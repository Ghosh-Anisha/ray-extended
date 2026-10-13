// Step 5b: voice notes in. A Hinglish voice note from Priya becomes a
// transcript the understand job reads; the message keeps the audio and the
// transcript. A merchant voice note produces the approval card, never a
// refund. Live speech-to-text runs on ElevenLabs only with a key.
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { seededAdapters } from "@/adapters/test-helpers";
import { aiWorld, tmpDir } from "@/ai/test-helpers";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { createDummySpecialist } from "@/engine/dummy-specialist";
import { createEngine, type Engine } from "@/engine/engine";
import { createRegistry } from "@/engine/specialist";
import { merchantVoiceNote, readMerchantNote } from "@/surfaces/voice";
import { approvalCards, caseView } from "@/surfaces/views";
import { createVoice, ELEVENLABS_API, VOICE_SAMPLES, VoiceError } from ".";

const LEAFY = "m_leafy_bakes";
const PRIYA = "+919800000101";
const PAY = "pay_LB1234PRIYA";

let a: ReturnType<typeof seededAdapters>;
let engine: Engine;
afterEach(() => {
  engine?.stop();
  a?.db.$client.close();
});

function world() {
  a = seededAdapters();
  engine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: createRegistry([createDummySpecialist()]) });
  return { a, engine, repo: createRepository(a.db) };
}

// A fake ElevenLabs: answers speech-to-text and text-to-speech, and keeps
// what it was sent.
function fakeElevenLabs() {
  const seen: { url: string; key: string | null }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), key: new Headers(init?.headers).get("xi-api-key") });
    if (String(url).endsWith("/speech-to-text")) {
      return Response.json({ text: "Maine 1299 pay kiya tha, order nahi aaya.", language_code: "hin", words: [{ end: 4.6 }] });
    }
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("customer voice notes", () => {
  it("a Hinglish voice note from Priya becomes a transcript the understand job reads", async () => {
    const { repo } = world();
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: PAY });
    const input = { merchantId: LEAFY, from: PRIYA, sampleId: "priya_hinglish", messageId: "inbound-voice-retry" };
    const r = await engine.receiveVoiceNote(input);
    const retry = await engine.receiveVoiceNote({ ...input, sampleId: "customer_where_order" });
    expect(retry).toMatchObject({ outcome: "duplicate", messageId: r.messageId, transcript: r.transcript });
    expect(repo.messages.list().filter((m) => m.id === input.messageId)).toHaveLength(1);

    // The message keeps the transcript (and the audio, when there is any).
    const m = repo.messages.get(r.messageId)!;
    expect(m).toMatchObject({ channel: "voice_note", direction: "in", from: PRIYA, transcript: VOICE_SAMPLES.priya_hinglish.transcript, duration_s: 14 });
    expect(m.body).toBe(m.transcript);
    expect(r.outcome).toBe("handled");

    // It reached the case like any message, transcript as the body.
    const caseId = (r as { caseId: string }).caseId;
    const ev = repo.caseEvents.listByCase(caseId).find((e) => e.type === "message_in" && e.evidence_ref === m.id)!;
    expect(ev.payload).toMatchObject({ channel: "voice_note", voice_note: true, body: m.transcript });

    // The understand job reads the transcript exactly like text.
    const { ai } = aiWorld();
    const read = await ai.understand({ text: String(ev.payload.body) });
    expect(read.source).toBe("replay");
    expect(read.label).toBe("recorded in Claude Code");
    expect(read.output).toMatchObject({ amount: 1299, intent: "paid_no_order", confidence: "sure" });

    // A voice note opens the WhatsApp 24-hour window like text.
    expect(a.messaging.window(LEAFY, PRIYA).open).toBe(true);
  });

  it("transcribes real audio on ElevenLabs when a key is set, and keeps the audio", async () => {
    world();
    const dir = tmpDir();
    const eleven = fakeElevenLabs();
    a.voice = createVoice(a.db, a.clock, { apiKey: "test-key", audioDir: dir, fetch: eleven.fetch });
    const r = await engine.receiveVoiceNote({ merchantId: LEAFY, from: PRIYA, audio: { bytes: new Uint8Array([9, 9]), mime: "audio/webm" } });
    expect(eleven.seen).toEqual([{ url: `${ELEVENLABS_API}/speech-to-text`, key: "test-key" }]);
    const m = createRepository(a.db).messages.get(r.messageId)!;
    expect(m).toMatchObject({ transcript: "Maine 1299 pay kiya tha, order nahi aaya.", duration_s: 5 });
    expect(m.audio_ref).toMatch(/^aud_/);
    expect(fs.readFileSync(a.voice.audioPath(m.audio_ref!)!)).toEqual(Buffer.from([9, 9]));
  });

  it("without a key, audio can't be transcribed: pick a recorded sample", async () => {
    world();
    await expect(a.voice.transcribe({ audio: { bytes: new Uint8Array([1]), mime: "audio/webm" } })).rejects.toBeInstanceOf(VoiceError);
    expect(a.voice.live).toBe(false);
    expect(await a.voice.transcribe({ sampleId: "priya_hinglish" })).toMatchObject({ source: "sample", audioRef: null });
  });
});

describe("merchant voice notes", () => {
  async function needsYou() {
    const w = world();
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: PAY });
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "I paid but my order still says pending" });
    const caseId = w.repo.cases.list(eq(s.cases.payment_id, PAY))[0].id;
    expect(w.repo.cases.get(caseId)?.state).toBe("waiting_merchant");
    return { ...w, caseId };
  }

  it('"haan refund kar do" produces an approval card for the refund, not a refund', async () => {
    const { repo, caseId } = await needsYou();
    const before = repo.caseEvents.listByCase(caseId).length;
    const r = await merchantVoiceNote(a, { merchantId: LEAFY, sampleId: "merchant_refund" });

    expect(r.transcript).toBe("Haan refund kar do.");
    expect(r.caseId).toBe(caseId);
    // The card RAY sends back is for the refund, with the voice note above it.
    expect(r.card?.primary).toMatchObject({ id: "prop_dummy_2", label: "Refund the customer" });
    expect(r.card?.voiceNote?.transcript).toBe("Haan refund kar do.");
    expect(approvalCards(a, LEAFY)[0].primary.id).toBe("prop_dummy_2");

    // Nothing was approved or done: no approval event, no action, no refund.
    const after = repo.caseEvents.listByCase(caseId).slice(before);
    expect(after.map((e) => [e.type, e.payload.kind])).toEqual([["note", "merchant_voice_note"]]);
    expect(repo.caseEvents.listByCase(caseId).filter((e) => e.type === "approval")).toEqual([]);
    expect(repo.actions.list(eq(s.actions.case_id, caseId))).toEqual([]);
    expect(await a.razorpay(LEAFY).listRefunds(PAY)).toEqual([]);
    expect(repo.cases.get(caseId)?.state).toBe("waiting_merchant");
    expect(caseView(a, caseId).events.at(-1)).toMatchObject({ what: "You sent a voice note: Haan refund kar do.", who: "You (voice note)" });
  });

  it("a plain yes points at the first option; an unclear note changes nothing", () => {
    const offered = [
      { id: "p1", label: "Mark paid & ship", tool: "mark_paid", args: {}, covered: false },
      { id: "p2", label: "Refund ₹1,299", tool: "refund", args: {}, covered: false },
    ];
    expect(readMerchantNote("Haan, mark paid karke order bhej do.", offered)?.id).toBe("p1");
    expect(readMerchantNote("Haan refund kar do.", offered)?.id).toBe("p2");
    expect(readMerchantNote("Okay go ahead", offered)?.id).toBe("p1");
    expect(readMerchantNote("Nahi, abhi mat karo", offered)).toBeNull();
    expect(readMerchantNote("Kal baat karte hain", offered)).toBeNull();
  });

  it("with nothing waiting for a tap, a voice note has nothing to answer", async () => {
    world();
    await expect(merchantVoiceNote(a, { merchantId: LEAFY, sampleId: "merchant_refund" })).rejects.toThrow("Nothing is waiting for your tap");
    expect(a.db.select().from(s.caseEvents).where(eq(s.caseEvents.type, "note")).all()).toEqual([]);
  });
});

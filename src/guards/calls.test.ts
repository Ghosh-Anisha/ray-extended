// Step 5b: place_call behind guardedCall. One test per call rule from Step
// 5b and design language section 5, the post-call summary on the case, and
// the opt-out a "don't call" records.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVoice, merchantPhone } from "@/adapters/voice";
import { tmpDir } from "@/ai/test-helpers";
import * as s from "@/db/schema";
import { CALL_TIMER } from "@/engine/specialist";
import { allCalls, preCallNotice } from "@/surfaces/calls";
import { cancelCall } from "@/surfaces/actions";
import { caseView } from "@/surfaces/views";
import type { GuardedResult } from ".";
import { guardWorld, LEAFY, MIN, PRIYA, type GuardWorld } from "./test-helpers";

let w: GuardWorld;
beforeEach(() => {
  w = guardWorld();
});
afterEach(() => w.close());

const codes = (r: GuardedResult) => (r.status === "blocked" ? r.failures.map((f) => `${f.guard}:${f.code}`) : [r.status]);
const HOUR = 60 * MIN;
const KARAN = "+919800000201";
const MEERA = "+919800000104";
const DEEPA = "+919800000106";

const opening = "Hi Priya, this is Leafy Bakes about your ₹1,299 payment this morning.";
const followUp = (over: Record<string, unknown> = {}) => ({ kind: "paid_no_order_follow_up", to: PRIYA, opening, lines: ["We wanted to check you got our message about your order."], ...over });
const checkParams = { name: "Priya", merchant: "Leafy Bakes", amount: "₹1,299", time: "9:22 AM", date: "12 Oct", order: "#1234", utr_last4: "0021" };

// The first text, which says a call may follow (Step 7 writes the words).
const textFirst = (caseId: string, to = PRIYA) =>
  w.a.messaging.send({ merchantId: LEAFY, caseId, channel: "whatsapp", to, senderMode: "merchant_inbox", templateId: "payment_received_check", params: checkParams });

async function pnoCase(over: Parameters<GuardWorld["openCase"]>[0] = {}) {
  const k = w.openCase(over);
  await textFirst(k.id);
  return k;
}

describe("place_call: a call that follows every rule", () => {
  it("calls from the merchant's own number and writes the post-call summary on the case", async () => {
    const k = await pnoCase();
    w.a.voice.setCallSim(PRIYA, { outcome: "answered", reply: "Haan, maine WhatsApp dekha. Order bhej do.", promise: "Wants the order shipped" });
    const r = await w.call(k.id, "place_call", followUp());
    expect(r.status).toBe("done");

    const call = w.repo.messages.list(eq(s.messages.channel, "call"))[0];
    expect(call).toMatchObject({ case_id: k.id, direction: "out", from: "call:leafy-bakes", to: PRIYA });
    expect(call.transcript!.split("\n")[0]).toBe(`Leafy Bakes: ${opening}`);

    const summary = w.repo.caseEvents.listByCase(k.id).find((e) => e.payload.kind === "call_summary")!;
    expect(summary.evidence_ref).toBe(call.id);
    expect(summary.payload).toMatchObject({ outcome: "answered", outcome_label: "Answered", promise: "Wants the order shipped", simulated: true, opted_out: false });
    expect(String(summary.payload.summary)).toMatch(/^Call to Priya · \d+ s · Answered\. Priya said: "Haan, maine WhatsApp dekha\. Order bhej do\." Promise: Wants the order shipped\.$/);
    expect((summary.payload.transcript as unknown[]).length).toBeGreaterThan(2);

    // Shown as a Call card on the case and the call screen.
    const conv = caseView(w.a, k.id).conversation.find((m) => m.id === call.id)!;
    expect(conv.call).toMatchObject({ outcome: "Answered", title: expect.stringMatching(/^Call to Priya · \d+ s$/) });
    expect(allCalls(w.a)[0].id).toBe(call.id);
  });

  it("generates audio for a few of RAY's lines when a key is set", async () => {
    const k = await pnoCase();
    const fetch = (async () => new Response(new Uint8Array([7]))) as unknown as typeof globalThis.fetch;
    w.a.voice = createVoice(w.a.db, w.a.clock, { apiKey: "test-key", audioDir: tmpDir(), fetch });
    const r = await w.call(k.id, "place_call", followUp({ lines: ["Line one.", "Line two.", "Line three."] }));
    expect(r.status).toBe("done");
    const summary = w.repo.caseEvents.listByCase(k.id).find((e) => e.payload.kind === "call_summary")!;
    const audio = summary.payload.audio as { line: number; audioRef: string }[];
    expect(audio).toHaveLength(3);
    for (const x of audio) expect(w.a.voice.audioPath(x.audioRef)).not.toBeNull();
  });

  it("records each outcome: No answer, Busy", async () => {
    const k = await pnoCase();
    w.a.voice.setCallSim(PRIYA, { outcome: "no_answer" });
    await w.call(k.id, "place_call", followUp());
    w.a.voice.setCallSim(PRIYA, { outcome: "busy" });
    await w.call(k.id, "place_call", followUp({ lines: ["Just checking in."] }));
    const outcomes = w.repo.caseEvents.listByCase(k.id).filter((e) => e.payload.kind === "call_summary").map((e) => e.payload.outcome_label);
    expect(outcomes).toEqual(["No answer", "Busy"]);
    // Busy stops the call but isn't an opt-out.
    expect(w.a.messaging.consent("cus_priya", "call")).toBe("opted_in");
  });
});

describe("call rule: opt-in", () => {
  it("blocks a call to someone who opted out of calls", async () => {
    const k = w.openCase();
    await w.a.messaging.send({ merchantId: LEAFY, caseId: k.id, channel: "whatsapp", to: DEEPA, senderMode: "merchant_inbox", templateId: "order_update", params: { name: "Deepa", order: "#1234", merchant: "Leafy Bakes", status: "packed" } });
    const r = await w.call(k.id, "place_call", followUp({ to: DEEPA, opening: "Hi Deepa, this is Leafy Bakes about your ₹1,299 payment." }));
    expect(codes(r)).toContain("call_rules:opted_out");
    expect(w.repo.messages.list(eq(s.messages.channel, "call"))).toEqual([]);
  });

  it("blocks a call to someone with no call opt-in on file", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "place_call", followUp({ to: MEERA, opening: "Hi Meera, this is Leafy Bakes about your ₹1,299 payment." }));
    expect(codes(r)).toContain("call_rules:no_opt_in");
  });
});

describe('call rule: "don\'t call" records an opt-out', () => {
  it("writes opted_out for the customer's call channel, and the next call is blocked", async () => {
    const k = await pnoCase();
    w.a.voice.setCallSim(PRIYA, { outcome: "asked_not_to_call" });
    const r = await w.call(k.id, "place_call", followUp());
    expect(r.status).toBe("done");
    expect(r.status === "done" && r.result).toMatchObject({ outcome: "asked_not_to_call", opted_out: true });

    const row = w.repo.messagingConsents.list(and(eq(s.messagingConsents.customer_id, "cus_priya"), eq(s.messagingConsents.channel, "call")))[0];
    expect(row).toMatchObject({ status: "opted_out", source: "asked not to be called on a call", updated_at: w.a.clock.now() });
    // WhatsApp consent is untouched.
    expect(w.a.messaging.consent("cus_priya", "whatsapp")).toBe("opted_in");
    const summary = w.repo.caseEvents.listByCase(k.id).find((e) => e.payload.kind === "call_summary")!;
    expect(summary.payload).toMatchObject({ outcome_label: "Asked not to call", opted_out: true });

    const again = await w.call(k.id, "place_call", followUp({ lines: ["One more thing."] }));
    expect(codes(again)).toContain("call_rules:opted_out");
  });
});

describe("call rule: calling hours", () => {
  it("blocks a call outside the default 10 AM to 7 PM", async () => {
    const k = await pnoCase();
    w.a.clock.advance(10.5 * HOUR); // 8:30 PM
    const r = await w.call(k.id, "place_call", followUp());
    expect(codes(r)).toContain("call_rules:outside_hours");
    expect(r.status === "blocked" && r.failures[0].reason).toBe("Calls only go out between 10 AM and 7 PM, as set in your playbook. It's 8:30 PM now.");
  });

  it("follows the hours the merchant set in the playbook", async () => {
    const k = await pnoCase();
    w.repo.merchants.update(LEAFY, { calling_hours_start: 11 * 60, calling_hours_end: 20 * 60 + 30 });
    expect(codes(await w.call(k.id, "place_call", followUp()))).toContain("call_rules:outside_hours"); // 10 AM
    w.a.clock.advance(10 * HOUR); // 8 PM
    expect((await w.call(k.id, "place_call", followUp({ lines: ["Later today."] }))).status).toBe("done");
  });
});

describe("call rule: text first", () => {
  it("paid-no-order: blocks a call with no prior text on the case", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "place_call", followUp());
    expect(codes(r)).toContain("call_rules:no_prior_text");
  });

  it("never a first contact: a subscription call needs a message first", async () => {
    const sub = { kind: "subscription_save", to: KARAN, opening: "Hi Karan, this is FitLoop about your FitLoop Monthly plan." };
    const k = w.openCase({ merchant_id: "m_fitloop", moment: "subscription", payment_id: null, store_order_id: null, amount: null });
    expect(codes(await w.call(k.id, "place_call", sub, w.tapFor(k.id, "place_call", sub)))).toContain("call_rules:first_contact");
    await w.a.messaging.send({ merchantId: "m_fitloop", caseId: k.id, channel: "email", to: "karan.mehta@example.com", senderMode: "merchant_inbox", body: "Your FitLoop Monthly payment didn't go through." });
    expect((await w.call(k.id, "place_call", sub, w.tapFor(k.id, "place_call", sub))).status).toBe("done");
  });
});

describe("call rule: not voice", () => {
  it("never calls an international buyer", async () => {
    const k = await pnoCase({ moment: "international" });
    expect(codes(await w.call(k.id, "place_call", followUp()))).toContain("call_rules:not_voice");
  });

  it("never calls a chargeback cardholder", async () => {
    const k = await pnoCase({ moment: "chargeback" });
    expect(codes(await w.call(k.id, "place_call", followUp()))).toContain("call_rules:not_voice");
  });
});

describe("call rule: the script", () => {
  it("opens as the merchant with who is calling and why", async () => {
    const k = await pnoCase();
    const r = await w.call(k.id, "place_call", followUp({ opening: "Hello, calling about your order." }));
    expect(codes(r)).toContain("call_rules:opening");
    expect(r.status === "blocked" && r.failures.find((f) => f.code === "opening")?.details?.missing).toEqual([
      "your name (Leafy Bakes)",
      "Priya's name",
      "what it's about (the amount)",
    ]);
  });

  it("never asks for a PIN, OTP or card number", async () => {
    const k = await pnoCase();
    for (const line of ["Can you tell me the OTP you got?", "Please confirm your UPI PIN.", "Read me your card number."]) {
      expect(codes(await w.call(k.id, "place_call", followUp({ lines: [line] }))), line).toContain("call_rules:asks_secret");
    }
  });

  it("never reads out a link", async () => {
    const k = await pnoCase();
    expect(codes(await w.call(k.id, "place_call", followUp({ lines: ["You can pay at rzp.io/l/leafy."] })))).toContain("call_rules:reads_link");
  });

  it("never takes payment on the call", async () => {
    const k = await pnoCase();
    expect(codes(await w.call(k.id, "place_call", followUp({ lines: ["Could you pay now while we're on the call?"] })))).toContain("call_rules:takes_payment");
    expect(codes(await w.call(k.id, "place_call", followUp({ lines: ["Please share your UPI ID so I can collect it."] })))).toContain("call_rules:takes_payment");
  });

  it("says only numbers that are in the case (rule 6)", async () => {
    const k = await pnoCase();
    expect(codes(await w.call(k.id, "place_call", followUp({ lines: ["We'll add ₹200 off your next order."] })))).toContain("grounding:ungrounded");
  });

  it("nothing calls on an Unsure case", async () => {
    const k = await pnoCase({ confidence: "unsure" });
    expect(codes(await w.call(k.id, "place_call", followUp()))).toContain("confidence:unsure");
  });
});

describe("the urgent call to the merchant", () => {
  const urgent = { kind: "urgent_merchant", to: merchantPhone(LEAFY), opening: "Hi, this is RAY about the ₹1,299 chargeback. Its deadline is tomorrow." };

  it("goes only to a merchant who opted in (Leafy Bakes is seeded in)", async () => {
    const k = w.openCase({ moment: "chargeback" });
    expect((await w.call(k.id, "place_call", urgent)).status).toBe("done");
    w.repo.merchants.update(LEAFY, { urgent_call_opt_in: false });
    expect(codes(await w.call(k.id, "place_call", { ...urgent, lines: ["Again."] }))).toContain("call_rules:no_opt_in");
  });

  it("goes only to the merchant's own number", async () => {
    const k = w.openCase({ moment: "chargeback" });
    expect(codes(await w.call(k.id, "place_call", { ...urgent, to: PRIYA }))).toContain("call_rules:wrong_number");
  });

  it('"don\'t call" turns the opt-in off', async () => {
    const k = w.openCase({ moment: "chargeback" });
    w.a.voice.setCallSim(merchantPhone(LEAFY), { outcome: "asked_not_to_call" });
    await w.call(k.id, "place_call", urgent);
    expect(w.repo.merchants.get(LEAFY)?.urgent_call_opt_in).toBe(false);
  });
});

describe("pre-call notice", () => {
  it('shows "RAY will call Priya at …" until the merchant taps Cancel call', () => {
    const k = w.openCase();
    const t = w.repo.timers.insert({ id: "tmr_call_1", case_id: k.id, kind: CALL_TIMER, due_at: w.a.clock.now() + 10.5 * HOUR });
    expect(caseView(w.a, k.id).preCall).toEqual({ timerId: t.id, text: "RAY will call Priya at 8:30 PM if there's no reply" });
    cancelCall(w.a, { caseId: k.id, timerId: t.id });
    expect(preCallNotice(w.a, k.id, "Priya Sharma")).toBeNull();
    expect(w.repo.timers.get(t.id)?.cancelled_at).toBe(w.a.clock.now());
    expect(w.repo.caseEvents.listByCase(k.id).at(-1)?.payload).toMatchObject({ kind: "call_cancelled", timer_id: t.id });
  });
});

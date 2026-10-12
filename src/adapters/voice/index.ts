// Voice on ElevenLabs only (design language section 5).
// - Voice notes in: speech-to-text, live when ELEVENLABS_API_KEY is set and
//   there is audio; recorded sample transcripts otherwise.
// - Calls out are Simulated: the callee's side comes from call_sims (set on
//   the call screen), RAY's lines come from the script place_call was given,
//   and a few of them become generated audio when a key is set.
// The key is read from the environment and never logged or stored.
import fs from "node:fs";
import path from "node:path";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Clock } from "../clock";
import { newId } from "../ids";

export const ELEVENLABS_API = "https://api.elevenlabs.io/v1";
export const STT_MODEL = "scribe_v1";
export const TTS_MODEL = "eleven_multilingual_v2";
export const TTS_VOICE = "JBFqnCBsd6RMkjVDRZzb";
// Generated audio for a few lines of each call, not the whole call.
export const AUDIO_LINES = 3;
export const DEFAULT_AUDIO_DIR = path.join(process.cwd(), "data", "audio");

export type CallOutcome = (typeof s.CALL_OUTCOMES)[number];
export type Speaker = "caller" | "callee" | "line";
export type TranscriptLine = { speaker: Speaker; who: string; text: string; audioRef: string | null };

// Recorded sample voice notes, used when there is no key or no audio.
// Fictional people; the transcript is what was said, in its own language.
export type VoiceSample = { id: string; who: "customer" | "buyer" | "merchant"; label: string; language: string; durationS: number; transcript: string };
export const VOICE_SAMPLES: Record<string, VoiceSample> = {
  priya_hinglish: {
    id: "priya_hinglish",
    who: "customer",
    label: "Priya: paid, no order (Hinglish)",
    language: "hi-en",
    durationS: 14,
    transcript: "Hello, maine aaj subah Leafy Bakes pe 1299 ka payment kiya, paisa kat gaya par order confirm nahi hua. Please check karo na.",
  },
  customer_where_order: {
    id: "customer_where_order",
    who: "customer",
    label: "Where is my order? (English)",
    language: "en",
    durationS: 6,
    transcript: "Hi, I paid this morning but I didn't get any order confirmation. Can you check?",
  },
  buyer_next_week: {
    id: "buyer_next_week",
    who: "buyer",
    label: "We'll pay next week (Hinglish)",
    language: "hi-en",
    durationS: 7,
    transcript: "Namaste, invoice ka payment agle hafte Friday tak kar denge. Accounts team ko bol diya hai.",
  },
  merchant_refund: {
    id: "merchant_refund",
    who: "merchant",
    label: "Haan refund kar do",
    language: "hi-en",
    durationS: 2,
    transcript: "Haan refund kar do.",
  },
  merchant_ship: {
    id: "merchant_ship",
    who: "merchant",
    label: "Haan, order bhej do",
    language: "hi-en",
    durationS: 3,
    transcript: "Haan, mark paid karke order bhej do.",
  },
};

export type Transcription = { transcript: string; language: string; durationS: number; audioRef: string | null; source: "live" | "sample" };
export type AudioInput = { bytes: Uint8Array; mime: string };

export type CallInput = {
  merchantId: string;
  caseId: string;
  // The number called, and who it is, for the transcript.
  to: string;
  calleeName: string;
  // The merchant's own number (calls only come from it) and the name it speaks as.
  from: string;
  callerName: string;
  opening: string;
  lines: string[];
};
export type CallRecord = {
  messageId: string;
  outcome: CallOutcome;
  durationS: number;
  transcript: TranscriptLine[];
  promise: string | null;
  summary: string;
  audio: { line: number; audioRef: string }[];
  audioError: string | null;
};

export class VoiceError extends Error {
  constructor(
    readonly code: "NO_KEY" | "NO_INPUT" | "UNKNOWN_SAMPLE" | "ELEVENLABS",
    message: string,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

export type VoiceConfig = { apiKey: string | null; audioDir: string; fetch: typeof fetch };

export function loadVoiceConfig(env: Record<string, string | undefined> = process.env): VoiceConfig {
  return { apiKey: env.ELEVENLABS_API_KEY?.trim() || null, audioDir: DEFAULT_AUDIO_DIR, fetch: globalThis.fetch };
}

export const OUTCOME_LABEL: Record<CallOutcome, string> = {
  answered: "Answered",
  no_answer: "No answer",
  busy: "Busy",
  asked_not_to_call: "Asked not to call",
};

export const firstNameOf = (name: string) => name.split(/[\s,]+/)[0];

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return m ? `${m} min ${sec} s` : `${sec} s`;
}

// How long it takes to say this, roughly: 2.5 words a second, a pause per turn.
const spoken = (text: string) => Math.round(text.split(/\s+/).filter(Boolean).length / 2.5) + 1;

// Fixed lines RAY says on every call of that outcome. No numbers, no links,
// nothing about paying on the call: anything about money ends as a text.
export const CALL_LINES = {
  goAhead: "Haan, boliye.",
  closeAnswered: (callee: string) => `Thanks, ${callee}. We'll send you the details by message, so you can check them.`,
  busyReply: "I'm busy right now, can't talk.",
  closeBusy: "Sorry to catch you at a bad time. We'll send you a message instead.",
  dontCallReply: "Please don't call me again.",
  closeDontCall: "Understood. We won't call you again, and we'll keep you posted by message.",
  noAnswer: "Rang for 30 s. No answer.",
};

export type CallSim = typeof s.callSims.$inferSelect;

// The call itself, without audio: who said what, for how long.
export function simulateCall(input: Pick<CallInput, "calleeName" | "callerName" | "opening" | "lines">, sim?: Pick<CallSim, "outcome" | "reply" | "promise">) {
  const outcome: CallOutcome = sim?.outcome ?? "answered";
  const callee = firstNameOf(input.calleeName);
  const caller = (text: string): Omit<TranscriptLine, "audioRef"> => ({ speaker: "caller", who: input.callerName, text });
  const them = (text: string): Omit<TranscriptLine, "audioRef"> => ({ speaker: "callee", who: callee, text });
  let lines: Omit<TranscriptLine, "audioRef">[];
  let durationS: number;
  if (outcome === "no_answer") {
    lines = [{ speaker: "line", who: "", text: CALL_LINES.noAnswer }];
    durationS = 30;
  } else {
    if (outcome === "busy") lines = [caller(input.opening), them(sim?.reply ?? CALL_LINES.busyReply), caller(CALL_LINES.closeBusy)];
    else if (outcome === "asked_not_to_call") lines = [caller(input.opening), them(sim?.reply ?? CALL_LINES.dontCallReply), caller(CALL_LINES.closeDontCall)];
    else {
      lines = [caller(input.opening), them(CALL_LINES.goAhead), ...input.lines.map(caller)];
      if (sim?.reply) lines.push(them(sim.reply));
      lines.push(caller(CALL_LINES.closeAnswered(callee)));
    }
    durationS = lines.reduce((t, l) => t + spoken(l.text), 0) + 2 * lines.length;
  }
  const promise = outcome === "answered" ? (sim?.promise ?? null) : null;
  return { outcome, lines, durationS, promise };
}

export function callSummary(calleeName: string, outcome: CallOutcome, durationS: number, promise: string | null, reply: string | null): string {
  const name = firstNameOf(calleeName);
  const head = `Call to ${name} · ${formatDuration(durationS)} · ${OUTCOME_LABEL[outcome]}.`;
  if (outcome === "no_answer") return `${head} ${name} didn't pick up.`;
  if (outcome === "busy") return `${head} ${name} was busy, so the call ended early.`;
  if (outcome === "asked_not_to_call") return `${head} ${name} asked not to be called. RAY won't call ${name} again.`;
  const said = reply ? ` ${name} said: "${reply}"` : "";
  return `${head}${said}${promise ? ` Promise: ${promise}.` : ""}`;
}

export type VoiceAdapter = {
  // Simulated systems are labelled; voice notes are live only with a key.
  live: boolean;
  samples(who?: VoiceSample["who"]): VoiceSample[];
  transcribe(input: { audio?: AudioInput; sampleId?: string }): Promise<Transcription>;
  // Generated audio for up to AUDIO_LINES lines, when a key is set.
  speak(lines: string[]): Promise<{ refs: (string | null)[]; error: string | null }>;
  call(input: CallInput): Promise<CallRecord>;
  callSim(callee: string): CallSim | undefined;
  setCallSim(callee: string, sim: Pick<CallSim, "outcome"> & Partial<Pick<CallSim, "reply" | "promise">>): CallSim;
  audioPath(audioRef: string): string | null;
};

const AUDIO_REF = /^aud_[A-Za-z0-9_]+$/;
const EXT: Record<string, string> = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/aac": "aac" };

export function createVoice(db: Db, clock: Clock, config: VoiceConfig = loadVoiceConfig()): VoiceAdapter {
  const repo = createRepository(db);

  const save = (bytes: Uint8Array, mime: string) => {
    const id = newId("aud");
    const ext = EXT[mime.split(";")[0].trim()] ?? "bin";
    fs.mkdirSync(config.audioDir, { recursive: true });
    fs.writeFileSync(path.join(config.audioDir, `${id}.${ext}`), bytes);
    return id;
  };

  async function eleven(pathname: string, init: RequestInit): Promise<Response> {
    const res = await config.fetch(`${ELEVENLABS_API}${pathname}`, { ...init, headers: { ...(init.headers ?? {}), "xi-api-key": config.apiKey! } });
    if (!res.ok) throw new VoiceError("ELEVENLABS", `ElevenLabs answered ${res.status}`);
    return res;
  }

  const voice: VoiceAdapter = {
    live: config.apiKey !== null,

    samples: (who) => Object.values(VOICE_SAMPLES).filter((x) => !who || x.who === who),

    async transcribe({ audio, sampleId }) {
      if (audio) {
        if (!config.apiKey) throw new VoiceError("NO_KEY", "Speech-to-text needs ELEVENLABS_API_KEY. Pick a recorded sample instead.");
        const audioRef = save(audio.bytes, audio.mime);
        const form = new FormData();
        form.append("model_id", STT_MODEL);
        form.append("file", new Blob([audio.bytes as BlobPart], { type: audio.mime }), "voice-note");
        const res = await eleven("/speech-to-text", { method: "POST", body: form });
        const out = (await res.json()) as { text?: string; language_code?: string; words?: { end?: number }[] };
        const transcript = (out.text ?? "").trim();
        if (!transcript) throw new VoiceError("ELEVENLABS", "Nothing could be heard in that voice note.");
        const end = out.words?.at(-1)?.end;
        return { transcript, language: out.language_code ?? "und", durationS: Math.max(1, Math.round(end ?? spoken(transcript))), audioRef, source: "live" };
      }
      if (!sampleId) throw new VoiceError("NO_INPUT", "Give a voice note or pick a sample.");
      const sample = VOICE_SAMPLES[sampleId];
      if (!sample) throw new VoiceError("UNKNOWN_SAMPLE", `No sample called ${sampleId}`);
      return { transcript: sample.transcript, language: sample.language, durationS: sample.durationS, audioRef: null, source: "sample" };
    },

    async speak(lines) {
      if (!config.apiKey) return { refs: lines.map(() => null), error: null };
      const refs: (string | null)[] = lines.map(() => null);
      try {
        for (let i = 0; i < Math.min(lines.length, AUDIO_LINES); i++) {
          const res = await eleven(`/text-to-speech/${TTS_VOICE}?output_format=mp3_44100_128`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "audio/mpeg" },
            body: JSON.stringify({ text: lines[i], model_id: TTS_MODEL }),
          });
          refs[i] = save(new Uint8Array(await res.arrayBuffer()), "audio/mpeg");
        }
        return { refs, error: null };
      } catch (e) {
        // Generated audio is a nice-to-have; the transcript is the record.
        return { refs, error: e instanceof Error ? e.message : "Couldn't generate audio" };
      }
    },

    async call(input) {
      const sim = voice.callSim(input.to);
      const r = simulateCall(input, sim);
      const callerAt = r.lines.map((l, i) => (l.speaker === "caller" ? i : -1)).filter((i) => i >= 0);
      const spokenAudio = await voice.speak(callerAt.map((i) => r.lines[i].text));
      const audio = callerAt.map((line, k) => ({ line, audioRef: spokenAudio.refs[k] })).filter((x): x is { line: number; audioRef: string } => !!x.audioRef);
      const transcript: TranscriptLine[] = r.lines.map((l, i) => ({ ...l, audioRef: audio.find((x) => x.line === i)?.audioRef ?? null }));
      const reply = r.outcome === "no_answer" ? null : (transcript.find((l) => l.speaker === "callee" && l.text !== CALL_LINES.goAhead)?.text ?? null);
      const summary = callSummary(input.calleeName, r.outcome, r.durationS, r.promise, reply);
      const m = repo.messages.insert({
        id: newId("msg"),
        case_id: input.caseId,
        channel: "call",
        direction: "out",
        from: input.from,
        to: input.to,
        sender_mode: "merchant_inbox",
        body: summary,
        transcript: transcript.map((l) => (l.who ? `${l.who}: ${l.text}` : l.text)).join("\n"),
        audio_ref: audio[0]?.audioRef ?? null,
        duration_s: r.durationS,
        template_id: null,
        within_24h: null,
        at: clock.now(),
      });
      return { messageId: m.id, outcome: r.outcome, durationS: r.durationS, transcript, promise: r.promise, summary, audio, audioError: spokenAudio.error };
    },

    callSim: (callee) => repo.callSims.get(callee),

    setCallSim(callee, sim) {
      const row = { outcome: sim.outcome, reply: sim.reply?.trim() || null, promise: sim.promise?.trim() || null, updated_at: clock.now() };
      return repo.callSims.get(callee) ? repo.callSims.update(callee, row)! : repo.callSims.insert({ callee, ...row });
    },

    audioPath(audioRef) {
      if (!AUDIO_REF.test(audioRef) || !fs.existsSync(config.audioDir)) return null;
      const file = fs.readdirSync(config.audioDir).find((f) => f.startsWith(`${audioRef}.`));
      return file ? path.join(config.audioDir, file) : null;
    },
  };
  return voice;
}

// Calls come only from the merchant's own number (simulated).
export const merchantCallNumber = (merchantId: string) => `call:${merchantId.replace(/^m_/, "").replace(/_/g, "-")}`;
// The merchant's own phone, for RAY's urgent call to the merchant.
export const merchantPhone = (merchantId: string) => `merchant:${merchantId}`;

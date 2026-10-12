// The merchant replies to RAY on WhatsApp by voice (design language
// section 5). RAY transcribes it, reads which option it is about, and sends
// back the approval card for that option. A voice note never approves
// anything: no approval event is written and nothing runs until the
// merchant taps. Reading the note is code (keywords), and only picks which
// card to show; the words are never followed as instructions.
import { and, desc, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import type { AudioInput } from "@/adapters/voice";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { openProposals } from "@/engine/orchestrator";
import type { ProposedAction } from "@/engine/specialist";
import { caseView, type ApprovalCard } from "./views";

export const MERCHANT_VOICE_NOTE = "merchant_voice_note";

const ABOUT: { words: RegExp; tools: string[] }[] = [
  { words: /\brefund|paise? wapas|wapas kar|money back/i, tools: ["refund"] },
  { words: /\bship|bhej|mark (?:it )?paid|mark paid|confirm (?:the )?order|order (?:bana|confirm)|restore/i, tools: ["mark_paid", "restore_order", "create_order_for_payment"] },
  { words: /\bcancel/i, tools: ["cancel_order", "cancel_subscription"] },
  { words: /\bcontest|\bfight|\blado\b/i, tools: ["contest_dispute"] },
  { words: /\baccept|maan lo/i, tools: ["accept_dispute"] },
  { words: /\bpause|rok do/i, tools: ["pause_subscription"] },
  { words: /\bresume|chalu kar/i, tools: ["resume_subscription"] },
];
const YES = /\b(?:haan|han|ha|yes|ok|okay|theek|thik|sure|go ahead|kar do)\b/i;
const NO = /\b(?:nahi|nahin|no|mat|don't|dont)\b/i;

// The open option the note is about: named by what it does, or a plain
// yes to the first option. null when it isn't clear.
export function readMerchantNote(transcript: string, offered: ProposedAction[]): ProposedAction | null {
  for (const { words, tools } of ABOUT) {
    if (words.test(transcript)) return offered.find((p) => tools.includes(p.tool)) ?? null;
  }
  if (YES.test(transcript) && !NO.test(transcript)) return offered[0] ?? null;
  return null;
}

export type MerchantVoiceNoteInput = { merchantId: string; caseId?: string; audio?: AudioInput; sampleId?: string };
export type MerchantVoiceNoteResult = { caseId: string; transcript: string; pointsTo: string | null; card: ApprovalCard | null; eventId: string };

export async function merchantVoiceNote(a: Adapters, input: MerchantVoiceNoteInput): Promise<MerchantVoiceNoteResult> {
  const repo = createRepository(a.db);
  const waiting = repo.cases.list(and(eq(s.cases.merchant_id, input.merchantId), eq(s.cases.state, "waiting_merchant")));
  const heard = await a.voice.transcribe({ audio: input.audio, sampleId: input.sampleId });

  let kase = input.caseId ? waiting.find((c) => c.id === input.caseId) : undefined;
  if (input.caseId && !kase) throw new Error("That case isn't waiting for your tap.");
  if (!kase) {
    // The case whose customer the note names, else the newest waiting case.
    const named = waiting.find((c) => {
      const v = caseView(a, c.id);
      const first = v.name.split(/[\s,]+/)[0];
      return first.length > 1 && new RegExp(`\\b${first}\\b`, "i").test(heard.transcript);
    });
    kase = named ?? a.db.select().from(s.cases).where(and(eq(s.cases.merchant_id, input.merchantId), eq(s.cases.state, "waiting_merchant"))).orderBy(desc(s.cases.opened_at)).get();
  }
  if (!kase) throw new Error("Nothing is waiting for your tap right now.");

  const offered = openProposals({ db: a.db, repo, clock: a.clock }, kase.id);
  const about = readMerchantNote(heard.transcript, offered);
  const ev = repo.caseEvents.insert({
    id: newId("cev"),
    case_id: kase.id,
    at: a.clock.now(),
    type: "note",
    payload: {
      kind: MERCHANT_VOICE_NOTE,
      transcript: heard.transcript,
      language: heard.language,
      duration_s: heard.durationS,
      audio_ref: heard.audioRef,
      source: heard.source,
      points_to: about?.id ?? null,
    },
    evidence_ref: heard.audioRef ?? newId("vn"),
  });
  return { caseId: kase.id, transcript: heard.transcript, pointsTo: about?.id ?? null, card: caseView(a, kase.id).card, eventId: ev.id };
}

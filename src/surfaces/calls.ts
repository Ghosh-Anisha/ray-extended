// Calls and voice notes as the screens show them (design language section
// 5): the Call card, the Voice note bubble and the Pre-call notice. Built
// from messages, case_events and timers.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { firstNameOf, formatDuration, OUTCOME_LABEL, type CallOutcome, type TranscriptLine } from "@/adapters/voice";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { CALL_TIMER } from "@/engine/specialist";
import { dateTime, formatTime } from "./format";
import type { Tone } from "./words";

type Message = typeof s.messages.$inferSelect;

export type CallView = {
  id: string;
  caseId: string | null;
  merchant: string;
  // "Call to Priya · 1 min 42 s"; the Simulated tag sits next to it.
  title: string;
  at: string;
  outcome: string;
  tone: Tone;
  transcript: { who: string; text: string; audioRef: string | null }[];
  summary: string;
  promise: string | null;
};

export type VoiceNoteView = { transcript: string; duration: string; audioRef: string | null };

const OUTCOME_TONE: Record<CallOutcome, Tone> = { answered: "positive", no_answer: "neutral", busy: "notice", asked_not_to_call: "negative" };

export function callView(a: Adapters, m: Message): CallView {
  const repo = createRepository(a.db);
  const summary = m.case_id ? repo.caseEvents.listByCase(m.case_id).find((e) => e.evidence_ref === m.id && e.payload.kind === "call_summary") : undefined;
  const p = summary?.payload ?? {};
  const outcome = (p.outcome as CallOutcome | undefined) ?? "answered";
  const customer = a.db.select().from(s.customers).where(eq(s.customers.phone, m.to)).get();
  const merchant = m.case_id ? repo.merchants.get(repo.cases.get(m.case_id)!.merchant_id) : undefined;
  // Collect calls a buyer's contact person.
  const buyer = customer ? undefined : a.db.select().from(s.buyers).where(eq(s.buyers.phone, m.to)).get();
  const callee = m.to.startsWith("merchant:") ? (merchant?.name ?? "you") : customer ? firstNameOf(customer.name) : buyer ? firstNameOf(buyer.contact_name) : m.to;
  const lines = (p.transcript as TranscriptLine[] | undefined) ?? (m.transcript ?? "").split("\n").filter(Boolean).map((text) => ({ speaker: "line" as const, who: "", text, audioRef: null }));
  return {
    id: m.id,
    caseId: m.case_id,
    merchant: merchant?.name ?? "",
    title: `Call to ${callee} · ${formatDuration(m.duration_s ?? 0)}`,
    at: dateTime(m.at),
    outcome: OUTCOME_LABEL[outcome],
    tone: OUTCOME_TONE[outcome],
    transcript: lines.map((l) => ({ who: l.who, text: l.text, audioRef: l.audioRef })),
    summary: m.body,
    promise: (p.promise as string | null | undefined) ?? null,
  };
}

export function voiceNoteView(m: Pick<Message, "transcript" | "body" | "duration_s" | "audio_ref">): VoiceNoteView {
  return { transcript: m.transcript ?? m.body, duration: formatDuration(m.duration_s ?? 0), audioRef: m.audio_ref };
}

// Every call RAY placed, newest first, for the call screen.
export function allCalls(a: Adapters): CallView[] {
  return a.db
    .select()
    .from(s.messages)
    .where(eq(s.messages.channel, "call"))
    .orderBy(desc(s.messages.at))
    .all()
    .map((m) => callView(a, m));
}

// "RAY will call Priya at 8:30 PM if there's no reply · Cancel call"
export type PreCallNotice = { timerId: string; text: string };

export function preCallNotice(a: Adapters, caseId: string, name: string): PreCallNotice | null {
  const t = a.db
    .select()
    .from(s.timers)
    .where(and(eq(s.timers.case_id, caseId), eq(s.timers.kind, CALL_TIMER), isNull(s.timers.fired_at), isNull(s.timers.cancelled_at)))
    .orderBy(s.timers.due_at)
    .get();
  return t ? { timerId: t.id, text: `RAY will call ${firstNameOf(name)} at ${formatTime(t.due_at)} if there's no reply` } : null;
}

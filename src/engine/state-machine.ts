// The only way a case changes state. Each move is checked against the table
// below, written to case_events as a state_changed note, then applied. A
// database trigger (migration 0004) rejects any state write without that note.
import { eq } from "drizzle-orm";
import type { Clock } from "@/adapters/clock";
import { newId } from "@/adapters/ids";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { CaseState } from "@/db/schema";
import { HANDLED_BY_MERCHANT } from "./outcomes";

export type Case = typeof s.cases.$inferSelect;

export const TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  likely: ["confirmed", "waiting_customer", "waiting_merchant", "unconfirmed", "fixed_itself"],
  confirmed: ["waiting_merchant", "waiting_customer", "acting", "fixed_itself"],
  waiting_customer: ["confirmed", "likely", "waiting_merchant", "unconfirmed", "fixed_itself"],
  waiting_merchant: ["acting", "waiting_customer", "confirmed", "closed", "fixed_itself"],
  acting: ["verifying", "waiting_merchant"],
  verifying: ["closed", "acting", "waiting_merchant"],
  unconfirmed: ["likely", "closed"],
  closed: [],
  fixed_itself: [],
};

export const FINAL_STATES: readonly CaseState[] = ["closed", "fixed_itself"];

// The merchant can take a case over from any open state. These extra moves to
// closed exist only for that, and need the handled_by_merchant outcome.
export const TAKEOVER_ONLY: Partial<Record<CaseState, readonly CaseState[]>> = {
  likely: ["closed"],
  confirmed: ["closed"],
  waiting_customer: ["closed"],
  acting: ["closed"],
};
export const isFinal = (state: CaseState) => FINAL_STATES.includes(state);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: CaseState,
    readonly to: CaseState,
    reason: string,
  ) {
    super(`Case cannot move from ${from} to ${to}: ${reason}`);
    this.name = "IllegalTransitionError";
  }
}

export function checkTransition(kase: Pick<Case, "state" | "confidence">, to: CaseState, outcome?: string | null) {
  const takeover = outcome === HANDLED_BY_MERCHANT && TAKEOVER_ONLY[kase.state]?.includes(to);
  if (!TRANSITIONS[kase.state].includes(to) && !takeover) {
    throw new IllegalTransitionError(kase.state, to, "not an allowed move");
  }
  // CLAUDE.md rule 4: nothing acts on Unsure confidence.
  if (to === "acting" && kase.confidence === "unsure") {
    throw new IllegalTransitionError(kase.state, to, "confidence is Unsure");
  }
}

export type TransitionInput = {
  reason: string;
  // The case_events id (or source id) that caused this move.
  evidenceRef: string;
  // Extra fields set together with the move, e.g. closed_at and outcome.
  patch?: Partial<Pick<Case, "closed_at" | "outcome" | "counts_as_saved">>;
};

export function transition(db: Db, clock: Clock, caseId: string, to: CaseState, input: TransitionInput): Case {
  if (!input.evidenceRef) throw new Error("A state change needs an evidence reference");
  const repo = createRepository(db);
  return db.transaction(() => {
    const kase = repo.cases.get(caseId);
    if (!kase) throw new Error(`Case ${caseId} not found`);
    checkTransition(kase, to, input.patch?.outcome);
    repo.caseEvents.insert({
      id: newId("cev"),
      case_id: caseId,
      at: clock.now(), // a decision by RAY; there is no source time
      type: "note",
      payload: { kind: "state_changed", from: kase.state, to, reason: input.reason },
      evidence_ref: input.evidenceRef,
    });
    return db
      .update(s.cases)
      .set({ ...input.patch, state: to })
      .where(eq(s.cases.id, caseId))
      .returning()
      .get();
  });
}

// Wakes on every event, reloads the case and calls the specialist hook that
// fits its state. Hooks only return results; this file writes them to
// case_events (each with an evidence reference) and moves the case through
// the state machine. Stops when the case waits on someone or is final.
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import * as s from "@/db/schema";
import type { CaseState } from "@/db/schema";
import { tapPayload, type EngineEvent } from "./events";
import { HANDLED_BY_MERCHANT } from "./outcomes";
import { PROMISED_TIME_TIMER, type Approval, type EngineContext, type Finding, type ProposedAction, type Registry, type TimerRequest } from "./specialist";
import { isFinal, transition, type Case } from "./state-machine";

export const MAX_STEPS = 12;
export const CHANGE_PROMPT = "What should I do instead?";
export const HANDLE_MYSELF_LABEL = "I'll handle this myself";

export class StepCapError extends Error {}

export type OrchestratorDeps = EngineContext & { registry: Registry };

export async function orchestrate(deps: OrchestratorDeps, caseId: string, event: EngineEvent, eventRowId: string) {
  const { repo, clock, db } = deps;
  const evidenceRef = eventRowId;
  const note = (kase: Case, payload: Record<string, unknown>, ref = evidenceRef) =>
    repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: clock.now(), type: "note", payload, evidence_ref: ref });
  const setTimers = (kase: Case, timers: TimerRequest[] = []) => {
    for (const t of timers) {
      const timer = repo.timers.insert({ id: newId("tmr"), case_id: kase.id, kind: t.kind, due_at: clock.now() + t.inMs });
      if (t.kind === PROMISED_TIME_TIMER) repo.cases.update(kase.id, { promised_by: timer.due_at });
      note(kase, { kind: "timer_set", timer_kind: t.kind, due_at: timer.due_at }, timer.id);
    }
  };
  const propose = (kase: Case, actions?: ProposedAction[]) => {
    if (actions?.length) note(kase, { kind: "actions_proposed", actions });
  };
  // Compares against the case as it is now: a hook may already have moved it
  // (a failed guard moves the case to waiting_merchant itself).
  const move = (kase: Case, to: CaseState, reason: string, patch?: Parameters<typeof transition>[4]["patch"]) => {
    const current = repo.cases.get(kase.id)!;
    return to === current.state ? current : transition(db, clock, kase.id, to, { reason, evidenceRef, patch });
  };

  let trigger: EngineEvent | null = event;
  let approval: Approval | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const kase = repo.cases.get(caseId)!;

    // A merchant's tap is handled here, not by a hook, and before the
    // finished-case check so a tap on a finished case is recorded as ignored.
    if (trigger?.kind === "tap") {
      const tap = tapPayload.parse(trigger.payload);
      trigger = null;
      // Taking over works from any open state. Events run one at a time, so
      // an action that was running has already finished by now.
      if (tap.choice === "handle_myself") {
        takeOver(deps, kase, evidenceRef);
        return repo.cases.get(caseId)!;
      }
      if (tap.choice === "change") {
        if (kase.state !== "waiting_merchant") {
          note(kase, { kind: "tap_ignored", state: kase.state, why: "change" });
          return kase;
        }
        // Recorded as data; the flow redrafts from it, never follows it.
        note(kase, { kind: "change_requested", text: tap.text });
        const spec = deps.registry.forMoment(kase.moment);
        if (spec?.onChange) {
          const r = await spec.onChange(deps, kase, tap.text!, event);
          note(kase, { kind: "change_handled", reason: r.reason });
          propose(kase, r.proposals);
        }
        return repo.cases.get(caseId)!;
      }
      if (kase.state !== "waiting_merchant") {
        note(kase, { kind: "tap_ignored", state: kase.state });
        return kase;
      }
      const offered = openProposals(deps, kase.id);
      if (!offered.some((p) => p.id === tap.proposalId)) {
        note(kase, { kind: "tap_ignored", state: kase.state, proposal_id: tap.proposalId, why: "not an open proposal" });
        return kase;
      }
      if (tap.choice === "decline") {
        // A no is not the end: the case stays with the merchant, timers keep
        // running, and the merchant sees the other options or can tell RAY
        // what to do instead.
        note(kase, {
          kind: "proposal_declined",
          proposal_id: tap.proposalId,
          alternatives: offered.filter((p) => p.id !== tap.proposalId),
          change_prompt: CHANGE_PROMPT,
          handle_myself_label: HANDLE_MYSELF_LABEL,
        });
        return kase;
      }
      approval = { by: "tap", tap, evidenceRef };
      move(kase, "acting", "Merchant tapped approve");
      continue;
    }

    if (isFinal(kase.state)) return kase;
    const spec = deps.registry.forMoment(kase.moment);
    if (!spec) {
      if (step === 0) note(kase, { kind: "no_specialist", moment: kase.moment });
      return kase;
    }

    const external = trigger;
    trigger = null;
    const before = kase.state;

    // The promised time passed: every flow decides what that means for the
    // customer (usually a holding message).
    if (external?.kind === "timer" && external.payload.timer_kind === PROMISED_TIME_TIMER) {
      note(kase, { kind: "promised_time_reached", promised_by: kase.promised_by, timer_id: external.sourceId });
      const r = await spec.onPromisedTime(deps, kase, external);
      note(kase, { kind: "promised_time_handled", reason: r.reason, to: r.to ?? kase.state });
      setTimers(kase, r.timers);
      propose(kase, r.proposals);
      if (r.to) move(kase, r.to, r.reason);
      const after = repo.cases.get(caseId)!;
      if (after.state === before) return after;
      continue;
    }

    switch (kase.state) {
      case "likely":
      case "waiting_customer":
      case "waiting_merchant":
      case "unconfirmed": {
        // These wait for new evidence; a continuation does nothing.
        if (!external) return kase;
        const r = await spec.investigate(deps, kase, external);
        writeFindings(deps, kase, r.findings, evidenceRef);
        const fields = {
          ...(r.confidence ? { confidence: r.confidence } : {}),
          ...(r.side ? { side: r.side } : {}),
          ...(r.cause ? { cause: r.cause } : {}),
          ...(r.situation ? { situation: r.situation } : {}),
        };
        if (Object.keys(fields).length > 0) repo.cases.update(kase.id, fields);
        note(kase, { kind: "investigated", to: r.to, reason: r.reason, confidence: r.confidence, side: r.side, cause: r.cause });
        setTimers(kase, r.timers);
        propose(kase, r.proposals);
        if (r.to === "closed") {
          // Closed straight from new evidence (Step 11: the money landed).
          const saved = await spec.countsAsSaved(deps, repo.cases.get(caseId)!);
          move(repo.cases.get(caseId)!, "closed", r.reason, { closed_at: clock.now(), outcome: r.outcome ?? "verified", counts_as_saved: saved });
        } else {
          move(repo.cases.get(caseId)!, r.to, r.reason);
        }
        break;
      }
      case "confirmed": {
        const d = await spec.decide(deps, kase);
        note(kase, { kind: "decided", to: d.to, summary: d.summary, rule_id: d.ruleId ?? null });
        let to: CaseState = d.to;
        if (to === "acting") {
          const rule = d.ruleId ? repo.playbookRules.get(d.ruleId) : undefined;
          if (!rule || rule.status !== "approved" || rule.merchant_id !== kase.merchant_id) {
            note(kase, { kind: "rule_not_approved", rule_id: d.ruleId ?? null });
            to = "waiting_merchant";
          } else {
            approval = { by: "rule", ruleId: rule.id, evidenceRef };
          }
        }
        if (to === "waiting_merchant" || to === "acting") {
          const actions = await spec.proposeActions(deps, kase, d);
          note(kase, { kind: "actions_proposed", actions });
        }
        setTimers(kase, d.timers);
        move(kase, to, approval?.by === "rule" ? `Approved rule ${approval.ruleId}` : d.reason);
        break;
      }
      case "acting": {
        if (!approval) {
          note(kase, { kind: "acting_without_approval" });
          return kase;
        }
        const r = await spec.onApproval(deps, kase, approval);
        approval = null;
        note(kase, { kind: "approval_handled", to: r.to, reason: r.reason }, evidenceRef);
        setTimers(kase, r.timers);
        propose(kase, r.proposals);
        move(kase, r.to, r.reason);
        break;
      }
      case "verifying": {
        const r = await spec.verify(deps, kase, external);
        note(kase, { kind: "verified", to: r.to, reason: r.reason, outcome: r.outcome ?? null });
        setTimers(kase, r.timers);
        propose(kase, r.proposals);
        if (r.to === "closed") {
          const saved = await spec.countsAsSaved(deps, kase);
          move(kase, "closed", r.reason, { closed_at: clock.now(), outcome: r.outcome ?? "verified", counts_as_saved: saved });
        } else {
          move(kase, r.to, r.reason);
        }
        break;
      }
      case "closed":
      case "fixed_itself":
        return kase;
    }

    const after = repo.cases.get(caseId)!;
    if (after.state === before) return after;
  }
  const kase = repo.cases.get(caseId)!;
  note(kase, { kind: "step_cap_hit", steps: MAX_STEPS });
  throw new StepCapError(`Case ${caseId} hit the step cap of ${MAX_STEPS}`);
}

function writeFindings(deps: OrchestratorDeps, kase: Case, findings: Finding[], eventRowId: string) {
  for (const f of findings) {
    if (!f.text || !f.evidenceRef) throw new Error("Every finding needs text and an evidence reference");
    deps.repo.caseEvents.insert({
      id: newId("cev"),
      case_id: kase.id,
      at: deps.clock.now(),
      type: "finding",
      payload: { text: f.text, cited_by: eventRowId },
      evidence_ref: f.evidenceRef,
    });
  }
}


// The latest proposals still on offer: the last actions_proposed note,
// minus any the merchant declined since.
export function openProposals(deps: EngineContext, caseId: string): ProposedAction[] {
  const timeline = deps.repo.caseEvents.listByCase(caseId);
  const lastIdx = timeline.findLastIndex((e) => e.payload.kind === "actions_proposed");
  if (lastIdx < 0) return [];
  const declined = new Set(
    timeline
      .slice(lastIdx + 1)
      .filter((e) => e.payload.kind === "proposal_declined")
      .map((e) => e.payload.proposal_id as string),
  );
  return (timeline[lastIdx].payload.actions as ProposedAction[]).filter((p) => !declined.has(p.id));
}

// The merchant takes the case over: call off everything RAY has queued for
// it (pending timers, held actions such as a refund in its hold or a
// scheduled call), record that, then close with handled_by_merchant.
export function takeOver(deps: EngineContext, kase: Case, evidenceRef: string) {
  const { db, repo, clock } = deps;
  if (isFinal(kase.state)) {
    note(deps, kase, { kind: "tap_ignored", state: kase.state, why: "case already finished" }, evidenceRef);
    return;
  }
  db.transaction(() => {
    const now = clock.now();
    const timers = db
      .select()
      .from(s.timers)
      .where(and(eq(s.timers.case_id, kase.id), isNull(s.timers.fired_at), isNull(s.timers.cancelled_at)))
      .all();
    for (const t of timers) repo.timers.update(t.id, { cancelled_at: now });
    const held = db
      .select()
      .from(s.actions)
      .where(and(eq(s.actions.case_id, kase.id), eq(s.actions.status, "held")))
      .all();
    for (const a of held) repo.actions.update(a.id, { status: "cancelled", result: { cancelled_because: HANDLED_BY_MERCHANT } });
    note(
      deps,
      kase,
      {
        kind: "takeover_cancelled",
        timers: timers.map((t) => ({ id: t.id, kind: t.kind, due_at: t.due_at })),
        actions: held.map((a) => ({ id: a.id, tool: a.tool, run_after: a.run_after })),
      },
      evidenceRef,
    );
    transition(db, clock, kase.id, "closed", {
      reason: "Merchant will handle it",
      evidenceRef,
      patch: { closed_at: now, outcome: HANDLED_BY_MERCHANT, counts_as_saved: false },
    });
  });
}

function note(deps: EngineContext, kase: Case, payload: Record<string, unknown>, evidenceRef: string) {
  deps.repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: deps.clock.now(), type: "note", payload, evidence_ref: evidenceRef });
}

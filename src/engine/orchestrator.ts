// Wakes on every event, reloads the case and calls the specialist hook that
// fits its state. Hooks only return results; this file writes them to
// case_events (each with an evidence reference) and moves the case through
// the state machine. Stops when the case waits on someone or is final.
import { newId } from "@/adapters/ids";
import type { CaseState } from "@/db/schema";
import { tapPayload, type EngineEvent } from "./events";
import type { Approval, EngineContext, Finding, Registry, TimerRequest } from "./specialist";
import { isFinal, transition, type Case } from "./state-machine";

export const MAX_STEPS = 12;

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
      note(kase, { kind: "timer_set", timer_kind: t.kind, due_at: timer.due_at }, timer.id);
    }
  };
  const move = (kase: Case, to: CaseState, reason: string, patch?: Parameters<typeof transition>[4]["patch"]) =>
    to === kase.state ? kase : transition(db, clock, kase.id, to, { reason, evidenceRef, patch });

  let trigger: EngineEvent | null = event;
  let approval: Approval | null = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    const kase = repo.cases.get(caseId)!;
    if (isFinal(kase.state)) return kase;
    const spec = deps.registry.forMoment(kase.moment);
    if (!spec) {
      if (step === 0) note(kase, { kind: "no_specialist", moment: kase.moment });
      return kase;
    }

    // A merchant's tap is handled here, not by a hook.
    if (trigger?.kind === "tap") {
      const tap = tapPayload.parse(trigger.payload);
      trigger = null;
      if (kase.state !== "waiting_merchant") {
        note(kase, { kind: "tap_ignored", state: kase.state });
        return kase;
      }
      if (tap.choice === "decline") {
        move(kase, "closed", "Merchant said no", { closed_at: clock.now(), outcome: "declined_by_merchant", counts_as_saved: false });
        return repo.cases.get(caseId)!;
      }
      approval = { by: "tap", tap, evidenceRef };
      move(kase, "acting", "Merchant tapped approve");
      continue;
    }

    const external = trigger;
    trigger = null;
    const before = kase.state;

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
        move(repo.cases.get(caseId)!, r.to, r.reason);
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
        move(kase, r.to, r.reason);
        break;
      }
      case "verifying": {
        const r = await spec.verify(deps, kase, external);
        note(kase, { kind: "verified", to: r.to, reason: r.reason, outcome: r.outcome ?? null });
        setTimers(kase, r.timers);
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


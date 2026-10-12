// What the merchant can do from a surface. Taps go to handleEvent, the same
// entry point as every other event; nothing here moves money.
import { z } from "zod";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Engine } from "@/engine/engine";
import { TAP_CHOICES } from "@/engine/events";
import { proposeSetupRules } from "@/engine/setup-rules";
import { CALL_TIMER } from "@/engine/specialist";
import { isFinal } from "@/engine/state-machine";
import { undoAction } from "@/guards";
import { SETTING_KEYS, writeSetting } from "./playbook";

export const tapInput = z.object({
  caseId: z.string().min(1),
  choice: z.enum(TAP_CHOICES),
  proposalId: z.string().optional(),
});

export async function tap(engine: Engine, a: Adapters, input: z.input<typeof tapInput>) {
  const { caseId, choice, proposalId } = tapInput.parse(input);
  const kase = createRepository(a.db).cases.get(caseId);
  if (!kase) throw new Error(`Case ${caseId} not found`);
  return engine.handleEvent({
    kind: "tap",
    merchantId: kase.merchant_id,
    caseId,
    at: a.clock.now(),
    sourceId: newId("tap"),
    payload: { choice, ...(proposalId ? { proposalId } : {}) },
  });
}

export const changeInput = z.object({ caseId: z.string().min(1), text: z.string().trim().min(1).max(500) });

// Change: the merchant says what to do instead. It is recorded on the case
// as data (never followed as an instruction); from Step 7 each flow sends it
// to the write job to redraft and the same card comes back.
export function requestChange(a: Adapters, input: z.input<typeof changeInput>) {
  const { caseId, text } = changeInput.parse(input);
  const repo = createRepository(a.db);
  const kase = repo.cases.get(caseId);
  if (!kase) throw new Error(`Case ${caseId} not found`);
  if (isFinal(kase.state)) throw new Error("This case is closed.");
  return repo.caseEvents.insert({
    id: newId("cev"),
    case_id: caseId,
    at: a.clock.now(),
    type: "note",
    payload: { kind: "change_requested", text },
    evidence_ref: newId("chg"),
  });
}

export const cancelCallInput = z.object({ caseId: z.string().min(1), timerId: z.string().min(1) });

// Pre-call notice: Cancel call. The follow-up call's timer is called off and
// the case records it. Nothing else changes.
export function cancelCall(a: Adapters, input: z.input<typeof cancelCallInput>) {
  const { caseId, timerId } = cancelCallInput.parse(input);
  const repo = createRepository(a.db);
  const timer = repo.timers.get(timerId);
  if (!timer || timer.case_id !== caseId || timer.kind !== CALL_TIMER) throw new Error("That call isn't planned on this case.");
  if (timer.fired_at !== null || timer.cancelled_at !== null) throw new Error("That call has already happened or was cancelled.");
  repo.timers.update(timerId, { cancelled_at: a.clock.now() });
  return repo.caseEvents.insert({
    id: newId("cev"),
    case_id: caseId,
    at: a.clock.now(),
    type: "note",
    payload: { kind: "call_cancelled", timer_id: timerId, due_at: timer.due_at },
    evidence_ref: timerId,
  });
}

// "Let RAY fix these": RAY on, and the setup rules proposed (each off until
// the merchant approves it).
export function letRayFix(a: Adapters, merchantId: string) {
  const repo = createRepository(a.db);
  if (!repo.merchants.update(merchantId, { ray_on: true })) throw new Error(`Merchant ${merchantId} not found`);
  proposeSetupRules(a.db, merchantId);
}

export const ruleInput = z.object({ merchantId: z.string(), ruleId: z.string(), status: z.enum(s.RULE_STATUSES) });

export function setRuleStatus(a: Adapters, input: z.input<typeof ruleInput>) {
  const { merchantId, ruleId, status } = ruleInput.parse(input);
  const repo = createRepository(a.db);
  const rule = repo.playbookRules.get(ruleId);
  if (!rule || rule.merchant_id !== merchantId) throw new Error(`Rule ${ruleId} not found`);
  return repo.playbookRules.update(ruleId, { status, approved_at: status === "approved" ? a.clock.now() : null });
}

export const settingInput = z.object({
  merchantId: z.string(),
  moment: z.enum(s.MOMENTS),
  key: z.enum(SETTING_KEYS),
  value: z.union([z.string().trim().min(1).max(80), z.boolean()]),
});

export function setSetting(a: Adapters, input: z.input<typeof settingInput>) {
  const { merchantId, moment, key, value } = settingInput.parse(input);
  if (key === "send_from" && !(s.SENDER_MODES as readonly unknown[]).includes(value)) throw new Error("Pick where messages are sent from");
  return writeSetting(a.db, a.clock.now(), merchantId, moment, key, value);
}

export const limitInput = z.object({ merchantId: z.string(), rupees: z.number().int().min(0).max(10_000_000) });

export function setApprovalLimit(a: Adapters, input: z.input<typeof limitInput>) {
  const { merchantId, rupees } = limitInput.parse(input);
  if (!createRepository(a.db).merchants.update(merchantId, { approval_limit: rupees * 100 })) throw new Error(`Merchant ${merchantId} not found`);
}

export async function undo(a: Adapters, merchantId: string, actionId: string) {
  const repo = createRepository(a.db);
  const action = repo.actions.get(actionId);
  if (!action || repo.cases.get(action.case_id)?.merchant_id !== merchantId) throw new Error(`Action ${actionId} not found`);
  return undoAction(a, actionId);
}

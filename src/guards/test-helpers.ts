import { newId } from "@/adapters/ids";
import { seededAdapters } from "@/adapters/test-helpers";
import { createRepository } from "@/db/repository";
import type * as s from "@/db/schema";
import type { Approval, ProposedAction } from "@/engine/specialist";
import { guardedCall } from ".";

export const LEAFY = "m_leafy_bakes";
export const PRIYA = "+919800000101";
export const PRIYA_PAY = "pay_LB1234PRIYA";
export const PRIYA_ORDER = "so_leafy_1234";
export const MIN = 60_000;

export function guardWorld() {
  const a = seededAdapters();
  const repo = createRepository(a.db);

  // A case inserted straight into a state (inserts don't need the state
  // machine; later moves do).
  const openCase = (over: Partial<typeof s.cases.$inferInsert> = {}) =>
    repo.cases.insert({
      id: newId("case"),
      merchant_id: LEAFY,
      moment: "paid_no_order",
      state: "waiting_merchant",
      confidence: "sure",
      payment_id: PRIYA_PAY,
      store_order_id: PRIYA_ORDER,
      amount: 129_900,
      opened_at: a.clock.now(),
      ...over,
    });

  const note = (caseId: string, payload: Record<string, unknown>, type: "note" | "approval" | "message_in" = "note", ref = "test") =>
    repo.caseEvents.insert({ id: newId("cev"), case_id: caseId, at: a.clock.now(), type, payload, evidence_ref: ref });

  // The merchant is offered tool(args) and taps approve, as the engine records it.
  const tapFor = (caseId: string, tool: string, args: Record<string, unknown>, proposalId = newId("prop")): Approval => {
    const action: ProposedAction = { id: proposalId, label: tool, tool, args, covered: false };
    note(caseId, { kind: "actions_proposed", actions: [action] });
    const ev = note(caseId, { source: "tap", keys: {}, choice: "approve", proposalId }, "approval", `tap_${proposalId}`);
    return { by: "tap", tap: { choice: "approve", proposalId }, evidenceRef: ev.id };
  };

  const rule = (status: "approved" | "proposed" = "approved", over: Partial<typeof s.playbookRules.$inferInsert> = {}) =>
    repo.playbookRules.insert({
      id: newId("rule"),
      merchant_id: LEAFY,
      moment: "paid_no_order",
      rule_json: {},
      text: "Refund duplicates under ₹2,000",
      source: "merchant",
      status,
      approved_at: status === "approved" ? a.clock.now() : null,
      ...over,
    });

  const call = (caseId: string, tool: string, args: Record<string, unknown>, approval?: Approval) =>
    guardedCall(tool, args, { adapters: a, caseId, approval });

  return { a, repo, openCase, note, tapFor, rule, call, close: () => a.db.$client.close() };
}
export type GuardWorld = ReturnType<typeof guardWorld>;

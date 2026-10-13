import { and, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";

export type CollectWorkflow = {
  buyerId: string;
  channel: "engine" | "email" | "whatsapp";
  tone: "gentle" | "firm";
  timing: "after_review" | "next_morning";
  requireApproval: true;
  savedAt: number;
};

export function enableBankingPlusDemo(a: Adapters, merchantId: string) {
  const repo = createRepository(a.db);
  const merchant = repo.merchants.get(merchantId);
  if (!merchant) throw new Error("Merchant not found.");
  // Demo capability flag only. No account or bank connection is created.
  repo.merchants.update(merchantId, { banking_plus: true });
  return { outcome: "enabled_simulation" as const };
}

export function saveCollectWorkflow(a: Adapters, input: Omit<CollectWorkflow, "savedAt"> & { merchantId: string }) {
  const repo = createRepository(a.db);
  const merchant = repo.merchants.get(input.merchantId);
  const buyer = repo.buyers.get(input.buyerId);
  if (!merchant || !buyer || buyer.merchant_id !== input.merchantId) throw new Error("Choose a seeded buyer for this merchant.");
  if (!merchant.banking_plus) throw new Error("Enable the simulated Banking+ workflow first.");
  if (input.timing !== "after_review") throw new Error("This prototype has no background scheduler. Choose after review.");
  const workflow: CollectWorkflow = {
    buyerId: input.buyerId, channel: input.channel, tone: input.tone, timing: input.timing,
    requireApproval: true, savedAt: a.clock.now(),
  };
  a.db.insert(s.uiState).values({ merchant_id: input.merchantId, key: "collect.workflow", value: workflow, updated_at: workflow.savedAt })
    .onConflictDoUpdate({ target: [s.uiState.merchant_id, s.uiState.key], set: { value: workflow, updated_at: workflow.savedAt } }).run();
  const kase = repo.cases.list(and(eq(s.cases.merchant_id, input.merchantId), eq(s.cases.moment, "collect")))
    .find((item) => repo.caseEvents.listByCase(item.id).some((event) => event.payload.kind === "collect_case" && event.payload.buyer_id === input.buyerId));
  if (kase) repo.caseEvents.insert({
    id: newId("cev"), case_id: kase.id, at: workflow.savedAt, type: "note",
    payload: { kind: "collect_workflow_saved", buyer_id: input.buyerId, channel: input.channel, tone: input.tone, timing: input.timing, require_approval: true, simulated: true }, evidence_ref: input.buyerId,
  });
  return { outcome: "saved" as const, workflow, caseId: kase?.id ?? null };
}

// Simulated systems for chargebacks, behind small functions: the filing
// setting, the card network's outcome (won, lost, withdrawn) and the
// escalation to pre-arbitration, each reaching the case as a Razorpay
// webhook through handleEvent. Every one of them is labelled Simulated.
import { eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import { cbSettings, type FilingPath } from "./schema";

export const DEFAULT_FILING: FilingPath = "disputes_api";

export function filingOf(db: Db, merchantId: string): FilingPath {
  return db.select().from(cbSettings).where(eq(cbSettings.merchant_id, merchantId)).get()?.filing ?? DEFAULT_FILING;
}

export function setFiling(db: Db, now: number, merchantId: string, filing: FilingPath) {
  db.insert(cbSettings)
    .values({ merchant_id: merchantId, filing, updated_at: now })
    .onConflictDoUpdate({ target: cbSettings.merchant_id, set: { filing, updated_at: now } })
    .run();
}

export const FILING_LABEL: Record<FilingPath, string> = {
  dispute_responder: "Dispute Responder (Simulated)",
  disputes_api: "Razorpay Disputes",
  manual: "You upload it",
};

export type Outcome = "won" | "lost" | "withdrawn";

// The network decides (Simulated). A withdrawal closes the dispute in the
// merchant's favour. Then Razorpay's webhook goes out.
export async function settleDispute(a: Adapters, merchantId: string, disputeId: string, outcome: Outcome) {
  const repo = createRepository(a.db);
  const d = repo.disputes.get(disputeId);
  if (!d || d.merchant_id !== merchantId) throw new Error(`Dispute ${disputeId} not found`);
  const status = outcome === "withdrawn" ? "closed" : outcome;
  repo.disputes.update(disputeId, { status });
  const event = outcome === "won" ? "payment.dispute.won" : outcome === "lost" ? "payment.dispute.lost" : "payment.dispute.closed";
  return a.webhooks.emit({ merchantId, event, disputeId });
}

// The cardholder's bank takes it to pre-arbitration (Simulated).
export async function escalateDispute(a: Adapters, merchantId: string, disputeId: string, respondBy: number) {
  const repo = createRepository(a.db);
  const d = repo.disputes.get(disputeId);
  if (!d || d.merchant_id !== merchantId) throw new Error(`Dispute ${disputeId} not found`);
  const phase = d.phase === "chargeback" ? "pre_arbitration" : "arbitration";
  repo.disputes.update(disputeId, { phase, status: "open", respond_by: respondBy, draft_json: null, draft_status: null });
  return a.webhooks.emit({ merchantId, event: "payment.dispute.action_required", disputeId });
}

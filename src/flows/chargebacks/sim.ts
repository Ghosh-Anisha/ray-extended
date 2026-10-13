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
export const OUTCOME_EVENT = { won: "payment.dispute.won", lost: "payment.dispute.lost", withdrawn: "payment.dispute.closed" } as const;

// The network decides (Simulated): Razorpay's outcome webhook goes out, the
// same event the dev panel fires. The flow's handler updates the dispute
// and closes the case; nothing is set here.
export function fireOutcome(a: Adapters, merchantId: string, disputeId: string, outcome: Outcome) {
  return a.webhooks.emit({ merchantId, event: OUTCOME_EVENT[outcome], disputeId });
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

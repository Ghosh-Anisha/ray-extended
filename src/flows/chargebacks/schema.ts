// The chargeback flow's own tables (migration 1000_chargebacks). Kept with
// the flow; everything a case or a guard reads lives in the database.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { merchants, rzpPayments } from "@/db/schema";

const bool = (name: string) => integer(name, { mode: "boolean" });

// How dispute responses are filed for a merchant.
// dispute_responder: Razorpay's Dispute Responder (Simulated hand-off).
// disputes_api: RAY drafts on the Disputes API and submits on approval.
// manual: RAY prepares the pack; the merchant uploads it.
export const FILING_PATHS = ["dispute_responder", "disputes_api", "manual"] as const;
export type FilingPath = (typeof FILING_PATHS)[number];

export const cbSettings = sqliteTable("cb_settings", {
  merchant_id: text("merchant_id")
    .primaryKey()
    .references(() => merchants.id),
  filing: text("filing", { enum: FILING_PATHS }).notNull(),
  updated_at: integer("updated_at").notNull(),
});

// Simulated: device and IP, delivery address and Vulcan's result for a
// payment. RAY reads Vulcan's result; it never re-scores it.
export const VULCAN_RESULTS = ["flagged", "clear"] as const;
export const cbFraudSignals = sqliteTable("cb_fraud_signals", {
  payment_id: text("payment_id")
    .primaryKey()
    .references(() => rzpPayments.id),
  merchant_id: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  vulcan_result: text("vulcan_result", { enum: VULCAN_RESULTS }).notNull(),
  device_seen_before: bool("device_seen_before").notNull(),
  ip_country: text("ip_country").notNull(),
  address_matches: bool("address_matches").notNull(),
  checked_at: integer("checked_at").notNull(),
});

// Simulated Buyer Protection claims. An open claim on the disputed payment
// is evidence for the pack.
export const cbBuyerProtectionClaims = sqliteTable("cb_buyer_protection_claims", {
  id: text("id").primaryKey(),
  merchant_id: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  payment_id: text("payment_id")
    .notNull()
    .references(() => rzpPayments.id),
  status: text("status", { enum: ["open", "closed"] }).notNull(),
  summary: text("summary").notNull(),
  opened_at: integer("opened_at").notNull(),
});

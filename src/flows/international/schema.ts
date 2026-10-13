// This flow's own tables (migration 0800_international). Simulated Razorpay
// systems for card payments from abroad: account settings, the internal
// signals RAY reads (Vulcan, risk hold, 3DS), MoneySaver receiving accounts
// and the bank transfers that land in them. Kept out of src/db/schema.ts on
// purpose: the seed test pins the row count of every table there.
// Money is minor units in the row's currency; limits are INR paise.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { merchants } from "@/db/schema";

const bool = (name: string) => integer(name, { mode: "boolean" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const CHECKOUT_KINDS = ["standard", "custom"] as const;
export const BUYER_TYPES = ["b2b", "b2c"] as const;
export const VULCAN_RESULTS = ["clean", "review", "fraud_suspected"] as const;
export const RISK_HOLDS = ["none", "held", "cleared", "declined"] as const;
export const THREE_DS = ["passed", "failed", "timed_out", "not_enrolled"] as const;

export const intlSettings = sqliteTable("intl_settings", {
  merchant_id: text("merchant_id").primaryKey().references(() => merchants.id),
  international_on: bool("international_on").notNull(),
  // Largest single international card payment the account accepts.
  limit_inr: integer("limit_inr").notNull(),
  currencies: json<string[]>("currencies").notNull(),
  networks: json<string[]>("networks").notNull(),
  checkout: text("checkout", { enum: CHECKOUT_KINDS }).notNull(),
  paypal_on: bool("paypal_on").notNull(),
  moneysaver_on: bool("moneysaver_on").notNull(),
  billing_address_required: bool("billing_address_required").notNull(),
  // The playbook's answer to "who buys from you abroad?", if the merchant gave one.
  buyer_type: text("buyer_type", { enum: BUYER_TYPES }),
  updated_at: integer("updated_at").notNull(),
});

// What Razorpay's own systems said about a payment. RAY reads these and never
// re-scores them.
export const intlPaymentSignals = sqliteTable("intl_payment_signals", {
  payment_id: text("payment_id").primaryKey(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  vulcan_result: text("vulcan_result", { enum: VULCAN_RESULTS }).notNull(),
  risk_hold: text("risk_hold", { enum: RISK_HOLDS }).notNull(),
  three_ds: text("three_ds", { enum: THREE_DS }),
  updated_at: integer("updated_at").notNull(),
});

// MoneySaver: local bank accounts abroad that pay out to the merchant in India.
export const intlAccounts = sqliteTable("intl_accounts", {
  id: text("id").primaryKey(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  currency: text("currency").notNull(),
  bank_name: text("bank_name").notNull(),
  account_name: text("account_name").notNull(),
  account_number: text("account_number").notNull(),
  // Sort code (GBP), routing number (USD) or IBAN (EUR), as the bank calls it.
  routing_label: text("routing_label").notNull(),
  routing: text("routing").notNull(),
  swift: text("swift").notNull(),
});

// A bank transfer that landed in a MoneySaver account. Settlement to the
// merchant is held until an invoice is attached; whether one is attached is
// read from the guarded invoice_attach action, so there is one source of truth.
export const intlTransfers = sqliteTable("intl_transfers", {
  id: text("id").primaryKey(),
  merchant_id: text("merchant_id").notNull().references(() => merchants.id),
  account_id: text("account_id").notNull().references(() => intlAccounts.id),
  currency: text("currency").notNull(),
  amount: integer("amount").notNull(),
  base_amount: integer("base_amount").notNull(), // INR paise
  remitter_name: text("remitter_name").notNull(),
  remitter_reference: text("remitter_reference").notNull(),
  // The invoice the buyer quoted, when the bank passed one on.
  invoice_ref: text("invoice_ref"),
  received_at: integer("received_at").notNull(),
});

// The error_reason lookup table (code, no model). Razorpay's error_reason and
// error_source on a failed card payment from abroad decide the situation
// (A to E), whose side it is on, the cause, and the cause-specific message
// the buyer sees on the checkout page. F (the buyer left before finishing)
// has no failed payment, so it has no row here.
import * as s from "@/db/schema";

export type Situation = (typeof s.SITUATIONS)[number];
export type Side = (typeof s.SIDES)[number];

export const CAUSES = {
  card_not_international: { situation: "A", side: "customer_or_bank" },
  card_not_online: { situation: "A", side: "customer_or_bank" },
  three_ds_failed: { situation: "B", side: "customer_or_bank" },
  three_ds_timed_out: { situation: "B", side: "customer_or_bank" },
  bank_declined: { situation: "C", side: "customer_or_bank" },
  bank_declined_fraud: { situation: "C", side: "customer_or_bank" },
  above_limit: { situation: "D", side: "merchant" },
  currency_off: { situation: "D", side: "merchant" },
  network_off: { situation: "D", side: "merchant" },
  billing_missing: { situation: "D", side: "merchant" },
  international_off: { situation: "D", side: "merchant" },
  risk_hold: { situation: "E", side: "razorpay" },
  left_checkout: { situation: "F", side: "customer_or_bank" },
} as const satisfies Record<string, { situation: Situation; side: Side }>;
export type Cause = keyof typeof CAUSES;
export const isCause = (v: unknown): v is Cause => typeof v === "string" && v in CAUSES;

// error_reason + error_source -> cause. "*" matches any source; the most
// specific row wins (exact source first).
const ROWS: { reason: string; source: string; cause: Cause }[] = [
  // A: the card itself isn't turned on for this.
  { reason: "international_transaction_not_allowed", source: "customer", cause: "card_not_international" },
  { reason: "international_transaction_not_allowed", source: "issuer_bank", cause: "card_not_international" },
  { reason: "card_not_enabled_for_international", source: "*", cause: "card_not_international" },
  { reason: "card_not_enabled_for_online_payments", source: "*", cause: "card_not_online" },
  { reason: "online_transactions_disabled", source: "*", cause: "card_not_online" },
  // B: the card security check (3DS).
  { reason: "authentication_failed", source: "*", cause: "three_ds_failed" },
  { reason: "3dsecure_authentication_failed", source: "*", cause: "three_ds_failed" },
  { reason: "authentication_timed_out", source: "*", cause: "three_ds_timed_out" },
  { reason: "payment_timed_out", source: "customer", cause: "three_ds_timed_out" },
  // C: the buyer's bank said no.
  { reason: "payment_declined", source: "issuer_bank", cause: "bank_declined" },
  { reason: "card_declined", source: "issuer_bank", cause: "bank_declined" },
  { reason: "do_not_honour", source: "issuer_bank", cause: "bank_declined" },
  { reason: "insufficient_funds", source: "*", cause: "bank_declined" },
  { reason: "suspected_fraud", source: "issuer_bank", cause: "bank_declined_fraud" },
  { reason: "card_reported_lost_or_stolen", source: "issuer_bank", cause: "bank_declined_fraud" },
  // D: something on the merchant's account blocks it.
  { reason: "amount_exceeds_maximum_amount_allowed", source: "*", cause: "above_limit" },
  { reason: "currency_not_supported", source: "*", cause: "currency_off" },
  { reason: "card_network_not_enabled", source: "*", cause: "network_off" },
  { reason: "network_not_supported", source: "business", cause: "network_off" },
  { reason: "billing_address_required", source: "*", cause: "billing_missing" },
  { reason: "international_transaction_not_allowed", source: "business", cause: "international_off" },
  // E: Razorpay's own risk check held it.
  { reason: "payment_risk_check_failed", source: "*", cause: "risk_hold" },
  { reason: "payment_held_for_review", source: "*", cause: "risk_hold" },
];

export function lookup(reason: string | null | undefined, source: string | null | undefined): Cause | null {
  if (!reason) return null;
  const rows = ROWS.filter((r) => r.reason === reason);
  return (rows.find((r) => r.source === source) ?? rows.find((r) => r.source === "*"))?.cause ?? null;
}

// The D request each merchant-side cause needs (draft_request's request).
export const REQUEST_FOR: Partial<Record<Cause, "international_limit" | "currency_enable" | "network_enable" | "billing_details" | "other">> = {
  above_limit: "international_limit",
  currency_off: "currency_enable",
  network_off: "network_enable",
  billing_missing: "billing_details",
  international_off: "other",
};

// What happened, in plain words for the merchant (design language section 1).
export function causeLine(cause: Cause, ctx: { first: string; limit?: string; currency?: string; network?: string }): string {
  switch (cause) {
    case "card_not_international":
      return `${ctx.first}'s card isn't turned on for payments abroad.`;
    case "card_not_online":
      return `${ctx.first}'s card isn't turned on for online payments.`;
    case "three_ds_failed":
      return `${ctx.first}'s card security check didn't go through.`;
    case "three_ds_timed_out":
      return `${ctx.first}'s card security check timed out.`;
    case "bank_declined":
      return `${ctx.first}'s bank declined the card.`;
    case "bank_declined_fraud":
      return `${ctx.first}'s bank declined the card as possible fraud.`;
    case "above_limit":
      return `It's above your international limit${ctx.limit ? ` of ${ctx.limit}` : ""}.`;
    case "currency_off":
      return `Your account doesn't take ${ctx.currency ?? "this currency"} yet.`;
    case "network_off":
      return `${ctx.network ? `${ctx.network[0].toUpperCase()}${ctx.network.slice(1)}` : "This card network"} is off on your account.`;
    case "billing_missing":
      return "Your checkout doesn't ask for the billing address, and this card's bank needs it.";
    case "international_off":
      return "Your account doesn't take cards from abroad yet.";
    case "risk_hold":
      return "Razorpay's risk check held it.";
    case "left_checkout":
      return `${ctx.first} left before paying.`;
  }
}

// The cause-specific message the buyer sees on the checkout page (Step 8's
// "Checkout failure screen" column). The fraud decline, and every bank
// decline, never suggests the same card.
export function checkoutMessage(cause: Cause, opts: { paypal: boolean }): string | null {
  const orPaypal = opts.paypal ? ", or pay with PayPal" : "";
  switch (cause) {
    case "card_not_international":
      return "This card isn't turned on for payments abroad. Turn it on in your bank app and try again, or use another card.";
    case "card_not_online":
      return "This card isn't turned on for online payments. Turn it on in your bank app and try again, or use another card.";
    case "three_ds_failed":
      return `Your bank's security check didn't go through. Try again${opts.paypal ? ", or pay with PayPal" : ", or use another card"}.`;
    case "three_ds_timed_out":
      return `Your bank's security check timed out. Try again${opts.paypal ? ", or pay with PayPal" : ", or use another card"}.`;
    case "bank_declined":
    case "bank_declined_fraud":
      return `Your bank declined this card. Please use another card${orPaypal}.`;
    case "above_limit":
    case "currency_off":
    case "network_off":
    case "billing_missing":
    case "international_off":
      return "This payment can't go through here. The seller will send you another way to pay.";
    case "risk_hold":
      return "We couldn't complete this payment. The seller has been told.";
    case "left_checkout":
      return null;
  }
}

// Every error_reason the table knows, for the simulator and tests.
export const KNOWN_ROWS = ROWS;

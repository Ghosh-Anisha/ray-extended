// The simulated checkout and the other simulated Razorpay systems this moment
// needs (Simulated in the UI). Each action writes the record the real system
// would and then reaches the engine the way a real event does: card and
// PayPal payments and expired links through the webhook sim, the rest
// through handleEvent. The checkout returns the cause-specific message the
// buyer sees; it comes from the lookup table, never a model.
import { and, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Engine } from "@/engine/engine";
import { normalizeEmail } from "@/engine/events";
import { CAUSES, checkoutMessage, type Cause } from "./errors";
import { LEAVE_MS, SIM_EVENTS } from ".";
import { createInternationalSim, toInr } from "./sim";

export const CARD_OUTCOMES = [
  "success",
  "card_not_international",
  "card_not_online",
  "three_ds_failed",
  "three_ds_timed_out",
  "bank_declined",
  "bank_declined_fraud",
  "billing_missing",
  "risk_hold",
] as const;
export type CardOutcome = (typeof CARD_OUTCOMES)[number];

// The error Razorpay reports for each simulated card outcome.
const ERROR: Record<Exclude<CardOutcome, "success">, { reason: string; source: string; code: string }> = {
  card_not_international: { reason: "international_transaction_not_allowed", source: "issuer_bank", code: "BAD_REQUEST_ERROR" },
  card_not_online: { reason: "card_not_enabled_for_online_payments", source: "issuer_bank", code: "BAD_REQUEST_ERROR" },
  three_ds_failed: { reason: "authentication_failed", source: "customer", code: "BAD_REQUEST_ERROR" },
  three_ds_timed_out: { reason: "authentication_timed_out", source: "customer", code: "BAD_REQUEST_ERROR" },
  bank_declined: { reason: "payment_declined", source: "issuer_bank", code: "BAD_REQUEST_ERROR" },
  bank_declined_fraud: { reason: "suspected_fraud", source: "issuer_bank", code: "BAD_REQUEST_ERROR" },
  billing_missing: { reason: "billing_address_required", source: "business", code: "BAD_REQUEST_ERROR" },
  risk_hold: { reason: "payment_risk_check_failed", source: "internal", code: "SERVER_ERROR" },
};
const MERCHANT_SIDE: Partial<Record<Cause, { reason: string; source: string }>> = {
  international_off: { reason: "international_transaction_not_allowed", source: "business" },
  currency_off: { reason: "currency_not_supported", source: "business" },
  network_off: { reason: "card_network_not_enabled", source: "business" },
  above_limit: { reason: "amount_exceeds_maximum_amount_allowed", source: "business" },
};

export type Buyer = { name: string; email: string; country: string; language?: string; phone?: string };

// The buyer opens checkout: a Razorpay order for them (the buyer is a
// customer of the merchant; added if new).
export function openCheckout(a: Adapters, input: { merchantId: string; amount: number; currency: string; receipt: string; buyer: Buyer }) {
  const repo = createRepository(a.db);
  const email = normalizeEmail(input.buyer.email)!;
  const known = repo.customers.list(eq(s.customers.merchant_id, input.merchantId)).find((c) => normalizeEmail(c.email) === email);
  if (!known) {
    repo.customers.insert({ id: newId("cus"), merchant_id: input.merchantId, name: input.buyer.name, email, phone: input.buyer.phone ?? null, country: input.buyer.country, language: input.buyer.language ?? "en" });
  }
  return repo.rzpOrders.insert({
    id: newId("order"),
    merchant_id: input.merchantId,
    status: "created",
    amount: input.amount,
    currency: input.currency,
    email,
    contact: input.buyer.phone ?? null,
    receipt: input.receipt,
    created_at: a.clock.now(),
  });
}

export type CheckoutResult = { paymentId: string; status: "captured" | "failed"; cause: Cause | null; message: string | null };

function orderOf(a: Adapters, merchantId: string, orderId: string) {
  const order = createRepository(a.db).rzpOrders.get(orderId);
  if (!order || order.merchant_id !== merchantId) throw new Error(`Order ${orderId} not found for ${merchantId}`);
  return order;
}

// The buyer pays by card. Merchant-side blocks come from the account's
// settings first; otherwise the chosen outcome decides.
export async function payByCard(
  a: Adapters,
  input: { merchantId: string; orderId: string; outcome: CardOutcome; cardLast4?: string; cardCountry?: string; network?: string },
): Promise<CheckoutResult> {
  const repo = createRepository(a.db);
  const sim = createInternationalSim(a.db, a.clock);
  const order = orderOf(a, input.merchantId, input.orderId);
  const st = sim.settings(input.merchantId);
  const base = toInr(order.amount, order.currency);
  const network = input.network ?? "visa";
  let outcome = input.outcome;
  // An approved "without 3DS" change skips the security check.
  if (st?.non_3ds && (outcome === "three_ds_failed" || outcome === "three_ds_timed_out")) outcome = "success";
  if (outcome === "billing_missing" && st?.billing_address_required) outcome = "success";
  let block: Cause | null = null;
  if (st && order.currency !== "INR") {
    if (!st.international_on) block = "international_off";
    else if (!st.currencies.includes(order.currency)) block = "currency_off";
    else if (!st.networks.includes(network)) block = "network_off";
    else if (base !== null && base > st.limit_inr) block = "above_limit";
  }
  const err = block ? { ...MERCHANT_SIDE[block]!, code: "BAD_REQUEST_ERROR" } : outcome === "success" ? null : ERROR[outcome];
  const now = a.clock.now();
  const p = repo.rzpPayments.insert({
    id: newId("pay"),
    merchant_id: input.merchantId,
    order_id: order.id,
    status: err ? "failed" : "captured",
    amount: order.amount,
    currency: order.currency,
    base_amount: order.currency === "INR" ? null : base,
    method: "card",
    email: order.email,
    contact: order.contact,
    card_last4: input.cardLast4 ?? "4242",
    card_country: input.cardCountry ?? "US",
    error_code: err?.code ?? null,
    error_source: err?.source ?? null,
    error_reason: err?.reason ?? null,
    receipt: order.receipt,
    created_at: now,
    captured_at: err ? null : now,
  });
  repo.rzpOrders.update(order.id, { status: err ? "attempted" : "paid" });
  sim.setSignals(input.merchantId, p.id, {
    vulcan_result: outcome === "bank_declined_fraud" ? "fraud_suspected" : "clean",
    risk_hold: outcome === "risk_hold" && !block ? "held" : "none",
    three_ds: outcome === "three_ds_failed" ? "failed" : outcome === "three_ds_timed_out" ? "timed_out" : "passed",
  });
  await a.webhooks.emit({ merchantId: input.merchantId, event: err ? "payment.failed" : "payment.captured", paymentId: p.id });
  const cause: Cause | null = block ?? (outcome === "success" ? null : outcome);
  return { paymentId: p.id, status: err ? "failed" : "captured", cause, message: cause ? checkoutMessage(cause, { paypal: sim.paypalAvailable(input.merchantId, order.currency) }) : null };
}

// PayPal: only on Standard Checkout, only for non-INR.
export async function payWithPaypal(a: Adapters, input: { merchantId: string; orderId: string }): Promise<CheckoutResult> {
  const repo = createRepository(a.db);
  const order = orderOf(a, input.merchantId, input.orderId);
  if (!createInternationalSim(a.db, a.clock).paypalAvailable(input.merchantId, order.currency)) throw new Error("PayPal isn't offered on this checkout");
  const now = a.clock.now();
  const p = repo.rzpPayments.insert({
    id: newId("pay"), merchant_id: input.merchantId, order_id: order.id, status: "captured", amount: order.amount, currency: order.currency,
    base_amount: toInr(order.amount, order.currency), method: "paypal", email: order.email, contact: order.contact, receipt: order.receipt, created_at: now, captured_at: now,
  });
  repo.rzpOrders.update(order.id, { status: "paid" });
  await a.webhooks.emit({ merchantId: input.merchantId, event: "payment.captured", paymentId: p.id });
  return { paymentId: p.id, status: "captured", cause: null, message: null };
}

// The buyer pays a payment link (one RAY sent, or the merchant's own).
export async function payLink(a: Adapters, input: { merchantId: string; linkId: string; method: "card" | "paypal" }): Promise<CheckoutResult> {
  const repo = createRepository(a.db);
  const link = repo.rzpLinks.get(input.linkId);
  if (!link || link.merchant_id !== input.merchantId) throw new Error(`Payment link ${input.linkId} not found`);
  if (link.status !== "created") throw new Error(`Payment link ${input.linkId} is ${link.status}`);
  const now = a.clock.now();
  const p = repo.rzpPayments.insert({
    id: newId("pay"), merchant_id: input.merchantId, status: "captured", amount: link.amount, currency: link.currency,
    base_amount: link.currency === "INR" ? null : toInr(link.amount, link.currency), method: input.method, email: link.email,
    card_last4: input.method === "card" ? "5555" : null, card_country: input.method === "card" ? "US" : null, created_at: now, captured_at: now,
  });
  repo.rzpLinks.update(link.id, { payment_id: p.id, status: "paid" });
  await a.webhooks.emit({ merchantId: input.merchantId, event: "payment.captured", paymentId: p.id });
  return { paymentId: p.id, status: "captured", cause: null, message: null };
}

export async function expireLink(a: Adapters, input: { merchantId: string; linkId: string }) {
  return a.webhooks.emit({ merchantId: input.merchantId, event: "payment_link.expired", linkId: input.linkId });
}

// Orders from abroad the buyer opened and left without one attempt, older
// than 30 min. Each goes to handleEvent once (F).
export async function abandonedCheckoutSweep(engine: Engine, a: Adapters, merchantId: string) {
  const repo = createRepository(a.db);
  const now = a.clock.now();
  const orders = repo.rzpOrders
    .list(and(eq(s.rzpOrders.merchant_id, merchantId), eq(s.rzpOrders.status, "created")))
    .filter((o) => o.currency !== "INR" && o.created_at <= now - LEAVE_MS)
    .filter((o) => !repo.rzpPayments.list(eq(s.rzpPayments.order_id, o.id)).length);
  const out = [];
  for (const o of orders) {
    out.push(
      await engine.handleEvent({
        kind: "webhook",
        merchantId,
        at: now,
        sourceId: `sweep_${o.id}`,
        keys: { email: normalizeEmail(o.email) },
        payload: { source: "razorpay", event: SIM_EVENTS.noAttempt, order_id: o.id, simulated: true },
      }),
    );
  }
  return out;
}

// A bank transfer lands in the merchant's MoneySaver account.
export async function landTransfer(
  engine: Engine,
  a: Adapters,
  input: { merchantId: string; currency: string; amount: number; remitterName: string; remitterReference: string; invoiceRef?: string | null },
) {
  const t = createInternationalSim(a.db, a.clock).landTransfer(input);
  const r = await engine.handleEvent({
    kind: "webhook",
    merchantId: input.merchantId,
    at: t.received_at,
    sourceId: t.id,
    payload: { source: "moneysaver", event: SIM_EVENTS.transfer, transfer_id: t.id, simulated: true },
  });
  return { transfer: t, result: r };
}

// Razorpay's risk desk finishes its review.
export async function riskReview(engine: Engine, a: Adapters, input: { merchantId: string; paymentId: string; cleared: boolean }) {
  createInternationalSim(a.db, a.clock).setSignals(input.merchantId, input.paymentId, { risk_hold: input.cleared ? "cleared" : "declined" });
  return engine.handleEvent({
    kind: "webhook",
    merchantId: input.merchantId,
    at: a.clock.now(),
    sourceId: newId("rsk"),
    keys: { paymentId: input.paymentId },
    payload: { source: "razorpay", event: input.cleared ? SIM_EVENTS.riskCleared : SIM_EVENTS.riskDeclined, simulated: true },
  });
}

// Razorpay makes the change the merchant asked for (limit, currency, network,
// billing details, cards from abroad).
export async function approveAccountChange(
  engine: Engine,
  a: Adapters,
  input: { merchantId: string; limitInr?: number; addCurrency?: string; addNetwork?: string; billingAddressRequired?: boolean; internationalOn?: boolean },
) {
  const sim = createInternationalSim(a.db, a.clock);
  const st = sim.settings(input.merchantId);
  if (!st) throw new Error(`${input.merchantId} has no international settings`);
  sim.updateSettings(input.merchantId, {
    ...(input.limitInr !== undefined ? { limit_inr: input.limitInr } : {}),
    ...(input.addCurrency ? { currencies: [...new Set([...st.currencies, input.addCurrency])] } : {}),
    ...(input.addNetwork ? { networks: [...new Set([...st.networks, input.addNetwork])] } : {}),
    ...(input.billingAddressRequired !== undefined ? { billing_address_required: input.billingAddressRequired } : {}),
    ...(input.internationalOn !== undefined ? { international_on: input.internationalOn } : {}),
  });
  return engine.handleEvent({
    kind: "webhook",
    merchantId: input.merchantId,
    at: a.clock.now(),
    sourceId: newId("acct"),
    payload: { source: "razorpay", event: SIM_EVENTS.accountUpdated, simulated: true },
  });
}

export const SITUATION_OF = (cause: Cause) => CAUSES[cause].situation;

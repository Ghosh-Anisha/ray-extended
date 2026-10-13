// The simulator page for this moment (Simulated): what it shows, and the
// one entry point its buttons call. Every action reaches the engine the way
// a real event does (webhook sim or handleEvent).
import { and, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Adapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Engine } from "@/engine/engine";
import { formatMoney } from "@/guards/format";
import { dateTime } from "@/surfaces/format";
import {
  abandonedCheckoutSweep,
  approveAccountChange,
  CARD_OUTCOMES,
  expireLink,
  landTransfer,
  openCheckout,
  payByCard,
  payLink,
  payWithPaypal,
  riskReview,
} from "./checkout";
import { createInternationalSim } from "./sim";

export const SIM_MERCHANTS = ["m_notenest", "m_pixelforge"] as const;

// What each card outcome is called on the checkout page.
export const OUTCOME_LABEL: Record<(typeof CARD_OUTCOMES)[number], string> = {
  success: "Card goes through",
  card_not_international: "Card not on for payments abroad",
  card_not_online: "Card not on for online payments",
  three_ds_failed: "Security check fails",
  three_ds_timed_out: "Security check times out",
  bank_declined: "Bank declines",
  bank_declined_fraud: "Bank declines as possible fraud",
  billing_missing: "Bank needs the billing address",
  risk_hold: "Razorpay's risk check holds it",
};

const money = z.number().int().positive();
export const simAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open_checkout"),
    merchantId: z.enum(SIM_MERCHANTS),
    amount: money,
    currency: z.enum(["USD", "GBP", "EUR"]),
    receipt: z.string().min(1).max(40),
    buyer: z.object({ name: z.string().min(1), email: z.string().email(), country: z.string().length(2), language: z.string().optional(), phone: z.string().optional() }),
  }),
  z.object({ action: z.literal("pay_card"), merchantId: z.string(), orderId: z.string(), outcome: z.enum(CARD_OUTCOMES), network: z.string().optional() }),
  z.object({ action: z.literal("pay_paypal"), merchantId: z.string(), orderId: z.string() }),
  z.object({ action: z.literal("pay_link"), merchantId: z.string(), linkId: z.string(), method: z.enum(["card", "paypal"]) }),
  z.object({ action: z.literal("expire_link"), merchantId: z.string(), linkId: z.string() }),
  z.object({ action: z.literal("sweep"), merchantId: z.string() }),
  z.object({
    action: z.literal("land_transfer"),
    merchantId: z.string(),
    currency: z.string().length(3),
    amount: money,
    remitterName: z.string().min(1),
    remitterReference: z.string().min(1),
    invoiceRef: z.string().nullish(),
  }),
  z.object({ action: z.literal("risk_review"), merchantId: z.string(), paymentId: z.string(), cleared: z.boolean() }),
  z.object({ action: z.literal("account_change"), merchantId: z.string(), limitInr: z.number().int().positive().optional(), addCurrency: z.string().length(3).optional() }),
]);
export type SimAction = z.input<typeof simAction>;

export async function runSimAction(engine: Engine, a: Adapters, raw: unknown) {
  const x = simAction.parse(raw);
  switch (x.action) {
    case "open_checkout":
      return openCheckout(a, x);
    case "pay_card":
      return payByCard(a, x);
    case "pay_paypal":
      return payWithPaypal(a, x);
    case "pay_link":
      return payLink(a, x);
    case "expire_link":
      return (await expireLink(a, x)).deliveryRow;
    case "sweep":
      return abandonedCheckoutSweep(engine, a, x.merchantId);
    case "land_transfer":
      return (await landTransfer(engine, a, x)).transfer;
    case "risk_review":
      return riskReview(engine, a, x);
    case "account_change":
      return approveAccountChange(engine, a, x);
  }
}

export type IntlSimView = {
  merchants: {
    id: string;
    name: string;
    settings: { limit: string; currencies: string; paypal: boolean; checkout: string; moneysaver: boolean; non3ds: boolean } | null;
    orders: { id: string; receipt: string; amount: string; status: string; buyer: string; at: string; paypal: boolean }[];
    links: { id: string; amount: string; buyer: string; status: string; url: string }[];
    held: { paymentId: string; amount: string; buyer: string }[];
    transfers: { id: string; amount: string; from: string; reference: string; settlement: "held" | "released"; at: string }[];
    tickets: { id: string; text: string }[];
  }[];
  outcomes: { value: string; label: string }[];
};

export function internationalSimView(a: Adapters): IntlSimView {
  const repo = createRepository(a.db);
  const sim = createInternationalSim(a.db, a.clock);
  return {
    outcomes: CARD_OUTCOMES.map((value) => ({ value, label: OUTCOME_LABEL[value] })),
    merchants: SIM_MERCHANTS.map((id) => {
      const m = repo.merchants.get(id)!;
      const st = sim.settings(id);
      const nameOf = (email: string | null) => repo.customers.list(eq(s.customers.merchant_id, id)).find((c) => c.email === email)?.name ?? email ?? "A buyer";
      const orders = a.db
        .select()
        .from(s.rzpOrders)
        .where(and(eq(s.rzpOrders.merchant_id, id), ne(s.rzpOrders.currency, "INR")))
        .orderBy(desc(s.rzpOrders.created_at))
        .limit(12)
        .all();
      return {
        id,
        name: m.name,
        settings: st
          ? { limit: formatMoney(st.limit_inr), currencies: st.currencies.join(", "), paypal: st.paypal_on, checkout: st.checkout === "standard" ? "Standard Checkout" : "Custom checkout", moneysaver: st.moneysaver_on, non3ds: st.non_3ds }
          : null,
        orders: orders.map((o) => ({
          id: o.id,
          receipt: o.receipt ?? o.id,
          amount: formatMoney(o.amount, o.currency),
          status: o.status === "paid" ? "Paid" : o.status === "attempted" ? "Tried, not paid" : "Open",
          buyer: nameOf(o.email),
          at: dateTime(o.created_at),
          paypal: sim.paypalAvailable(id, o.currency),
        })),
        links: repo.rzpLinks
          .list(eq(s.rzpLinks.merchant_id, id))
          .filter((l) => l.currency !== "INR")
          .map((l) => ({ id: l.id, amount: formatMoney(l.amount, l.currency), buyer: nameOf(l.email), status: l.status, url: l.short_url ?? "" })),
        held: repo.rzpPayments
          .list(eq(s.rzpPayments.merchant_id, id))
          .filter((p) => sim.signals(p.id)?.risk_hold === "held")
          .map((p) => ({ paymentId: p.id, amount: formatMoney(p.amount, p.currency), buyer: nameOf(p.email) })),
        transfers: sim.transfers(id).map((t) => ({
          id: t.id,
          amount: `${formatMoney(t.amount, t.currency)} (${formatMoney(t.base_amount)})`,
          from: t.remitter_name,
          reference: t.remitter_reference,
          settlement: sim.settlement(t.id),
          at: dateTime(t.received_at),
        })),
        tickets: sim.riskTickets(id).map((x) => ({ id: x.id, text: String(x.args.text) })),
      };
    }),
  };
}

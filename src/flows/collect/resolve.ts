// Which buyer an event is about, in code: a morning check names one, a
// handoff from Subscriptions (Step 9) names an invoice, a bank credit names
// a payer in its remark, a message comes from a buyer's address.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import * as s from "@/db/schema";
import type { EngineEvent } from "@/engine/events";
import { normalizeEmail, normalizePhone } from "@/engine/events";
import { DAY, type Buyer, type Invoice } from "./stages";
import type { Ctx } from "./data";

export const COLLECT_SOURCE = "collect";
export const MORNING_KIND = "collect_morning";
export const COLLECT_HANDOFF = "collect.handoff";
export const BANKING_SOURCE = "banking_plus";
export const BANK_CREDIT_EVENT = "bank_credit.received";

// The handoff contract for Step 9 (unpaid B2B renewals). Either an existing
// invoice, or the subscription invoice to raise one from.
export const handoffPayload = z.object({
  event: z.literal(COLLECT_HANDOFF),
  invoice_id: z.string().optional(),
  subscription_id: z.string().optional(),
  sub_invoice_id: z.string().optional(),
  customer_id: z.string().optional(),
  amount: z.number().int().positive().optional(),
  due_date: z.number().int().optional(),
});
export type HandoffPayload = z.infer<typeof handoffPayload>;

export type EventKind = "morning" | "handoff" | "credit" | "check" | "buyer_message" | "merchant_note" | "other";

export function kindOf(e: EngineEvent | null, checkTimer: string): EventKind | null {
  if (!e) return null;
  const p = e.payload;
  if (e.kind === "timer") return p.timer_kind === checkTimer ? "check" : "other";
  if (p.event === COLLECT_HANDOFF) return "handoff";
  if (p.source === COLLECT_SOURCE && p.kind === MORNING_KIND) return "morning";
  if (p.source === BANKING_SOURCE && p.event === BANK_CREDIT_EVENT) return "credit";
  if (e.kind === "message_in") return p.from_merchant === true ? "merchant_note" : "buyer_message";
  return "other";
}

export const fullLoop = (ctx: Ctx, merchantId: string) => !!ctx.repo.merchants.get(merchantId)?.banking_plus;

export function buyerAtAddress(ctx: Ctx, merchantId: string, e: EngineEvent): Buyer | undefined {
  const email = normalizeEmail(String(e.payload.from ?? "")) ?? e.keys.email;
  const phone = normalizePhone(String(e.payload.from ?? "")) ?? e.keys.phone;
  return ctx.repo.buyers
    .list(eq(s.buyers.merchant_id, merchantId))
    .find((b) => (!!email && normalizeEmail(b.email) === email) || (!!phone && normalizePhone(b.phone) === phone));
}

// The handoff's invoice: the one named, or one raised from the subscription
// invoice (once; the same handoff again finds it). The buyer is found by the
// subscriber's email or phone, or added with no consent rows, so nothing
// is sent to them until the merchant adds consent.
export function resolveHandoff(ctx: Ctx, e: EngineEvent): { invoice: Invoice; buyer: Buyer } | null {
  const parsed = handoffPayload.safeParse(e.payload);
  if (!parsed.success) return null;
  const h = parsed.data;
  if (h.invoice_id) {
    const invoice = ctx.repo.invoices.get(h.invoice_id);
    if (!invoice || invoice.merchant_id !== e.merchantId) return null;
    return { invoice, buyer: ctx.repo.buyers.get(invoice.buyer_id)! };
  }
  if (!h.sub_invoice_id) return null;
  const id = `inv_sub_${h.sub_invoice_id}`;
  const existing = ctx.repo.invoices.get(id);
  if (existing) return { invoice: existing, buyer: ctx.repo.buyers.get(existing.buyer_id)! };
  const subInv = ctx.repo.subInvoices.get(h.sub_invoice_id);
  const sub = ctx.repo.subscriptions.get(h.subscription_id ?? subInv?.subscription_id ?? "");
  if (!sub || sub.merchant_id !== e.merchantId) return null;
  const customer = ctx.repo.customers.get(h.customer_id ?? sub.customer_id);
  if (!customer) return null;
  const buyer =
    ctx.repo.buyers
      .list(eq(s.buyers.merchant_id, e.merchantId))
      .find((b) => (customer.email && normalizeEmail(b.email) === normalizeEmail(customer.email)) || (customer.phone && normalizePhone(b.phone) === normalizePhone(customer.phone))) ??
    ctx.repo.buyers.insert({
      id: `buy_sub_${customer.id}`,
      merchant_id: e.merchantId,
      name: customer.name,
      contact_name: customer.name,
      email: customer.email,
      phone: customer.phone,
      avg_days_late: 0,
      pay_history: "New: raised from an unpaid subscription renewal.",
      usual_tds_rate: 0,
      key_account: false,
    });
  const issued = subInv?.billing_start ?? e.at;
  const invoice = ctx.repo.invoices.insert({
    id,
    merchant_id: e.merchantId,
    buyer_id: buyer.id,
    number: `SUB/${subInv?.id ?? h.sub_invoice_id}`,
    amount: h.amount ?? subInv?.amount ?? sub.amount,
    issued_at: issued,
    due_date: h.due_date ?? issued,
    accepted_at: issued,
    status: "open",
    paid_amount: 0,
    key_account: buyer.key_account,
    disputed_part: null,
  });
  return { invoice, buyer };
}

// The payer a bank remark names, in code: the buyer's business name, or an
// invoice number of theirs.
export function buyerFromRemark(ctx: Ctx, merchantId: string, remark: string): Buyer | undefined {
  const r = remark.toUpperCase().replace(/[^A-Z0-9 ]/g, " ");
  const buyers = ctx.repo.buyers.list(eq(s.buyers.merchant_id, merchantId));
  const STOP = new Set(["PVT", "LTD", "CO", "AND", "THE", "PRIVATE", "LIMITED", "FOODS", "TRADERS", "PACKAGING", "EXPORTS", "DAIRY", "SNACKS", "AGRO"]);
  const byName = buyers.filter((b) => {
    const words = b.name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
    return words.length > 0 && words.every((w) => new RegExp(`\\b${w}\\b`).test(r));
  });
  if (byName.length === 1) return byName[0];
  const named = ctx.db
    .select()
    .from(s.invoices)
    .where(eq(s.invoices.merchant_id, merchantId))
    .all()
    .filter((i) => {
      const tail = i.number.match(/(\d{3,})$/)?.[1];
      return tail && new RegExp(`\\b${tail}\\b`).test(r) && r.includes("INV");
    });
  const ids = new Set(named.map((i) => i.buyer_id));
  return ids.size === 1 ? buyers.find((b) => b.id === [...ids][0]) : undefined;
}

export function buyerByName(ctx: Ctx, merchantId: string, name: string): Buyer | undefined {
  const n = name.toLowerCase().trim();
  if (n.length < 3) return undefined;
  const hits = ctx.repo.buyers.list(eq(s.buyers.merchant_id, merchantId)).filter((b) => b.name.toLowerCase().includes(n) || n.includes(b.name.toLowerCase()));
  return hits.length === 1 ? hits[0] : undefined;
}

// A buyer said they paid with this UTR, or a pay link's payment carries it.
export function creditByUtrOrAmount(ctx: Ctx, merchantId: string, opts: { utr?: string | null; amount?: number | null; near: number }) {
  const credits = ctx.db.select().from(s.bankCredits).where(and(eq(s.bankCredits.merchant_id, merchantId))).all().filter((c) => c.matched_invoices.length === 0);
  if (opts.utr) {
    const hit = credits.find((c) => c.utr.toUpperCase() === opts.utr!.toUpperCase());
    if (hit) return hit;
  }
  if (opts.amount) return credits.find((c) => c.amount === opts.amount && Math.abs(c.date - opts.near) <= 3 * DAY);
  return undefined;
}

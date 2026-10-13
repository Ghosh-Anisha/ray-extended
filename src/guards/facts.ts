// The case data an outgoing message may quote (rule 6), built by code and
// display-ready: ₹1,299, 7:52 PM, 6 Oct, UTR ending 4821, #1234, 12 in
// stock. It holds the case, its merchant, the records the case cites and the
// records those lead to, and the case's timers. What customers wrote is left
// out on purpose: a number a customer typed is not case data.
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { formatDate, formatMoney, formatTime, last4 } from "./format";

const MONEY = new Set(["amount", "base_amount", "total", "price", "paid_amount", "disputed_part", "lifetime_value", "amount_refunded", "max_amount", "approval_limit"]);
const TIME = new Set([
  "created_at", "captured_at", "at", "due_at", "promised_by", "respond_by", "due_date", "issued_at", "accepted_at", "date",
  "billing_start", "billing_end", "promised_date", "made_at", "opened_at", "start", "end", "reported_at", "delivered_at", "expires_at",
  // Subscriptions (Step 9): mandate approval and pre-debit notice.
  "authorised_at", "notified_at",
]);
// Fields that are internal and never quoted, so their numbers don't count.
const SKIP = new Set(["id", "seq", "merchant_id", "customer_id", "case_id", "token_id"]);

type Row = Record<string, unknown>;

function display(row: Row, currency: string): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (SKIP.has(k) || v === null || v === undefined) continue;
    if (typeof v === "number" && MONEY.has(k)) out[k] = formatMoney(v, (row.currency as string) ?? currency);
    else if (typeof v === "number" && TIME.has(k)) out[k] = `${formatTime(v)} on ${formatDate(v)}`;
    else if (k === "utr" && typeof v === "string") out[k] = `${v} (ending ${last4(v)})`;
    else if (typeof v !== "object") out[k] = v;
  }
  return out;
}

export function caseFacts(db: Db, caseId: string): Row {
  const repo = createRepository(db);
  const kase = repo.cases.get(caseId);
  if (!kase) throw new Error(`Case ${caseId} not found`);
  const merchant = repo.merchants.get(kase.merchant_id)!;
  const records: Row[] = [];
  const seen = new Set<string>();
  const mine = <T extends { merchant_id?: string | null }>(r: T | undefined) =>
    r && (r.merchant_id === undefined || r.merchant_id === null || r.merchant_id === kase.merchant_id) ? r : undefined;
  const add = (r: Row | undefined, currency = "INR") => {
    if (!r) return false;
    const key = String(r.id ?? r.event_id ?? JSON.stringify(r));
    if (seen.has(key)) return false;
    seen.add(key);
    records.push(display(r, currency));
    return true;
  };

  // Follows one id to its record and the records it leads to.
  const follow = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    const payment = mine(repo.rzpPayments.get(id));
    if (payment && add(payment, payment.currency)) {
      follow(payment.order_id);
      for (const r of db.select().from(s.rzpRefunds).where(eq(s.rzpRefunds.payment_id, id)).all()) add(r, r.currency);
      for (const d of db.select().from(s.disputes).where(eq(s.disputes.payment_id, id)).all()) add(d, payment.currency);
      const so = db.select().from(s.storeOrders).where(and(eq(s.storeOrders.merchant_id, kase.merchant_id), eq(s.storeOrders.payment_id, id))).get();
      if (so) follow(so.id);
      return;
    }
    const order = mine(repo.storeOrders.get(id));
    if (order && add(order)) {
      for (const it of order.items) {
        const p = db.select().from(s.products).where(and(eq(s.products.merchant_id, order.merchant_id), eq(s.products.name, it.name))).get();
        records.push(display({ name: it.name, qty: it.qty, price: it.price, stock: p?.stock ?? it.stock }, "INR"));
      }
      if (order.customer_id) add(repo.customers.get(order.customer_id));
      return;
    }
    const dispute = mine(repo.disputes.get(id));
    if (dispute && add(dispute)) return follow(dispute.payment_id);
    const sub = mine(repo.subscriptions.get(id));
    if (sub && add(sub)) {
      add(repo.customers.get(sub.customer_id));
      for (const i of db.select().from(s.subInvoices).where(eq(s.subInvoices.subscription_id, id)).all()) add(i);
      for (const m of db.select().from(s.mandates).where(eq(s.mandates.subscription_id, id)).all()) add(m);
      return;
    }
    const subInvoice = repo.subInvoices.get(id);
    if (subInvoice && mine(repo.subscriptions.get(subInvoice.subscription_id))) return follow(subInvoice.subscription_id);
    const invoice = mine(repo.invoices.get(id));
    if (invoice && add(invoice)) {
      add(repo.buyers.get(invoice.buyer_id));
      for (const p of db.select().from(s.promises).where(eq(s.promises.invoice_id, id)).all()) add(p);
      return;
    }
    const credit = mine(repo.bankCredits.get(id));
    if (credit && add(credit)) return credit.matched_invoices.forEach(follow);
    for (const r of [repo.rzpOrders.get(id), repo.rzpRefunds.get(id), repo.rzpLinks.get(id)]) {
      if (mine(r)) return void add(r!, r!.currency);
    }
    add(mine(repo.customers.get(id)));
    add(mine(repo.buyers.get(id)));
  };

  follow(kase.payment_id);
  follow(kase.store_order_id);
  for (const e of repo.caseEvents.listByCase(caseId)) follow(e.evidence_ref);
  // Links and invoices RAY created or fetched for this case.
  for (const a of db.select().from(s.actions).where(and(eq(s.actions.case_id, caseId), eq(s.actions.status, "done"))).all()) {
    if (a.result) records.push(display(a.result, "INR"));
  }
  const timers = db.select().from(s.timers).where(eq(s.timers.case_id, caseId)).all();

  return {
    case: display(kase, "INR"),
    merchant: {
      name: merchant.name,
      // Step 9: the discount save offer a subscriber may be told about.
      ...(kase.moment === "subscription" && merchant.sub_discount_percent ? { subscription_offer: `${merchant.sub_discount_percent}% off` } : {}),
    },
    records,
    timers: timers.map((t) => ({ kind: t.kind, due: `${formatTime(t.due_at)} on ${formatDate(t.due_at)}` })),
  };
}

// Simulated Razorpay, scoped to one merchant's account and backed by the
// rzp_* mirror tables plus disputes and subscriptions. Behaves like the REST
// API for every call in the adapter interface.
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Clock } from "../clock";
import { newId } from "../ids";
import { decideRefund } from "./refund-policy";
import {
  contestInput,
  createOrderInput,
  paymentLinkInput,
  RazorpayError,
  refundInput,
  type ContestInput,
  type CreateOrderInput,
  type Dispute,
  type DisputeEvidence,
  type Invoice,
  type Order,
  type Payment,
  type PaymentLink,
  type PaymentLinkInput,
  type RazorpayAdapter,
  type Refund,
  type RefundInput,
  type Subscription,
} from "./types";

type PaymentRow = typeof s.rzpPayments.$inferSelect;
type RefundRow = typeof s.rzpRefunds.$inferSelect;

export const SIM_LINK_BASE = "https://pay.sim.example";

const notFound = (what: string, id: string) => new RazorpayError("NOT_FOUND", `${what} ${id} does not exist`, 404);

const toRefund = (r: RefundRow): Refund => ({
  id: r.id,
  payment_id: r.payment_id,
  status: r.status,
  amount: r.amount,
  currency: r.currency,
  receipt: r.receipt,
  created_at: r.created_at,
});

const toOrder = (o: typeof s.rzpOrders.$inferSelect): Order => ({
  id: o.id,
  status: o.status,
  amount: o.amount,
  currency: o.currency,
  receipt: o.receipt,
  created_at: o.created_at,
});

const toLink = (l: typeof s.rzpLinks.$inferSelect): PaymentLink => ({
  id: l.id,
  status: l.status,
  amount: l.amount,
  currency: l.currency,
  short_url: l.short_url,
  reference_id: l.receipt,
  payment_id: l.payment_id,
  created_at: l.created_at,
});

export type MockRazorpay = RazorpayAdapter & {
  readonly merchantId: string;
  // Simulation hooks, not part of the adapter interface.
  simulatePayment(input: SimulatedPayment): Payment;
};

export type SimulatedPayment = {
  order_id?: string;
  amount: number;
  currency?: string;
  status: "authorized" | "captured" | "failed";
  method?: string;
  contact?: string;
  email?: string;
  vpa?: string;
  utr?: string;
  error_reason?: string;
};


export function createMockRazorpay(db: Db, clock: Clock, merchantId: string): MockRazorpay {
  const repo = createRepository(db);

  const paymentRow = (id: string) => {
    const row = repo.rzpPayments.get(id);
    if (!row || row.merchant_id !== merchantId) throw notFound("Payment", id);
    return row;
  };
  const refundRows = (paymentId: string) =>
    db.select().from(s.rzpRefunds).where(eq(s.rzpRefunds.payment_id, paymentId)).all();

  const toPayment = (p: PaymentRow): Payment => {
    const refunded = refundRows(p.id)
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amount, 0);
    return {
      id: p.id,
      order_id: p.order_id,
      status: p.status as Payment["status"],
      amount: p.amount,
      currency: p.currency,
      base_amount: p.base_amount,
      amount_refunded: refunded,
      method: p.method,
      contact: p.contact,
      email: p.email,
      vpa: p.vpa,
      card_last4: p.card_last4,
      card_country: p.card_country,
      utr: p.utr,
      error_code: p.error_code,
      error_source: p.error_source,
      error_reason: p.error_reason,
      created_at: p.created_at,
      captured_at: p.captured_at,
    };
  };

  const orderRow = (id: string) => {
    const row = repo.rzpOrders.get(id);
    if (!row || row.merchant_id !== merchantId) throw notFound("Order", id);
    return row;
  };

  const disputeRow = (id: string) => {
    const row = repo.disputes.get(id);
    if (!row || row.merchant_id !== merchantId) throw notFound("Dispute", id);
    return row;
  };
  const toDispute = (d: typeof s.disputes.$inferSelect): Dispute => ({
    id: d.id,
    payment_id: d.payment_id,
    status: d.status,
    phase: d.phase,
    amount: d.amount,
    currency: repo.rzpPayments.get(d.payment_id)?.currency ?? "INR",
    reason_code: d.reason_code,
    reason: d.reason,
    network: d.network,
    deducted: d.deducted,
    respond_by: d.respond_by,
    created_at: d.created_at,
    evidence: (d.draft_json as DisputeEvidence | null) ?? null,
  });

  const subRow = (id: string) => {
    const row = repo.subscriptions.get(id);
    if (!row || row.merchant_id !== merchantId) throw notFound("Subscription", id);
    return row;
  };
  const toSub = (r: typeof s.subscriptions.$inferSelect): Subscription => ({
    id: r.id,
    status: r.status,
    plan: r.plan,
    amount: r.amount,
    customer_id: r.customer_id,
    pending_invoice_id: r.pending_invoice_id,
    retries_left: r.retries_left,
  });
  const setSubStatus = (id: string, from: string[], to: (typeof s.SUBSCRIPTION_STATUSES)[number]) => {
    const row = subRow(id);
    if (!from.includes(row.status)) {
      throw new RazorpayError("INVALID_STATE", `Subscription ${id} is ${row.status}, cannot move to ${to}`);
    }
    const patch: Partial<typeof s.subscriptions.$inferInsert> = { status: to };
    if (to === "active") patch.resume_at = null;
    return toSub(repo.subscriptions.update(id, patch)!);
  };

  return {
    mode: "mock",
    merchantId,

    async createOrder(input: CreateOrderInput) {
      const o = createOrderInput.parse(input);
      const row = repo.rzpOrders.insert({
        id: newId("order"),
        merchant_id: merchantId,
        status: "created",
        amount: o.amount,
        currency: o.currency,
        receipt: o.receipt,
        created_at: clock.now(),
      });
      return toOrder(row);
    },

    async fetchOrder(orderId) {
      return toOrder(orderRow(orderId));
    },

    async fetchOrderByReceipt(receipt) {
      const row = db
        .select()
        .from(s.rzpOrders)
        .where(and(eq(s.rzpOrders.merchant_id, merchantId), eq(s.rzpOrders.receipt, receipt)))
        .orderBy(desc(s.rzpOrders.created_at))
        .get();
      return row ? toOrder(row) : null;
    },

    async fetchPayment(paymentId) {
      return toPayment(paymentRow(paymentId));
    },

    async listOrderPayments(orderId) {
      orderRow(orderId);
      return db
        .select()
        .from(s.rzpPayments)
        .where(eq(s.rzpPayments.order_id, orderId))
        .orderBy(s.rzpPayments.created_at)
        .all()
        .map(toPayment);
    },

    async capturePayment(paymentId, amount, currency) {
      const p = paymentRow(paymentId);
      if (p.status !== "authorized") {
        throw new RazorpayError("INVALID_STATE", `Payment ${paymentId} is ${p.status}, only authorized payments can be captured`, 400);
      }
      if (amount !== p.amount || currency !== p.currency) {
        throw new RazorpayError("BAD_REQUEST", "Capture amount must equal the authorized amount", 400);
      }
      const now = clock.now();
      repo.rzpPayments.update(paymentId, { status: "captured", captured_at: now });
      if (p.order_id) repo.rzpOrders.update(p.order_id, { status: "paid" });
      return toPayment(paymentRow(paymentId));
    },

    async listRefunds(paymentId) {
      paymentRow(paymentId);
      return refundRows(paymentId).map(toRefund);
    },

    async refund(paymentId, input: RefundInput) {
      const req = refundInput.parse(input);
      const p = paymentRow(paymentId);
      const decision = decideRefund(toPayment(p), refundRows(paymentId).map(toRefund), req);
      if (decision.kind === "existing") return decision.refund;
      const row = repo.rzpRefunds.insert({
        id: newId("rfnd"),
        merchant_id: merchantId,
        payment_id: paymentId,
        status: "processed",
        amount: req.amount,
        currency: p.currency,
        receipt: req.receipt,
        created_at: clock.now(),
      });
      if (req.amount === p.amount) repo.rzpPayments.update(paymentId, { status: "refunded" });
      return toRefund(row);
    },

    async createPaymentLink(input: PaymentLinkInput) {
      const l = paymentLinkInput.parse(input);
      const id = newId("plink");
      const row = repo.rzpLinks.insert({
        id,
        merchant_id: merchantId,
        status: "created",
        amount: l.amount,
        currency: l.currency,
        receipt: l.reference_id ?? null,
        contact: l.customer?.contact ?? null,
        email: l.customer?.email ?? null,
        short_url: `${SIM_LINK_BASE}/l/${id.slice(6)}`,
        created_at: clock.now(),
      });
      return toLink(row);
    },

    async fetchPaymentLink(linkId) {
      const row = repo.rzpLinks.get(linkId);
      if (!row || row.merchant_id !== merchantId) throw notFound("Payment link", linkId);
      return toLink(row);
    },

    async fetchDispute(disputeId) {
      return toDispute(disputeRow(disputeId));
    },

    async listDisputes(filter) {
      const where = filter?.paymentId
        ? and(eq(s.disputes.merchant_id, merchantId), eq(s.disputes.payment_id, filter.paymentId))
        : eq(s.disputes.merchant_id, merchantId);
      return db.select().from(s.disputes).where(where).orderBy(s.disputes.created_at).all().map(toDispute);
    },

    async contestDispute(disputeId, input: ContestInput) {
      const c = contestInput.parse(input);
      const d = disputeRow(disputeId);
      if (d.status !== "open") {
        throw new RazorpayError("INVALID_STATE", `Dispute ${disputeId} is ${d.status}, only open disputes can be contested`, 400);
      }
      if (clock.now() > d.respond_by) {
        throw new RazorpayError("DEADLINE_PASSED", `The deadline to respond to dispute ${disputeId} has passed`, 400);
      }
      if (c.amount !== undefined && c.amount > d.amount) {
        throw new RazorpayError("BAD_REQUEST", "Contest amount is more than the disputed amount", 400);
      }
      const prev = d.draft_json as DisputeEvidence | null;
      const merged: DisputeEvidence = {
        amount: c.amount ?? prev?.amount ?? null,
        summary: c.summary ?? prev?.summary ?? null,
        documents: { ...prev?.documents, ...c.documents },
        submitted_at: null,
      };
      if (c.action === "submit") {
        const hasDocs = Object.values(merged.documents).some((ids) => ids && ids.length > 0);
        if (merged.amount === null || !merged.summary || !hasDocs) {
          throw new RazorpayError("BAD_REQUEST", "Submit needs an amount, a summary and at least one document", 400);
        }
        merged.submitted_at = clock.now();
      }
      const submitted = c.action === "submit";
      repo.disputes.update(disputeId, {
        draft_json: merged,
        draft_status: submitted ? "submitted" : "draft",
        ...(submitted ? { status: "under_review" } : {}),
      });
      return toDispute(disputeRow(disputeId));
    },

    async acceptDispute(disputeId) {
      const d = disputeRow(disputeId);
      if (d.status !== "open") {
        throw new RazorpayError("INVALID_STATE", `Dispute ${disputeId} is ${d.status}, only open disputes can be accepted`, 400);
      }
      return toDispute(repo.disputes.update(disputeId, { status: "lost" })!);
    },

    async fetchSubscription(subscriptionId) {
      return toSub(subRow(subscriptionId));
    },

    async pauseSubscription(subscriptionId) {
      return setSubStatus(subscriptionId, ["active"], "paused");
    },

    async resumeSubscription(subscriptionId) {
      return setSubStatus(subscriptionId, ["paused"], "active");
    },

    async cancelSubscription(subscriptionId) {
      return setSubStatus(subscriptionId, ["created", "authenticated", "active", "pending", "halted", "paused"], "cancelled");
    },

    async fetchPendingInvoice(subscriptionId) {
      const sub = subRow(subscriptionId);
      if (!sub.pending_invoice_id) return null;
      const inv = repo.subInvoices.get(sub.pending_invoice_id);
      if (!inv) return null;
      const out: Invoice = {
        id: inv.id,
        subscription_id: inv.subscription_id,
        status: inv.status,
        amount: inv.amount,
        payment_id: inv.payment_id,
        short_url: `${SIM_LINK_BASE}/i/${inv.id}`,
        billing_start: inv.billing_start,
        billing_end: inv.billing_end,
      };
      return out;
    },

    simulatePayment(input) {
      if (input.order_id) orderRow(input.order_id);
      const now = clock.now();
      const row = repo.rzpPayments.insert({
        id: newId("pay"),
        merchant_id: merchantId,
        order_id: input.order_id ?? null,
        status: input.status,
        amount: input.amount,
        currency: input.currency ?? "INR",
        method: input.method ?? "upi",
        contact: input.contact ?? null,
        email: input.email ?? null,
        vpa: input.vpa ?? null,
        utr: input.utr ?? null,
        error_reason: input.error_reason ?? null,
        created_at: now,
        captured_at: input.status === "captured" ? now : null,
      });
      if (input.order_id && input.status !== "failed") {
        repo.rzpOrders.update(input.order_id, { status: input.status === "captured" ? "paid" : "attempted" });
      }
      return toPayment(row);
    },
  };
}


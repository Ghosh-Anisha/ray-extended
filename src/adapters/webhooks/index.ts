// Simulated Razorpay webhook delivery. emit() builds a Razorpay-shaped event
// from the mirror tables, delivers it to the merchant's site (the store sim
// when they have one), writes a webhook_deliveries row and tells listeners
// (the engine's intake, from Step 3).
//
// Events that are themselves a state change in Razorpay (subscription,
// token, payment link, downtime) apply it to the simulated records. Payment,
// refund and dispute events only report the record as it is.
import { z } from "zod";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import type { subscriptions, webhookDeliveries } from "@/db/schema";
import type { Clock } from "../clock";
import { newId } from "../ids";
import type { StoreConnector, WebhookReceipt } from "../store";

export const WEBHOOK_EVENTS = [
  "payment.captured",
  "payment.failed",
  "order.paid",
  "refund.created",
  "refund.processed",
  "refund.failed",
  "payment.dispute.created",
  "payment.dispute.action_required",
  // The outcome of a dispute (Step 10). They report the dispute as it is.
  "payment.dispute.won",
  "payment.dispute.lost",
  "payment.dispute.closed",
  "payment.downtime.started",
  "payment.downtime.updated",
  "payment.downtime.resolved",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
  // Step 9: the sign-up finished, and a cycle was paid (by the pending
  // invoice's link or by the bank's retry).
  "subscription.activated",
  "subscription.charged",
  "token.cancelled",
  "payment_link.expired",
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

// Which record each event needs.
export const EVENT_REF: Record<WebhookEventName, keyof EmitRefs> = {
  "payment.captured": "paymentId",
  "payment.failed": "paymentId",
  "order.paid": "paymentId",
  "refund.created": "refundId",
  "refund.processed": "refundId",
  "refund.failed": "refundId",
  "payment.dispute.created": "disputeId",
  "payment.dispute.action_required": "disputeId",
  "payment.dispute.won": "disputeId",
  "payment.dispute.lost": "disputeId",
  "payment.dispute.closed": "disputeId",
  "payment.downtime.started": "downtime",
  "payment.downtime.updated": "downtime",
  "payment.downtime.resolved": "downtime",
  "subscription.pending": "subscriptionId",
  "subscription.halted": "subscriptionId",
  "subscription.cancelled": "subscriptionId",
  "subscription.activated": "subscriptionId",
  "subscription.charged": "subscriptionId",
  "token.cancelled": "tokenId",
  "payment_link.expired": "linkId",
};

const emitRefs = z.object({
  paymentId: z.string().optional(),
  refundId: z.string().optional(),
  disputeId: z.string().optional(),
  subscriptionId: z.string().optional(),
  tokenId: z.string().optional(),
  linkId: z.string().optional(),
  downtime: z.object({ method: z.string(), bank: z.string().optional(), id: z.string().optional() }).optional(),
});
export type EmitRefs = z.infer<typeof emitRefs>;

export const emitInput = emitRefs.extend({
  merchantId: z.string(),
  event: z.enum(WEBHOOK_EVENTS),
});
export type EmitInput = z.input<typeof emitInput>;

export type RazorpayEvent = {
  entity: "event";
  id: string;
  account_id: string;
  event: WebhookEventName;
  contains: string[];
  payload: Record<string, { entity: Record<string, unknown> }>;
  created_at: number;
};

export type Delivery = { event: RazorpayEvent; receipt: WebhookReceipt; deliveryRow: typeof webhookDeliveries.$inferSelect };
export type WebhookListener = (d: Delivery) => void | Promise<void>;

export interface WebhookSim {
  emit(input: EmitInput): Promise<Delivery>;
  subscribe(listener: WebhookListener): () => void;
}

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

export function createWebhookSim(db: Db, clock: Clock, store: StoreConnector): WebhookSim {
  const repo = createRepository(db);
  const listeners = new Set<WebhookListener>();

  const owned = <T extends { merchant_id: string }>(row: T | undefined, what: string, id: string, merchantId: string): T => {
    if (!row || row.merchant_id !== merchantId) throw new WebhookError(`${what} ${id} not found for ${merchantId}`);
    return row;
  };
  const need = (v: string | undefined, event: string, field: string) => {
    if (!v) throw new WebhookError(`${event} needs ${field}`);
    return v;
  };

  // Step 9. The next cycle's invoice, issued after the latest one.
  function issueNextInvoice(sub: typeof subscriptions.$inferSelect) {
    const cycles = repo.subInvoices.list().filter((i) => i.subscription_id === sub.id);
    const last = cycles.sort((x, y) => x.billing_start - y.billing_start).at(-1);
    const start = last ? last.billing_end : clock.now();
    const id = `${sub.id.replace("sub_", "inv_")}_${cycles.length + 1}`;
    repo.subInvoices.insert({
      id, subscription_id: sub.id, amount: sub.amount, status: "issued", attempts: 1, error_reason: null,
      billing_start: start, billing_end: start + (last ? last.billing_end - last.billing_start : 30 * 86_400_000), notified_at: start - 86_400_000,
    });
    repo.subscriptions.update(sub.id, { pending_invoice_id: id });
    return id;
  }

  // Step 9. A cycle is paid: a captured payment from the subscriber for the
  // pending invoice, which is marked paid; the subscription is active again.
  // With nothing pending, the bank charged a cycle that was already paid:
  // a second payment on the latest paid invoice (the duplicate). activated
  // also marks the mandate authorised.
  function chargeSubscription(sub: typeof subscriptions.$inferSelect, activated: boolean) {
    const customer = repo.customers.get(sub.customer_id);
    const now = clock.now();
    const pendingId = sub.pending_invoice_id;
    const invoice = pendingId
      ? repo.subInvoices.get(pendingId)
      : repo.subInvoices
          .list()
          .filter((i) => i.subscription_id === sub.id && i.status === "paid")
          .sort((x, y) => x.billing_start - y.billing_start)
          .at(-1);
    if (activated) {
      for (const md of repo.mandates.list().filter((x) => x.subscription_id === sub.id && x.status !== "active")) {
        repo.mandates.update(md.id, { status: "active", authorised_at: now });
      }
    }
    let paid: { paymentId: string; invoiceId: string } | null = null;
    if (invoice && (pendingId || !activated)) {
      const pay = repo.rzpPayments.insert({
        id: newId("pay"), merchant_id: sub.merchant_id, status: "captured", amount: invoice.amount, method: "upi",
        contact: customer?.phone ?? null, email: customer?.email ?? null, receipt: invoice.id, created_at: now, captured_at: now,
      });
      if (pendingId) repo.subInvoices.update(invoice.id, { status: "paid", payment_id: pay.id, attempts: invoice.attempts + 1 });
      paid = { paymentId: pay.id, invoiceId: invoice.id };
    }
    repo.subscriptions.update(sub.id, { status: "active", pending_invoice_id: null, ...(pendingId ? { retries_left: 3 } : {}) });
    return paid;
  }

  function build(input: z.infer<typeof emitInput>): { payload: RazorpayEvent["payload"]; paymentId: string | null; orderId: string | null } {
    const { merchantId: m, event } = input;
    const now = clock.now();
    const out: RazorpayEvent["payload"] = {};
    let paymentId: string | null = null;
    let orderId: string | null = null;
    const addPayment = (id: string) => {
      const p = owned(repo.rzpPayments.get(id), "Payment", id, m);
      out.payment = { entity: { ...p, entity: "payment" } };
      paymentId = p.id;
      orderId = p.order_id;
      return p;
    };

    switch (EVENT_REF[event]) {
      case "paymentId": {
        const p = addPayment(need(input.paymentId, event, "paymentId"));
        if (event === "order.paid") {
          if (!p.order_id) throw new WebhookError(`Payment ${p.id} has no order`);
          out.order = { entity: { ...repo.rzpOrders.get(p.order_id), entity: "order" } };
        }
        break;
      }
      case "refundId": {
        const id = need(input.refundId, event, "refundId");
        const r = owned(repo.rzpRefunds.get(id), "Refund", id, m);
        out.refund = { entity: { ...r, entity: "refund" } };
        addPayment(r.payment_id);
        break;
      }
      case "disputeId": {
        const id = need(input.disputeId, event, "disputeId");
        const d = owned(repo.disputes.get(id), "Dispute", id, m);
        out.dispute = { entity: { ...d, entity: "dispute" } };
        addPayment(d.payment_id);
        break;
      }
      case "downtime": {
        const dt = input.downtime;
        if (!dt) throw new WebhookError(`${event} needs downtime`);
        let row;
        if (event === "payment.downtime.started") {
          row = repo.downtimes.insert({ id: dt.id ?? newId("down"), method: dt.method, bank: dt.bank ?? null, start: now });
        } else {
          const id = need(dt.id, event, "downtime.id");
          if (!repo.downtimes.get(id)) throw new WebhookError(`Downtime ${id} not found`);
          row = event === "payment.downtime.resolved" ? repo.downtimes.update(id, { end: now })! : repo.downtimes.get(id)!;
        }
        const status = event === "payment.downtime.resolved" ? "resolved" : "started";
        out["payment.downtime"] = {
          entity: { entity: "payment.downtime", id: row.id, method: row.method, instrument: { bank: row.bank }, begin: row.start, end: row.end, status },
        };
        break;
      }
      case "subscriptionId": {
        const id = need(input.subscriptionId, event, "subscriptionId");
        const before = owned(repo.subscriptions.get(id), "Subscription", id, m);
        if (event === "subscription.activated" || event === "subscription.charged") {
          const paid = chargeSubscription(before, event === "subscription.activated");
          out.subscription = { entity: { ...repo.subscriptions.get(id)!, entity: "subscription" } };
          if (paid) {
            addPayment(paid.paymentId);
            out.invoice = { entity: { ...repo.subInvoices.get(paid.invoiceId)!, entity: "invoice" } };
          }
          break;
        }
        const status = event.split(".")[1] as "pending" | "halted" | "cancelled";
        // A new cycle fell due with nothing pending: Razorpay issues its invoice.
        if (status === "pending" && !before.pending_invoice_id) issueNextInvoice(before);
        const sub = repo.subscriptions.update(id, { status, ...(status === "halted" ? { retries_left: 0 } : {}) })!;
        out.subscription = { entity: { ...sub, entity: "subscription" } };
        break;
      }
      case "tokenId": {
        const id = need(input.tokenId, event, "tokenId");
        const mandate = repo.mandates.list().find((x) => x.token_id === id);
        const sub = mandate && repo.subscriptions.get(mandate.subscription_id);
        if (!mandate || !sub || sub.merchant_id !== m) throw new WebhookError(`Token ${id} not found for ${m}`);
        repo.mandates.update(mandate.id, { status: "cancelled" });
        out.token = { entity: { entity: "token", id, method: mandate.method, status: "cancelled", subscription_id: sub.id } };
        break;
      }
      case "linkId": {
        const id = need(input.linkId, event, "linkId");
        owned(repo.rzpLinks.get(id), "Payment link", id, m);
        const link = repo.rzpLinks.update(id, { status: "expired" })!;
        out.payment_link = { entity: { ...link, entity: "payment_link" } };
        break;
      }
    }
    return { payload: out, paymentId, orderId };
  }

  return {
    async emit(raw) {
      const input = emitInput.parse(raw);
      if (!repo.merchants.get(input.merchantId)) throw new WebhookError(`Merchant ${input.merchantId} not found`);
      const { payload, paymentId, orderId } = build(input);
      const now = clock.now();
      const event: RazorpayEvent = {
        entity: "event",
        id: newId("evt"),
        account_id: `acc_${input.merchantId}`,
        event: input.event,
        contains: Object.keys(payload),
        payload,
        created_at: now,
      };

      let receipt: WebhookReceipt;
      let url: string;
      let plugin: string | null = null;
      let pluginVersion: string | null = null;
      if (store.hasStore(input.merchantId)) {
        receipt = await store.receiveWebhook(input.merchantId, { id: event.id, event: event.event, payment_id: paymentId, order_id: orderId });
        // Settings are unreadable while the site is down; fall back to the known URL.
        const settings = await store.getSettings(input.merchantId).catch(() => null);
        url = settings?.webhook_url ?? `https://${input.merchantId}.example.com/?wc-api=razorpay_webhook`;
        plugin = settings?.plugin ?? null;
        pluginVersion = settings?.plugin_version ?? null;
      } else {
        receipt = { http_status: 200, response_body: "OK", processed: true, cron_note: null };
        url = `https://${input.merchantId.replace(/^m_/, "").replace(/_/g, "")}.example.com/razorpay/webhook`;
      }

      const deliveryRow = repo.webhookDeliveries.insert({
        event_id: event.id,
        merchant_id: input.merchantId,
        event: event.event,
        url,
        http_status: receipt.http_status,
        response_body: receipt.response_body,
        delivered_at: now,
        plugin,
        plugin_version: pluginVersion,
        processed: receipt.processed,
        cron_note: receipt.cron_note,
        payment_id: paymentId,
      });
      const delivery = { event, receipt, deliveryRow };
      for (const l of listeners) await l(delivery);
      return delivery;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

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
import type { webhookDeliveries } from "@/db/schema";
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
  "payment.downtime.started",
  "payment.downtime.updated",
  "payment.downtime.resolved",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
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
  "payment.downtime.started": "downtime",
  "payment.downtime.updated": "downtime",
  "payment.downtime.resolved": "downtime",
  "subscription.pending": "subscriptionId",
  "subscription.halted": "subscriptionId",
  "subscription.cancelled": "subscriptionId",
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
        owned(repo.subscriptions.get(id), "Subscription", id, m);
        const status = event.split(".")[1] as "pending" | "halted" | "cancelled";
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

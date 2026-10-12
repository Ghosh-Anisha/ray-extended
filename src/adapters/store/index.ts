// Simulated store connector (WooCommerce-like) over the store_orders table.
// Flows use the StoreConnector interface; the sim also reproduces the plugin
// failures RAY has to find: 200-but-dropped, site down, webhook disabled and
// wrong settings.
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Clock } from "../clock";
import { newId } from "../ids";

export type StoreOrder = typeof s.storeOrders.$inferSelect;

export const STORE_FAILURES = ["none", "dropped_200", "site_down", "webhook_disabled", "settings_wrong"] as const;
export type StoreFailure = (typeof STORE_FAILURES)[number];

export type StoreSettings = {
  platform: "woocommerce";
  site_url: string;
  plugin: string;
  plugin_version: string;
  webhook_url: string;
  webhook_enabled: boolean;
  webhook_secret_matches: boolean;
  payment_action: "authorize_and_capture";
  hold_stock_minutes: number;
};

export type OrderRef = { id: string } | { number: string } | { receipt: string } | { paymentId: string };

export type NewOrderForPayment = {
  paymentId: string;
  customerId?: string | null;
  razorpayOrderId?: string | null;
  receipt?: string | null;
  items: { name: string; qty: number }[];
};

export type WebhookEnvelope = {
  id: string;
  event: string;
  payment_id: string | null;
  order_id: string | null;
};

// What the merchant's site did with a webhook. http_status is null when
// Razorpay never sent it (webhook turned off).
export type WebhookReceipt = {
  http_status: number | null;
  response_body: string | null;
  processed: boolean;
  cron_note: string | null;
};

export interface StoreConnector {
  hasStore(merchantId: string): boolean;
  getSettings(merchantId: string): Promise<StoreSettings>;
  getOrder(merchantId: string, ref: OrderRef): Promise<StoreOrder | null>;
  markPaid(merchantId: string, orderId: string, paymentId: string): Promise<StoreOrder>;
  restoreCancelled(merchantId: string, orderId: string): Promise<StoreOrder>;
  createOrderForPayment(merchantId: string, input: NewOrderForPayment): Promise<StoreOrder>;
  cancelUnshipped(merchantId: string, orderId: string, reason: string): Promise<StoreOrder>;
  receiveWebhook(merchantId: string, envelope: WebhookEnvelope): Promise<WebhookReceipt>;
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export const DROPPED_NOTE = "Queued for cron. Cron marked the job done; order not updated.";
export const AUTO_CANCEL_NOTE = "Unpaid order cancelled - time limit reached.";
const PLUGIN = "razorpay-woocommerce";
const HOLD_STOCK_MINUTES = 60;

// Sim starting state: Leafy Bakes runs plugin 4.8.2 with the 200-but-dropped bug,
// matching the seeded webhook deliveries.
const DEFAULT_FAILURES: Record<string, StoreFailure> = { m_leafy_bakes: "dropped_200" };
const PLUGIN_VERSIONS: Record<string, string> = { m_leafy_bakes: "4.8.2" };

export type StoreSim = StoreConnector & {
  setFailure(merchantId: string, failure: StoreFailure): void;
  failure(merchantId: string): StoreFailure;
  stock(merchantId: string, product: string): number | undefined;
  // Runs the store's own cron: cancels pending orders past the hold-stock time.
  runCron(merchantId: string): StoreOrder[];
};

export function createStoreSim(db: Db, clock: Clock): StoreSim {
  const repo = createRepository(db);
  const failures = new Map<string, StoreFailure>(Object.entries(DEFAULT_FAILURES));
  const catalogs = new Map<string, Map<string, { price: number; stock: number }>>();

  const merchant = (merchantId: string) => {
    const m = repo.merchants.get(merchantId);
    if (!m || m.store_platform !== "woocommerce") throw new StoreError(`${merchantId} has no connected store`, 404);
    return m;
  };
  const failureOf = (merchantId: string) => failures.get(merchantId) ?? "none";
  const siteUp = (merchantId: string) => {
    merchant(merchantId);
    if (failureOf(merchantId) === "site_down") throw new StoreError("Store site is down (503)", 503);
  };
  const slug = (merchantId: string) => merchantId.replace(/^m_/, "").replace(/_/g, "");

  // Product stock, built from the latest snapshot on the merchant's orders.
  const catalog = (merchantId: string) => {
    let c = catalogs.get(merchantId);
    if (!c) {
      c = new Map();
      const orders = db
        .select()
        .from(s.storeOrders)
        .where(eq(s.storeOrders.merchant_id, merchantId))
        .orderBy(s.storeOrders.created_at)
        .all();
      for (const o of orders) for (const it of o.items) c.set(it.name, { price: it.price, stock: it.stock });
      catalogs.set(merchantId, c);
    }
    return c;
  };
  const moveStock = (merchantId: string, items: { name: string; qty: number }[], sign: 1 | -1) => {
    const c = catalog(merchantId);
    for (const it of items) {
      const p = c.get(it.name);
      if (!p) throw new StoreError(`Unknown product: ${it.name}`);
      if (sign < 0 && p.stock < it.qty) throw new StoreError(`Not enough stock for ${it.name} (${p.stock} left)`);
    }
    for (const it of items) c.get(it.name)!.stock += sign * it.qty;
  };
  const snapshotItems = (merchantId: string, items: { name: string; qty: number }[]) =>
    items.map((it) => {
      const p = catalog(merchantId).get(it.name)!;
      return { name: it.name, qty: it.qty, price: p.price, stock: p.stock };
    });

  const orderOf = (merchantId: string, orderId: string) => {
    const o = repo.storeOrders.get(orderId);
    if (!o || o.merchant_id !== merchantId) throw new StoreError(`Order ${orderId} not found`, 404);
    return o;
  };
  const setStatus = (o: StoreOrder, status: StoreOrder["status"], note: string, patch: Partial<StoreOrder> = {}) => {
    const items = patch.items ?? o.items;
    return repo.storeOrders.update(o.id, {
      ...patch,
      status,
      status_history: [...o.status_history, { status, at: clock.now(), note }],
      stock: items.length ? Math.min(...items.map((i) => catalog(o.merchant_id).get(i.name)?.stock ?? i.stock)) : o.stock,
    })!;
  };

  const findOrder = (merchantId: string, ref: OrderRef) => {
    const mine = eq(s.storeOrders.merchant_id, merchantId);
    const where =
      "id" in ref
        ? and(mine, eq(s.storeOrders.id, ref.id))
        : "number" in ref
          ? and(mine, eq(s.storeOrders.number, ref.number.startsWith("#") ? ref.number : `#${ref.number}`))
          : "receipt" in ref
            ? and(mine, eq(s.storeOrders.receipt, ref.receipt))
            : and(mine, eq(s.storeOrders.payment_id, ref.paymentId));
    return db.select().from(s.storeOrders).where(where).orderBy(desc(s.storeOrders.created_at)).get() ?? null;
  };

  const sim: StoreSim = {
    hasStore(merchantId) {
      return repo.merchants.get(merchantId)?.store_platform === "woocommerce";
    },

    async getSettings(merchantId) {
      siteUp(merchantId);
      const f = failureOf(merchantId);
      const site = `https://${slug(merchantId)}.example.com`;
      return {
        platform: "woocommerce",
        site_url: site,
        plugin: PLUGIN,
        plugin_version: PLUGIN_VERSIONS[merchantId] ?? "4.9.1",
        webhook_url: `${site}/?wc-api=razorpay_webhook`,
        webhook_enabled: f !== "webhook_disabled",
        webhook_secret_matches: f !== "settings_wrong",
        payment_action: "authorize_and_capture",
        hold_stock_minutes: HOLD_STOCK_MINUTES,
      };
    },

    async getOrder(merchantId, ref) {
      siteUp(merchantId);
      return findOrder(merchantId, ref);
    },

    async markPaid(merchantId, orderId, paymentId) {
      siteUp(merchantId);
      const o = orderOf(merchantId, orderId);
      if (o.payment_id === paymentId && o.status !== "cancelled") return o;
      if (o.status === "cancelled") throw new StoreError(`Order ${o.number} was cancelled. Restore it first.`);
      if (o.status !== "pending") throw new StoreError(`Order ${o.number} is already ${o.status}`);
      return setStatus(o, "processing", `Payment ${paymentId} recorded by RAY`, { payment_id: paymentId });
    },

    async restoreCancelled(merchantId, orderId) {
      siteUp(merchantId);
      const o = orderOf(merchantId, orderId);
      const last = o.status_history[o.status_history.length - 1];
      if (o.status !== "cancelled" || last?.note !== AUTO_CANCEL_NOTE) {
        throw new StoreError(`Order ${o.number} was not auto-cancelled, so it cannot be restored`);
      }
      moveStock(merchantId, o.items, -1);
      return setStatus(o, "pending", "Restored by RAY after auto-cancel", { items: snapshotItems(merchantId, o.items) });
    },

    async createOrderForPayment(merchantId, input) {
      siteUp(merchantId);
      const existing = findOrder(merchantId, { paymentId: input.paymentId });
      if (existing) return existing;
      if (input.items.length === 0) throw new StoreError("An order needs at least one item");
      moveStock(merchantId, input.items, -1);
      const items = snapshotItems(merchantId, input.items);
      const numbers = db
        .select({ n: s.storeOrders.number })
        .from(s.storeOrders)
        .where(eq(s.storeOrders.merchant_id, merchantId))
        .all()
        .map((r) => Number(r.n.replace("#", "")) || 0);
      const now = clock.now();
      const note = `Created by RAY for payment ${input.paymentId}`;
      return repo.storeOrders.insert({
        id: newId("so"),
        number: `#${Math.max(1000, ...numbers) + 1}`,
        merchant_id: merchantId,
        customer_id: input.customerId ?? null,
        status: "processing",
        status_history: [{ status: "processing", at: now, note }],
        razorpay_order_id: input.razorpayOrderId ?? null,
        receipt: input.receipt ?? null,
        payment_id: input.paymentId,
        total: items.reduce((sum, i) => sum + i.price * i.qty, 0),
        items,
        stock: Math.min(...items.map((i) => i.stock)),
        created_at: now,
      });
    },

    async cancelUnshipped(merchantId, orderId, reason) {
      siteUp(merchantId);
      const o = orderOf(merchantId, orderId);
      if (o.status === "completed") throw new StoreError(`Order ${o.number} has shipped and cannot be cancelled`);
      if (o.status === "cancelled") return o;
      moveStock(merchantId, o.items, 1);
      return setStatus(o, "cancelled", reason, { items: snapshotItems(merchantId, o.items) });
    },

    async receiveWebhook(merchantId, env) {
      merchant(merchantId);
      switch (failureOf(merchantId)) {
        case "webhook_disabled":
          return { http_status: null, response_body: null, processed: false, cron_note: "Webhook is turned off in plugin settings; not sent." };
        case "site_down":
          return { http_status: 503, response_body: "Service Unavailable", processed: false, cron_note: null };
        case "settings_wrong":
          return { http_status: 401, response_body: "Webhook signature mismatch", processed: false, cron_note: null };
        case "dropped_200":
          return { http_status: 200, response_body: "OK", processed: false, cron_note: DROPPED_NOTE };
        case "none":
          break;
      }
      const ok = (cron_note: string | null = null): WebhookReceipt => ({ http_status: 200, response_body: "OK", processed: true, cron_note });
      if (!["payment.captured", "order.paid"].includes(env.event) || !env.payment_id) return ok();
      const o =
        findOrder(merchantId, { paymentId: env.payment_id }) ??
        (env.order_id
          ? (db
              .select()
              .from(s.storeOrders)
              .where(and(eq(s.storeOrders.merchant_id, merchantId), eq(s.storeOrders.razorpay_order_id, env.order_id)))
              .get() ?? null)
          : null);
      if (!o) return ok("No store order for this payment.");
      if (o.payment_id === env.payment_id) return ok();
      if (o.status === "pending") {
        setStatus(o, "processing", `Paid via Razorpay, payment ${env.payment_id}`, { payment_id: env.payment_id });
        return ok();
      }
      if (o.status === "cancelled") return ok("Order was cancelled; payment not applied.");
      return ok(`Order already ${o.status}; second payment ignored.`);
    },

    setFailure(merchantId, failure) {
      merchant(merchantId);
      failures.set(merchantId, failure);
    },
    failure: failureOf,
    stock(merchantId, product) {
      return catalog(merchantId).get(product)?.stock;
    },

    runCron(merchantId) {
      siteUp(merchantId);
      const cutoff = clock.now() - HOLD_STOCK_MINUTES * 60_000;
      const pending = db
        .select()
        .from(s.storeOrders)
        .where(and(eq(s.storeOrders.merchant_id, merchantId), eq(s.storeOrders.status, "pending")))
        .all()
        .filter((o) => o.created_at <= cutoff);
      return pending.map((o) => {
        moveStock(merchantId, o.items, 1);
        return setStatus(o, "cancelled", AUTO_CANCEL_NOTE, { items: snapshotItems(merchantId, o.items) });
      });
    },
  };
  return sim;
}

// Simulated store connector (WooCommerce-like) over store_orders, with plugin
// state in store_settings and live stock in products.
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

export const STORE_FAILURES = s.STORE_FAILURE_MODES;
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
const HOLD_STOCK_MINUTES = 60;

export type StoreSim = StoreConnector & {
  setFailure(merchantId: string, failure: StoreFailure): void;
  failure(merchantId: string): StoreFailure;
  stock(merchantId: string, product: string): number | undefined;
  // Runs the store's own cron: cancels pending orders past the hold-stock time.
  runCron(merchantId: string): StoreOrder[];
};

export function createStoreSim(db: Db, clock: Clock): StoreSim {
  const repo = createRepository(db);

  const settingsOf = (merchantId: string) => {
    const row = repo.storeSettings.get(merchantId);
    if (!row) throw new StoreError(`${merchantId} has no connected store`, 404);
    return row;
  };
  const siteUp = (merchantId: string) => {
    if (settingsOf(merchantId).site_status === "down") throw new StoreError("Store site is down (503)", 503);
  };
  const slug = (merchantId: string) => merchantId.replace(/^m_/, "").replace(/_/g, "");

  // Order items name their product; stock always comes from the products table.
  const product = (merchantId: string, name: string) =>
    db
      .select()
      .from(s.products)
      .where(and(eq(s.products.merchant_id, merchantId), eq(s.products.name, name)))
      .get();
  const moveStock = (merchantId: string, items: { name: string; qty: number }[], sign: 1 | -1) => {
    const found = items.map((it) => {
      const p = product(merchantId, it.name);
      if (!p) throw new StoreError(`Unknown product: ${it.name}`);
      if (sign < 0 && p.stock < it.qty) throw new StoreError(`Not enough stock for ${it.name} (${p.stock} left)`);
      return { p, qty: it.qty };
    });
    db.transaction(() => {
      for (const { p, qty } of found) repo.products.update(p.id, { stock: product(merchantId, p.name)!.stock + sign * qty });
    });
  };
  const snapshotItems = (merchantId: string, items: { name: string; qty: number }[]) =>
    items.map((it) => {
      const p = product(merchantId, it.name)!;
      return { name: it.name, qty: it.qty, price: p.price, stock: p.stock };
    });
  // Orders are returned with item stock read live from products.
  const withStock = (o: StoreOrder): StoreOrder => {
    const items = o.items.map((it) => ({ ...it, stock: product(o.merchant_id, it.name)?.stock ?? it.stock }));
    return { ...o, items, stock: items.length ? Math.min(...items.map((i) => i.stock)) : o.stock };
  };

  const orderOf = (merchantId: string, orderId: string) => {
    const o = repo.storeOrders.get(orderId);
    if (!o || o.merchant_id !== merchantId) throw new StoreError(`Order ${orderId} not found`, 404);
    return o;
  };
  const setStatus = (o: StoreOrder, status: StoreOrder["status"], note: string, patch: Partial<StoreOrder> = {}) => {
    const updated = repo.storeOrders.update(o.id, {
      ...patch,
      status,
      status_history: [...o.status_history, { status, at: clock.now(), note }],
    })!;
    return withStock(updated);
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
    const o = db.select().from(s.storeOrders).where(where).orderBy(desc(s.storeOrders.created_at)).get();
    return o ? withStock(o) : null;
  };

  const sim: StoreSim = {
    hasStore(merchantId) {
      return repo.storeSettings.get(merchantId) !== undefined;
    },

    async getSettings(merchantId) {
      siteUp(merchantId);
      const row = settingsOf(merchantId);
      const site = `https://${slug(merchantId)}.example.com`;
      return {
        platform: "woocommerce",
        site_url: site,
        plugin: row.plugin,
        plugin_version: row.plugin_version,
        webhook_url: `${site}/?wc-api=razorpay_webhook`,
        webhook_enabled: row.webhook_enabled,
        webhook_secret_matches: row.failure_mode !== "wrong_settings",
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
      if (o.payment_id === paymentId && o.status !== "cancelled") return withStock(o);
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
      const created = repo.storeOrders.insert({
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
      return withStock(created);
    },

    async cancelUnshipped(merchantId, orderId, reason) {
      siteUp(merchantId);
      const o = orderOf(merchantId, orderId);
      if (o.status === "completed") throw new StoreError(`Order ${o.number} has shipped and cannot be cancelled`);
      if (o.status === "cancelled") return withStock(o);
      moveStock(merchantId, o.items, 1);
      return setStatus(o, "cancelled", reason, { items: snapshotItems(merchantId, o.items) });
    },

    async receiveWebhook(merchantId, env) {
      const row = settingsOf(merchantId);
      if (!row.webhook_enabled) {
        return { http_status: null, response_body: null, processed: false, cron_note: "Webhook is turned off in plugin settings; not sent." };
      }
      if (row.site_status === "down") {
        return { http_status: 503, response_body: "Service Unavailable", processed: false, cron_note: null };
      }
      switch (row.failure_mode) {
        case "webhook_disabled":
        case "site_down":
          break;
        case "wrong_settings":
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

    // failure_mode drives site_status and webhook_enabled, so the three never disagree.
    setFailure(merchantId, failure) {
      settingsOf(merchantId);
      repo.storeSettings.update(merchantId, {
        failure_mode: failure,
        site_status: failure === "site_down" ? "down" : "up",
        webhook_enabled: failure !== "webhook_disabled",
      });
    },
    failure(merchantId) {
      return settingsOf(merchantId).failure_mode;
    },
    stock(merchantId, name) {
      return product(merchantId, name)?.stock;
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

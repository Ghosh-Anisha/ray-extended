// The read tools: look, never change anything. Each is scoped to one
// merchant and takes one id (or null), which is what investigate's loop
// hands it. Razorpay records come through the Razorpay adapter, store
// records through the store adapter; the simulated logs (webhook
// deliveries, plugin reports, downtimes, invoices, bank credits) are read
// from their tables. The kill switch never blocks a read.
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { RazorpayError } from "@/adapters/razorpay";
import { StoreError, type OrderRef } from "@/adapters/store";
import * as s from "@/db/schema";
import type { ReadToolName, ReadToolResult, ReadToolRunner } from "./names";

const DAY = 24 * 60 * 60 * 1000;
// A downtime counts for a payment if it overlaps the payment's time, give or take this.
const DOWNTIME_SLACK_MS = 30 * 60 * 1000;

const none = (why?: string): ReadToolResult => ({ evidence_ids: [], data: why ? { found: false, why } : null });

// Razorpay answers an unknown id with NOT_FOUND; a read reports that as nothing found.
async function orNone<T>(fn: () => Promise<T>, wrap: (v: T) => ReadToolResult): Promise<ReadToolResult> {
  try {
    return wrap(await fn());
  } catch (e) {
    if (e instanceof RazorpayError && e.code === "NOT_FOUND") return none();
    throw e;
  }
}

// "#1234" or "1234" is an order number, pay_ a payment, so_ a store order id;
// anything else is read as the receipt.
export function storeOrderRef(id: string): OrderRef {
  if (/^#?\d+$/.test(id)) return { number: id };
  if (id.startsWith("pay_")) return { paymentId: id };
  if (id.startsWith("so_")) return { id };
  return { receipt: id };
}

export function createReadTools(a: Adapters, merchantId: string): ReadToolRunner {
  const { db } = a;
  const rzp = a.razorpay(merchantId);
  const need = (tool: ReadToolName, id: string | null): id is string => {
    if (!id) throw new Error(`${tool} needs an id`);
    return true;
  };

  const tools: Record<ReadToolName, (id: string | null) => Promise<ReadToolResult>> = {
    async get_payment(id) {
      need("get_payment", id);
      return orNone(() => rzp.fetchPayment(id!), (p) => ({ evidence_ids: [p.id], data: p }));
    },

    async get_order(id) {
      need("get_order", id);
      return orNone(() => rzp.fetchOrder(id!), (o) => ({ evidence_ids: [o.id], data: o }));
    },

    async list_order_payments(id) {
      need("list_order_payments", id);
      return orNone(() => rzp.listOrderPayments(id!), (ps) => ({ evidence_ids: ps.map((p) => p.id), data: ps }));
    },

    async get_refunds(id) {
      need("get_refunds", id);
      return orNone(() => rzp.listRefunds(id!), (rs) => ({ evidence_ids: rs.map((r) => r.id), data: rs }));
    },

    async get_webhook_deliveries(id) {
      need("get_webhook_deliveries", id);
      const rows = db
        .select()
        .from(s.webhookDeliveries)
        .where(and(eq(s.webhookDeliveries.merchant_id, merchantId), eq(s.webhookDeliveries.payment_id, id!)))
        .orderBy(s.webhookDeliveries.delivered_at, sql`rowid`)
        .all();
      return { evidence_ids: rows.map((r) => r.event_id), data: rows };
    },

    // Reports for this merchant's plugin and version (or the version given).
    // Other merchants' reports are shared without saying whose they are.
    async get_plugin_reports(id) {
      const settings = db.select().from(s.storeSettings).where(eq(s.storeSettings.merchant_id, merchantId)).get();
      const version = id ?? settings?.plugin_version;
      if (!version) return none("no plugin version known");
      const plugin = settings?.plugin ?? null;
      const rows = db
        .select()
        .from(s.pluginReports)
        .where(and(eq(s.pluginReports.plugin_version, version), plugin ? eq(s.pluginReports.plugin, plugin) : undefined))
        .orderBy(desc(s.pluginReports.reported_at))
        .all();
      return {
        evidence_ids: rows.map((r) => r.id),
        data: {
          plugin,
          plugin_version: version,
          reports: rows.map((r) => ({ id: r.id, failure: r.failure, reported_at: r.reported_at, from_this_merchant: r.merchant_id === merchantId })),
        },
      };
    },

    async get_store_order(id) {
      need("get_store_order", id);
      if (!a.store.hasStore(merchantId)) return none("no connected store");
      try {
        const o = await a.store.getOrder(merchantId, storeOrderRef(id!));
        return o ? { evidence_ids: [o.id], data: o } : none();
      } catch (e) {
        if (e instanceof StoreError) return { evidence_ids: [`store_settings:${merchantId}`], data: { reachable: false, error: e.message, http_status: e.httpStatus } };
        throw e;
      }
    },

    // What the store's own settings page shows. A site that is down can't be read.
    async get_store_settings() {
      if (!a.store.hasStore(merchantId)) return none("no connected store");
      const evidence = [`store_settings:${merchantId}`];
      try {
        return { evidence_ids: evidence, data: { reachable: true, ...(await a.store.getSettings(merchantId)) } };
      } catch (e) {
        if (e instanceof StoreError) return { evidence_ids: evidence, data: { reachable: false, error: e.message, http_status: e.httpStatus } };
        throw e;
      }
    },

    // With a payment id: downtimes on that payment's method around its time.
    // Without: downtimes still running or ended in the last day.
    async get_downtimes(id) {
      let rows: (typeof s.downtimes.$inferSelect)[];
      if (id) {
        const p = await rzp.fetchPayment(id).catch((e) => {
          if (e instanceof RazorpayError && e.code === "NOT_FOUND") return null;
          throw e;
        });
        if (!p) return none();
        const at = p.created_at;
        rows = db
          .select()
          .from(s.downtimes)
          .all()
          .filter((d) => (!p.method || d.method === p.method) && d.start <= at + DOWNTIME_SLACK_MS && (d.end === null || d.end >= at - DOWNTIME_SLACK_MS));
      } else {
        rows = db
          .select()
          .from(s.downtimes)
          .where(or(isNull(s.downtimes.end), gte(s.downtimes.end, a.clock.now() - DAY)))
          .all();
      }
      return { evidence_ids: rows.map((r) => r.id), data: rows };
    },

    // A dispute id, or a payment id for every dispute on that payment.
    async get_dispute(id) {
      need("get_dispute", id);
      if (id!.startsWith("pay_")) {
        const ds = await rzp.listDisputes({ paymentId: id! });
        return { evidence_ids: ds.map((d) => d.id), data: ds };
      }
      return orNone(() => rzp.fetchDispute(id!), (d) => ({ evidence_ids: [d.id], data: d }));
    },

    // The subscription, its own pending invoice and its mandates.
    async get_subscription(id) {
      need("get_subscription", id);
      return orNone(
        async () => {
          const sub = await rzp.fetchSubscription(id!);
          const pending = await rzp.fetchPendingInvoice(id!);
          const mandates = db.select().from(s.mandates).where(eq(s.mandates.subscription_id, id!)).all();
          return { sub, pending, mandates };
        },
        ({ sub, pending, mandates }) => ({
          evidence_ids: [sub.id, ...(pending ? [pending.id] : []), ...mandates.map((m) => m.id)],
          data: { subscription: sub, pending_invoice: pending, mandates },
        }),
      );
    },

    // A buyer id (buy_) for that buyer's invoices, an invoice id, or null for
    // every invoice not yet paid. Promises on them come along.
    async get_invoices(id) {
      const mine = eq(s.invoices.merchant_id, merchantId);
      const where = !id
        ? and(mine, sql`${s.invoices.status} != 'paid'`)
        : id.startsWith("buy_")
          ? and(mine, eq(s.invoices.buyer_id, id))
          : and(mine, eq(s.invoices.id, id));
      const rows = db.select().from(s.invoices).where(where).orderBy(s.invoices.due_date).all();
      const ids = new Set(rows.map((r) => r.id));
      const promises = db.select().from(s.promises).all().filter((p) => ids.has(p.invoice_id));
      return { evidence_ids: [...rows.map((r) => r.id), ...promises.map((p) => p.id)], data: { invoices: rows, promises } };
    },

    // A credit id, or null for every credit not yet matched to an invoice.
    async get_bank_credits(id) {
      const rows = db
        .select()
        .from(s.bankCredits)
        .where(and(eq(s.bankCredits.merchant_id, merchantId), id ? eq(s.bankCredits.id, id) : undefined))
        .orderBy(desc(s.bankCredits.date))
        .all()
        .filter((r) => id || r.matched_invoices.length === 0);
      return { evidence_ids: rows.map((r) => r.id), data: rows };
    },
  };

  return (tool, id) => tools[tool](id);
}

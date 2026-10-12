// The connector sweep. With no webhook configured, Razorpay sends the store
// nothing, so only the connector can see the problem: a store order still
// Pending while Razorpay has a captured payment for it. Each one goes to
// handleEvent as a store event, the same entry point as every other event.
import { and, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import * as s from "@/db/schema";
import type { Engine, HandleResult } from "@/engine/engine";
import { normalizeEmail, normalizePhone } from "@/engine/events";
import { recentPayments } from "./match";
import { hasConnector } from "./store";

export async function connectorSweep(engine: Engine, a: Adapters, merchantId: string): Promise<HandleResult[]> {
  if (!hasConnector(a, merchantId)) return [];
  const now = a.clock.now();
  const pending = a.db
    .select()
    .from(s.storeOrders)
    .where(and(eq(s.storeOrders.merchant_id, merchantId), eq(s.storeOrders.status, "pending")))
    .all();
  const payments = (await recentPayments(a, merchantId, now)).filter((p) => p.status === "captured");
  const out: HandleResult[] = [];
  for (const o of pending) {
    const p = payments.find((x) => x.order_id && x.order_id === o.razorpay_order_id);
    if (!p) continue;
    out.push(
      await engine.handleEvent({
        kind: "store",
        merchantId,
        at: now,
        // One event per order and payment: a second sweep is a duplicate.
        sourceId: `sweep_${o.id}_${p.id}`,
        keys: { paymentId: p.id, phone: normalizePhone(p.contact), email: normalizeEmail(p.email) },
        payload: { source: "store", kind: "paid_order_pending", order_id: o.id, order_number: o.number, payment_id: p.id },
      }),
    );
  }
  return out;
}

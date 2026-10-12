// Reading the merchant's store through the connector, and the fulfil action
// that fits what the store shows (Fulfil by store type).
import { and, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import type { Payment } from "@/adapters/razorpay";
import { AUTO_CANCEL_NOTE, StoreError, type StoreOrder } from "@/adapters/store";
import * as s from "@/db/schema";
import { createRepository } from "@/db/repository";

export type StoreRead =
  | { kind: "no_connector" }
  | { kind: "unreachable"; error: string }
  | { kind: "found"; order: StoreOrder }
  | { kind: "missing" };

export function hasConnector(a: Adapters, merchantId: string) {
  const m = createRepository(a.db).merchants.get(merchantId);
  return !!m?.connector_on && a.store.hasStore(merchantId);
}

// The store order for a payment: by the payment, else by the Razorpay
// order's receipt (WooCommerce puts its order there).
export async function readStoreOrder(a: Adapters, merchantId: string, p: Payment): Promise<StoreRead> {
  if (!hasConnector(a, merchantId)) return { kind: "no_connector" };
  try {
    const byPayment = await a.store.getOrder(merchantId, { paymentId: p.id });
    if (byPayment) return { kind: "found", order: byPayment };
    const receipt = await receiptOf(a, merchantId, p);
    const byReceipt = receipt ? await a.store.getOrder(merchantId, { receipt }) : null;
    return byReceipt ? { kind: "found", order: byReceipt } : { kind: "missing" };
  } catch (e) {
    if (e instanceof StoreError) return { kind: "unreachable", error: e.message };
    throw e;
  }
}

export async function receiptOf(a: Adapters, merchantId: string, p: Payment): Promise<string | null> {
  if (!p.order_id) return null;
  try {
    return (await a.razorpay(merchantId).fetchOrder(p.order_id)).receipt;
  } catch {
    return null;
  }
}

// Without a connector RAY only knows the receipt: wc_1234 is order #1234.
export async function orderNumberGuess(a: Adapters, merchantId: string, p: Payment): Promise<string | null> {
  const receipt = await receiptOf(a, merchantId, p);
  const n = receipt?.match(/(\d+)$/)?.[1];
  return n ? `#${n}` : null;
}

export const isPaidFor = (o: StoreOrder, p: Payment) => o.payment_id === p.id && (o.status === "processing" || o.status === "completed");
export const autoCancelled = (o: StoreOrder) => o.status === "cancelled" && o.status_history.at(-1)?.note === AUTO_CANCEL_NOTE;

// Orders in the store that carry this payment. More than one is flagged.
export function ordersWithPayment(a: Adapters, merchantId: string, paymentId: string) {
  return a.db
    .select()
    .from(s.storeOrders)
    .where(and(eq(s.storeOrders.merchant_id, merchantId), eq(s.storeOrders.payment_id, paymentId)))
    .all();
}

export type Fulfil =
  | { tool: "mark_paid"; args: { order_id: string; payment_id: string } }
  | { tool: "restore_order"; args: { order_id: string; payment_id: string } }
  | { tool: "create_order_for_payment"; args: { payment_id: string; items: { name: string; qty: number }[]; customer_id: string | null } };

// Mark the existing order paid; restore it if the store auto-cancelled it;
// create one only if none exists, from the one product whose price is the
// captured amount (the order total must equal it). null: RAY can't fulfil.
export function fulfilFor(a: Adapters, merchantId: string, read: StoreRead, p: Payment, customerId: string | null): Fulfil | null {
  if (read.kind === "found") {
    const o = read.order;
    if (o.status === "pending" && !o.payment_id) return { tool: "mark_paid", args: { order_id: o.id, payment_id: p.id } };
    if (autoCancelled(o)) return { tool: "restore_order", args: { order_id: o.id, payment_id: p.id } };
    return null;
  }
  if (read.kind === "missing") {
    const products = createRepository(a.db).products.list(eq(s.products.merchant_id, merchantId)).filter((x) => x.price === p.amount);
    if (products.length !== 1) return null;
    return { tool: "create_order_for_payment", args: { payment_id: p.id, items: [{ name: products[0].name, qty: 1 }], customer_id: customerId } };
  }
  return null;
}

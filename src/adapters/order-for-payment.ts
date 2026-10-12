// RAY creates a store order for a case's payment. The order total is always
// the captured amount from Razorpay's own payment record; line items only
// fill in what was bought. If they don't add up, nothing is created: the
// mismatch goes on the case timeline and the case waits for the merchant.
import { createRepository } from "@/db/repository";
import { transition } from "@/engine/state-machine";
import type { Adapters } from ".";
import { newId } from "./ids";
import { StoreError, type OrderTotalMismatch, type StoreOrder } from "./store";

export const ORDER_TOTAL_MISMATCH = "order_total_mismatch";

export type OrderForPaymentResult =
  | { created: true; order: StoreOrder }
  | { created: false; mismatch: OrderTotalMismatch };

export async function createOrderForCasePayment(
  a: Adapters,
  input: { caseId: string; items: { name: string; qty: number }[]; customerId?: string | null },
): Promise<OrderForPaymentResult> {
  const repo = createRepository(a.db);
  const kase = repo.cases.get(input.caseId);
  if (!kase) throw new Error(`Case ${input.caseId} not found`);
  if (!kase.payment_id) throw new Error(`Case ${input.caseId} has no payment`);
  const payment = await a.razorpay(kase.merchant_id).fetchPayment(kase.payment_id);
  if (payment.status !== "captured") {
    throw new Error(`Payment ${payment.id} is ${payment.status}; an order is only created for a captured payment`);
  }

  try {
    const order = await a.store.createOrderForPayment(kase.merchant_id, {
      paymentId: payment.id,
      expectedTotal: payment.amount,
      customerId: input.customerId ?? null,
      razorpayOrderId: payment.order_id,
      items: input.items,
    });
    return { created: true, order };
  } catch (e) {
    if (!(e instanceof StoreError) || !e.mismatch) throw e;
    const event = repo.caseEvents.insert({
      id: newId("cev"),
      case_id: kase.id,
      at: a.clock.now(), // RAY found the mismatch itself; there is no source time
      type: "note",
      payload: {
        kind: ORDER_TOTAL_MISMATCH,
        payment_id: payment.id,
        currency: payment.currency,
        payment_amount: payment.amount,
        line_items_total: e.mismatch.line_items_total,
        items: input.items,
      },
      evidence_ref: payment.id,
    });
    transition(a.db, a.clock, kase.id, "waiting_merchant", {
      reason: "Line items don't add up to the payment",
      evidenceRef: event.id,
    });
    return { created: false, mismatch: e.mismatch };
  }
}

// Refund rules shared by the mock and the test-mode client, so both behave
// the same: the receipt is the idempotency key, over-refunds are rejected and
// a payment gets at most one refund.
import { RazorpayError, type Payment, type Refund } from "./types";

export type RefundDecision = { kind: "existing"; refund: Refund } | { kind: "create" };

export function decideRefund(
  payment: Payment,
  existing: Refund[],
  req: { amount: number; receipt: string },
): RefundDecision {
  const live = existing.filter((r) => r.status !== "failed");
  const same = live.find((r) => r.receipt === req.receipt);
  if (same) {
    if (same.amount !== req.amount) {
      throw new RazorpayError("RECEIPT_REUSED", `Receipt ${req.receipt} was already used for a different amount`);
    }
    return { kind: "existing", refund: same };
  }
  if (live.length > 0) {
    throw new RazorpayError("ALREADY_REFUNDED", `Payment ${payment.id} already has a refund`);
  }
  if (payment.status !== "captured") {
    throw new RazorpayError("INVALID_STATE", `Payment ${payment.id} is ${payment.status}, only captured payments can be refunded`);
  }
  if (req.amount > payment.amount - payment.amount_refunded) {
    throw new RazorpayError("OVER_REFUND", `Refund is more than the amount left on payment ${payment.id}`);
  }
  return { kind: "create" };
}

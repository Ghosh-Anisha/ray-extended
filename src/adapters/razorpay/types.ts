// The Razorpay adapter interface. Flows and tools only ever call this; the
// mock (simulated, backed by the rzp_* mirror tables) and the test-mode REST
// client both implement it. Money is integer minor units, times are epoch ms.
import { z } from "zod";

export type PaymentStatus = "created" | "authorized" | "captured" | "refunded" | "failed";

export type Payment = {
  id: string;
  order_id: string | null;
  status: PaymentStatus;
  amount: number;
  currency: string;
  base_amount: number | null;
  amount_refunded: number;
  method: string | null;
  contact: string | null;
  email: string | null;
  vpa: string | null;
  card_last4: string | null;
  card_country: string | null;
  utr: string | null;
  error_code: string | null;
  error_source: string | null;
  error_reason: string | null;
  created_at: number;
  captured_at: number | null;
};

export type Order = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  receipt: string | null;
  created_at: number;
};

export type Refund = {
  id: string;
  payment_id: string;
  status: string;
  amount: number;
  currency: string;
  receipt: string | null;
  created_at: number;
};

export type PaymentLink = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  short_url: string | null;
  reference_id: string | null;
  payment_id: string | null;
  created_at: number;
};

export type DisputeStatus = "open" | "under_review" | "won" | "lost" | "closed";

export const EVIDENCE_TYPES = [
  "shipping_proof",
  "billing_proof",
  "cancellation_proof",
  "customer_communication",
  "proof_of_service",
  "explanation_letter",
  "refund_confirmation",
  "access_activity_log",
  "refund_cancellation_policy",
  "term_and_conditions",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type DisputeEvidence = {
  amount: number | null;
  summary: string | null;
  documents: Partial<Record<EvidenceType, string[]>>;
  submitted_at: number | null;
};

export type Dispute = {
  id: string;
  payment_id: string;
  status: DisputeStatus | string;
  phase: string;
  amount: number;
  currency: string;
  reason_code: string;
  reason: string;
  network: string | null;
  deducted: boolean;
  respond_by: number;
  created_at: number;
  evidence: DisputeEvidence | null;
};

export type Subscription = {
  id: string;
  status: string;
  plan: string;
  amount: number | null;
  customer_id: string | null;
  pending_invoice_id: string | null;
  retries_left: number | null;
};

export type Invoice = {
  id: string;
  subscription_id: string | null;
  status: string;
  amount: number;
  payment_id: string | null;
  short_url: string | null;
  billing_start: number | null;
  billing_end: number | null;
};

export const createOrderInput = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3).default("INR"),
  receipt: z.string().min(1).max(40),
  notes: z.record(z.string(), z.string()).optional(),
});
export type CreateOrderInput = z.input<typeof createOrderInput>;

// receipt is the idempotency key: the same receipt returns the same refund.
export const refundInput = z.object({
  amount: z.number().int().positive(),
  receipt: z.string().min(1).max(40),
  notes: z.record(z.string(), z.string()).optional(),
});
export type RefundInput = z.input<typeof refundInput>;

export const paymentLinkInput = z.object({
  amount: z.number().int().min(100),
  currency: z.string().length(3).default("INR"),
  description: z.string().max(2048),
  reference_id: z.string().max(40).optional(),
  customer: z
    .object({ name: z.string().optional(), email: z.string().optional(), contact: z.string().optional() })
    .optional(),
  expire_by: z.number().int().optional(),
  notes: z.record(z.string(), z.string()).optional(),
});
export type PaymentLinkInput = z.input<typeof paymentLinkInput>;

// Contest goes draft first, then submit. Documents are Razorpay document ids.
export const contestInput = z.object({
  action: z.enum(["draft", "submit"]),
  amount: z.number().int().positive().optional(),
  summary: z.string().max(1000).optional(),
  documents: z.partialRecord(z.enum(EVIDENCE_TYPES), z.array(z.string().min(1))).optional(),
});
export type ContestInput = z.input<typeof contestInput>;

export interface RazorpayAdapter {
  readonly mode: "mock" | "test";
  createOrder(input: CreateOrderInput): Promise<Order>;
  fetchOrder(orderId: string): Promise<Order>;
  fetchOrderByReceipt(receipt: string): Promise<Order | null>;
  fetchPayment(paymentId: string): Promise<Payment>;
  listOrderPayments(orderId: string): Promise<Payment[]>;
  // Every payment created in [from, to] (epoch ms), oldest first. Razorpay
  // can't filter by contact or email, so callers filter in code.
  listPayments(window: { from: number; to: number }): Promise<Payment[]>;
  capturePayment(paymentId: string, amount: number, currency: string): Promise<Payment>;
  listRefunds(paymentId: string): Promise<Refund[]>;
  refund(paymentId: string, input: RefundInput): Promise<Refund>;
  createPaymentLink(input: PaymentLinkInput): Promise<PaymentLink>;
  fetchPaymentLink(linkId: string): Promise<PaymentLink>;
  fetchDispute(disputeId: string): Promise<Dispute>;
  listDisputes(filter?: { paymentId?: string }): Promise<Dispute[]>;
  contestDispute(disputeId: string, input: ContestInput): Promise<Dispute>;
  acceptDispute(disputeId: string): Promise<Dispute>;
  fetchSubscription(subscriptionId: string): Promise<Subscription>;
  pauseSubscription(subscriptionId: string): Promise<Subscription>;
  resumeSubscription(subscriptionId: string): Promise<Subscription>;
  cancelSubscription(subscriptionId: string): Promise<Subscription>;
  fetchPendingInvoice(subscriptionId: string): Promise<Invoice | null>;
}

export type RazorpayErrorCode =
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "INVALID_STATE"
  | "OVER_REFUND"
  | "ALREADY_REFUNDED"
  | "RECEIPT_REUSED"
  | "DEADLINE_PASSED"
  | "AUTH"
  | "SERVER";

export class RazorpayError extends Error {
  constructor(
    readonly code: RazorpayErrorCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "RazorpayError";
  }
}

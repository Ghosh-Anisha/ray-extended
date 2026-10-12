// Razorpay test mode over the public REST API with basic auth. Keys stay in
// this closure: they are never logged, never put in errors and never exposed
// as properties of the client.
import { z } from "zod";
import { decideRefund } from "./refund-policy";
import {
  contestInput,
  createOrderInput,
  paymentLinkInput,
  RazorpayError,
  refundInput,
  type Dispute,
  type Invoice,
  type Order,
  type Payment,
  type PaymentLink,
  type RazorpayAdapter,
  type RazorpayErrorCode,
  type Refund,
  type Subscription,
} from "./types";

export const RAZORPAY_API = "https://api.razorpay.com/v1";
export const TEST_KEY_PREFIX = "rzp_test_";

export type RazorpayKeys = { keyId: string; keySecret: string };

export function assertTestKey(keyId: string | undefined): asserts keyId is string {
  if (!keyId || !keyId.startsWith(TEST_KEY_PREFIX)) {
    throw new Error("Refusing to start: RAZORPAY_KEY_ID must be a Razorpay test key (rzp_test_). Live keys are never allowed.");
  }
}

const secs = (v: number | null | undefined) => (v == null ? null : v * 1000);
const opt = <T extends z.ZodType>(t: T) => t.nullish();

const paymentApi = z.object({
  id: z.string(),
  order_id: opt(z.string()),
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  amount: z.number(),
  currency: z.string(),
  base_amount: opt(z.number()),
  amount_refunded: opt(z.number()),
  method: opt(z.string()),
  contact: opt(z.string()),
  email: opt(z.string()),
  vpa: opt(z.string()),
  card: opt(z.object({ last4: opt(z.string()), country: opt(z.string()) })),
  acquirer_data: opt(z.object({ rrn: opt(z.string()), upi_transaction_id: opt(z.string()) }).loose()),
  error_code: opt(z.string()),
  error_source: opt(z.string()),
  error_reason: opt(z.string()),
  created_at: z.number(),
});
const toPayment = (p: z.infer<typeof paymentApi>): Payment => ({
  id: p.id,
  order_id: p.order_id ?? null,
  status: p.status,
  amount: p.amount,
  currency: p.currency,
  base_amount: p.base_amount ?? null,
  amount_refunded: p.amount_refunded ?? 0,
  method: p.method ?? null,
  contact: p.contact ?? null,
  email: p.email ?? null,
  vpa: p.vpa ?? null,
  card_last4: p.card?.last4 ?? null,
  card_country: p.card?.country ?? null,
  utr: p.acquirer_data?.rrn ?? null,
  error_code: p.error_code ?? null,
  error_source: p.error_source ?? null,
  error_reason: p.error_reason ?? null,
  created_at: p.created_at * 1000,
  captured_at: null,
});

const orderApi = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  receipt: opt(z.string()),
  created_at: z.number(),
});
const toOrder = (o: z.infer<typeof orderApi>): Order => ({
  id: o.id,
  status: o.status,
  amount: o.amount,
  currency: o.currency,
  receipt: o.receipt ?? null,
  created_at: o.created_at * 1000,
});

const refundApi = z.object({
  id: z.string(),
  payment_id: z.string(),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  receipt: opt(z.string()),
  created_at: z.number(),
});
const toRefund = (r: z.infer<typeof refundApi>): Refund => ({
  id: r.id,
  payment_id: r.payment_id,
  status: r.status,
  amount: r.amount,
  currency: r.currency,
  receipt: r.receipt ?? null,
  created_at: r.created_at * 1000,
});

const linkApi = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.number(),
  currency: z.string(),
  short_url: opt(z.string()),
  reference_id: opt(z.string()),
  payments: opt(z.array(z.object({ payment_id: z.string() }).loose())),
  created_at: z.number(),
});
const toLink = (l: z.infer<typeof linkApi>): PaymentLink => ({
  id: l.id,
  status: l.status,
  amount: l.amount,
  currency: l.currency,
  short_url: l.short_url ?? null,
  reference_id: l.reference_id || null,
  payment_id: l.payments?.[0]?.payment_id ?? null,
  created_at: l.created_at * 1000,
});

const disputeApi = z.object({
  id: z.string(),
  payment_id: z.string(),
  status: z.string(),
  phase: opt(z.string()),
  amount: z.number(),
  currency: z.string(),
  amount_deducted: opt(z.number()),
  reason_code: opt(z.string()),
  reason_description: opt(z.string()),
  respond_by: z.number(),
  created_at: z.number(),
  evidence: opt(
    z
      .object({ amount: opt(z.number()), summary: opt(z.string()), submitted_at: opt(z.number()) })
      .catchall(z.unknown()),
  ),
});
const toDispute = (d: z.infer<typeof disputeApi>): Dispute => {
  const { amount, summary, submitted_at, ...docs } = d.evidence ?? {};
  const documents = Object.fromEntries(
    Object.entries(docs).filter(([, v]) => Array.isArray(v) && v.length > 0),
  ) as Record<string, string[]>;
  return {
    id: d.id,
    payment_id: d.payment_id,
    status: d.status,
    phase: d.phase ?? "chargeback",
    amount: d.amount,
    currency: d.currency,
    reason_code: d.reason_code ?? "",
    reason: d.reason_description ?? "",
    network: null,
    deducted: (d.amount_deducted ?? 0) > 0,
    respond_by: d.respond_by * 1000,
    created_at: d.created_at * 1000,
    evidence: d.evidence
      ? { amount: amount ?? null, summary: summary ?? null, documents, submitted_at: secs(submitted_at) }
      : null,
  };
};

const subscriptionApi = z.object({ id: z.string(), status: z.string(), plan_id: z.string(), customer_id: opt(z.string()) });
const toSub = (r: z.infer<typeof subscriptionApi>): Subscription => ({
  id: r.id,
  status: r.status,
  plan: r.plan_id,
  amount: null,
  customer_id: r.customer_id ?? null,
  pending_invoice_id: null,
  retries_left: null,
});

const invoiceApi = z.object({
  id: z.string(),
  subscription_id: opt(z.string()),
  status: z.string(),
  amount: z.number(),
  payment_id: opt(z.string()),
  short_url: opt(z.string()),
  billing_start: opt(z.number()),
  billing_end: opt(z.number()),
});
const toInvoice = (i: z.infer<typeof invoiceApi>): Invoice => ({
  id: i.id,
  subscription_id: i.subscription_id ?? null,
  status: i.status,
  amount: i.amount,
  payment_id: i.payment_id ?? null,
  short_url: i.short_url ?? null,
  billing_start: secs(i.billing_start),
  billing_end: secs(i.billing_end),
});

const list = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });

// Razorpay answers an unknown id with 400 "The id provided does not exist".
function errorCode(status: number, message: string): RazorpayErrorCode {
  if (status === 401) return "AUTH";
  if (/does not exist/i.test(message)) return "NOT_FOUND";
  if (status === 404) return "NOT_FOUND";
  if (status >= 500) return "SERVER";
  return "BAD_REQUEST";
}

export function createTestClient(keys: RazorpayKeys, fetchImpl: typeof fetch = fetch): RazorpayAdapter {
  assertTestKey(keys.keyId);
  if (!keys.keySecret) throw new Error("Refusing to start: RAZORPAY_KEY_SECRET is empty");
  const auth = "Basic " + Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64");

  async function call<T extends z.ZodType>(
    method: string,
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<z.infer<T>> {
    let res: Response;
    try {
      res = await fetchImpl(RAZORPAY_API + path, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new RazorpayError("SERVER", `Could not reach Razorpay for ${method} ${path}`);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const desc = z.object({ error: z.object({ description: z.string() }) }).safeParse(json);
      const message = desc.success ? desc.data.error.description : `HTTP ${res.status}`;
      throw new RazorpayError(errorCode(res.status, message), `Razorpay ${method} ${path}: ${message}`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new RazorpayError("SERVER", `Unexpected Razorpay response for ${method} ${path}`);
    return parsed.data;
  }

  const enc = encodeURIComponent;

  const client: RazorpayAdapter = {
    mode: "test",

    async createOrder(input) {
      return toOrder(await call("POST", "/orders", orderApi, createOrderInput.parse(input)));
    },
    async fetchOrder(orderId) {
      return toOrder(await call("GET", `/orders/${enc(orderId)}`, orderApi));
    },
    async fetchOrderByReceipt(receipt) {
      const { items } = await call("GET", `/orders?receipt=${enc(receipt)}`, list(orderApi));
      const latest = items.sort((a, b) => b.created_at - a.created_at)[0];
      return latest ? toOrder(latest) : null;
    },
    async fetchPayment(paymentId) {
      return toPayment(await call("GET", `/payments/${enc(paymentId)}?expand[]=card`, paymentApi));
    },
    async listOrderPayments(orderId) {
      const { items } = await call("GET", `/orders/${enc(orderId)}/payments`, list(paymentApi));
      return items.map(toPayment).sort((a, b) => a.created_at - b.created_at);
    },
    async listPayments({ from, to }) {
      const out: Payment[] = [];
      // Razorpay pages at most 100 items per call.
      for (let skip = 0; ; skip += 100) {
        const { items } = await call("GET", `/payments?from=${Math.floor(from / 1000)}&to=${Math.ceil(to / 1000)}&count=100&skip=${skip}`, list(paymentApi));
        out.push(...items.map(toPayment));
        if (items.length < 100) break;
      }
      return out.sort((a, b) => a.created_at - b.created_at);
    },
    async capturePayment(paymentId, amount, currency) {
      return toPayment(await call("POST", `/payments/${enc(paymentId)}/capture`, paymentApi, { amount, currency }));
    },
    async listRefunds(paymentId) {
      const { items } = await call("GET", `/payments/${enc(paymentId)}/refunds`, list(refundApi));
      return items.map(toRefund);
    },
    async refund(paymentId, input) {
      const req = refundInput.parse(input);
      const [payment, existing] = await Promise.all([client.fetchPayment(paymentId), client.listRefunds(paymentId)]);
      const decision = decideRefund(payment, existing, req);
      if (decision.kind === "existing") return decision.refund;
      return toRefund(
        await call("POST", `/payments/${enc(paymentId)}/refund`, refundApi, {
          amount: req.amount,
          receipt: req.receipt,
          notes: req.notes,
          speed: "normal",
        }),
      );
    },
    async createPaymentLink(input) {
      const l = paymentLinkInput.parse(input);
      return toLink(
        await call("POST", "/payment_links", linkApi, {
          ...l,
          expire_by: l.expire_by === undefined ? undefined : Math.floor(l.expire_by / 1000),
          notify: { sms: false, email: false },
        }),
      );
    },
    async fetchPaymentLink(linkId) {
      return toLink(await call("GET", `/payment_links/${enc(linkId)}`, linkApi));
    },
    async fetchDispute(disputeId) {
      return toDispute(await call("GET", `/disputes/${enc(disputeId)}`, disputeApi));
    },
    async listDisputes(filter) {
      const { items } = await call("GET", "/disputes", list(disputeApi));
      return items.filter((d) => !filter?.paymentId || d.payment_id === filter.paymentId).map(toDispute);
    },
    async contestDispute(disputeId, input) {
      const c = contestInput.parse(input);
      const body = { action: c.action, amount: c.amount, summary: c.summary, ...c.documents };
      return toDispute(await call("PATCH", `/disputes/${enc(disputeId)}/contest`, disputeApi, body));
    },
    async acceptDispute(disputeId) {
      return toDispute(await call("POST", `/disputes/${enc(disputeId)}/accept`, disputeApi));
    },
    async fetchSubscription(subscriptionId) {
      return toSub(await call("GET", `/subscriptions/${enc(subscriptionId)}`, subscriptionApi));
    },
    async pauseSubscription(subscriptionId) {
      return toSub(await call("POST", `/subscriptions/${enc(subscriptionId)}/pause`, subscriptionApi, { pause_at: "now" }));
    },
    async resumeSubscription(subscriptionId) {
      return toSub(await call("POST", `/subscriptions/${enc(subscriptionId)}/resume`, subscriptionApi, { resume_at: "now" }));
    },
    async cancelSubscription(subscriptionId) {
      return toSub(
        await call("POST", `/subscriptions/${enc(subscriptionId)}/cancel`, subscriptionApi, { cancel_at_cycle_end: 0 }),
      );
    },
    async fetchPendingInvoice(subscriptionId) {
      const { items } = await call("GET", `/invoices?subscription_id=${enc(subscriptionId)}`, list(invoiceApi));
      const pending = items.filter((i) => i.status === "issued");
      const last = pending.sort((a, b) => (b.billing_start ?? 0) - (a.billing_start ?? 0))[0];
      return last ? toInvoice(last) : null;
    },
  };
  return client;
}

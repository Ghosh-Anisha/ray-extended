// The act tools. Each one is a typed args schema, the guards it needs and
// the adapter call that does it. Only src/guards imports this file: every
// act goes through guardedCall, never straight here (a test checks).
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Adapters } from "@/adapters";
import { CHANNELS, SENDER_MODES } from "@/db/schema";
import * as s from "@/db/schema";
import { createRepository } from "@/db/repository";
import { contestInput, EVIDENCE_TYPES } from "@/adapters/razorpay";
import type { Case } from "@/engine/state-machine";
import type { ActToolName } from "./names";

// The guards a tool can ask for. Kill switch and confidence run on every
// act tool; approval runs unless the tool runs alone.
export const GUARDS = [
  "kill_switch",
  "confidence",
  "approval",
  "amount_cap",
  "match",
  "one_refund",
  "pre_action",
  "order_total",
  "channel_rules",
  "consent",
  "first_message",
  "grounding",
  "refund_hold",
] as const;
export type GuardName = (typeof GUARDS)[number];

// What a customer said that points at a payment. The match guard checks it
// against Razorpay's own record: exact UTR, else contact + amount within
// ±2 hours. A screenshot alone never counts. sender is the phone or email
// the claim came from; if it isn't the checkout contact, the case needs a
// message from the checkout contact confirming it.
export const matchClaim = z.object({
  sender: z.string().min(3),
  utr: z.string().min(4).optional(),
  contact: z.string().optional(),
  amount: z.number().int().positive().optional(),
  at: z.number().int().optional(),
  screenshot: z.boolean().optional(),
  checkout_confirmation_event_id: z.string().optional(),
});
export type MatchClaim = z.infer<typeof matchClaim>;

const paymentId = z.string().startsWith("pay_");
const storeItem = z.object({ name: z.string().min(1), qty: z.number().int().positive() });

export type ActRunContext = { a: Adapters; kase: Case; idempotencyKey: string; actionId: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActToolSpec<A = any> = {
  args: z.ZodType<A>;
  // Merchant-facing name of the action, for reasons: "A check stopped the refund".
  label: string;
  // required: a tap or an approved rule. unless_sure: a tap unless the case is Sure. none: runs alone.
  approval: "required" | "unless_sure" | "none";
  guards: GuardName[];
  holdMs?: number;
  paymentId?(args: A): string | undefined;
  storeOrderId?(args: A): string | undefined;
  // The amount in INR paise the amount cap compares, or null when there is none.
  amountInr?(ctx: { a: Adapters; kase: Case }, args: A): Promise<number | null>;
  run(ctx: ActRunContext, args: A): Promise<Record<string, unknown>>;
  // Reverses a done action (post_match). Refunds are undone inside their hold instead.
  undo?(ctx: ActRunContext, args: A, result: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export const REFUND_HOLD_MS = 10 * 60 * 1000;

// Foreign payments compare by Razorpay's INR base amount.
async function paymentInr(a: Adapters, kase: Case, id: string, minor?: number) {
  const p = await a.razorpay(kase.merchant_id).fetchPayment(id);
  const amount = minor ?? p.amount;
  if (p.currency === "INR" || !p.base_amount) return amount;
  return Math.round((amount * p.base_amount) / p.amount);
}

const asRecord = (v: unknown) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

const fulfil = { match: matchClaim.optional() };

const subscriptionArgs = z.object({ subscription_id: z.string().min(1) });
const subscriptionAmount = async ({ a, kase }: { a: Adapters; kase: Case }, args: { subscription_id: string }) => {
  const sub = await a.razorpay(kase.merchant_id).fetchSubscription(args.subscription_id);
  return sub.amount ?? createRepository(a.db).subscriptions.get(args.subscription_id)?.amount ?? null;
};
const disputeAmount = async ({ a, kase }: { a: Adapters; kase: Case }, args: { dispute_id: string }) => {
  const d = await a.razorpay(kase.merchant_id).fetchDispute(args.dispute_id);
  return paymentInr(a, kase, d.payment_id, d.amount);
};

const postMatchArgs = z.object({
  credit_id: z.string().min(1),
  allocations: z.array(z.object({ invoice_id: z.string().min(1), amount: z.number().int().positive() })).min(1),
});

// Types each tool's run and checks from its own args schema.
const def = <A>(spec: ActToolSpec<A>): ActToolSpec => spec;

export const ACT_TOOL_SPECS: { [K in ActToolName]: ActToolSpec } = {
  mark_paid: def({
    args: z.object({ order_id: z.string().min(1), payment_id: paymentId, ...fulfil }),
    label: "marking the order paid",
    approval: "required",
    guards: ["match", "pre_action", "amount_cap"],
    paymentId: (x) => x.payment_id,
    storeOrderId: (x) => x.order_id,
    amountInr: ({ a, kase }, x) => paymentInr(a, kase, x.payment_id),
    async run({ a, kase }, x) {
      return asRecord(await a.store.markPaid(kase.merchant_id, x.order_id, x.payment_id));
    },
  }),

  // An auto-cancelled order is restored, then marked paid with the payment.
  restore_order: def({
    args: z.object({ order_id: z.string().min(1), payment_id: paymentId, ...fulfil }),
    label: "restoring the order",
    approval: "required",
    guards: ["match", "pre_action", "amount_cap"],
    paymentId: (x) => x.payment_id,
    storeOrderId: (x) => x.order_id,
    amountInr: ({ a, kase }, x) => paymentInr(a, kase, x.payment_id),
    async run({ a, kase }, x) {
      await a.store.restoreCancelled(kase.merchant_id, x.order_id);
      return asRecord(await a.store.markPaid(kase.merchant_id, x.order_id, x.payment_id));
    },
  }),

  create_order_for_payment: def({
    args: z.object({ payment_id: paymentId, items: z.array(storeItem).min(1), customer_id: z.string().nullish(), ...fulfil }),
    label: "creating the order",
    approval: "required",
    guards: ["match", "pre_action", "order_total", "amount_cap"],
    paymentId: (x) => x.payment_id,
    amountInr: ({ a, kase }, x) => paymentInr(a, kase, x.payment_id),
    async run({ a, kase }, x) {
      const p = await a.razorpay(kase.merchant_id).fetchPayment(x.payment_id);
      return asRecord(
        await a.store.createOrderForPayment(kase.merchant_id, {
          paymentId: p.id,
          expectedTotal: p.amount,
          customerId: x.customer_id ?? null,
          razorpayOrderId: p.order_id,
          items: x.items,
        }),
      );
    },
  }),

  cancel_order: def({
    args: z.object({ order_id: z.string().min(1), reason: z.string().min(1) }),
    label: "cancelling the order",
    approval: "required",
    guards: ["amount_cap"],
    storeOrderId: (x) => x.order_id,
    async amountInr({ a, kase }, x) {
      return (await a.store.getOrder(kase.merchant_id, { id: x.order_id }))?.total ?? null;
    },
    async run({ a, kase }, x) {
      return asRecord(await a.store.cancelUnshipped(kase.merchant_id, x.order_id, x.reason));
    },
  }),

  // Held for 10 minutes with Undo; the idempotency key is the refund receipt.
  refund: def({
    args: z.object({ payment_id: paymentId, amount: z.number().int().positive(), ...fulfil }),
    label: "the refund",
    approval: "required",
    guards: ["match", "one_refund", "pre_action", "amount_cap", "refund_hold"],
    holdMs: REFUND_HOLD_MS,
    paymentId: (x) => x.payment_id,
    amountInr: ({ a, kase }, x) => paymentInr(a, kase, x.payment_id, x.amount),
    async run({ a, kase, idempotencyKey }, x) {
      return asRecord(
        await a.razorpay(kase.merchant_id).refund(x.payment_id, { amount: x.amount, receipt: idempotencyKey, notes: { case_id: kase.id } }),
      );
    },
  }),

  capture: def({
    args: z.object({ payment_id: paymentId }),
    label: "capturing the payment",
    approval: "required",
    guards: ["match", "pre_action", "amount_cap"],
    paymentId: (x) => x.payment_id,
    amountInr: ({ a, kase }, x) => paymentInr(a, kase, x.payment_id),
    async run({ a, kase }, x) {
      const rzp = a.razorpay(kase.merchant_id);
      const p = await rzp.fetchPayment(x.payment_id);
      return asRecord(await rzp.capturePayment(p.id, p.amount, p.currency));
    },
  }),

  // A Razorpay-hosted link in the merchant's name. Mirrored so later checks
  // can tell it is Razorpay's.
  payment_link: def({
    args: z.object({
      amount: z.number().int().min(100),
      currency: z.string().length(3).default("INR"),
      description: z.string().min(1).max(2048),
      reference_id: z.string().max(40).optional(),
      customer: z.object({ name: z.string().optional(), email: z.string().optional(), contact: z.string().optional() }).optional(),
    }),
    label: "the payment link",
    approval: "none",
    guards: [],
    async run({ a, kase }, x) {
      const link = await a.razorpay(kase.merchant_id).createPaymentLink(x);
      const repo = createRepository(a.db);
      if (!repo.rzpLinks.get(link.id)) {
        repo.rzpLinks.insert({
          id: link.id, merchant_id: kase.merchant_id, status: link.status, amount: link.amount, currency: link.currency,
          short_url: link.short_url, receipt: link.reference_id, created_at: link.created_at,
        });
      }
      return asRecord(link);
    },
  }),

  // kind "question" is the one thing RAY may still send when it's Unsure.
  send_message: def({
    args: z
      .object({
        channel: z.enum(CHANNELS),
        to: z.string().min(3),
        sender_mode: z.enum(SENDER_MODES),
        kind: z.enum(["question", "update"]).default("update"),
        body: z.string().min(1).optional(),
        template_id: z.string().optional(),
        params: z.record(z.string(), z.string()).optional(),
      })
      .refine((v) => (v.body === undefined) !== (v.template_id === undefined), "Give either a body or a template_id"),
    label: "the message",
    approval: "none",
    guards: ["channel_rules", "consent", "first_message", "grounding"],
    async run({ a, kase }, x) {
      const m = await a.messaging.send({
        merchantId: kase.merchant_id,
        caseId: kase.id,
        channel: x.channel,
        to: x.to,
        senderMode: x.sender_mode,
        body: x.body,
        templateId: x.template_id,
        params: x.params,
      });
      return { message_id: m.id, channel: m.channel, to: m.to, from: m.from, body: m.body, within_24h: m.within_24h };
    },
  }),

  // Saves evidence on the dispute as a draft; nothing is submitted.
  attach_dispute_proof: def({
    args: z.object({
      dispute_id: z.string().min(1),
      summary: z.string().max(1000).optional(),
      amount: z.number().int().positive().optional(),
      documents: z.partialRecord(z.enum(EVIDENCE_TYPES), z.array(z.string().min(1))),
    }),
    label: "attaching proof to the dispute",
    approval: "none",
    guards: [],
    async run({ a, kase }, x) {
      return asRecord(await a.razorpay(kase.merchant_id).contestDispute(x.dispute_id, contestInput.parse({ action: "draft", ...x, dispute_id: undefined })));
    },
  }),

  contest_dispute: def({
    args: z.object({
      dispute_id: z.string().min(1),
      summary: z.string().max(1000).optional(),
      amount: z.number().int().positive().optional(),
      documents: z.partialRecord(z.enum(EVIDENCE_TYPES), z.array(z.string().min(1))).optional(),
    }),
    label: "contesting the dispute",
    approval: "required",
    guards: ["amount_cap"],
    amountInr: disputeAmount,
    async run({ a, kase }, x) {
      return asRecord(await a.razorpay(kase.merchant_id).contestDispute(x.dispute_id, contestInput.parse({ action: "submit", ...x, dispute_id: undefined })));
    },
  }),

  accept_dispute: def({
    args: z.object({ dispute_id: z.string().min(1) }),
    label: "accepting the dispute",
    approval: "required",
    guards: ["amount_cap"],
    amountInr: disputeAmount,
    async run({ a, kase }, x) {
      return asRecord(await a.razorpay(kase.merchant_id).acceptDispute(x.dispute_id));
    },
  }),

  // The subscription's own pending invoice, ready to send; never a fresh link.
  pay_pending_invoice: def({
    args: subscriptionArgs,
    label: "the pending invoice",
    approval: "none",
    guards: [],
    async run({ a, kase }, x) {
      const inv = await a.razorpay(kase.merchant_id).fetchPendingInvoice(x.subscription_id);
      if (!inv || inv.status !== "issued") throw new Error(`Subscription ${x.subscription_id} has no pending invoice`);
      return { invoice_id: inv.id, subscription_id: x.subscription_id, short_url: inv.short_url, amount: inv.amount };
    },
  }),

  pause_subscription: def({
    args: subscriptionArgs,
    label: "pausing the subscription",
    approval: "required",
    guards: ["amount_cap"],
    amountInr: subscriptionAmount,
    async run({ a, kase }, x) {
      return asRecord(await a.razorpay(kase.merchant_id).pauseSubscription(x.subscription_id));
    },
  }),

  resume_subscription: def({
    args: subscriptionArgs,
    label: "resuming the subscription",
    approval: "required",
    guards: ["amount_cap"],
    amountInr: subscriptionAmount,
    async run({ a, kase }, x) {
      return asRecord(await a.razorpay(kase.merchant_id).resumeSubscription(x.subscription_id));
    },
  }),

  cancel_subscription: def({
    args: subscriptionArgs,
    label: "cancelling the subscription",
    approval: "required",
    guards: ["amount_cap"],
    amountInr: subscriptionAmount,
    async run({ a, kase }, x) {
      return asRecord(await a.razorpay(kase.merchant_id).cancelSubscription(x.subscription_id));
    },
  }),

  // Posts a bank credit against invoices in the books (simulated
  // Bookkeeping Agent), with undo. Sure posts; anything less needs a tap.
  post_match: def({
    args: postMatchArgs,
    label: "posting the payment to the books",
    approval: "unless_sure",
    guards: ["amount_cap"],
    async amountInr({ a }, x) {
      return createRepository(a.db).bankCredits.get(x.credit_id)?.amount ?? null;
    },
    async run({ a, kase }, x) {
      const repo = createRepository(a.db);
      const credit = repo.bankCredits.get(x.credit_id);
      if (!credit || credit.merchant_id !== kase.merchant_id) throw new Error(`Bank credit ${x.credit_id} not found`);
      if (credit.matched_invoices.length) throw new Error(`Bank credit ${x.credit_id} is already matched`);
      const total = x.allocations.reduce((n, al) => n + al.amount, 0);
      if (total > credit.amount) throw new Error("Allocations add up to more than the credit");
      const invoices = x.allocations.map((al) => {
        const inv = repo.invoices.get(al.invoice_id);
        if (!inv || inv.merchant_id !== kase.merchant_id) throw new Error(`Invoice ${al.invoice_id} not found`);
        if (inv.amount - inv.paid_amount < al.amount) throw new Error(`Invoice ${inv.number} has less than that left to pay`);
        return { inv, amount: al.amount };
      });
      a.db.transaction(() => {
        for (const { inv, amount } of invoices) {
          const paid = inv.paid_amount + amount;
          repo.invoices.update(inv.id, { paid_amount: paid, status: paid >= inv.amount ? "paid" : "partly_paid" });
        }
        repo.bankCredits.update(credit.id, { matched_invoices: invoices.map((i) => i.inv.id) });
      });
      return { credit_id: credit.id, posted: x.allocations, simulated: true };
    },
    async undo({ a }, x) {
      const repo = createRepository(a.db);
      a.db.transaction(() => {
        for (const al of x.allocations) {
          const inv = repo.invoices.get(al.invoice_id)!;
          const paid = inv.paid_amount - al.amount;
          repo.invoices.update(inv.id, { paid_amount: paid, status: paid <= 0 ? "open" : "partly_paid" });
        }
        a.db.update(s.bankCredits).set({ matched_invoices: [] }).where(eq(s.bankCredits.id, x.credit_id)).run();
      });
      return { credit_id: x.credit_id, reversed: x.allocations };
    },
  }),

  // A drafted request (limit, currency or details change) recorded on the
  // case for the merchant to approve and send. Nothing is filed.
  draft_request: def({
    args: z.object({
      request: z.enum(["international_limit", "currency_enable", "network_enable", "billing_details", "other"]),
      text: z.string().min(1),
      evidence_refs: z.array(z.string()).default([]),
    }),
    label: "drafting the request",
    approval: "none",
    guards: [],
    async run(_ctx, x) {
      return { request: x.request, text: x.text, evidence_refs: x.evidence_refs, status: "drafted", simulated: true };
    },
  }),
};

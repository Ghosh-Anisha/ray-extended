// The act tools. Each one is a typed args schema, the guards it needs and
// the adapter call that does it. Only src/guards imports this file: every
// act goes through guardedCall, never straight here (a test checks).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Adapters } from "@/adapters";
import { CHANNELS, SENDER_MODES } from "@/db/schema";
import * as s from "@/db/schema";
import { createRepository } from "@/db/repository";
import { contestInput, EVIDENCE_TYPES, REFUND_SPEEDS } from "@/adapters/razorpay";
import { merchantCallNumber, OUTCOME_LABEL } from "@/adapters/voice";
import { newId } from "@/adapters/ids";
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
  "confirmation",
  "refund_hold",
  "call_rules",
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
  // A function when it depends on the args (send_message, by kind).
  approval: ApprovalNeed | ((args: A) => ApprovalNeed);
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

export type ApprovalNeed = "required" | "unless_sure" | "none";

export const needsApproval = (spec: ActToolSpec, args: unknown): ApprovalNeed =>
  typeof spec.approval === "function" ? spec.approval(args) : spec.approval;

export const REFUND_HOLD_MS = 10 * 60 * 1000;

// Every message says what kind it is, and the kind decides whether it needs
// the merchant's tap (or an approved rule) before it goes out.
export const MESSAGE_APPROVAL = {
  // Runs alone.
  promise_line: "none", // "We can see your ₹1,299. You'll hear from us by ..." before the tap
  holding: "none", // the promised time passed and the merchant hasn't tapped
  status: "none", // where things stand, answering the customer
  resend_confirmation: "none", // resending a confirmation the store already sent
  before_due_reminder: "none", // Collect, 3 days before due
  gentle_reminder: "none", // Collect, due + 3
  recovery_link: "none", // international F, subscription A and B
  question: "none", // the one question; the only kind allowed on an Unsure case
  auto_customer: "none", // only while the playbook has automatic customer messages on
  // A tap or an approved rule.
  firm_reminder: "required",
  msme_notice: "required",
  dispute_outreach: "required",
  didnt_authorise_reply: "required",
  refund_confirmation: "required",
  fulfil_confirmation: "required",
} as const satisfies Record<string, ApprovalNeed>;
export type MessageKind = keyof typeof MESSAGE_APPROVAL;
export const MESSAGE_KINDS = Object.keys(MESSAGE_APPROVAL) as MessageKind[];

// Confirmation kinds name the action they confirm; it must have run and
// been checked first (never during a refund hold).
export const CONFIRMS: Partial<Record<MessageKind, readonly string[]>> = {
  refund_confirmation: ["refund"],
  fulfil_confirmation: ["mark_paid", "restore_order", "create_order_for_payment"],
};

// Every call says what kind it is (design language section 5). The kind
// decides the moment it belongs to and whether it needs a tap or a rule.
export const CALL_KINDS = {
  // Paid, no order: text first; a call only if no reply by the promised time.
  paid_no_order_follow_up: { moment: "paid_no_order", approval: "none" },
  // Subscription stopped: one call with the playbook's save offer.
  subscription_save: { moment: "subscription", approval: "required" },
  // Invoice overdue, the Call stage: after the merchant's tap.
  collect_call: { moment: "collect", approval: "required" },
  // The day before a chargeback deadline, to the merchant who opted in.
  urgent_merchant: { moment: "chargeback", approval: "none" },
} as const satisfies Record<string, { moment: s.Moment; approval: ApprovalNeed }>;
export type CallKind = keyof typeof CALL_KINDS;
export const CALL_KIND_NAMES = Object.keys(CALL_KINDS) as CallKind[];

// The playbook setting automatic customer messages need.
export const AUTO_CUSTOMER_MESSAGES = "auto_customer_messages";

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
    // speed: the merchant's default, or optimum when they tap "Make it instant".
    args: z.object({ payment_id: paymentId, amount: z.number().int().positive(), speed: z.enum(REFUND_SPEEDS).default("normal"), ...fulfil }),
    label: "the refund",
    approval: "required",
    guards: ["match", "one_refund", "pre_action", "amount_cap", "refund_hold"],
    holdMs: REFUND_HOLD_MS,
    paymentId: (x) => x.payment_id,
    amountInr: ({ a, kase }, x) => paymentInr(a, kase, x.payment_id, x.amount),
    async run({ a, kase, idempotencyKey }, x) {
      return asRecord(
        await a.razorpay(kase.merchant_id).refund(x.payment_id, { amount: x.amount, receipt: idempotencyKey, speed: x.speed, notes: { case_id: kase.id } }),
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

  // The kind decides the approval (MESSAGE_APPROVAL). Only a question may
  // go out on an Unsure case.
  send_message: def({
    args: z
      .object({
        channel: z.enum(CHANNELS),
        to: z.string().min(3),
        sender_mode: z.enum(SENDER_MODES),
        kind: z.enum(MESSAGE_KINDS as [MessageKind, ...MessageKind[]]),
        body: z.string().min(1).optional(),
        template_id: z.string().optional(),
        params: z.record(z.string(), z.string()).optional(),
        // For refund_confirmation and fulfil_confirmation: the action confirmed.
        confirms_action_id: z.string().optional(),
      })
      .refine((v) => (v.body === undefined) !== (v.template_id === undefined), "Give either a body or a template_id"),
    label: "the message",
    approval: (x) => MESSAGE_APPROVAL[x.kind],
    guards: ["channel_rules", "consent", "first_message", "grounding", "confirmation"],
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

  // The subscription's own pending invoice link, ready to send; never a
  // fresh link. It only reads (Razorpay's fetch-invoices call): nothing is
  // charged, the subscriber pays through the link. So it runs alone.
  pay_pending_invoice: def({
    args: subscriptionArgs,
    label: "the pending invoice",
    approval: "none",
    guards: [],
    async run({ a, kase }, x) {
      const inv = await a.razorpay(kase.merchant_id).fetchPendingInvoice(x.subscription_id);
      if (!inv || inv.status !== "issued") throw new Error(`Subscription ${x.subscription_id} has no pending invoice`);
      if (inv.subscription_id !== x.subscription_id) throw new Error(`Invoice ${inv.id} isn't this subscription's own`);
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
  // A Simulated call (ElevenLabs) from the merchant's own number. The
  // call_rules guard checks every call rule first. The post-call summary
  // goes on the case for decide to read; "don't call" records an opt-out.
  place_call: def({
    args: z.object({
      kind: z.enum(CALL_KIND_NAMES as [CallKind, ...CallKind[]]),
      // The number called. The urgent call goes to the merchant's own phone.
      to: z.string().min(3),
      // Opens as the merchant: who is calling and why.
      opening: z.string().min(1).max(300),
      lines: z.array(z.string().min(1).max(300)).max(6).default([]),
    }),
    label: "the call",
    approval: (x) => CALL_KINDS[x.kind].approval,
    guards: ["call_rules", "grounding"],
    async run({ a, kase }, x) {
      const repo = createRepository(a.db);
      const merchant = repo.merchants.get(kase.merchant_id)!;
      const urgent = x.kind === "urgent_merchant";
      const customer = urgent
        ? undefined
        : a.db.select().from(s.customers).where(and(eq(s.customers.merchant_id, kase.merchant_id), eq(s.customers.phone, x.to))).get();
      const call = await a.voice.call({
        merchantId: kase.merchant_id,
        caseId: kase.id,
        to: x.to,
        calleeName: urgent ? merchant.name : (customer?.name ?? x.to),
        from: merchantCallNumber(kase.merchant_id),
        callerName: urgent ? "RAY" : merchant.name,
        opening: x.opening,
        lines: x.lines,
      });
      // "Don't call": stop and record the opt-out.
      let optedOut = false;
      if (call.outcome === "asked_not_to_call") {
        if (customer) a.messaging.setConsent(customer.id, "call", "opted_out", "asked not to be called on a call");
        if (urgent) repo.merchants.update(merchant.id, { urgent_call_opt_in: false });
        optedOut = true;
      }
      repo.caseEvents.insert({
        id: newId("cev"),
        case_id: kase.id,
        at: a.clock.now(),
        type: "note",
        payload: {
          kind: "call_summary",
          call_kind: x.kind,
          simulated: true,
          message_id: call.messageId,
          outcome: call.outcome,
          outcome_label: OUTCOME_LABEL[call.outcome],
          duration_s: call.durationS,
          promise: call.promise,
          summary: call.summary,
          transcript: call.transcript,
          audio: call.audio,
          audio_error: call.audioError,
          opted_out: optedOut,
        },
        evidence_ref: call.messageId,
      });
      return { message_id: call.messageId, outcome: call.outcome, duration_s: call.durationS, promise: call.promise, summary: call.summary, opted_out: optedOut };
    },
  }),

  draft_request: def({
    args: z.object({
      // risk_review: a review ticket to Razorpay's risk desk (Step 8 E).
      // invoice_attach: the invoice attached to a bank transfer so its
      // settlement isn't held (Step 8). Both Simulated.
      request: z.enum(["international_limit", "currency_enable", "network_enable", "billing_details", "other", "risk_review", "invoice_attach"]),
      text: z.string().min(1),
      evidence_refs: z.array(z.string()).default([]),
    }),
    label: "drafting the request",
    approval: "none",
    guards: [],
    async run(_ctx, x) {
      const status = x.request === "risk_review" ? "filed" : x.request === "invoice_attach" ? "attached" : "drafted";
      return { request: x.request, text: x.text, evidence_refs: x.evidence_refs, status, simulated: true };
    },
  }),
};

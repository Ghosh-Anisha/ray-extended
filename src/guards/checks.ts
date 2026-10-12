// One function per guard in Step 5's table. Each returns the failures it
// found, with a reason in plain words for the merchant (no technical terms,
// see design language section 1). guardedCall runs every check that applies
// and collects all failures, not just the first.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { WHATSAPP_TEMPLATES, WINDOW_MS, renderTemplate, sameChannel, type Channel } from "@/adapters/messaging";
import { firstNameOf, merchantPhone } from "@/adapters/voice";
import { RazorpayError, sameContact, syncRecentPayments, type Payment } from "@/adapters/razorpay";
import { ORDER_TOTAL_MISMATCH } from "@/adapters/order-for-payment";
import { StoreError, type StoreOrder } from "@/adapters/store";
import { bannedWordsIn, factNumbers, hasLink, ungroundedNumbers } from "@/ai/grounding";
import type { Repository } from "@/db/repository";
import * as s from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/engine/events";
import type { Approval, ProposedAction } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { normalise } from "@/ai/key";
import { AUTO_CUSTOMER_MESSAGES, CALL_KINDS, CONFIRMS, needsApproval, type ActToolSpec, type CallKind, type GuardName, type MatchClaim, type MessageKind } from "@/tools/act";
import type { ActToolName } from "@/tools/names";
import { caseFacts } from "./facts";
import { formatDate, formatMoney, formatTime, last4 } from "./format";
import { killSwitchOn } from "./kill-switch";

export const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

export type Failure = { guard: GuardName; code: string; reason: string; details?: Record<string, unknown> };

export type GuardContext = {
  a: Adapters;
  repo: Repository;
  kase: Case;
  merchant: typeof s.merchants.$inferSelect;
  tool: ActToolName;
  spec: ActToolSpec;
  args: Record<string, unknown>;
  approval?: Approval;
  idempotencyKey: string;
  now: number;
  payment(): Promise<Payment | null>;
  storeOrder(): Promise<StoreOrder | null | "unreachable">;
};

const fail = (guard: GuardName, code: string, reason: string, details?: Record<string, unknown>): Failure => ({ guard, code, reason, details });
const short = (id: string) => `${id.slice(0, 7)}…`;
const money = (p: Pick<Payment, "amount" | "currency">) => formatMoney(p.amount, p.currency);

// The case already knows this record: it is the case's payment, or the
// timeline cites it.
export function caseKnows(g: Pick<GuardContext, "repo" | "kase">, id: string) {
  if (g.kase.payment_id === id || g.kase.store_order_id === id) return true;
  return g.repo.caseEvents.listByCase(g.kase.id).some((e) => e.evidence_ref === id || JSON.stringify(e.payload).includes(id));
}

const FULFIL: readonly ActToolName[] = ["mark_paid", "restore_order", "create_order_for_payment"];

// ---- Kill switch: blocks every act tool; reads still work.
export async function killSwitch(g: GuardContext): Promise<Failure[]> {
  const on = killSwitchOn(g.a.db, g.kase.merchant_id);
  if (on === "merchant") return [fail("kill_switch", "merchant", "RAY's actions are paused for this account. Reading still works.")];
  if (on === "global") return [fail("kill_switch", "global", "RAY's actions are paused for every account right now. Reading still works.")];
  return [];
}

// ---- Confidence: nothing runs on Unsure. Unsure may only ask its question.
export async function confidence(g: GuardContext): Promise<Failure[]> {
  if (g.kase.confidence !== "unsure") return [];
  if (g.tool === "send_message" && g.args.kind === "question") return [];
  return [fail("confidence", "unsure", "RAY isn't sure yet, so it asks instead of acting.")];
}

// ---- Approval: a tap from the merchant on a proposal for this action, or
// an approved playbook rule for this merchant and moment.
export async function approval(g: GuardContext): Promise<Failure[]> {
  const need = needsApproval(g.spec, g.args);
  if (need === "none") return autoMessages(g);
  const ap = g.approval;
  if (!ap) {
    if (need === "unless_sure" && g.kase.confidence === "sure") return [];
    return [fail("approval", "missing", `This needs your tap before RAY can do it.${await captureTimeLeft(g)}`)];
  }
  if (ap.by === "rule") {
    const rule = g.repo.playbookRules.get(ap.ruleId);
    const ok =
      rule &&
      rule.status === "approved" &&
      rule.merchant_id === g.kase.merchant_id &&
      rule.moment === g.kase.moment &&
      (rule.rule_json.tool === undefined || rule.rule_json.tool === g.tool) &&
      (rule.rule_json.kind === undefined || rule.rule_json.kind === g.args.kind);
    return ok ? [] : [fail("approval", "rule_not_approved", "That rule isn't approved for this, so this needs your tap.", { rule_id: ap.ruleId })];
  }
  const ev = g.repo.caseEvents.get(ap.evidenceRef);
  const tapped =
    ev && ev.case_id === g.kase.id && ev.type === "approval" && ev.payload.choice === "approve" && ev.payload.proposalId === ap.tap.proposalId;
  if (!tapped) return [fail("approval", "tap_not_found", "RAY can't find your tap for this on the case.", { evidence_ref: ap.evidenceRef })];
  const proposal = g.repo.caseEvents
    .listByCase(g.kase.id)
    .filter((e) => e.payload.kind === "actions_proposed")
    .flatMap((e) => e.payload.actions as ProposedAction[])
    .findLast((p) => p.id === ap.tap.proposalId);
  // The tapped proposal, or one of the follow-ups it listed (the
  // confirmation the card showed as its draft), same tool and same args.
  const sameAs = (x: { tool: string; args: Record<string, unknown> }) =>
    x.tool === g.tool && Object.entries(x.args).every(([k, v]) => JSON.stringify(normalise(v)) === JSON.stringify(normalise(g.args[k])));
  if (!proposal || !(sameAs(proposal) || (proposal.followUps ?? []).some(sameAs))) {
    return [fail("approval", "different_action", "You approved a different action, so this needs your tap.", { proposal_id: ap.tap.proposalId })];
  }
  return [];
}

// Razorpay refunds an authorised payment that isn't captured in time (5 days
// by default). Without the capture rule, the merchant is asked with the time left.
export const CAPTURE_TIMEOUT_MS = 5 * 24 * 60 * 60 * 1000;

async function captureTimeLeft(g: GuardContext): Promise<string> {
  if (g.tool !== "capture") return "";
  const p = await g.payment();
  if (!p || p.status !== "authorized") return "";
  const left = p.created_at + CAPTURE_TIMEOUT_MS - g.now;
  if (left <= 0) return " The time to capture it has run out.";
  const days = Math.floor(left / 86_400_000);
  const hours = Math.floor((left % 86_400_000) / 3_600_000);
  const mins = Math.floor((left % 3_600_000) / 60_000);
  const parts = days ? [`${days} day${days > 1 ? "s" : ""}`, `${hours} hr`] : hours ? [`${hours} hr`, `${mins} min`] : [`${mins} min`];
  return ` ${parts.join(" ")} left to capture ${money(p)} before Razorpay refunds it.`;
}

// Automatic customer messages go out alone only while the playbook has them on.
function autoMessages(g: GuardContext): Failure[] {
  if (g.tool !== "send_message" || g.args.kind !== "auto_customer") return [];
  const on = g.repo.playbookRules
    .list(and(eq(s.playbookRules.merchant_id, g.kase.merchant_id), eq(s.playbookRules.status, "approved")))
    .some((r) => r.rule_json.setting === AUTO_CUSTOMER_MESSAGES && r.rule_json.on === true && (!r.moment || r.moment === g.kase.moment));
  return on ? [] : [fail("approval", "auto_messages_off", "Automatic customer messages are off in your playbook, so this needs your tap.")];
}

// ---- Amount cap: without a tap, nothing above the merchant's approval limit.
export async function amountCap(g: GuardContext): Promise<Failure[]> {
  if (g.approval?.by === "tap" || !g.spec.amountInr) return [];
  const amount = await g.spec.amountInr({ a: g.a, kase: g.kase }, g.args);
  if (amount === null || amount <= g.merchant.approval_limit) return [];
  return [
    fail(
      "amount_cap",
      "above_limit",
      `${formatMoney(amount)} is above your approval limit of ${formatMoney(g.merchant.approval_limit)}, so this needs your tap.`,
      { amount, approval_limit: g.merchant.approval_limit },
    ),
  ];
}

// ---- Match: against Razorpay's own payment record. A customer's claim
// must match it by exact UTR, else contact + amount within ±2 hours. A
// screenshot alone never counts, and a near-match is never acted on.
export async function match(g: GuardContext): Promise<Failure[]> {
  const id = g.spec.paymentId?.(g.args);
  if (!id) return [];
  const p = await g.payment();
  if (!p) return [fail("match", "no_payment", `Razorpay has no payment ${short(id)} on your account.`)];
  const out: Failure[] = [];
  const expected = g.tool === "capture" ? "authorized" : "captured";
  if (p.status !== expected) out.push(fail("match", "status", `Razorpay shows this payment as ${p.status}, not ${expected}.`, { status: p.status }));
  if (!caseKnows(g, p.id)) out.push(fail("match", "not_on_case", "This payment isn't part of this case."));

  if (g.spec.storeOrderId?.(g.args)) {
    const o = await g.storeOrder();
    if (o === "unreachable") out.push(fail("match", "store_unreachable", "Couldn't reach your store to check the order."));
    else if (!o) out.push(fail("match", "no_order", "Couldn't find that order in your store."));
    else {
      const linked = o.payment_id === p.id || (!!o.razorpay_order_id && o.razorpay_order_id === p.order_id);
      if (!linked) out.push(fail("match", "order_not_linked", `Order ${o.number} isn't linked to this payment.`));
      if (o.total !== p.amount) {
        out.push(fail("match", "order_amount", `Order ${o.number} is ${formatMoney(o.total)} but the payment is ${money(p)}.`));
      }
    }
  }

  const claim = g.args.match as MatchClaim | undefined;
  if (claim) out.push(...(await checkClaim(g, p, claim)));
  return out;
}

async function checkClaim(g: GuardContext, p: Payment, claim: MatchClaim): Promise<Failure[]> {
  const out: Failure[] = [];
  if (claim.utr) {
    if (claim.utr.trim() !== p.utr) out.push(fail("match", "utr_mismatch", "The UTR the customer gave doesn't match Razorpay's record."));
  } else if (claim.contact && claim.amount !== undefined && claim.at !== undefined) {
    const near =
      !sameContact(p, { contact: claim.contact, email: claim.contact }) ||
      claim.amount !== p.amount ||
      Math.abs(claim.at - p.created_at) > MATCH_WINDOW_MS;
    if (near) out.push(fail("match", "near_match", "The customer's details are close to this payment but don't match it, so RAY will ask instead."));
    else {
      const others = g.repo.rzpPayments
        .list(and(eq(s.rzpPayments.merchant_id, g.kase.merchant_id), eq(s.rzpPayments.amount, claim.amount), eq(s.rzpPayments.status, "captured")))
        .filter((o) => o.id !== p.id && sameContact(o, { contact: claim.contact, email: claim.contact }) && Math.abs(claim.at! - o.created_at) <= MATCH_WINDOW_MS);
      if (others.length) out.push(fail("match", "two_matches", "Two payments could match.", { payment_ids: [p.id, ...others.map((o) => o.id)] }));
    }
  } else {
    out.push(fail("match", "claim_alone", "A screenshot or UTR alone isn't enough. RAY needs it to match Razorpay's own record."));
  }

  // Sender isn't the checkout contact: confirm through the checkout contact first.
  const fromCheckout = (addr: unknown) =>
    typeof addr === "string" &&
    ((!!p.contact && normalizePhone(addr) === normalizePhone(p.contact)) || (!!p.email && normalizeEmail(addr) === normalizeEmail(p.email)));
  if (!fromCheckout(claim.sender)) {
    const ev = claim.checkout_confirmation_event_id ? g.repo.caseEvents.get(claim.checkout_confirmation_event_id) : undefined;
    const confirmed = ev && ev.case_id === g.kase.id && ev.type === "message_in" && fromCheckout(ev.payload.from);
    if (!confirmed) {
      out.push(fail("match", "sender_not_checkout", "The message came from a different contact than the one used at checkout. RAY needs to confirm with the checkout contact first."));
    }
  }
  return out;
}

// ---- One refund per payment: the receipt is the idempotency key; a second
// refund or an over-refund is refused.
export async function oneRefund(g: GuardContext): Promise<Failure[]> {
  const p = await g.payment();
  if (!p) return [];
  const out: Failure[] = [];
  const refunds = (await g.a.razorpay(g.kase.merchant_id).listRefunds(p.id)).filter((r) => r.status !== "failed" && r.receipt !== g.idempotencyKey);
  if (refunds.length) out.push(fail("one_refund", "already_refunded", "This payment already has a refund.", { refund_ids: refunds.map((r) => r.id) }));
  if (liveRefundActions(g.repo, p.id, g.idempotencyKey).length) {
    out.push(fail("one_refund", "refund_pending", "A refund for this payment is already on hold or done."));
  }
  const amount = g.args.amount as number;
  if (amount > p.amount - p.amount_refunded) out.push(fail("one_refund", "over_refund", "That's more than what's left on this payment."));
  return out;
}

export function liveRefundActions(repo: Repository, paymentId: string, exceptKey: string) {
  return repo.actions
    .list(and(eq(s.actions.tool, "refund"), inArray(s.actions.status, ["held", "done"])))
    .filter((x) => x.args.payment_id === paymentId && x.idempotency_key !== exceptKey);
}

// ---- Pre-action check, right before acting: the order is still unpaid, no
// newer payment from the same contact, no open dispute or bank complaint.
export const BANK_COMPLAINT = "bank_complaint";

export async function preAction(g: GuardContext): Promise<Failure[]> {
  const p = await g.payment();
  if (!p) return [];
  const out: Failure[] = [];
  const full = FULFIL.includes(g.tool) || g.tool === "capture" || (g.tool === "refund" && g.kase.moment === "paid_no_order");
  const rzp = g.a.razorpay(g.kase.merchant_id);

  if (full) {
    // Order still unpaid.
    if (g.tool === "mark_paid" || g.tool === "restore_order") {
      const o = await g.storeOrder();
      if (o && o !== "unreachable") {
        if (g.tool === "mark_paid" && (o.status !== "pending" || o.payment_id)) out.push(fail("pre_action", "order_paid", `Order ${o.number} is already ${o.status}.`));
        if (g.tool === "restore_order" && o.status !== "cancelled") out.push(fail("pre_action", "order_not_cancelled", `Order ${o.number} isn't cancelled, so there's nothing to restore.`));
      }
    }
    if (g.tool === "create_order_for_payment" || g.tool === "refund") {
      const existing = g.a.store.hasStore(g.kase.merchant_id) ? await g.a.store.getOrder(g.kase.merchant_id, { paymentId: p.id }).catch(() => null) : null;
      if (existing && g.tool === "create_order_for_payment") out.push(fail("pre_action", "order_exists", `Order ${existing.number} already exists for this payment.`));
      if (existing && g.tool === "refund" && ["processing", "completed"].includes(existing.status)) {
        out.push(fail("pre_action", "order_fulfilled", `Order ${existing.number} was already fulfilled with this payment.`));
      }
    }

    // No newer payment from the same contact the case doesn't know about.
    // The mirror is synced with Razorpay first, so a pay-again link on
    // another order shows up in test mode too.
    await syncRecentPayments(g.a.db, rzp, g.kase.merchant_id, { now: g.now, contact: p.contact, email: p.email });
    const newer = g.repo.rzpPayments
      .list(and(eq(s.rzpPayments.merchant_id, g.kase.merchant_id), inArray(s.rzpPayments.status, ["captured", "authorized"])))
      .filter((o) => o.id !== p.id && o.created_at > p.created_at && sameContact(o, p) && !caseKnows(g, o.id))
      .sort((x, y) => x.created_at - y.created_at);
    for (const n of newer) {
      out.push(
        fail("pre_action", "newer_payment", `The same customer paid ${money(n)} again at ${formatTime(n.created_at)} on ${formatDate(n.created_at)}. Check that before RAY acts.`, {
          payment_id: n.id,
        }),
      );
    }
  }

  const disputes = (await rzp.listDisputes({ paymentId: p.id })).filter((d) => ["open", "under_review"].includes(d.status));
  if (disputes.length) out.push(fail("pre_action", "open_dispute", "There's an open chargeback on this payment.", { dispute_ids: disputes.map((d) => d.id) }));

  const complaint = g.a.db
    .select({ id: s.caseEvents.id })
    .from(s.caseEvents)
    .innerJoin(s.cases, eq(s.cases.id, s.caseEvents.case_id))
    .where(
      and(
        eq(s.cases.merchant_id, g.kase.merchant_id),
        sql`json_extract(${s.caseEvents.payload}, '$.kind') = ${BANK_COMPLAINT}`,
        sql`(${s.caseEvents.evidence_ref} = ${p.id} or json_extract(${s.caseEvents.payload}, '$.payment_id') = ${p.id})`,
      ),
    )
    .get();
  if (complaint) out.push(fail("pre_action", "bank_complaint", "There's a bank complaint on this payment."));
  return out;
}

// ---- Order total: an order created for a payment totals the captured amount.

export async function orderTotal(g: GuardContext): Promise<Failure[]> {
  const p = await g.payment();
  if (!p) return [];
  const items = g.args.items as { name: string; qty: number }[];
  let total = 0;
  for (const it of items) {
    const prod = g.a.db
      .select()
      .from(s.products)
      .where(and(eq(s.products.merchant_id, g.kase.merchant_id), eq(s.products.name, it.name)))
      .get();
    if (!prod) return [fail("order_total", "unknown_product", `${it.name} isn't one of your store's products.`)];
    total += prod.price * it.qty;
  }
  if (total === p.amount) return [];
  return [
    fail("order_total", ORDER_TOTAL_MISMATCH, `Line items add up to ${formatMoney(total)}, but the payment is ${money(p)}. Order not created.`, {
      payment_id: p.id,
      payment_amount: p.amount,
      line_items_total: total,
      items,
    }),
  ];
}

// ---- Messages: the shared lookups.
const messageBody = (args: Record<string, unknown>) => {
  if (typeof args.body === "string") return args.body;
  // A call's script: everything RAY will say.
  if (typeof args.opening === "string") return [args.opening, ...((args.lines as string[] | undefined) ?? [])].join("\n");
  try {
    return renderTemplate(args.template_id as string, args.params as Record<string, string>);
  } catch {
    return "";
  }
};

// The customer wrote on this channel in the last 24 hours, so this is a reply.
function replying(g: GuardContext) {
  return g.a.messaging
    .thread(g.kase.merchant_id, g.args.to as string)
    .some((m) => m.direction === "in" && sameChannel(g.args.channel as string).includes(m.channel) && m.at <= g.now && m.at > g.now - WINDOW_MS);
}

function recipient(g: GuardContext) {
  const to = g.args.to as string;
  const col = g.args.channel === "whatsapp" ? s.customers.phone : s.customers.email;
  return g.a.db.select().from(s.customers).where(and(eq(s.customers.merchant_id, g.kase.merchant_id), eq(col, to))).get();
}

// ---- Channel rules: WhatsApp template and 24-hour window.
export async function channelRules(g: GuardContext): Promise<Failure[]> {
  const out: Failure[] = [];
  if (g.args.channel === "email") {
    if (g.args.template_id) out.push(fail("channel_rules", "email_template", "Templates are for WhatsApp; an email needs a written message."));
    return out;
  }
  if (!g.merchant.whatsapp_on) out.push(fail("channel_rules", "whatsapp_off", "WhatsApp is off for this account."));
  if (g.args.sender_mode === "verified_domain") out.push(fail("channel_rules", "sender_mode", "WhatsApp can't send from your email domain."));
  if (!replying(g)) {
    const id = g.args.template_id as string | undefined;
    if (!id) out.push(fail("channel_rules", "window_closed", "It's been more than 24 hours since the customer's last WhatsApp message, so only an approved template can go out."));
    else if (WHATSAPP_TEMPLATES[id]?.status !== "approved") out.push(fail("channel_rules", "template_not_approved", `The ${id} template isn't approved for WhatsApp.`));
  }
  return out;
}

// ---- Consent: an opt-out, or no WhatsApp opt-in, blocks proactive messages.
export async function consent(g: GuardContext): Promise<Failure[]> {
  if (replying(g)) return [];
  const channel = g.args.channel as Channel;
  const who = recipient(g);
  const status = who ? g.a.messaging.consent(who.id, channel) : null;
  const name = who?.name ?? "This person";
  const label = channel === "whatsapp" ? "WhatsApp" : "email";
  if (status === "opted_out") return [fail("consent", "opted_out", `${name} opted out of ${label} messages.`)];
  if (channel === "whatsapp" && status !== "opted_in") return [fail("consent", "no_opt_in", `${name} hasn't opted in to WhatsApp messages.`)];
  return [];
}

// ---- First message (rule 7). About a payment the customer may think went
// wrong (paid-no-order, refunds, disputes): the first message has checkable
// details (amount, time, last 4 of the UTR) and no link. Any message with a
// link (recovery messages) may only carry a Razorpay-hosted link in the
// merchant's name, never alone, with the merchant, the amount and what it's for.
const URL = /https?:\/\/[^\s)]+|www\.[^\s)]+/gi;
const TIME_OR_DATE = /\b\d{1,2}:\d{2}\s?(?:AM|PM)\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i;

const mentionsAmount = (text: string, minor: number, currency: string) => {
  const said = factNumbers(text);
  const shown = [...factNumbers(formatMoney(minor, currency))];
  return said.has(String(minor / 100)) || (shown.length > 0 && shown.every((n) => said.has(n)));
};

export function paymentWorry(g: Pick<GuardContext, "repo" | "kase">) {
  if (g.kase.moment === "paid_no_order" || g.kase.moment === "chargeback") return true;
  return g.repo.actions.list(and(eq(s.actions.case_id, g.kase.id), eq(s.actions.tool, "refund"))).length > 0;
}

export async function firstMessage(g: GuardContext): Promise<Failure[]> {
  const body = messageBody(g.args);
  const out: Failure[] = [];
  const p = await g.payment();
  const amount = p ? { minor: p.amount, currency: p.currency } : g.kase.amount ? { minor: g.kase.amount, currency: "INR" } : null;
  const first = recipient(g) && !g.a.messaging.thread(g.kase.merchant_id, g.args.to as string).some((m) => m.direction === "out");

  if (first && paymentWorry(g)) {
    if (hasLink(body.replace(/\S+@\S+/g, ""))) out.push(fail("first_message", "link", "A first message about a payment can't carry a link."));
    const missing: string[] = [];
    if (amount && !mentionsAmount(body, amount.minor, amount.currency)) missing.push("the amount");
    if (!TIME_OR_DATE.test(body)) missing.push("the time");
    if (p?.utr && !body.includes(last4(p.utr))) missing.push("the last 4 of the UTR");
    if (missing.length) out.push(fail("first_message", "not_checkable", `A first message about a payment needs ${missing.join(", ")} so the customer can check it.`, { missing }));
    return out;
  }

  const links = body.match(URL) ?? [];
  if (!links.length) return out;
  const hosted = new Set<string>();
  for (const l of g.repo.rzpLinks.list(eq(s.rzpLinks.merchant_id, g.kase.merchant_id))) if (l.short_url) hosted.add(l.short_url);
  for (const x of g.repo.actions.list(and(eq(s.actions.case_id, g.kase.id), eq(s.actions.status, "done")))) {
    if (typeof x.result?.short_url === "string") hosted.add(x.result.short_url);
  }
  const strip = (u: string) => u.replace(/[.,;:!?]+$/, "");
  if (links.some((l) => !hosted.has(strip(l)))) {
    out.push(fail("first_message", "link_not_razorpay", "A link can only be a Razorpay payment link in your name."));
  }
  const rest = body.replace(URL, " ");
  const words = rest.split(/\s+/).filter(Boolean).length;
  const alone = !rest.includes(g.merchant.name) || (amount !== null && !mentionsAmount(rest, amount.minor, amount.currency)) || words < 8;
  if (alone) out.push(fail("first_message", "link_alone", "A link can't go out alone. The message needs your name, the amount and what it's for."));
  return out;
}

// ---- Grounding (rule 6): every number in the message is in the case data.
export async function grounding(g: GuardContext): Promise<Failure[]> {
  const stray = ungroundedNumbers(messageBody(g.args), caseFacts(g.a.db, g.kase.id));
  return stray.length ? [fail("grounding", "ungrounded", `The message has numbers that aren't in the case: ${stray.join(", ")}.`, { numbers: stray })] : [];
}

// ---- Confirmation: a message saying money was refunded or an order is
// confirmed goes out only after that action ran and its result checks out
// (never during the refund hold). Only the confirmation kinds may say so.
const SAYS_DONE = /\brefunded\b|\brefund (?:is|has been|was) (?:processed|issued|sent|done|made)\b|\bconfirmed\b/i;

export async function confirmation(g: GuardContext): Promise<Failure[]> {
  const kind = g.args.kind as MessageKind;
  const tools = CONFIRMS[kind];
  if (!tools) {
    return SAYS_DONE.test(messageBody(g.args))
      ? [fail("confirmation", "says_done", "Only a refund or order confirmation can say it's refunded or confirmed, after RAY has done it and checked.")]
      : [];
  }
  const id = g.args.confirms_action_id as string | undefined;
  const action = id ? g.repo.actions.get(id) : undefined;
  if (!action || action.case_id !== g.kase.id || !tools.includes(action.tool)) {
    return [fail("confirmation", "no_action", "RAY can't find what this message confirms on the case.")];
  }
  if (action.status === "held") return [fail("confirmation", "on_hold", "The refund is still on hold, so it can't be confirmed yet.")];
  if (action.status !== "done") return [fail("confirmation", "not_done", "That hasn't been done, so it can't be confirmed.")];
  if (!(await resultChecksOut(g, action))) return [fail("confirmation", "not_checked", "RAY couldn't check that it went through, so it can't be confirmed yet.")];
  return [];
}

// Reads the result back from the source: the refund at Razorpay, the order in the store.
async function resultChecksOut(g: GuardContext, action: typeof s.actions.$inferSelect): Promise<boolean> {
  const result = action.result ?? {};
  if (action.tool === "refund") {
    const refunds = await g.a.razorpay(g.kase.merchant_id).listRefunds(action.args.payment_id as string);
    return refunds.some((r) => r.id === result.id && r.status !== "failed");
  }
  const order = await g.a.store.getOrder(g.kase.merchant_id, { id: result.id as string }).catch(() => null);
  return !!order && ["processing", "completed"].includes(order.status) && order.payment_id === action.args.payment_id;
}

// ---- Call rules (Step 5b, design language section 5). Every call:
// - only for the moment its kind belongs to; never an international buyer
//   or a chargeback cardholder,
// - only to someone who opted in to calls (the urgent call: a merchant who
//   opted in); an opt-out or no row blocks it,
// - only within the merchant's calling hours (default 10 AM to 7 PM),
// - paid-no-order: only after a text on the case; never a first contact,
// - opens as the merchant with who is calling and why,
// - never asks for a PIN, OTP, card number or password, never reads out a
//   link, never asks the person to pay on the call.
// Calls only come from the merchant's own number: place_call has no other.
const IST_MS = (5 * 60 + 30) * 60_000;
const SECRETS = /\b(?:upi pin|pin|otp|one[- ]time password|card number|card no|cvv|cvc|password|expiry date)\b/i;
const PAY_ON_CALL =
  /\b(?:pay|payment|transfer|send the money)\b[^.?!\n]*\b(?:now|right now|right away|on (?:this|the) call|over the phone|while we're on the call)\b|\b(?:share|tell me|read out|give me)\b[^.?!\n]*\b(?:upi id|card|bank details|account number)\b|\btake (?:the|your) payment\b/i;

export const minutesIst = (ms: number) => Math.floor(((ms + IST_MS) % 86_400_000) / 60_000);
export const clockLabel = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};

function callee(g: GuardContext) {
  const to = g.args.to as string;
  return g.a.db.select().from(s.customers).where(and(eq(s.customers.merchant_id, g.kase.merchant_id), eq(s.customers.phone, to))).get();
}

export async function callRules(g: GuardContext): Promise<Failure[]> {
  const out: Failure[] = [];
  const kind = g.args.kind as CallKind;
  const urgent = kind === "urgent_merchant";
  const to = g.args.to as string;

  // Who RAY may call at all.
  if (g.kase.moment === "international") out.push(fail("call_rules", "not_voice", "RAY doesn't call international buyers. It writes instead."));
  else if (g.kase.moment === "chargeback" && !urgent) out.push(fail("call_rules", "not_voice", "RAY never calls the cardholder on a chargeback. They may not be the buyer."));
  else if (CALL_KINDS[kind].moment !== g.kase.moment) out.push(fail("call_rules", "wrong_moment", "This kind of call isn't for this case."));

  // Opt-in.
  const person = urgent ? undefined : callee(g);
  const name = urgent ? g.merchant.name : (person?.name ?? "This person");
  if (urgent) {
    if (to !== merchantPhone(g.merchant.id)) out.push(fail("call_rules", "wrong_number", "The urgent call only goes to your own number."));
    if (!g.merchant.urgent_call_opt_in) out.push(fail("call_rules", "no_opt_in", "You haven't opted in to an urgent call before a deadline."));
  } else {
    const status = person ? g.a.messaging.consent(person.id, "call") : null;
    if (status === "opted_out") out.push(fail("call_rules", "opted_out", `${name} asked not to be called.`));
    else if (status !== "opted_in") out.push(fail("call_rules", "no_opt_in", `${name} hasn't opted in to calls.`));
  }

  // Calling hours.
  const start = g.merchant.calling_hours_start;
  const end = g.merchant.calling_hours_end;
  const now = minutesIst(g.now);
  if (now < start || now >= end) {
    out.push(
      fail("call_rules", "outside_hours", `Calls only go out between ${clockLabel(start)} and ${clockLabel(end)}, as set in your playbook. It's ${clockLabel(now)} now.`, {
        start,
        end,
        now,
      }),
    );
  }

  // Text first: a call never makes first contact.
  if (!urgent && person) {
    const addresses = [person.phone, person.email].filter((x): x is string => !!x);
    const texts = addresses
      .flatMap((addr) => g.a.messaging.thread(g.kase.merchant_id, addr))
      .filter((m) => m.direction === "out" && (m.channel === "whatsapp" || m.channel === "email") && m.at <= g.now);
    if (g.kase.moment === "paid_no_order") {
      if (!texts.some((m) => m.case_id === g.kase.id)) out.push(fail("call_rules", "no_prior_text", `RAY texts ${firstNameOf(name)} first. A call only follows a text that said one may come.`));
    } else if (!texts.length) {
      out.push(fail("call_rules", "first_contact", `RAY never calls ${firstNameOf(name)} as a first contact. A text goes first.`));
    }
  }

  // The script.
  const opening = g.args.opening as string;
  const script = messageBody(g.args);
  const missing: string[] = [];
  if (urgent) {
    if (!/\bRAY\b/.test(opening)) missing.push("that it's RAY calling");
  } else {
    if (!opening.includes(g.merchant.name)) missing.push(`your name (${g.merchant.name})`);
    if (person && !opening.toLowerCase().includes(firstNameOf(person.name).toLowerCase())) missing.push(`${firstNameOf(person.name)}'s name`);
  }
  const amount = g.kase.amount;
  if (amount && !mentionsAmount(opening, amount, "INR")) missing.push("what it's about (the amount)");
  if (missing.length) out.push(fail("call_rules", "opening", `The call has to open with who is calling and why. It's missing ${missing.join(", ")}.`, { missing }));
  if (SECRETS.test(script)) out.push(fail("call_rules", "asks_secret", "A call never asks for a card number, UPI PIN, OTP or password."));
  if (hasLink(script)) out.push(fail("call_rules", "reads_link", "A call never reads out a link. Links go by text, with details to check."));
  if (PAY_ON_CALL.test(script)) out.push(fail("call_rules", "takes_payment", "A call never asks the person to pay on the call. Anything about money ends as a text and your tap."));
  const internal = bannedWordsIn(script);
  if (internal.length) out.push(fail("call_rules", "internal_words", `The call uses words customers never hear: ${internal.join(", ")}.`));
  return out;
}

// The refund hold isn't a check that can fail; guardedCall holds the action.
export async function refundHold(): Promise<Failure[]> {
  return [];
}

export const CHECKS: Record<GuardName, (g: GuardContext) => Promise<Failure[]>> = {
  kill_switch: killSwitch,
  confidence,
  approval,
  amount_cap: amountCap,
  match,
  one_refund: oneRefund,
  pre_action: preAction,
  order_total: orderTotal,
  channel_rules: channelRules,
  consent,
  first_message: firstMessage,
  grounding,
  confirmation,
  refund_hold: refundHold,
  call_rules: callRules,
};

// The guards that apply to a tool, in the order they run.
// Approval always runs: a tool that runs alone passes it (send_message's
// auto_customer kind still checks the playbook).
export function guardsFor(spec: ActToolSpec): GuardName[] {
  return ["kill_switch", "confidence", "approval", ...spec.guards];
}

// Lazy, memoised reads every check shares.
export function guardContext(base: Omit<GuardContext, "payment" | "storeOrder">): GuardContext {
  let payment: Promise<Payment | null> | undefined;
  let order: Promise<StoreOrder | null | "unreachable"> | undefined;
  const g: GuardContext = {
    ...base,
    payment() {
      const id = base.spec.paymentId?.(base.args) ?? base.kase.payment_id;
      payment ??= id
        ? base.a
            .razorpay(base.kase.merchant_id)
            .fetchPayment(id)
            .catch((e) => {
              if (e instanceof RazorpayError && e.code === "NOT_FOUND") return null;
              throw e;
            })
        : Promise.resolve(null);
      return payment;
    },
    storeOrder() {
      const id = base.spec.storeOrderId?.(base.args);
      order ??= id
        ? base.a.store.getOrder(base.kase.merchant_id, { id }).catch((e) => {
            if (e instanceof StoreError) return e.httpStatus === 404 ? null : ("unreachable" as const);
            throw e;
          })
        : Promise.resolve(null);
      return order;
    },
  };
  return g;
}

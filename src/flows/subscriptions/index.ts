// Moment 3: subscription stopped (build guide Step 9). The Specialist for
// situations A to F. Razorpay's retries and Revenue-Protect stay as they are
// (simulated): RAY starts only after retries run out, and for sign-ups,
// cancellations and messages. Money only moves through guardedCall, after
// a tap, under an approved rule, or (A, B, C, F) through tools that run
// alone and never charge: the subscription's own invoice link and messages.
//
//   A  sign-up never finished        one message with the first invoice's link (runs alone)
//   B  retries ran out                the pending invoice's link, never a fresh one (runs alone);
//                                     a call to subscribers above the merchant's value limit
//   C  mandate cancelled in UPI app   asks once why; payment trouble -> set up again; else D
//   D  "cancel my plan"               one save offer from the playbook, or the merchant picks
//                                     from 2 or 3 options and the pick becomes a proposed rule
//   E  "I didn't authorise this"      evidence pack, drafted reply, refund if allowed or proof
//                                     is weak; the merchant decides
//   F  B2B renewal failed             email the invoice with a bank-transfer option; Collect
//                                     takes it (collect.handoff) if unpaid after 7 days
import { and, eq } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import { firstNameOf } from "@/adapters/voice";
import { canAct, createAi, type Ai } from "@/ai";
import * as s from "@/db/schema";
import { openProposals } from "@/engine/orchestrator";
import {
  PROMISED_TIME_TIMER,
  type Approval,
  type ApprovalResult,
  type EngineContext,
  type Finding,
  type InvestigateResult,
  type ProposedAction,
  type Specialist,
  type TimerRequest,
} from "@/engine/specialist";
import type { EngineEvent } from "@/engine/events";
import type { Case } from "@/engine/state-machine";
import { caseFacts, formatDate, formatMoney, formatTime, guardedCall, type GuardedResult } from "@/guards";
import { clockLabel, minutesIst } from "@/guards/checks";
import { idAliases } from "../shared/stable-ids";
import { adaptersOf, messageArgs, recipientFor, settingsOf, subscriberBy, type Customer, type Recipient } from "./channel";
import { emitCollectHandoff } from "./handoff";
import * as L from "./lines";
import { answerOf, changeTarget, messageKind, OFFER_FOR, reasonOf, refundAllowed, RULE_TOOL, ruleText, rulesFor, type Offer, type Reason } from "./offers";
import { SETUP_EVENT } from "./sweep";

export { setupSweep, SETUP_EVENT, SETUP_WAIT_MS } from "./sweep";
export { COLLECT_HANDOFF, collectHandoff, listCollectHandoffs, type CollectHandoff } from "./handoff";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const NO_RESPONSE_MS = 7 * DAY; // A, B: no payment -> closed as lost
export const HANDOFF_MS = 7 * DAY; // F: unpaid -> Collect
export const NO_REPLY_MS = 72 * HOUR; // C question, D offer, E reply
export const CALL_AFTER_MS = 24 * HOUR; // B: call if still unpaid a day after the link
export const PROMISE_MS = 2 * HOUR;
export const DEFAULT_PAUSE_DAYS = 30;

export const TIMERS = {
  noResponse: "sub_no_response",
  handoff: "sub_collect_handoff",
  noReply: "sub_no_reply",
  offerReply: "sub_offer_reply",
  callCheck: "sub_call_check",
  resume: "sub_resume",
  refund: "sub_refund_check",
  cycleLost: "sub_cycle_lost",
} as const;

// Causes, also shown as the case's cause.
export const CAUSES = {
  setup: "setup_incomplete",
  retrying: "retrying",
  halted: "retries_ran_out",
  b2b: "b2b_renewal_failed",
  token: "mandate_cancelled",
  cancel: "cancel_request",
  didnt: "didnt_authorise",
  duplicate: "duplicate_charge",
} as const;
const WAITS_FOR_PAYMENT: string[] = [CAUSES.setup, CAUSES.halted, CAUSES.b2b, CAUSES.token];

// Flow notes on the timeline (payload.kind).
export const N = {
  situation: "sub_situation",
  contact: "sub_contact",
  reason: "sub_reason",
  question: "sub_question_asked",
  options: "sub_options",
  offer: "sub_offer_made",
  rule: "sub_rule_proposed",
  linkSent: "sub_link_sent",
  waitCycle: "sub_wait_next_cycle",
  paused: "sub_paused",
  call: "sub_call_decided",
  resolution: "sub_resolution",
  evidence: "sub_evidence_pack",
  promise: "sub_promise_sent",
} as const;

type Option = "offer_discount" | "offer_pause" | "offer_other_method" | "cancel" | "call" | "reply_proof" | "refund" | "resend_link" | "pause_now" | "resume";
type Sub = typeof s.subscriptions.$inferSelect;

export type SubscriptionsOptions = { ai?: (ctx: EngineContext) => Ai };

export function createSubscriptionsSpecialist(opts: SubscriptionsOptions = {}): Specialist {
  const aiOf = opts.ai ?? ((ctx: EngineContext) => createAi({ repo: ctx.repo }));
  const understood = new Map<string, Awaited<ReturnType<Ai["understand"]>>>();

  // ---- Small helpers

  const note = (ctx: EngineContext, kase: Case, payload: Record<string, unknown>, ref: string) =>
    ctx.repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: ctx.clock.now(), type: "note", payload, evidence_ref: ref });
  const notes = (ctx: EngineContext, caseId: string, kind: string) => ctx.repo.caseEvents.listByCase(caseId).filter((e) => e.payload.kind === kind);
  const lastNote = (ctx: EngineContext, caseId: string, kind: string) => notes(ctx, caseId, kind).at(-1);
  const stay = (kase: Case, reason: string, findings: Finding[] = []): InvestigateResult => ({ to: kase.state, reason, findings });
  const went = (r: GuardedResult) => r.status === "done" || r.status === "duplicate";
  const resultOf = (r: GuardedResult) => (r.status === "done" ? r.result : r.status === "duplicate" ? (r.action.result ?? {}) : null);

  async function understand(ctx: EngineContext, messageId: string, text: string, caseId: string | null) {
    const hit = understood.get(messageId);
    if (hit) return hit;
    const r = await aiOf(ctx).understand({ text }, { caseId });
    understood.set(messageId, r);
    return r;
  }

  function subOf(ctx: EngineContext, kase: Case): Sub | null {
    const id = lastNote(ctx, kase.id, N.situation)?.payload.subscription_id as string | undefined;
    return id ? (ctx.repo.subscriptions.get(id) ?? null) : null;
  }

  function context(ctx: EngineContext, kase: Case) {
    const sub = subOf(ctx, kase)!;
    const customer = ctx.repo.customers.get(sub.customer_id)!;
    const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
    const settings = settingsOf(ctx, kase);
    const bits = L.bitsFor(customer.name, merchant.name, sub.plan, formatMoney(sub.amount), sub.b2b);
    return { a: adaptersOf(ctx), sub, customer, merchant, settings, bits, first: firstNameOf(customer.name) };
  }

  const send = (ctx: EngineContext, kase: Case, args: ReturnType<typeof messageArgs>, approval?: Approval) =>
    guardedCall("send_message", args, { adapters: adaptersOf(ctx), caseId: kase.id, approval });

  function recipient(ctx: EngineContext, kase: Case, customer: Customer, sub: Sub): Recipient | null {
    return recipientFor(ctx, kase, customer, { b2b: sub.b2b });
  }

  // Closes from waiting_merchant (allowed by the state machine) with the
  // outcome, when the subscriber pays while the merchant has a card open.
  function closeFields(ctx: EngineContext, kase: Case, outcome: string, saved: boolean, ref: string) {
    note(ctx, kase, { kind: N.resolution, outcome, saved }, ref);
    ctx.repo.cases.update(kase.id, { outcome, counts_as_saved: saved, closed_at: ctx.clock.now() });
  }

  // The time promised to the subscriber, set on the case before the message
  // that quotes it (so the time is case data).
  function promiseAt(ctx: EngineContext, kase: Case, due: number) {
    for (const t of ctx.repo.timers.list(and(eq(s.timers.case_id, kase.id), eq(s.timers.kind, PROMISED_TIME_TIMER)))) {
      if (t.fired_at === null && t.cancelled_at === null) ctx.repo.timers.update(t.id, { cancelled_at: ctx.clock.now() });
    }
    const t = ctx.repo.timers.insert({ id: newId("tmr"), case_id: kase.id, kind: PROMISED_TIME_TIMER, due_at: due });
    ctx.repo.cases.update(kase.id, { promised_by: due });
    note(ctx, kase, { kind: "timer_set", timer_kind: PROMISED_TIME_TIMER, due_at: due }, t.id);
    return t;
  }

  const timeLabel = (at: number, now: number) => (formatDate(at) === formatDate(now) ? formatTime(at) : `${formatTime(at)} on ${formatDate(at)}`);

  async function sendPromise(ctx: EngineContext, kase: Case, holding = false) {
    const c = context(ctx, kase);
    const r = recipient(ctx, kase, c.customer, c.sub);
    if (!r) return false;
    const now = ctx.clock.now();
    const due = now + PROMISE_MS;
    const t = promiseAt(ctx, kase, due);
    const by = timeLabel(due, now);
    const body = holding ? L.holdingLine(c.bits, by, c.settings.signOff) : L.promiseLine(c.bits, by, c.settings.signOff);
    const res = await send(ctx, kase, messageArgs(ctx, kase, r, holding ? "holding" : "promise_line", body));
    if (!went(res)) {
      ctx.repo.timers.update(t.id, { cancelled_at: now });
      ctx.repo.cases.update(kase.id, { promised_by: null });
      return false;
    }
    note(ctx, kase, { kind: N.promise, due_at: due, holding }, res.action.id);
    return true;
  }

  // The subscription's own pending invoice link, then the message carrying
  // it. Never a fresh link, never a charge (pay_pending_invoice only reads).
  async function shareInvoiceLink(ctx: EngineContext, kase: Case, approval?: Approval): Promise<{ ok: boolean; reason: string }> {
    const c = context(ctx, kase);
    const inv = await guardedCall("pay_pending_invoice", { subscription_id: c.sub.id }, { adapters: c.a, caseId: kase.id, approval });
    const res = resultOf(inv);
    if (!res || typeof res.short_url !== "string") {
      return { ok: false, reason: inv.status === "blocked" ? inv.failures[0].reason : `There's no invoice to pay for ${c.sub.plan} right now.` };
    }
    const r = recipient(ctx, kase, c.customer, c.sub);
    if (!r) return { ok: false, reason: `RAY has no way to reach ${c.first} that they agreed to.` };
    const link = res.short_url;
    const invoice = ctx.repo.subInvoices.get(String(res.invoice_id))!;
    let body: string;
    if (kase.cause === CAUSES.setup) body = L.finishSetupLine(c.bits, link, invoice.error_reason, c.settings.signOff);
    else if (kase.cause === CAUSES.b2b) body = L.b2bInvoiceLine(c.bits, link, `${formatDate(invoice.billing_start)} to ${formatDate(invoice.billing_end)}`, c.settings.signOff);
    else if (kase.cause === CAUSES.token) body = L.setupAgainLine(c.bits, link, c.settings.signOff);
    else body = L.pendingInvoiceLine(c.bits, L.bVariant(invoice.error_reason), link, c.settings.signOff);
    const sent = await send(ctx, kase, messageArgs(ctx, kase, r, "recovery_link", body), approval);
    if (!went(sent)) return { ok: false, reason: sent.status === "blocked" ? sent.failures[0].reason : "The message didn't go." };
    note(ctx, kase, { kind: N.linkSent, invoice_id: invoice.id, channel: r.channel }, sent.action.id);
    return { ok: true, reason: `RAY sent ${c.first} the link to pay ${formatMoney(invoice.amount)} by ${r.channel === "email" ? "email" : "WhatsApp"}.` };
  }

  // Calls (design language section 5, decision 3): only to subscribers who
  // opted in to calls, never B2B. The playbook's "call subscribers worth
  // more than ₹X" rule is the merchant's approval: above it, RAY calls under
  // that rule id. Without the rule, RAY offers the call for a tap. The
  // call_rules guard checks opt-in, calling hours and the script at call time.
  function callPlan(ctx: EngineContext, kase: Case) {
    const c = context(ctx, kase);
    const optedIn = !c.sub.b2b && !!c.customer.phone && c.a.messaging.consent(c.customer.id, "call") === "opted_in";
    const rule = ctx.repo.playbookRules
      .list(and(eq(s.playbookRules.merchant_id, kase.merchant_id), eq(s.playbookRules.moment, "subscription"), eq(s.playbookRules.status, "approved")))
      .find((r) => r.rule_json.tool === "place_call" && r.rule_json.kind === "subscription_save" && typeof r.rule_json.min_value === "number");
    const above = rule ? c.sub.lifetime_value > (rule.rule_json.min_value as number) : false;
    return { optedIn, rule: rule ?? null, above };
  }

  // The first time inside the merchant's calling hours at or after `at`.
  function inCallingHours(ctx: EngineContext, kase: Case, at: number) {
    const m = ctx.repo.merchants.get(kase.merchant_id)!;
    const mins = minutesIst(at);
    if (mins >= m.calling_hours_start && mins < m.calling_hours_end) return at;
    const wait = mins < m.calling_hours_start ? m.calling_hours_start - mins : 24 * 60 - mins + m.calling_hours_start;
    return at + wait * MIN;
  }

  // ---- Proposals

  function remember(ctx: EngineContext, kase: Case, proposals: (ProposedAction & { option: Option })[]): ProposedAction[] {
    note(ctx, kase, { kind: N.options, options: proposals.map((p) => ({ proposal_id: p.id, option: p.option })) }, kase.id);
    return proposals.map((p) => {
      const { option, ...rest } = p;
      void option;
      return rest;
    });
  }

  function optionOf(ctx: EngineContext, kase: Case, proposalId: string): Option | null {
    for (const n of notes(ctx, kase.id, N.options).reverse()) {
      const hit = (n.payload.options as { proposal_id: string; option: Option }[]).find((o) => o.proposal_id === proposalId);
      if (hit) return hit.option;
    }
    return null;
  }

  function offerProposal(ctx: EngineContext, kase: Case, offer: Offer): ProposedAction & { option: Option } {
    const c = context(ctx, kase);
    const r = recipient(ctx, kase, c.customer, c.sub)!;
    // A merchant who set the pause to one 30-day cycle (Sharma Tutorials)
    // means "skip a month"; the default pause is worded as a month's break.
    const skip = c.merchant.sub_pause_days === 30;
    if (offer === "discount") {
      const percent = `${c.merchant.sub_discount_percent}%`;
      return {
        id: newId("prop"),
        option: "offer_discount",
        label: `Offer ${c.first} ${percent} off next month`,
        tool: "send_message",
        args: messageArgs(ctx, kase, r, "question", L.discountOfferLine(c.bits, percent, c.settings.signOff)),
        covered: false,
        // If they say yes, RAY links your Dashboard offer with the same approval.
        followUps: [{ tool: "apply_offer", args: { subscription_id: c.sub.id, offer_id: c.merchant.sub_discount_offer_id! } }],
      };
    }
    if (offer === "pause") {
      const args = { subscription_id: c.sub.id };
      return {
        id: newId("prop"),
        option: "offer_pause",
        label: skip ? `Offer ${c.first} a skipped month` : `Offer ${c.first} a month's pause`,
        tool: "send_message",
        args: messageArgs(ctx, kase, r, "question", L.pauseOfferLine(c.bits, skip, c.settings.signOff)),
        covered: false,
        // If they say yes, RAY pauses with the same tap and resumes on the date.
        followUps: [
          { tool: "pause_subscription", args },
          { tool: "resume_subscription", args },
        ],
      };
    }
    return {
      id: newId("prop"),
      option: "offer_other_method",
      label: `Offer ${c.first} another way to pay`,
      tool: "send_message",
      args: messageArgs(ctx, kase, r, "question", L.otherMethodOfferLine(c.bits, c.settings.signOff)),
      covered: false,
    };
  }

  function cancelProposal(ctx: EngineContext, kase: Case): ProposedAction & { option: Option } {
    const c = context(ctx, kase);
    const r = recipient(ctx, kase, c.customer, c.sub);
    return {
      id: newId("prop"),
      option: "cancel",
      label: `Cancel ${c.first}'s plan`,
      tool: "cancel_subscription",
      args: { subscription_id: c.sub.id },
      covered: false,
      ...(r ? { followUps: [{ tool: "send_message", args: messageArgs(ctx, kase, r, "status", L.cancelledLine(c.bits, c.settings.signOff)) }] } : {}),
    };
  }

  function refundProposal(ctx: EngineContext, kase: Case, paymentId: string, amount: number): ProposedAction & { option: Option } {
    return { id: newId("prop"), option: "refund", label: `Refund ${formatMoney(amount)}`, tool: "refund", args: { payment_id: paymentId, amount }, covered: false };
  }

  function callProposal(ctx: EngineContext, kase: Case): ProposedAction & { option: Option } {
    const c = context(ctx, kase);
    const offer = rulesFor(ctx.db, kase.merchant_id, "payment").find((r) => r.rule_json.offer === "pause");
    const lines = [
      "We've emailed you the details of this month's payment, with a page you can check before paying.",
      offer ? "If a break would help, we can pause your plan for a month instead." : "Is something stopping it from going through? We're happy to help.",
    ];
    return {
      id: newId("prop"),
      option: "call",
      label: `Call ${c.first}`,
      tool: "place_call",
      args: { kind: "subscription_save", to: c.customer.phone!, opening: `Hi ${c.first}, this is ${c.merchant.name} about your ${c.bits.amount} ${c.sub.plan} payment.`, lines },
      covered: false,
    };
  }

  // ---- Situations

  async function startPaymentCase(ctx: EngineContext, kase: Case, sub: Sub, findings: Finding[]): Promise<InvestigateResult> {
    const inv = sub.pending_invoice_id ? ctx.repo.subInvoices.get(sub.pending_invoice_id) : undefined;
    if (inv) {
      findings.push({
        text: `Invoice for ${formatMoney(inv.amount)} is unpaid after ${inv.attempts} attempt${inv.attempts === 1 ? "" : "s"}${inv.error_reason ? `: ${inv.error_reason}` : ""}.`,
        evidenceRef: inv.id,
      });
    }
    return { to: "confirmed", reason: "RAY will send the subscription's own invoice link.", findings, confidence: "sure", side: "customer_or_bank" };
  }

  async function askWhy(ctx: EngineContext, kase: Case): Promise<InvestigateResult> {
    const c = context(ctx, kase);
    const r = recipient(ctx, kase, c.customer, c.sub);
    if (!r) return { to: "waiting_merchant", reason: `RAY has no way to reach ${c.first} that they agreed to.`, findings: [] };
    const res = await send(ctx, kase, messageArgs(ctx, kase, r, "question", L.whyCancelledLine(c.bits, c.settings.signOff)));
    if (!went(res)) return { to: "waiting_merchant", reason: res.status === "blocked" ? res.failures[0].reason : "The question didn't go.", findings: [] };
    note(ctx, kase, { kind: N.question }, res.action.id);
    return { to: "waiting_customer", reason: `RAY asked ${c.first} once why.`, findings: [], timers: [{ kind: TIMERS.noReply, inMs: NO_REPLY_MS }] };
  }

  // E: proof from Razorpay's records, each finding citing its record.
  function evidencePack(ctx: EngineContext, kase: Case) {
    const c = context(ctx, kase);
    const mandate = ctx.db.select().from(s.mandates).where(eq(s.mandates.subscription_id, c.sub.id)).all().at(-1);
    const paid = ctx.db
      .select()
      .from(s.subInvoices)
      .where(and(eq(s.subInvoices.subscription_id, c.sub.id), eq(s.subInvoices.status, "paid")))
      .all()
      .sort((x, y) => x.billing_start - y.billing_start)
      .at(-1);
    const payment = paid?.payment_id ? ctx.repo.rzpPayments.get(paid.payment_id) : undefined;
    const findings: Finding[] = [];
    if (mandate?.authorised_at) {
      findings.push({
        text: `✓ ${c.customer.name} approved the ${mandate.method === "card" ? "card" : "UPI"} AutoPay on ${formatDate(mandate.authorised_at)} at ${formatTime(mandate.authorised_at)}${mandate.auth_ref ? `, reference ending ${mandate.auth_ref.slice(-4)}` : ""}.`,
        evidenceRef: mandate.id,
      });
    } else if (mandate) findings.push({ text: `✗ Razorpay has no record of when ${c.customer.name} approved the AutoPay.`, evidenceRef: mandate.id });
    if (paid?.notified_at) findings.push({ text: `✓ Razorpay sent the pre-debit notice on ${formatDate(paid.notified_at)}, before the ${formatMoney(paid.amount)} charge.`, evidenceRef: paid.id });
    else if (paid) findings.push({ text: "✗ No pre-debit notice on record for this charge.", evidenceRef: paid.id });
    if (payment) findings.push({ text: `✓ ${formatMoney(payment.amount)} was charged on ${formatDate(payment.created_at)}.`, evidenceRef: payment.id });
    const strong = !!(mandate?.authorised_at && mandate.auth_ref && paid?.notified_at);
    return { mandate, paid, payment, findings, strong };
  }

  async function didntAuthoriseDraft(ctx: EngineContext, kase: Case, pack: ReturnType<typeof evidencePack>) {
    const c = context(ctx, kase);
    const fallback = L.didntAuthoriseLine(
      c.bits,
      {
        approvedOn: pack.mandate?.authorised_at ? formatDate(pack.mandate.authorised_at) : null,
        ref: pack.mandate?.auth_ref ?? null,
        method: pack.mandate?.method === "card" ? "card" : "UPI",
        noticeOn: pack.paid?.notified_at ? formatDate(pack.paid.notified_at) : null,
        chargedOn: pack.payment ? formatDate(pack.payment.created_at) : formatDate(ctx.clock.now()),
      },
      c.settings.signOff,
    );
    const ids = idAliases();
    const facts = ids.hide({ ...caseFacts(ctx.db, kase.id), sign_off: c.settings.signOff, evidence: pack.findings.map((f) => f.text), example: fallback });
    const r = await aiOf(ctx).write(
      { audience: "customer", kind: "didnt_authorise_reply", first_customer_message: false, facts, tone: c.settings.tone, language: c.customer.language },
      { caseId: kase.id },
    );
    return r.source !== "fallback" && r.output.draft ? ids.show(r.output.draft) : fallback;
  }

  // ---- Decide for each situation

  async function decideCancel(ctx: EngineContext, kase: Case) {
    const c = context(ctx, kase);
    const reason = (lastNote(ctx, kase.id, N.reason)?.payload.reason as Reason | undefined) ?? "other";
    const offered = notes(ctx, kase.id, N.offer).length > 0;
    // A pause needs an active subscription; a plan change is never offered.
    const feasible = (o: Offer) =>
      o === "other_method" || (c.sub.status === "active" && (o === "pause" || (!!c.merchant.sub_discount_offer_id && !!c.merchant.sub_discount_percent)));
    const fits = offered ? [] : OFFER_FOR[reason].filter(feasible);
    // One save offer only, from the playbook.
    const rule = rulesFor(ctx.db, kase.merchant_id, reason).find((r) => r.rule_json.offer === "cancel" || fits.includes(r.rule_json.offer as Offer));
    const who = `${c.customer.name} wants to cancel ${c.sub.plan} (${c.bits.amount} a month) because ${L.REASON_LABEL[reason]}.`;
    if (rule) {
      const p = rule.rule_json.offer === "cancel" ? cancelProposal(ctx, kase) : offerProposal(ctx, kase, rule.rule_json.offer as Offer);
      return { to: "acting" as const, reason: `Under your rule: ${rule.text}`, summary: who, ruleId: rule.id, proposals: remember(ctx, kase, [p]) };
    }
    // No rule: 2 or 3 options for the merchant, the offer that fits the
    // reason first, then cancel.
    const offers = offered ? [] : [...new Set<Offer>([...fits, ...(["discount", "pause", "other_method"] as Offer[]).filter(feasible)])].slice(0, 2);
    const options = [...offers.map((o) => offerProposal(ctx, kase, o)), cancelProposal(ctx, kase)];
    if (!lastNote(ctx, kase.id, N.promise)) await sendPromise(ctx, kase);
    const ask = offered ? `${c.first} said no to the offer. Cancel the plan?` : "No rule covers this yet. Which should I offer?";
    return { to: "waiting_merchant" as const, reason: ask, summary: `${who} ${ask}`, proposals: remember(ctx, kase, options) };
  }

  async function decideDidntAuthorise(ctx: EngineContext, kase: Case) {
    const c = context(ctx, kase);
    const pack = evidencePack(ctx, kase);
    const r = recipient(ctx, kase, c.customer, c.sub);
    if (!lastNote(ctx, kase.id, N.promise)) await sendPromise(ctx, kase);
    const body = await didntAuthoriseDraft(ctx, kase, pack);
    const proposals: (ProposedAction & { option: Option })[] = [];
    const reply = r
      ? { id: newId("prop"), option: "reply_proof" as Option, label: `Send ${c.first} the proof`, tool: "send_message", args: messageArgs(ctx, kase, r, "didnt_authorise_reply", body), covered: false }
      : null;
    const refund = pack.payment && (!pack.strong || refundAllowed(ctx.db, kase.merchant_id)) ? refundProposal(ctx, kase, pack.payment.id, pack.payment.amount) : null;
    // Weak proof: refund is the recommendation.
    if (!pack.strong && refund) proposals.push(refund);
    if (reply) proposals.push(reply);
    if (pack.strong && refund) proposals.push(refund);
    const head = `${c.customer.name} says they didn't authorise the ${c.bits.amount} ${c.sub.plan} renewal.`;
    const why = pack.strong ? "The AutoPay approval and the pre-debit notice are both on record." : "The proof is weak, so a refund is the safer call.";
    return { to: "waiting_merchant" as const, reason: "The merchant decides.", summary: `${head} ${why} Want me to send the reply?`, proposals: remember(ctx, kase, proposals) };
  }

  async function decideAfterCall(ctx: EngineContext, kase: Case, summary: Record<string, unknown>, ref: string): Promise<ApprovalResult> {
    const c = context(ctx, kase);
    const findings: Finding[] = [{ text: `Call to ${c.customer.name}: ${String(summary.summary ?? "")}`, evidenceRef: ref }];
    const playbook = ctx.repo.playbookRules
      .list(and(eq(s.playbookRules.merchant_id, kase.merchant_id), eq(s.playbookRules.moment, "subscription")))
      .filter((r) => r.rule_json.setting === undefined)
      .map((r) => ({ id: r.id, moment: r.moment, text: r.text, status: r.status }));
    const ids = idAliases();
    const input = ids.hide({
      moment: "subscription" as const,
      case: { situation: kase.situation, cause: kase.cause, amount: c.bits.amount, plan: c.sub.plan, subscription_status: c.sub.status, confidence: kase.confidence },
      findings,
      playbook,
      memory: [] as string[],
    });
    const d = await aiOf(ctx).decide(input, { caseId: kase.id });
    note(ctx, kase, { kind: N.call, proposal: d.output.proposal, reason: d.output.reason, source: d.source }, ref);
    const options: (ProposedAction & { option: Option })[] = [];
    const resend = { id: newId("prop"), option: "resend_link" as Option, label: `Send ${c.first} the link again`, tool: "pay_pending_invoice", args: { subscription_id: c.sub.id }, covered: false };
    const pick = canAct(d) ? d.output.proposal : "escalate";
    if (pick === "pause_subscription" && c.sub.status === "active") {
      options.push({ id: newId("prop"), option: "pause_now", label: `Pause ${c.first}'s plan for a month`, tool: "pause_subscription", args: { subscription_id: c.sub.id }, covered: false, followUps: [{ tool: "resume_subscription", args: { subscription_id: c.sub.id } }] });
    }
    if (pick === "cancel_subscription") options.push(cancelProposal(ctx, kase));
    if (c.sub.pending_invoice_id) options.push(resend);
    if (!options.some((o) => o.option === "cancel")) options.push(cancelProposal(ctx, kase));
    const outcome = String(summary.outcome_label ?? summary.outcome ?? "");
    return {
      to: "waiting_merchant",
      reason: `I called ${c.first} (${outcome}). ${ids.show(d.output.reason)}`,
      proposals: remember(ctx, kase, options.slice(0, 3)),
    };
  }

  // ---- Acting

  async function runOption(ctx: EngineContext, kase: Case, proposal: ProposedAction, option: Option | null, approval: Approval): Promise<ApprovalResult> {
    const c = context(ctx, kase);
    const a = c.a;
    if (option === "call") {
      const r = await guardedCall("place_call", proposal.args, { adapters: a, caseId: kase.id, approval });
      if (r.status !== "done") return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped the call: ${r.failures[0].reason}` : "The call didn't go through." };
      const summary = lastNote(ctx, kase.id, "call_summary")!;
      return decideAfterCall(ctx, kase, summary.payload, summary.id);
    }
    if (option === "offer_discount" || option === "offer_pause" || option === "offer_other_method") {
      const r = await send(ctx, kase, proposal.args as ReturnType<typeof messageArgs>, approval);
      if (!went(r)) return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped the offer: ${r.failures[0].reason}` : "The offer didn't go." };
      const offer: Offer = option === "offer_discount" ? "discount" : option === "offer_pause" ? "pause" : "other_method";
      note(ctx, kase, { kind: N.offer, offer, proposal_id: proposal.id, approval }, r.action.id);
      // The merchant's pick becomes a proposed rule; it applies only after Approve rule.
      if (approval.by === "tap") proposeRule(ctx, kase, offer);
      const what = offer === "discount" ? `${c.merchant.sub_discount_percent}% off` : offer === "pause" ? "a month's pause" : "another way to pay";
      return { to: "verifying", reason: `RAY offered ${c.first} ${what}.`, timers: [{ kind: TIMERS.offerReply, inMs: NO_REPLY_MS }] };
    }
    if (option === "cancel") {
      const r = await guardedCall("cancel_subscription", proposal.args, { adapters: a, caseId: kase.id, approval });
      if (!went(r)) return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped it: ${r.failures[0].reason}` : `It didn't go through: ${r.status === "failed" ? r.error : ""}` };
      for (const f of proposal.followUps ?? []) await send(ctx, kase, f.args as ReturnType<typeof messageArgs>, approval);
      if (approval.by === "tap" && kase.situation === "D" && !notes(ctx, kase.id, N.offer).length) proposeRule(ctx, kase, "cancel");
      note(ctx, kase, { kind: N.resolution, outcome: "cancelled", saved: false }, r.action.id);
      return { to: "verifying", reason: `${c.sub.plan} for ${c.customer.name} cancelled ✓` };
    }
    if (option === "reply_proof") {
      const r = await send(ctx, kase, proposal.args as ReturnType<typeof messageArgs>, approval);
      if (!went(r)) return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped the reply: ${r.failures[0].reason}` : "The reply didn't go." };
      return { to: "verifying", reason: `Reply with the proof sent to ${c.first} ✓`, timers: [{ kind: TIMERS.noReply, inMs: NO_REPLY_MS }] };
    }
    if (option === "refund") {
      const r = await guardedCall("refund", proposal.args, { adapters: a, caseId: kase.id, approval });
      if (r.status === "held") return { to: "verifying", reason: `${proposal.label}: on hold for 10 min, with Undo.`, timers: [{ kind: TIMERS.refund, inMs: r.runAfter - ctx.clock.now() }] };
      return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped the refund: ${r.failures[0].reason}` : "The refund didn't go through." };
    }
    if (option === "resend_link") {
      const r = await shareInvoiceLink(ctx, kase, approval);
      if (!r.ok) return { to: "waiting_merchant", reason: r.reason };
      return { to: "verifying", reason: r.reason, timers: [{ kind: TIMERS.noResponse, inMs: NO_RESPONSE_MS }] };
    }
    if (option === "pause_now") return pauseAndSchedule(ctx, kase, approval, proposal.args.subscription_id as string);
    if (option === "resume") {
      const r = await guardedCall("resume_subscription", proposal.args, { adapters: a, caseId: kase.id, approval });
      if (!went(r)) return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped it: ${r.failures[0].reason}` : "The resume didn't go through." };
      note(ctx, kase, { kind: N.resolution, outcome: "resumed", saved: true }, r.action.id);
      return { to: "verifying", reason: `${c.customer.name}'s ${c.sub.plan} is active again ✓` };
    }
    return { to: "waiting_merchant", reason: "RAY can't find what was approved." };
  }

  function proposeRule(ctx: EngineContext, kase: Case, offer: Offer | "cancel") {
    const reason = (lastNote(ctx, kase.id, N.reason)?.payload.reason as Reason | undefined) ?? "other";
    const rule = ctx.repo.playbookRules.insert({
      id: newId("rule"),
      merchant_id: kase.merchant_id,
      moment: "subscription",
      rule_json: { tool: RULE_TOOL[offer], offer, reasons: [reason], ...(offer === "other_method" ? { kind: "question" } : {}) },
      text: ruleText(offer, reason, ctx.repo.merchants.get(kase.merchant_id)!.sub_discount_percent),
      source: "merchant",
      status: "proposed",
      approved_at: null,
    });
    note(ctx, kase, { kind: N.rule, rule_id: rule.id, text: rule.text }, rule.id);
  }

  // The discount: your Dashboard offer linked to the subscription with the
  // approval that sent the offer (tap or rule); it applies from the next cycle.
  async function applyDiscount(ctx: EngineContext, kase: Case, approval: Approval): Promise<ApprovalResult> {
    const c = context(ctx, kase);
    const offerId = c.merchant.sub_discount_offer_id;
    if (!offerId || !c.merchant.sub_discount_percent) return { to: "waiting_merchant", reason: "There's no offer set up in your playbook to apply." };
    const r = await guardedCall("apply_offer", { subscription_id: c.sub.id, offer_id: offerId }, { adapters: c.a, caseId: kase.id, approval });
    if (!went(r)) return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped the offer: ${r.failures[0].reason}` : `The offer didn't go through: ${r.status === "failed" ? r.error : ""}` };
    const percent = `${c.merchant.sub_discount_percent}%`;
    const rcpt = recipient(ctx, kase, c.customer, c.sub);
    if (rcpt) await send(ctx, kase, messageArgs(ctx, kase, rcpt, "status", L.discountAppliedLine(c.bits, percent, c.settings.signOff)));
    note(ctx, kase, { kind: N.resolution, outcome: "discount_applied", saved: true }, r.action.id);
    return { to: "verifying", reason: `${percent} off applied to ${c.customer.name}'s next ${c.sub.plan} payment ✓` };
  }

  // A new card led by the action the merchant asked for, then the rest.
  async function changedCard(ctx: EngineContext, kase: Case, wanted: Option, offered: ProposedAction[], options: (Option | null)[]): Promise<ProposedAction[] | null> {
    const c = context(ctx, kase);
    let lead: (ProposedAction & { option: Option }) | null = null;
    if (wanted === "refund") {
      const pay = kase.payment_id ? ctx.repo.rzpPayments.get(kase.payment_id) : undefined;
      if (pay) lead = refundProposal(ctx, kase, pay.id, pay.amount);
    } else if (wanted === "cancel") lead = cancelProposal(ctx, kase);
    else if (c.sub.status === "active" || wanted === "offer_other_method") {
      const offer = wanted.replace("offer_", "") as Offer;
      if (offer !== "discount" || (c.merchant.sub_discount_offer_id && c.merchant.sub_discount_percent)) lead = offerProposal(ctx, kase, offer);
    }
    if (!lead) return null;
    const rest = offered
      .map((p, i) => ({ ...p, id: newId("prop"), option: options[i] ?? ("cancel" as Option) }))
      .filter((p) => p.option !== wanted);
    return remember(ctx, kase, [lead, ...rest].slice(0, 3));
  }

  // Pause has no end date in Razorpay's API, so RAY schedules the resume.
  async function pauseAndSchedule(ctx: EngineContext, kase: Case, approval: Approval, subscriptionId: string): Promise<ApprovalResult> {
    const c = context(ctx, kase);
    const r = await guardedCall("pause_subscription", { subscription_id: subscriptionId }, { adapters: c.a, caseId: kase.id, approval });
    if (!went(r)) return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped the pause: ${r.failures[0].reason}` : "The pause didn't go through." };
    const due = ctx.clock.now() + (c.merchant.sub_pause_days ?? DEFAULT_PAUSE_DAYS) * DAY;
    const t = ctx.repo.timers.insert({ id: newId("tmr"), case_id: kase.id, kind: TIMERS.resume, due_at: due });
    ctx.repo.subscriptions.update(subscriptionId, { resume_at: due });
    note(ctx, kase, { kind: "timer_set", timer_kind: TIMERS.resume, due_at: due }, t.id);
    note(ctx, kase, { kind: N.paused, resume_at: due, approval }, r.action.id);
    const rcpt = recipient(ctx, kase, c.customer, c.sub);
    if (rcpt) await send(ctx, kase, messageArgs(ctx, kase, rcpt, "status", L.pausedLine(c.bits, formatDate(due), c.settings.signOff)));
    return { to: "verifying", reason: `${c.customer.name}'s ${c.sub.plan} is paused until ${formatDate(due)} ✓ RAY resumes it then.` };
  }

  // ---- Reading events on an open case

  async function onSubscriberMessage(ctx: EngineContext, kase: Case, e: EngineEvent): Promise<InvestigateResult> {
    const text = String(e.payload.body ?? "");
    const u = await understand(ctx, e.sourceId, text, kase.id);
    const kind = messageKind(text, u.output.intent);
    const c = context(ctx, kase);
    if (kase.state === "waiting_customer" && kase.cause === CAUSES.token) {
      // The one question's answer: payment trouble sets up again, else D.
      const reason = reasonOf(text);
      note(ctx, kase, { kind: N.reason, reason }, e.sourceId);
      if (reason === "payment" && kind !== "cancel") {
        return { to: "confirmed", reason: `${c.first} had trouble with the payment, so RAY will help set it up again.`, findings: [{ text: `${c.first} replied: the AutoPay stopped because of a payment problem.`, evidenceRef: e.sourceId }] };
      }
      return {
        to: "confirmed",
        reason: `${c.first} wants to stop ${c.sub.plan}.`,
        situation: "D",
        cause: CAUSES.cancel,
        findings: [{ text: `${c.first} replied that they want to stop.`, evidenceRef: e.sourceId }],
      };
    }
    if (kind === "didnt_authorise" && kase.situation !== "E") {
      ctx.repo.cases.update(kase.id, { situation: "E", cause: CAUSES.didnt });
      return { to: kase.state === "waiting_merchant" ? "confirmed" : kase.state, reason: `${c.first} says they didn't authorise it.`, findings: [] };
    }
    return stay(kase, "Noted the message.");
  }

  async function start(ctx: EngineContext, kase: Case, e: EngineEvent): Promise<InvestigateResult> {
    const sub = subOf(ctx, kase)!;
    const customer = ctx.repo.customers.get(sub.customer_id)!;
    const findings: Finding[] = [{ text: `${customer.name}'s ${sub.plan} is ${sub.status} at Razorpay.`, evidenceRef: sub.id }];
    switch (kase.cause) {
      case CAUSES.retrying:
        return { to: "likely", reason: "Razorpay is still retrying. RAY waits.", findings, side: "customer_or_bank" };
      case CAUSES.setup:
      case CAUSES.halted:
      case CAUSES.b2b:
        return startPaymentCase(ctx, kase, sub, findings);
      case CAUSES.token:
        return { ...(await askWhy(ctx, kase)), findings: [...findings, { text: "The AutoPay mandate was cancelled from the subscriber's side.", evidenceRef: e.sourceId }], side: "customer_or_bank" };
      case CAUSES.duplicate: {
        findings.push({ text: `A second ${formatMoney(sub.amount)} payment came in for a month that was already paid.`, evidenceRef: kase.payment_id ?? e.sourceId });
        return { to: "confirmed", reason: "Charged twice for one month.", findings, confidence: "sure", side: "customer_or_bank" };
      }
      case CAUSES.cancel: {
        const text = String(e.payload.body ?? "");
        const reason = reasonOf(text);
        note(ctx, kase, { kind: N.reason, reason }, e.sourceId);
        findings.push({ text: `${firstNameOf(customer.name)} asked to cancel; the reason reads as: ${L.REASON_LABEL[reason]}.`, evidenceRef: e.sourceId });
        return { to: "confirmed", reason: "A cancellation request.", findings, side: "customer_or_bank" };
      }
      case CAUSES.didnt: {
        const pack = evidencePack(ctx, kase);
        if (pack.payment) ctx.repo.cases.update(kase.id, { payment_id: pack.payment.id });
        note(ctx, kase, { kind: N.evidence, strong: pack.strong }, e.sourceId);
        return { to: "confirmed", reason: pack.strong ? "Proof found." : "The proof is weak.", findings: [...findings, ...pack.findings], side: "merchant" };
      }
    }
    return stay(kase, "Nothing to do.", findings);
  }

  // ---- The Specialist

  return {
    id: "subscriptions",
    moment: "subscription",

    async detect(ctx, e) {
      if (!ctx.adapters) return null;
      if (e.kind === "webhook") {
        const ev = String(e.payload.event ?? "");
        const ent = (e.payload.entities ?? {}) as { subscription?: { entity?: { id?: string } }; token?: { entity?: { subscription_id?: string } }; invoice?: { entity?: { status?: string; payment_id?: string | null } } };
        const subId = ent.subscription?.entity?.id ?? ent.token?.entity?.subscription_id ?? e.keys.subscriptionId;
        const sub = subId ? ctx.repo.subscriptions.get(subId) : undefined;
        if (!sub || sub.merchant_id !== e.merchantId) return null;
        const who = ctx.repo.customers.get(sub.customer_id)?.name ?? "A subscriber";
        const amount = formatMoney(sub.amount);
        const base = { moment: "subscription" as const, amount: sub.amount, side: "customer_or_bank" as const };
        if (ev === SETUP_EVENT) return { ...base, situation: "A" as const, confidence: "sure" as const, cause: CAUSES.setup, alert: L.alerts.setup(who, amount, sub.plan) };
        if (ev === "subscription.pending") return { ...base, situation: sub.b2b ? ("F" as const) : ("B" as const), confidence: "likely" as const, cause: CAUSES.retrying, alert: L.alerts.pending(who, amount, sub.plan) };
        if (ev === "subscription.halted") {
          return { ...base, situation: sub.b2b ? ("F" as const) : ("B" as const), confidence: "sure" as const, cause: sub.b2b ? CAUSES.b2b : CAUSES.halted, alert: L.alerts.halted(who, amount, sub.plan) };
        }
        if (ev === "token.cancelled") return { ...base, situation: "C" as const, confidence: "sure" as const, cause: CAUSES.token, alert: L.alerts.tokenCancelled(who, amount, sub.plan) };
        // Paid by link and by the bank's retry: the second payment is the duplicate.
        if (ev === "subscription.charged" && e.keys.paymentId && ent.invoice?.entity?.status === "paid" && ent.invoice.entity.payment_id && ent.invoice.entity.payment_id !== e.keys.paymentId) {
          return { ...base, situation: "B" as const, confidence: "sure" as const, cause: CAUSES.duplicate, paymentId: e.keys.paymentId, alert: L.alerts.duplicate(who, amount) };
        }
        return null;
      }
      if (e.kind === "message_in") {
        const found = subscriberBy(ctx, e.merchantId, { phone: e.keys.phone, email: e.keys.email });
        if (!found) return null;
        const text = String(e.payload.body ?? "");
        const u = await understand(ctx, e.sourceId, text, null);
        const kind = messageKind(text, u.output.intent);
        if (kind === "other") return null;
        const confidence = canAct(u) ? ("sure" as const) : ("likely" as const);
        const base = { moment: "subscription" as const, amount: found.sub.amount, confidence };
        if (kind === "didnt_authorise") return { ...base, situation: "E" as const, cause: CAUSES.didnt, alert: L.alerts.didntAuthorise(found.customer.name, formatMoney(found.sub.amount)) };
        return { ...base, situation: "D" as const, side: "customer_or_bank" as const, cause: CAUSES.cancel, alert: L.alerts.cancel(found.customer.name, found.sub.plan) };
      }
      return null;
    },

    async investigate(ctx, kase, e) {
      // First event: tie the case to its subscription and the subscriber's
      // contacts (so their messages join this case), then start.
      if (!lastNote(ctx, kase.id, N.situation)) {
        const ent = (e.payload.entities ?? {}) as { subscription?: { entity?: { id?: string } }; token?: { entity?: { subscription_id?: string } } };
        let subId = ent.subscription?.entity?.id ?? ent.token?.entity?.subscription_id ?? e.keys.subscriptionId;
        if (!subId && e.kind === "message_in") subId = subscriberBy(ctx, kase.merchant_id, { phone: e.keys.phone, email: e.keys.email })?.sub.id;
        if (!subId) return stay(kase, "No subscription found.");
        const sub = ctx.repo.subscriptions.get(subId)!;
        const customer = ctx.repo.customers.get(sub.customer_id)!;
        note(ctx, kase, { kind: N.situation, situation: kase.situation, subscription_id: sub.id }, sub.id);
        note(ctx, kase, { kind: N.contact, keys: { subscriptionId: sub.id, phone: customer.phone ?? undefined, email: customer.email?.toLowerCase() ?? undefined } }, customer.id);
        return start(ctx, kase, e);
      }
      const ev = String(e.payload.event ?? "");
      if (e.kind === "message_in") return onSubscriberMessage(ctx, kase, e);
      if (e.kind === "webhook") {
        const c = context(ctx, kase);
        if (kase.state === "likely" && kase.cause === CAUSES.retrying) {
          if (ev === "subscription.charged") return { to: "fixed_itself", reason: "Razorpay's retry went through.", findings: [{ text: `${c.bits.amount} paid on retry.`, evidenceRef: e.sourceId }] };
          if (ev === "subscription.halted") {
            ctx.repo.cases.update(kase.id, { cause: c.sub.b2b ? CAUSES.b2b : CAUSES.halted, confidence: "sure" });
            return startPaymentCase(ctx, kase, c.sub, [{ text: "Razorpay's retries ran out; the plan is on hold.", evidenceRef: e.sourceId }]);
          }
        }
        if (kase.state === "waiting_merchant" && (ev === "subscription.charged" || ev === "subscription.activated") && WAITS_FOR_PAYMENT.includes(kase.cause ?? "")) {
          closeFields(ctx, kase, "active_again", true, e.sourceId);
          return { to: "closed", reason: `${c.customer.name} paid; ${c.sub.plan} is active again ✓`, findings: [{ text: `${c.bits.amount} paid.`, evidenceRef: e.sourceId }] };
        }
        if (ev === "subscription.cancelled" && kase.state !== "waiting_merchant") return { to: "waiting_merchant", reason: `${c.sub.plan} was cancelled at Razorpay.`, findings: [] };
      }
      // No response while a call card is open: still lost after 7 days.
      if (e.kind === "timer" && e.payload.timer_kind === TIMERS.noResponse && kase.state === "waiting_merchant" && WAITS_FOR_PAYMENT.includes(kase.cause ?? "")) {
        const c = context(ctx, kase);
        if (ctx.repo.subscriptions.get(c.sub.id)!.status !== "active") {
          closeFields(ctx, kase, "lost", false, e.sourceId);
          return { to: "closed", reason: `${c.first} didn't pay; ${c.sub.plan} stays halted per Razorpay's rules. Closed as lost.`, findings: [] };
        }
      }
      if (e.kind === "timer" && e.payload.timer_kind === TIMERS.noReply && kase.state === "waiting_customer") {
        return { to: "unconfirmed", reason: "No reply in 72 hr.", findings: [] };
      }
      return stay(kase, "Nothing new.");
    },

    async decide(ctx, kase) {
      const c = context(ctx, kase);
      if (kase.cause === CAUSES.cancel) return decideCancel(ctx, kase);
      if (kase.cause === CAUSES.didnt) return decideDidntAuthorise(ctx, kase);
      if (kase.cause === CAUSES.duplicate) {
        const p = kase.payment_id ? ctx.repo.rzpPayments.get(kase.payment_id) : undefined;
        const proposals = p ? remember(ctx, kase, [refundProposal(ctx, kase, p.id, p.amount)]) : [];
        return { to: "waiting_merchant", reason: "Needs your tap.", summary: `${c.customer.name} paid ${c.bits.amount} by the link and the bank's retry also went through. Want me to refund the extra ${c.bits.amount}?`, proposals };
      }
      // A, B, C (set up again), F: the subscription's own invoice link, alone.
      if (c.sub.pending_invoice_id) {
        const proposals = remember(ctx, kase, [{ id: newId("prop"), option: "resend_link", label: `Send ${c.first} the invoice link`, tool: "pay_pending_invoice", args: { subscription_id: c.sub.id }, covered: false }]);
        return { to: "acting", alone: true, reason: "Runs alone.", summary: `RAY is sending ${c.first} the link to pay ${c.bits.amount}.`, proposals };
      }
      if (kase.cause === CAUSES.token) {
        // Nothing due yet: the steps now, the link when the next cycle is due.
        const r = recipient(ctx, kase, c.customer, c.sub);
        const last = ctx.db.select().from(s.subInvoices).where(eq(s.subInvoices.subscription_id, c.sub.id)).all().sort((x, y) => x.billing_end - y.billing_end).at(-1);
        if (r && last) {
          const body = L.setupAgainLaterLine(c.bits, formatDate(last.billing_end), c.settings.signOff);
          const proposals = remember(ctx, kase, [{ id: newId("prop"), option: "resend_link", label: `Tell ${c.first} how to set it up again`, tool: "send_message", args: messageArgs(ctx, kase, r, "status", body), covered: false }]);
          return { to: "acting", alone: true, reason: "Runs alone.", summary: `RAY is telling ${c.first} how to set up AutoPay again.`, proposals };
        }
      }
      return { to: "waiting_merchant", reason: "Nothing RAY can send on its own.", summary: `${c.customer.name}'s ${c.sub.plan} has nothing to pay right now. Want to handle it yourself?`, proposals: [] };
    },

    async proposeActions(_ctx, _kase, d) {
      return (d as typeof d & { proposals?: ProposedAction[] }).proposals ?? [];
    },

    async onRunAlone(ctx, kase) {
      const offered = openProposals(ctx, kase.id);
      const p = offered[0];
      if (!p) return { to: "waiting_merchant", reason: "Nothing to send." };
      const c = context(ctx, kase);
      if (p.tool === "pay_pending_invoice") {
        const r = await shareInvoiceLink(ctx, kase);
        if (!r.ok) return { to: "waiting_merchant", reason: r.reason };
        const timers: TimerRequest[] = [];
        if (kase.cause === CAUSES.b2b) timers.push({ kind: TIMERS.handoff, inMs: HANDOFF_MS });
        else timers.push({ kind: TIMERS.noResponse, inMs: NO_RESPONSE_MS });
        if (kase.cause === CAUSES.halted && callPlan(ctx, kase).optedIn) {
          const now = ctx.clock.now();
          timers.push({ kind: TIMERS.callCheck, inMs: inCallingHours(ctx, kase, now + CALL_AFTER_MS) - now });
        }
        return { to: "verifying", reason: r.reason, timers };
      }
      // C, nothing due yet: the steps, then the link when the next cycle is due.
      const r = await send(ctx, kase, p.args as ReturnType<typeof messageArgs>);
      if (!went(r)) return { to: "waiting_merchant", reason: r.status === "blocked" ? r.failures[0].reason : "The message didn't go." };
      note(ctx, kase, { kind: N.waitCycle }, r.action.id);
      const last = ctx.db.select().from(s.subInvoices).where(eq(s.subInvoices.subscription_id, c.sub.id)).all().sort((x, y) => x.billing_end - y.billing_end).at(-1);
      const lostAt = (last?.billing_end ?? ctx.clock.now()) + NO_RESPONSE_MS - ctx.clock.now();
      return { to: "verifying", reason: `RAY told ${c.first} how to set up AutoPay again.`, timers: [{ kind: TIMERS.cycleLost, inMs: Math.max(lostAt, HOUR) }] };
    },

    async onApproval(ctx, kase, approval) {
      const offered = openProposals(ctx, kase.id);
      const proposal =
        approval.by === "tap"
          ? offered.find((p) => p.id === approval.tap.proposalId)
          : offered.find((p) => {
              const rule = ctx.repo.playbookRules.get(approval.ruleId);
              if (!rule) return false;
              const offer = rule.rule_json.offer as string | undefined;
              const option = optionOf(ctx, kase, p.id);
              return offer === "cancel" ? option === "cancel" : option === `offer_${offer}`;
            });
      if (!proposal) return { to: "waiting_merchant", reason: "RAY can't find what was approved." };
      return runOption(ctx, kase, proposal, optionOf(ctx, kase, proposal.id), approval);
    },

    async verify(ctx, kase, e) {
      const c = context(ctx, kase);
      const resolution = lastNote(ctx, kase.id, N.resolution);
      if (!e) {
        if (resolution) return { to: "closed", reason: "Done.", outcome: String(resolution.payload.outcome) };
        return { to: "verifying", reason: "Checking it worked." };
      }
      const ev = String(e.payload.event ?? "");
      if (e.kind === "webhook") {
        if ((ev === "subscription.charged" || ev === "subscription.activated") && WAITS_FOR_PAYMENT.includes(kase.cause ?? "")) {
          note(ctx, kase, { kind: N.resolution, outcome: "active_again", saved: true }, e.sourceId);
          return { to: "closed", reason: `${c.customer.name} paid; ${c.sub.plan} is active again ✓`, outcome: "active_again" };
        }
        // C: the next cycle is due, so the set-up-again link goes now.
        if (ev === "subscription.pending" && lastNote(ctx, kase.id, N.waitCycle)) {
          const r = await shareInvoiceLink(ctx, kase);
          return { to: r.ok ? "verifying" : "waiting_merchant", reason: r.reason };
        }
        if (ev === "subscription.cancelled") {
          note(ctx, kase, { kind: N.resolution, outcome: "cancelled", saved: false }, e.sourceId);
          return { to: "closed", reason: `${c.sub.plan} was cancelled.`, outcome: "cancelled" };
        }
        return { to: "verifying", reason: "Nothing new." };
      }
      if (e.kind === "message_in") {
        const offer = lastNote(ctx, kase.id, N.offer);
        if (offer && !lastNote(ctx, kase.id, N.paused) && !resolution) {
          const text = String(e.payload.body ?? "");
          await understand(ctx, e.sourceId, text, kase.id);
          const answer = answerOf(text);
          const approval = offer.payload.approval as Approval;
          if (answer === "yes" && offer.payload.offer === "pause") return pauseAndSchedule(ctx, kase, approval, c.sub.id);
          // Inside verify, a recorded resolution closes now (the orchestrator
          // doesn't run verify again on the same state).
          const settled = (r: ApprovalResult) => {
            const done = r.to === "verifying" ? lastNote(ctx, kase.id, N.resolution) : undefined;
            return done ? { to: "closed" as const, reason: r.reason, outcome: String(done.payload.outcome) } : r;
          };
          if (answer === "yes" && offer.payload.offer === "discount") return settled(await applyDiscount(ctx, kase, approval));
          if (answer === "yes" && offer.payload.offer === "other_method") {
            if (c.sub.pending_invoice_id) {
              const r = await shareInvoiceLink(ctx, kase);
              if (r.ok) return { to: "verifying", reason: r.reason, timers: [{ kind: TIMERS.noResponse, inMs: NO_RESPONSE_MS }] };
            }
            return { to: "waiting_merchant", reason: `${c.first} wants another way to pay. Set it up with them?` };
          }
          if (answer === "no") {
            // Cancels cleanly: under a cancel rule, or with the merchant's tap.
            const rule = rulesFor(ctx.db, kase.merchant_id, (lastNote(ctx, kase.id, N.reason)?.payload.reason as Reason) ?? "other").find((r) => r.rule_json.offer === "cancel");
            const p = cancelProposal(ctx, kase);
            if (rule) return settled(await runOption(ctx, kase, p, "cancel", { by: "rule", ruleId: rule.id, evidenceRef: e.sourceId }));
            return { to: "waiting_merchant", reason: `${c.first} said no to the offer. Cancel the plan?`, proposals: remember(ctx, kase, [p]) };
          }
        }
        return { to: "verifying", reason: "Noted the message." };
      }
      if (e.kind === "timer") {
        const kind = e.payload.timer_kind;
        if (kind === TIMERS.noResponse || kind === TIMERS.cycleLost) {
          if (resolution || lastNote(ctx, kase.id, N.paused)) return { to: "verifying", reason: "Nothing new." };
          note(ctx, kase, { kind: N.resolution, outcome: "lost", saved: false }, e.sourceId);
          return { to: "closed", reason: `${c.first} didn't pay; ${c.sub.plan} stays halted per Razorpay's rules. Closed as lost.`, outcome: "lost" };
        }
        if (kind === TIMERS.handoff) {
          const fresh = ctx.repo.subscriptions.get(c.sub.id)!;
          const inv = fresh.pending_invoice_id ? ctx.repo.subInvoices.get(fresh.pending_invoice_id) : undefined;
          if (!inv || fresh.status === "active") return { to: "verifying", reason: "Nothing new." };
          const shared = ctx.repo.actions
            .list(and(eq(s.actions.case_id, kase.id), eq(s.actions.tool, "pay_pending_invoice"), eq(s.actions.status, "done")))
            .find((x) => x.result?.invoice_id === inv.id);
          const link = typeof shared?.result?.short_url === "string" ? shared.result.short_url : null;
          emitCollectHandoff(ctx, kase, {
            merchant_id: kase.merchant_id,
            subscription_id: fresh.id,
            invoice: { id: inv.id, amount: inv.amount, billing_start: inv.billing_start, billing_end: inv.billing_end, short_url: link, attempts: inv.attempts },
            buyer: { customer_id: c.customer.id, name: c.customer.name, email: c.customer.email, phone: c.customer.phone },
            reason: "B2B renewal unpaid 7 days after the invoice email",
          });
          note(ctx, kase, { kind: N.resolution, outcome: "handed_to_collect", saved: false }, inv.id);
          return { to: "closed", reason: `Unpaid after 7 days, so Invoice overdue takes it from here.`, outcome: "handed_to_collect" };
        }
        if (kind === TIMERS.callCheck) {
          const fresh = ctx.repo.subscriptions.get(c.sub.id)!;
          if (fresh.status === "active" || ctx.repo.actions.list(and(eq(s.actions.case_id, kase.id), eq(s.actions.tool, "place_call"))).length) {
            return { to: "verifying", reason: "Nothing new." };
          }
          const plan = callPlan(ctx, kase);
          if (!plan.optedIn) return { to: "verifying", reason: `No call: ${c.first} hasn't opted in to calls.` };
          const p = callProposal(ctx, kase);
          if (plan.rule && plan.above) {
            // Under the merchant's call rule: one call, no tap.
            const r = await guardedCall("place_call", p.args, { adapters: c.a, caseId: kase.id, approval: { by: "rule", ruleId: plan.rule.id, evidenceRef: e.sourceId } });
            if (r.status !== "done") return { to: "waiting_merchant", reason: r.status === "blocked" ? `A check stopped the call: ${r.failures[0].reason}` : "The call didn't go through." };
            const summary = lastNote(ctx, kase.id, "call_summary")!;
            return decideAfterCall(ctx, kase, summary.payload, summary.id);
          }
          if (plan.rule) return { to: "verifying", reason: `No call: ${c.first} is below your call limit.` };
          return {
            to: "waiting_merchant",
            reason: `${c.customer.name} (${formatMoney(fresh.lifetime_value)} so far) hasn't paid the ${c.bits.amount} yet. Want me to call ${c.first} with your save offer?`,
            proposals: remember(ctx, kase, [p]),
          };
        }
        if (kind === TIMERS.offerReply) {
          if (lastNote(ctx, kase.id, N.paused) || resolution) return { to: "verifying", reason: "Nothing new." };
          return { to: "waiting_merchant", reason: `${c.first} didn't answer the offer in 72 hr. Cancel the plan as asked?`, proposals: remember(ctx, kase, [cancelProposal(ctx, kase)]) };
        }
        if (kind === TIMERS.noReply) {
          if (resolution) return { to: "verifying", reason: "Nothing new." };
          note(ctx, kase, { kind: N.resolution, outcome: "proof_sent", saved: true }, e.sourceId);
          return { to: "closed", reason: `${c.first} didn't write back after the reply.`, outcome: "proof_sent" };
        }
        if (kind === TIMERS.refund) {
          const refund = ctx.repo.actions.list(and(eq(s.actions.case_id, kase.id), eq(s.actions.tool, "refund"))).at(-1);
          if (refund?.status !== "done") return { to: "verifying", reason: "The refund hasn't gone yet." };
          note(ctx, kase, { kind: N.resolution, outcome: kase.cause === CAUSES.duplicate ? "duplicate_refunded" : "refunded", saved: false }, refund.id);
          return { to: "closed", reason: `Refunded ${formatMoney(Number(refund.args.amount))} ✓`, outcome: kase.cause === CAUSES.duplicate ? "duplicate_refunded" : "refunded" };
        }
        if (kind === TIMERS.resume) {
          const paused = lastNote(ctx, kase.id, N.paused);
          const approval = paused?.payload.approval as Approval | undefined;
          // The tap or rule that approved the pause covers its scheduled resume.
          const r = approval ? await guardedCall("resume_subscription", { subscription_id: c.sub.id }, { adapters: c.a, caseId: kase.id, approval }) : null;
          if (r && went(r)) {
            note(ctx, kase, { kind: N.resolution, outcome: "resumed", saved: true }, r.action.id);
            return { to: "closed", reason: `${c.customer.name}'s ${c.sub.plan} is active again ✓`, outcome: "resumed" };
          }
          // Only if that fails (a check stopped it) does the merchant get a card.
          return {
            to: "waiting_merchant",
            reason: `${c.first}'s pause ended but the resume didn't go through${r?.status === "blocked" ? `: ${r.failures[0].reason}` : ""}. Resume ${c.sub.plan}?`,
            proposals: remember(ctx, kase, [{ id: newId("prop"), option: "resume", label: `Resume ${c.first}'s plan`, tool: "resume_subscription", args: { subscription_id: c.sub.id }, covered: false }]),
          };
        }
      }
      return { to: "verifying", reason: "Nothing new." };
    },

    async onPromisedTime(ctx, kase) {
      if (kase.state !== "waiting_merchant") return { reason: "Promised time reached; RAY is already on it." };
      const c = context(ctx, kase);
      const sent = await sendPromise(ctx, kase, true);
      ctx.repo.alerts.insert({
        id: newId("alert"),
        merchant_id: kase.merchant_id,
        case_id: kase.id,
        kind: "nudge",
        text: `${c.customer.name} was promised an update by now.${sent ? ` RAY told ${c.first} it's still being looked at.` : ""} This still needs your tap.`,
        channel: "whatsapp",
        sent_at: ctx.clock.now(),
      });
      return { reason: sent ? "Holding message sent and you were nudged." : "You were nudged." };
    },

    // Change (decision 5). The merchant's text is data, never an instruction.
    // Wording only: the write job redrafts each message on the card and the
    // same card comes back. A different action: the old card's approval is
    // void, and a new card with that action needs a fresh tap.
    async onChange(ctx, kase, text) {
      const offered = openProposals(ctx, kase.id);
      if (!offered.length) return { reason: "Nothing to redraft." };
      const options = offered.map((p) => optionOf(ctx, kase, p.id));
      const target = changeTarget(text);
      const wanted: Option | null =
        target === "refund" ? "refund" : target === "cancel" ? "cancel" : target ? (`offer_${target}` as Option) : null;
      if (wanted && options[0] !== wanted) {
        const fresh = await changedCard(ctx, kase, wanted, offered, options);
        if (fresh) {
          note(ctx, kase, { kind: "sub_change_voided", voided: offered.map((p) => p.id), now_first: wanted }, kase.id);
          return { reason: `New action, so the old card is void and this one needs your tap: ${fresh[0].label}.`, proposals: fresh };
        }
        return { reason: "RAY can't do that here, so the card stays as it was. Tap I'll handle this myself to take it over." };
      }
      const c = context(ctx, kase);
      const redraft = async (args: Record<string, unknown>) => {
        if (typeof args.body !== "string") return args;
        const ids = idAliases();
        const facts = ids.hide({ ...caseFacts(ctx.db, kase.id), sign_off: c.settings.signOff, current_draft: args.body, merchant_change: text });
        const r = await aiOf(ctx).write(
          { audience: "customer", kind: `${String(args.kind)}_redraft`, first_customer_message: false, facts, tone: c.settings.tone, language: c.customer.language },
          { caseId: kase.id },
        );
        return { ...args, body: r.source !== "fallback" && r.output.draft ? ids.show(r.output.draft) : args.body };
      };
      const proposals: (ProposedAction & { option: Option })[] = [];
      for (const [i, p] of offered.entries()) {
        const followUps = p.followUps ? await Promise.all(p.followUps.map(async (f) => (f.tool === "send_message" ? { ...f, args: await redraft(f.args) } : f))) : undefined;
        const args = p.tool === "send_message" ? await redraft(p.args) : p.args;
        proposals.push({ ...p, id: newId("prop"), option: options[i] ?? "cancel", args, ...(followUps ? { followUps } : {}) });
      }
      return { reason: "RAY redrafted the message with your note.", proposals: remember(ctx, kase, proposals) };
    },

    async countsAsSaved(ctx, kase) {
      const resolution = lastNote(ctx, kase.id, N.resolution);
      const sub = subOf(ctx, kase);
      if (!resolution?.payload.saved || !sub) return false;
      // Counts when the subscription is active again at Razorpay.
      const live = await adaptersOf(ctx).razorpay(kase.merchant_id).fetchSubscription(sub.id).catch(() => null);
      return live?.status === "active";
    },
  };
}

// Calling hours as a label, for the case page and tests.
export const callingHoursLabel = (start: number, end: number) => `${clockLabel(start)} to ${clockLabel(end)}`;

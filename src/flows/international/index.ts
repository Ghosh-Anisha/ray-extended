// Moment 2: card declined abroad (build guide Step 8). The Specialist for
// situations A to F. What happened is read from Razorpay's own record by
// code (the error_reason lookup table); buyer type is code; matching a later
// payment or a bank transfer is code. Models only write the buyer emails,
// the request reason (D) and the insight text. No calls to buyers abroad;
// a buyer's voice note is read like any message.
//
//   A  card not on for abroad/online  checkout: turn it on and retry, or another card
//                                     left: one email with steps and a fresh link
//   B  card security check (3DS)      checkout: retry, or PayPal; left: email, retry + PayPal
//   C  buyer's bank declined          checkout: another card or PayPal, never the same card
//   D  merchant-side block            checkout: the seller will send another way to pay
//                                     merchant approves the drafted request; B2B gets
//                                     MoneySaver bank details, B2C PayPal where possible
//   E  Razorpay risk hold             checkout: we couldn't complete it, the seller has
//                                     been told; merchant told, review ticket filed
//   F  buyer left before finishing    one email with a fresh link
//
// Runs alone: every buyer email (recovery_link), the risk ticket, the invoice
// attach on a transfer that matches for sure. A tap: the D request, a refund
// when the buyer paid twice, a near-match transfer.
import { and, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import { syncRecentPayments, type Payment } from "@/adapters/razorpay";
import { firstNameOf } from "@/adapters/voice";
import { createAi, type Ai } from "@/ai";
import * as s from "@/db/schema";
import { normalizeEmail, type EngineEvent } from "@/engine/events";
import { openProposals } from "@/engine/orchestrator";
import type { Approval, Decision, EngineContext, Finding, InvestigateResult, ProposedAction, Specialist, TimerRequest, VerifyResult } from "@/engine/specialist";
import { isFinal, type Case } from "@/engine/state-machine";
import { formatDate, formatMoney, formatTime, guardedCall, type GuardedResult } from "@/guards";
import { readSettings } from "@/surfaces/playbook";
import { idAliases } from "../shared/stable-ids";
import { buyerType, isInvoiceRef, type BuyerType } from "./buyer-type";
import { CAUSES, causeLine, checkoutMessage, isCause, lookup, REQUEST_FOR, type Cause, type Situation } from "./errors";
import "./facts";
import { patternCheck } from "./insight";
import { buyerReason, recoveryEmail, replyEmail, type EmailFacts } from "./messages";
import { createInternationalSim, REQUEST_KINDS, toInr, type InternationalSim, type Transfer } from "./sim";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const LEAVE_MS = 30 * MIN; // no new attempt for this long: the buyer left
export const NO_PAY_MS = 72 * HOUR; // after the email: nothing paid -> Closed, no reply
export const REQUEST_CHECK_MS = 24 * HOUR; // RAY tracks an approved request daily
export const REQUEST_TRACK_MS = 7 * DAY;
export const LOST_WINDOW_MS = 30 * DAY;
// After a payment, RAY waits this long before closing, in case the buyer
// paid twice (card and PayPal): then the merchant decides which to refund.
export const DUPLICATE_WINDOW_MS = 30 * MIN;

export const TIMERS = { leave: "leave_check", noPay: "no_pay", request: "request_check", refund: "refund_check", settle: "settle", close: "close_check", reopen: "reopen" } as const;

// Events the simulated systems send through handleEvent (payload.event).
export const SIM_EVENTS = {
  transfer: "moneysaver.transfer_received",
  riskCleared: "risk_review.cleared",
  riskDeclined: "risk_review.declined",
  accountUpdated: "account.updated",
  noAttempt: "order.no_attempt",
} as const;

// Flow bookkeeping on the timeline (case_events notes, payload.kind).
export const N = {
  situation: "intl_situation",
  checkout: "intl_checkout_message",
  emailed: "intl_emailed",
  noEmail: "intl_no_email",
  outcome: "intl_outcome",
  requestDraft: "intl_request_draft",
  requestApproved: "intl_request_approved",
  requestDone: "intl_request_done",
  ticket: "intl_ticket",
  transfer: "intl_transfer",
  duplicate: "intl_duplicate",
  reply: "intl_reply_draft",
  retry: "intl_retry",
} as const;

export type InternationalOptions = { ai?: (ctx: EngineContext) => Ai };

type Customer = typeof s.customers.$inferSelect;
type Link = typeof s.rzpLinks.$inferSelect;

// Everything a step needs about the case, read fresh.
type Ctx = {
  a: Adapters;
  sim: InternationalSim;
  merchant: typeof s.merchants.$inferSelect;
  p: Payment | null;
  orderId: string | null;
  link: Link | null;
  email: string | null;
  buyer: Customer | null;
  first: string;
  name: string;
  amount: number;
  currency: string;
  base: number | null;
  amountShown: string; // $49
  amountBoth: string; // $49 (₹4,100)
  reference: string | null;
  forLabel: string; // "order nn_pro_annual_881" or "invoice pf_inv_2041"
  cause: Cause | null;
  situation: Situation | null;
  buyerType: BuyerType | null;
  since: number;
  lang: string;
  settings: ReturnType<typeof readSettings>;
};

export function isInternational(p: Pick<Payment, "currency" | "card_country">) {
  return p.currency !== "INR" || (!!p.card_country && p.card_country !== "IN");
}

export function createInternationalSpecialist(opts: InternationalOptions = {}): Specialist {
  const aiOf = opts.ai ?? ((ctx: EngineContext) => createAi({ repo: ctx.repo }));

  // ---- Small helpers

  const adaptersOf = (ctx: EngineContext): Adapters => {
    if (!ctx.adapters) throw new Error("The international flow needs the adapters");
    return ctx.adapters;
  };
  const simOf = (ctx: EngineContext) => createInternationalSim(ctx.db, ctx.clock);
  const note = (ctx: EngineContext, kase: Case, payload: Record<string, unknown>, ref: string) =>
    ctx.repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: ctx.clock.now(), type: "note", payload, evidence_ref: ref });
  const notes = (ctx: EngineContext, caseId: string, kind: string) => ctx.repo.caseEvents.listByCase(caseId).filter((e) => e.payload.kind === kind);
  const lastNote = (ctx: EngineContext, caseId: string, kind: string) => notes(ctx, caseId, kind).at(-1);
  const stay = (kase: Case, reason: string, findings: Finding[] = []): InvestigateResult => ({ to: kase.state, reason, findings });
  const went = (r: GuardedResult) => r.status === "done" || r.status === "duplicate";
  const doneResult = (r: GuardedResult) => (r.status === "done" ? r.result : r.status === "duplicate" ? (r.action.result ?? {}) : null);
  const both = (amount: number, currency: string, base: number | null) =>
    currency === "INR" || !base ? formatMoney(amount, currency) : `${formatMoney(amount, currency)} (${formatMoney(base)})`;

  async function fetchPayment(a: Adapters, merchantId: string, id: string | null | undefined): Promise<Payment | null> {
    if (!id) return null;
    return a.razorpay(merchantId).fetchPayment(id).catch(() => null);
  }

  function customerByEmail(ctx: EngineContext, merchantId: string, email: string | null): Customer | null {
    if (!email) return null;
    return ctx.repo.customers.list(eq(s.customers.merchant_id, merchantId)).find((c) => normalizeEmail(c.email) === normalizeEmail(email)) ?? null;
  }

  async function load(ctx: EngineContext, kase: Case): Promise<Ctx> {
    const a = adaptersOf(ctx);
    const sim = simOf(ctx);
    const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
    const sit = lastNote(ctx, kase.id, N.situation)?.payload ?? {};
    // F has no failed payment: a payment_id the engine set later is the buyer's payment, not the case's.
    const p = sit.situation === "F" ? null : await fetchPayment(a, kase.merchant_id, kase.payment_id);
    const link = typeof sit.link_id === "string" ? (ctx.repo.rzpLinks.get(sit.link_id) ?? null) : null;
    const orderId = p?.order_id ?? (typeof sit.order_id === "string" ? sit.order_id : null);
    const order = orderId ? ctx.repo.rzpOrders.get(orderId) : undefined;
    const email = p?.email ?? link?.email ?? order?.email ?? (typeof sit.email === "string" ? sit.email : null);
    const buyer = customerByEmail(ctx, kase.merchant_id, email);
    const amount = p?.amount ?? link?.amount ?? order?.amount ?? 0;
    const currency = p?.currency ?? link?.currency ?? order?.currency ?? "INR";
    const base = p?.base_amount ?? null;
    const reference = order?.receipt ?? link?.receipt ?? (p ? (ctx.repo.rzpPayments.get(p.id)?.receipt ?? null) : null);
    const name = buyer?.name ?? email ?? "The buyer";
    return {
      a,
      sim,
      merchant,
      p,
      orderId,
      link,
      email,
      buyer,
      name,
      first: buyer ? firstNameOf(buyer.name) : "The buyer",
      amount,
      currency,
      base,
      amountShown: formatMoney(amount, currency),
      amountBoth: both(amount, currency, base),
      reference,
      forLabel: reference ? `${isInvoiceRef(reference) ? "invoice" : "order"} ${reference}` : "your order",
      cause: isCause(kase.cause) ? kase.cause : null,
      situation: kase.situation,
      buyerType: (sit.buyer_type as BuyerType | null | undefined) ?? null,
      since: p?.created_at ?? kase.opened_at,
      lang: buyer?.language ?? "en",
      settings: readSettings(ctx.db, kase.merchant_id, "international"),
    };
  }

  const linksOnCase = (ctx: EngineContext, caseId: string) =>
    ctx.repo.actions
      .list(and(eq(s.actions.case_id, caseId), eq(s.actions.tool, "payment_link"), eq(s.actions.status, "done")))
      .map((x) => String(x.result?.id ?? ""))
      .filter(Boolean);

  // ---- Later payments: the buyer paid, or is still trying (code).

  type Later = { paid: Payment[]; attempts: Payment[] };

  async function later(ctx: EngineContext, kase: Case, c: Ctx): Promise<Later> {
    const rzp = c.a.razorpay(kase.merchant_id);
    // Razorpay first, so a payment the mirror lacks is seen too.
    if (c.email) await syncRecentPayments(ctx.db, rzp, kase.merchant_id, { now: ctx.clock.now(), email: c.email }).catch(() => []);
    const mine = new Set(linksOnCase(ctx, kase.id));
    const viaLink = new Set(ctx.repo.rzpLinks.list(eq(s.rzpLinks.merchant_id, kase.merchant_id)).filter((l) => mine.has(l.id) && l.payment_id).map((l) => l.payment_id!));
    const related = ctx.repo.rzpPayments
      .list(eq(s.rzpPayments.merchant_id, kase.merchant_id))
      .filter((x) => x.id !== c.p?.id && x.created_at >= c.since)
      .filter(
        (x) =>
          (!!c.orderId && x.order_id === c.orderId) ||
          viaLink.has(x.id) ||
          (!!c.email && normalizeEmail(x.email) === normalizeEmail(c.email) && x.amount === c.amount && x.currency === c.currency),
      )
      .sort((x, y) => x.created_at - y.created_at);
    const asPayment = async (id: string) => (await fetchPayment(c.a, kase.merchant_id, id))!;
    return {
      paid: await Promise.all(related.filter((x) => x.status === "captured" || x.status === "authorized").map((x) => asPayment(x.id))),
      attempts: await Promise.all(related.filter((x) => x.status === "failed").map((x) => asPayment(x.id))),
    };
  }

  type Outcome = { outcome: string; saved: boolean; ref: string; line: string };

  // How a later payment counts: another way (a link RAY sent, PayPal or a
  // transfer) is saved; a card retry on the same checkout is not.
  function outcomeOf(ctx: EngineContext, kase: Case, c: Ctx, q: Payment): Outcome {
    const link = ctx.repo.rzpLinks.list(eq(s.rzpLinks.payment_id, q.id))[0];
    const amt = formatMoney(q.amount, q.currency);
    if (link && linksOnCase(ctx, kase.id).includes(link.id)) return { outcome: "paid_by_link", saved: true, ref: q.id, line: `${c.first} paid ${amt} through the link RAY sent ✓` };
    if (q.method === "paypal" || q.method === "wallet") return { outcome: "paid_by_paypal", saved: true, ref: q.id, line: `${c.first} paid ${amt} with PayPal ✓` };
    return { outcome: "paid_by_card_retry", saved: false, ref: q.id, line: `${c.first} paid ${amt} by card on a retry ✓` };
  }

  // A payment came in for the case. Two paid: the merchant decides which to
  // refund. One: the case's outcome.
  async function onPaid(ctx: EngineContext, kase: Case, c: Ctx, l: Later): Promise<
    | { kind: "duplicate"; reason: string; proposals: ProposedAction[]; findings: Finding[]; underRule?: { reason: string; timers: TimerRequest[] } }
    | { kind: "outcome"; o: Outcome; findings: Finding[]; fixedItself: boolean }
  > {
    const paid = l.paid.filter((x) => x.status === "captured");
    const findings: Finding[] = paid.map((q) => ({ text: `${c.first} paid ${formatMoney(q.amount, q.currency)} by ${q.method === "paypal" ? "PayPal" : q.method ?? "card"} at ${formatTime(q.created_at)} on ${formatDate(q.created_at)}.`, evidenceRef: q.id }));
    if (paid.length >= 2) {
      const [keep, extra] = paid;
      note(ctx, kase, { kind: N.duplicate, payment_ids: paid.map((q) => q.id) }, extra.id);
      const how = (q: Payment) => (q.method === "paypal" ? "PayPal" : "card");
      const amt = formatMoney(extra.amount, extra.currency);
      // A playbook threshold the merchant approved counts as a rule: refund
      // the extra one under it, with the same hold and every guard.
      const rule = duplicateRule(ctx, kase, extra);
      if (rule) {
        const r = await guardedCall("refund", { payment_id: extra.id, amount: extra.amount, speed: "normal" }, { adapters: c.a, caseId: kase.id, approval: { by: "rule", ruleId: rule.id, evidenceRef: extra.id } });
        if (r.status === "held") {
          return {
            kind: "duplicate",
            reason: "",
            proposals: [],
            findings,
            underRule: {
              reason: `${c.name} paid ${amt} twice. Refunding the ${how(extra)} one under your rule (${rule.text}), on hold for 10 min with Undo.`,
              timers: [{ kind: TIMERS.refund, inMs: r.runAfter - ctx.clock.now() + 1 }],
            },
          };
        }
      }
      return {
        kind: "duplicate",
        reason: `${c.name} paid ${amt} twice for ${c.forLabel}: by ${how(keep)} at ${formatTime(keep.created_at)} and by ${how(extra)} at ${formatTime(extra.created_at)}. Want me to refund the ${how(extra)} one?`,
        proposals: [
          { id: newId("prop"), label: `Refund ${amt}`, tool: "refund", args: { payment_id: extra.id, amount: extra.amount, speed: "normal" }, covered: true },
          { id: newId("prop"), label: `Refund the ${how(keep)} one instead`, tool: "refund", args: { payment_id: keep.id, amount: keep.amount, speed: "normal" }, covered: true },
        ],
        findings,
      };
    }
    const q = paid[0] ?? l.paid[0];
    const o = outcomeOf(ctx, kase, c, q);
    const emailed = notes(ctx, kase.id, N.emailed).length > 0;
    note(ctx, kase, { kind: N.outcome, outcome: o.outcome, saved: o.saved, payment_id: q.id, close_at: ctx.clock.now() + DUPLICATE_WINDOW_MS }, q.id);
    return { kind: "outcome", o, findings, fixedItself: !o.saved && !emailed };
  }

  // ---- Talking to the buyer

  async function emailFacts(ctx: EngineContext, kase: Case, c: Ctx, extra: { link: string | null; paypal: boolean; bank: boolean }): Promise<EmailFacts> {
    const acc = extra.bank ? c.sim.account(kase.merchant_id, c.currency) : null;
    return {
      merchant: c.merchant.name,
      buyer_first_name: c.buyer ? c.first : "there",
      amount: c.amountShown,
      for: c.forLabel,
      card: c.p?.card_last4 ? `card ending ${c.p.card_last4}` : null,
      link: extra.link,
      paypal: extra.paypal,
      bank_details: acc
        ? { Bank: acc.bank_name, "Account name": acc.account_name, "Account number": acc.account_number, [acc.routing_label]: acc.routing, SWIFT: acc.swift }
        : null,
      reference: c.reference,
      sign_off: c.settings.signOff,
    };
  }

  async function writeBuyer(ctx: EngineContext, kase: Case, c: Ctx, kind: string, facts: Record<string, unknown>, fallback: string): Promise<string> {
    const ids = idAliases();
    const r = await aiOf(ctx).write(
      { audience: "buyer", kind, first_customer_message: false, facts: ids.hide(facts), tone: c.settings.tone, language: c.lang },
      { caseId: kase.id },
    );
    return r.source !== "fallback" && r.output.draft ? ids.show(r.output.draft) : fallback;
  }

  const messageArgs = (c: Ctx, kind: "recovery_link" | "status", body: string) => ({
    channel: "email" as const,
    to: c.email!,
    sender_mode: c.settings.sendFrom,
    kind,
    body,
  });

  async function freshLink(ctx: EngineContext, kase: Case, c: Ctx): Promise<string | null> {
    const existing = linksOnCase(ctx, kase.id).map((id) => ctx.repo.rzpLinks.get(id)).find((l) => l && l.status === "created");
    if (existing?.short_url) return existing.short_url;
    const r = await guardedCall(
      "payment_link",
      {
        amount: c.amount,
        currency: c.currency,
        description: `${c.merchant.name}: ${c.forLabel}`,
        customer: { name: c.buyer?.name, email: c.email ?? undefined },
      },
      { adapters: c.a, caseId: kase.id },
    );
    const res = doneResult(r);
    return typeof res?.short_url === "string" ? res.short_url : null;
  }

  // Why no email can go: no address, or the buyer opted out of email.
  function cannotEmail(c: Ctx): string | null {
    if (!c.email) return `RAY has no email for ${c.name}, so it can't write.`;
    if (c.buyer && c.a.messaging.consent(c.buyer.id, "email") === "opted_out") return `${c.name} opted out of email, so RAY didn't write.`;
    return null;
  }

  type Sent = { sent: true; messageId: string } | { sent: false; why: string; paid?: Later };

  // The one email after the buyer leaves (and D's, after the merchant's tap).
  // Right before sending: no later payment, no email yet, consent.
  async function sendRecovery(ctx: EngineContext, kase: Case, c: Ctx, cause: Cause, opts: { bank?: boolean; approval?: Approval; body?: string; merchantNote?: string } = {}): Promise<Sent> {
    if (notes(ctx, kase.id, N.emailed).length) return { sent: false, why: `RAY already emailed ${c.first} once.` };
    const l = await later(ctx, kase, c);
    if (l.paid.length) return { sent: false, why: `${c.first} has already paid.`, paid: l };
    const blocked = cannotEmail(c);
    if (blocked) return { sent: false, why: blocked };
    const paypal = c.sim.paypalAvailable(kase.merchant_id, c.currency);
    const bank = !!opts.bank && !!c.sim.account(kase.merchant_id, c.currency);
    const link = bank ? null : await freshLink(ctx, kase, c);
    if (!bank && !link) return { sent: false, why: "RAY couldn't make a fresh payment link." };
    const facts = await emailFacts(ctx, kase, c, { link, paypal, bank });
    const body =
      opts.body ??
      (await writeBuyer(
        ctx,
        kase,
        c,
        `buyer_recovery_${cause}`,
        { ...facts, what_happened: buyerReason(cause), never_the_same_card: CAUSES[cause].situation === "C", ...(opts.merchantNote ? { merchant_change: opts.merchantNote } : {}) },
        recoveryEmail(cause, facts),
      ));
    const r = await guardedCall("send_message", messageArgs(c, "recovery_link", body), { adapters: c.a, caseId: kase.id, approval: opts.approval });
    if (!went(r)) return { sent: false, why: r.status === "blocked" ? r.failures[0].reason : "The email didn't go." };
    const messageId = String(doneResult(r)?.message_id ?? "");
    note(ctx, kase, { kind: N.emailed, message_id: messageId, cause }, messageId || kase.id);
    return { sent: true, messageId };
  }

  // ---- Opening a case: what happened, by code

  async function classify(ctx: EngineContext, kase: Case, e: EngineEvent, p: Payment): Promise<InvestigateResult> {
    const c0 = await load(ctx, kase);
    const sim = c0.sim;
    const signals = sim.signals(p.id);
    const cause: Cause | null = signals?.risk_hold === "held" ? "risk_hold" : lookup(p.error_reason, p.error_source);
    const order = p.order_id ? ctx.repo.rzpOrders.get(p.order_id) : undefined;
    const bt = buyerType({
      reference: order?.receipt ?? null,
      viaLink: false,
      amountInr: p.currency === "INR" ? p.amount : p.base_amount,
      email: p.email,
      merchantBusinessType: c0.merchant.business_type,
      playbook: sim.settings(kase.merchant_id)?.buyer_type ?? null,
    });
    const settings = sim.settings(kase.merchant_id);
    const paypal = sim.paypalAvailable(kase.merchant_id, p.currency);
    const shown = cause ? checkoutMessage(cause, { paypal }) : null;
    note(ctx, kase, { kind: N.situation, situation: cause ? CAUSES[cause].situation : null, cause, buyer_type: bt.type, buyer_reasons: bt.reasons, order_id: p.order_id, email: p.email }, p.id);
    if (shown) note(ctx, kase, { kind: N.checkout, text: shown, cause }, p.id);

    const country = p.card_country && p.card_country !== "IN" ? `${p.card_country} ` : "";
    const findings: Finding[] = [
      {
        text: `Razorpay declined ${both(p.amount, p.currency, p.base_amount)} on a ${country}card${p.card_last4 ? ` ending ${p.card_last4}` : ""} at ${formatTime(p.created_at)} on ${formatDate(p.created_at)}.`,
        evidenceRef: p.id,
      },
    ];
    if (!cause) {
      findings.push({ text: `Razorpay's reason (${p.error_reason ?? "none given"}) isn't one RAY knows yet.`, evidenceRef: p.id });
      return {
        to: "waiting_merchant",
        confidence: "unsure",
        reason: `RAY doesn't know this decline reason yet, so it won't write to ${c0.first}. How do you want to reach ${c0.first}?`,
        findings,
      };
    }
    const situation = CAUSES[cause].situation;
    const limit = settings ? formatMoney(settings.limit_inr) : undefined;
    const line = causeLine(cause, { first: c0.first, limit, currency: p.currency });
    findings.push({ text: line, evidenceRef: p.id });
    if (situation === "C" && signals) {
      // Read as Razorpay's fraud check gave it; never re-scored.
      const said = { clean: "found nothing wrong", review: "flagged it for review", fraud_suspected: "flagged it as likely fraud" }[signals.vulcan_result];
      findings.push({ text: `Razorpay's fraud check ${said}.`, evidenceRef: p.id });
    }
    if (bt.type) findings.push({ text: `${c0.first} looks like ${bt.type === "b2b" ? "a business buyer" : "someone buying for themselves"}: ${bt.reasons.map((r) => r.replace(/\.$/, "").toLowerCase()).join("; ")}.`, evidenceRef: p.order_id ?? p.id });
    else findings.push({ text: `RAY can't tell yet if ${c0.first} is a business or buying for themselves.`, evidenceRef: p.order_id ?? p.id });
    if (shown) findings.push({ text: `At checkout, ${c0.first} saw: "${shown}"`, evidenceRef: p.id });

    await patternCheck(ctx, { ...kase, cause }, cause, { ai: aiOf(ctx), sim, evidenceRef: p.id }).catch(() => null);

    const base = { situation, cause, side: CAUSES[cause].side, confidence: "sure" as const, findings };
    if (situation === "D") return { ...base, to: "confirmed", reason: `${line} Your side. Here's the fix.` };
    if (situation === "E") {
      const c = await load(ctx, ctx.repo.cases.update(kase.id, { cause, situation })!);
      const ticket = await guardedCall(
        "draft_request",
        {
          request: REQUEST_KINDS.risk,
          text: `Review request: Razorpay's risk check held ${c.amountBoth} from ${c.name}${c.email ? ` (${c.email})` : ""} to ${c.merchant.name} on ${formatDate(p.created_at)} at ${formatTime(p.created_at)}, payment ${p.id}. Fraud check result: ${signals?.vulcan_result ?? "not given"}. The merchant has been told. Please review whether this buyer can pay.`,
          evidence_refs: [p.id],
        },
        { adapters: c.a, caseId: kase.id },
      );
      if (!went(ticket)) return { ...base, to: "waiting_merchant", reason: "Razorpay's risk check held it, and RAY couldn't file the review ticket." };
      note(ctx, kase, { kind: N.ticket, action_id: ticket.action.id }, ticket.action.id);
      findings.push({ text: "RAY filed a review ticket with Razorpay's risk team (Simulated).", evidenceRef: ticket.action.id });
      ctx.repo.alerts.insert({
        id: newId("alert"),
        merchant_id: kase.merchant_id,
        case_id: kase.id,
        kind: "intl_risk_hold",
        text: `${c.name}'s ${c.amountBoth} card payment was held by Razorpay's risk check. I've filed a simulated review ticket. The evidence points to Razorpay, but compensation terms are not confirmed. ${c.first} was told you've been informed.`,
        channel: "whatsapp",
        sent_at: ctx.clock.now(),
      });
      return { ...base, to: "waiting_customer", reason: "Razorpay's risk team is reviewing it. Review ticket filed.", timers: [{ kind: TIMERS.noPay, inMs: NO_PAY_MS }] };
    }
    return {
      ...base,
      to: "waiting_customer",
      reason: `${line} ${c0.first} saw how to pay at checkout. If ${c0.first} leaves, RAY emails once with a fresh link.`,
      timers: [{ kind: TIMERS.leave, inMs: LEAVE_MS }],
    };
  }

  // F: an expired link, or an order with no attempt. One email with a fresh link.
  async function classifyLeft(ctx: EngineContext, kase: Case, e: EngineEvent, from: { linkId?: string; orderId?: string }): Promise<InvestigateResult> {
    const link = from.linkId ? ctx.repo.rzpLinks.get(from.linkId) : undefined;
    const order = from.orderId ? ctx.repo.rzpOrders.get(from.orderId) : undefined;
    const email = normalizeEmail(link?.email ?? order?.email) ?? null;
    const reference = order?.receipt ?? link?.receipt ?? null;
    // keys.email puts the buyer on the case: their reply joins it, and screens show their name.
    note(ctx, kase, { kind: N.situation, situation: "F", cause: "left_checkout", link_id: link?.id ?? null, order_id: order?.id ?? null, email, keys: { email } }, link?.id ?? order?.id ?? e.sourceId);
    const c = await load(ctx, ctx.repo.cases.update(kase.id, { cause: "left_checkout", situation: "F", side: "customer_or_bank" })!);
    const what = link ? `The payment link for ${c.amountShown} expired unpaid.` : `${c.first} opened checkout for ${c.amountShown} and left without trying to pay.`;
    const findings: Finding[] = [{ text: what, evidenceRef: link?.id ?? order?.id ?? e.sourceId }];
    if (reference) findings.push({ text: `It was for ${c.forLabel}.`, evidenceRef: link?.id ?? order?.id ?? e.sourceId });
    const r = await sendRecovery(ctx, kase, c, "left_checkout");
    if (r.sent) {
      findings.push({ text: `RAY emailed ${c.first} once with a fresh link.`, evidenceRef: r.messageId });
      return { to: "waiting_customer", situation: "F", side: "customer_or_bank", confidence: "sure", cause: "left_checkout", reason: `${what} RAY sent ${c.first} one email with a fresh link.`, findings, timers: [{ kind: TIMERS.noPay, inMs: NO_PAY_MS }] };
    }
    if (r.paid) return { to: "fixed_itself", reason: `${c.first} has already paid.`, findings };
    note(ctx, kase, { kind: N.noEmail, why: r.why }, kase.id);
    return { to: "waiting_merchant", situation: "F", side: "customer_or_bank", confidence: "sure", cause: "left_checkout", reason: `${what} ${r.why}`, findings };
  }

  // ---- After the case opened

  // A payment came in (or a transfer was matched): move toward closing from
  // wherever the case is.
  function outcomeStep(ctx: EngineContext, kase: Case, o: Outcome, findings: Finding[], fixedItself: boolean): InvestigateResult {
    if (fixedItself) return { to: "fixed_itself", reason: `Fixed itself: ${o.line}`, findings };
    if (kase.state === "waiting_merchant" || kase.state === "likely") {
      // waiting_merchant can't go straight to verifying: through waiting_customer, then a settle check.
      return { to: "waiting_customer", reason: o.line, findings, timers: [{ kind: TIMERS.settle, inMs: 0 }] };
    }
    return { to: "verifying", reason: o.line, findings, timers: closeTimer(ctx, kase) };
  }

  // An approved international rule { tool: "refund", when: "duplicate", max }
  // covers the extra payment when its INR amount is at or under max.
  function duplicateRule(ctx: EngineContext, kase: Case, extra: Payment) {
    const inr = extra.currency === "INR" ? extra.amount : extra.base_amount;
    if (inr === null) return null;
    return (
      ctx.repo.playbookRules
        .list(and(eq(s.playbookRules.merchant_id, kase.merchant_id), eq(s.playbookRules.moment, "international"), eq(s.playbookRules.status, "approved")))
        .find((r) => r.rule_json.tool === "refund" && r.rule_json.when === "duplicate" && (typeof r.rule_json.max !== "number" || inr <= r.rule_json.max)) ?? null
    );
  }

  type DuplicateStep = { to: "waiting_merchant" | "verifying"; reason: string; findings: Finding[]; proposals?: ProposedAction[]; timers?: TimerRequest[] };
  function duplicateStep(r: { reason: string; proposals: ProposedAction[]; underRule?: { reason: string; timers: TimerRequest[] } }, findings: Finding[]): DuplicateStep {
    if (r.underRule) return { to: "verifying", reason: r.underRule.reason, findings, timers: r.underRule.timers };
    return { to: "waiting_merchant", reason: r.reason, findings, proposals: r.proposals };
  }

  // A payment outcome closes after the duplicate window; others at once.
  const closeTimer = (ctx: EngineContext, kase: Case): TimerRequest[] => {
    const at = Number(lastNote(ctx, kase.id, N.outcome)?.payload.close_at ?? 0);
    return at > ctx.clock.now() ? [{ kind: TIMERS.close, inMs: at - ctx.clock.now() }] : [];
  };
  const readyToClose = (ctx: EngineContext, kase: Case) => {
    const o = lastNote(ctx, kase.id, N.outcome);
    // Paid twice: only the refund closes it.
    return !!o && Number(o.payload.close_at ?? 0) <= ctx.clock.now() && !lastNote(ctx, kase.id, N.duplicate);
  };

  async function onRetry(ctx: EngineContext, kase: Case, q: Payment): Promise<InvestigateResult> {
    const c = await load(ctx, kase);
    note(ctx, kase, { kind: N.retry, payment_id: q.id }, q.id);
    const cause = lookup(q.error_reason, q.error_source);
    const finding = { text: `${c.first} tried again at ${formatTime(q.created_at)}; it was declined again${cause ? `: ${causeLine(cause, { first: c.first }).replace(/\.$/, "").toLowerCase()}` : ""}.`, evidenceRef: q.id };
    if (kase.state !== "waiting_customer" || notes(ctx, kase.id, N.emailed).length) return stay(kase, `${c.first} is still trying.`, [finding]);
    // Buyer already retrying: no email. Wait 30 min from this attempt.
    return { to: "waiting_customer", reason: `${c.first} is still trying, so RAY waits before writing.`, findings: [finding], timers: [{ kind: TIMERS.leave, inMs: LEAVE_MS }] };
  }

  async function onLeaveCheck(ctx: EngineContext, kase: Case): Promise<InvestigateResult> {
    const c = await load(ctx, kase);
    if (kase.state !== "waiting_customer" || !c.cause || notes(ctx, kase.id, N.emailed).length) return stay(kase, "Nothing to do.");
    if (!["A", "B", "C"].includes(c.situation ?? "")) return stay(kase, "Nothing to do.");
    const l = await later(ctx, kase, c);
    if (l.paid.length) {
      const r = await onPaid(ctx, kase, c, l);
      if (r.kind === "duplicate") return duplicateStep(r, r.findings);
      return outcomeStep(ctx, kase, r.o, r.findings, r.fixedItself);
    }
    const latest = l.attempts.at(-1);
    if (latest && latest.created_at > ctx.clock.now() - LEAVE_MS) {
      note(ctx, kase, { kind: N.noEmail, why: "retrying" }, latest.id);
      return { to: "waiting_customer", reason: `${c.first} is still trying, so RAY waits before writing.`, findings: [], timers: [{ kind: TIMERS.leave, inMs: latest.created_at + LEAVE_MS - ctx.clock.now() }] };
    }
    const r = await sendRecovery(ctx, kase, c, c.cause);
    if (r.sent) {
      return {
        to: "waiting_customer",
        reason: `${c.first} left without paying. RAY sent one email with ${c.situation === "A" ? "the steps and " : ""}a fresh link.`,
        findings: [{ text: `RAY emailed ${c.first} once with a fresh link.`, evidenceRef: r.messageId }],
        timers: [{ kind: TIMERS.noPay, inMs: NO_PAY_MS }],
      };
    }
    note(ctx, kase, { kind: N.noEmail, why: r.why }, kase.id);
    return { to: "waiting_merchant", reason: `${c.first} left without paying. ${r.why}`, findings: [] };
  }

  // A buyer wrote (or sent a voice note, read like text). Their words are
  // data: code checks Razorpay for a payment, and otherwise the merchant gets
  // a reply the model drafted. RAY never answers a buyer on its own.
  async function onBuyerMessage(ctx: EngineContext, kase: Case, e: EngineEvent): Promise<InvestigateResult & { proposals?: ProposedAction[] }> {
    const c = await load(ctx, kase);
    const body = String(e.payload.body ?? "");
    const finding = { text: `${c.first} ${e.payload.voice_note ? "sent a voice note" : "wrote"}: "${body}"`, evidenceRef: e.sourceId };
    const l = await later(ctx, kase, c);
    if (l.paid.length) {
      const r = await onPaid(ctx, kase, c, l);
      if (r.kind === "duplicate") return duplicateStep(r, [finding, ...r.findings]);
      return outcomeStep(ctx, kase, r.o, [finding, ...r.findings], r.fixedItself);
    }
    const blocked = !c.email ? `RAY has no email for ${c.name}.` : null;
    if (blocked) return { to: "waiting_merchant", reason: `${c.first} wrote. ${blocked}`, findings: [finding] };
    const link = linksOnCase(ctx, kase.id).map((id) => ctx.repo.rzpLinks.get(id)).find((x) => x?.status === "created")?.short_url ?? null;
    const facts = await emailFacts(ctx, kase, c, { link, paypal: c.sim.paypalAvailable(kase.merchant_id, c.currency), bank: false });
    const reply = await writeBuyer(ctx, kase, c, "buyer_reply", { ...facts, buyer_message: body, paid: false }, replyEmail(facts));
    note(ctx, kase, { kind: N.reply, message_id: e.sourceId }, e.sourceId);
    return {
      to: "waiting_merchant",
      reason: `${c.first} wrote. RAY doesn't see a payment yet. Want me to send this reply?`,
      findings: [finding, { text: `No payment from ${c.first} for ${c.forLabel} yet.`, evidenceRef: c.p?.id ?? e.sourceId }],
      proposals: [
        { id: newId("prop"), label: `Send reply to ${c.first}`, tool: "send_message", args: messageArgs(c, "status", reply), covered: false },
        // Whatever was already waiting on the merchant (a D request) stays on offer.
        ...(kase.state === "waiting_merchant" ? openProposals(ctx, kase.id).filter((x) => x.tool !== "send_message").map((x) => ({ ...x, id: newId("prop") })) : []),
      ],
    };
  }

  // A MoneySaver transfer the case claimed. Match is code: exact amount and
  // currency plus the invoice reference or the buyer's name is Sure; close
  // but not exact is a near-match and is never acted on.
  function matchTransfer(t: Transfer, c: Ctx): "sure" | "near" | null {
    const ref = c.reference?.toLowerCase();
    const refOk = !!ref && (t.invoice_ref?.toLowerCase() === ref || t.remitter_reference.toLowerCase().includes(ref));
    const last = c.buyer?.name.split(/\s+/).at(-1)?.toLowerCase();
    const nameOk = !!last && last.length > 1 && t.remitter_name.toLowerCase().includes(last);
    if (t.currency !== c.currency) return null;
    if (t.amount === c.amount && (refOk || nameOk)) return "sure";
    if ((refOk || nameOk) && Math.abs(t.amount - c.amount) <= c.amount * 0.05) return "near";
    if (t.amount === c.amount) return "near";
    return null;
  }

  async function attachInvoice(ctx: EngineContext, kase: Case, c: Ctx, t: Transfer, approval?: Approval) {
    return guardedCall(
      "draft_request",
      {
        request: REQUEST_KINDS.invoice,
        text: `Attach ${c.forLabel} (${c.amountBoth}, ${c.name}) to the ${formatMoney(t.amount, t.currency)} bank transfer from ${t.remitter_name} received at ${formatTime(t.received_at)} on ${formatDate(t.received_at)}, so its settlement isn't held.`,
        evidence_refs: [t.id, ...(c.p ? [c.p.id] : [])],
      },
      { adapters: c.a, caseId: kase.id, approval },
    );
  }

  type Step = { to: Case["state"]; reason: string; findings: Finding[]; proposals?: ProposedAction[]; timers?: TimerRequest[]; outcome?: string };

  async function onTransfer(ctx: EngineContext, kase: Case, transferId: string): Promise<Step> {
    const c = await load(ctx, kase);
    const t = c.sim.transfer(transferId);
    if (!t) return { to: kase.state, reason: "RAY couldn't find that transfer.", findings: [] };
    const got = `${formatMoney(t.amount, t.currency)} (${formatMoney(t.base_amount)})`;
    const finding = { text: `A bank transfer of ${got} from ${t.remitter_name} landed in your MoneySaver account at ${formatTime(t.received_at)} (Simulated).`, evidenceRef: t.id };
    const m = matchTransfer(t, c);
    note(ctx, kase, { kind: N.transfer, transfer_id: t.id, match: m }, t.id);
    if (m !== "sure") {
      return {
        to: "waiting_merchant",
        reason: `A ${formatMoney(t.amount, t.currency)} transfer from ${t.remitter_name} came in, but ${c.forLabel} is ${c.amountShown}${t.amount === c.amount ? " and nothing on it names the invoice or the buyer" : ""}. Is it ${c.first}'s payment?`,
        findings: [finding],
        proposals: [{ id: newId("prop"), label: `Attach ${c.forLabel} to this transfer`, tool: "draft_request", args: { request: REQUEST_KINDS.invoice, transfer_id: t.id, text: "near-match", evidence_refs: [t.id] }, covered: false }],
      };
    }
    const findings = [finding];
    if (c.sim.settlement(t.id) === "held") {
      const r = await attachInvoice(ctx, kase, c, t);
      if (!went(r)) return { to: "waiting_merchant", reason: `${c.first} paid by bank transfer, but RAY couldn't attach the invoice: ${r.status === "blocked" ? r.failures[0].reason : "it didn't go through"}`, findings };
      findings.push({ text: `RAY attached ${c.forLabel} to the transfer, so the settlement isn't held (Simulated).`, evidenceRef: r.action.id });
    }
    note(ctx, kase, { kind: N.outcome, outcome: "paid_by_transfer", saved: true, transfer_id: t.id }, t.id);
    return { to: "verifying", reason: `${c.first} paid ${got} by bank transfer ✓`, findings, outcome: "paid_by_transfer" };
  }

  async function onRiskReview(ctx: EngineContext, kase: Case, cleared: boolean): Promise<InvestigateResult> {
    const c = await load(ctx, kase);
    const line = cleared ? `Razorpay's risk team cleared ${c.first}'s card.` : `Razorpay's risk team kept the block on ${c.first}'s card.`;
    note(ctx, kase, { kind: N.outcome, outcome: cleared ? "review_cleared" : "review_declined", saved: false }, kase.payment_id ?? kase.id);
    ctx.repo.alerts.insert({ id: newId("alert"), merchant_id: kase.merchant_id, case_id: kase.id, kind: "intl_risk_review", text: `${line} ${cleared ? `${c.first} can pay you now.` : ""}`.trim(), channel: "whatsapp", sent_at: ctx.clock.now() });
    return { to: kase.state === "waiting_customer" ? "verifying" : kase.state, reason: line, findings: [{ text: `${line} (Simulated)`, evidenceRef: kase.payment_id ?? kase.id }] };
  }

  // ---- D: the fix request

  type RequestKind = NonNullable<(typeof REQUEST_FOR)[Cause]>;

  function requestDone(c: Ctx, request: RequestKind): boolean {
    const st = c.sim.settings(c.merchant.id);
    if (!st) return false;
    switch (request) {
      case "international_limit":
        return (c.base ?? toInr(c.amount, c.currency) ?? Infinity) <= st.limit_inr;
      case "currency_enable":
        return st.currencies.includes(c.currency);
      case "network_enable":
        return true;
      case "billing_details":
        return st.billing_address_required;
      default:
        return st.international_on;
    }
  }

  const REQUEST_LABEL: Record<RequestKind, string> = {
    international_limit: "limit request",
    currency_enable: "currency request",
    network_enable: "card network request",
    billing_details: "billing details change",
    other: "request to take cards from abroad",
  };

  // ₹ lost so far: declined payments with this cause in 30 days, not paid since.
  function lost(ctx: EngineContext, kase: Case, cause: Cause) {
    const since = ctx.clock.now() - LOST_WINDOW_MS;
    const cases = ctx.repo.cases
      .list(and(eq(s.cases.merchant_id, kase.merchant_id), eq(s.cases.moment, "international"), eq(s.cases.cause, cause)))
      .filter((x) => x.opened_at >= since && !x.counts_as_saved);
    const pays = cases.map((x) => (x.payment_id ? ctx.repo.rzpPayments.get(x.payment_id) : undefined)).filter((p) => !!p);
    return { total: pays.reduce((n, p) => n + (p.currency === "INR" ? p.amount : (p.base_amount ?? 0)), 0), count: pays.length, ids: pays.map((p) => p.id) };
  }

  async function requestProposals(ctx: EngineContext, kase: Case): Promise<{ summary: string; proposals: ProposedAction[] }> {
    const c = await load(ctx, kase);
    const p = c.p!;
    const cause = c.cause!;
    const request = REQUEST_FOR[cause]!;
    const st = c.sim.settings(kase.merchant_id);
    const limit = st ? formatMoney(st.limit_inr) : "your limit";
    const lostSoFar = lost(ctx, kase, cause);
    const line = causeLine(cause, { first: c.first, limit, currency: c.currency });
    const ask = {
      international_limit: `raise the international card limit to at least ${formatMoney(c.base ?? 0)}`,
      currency_enable: `turn on ${c.currency} payments`,
      network_enable: "turn on this card network",
      billing_details: "ask for the billing address at checkout",
      other: "turn on card payments from abroad",
    }[request];
    const facts = {
      merchant: c.merchant.name,
      buyer: c.name,
      buyer_type: c.buyerType,
      amount: c.amountBoth,
      for: c.forLabel,
      what_happened: line,
      current_limit: limit,
      ask,
      lost_so_far: formatMoney(lostSoFar.total),
      declined_payments: lostSoFar.count,
    };
    const fallback = `${c.name} tried to pay ${c.amountBoth} for ${c.forLabel} by card from abroad, and Razorpay declined it: ${line.charAt(0).toLowerCase()}${line.slice(1)} Please ${ask} on ${c.merchant.name}'s account so payments like this go through.`;
    const ids = idAliases();
    const r = await aiOf(ctx).write({ audience: "merchant", kind: "request_reason", first_customer_message: false, facts: ids.hide(facts), tone: "Plain", language: "en" }, { caseId: kase.id });
    const reason = r.source !== "fallback" && r.output.draft ? ids.show(r.output.draft) : fallback;
    // The draft: the model's reason, then code's evidence and ₹ lost.
    const text = [
      reason,
      `Evidence: payment ${p.id}, ${c.amountBoth}, declined at ${formatTime(p.created_at)} on ${formatDate(p.created_at)} (${p.error_reason ?? "no reason given"}).`,
      `Lost so far: ${formatMoney(lostSoFar.total)} across ${lostSoFar.count} declined payment${lostSoFar.count === 1 ? "" : "s"} in 30 days.`,
    ].join("\n\n");
    const evidence = [...new Set([p.id, ...lostSoFar.ids])];
    note(ctx, kase, { kind: N.requestDraft, request, text }, p.id);

    const args = (next: "bank_details" | "paypal_link" | null) => ({ request, text, evidence_refs: evidence, draft: text, next });
    const b2bOrTie = c.buyerType !== "b2c";
    const account = c.sim.account(kase.merchant_id, c.currency);
    const paypal = c.sim.paypalAvailable(kase.merchant_id, c.currency);
    const label = REQUEST_LABEL[request];
    const proposals: ProposedAction[] = [];
    let question = `Want me to send the ${label}?`;
    if (account && b2bOrTie && c.email) {
      const facts2 = await emailFacts(ctx, kase, c, { link: null, paypal: false, bank: true });
      const body = await writeBuyer(ctx, kase, c, `buyer_recovery_${cause}_bank`, { ...facts2, what_happened: buyerReason(cause) }, recoveryEmail(cause, facts2));
      proposals.push({
        id: newId("prop"),
        label: "Approve request & send bank details",
        tool: "draft_request",
        args: { request, text, evidence_refs: evidence, next: "bank_details" },
        covered: false,
        followUps: [{ tool: "send_message", args: messageArgs(c, "recovery_link", body) }],
      });
      question = `Approve the ${label}, and send ${c.first} your MoneySaver bank details to pay by transfer meanwhile?`;
    }
    if (paypal && c.email && (c.buyerType === "b2c" || !account)) {
      proposals.push({
        id: newId("prop"),
        label: "Approve request & send PayPal link",
        tool: "draft_request",
        args: args("paypal_link"),
        covered: false,
        // Done on the same tap; the email is written then, with the link in it.
        followUps: [
          { tool: "payment_link", args: { amount: c.amount, currency: c.currency, description: `${c.merchant.name}: ${c.forLabel}` } },
          { tool: "send_message", args: { channel: "email", to: c.email, kind: "recovery_link" } },
        ],
      });
      if (proposals.length === 1) question = `Approve the ${label}, and send ${c.first} a link to pay with PayPal meanwhile?`;
    }
    proposals.push({ id: newId("prop"), label: "Approve request", tool: "draft_request", args: args(null), covered: false });
    return {
      summary: `${c.name}'s ${c.amountBoth} card payment for ${c.forLabel} was declined. ${line} I've drafted a ${label} with the evidence and ${formatMoney(lostSoFar.total)} lost. ${question}`,
      proposals,
    };
  }

  // ---- After a tap

  async function runProposal(ctx: EngineContext, kase: Case, proposal: ProposedAction, approval: Approval) {
    const c = await load(ctx, kase);
    if (proposal.tool === "refund") {
      const r = await guardedCall("refund", proposal.args, { adapters: c.a, caseId: kase.id, approval });
      if (r.status === "held") return { to: "verifying" as const, reason: `${proposal.label}: on hold for 10 min, with Undo.`, timers: [{ kind: TIMERS.refund, inMs: r.runAfter - ctx.clock.now() + 1 }] };
      return { to: "waiting_merchant" as const, reason: r.status === "blocked" ? `A check stopped it: ${r.failures[0].reason}` : "The refund didn't go through." };
    }
    if (proposal.tool === "send_message") {
      const r = await guardedCall("send_message", proposal.args, { adapters: c.a, caseId: kase.id, approval });
      if (!went(r)) return { to: "waiting_merchant" as const, reason: r.status === "blocked" ? `A check stopped it: ${r.failures[0].reason}` : "The email didn't go." };
      return { to: "verifying" as const, reason: `Reply sent to ${c.first} ✓` };
    }
    if (proposal.tool === "draft_request" && proposal.args.request === REQUEST_KINDS.invoice) {
      // The merchant said a near-match transfer is the buyer's.
      const t = c.sim.transfer(String(proposal.args.transfer_id));
      if (!t) return { to: "waiting_merchant" as const, reason: "RAY couldn't find that transfer." };
      const r = await attachInvoice(ctx, kase, c, t, approval);
      if (!went(r)) return { to: "waiting_merchant" as const, reason: "RAY couldn't attach the invoice." };
      note(ctx, kase, { kind: N.outcome, outcome: "paid_by_transfer", saved: true, transfer_id: t.id }, r.action.id);
      return { to: "verifying" as const, reason: `${c.forLabel} attached to the transfer, so the settlement isn't held ✓` };
    }
    if (proposal.tool === "draft_request") {
      const { request, text, evidence_refs } = proposal.args as { request: string; text: string; evidence_refs: string[] };
      const r = await guardedCall("draft_request", { request, text, evidence_refs }, { adapters: c.a, caseId: kase.id, approval });
      if (!went(r)) return { to: "waiting_merchant" as const, reason: r.status === "blocked" ? `A check stopped it: ${r.failures[0].reason}` : "RAY couldn't save the request." };
      note(ctx, kase, { kind: N.requestApproved, request, action_id: r.action.id, until: ctx.clock.now() + REQUEST_TRACK_MS }, r.action.id);
      const timers: TimerRequest[] = [{ kind: TIMERS.request, inMs: REQUEST_CHECK_MS }];
      const next = proposal.args.next;
      let sent = "";
      if (next === "bank_details" || next === "paypal_link") {
        const body = next === "bank_details" ? (proposal.followUps?.find((f) => f.tool === "send_message")?.args.body as string | undefined) : undefined;
        const merchantNote = typeof proposal.args.merchant_note === "string" ? proposal.args.merchant_note : undefined;
        const res = await sendRecovery(ctx, kase, c, c.cause!, { bank: next === "bank_details", approval, body, merchantNote });
        if (res.sent) {
          sent = next === "bank_details" ? ` RAY sent ${c.first} your bank details.` : ` RAY sent ${c.first} a link to pay with PayPal.`;
          timers.push({ kind: TIMERS.noPay, inMs: NO_PAY_MS });
        } else if (res.paid) {
          sent = ` ${c.first} has already paid, so RAY didn't write.`;
        } else {
          sent = ` The email didn't go: ${res.why}`;
        }
      }
      return { to: "verifying" as const, reason: `Request approved. RAY is tracking it and checks daily.${sent}`, timers };
    }
    return { to: "waiting_merchant" as const, reason: "RAY can't do that one." };
  }

  // Every hand-back to the merchant asks one question; it shows on the case.
  const asking = <R extends { to: string; reason: string }>(ctx: EngineContext, kase: Case, r: R): R => {
    if (r.to === "waiting_merchant") note(ctx, kase, { kind: "merchant_question", text: r.reason }, kase.payment_id ?? kase.id);
    return r;
  };

  // ---- The Specialist

  const spec: Specialist = {
    id: "international",
    moment: "international",

    async detect(ctx, e) {
      const a = ctx.adapters;
      if (!a || e.kind !== "webhook") return null;
      const event = String(e.payload.event ?? "");
      if (event === "payment.failed" && e.keys.paymentId) {
        const p = await fetchPayment(a, e.merchantId, e.keys.paymentId);
        if (!p || p.status !== "failed" || !isInternational(p)) return null;
        const sim = createInternationalSim(ctx.db, ctx.clock);
        const cause = sim.signals(p.id)?.risk_hold === "held" ? "risk_hold" : lookup(p.error_reason, p.error_source);
        const buyer = customerByEmail(ctx, e.merchantId, p.email);
        const name = buyer?.name ?? p.email ?? "A buyer";
        const limit = sim.settings(e.merchantId)?.limit_inr;
        const why = cause ? ` ${causeLine(cause, { first: firstNameOf(name), limit: limit ? formatMoney(limit) : undefined, currency: p.currency })}` : "";
        return {
          moment: "international",
          confidence: cause ? "likely" : "unsure",
          alert: `${name}'s ${both(p.amount, p.currency, p.base_amount)} card payment from abroad was declined.${why}`,
          paymentId: p.id,
          ...(cause ? { situation: CAUSES[cause].situation, side: CAUSES[cause].side, cause } : {}),
        };
      }
      if (event === "payment_link.expired") {
        const entity = (e.payload.entities as { payment_link?: { entity?: Link } } | undefined)?.payment_link?.entity;
        const link = entity?.id ? ctx.repo.rzpLinks.get(entity.id) : undefined;
        if (!link || link.payment_id) return null;
        // A link RAY itself sent on a case doesn't open another.
        if (ctx.repo.actions.list(eq(s.actions.tool, "payment_link")).some((x) => x.result?.id === link.id)) return null;
        const buyer = customerByEmail(ctx, e.merchantId, link.email);
        if (link.currency === "INR" && (!buyer || buyer.country === "IN")) return null;
        return { moment: "international", confidence: "likely", situation: "F", side: "customer_or_bank", cause: "left_checkout", alert: `${buyer?.name ?? link.email ?? "A buyer"} didn't pay the ${formatMoney(link.amount, link.currency)} payment link before it expired.` };
      }
      if (event === SIM_EVENTS.noAttempt && typeof e.payload.order_id === "string") {
        const order = ctx.repo.rzpOrders.get(e.payload.order_id);
        if (!order || order.currency === "INR") return null;
        const buyer = customerByEmail(ctx, e.merchantId, order.email);
        return { moment: "international", confidence: "likely", situation: "F", side: "customer_or_bank", cause: "left_checkout", alert: `${buyer?.name ?? order.email ?? "A buyer"} opened checkout for ${formatMoney(order.amount, order.currency)} and left without paying.` };
      }
      return null;
    },

    // Events that belong to an open international case but carry another
    // payment (a retry, PayPal, the fresh link), a MoneySaver transfer, or an
    // account change Razorpay made on a request RAY is tracking.
    async claim(ctx, e) {
      if (e.kind !== "webhook") return null;
      const open = ctx.repo.cases
        .list(and(eq(s.cases.merchant_id, e.merchantId), eq(s.cases.moment, "international")))
        // Closed, no reply: only the engine's late rule (14 days) may take an event.
        .filter((k) => !isFinal(k.state) && k.state !== "unconfirmed")
        .sort((x, y) => y.opened_at - x.opened_at);
      if (!open.length) return null;
      const event = String(e.payload.event ?? "");
      const a = ctx.adapters;
      if (e.keys.paymentId && a && event.startsWith("payment.")) {
        const q = ctx.repo.rzpPayments.get(e.keys.paymentId);
        if (!q) return null;
        const link = ctx.repo.rzpLinks.list(eq(s.rzpLinks.payment_id, q.id))[0];
        for (const k of open) {
          const c = await load(ctx, k);
          if (q.created_at < c.since) continue;
          if (c.orderId && q.order_id === c.orderId) return k.id;
          if (link && linksOnCase(ctx, k.id).includes(link.id)) return k.id;
          if (c.email && normalizeEmail(q.email) === normalizeEmail(c.email) && q.amount === c.amount && q.currency === c.currency) return k.id;
        }
        return null;
      }
      if (event === SIM_EVENTS.transfer && typeof e.payload.transfer_id === "string") {
        const t = createInternationalSim(ctx.db, ctx.clock).transfer(e.payload.transfer_id);
        if (!t) return null;
        let near: string | null = null;
        for (const k of open) {
          const m = matchTransfer(t, await load(ctx, k));
          if (m === "sure") return k.id;
          if (m === "near" && !near) near = k.id;
        }
        return near;
      }
      if (event === SIM_EVENTS.accountUpdated) {
        return open.find((k) => notes(ctx, k.id, N.requestApproved).length && !notes(ctx, k.id, N.requestDone).length)?.id ?? null;
      }
      return null;
    },

    async investigate(ctx, kase, e) {
      // A new message reopens a case that closed with no reply; RAY reads it next.
      if (e.kind === "message_in" && kase.state === "unconfirmed") {
        return { to: "likely", reason: "The buyer wrote again.", findings: [], timers: [{ kind: TIMERS.reopen, inMs: 0 }] };
      }
      if (e.kind === "message_in") return onBuyerMessage(ctx, kase, e);
      if (kase.state === "unconfirmed") return stay(kase, "Closed, no reply. A payment or a message from the buyer reopens it.");
      if (e.kind === "timer" && e.payload.timer_kind === TIMERS.reopen && kase.state === "likely") {
        const last = ctx.repo.caseEvents.listByCase(kase.id).findLast((x) => x.type === "message_in");
        if (last) return onBuyerMessage(ctx, kase, { ...e, kind: "message_in", sourceId: last.evidence_ref ?? last.id, payload: last.payload });
      }
      if (e.kind === "timer") {
        switch (e.payload.timer_kind) {
          case TIMERS.leave:
            return onLeaveCheck(ctx, kase);
          case TIMERS.noPay: {
            if (kase.state !== "waiting_customer") return stay(kase, "Nothing to do.");
            const c = await load(ctx, kase);
            const l = await later(ctx, kase, c);
            if (l.paid.length) {
              const r = await onPaid(ctx, kase, c, l);
              if (r.kind === "duplicate") return duplicateStep(r, r.findings);
              return outcomeStep(ctx, kase, r.o, r.findings, r.fixedItself);
            }
            return { to: "unconfirmed", reason: `${c.first} hasn't paid in 72 hr.`, findings: [] };
          }
          case TIMERS.settle:
            if (kase.state === "waiting_customer" && lastNote(ctx, kase.id, N.outcome)) return { to: "verifying", reason: "Checking it worked.", findings: [] };
            return stay(kase, "Nothing to do.");
          default:
            return stay(kase, "Nothing to do.");
        }
      }
      if (e.kind !== "webhook") return stay(kase, "Nothing to do.");
      const event = String(e.payload.event ?? "");
      const first = !lastNote(ctx, kase.id, N.situation);
      if (first && kase.state === "likely") {
        if (event === "payment.failed" && kase.payment_id) {
          const p = await fetchPayment(adaptersOf(ctx), kase.merchant_id, kase.payment_id);
          if (p) return classify(ctx, kase, e, p);
        }
        if (event === "payment_link.expired") {
          const entity = (e.payload.entities as { payment_link?: { entity?: Link } } | undefined)?.payment_link?.entity;
          return classifyLeft(ctx, kase, e, { linkId: entity?.id });
        }
        if (event === SIM_EVENTS.noAttempt) return classifyLeft(ctx, kase, e, { orderId: String(e.payload.order_id) });
        return stay(kase, "Nothing to do.");
      }
      if (event === "payment.failed" && e.keys.paymentId && e.keys.paymentId !== kase.payment_id) {
        const q = await fetchPayment(adaptersOf(ctx), kase.merchant_id, e.keys.paymentId);
        return q ? onRetry(ctx, kase, q) : stay(kase, "Nothing to do.");
      }
      if (event.startsWith("payment.") || event === "order.paid") {
        const c = await load(ctx, kase);
        const l = await later(ctx, kase, c);
        if (!l.paid.length) return stay(kase, "Nothing new.");
        const r = await onPaid(ctx, kase, c, l);
        if (r.kind === "duplicate") return duplicateStep(r, r.findings);
        return outcomeStep(ctx, kase, r.o, r.findings, r.fixedItself);
      }
      if (event === SIM_EVENTS.transfer) {
        const r = await onTransfer(ctx, kase, String(e.payload.transfer_id));
        if (r.outcome) {
          const o = { outcome: r.outcome, saved: true, ref: "", line: r.reason };
          return outcomeStep(ctx, kase, o, r.findings, false);
        }
        return { to: r.to, reason: r.reason, findings: r.findings, proposals: r.proposals };
      }
      if (event === SIM_EVENTS.riskCleared || event === SIM_EVENTS.riskDeclined) return onRiskReview(ctx, kase, event === SIM_EVENTS.riskCleared);
      return stay(kase, "Nothing new.");
    },

    async decide(ctx, kase) {
      if (kase.situation !== "D" || !isCause(kase.cause) || !REQUEST_FOR[kase.cause]) {
        return { to: "waiting_merchant", reason: "This needs you.", summary: "What should RAY do?" };
      }
      const { summary, proposals } = await requestProposals(ctx, kase);
      const d: Decision & { proposals: ProposedAction[] } = { to: "waiting_merchant", reason: "Needs your tap.", summary, proposals };
      return d;
    },

    async proposeActions(_ctx, _kase, d) {
      return (d as Decision & { proposals?: ProposedAction[] }).proposals ?? [];
    },

    async onApproval(ctx, kase, approval) {
      if (approval.by !== "tap") return { to: "waiting_merchant", reason: "Only your tap approves this." };
      const proposal = openProposals(ctx, kase.id).find((p) => p.id === approval.tap.proposalId);
      if (!proposal) return { to: "waiting_merchant", reason: "RAY can't find what was approved." };
      return runProposal(ctx, kase, proposal, approval);
    },

    async verify(ctx, kase, e): Promise<VerifyResult> {
      const outcome = lastNote(ctx, kase.id, N.outcome);
      if (!e || (e.kind === "timer" && e.payload.timer_kind === TIMERS.close)) {
        if (outcome && readyToClose(ctx, kase)) return { to: "closed", reason: "Done.", outcome: String(outcome.payload.outcome) };
        return { to: "verifying", reason: outcome ? "Checking it worked: RAY waits 30 min in case the buyer paid twice." : "Checking it worked." };
      }
      if (e.kind === "message_in") {
        const r = await onBuyerMessage(ctx, kase, e);
        if (r.to === "verifying") return { to: "verifying", reason: r.reason, timers: closeTimer(ctx, kase) };
        return { to: r.to === "waiting_merchant" ? "waiting_merchant" : "verifying", reason: r.reason, proposals: r.proposals };
      }
      if (e.kind === "timer") {
        const kind = e.payload.timer_kind;
        if (kind === TIMERS.refund) {
          const refund = ctx.repo.actions.list(and(eq(s.actions.case_id, kase.id), eq(s.actions.tool, "refund"))).at(-1);
          if (refund?.status !== "done") return { to: "verifying", reason: "The refund hasn't gone yet." };
          note(ctx, kase, { kind: N.outcome, outcome: "paid_twice_refunded", saved: true }, refund.id);
          return { to: "closed", reason: `Refunded ${formatMoney(Number(refund.args.amount), (await load(ctx, kase)).currency)} ✓`, outcome: "paid_twice_refunded" };
        }
        if (kind === TIMERS.request) {
          const c = await load(ctx, kase);
          const approved = lastNote(ctx, kase.id, N.requestApproved);
          if (!approved || lastNote(ctx, kase.id, N.requestDone)) return { to: "verifying", reason: "Nothing to track." };
          if (requestDone(c, approved.payload.request as RequestKind)) {
            note(ctx, kase, { kind: N.requestDone, request: approved.payload.request }, approved.evidence_ref ?? kase.id);
            return { to: "verifying", reason: "Razorpay made the change you asked for ✓" };
          }
          const more = ctx.clock.now() + REQUEST_CHECK_MS <= Number(approved.payload.until);
          return { to: "verifying", reason: more ? "The request is still open. RAY checks again tomorrow." : "The request is still open after 7 days.", timers: more ? [{ kind: TIMERS.request, inMs: REQUEST_CHECK_MS }] : [] };
        }
        if (kind === TIMERS.noPay) {
          if (outcome) return { to: "closed", reason: "Done.", outcome: String(outcome.payload.outcome) };
          const c = await load(ctx, kase);
          const l = await later(ctx, kase, c);
          if (!l.paid.length) return { to: "unconfirmed", reason: `${c.first} hasn't paid in 72 hr.` };
        } else return { to: "verifying", reason: "Nothing new." };
      }
      const event = String(e.payload.event ?? "");
      if (e.kind === "webhook" && event === SIM_EVENTS.transfer) {
        const r = await onTransfer(ctx, kase, String(e.payload.transfer_id));
        if (r.outcome) return { to: "closed", reason: r.reason, outcome: r.outcome };
        return { to: r.to === "waiting_merchant" ? "waiting_merchant" : "verifying", reason: r.reason, proposals: r.proposals };
      }
      if (e.kind === "webhook" && event === SIM_EVENTS.accountUpdated) {
        const c = await load(ctx, kase);
        const approved = lastNote(ctx, kase.id, N.requestApproved);
        if (approved && !lastNote(ctx, kase.id, N.requestDone) && requestDone(c, approved.payload.request as RequestKind)) {
          note(ctx, kase, { kind: N.requestDone, request: approved.payload.request }, e.sourceId);
          const st = c.sim.settings(kase.merchant_id);
          return { to: "verifying", reason: approved.payload.request === "international_limit" && st ? `Razorpay raised your international limit to ${formatMoney(st.limit_inr)} ✓` : "Razorpay made the change you asked for ✓" };
        }
        return { to: "verifying", reason: "Nothing new." };
      }
      if (e.kind === "webhook" && (event.startsWith("payment.") || event === "order.paid") || (e.kind === "timer" && e.payload.timer_kind === TIMERS.noPay)) {
        const c = await load(ctx, kase);
        const l = await later(ctx, kase, c);
        if (!l.paid.length) return { to: "verifying", reason: "Nothing new." };
        const r = await onPaid(ctx, kase, c, l);
        if (r.kind === "duplicate") return duplicateStep(r, []);
        return { to: "verifying", reason: r.o.line, timers: closeTimer(ctx, kase) };
      }
      return { to: "verifying", reason: "Nothing new." };
    },

    async onPromisedTime() {
      // No time is promised to buyers abroad on this moment.
      return { reason: "No time was promised to the buyer on this case." };
    },

    countsAsSaved(ctx, kase) {
      return lastNote(ctx, kase.id, N.outcome)?.payload.saved === true;
    },

    // The merchant's words redraft the email or the request; they are data.
    // Change: the merchant's words are data for the write job, which redrafts
    // the buyer email and the request reason with the case's real facts; code
    // keeps the request's evidence and ₹ lost. The same card comes back with
    // new proposal ids. An email written only at approval (the PayPal link)
    // carries the note to that write.
    async onChange(ctx, kase, text) {
      const offered = openProposals(ctx, kase.id);
      if (!offered.length) return { reason: "Nothing to redraft." };
      const c = await load(ctx, kase);
      const ids = idAliases();
      const write = async (input: { audience: "buyer" | "merchant"; kind: string; facts: Record<string, unknown> }) => {
        const r = await aiOf(ctx).write(
          { audience: input.audience, kind: input.kind, first_customer_message: false, facts: ids.hide(input.facts), tone: input.audience === "buyer" ? c.settings.tone : "Plain", language: input.audience === "buyer" ? c.lang : "en" },
          { caseId: kase.id },
        );
        return r.source !== "fallback" && r.output.draft ? ids.show(r.output.draft) : null;
      };
      const link = linksOnCase(ctx, kase.id).map((id) => ctx.repo.rzpLinks.get(id)).find((x) => x?.status === "created")?.short_url ?? null;
      const buyerFacts = async (bank: boolean) => ({
        ...(await emailFacts(ctx, kase, c, { link: bank ? null : link, paypal: c.sim.paypalAvailable(kase.merchant_id, c.currency), bank })),
        ...(c.cause ? { what_happened: buyerReason(c.cause) } : {}),
      });
      const emails = new Map<string, string>();
      const redraftEmail = async (kind: string, current: string, bank: boolean) => {
        if (!emails.has(current)) emails.set(current, (await write({ audience: "buyer", kind: `${kind}_redraft`, facts: { ...(await buyerFacts(bank)), current_draft: current, merchant_change: text } })) ?? current);
        return emails.get(current)!;
      };
      const requests = new Map<string, string>();
      const redraftRequest = async (current: string) => {
        if (!requests.has(current)) {
          const [reason, ...rest] = current.split("\n\nEvidence: ");
          const again = await write({ audience: "merchant", kind: "request_reason_redraft", facts: { merchant: c.merchant.name, buyer: c.name, amount: c.amountBoth, for: c.forLabel, current_draft: reason, merchant_change: text } });
          requests.set(current, again ? [again, ...rest].join("\n\nEvidence: ") : current);
        }
        return requests.get(current)!;
      };

      const proposals: ProposedAction[] = [];
      for (const p of offered) {
        const args = { ...p.args };
        if (p.tool === "send_message" && typeof args.body === "string") args.body = await redraftEmail("buyer_reply", args.body, false);
        if (p.tool === "draft_request" && typeof args.text === "string" && args.request !== REQUEST_KINDS.invoice) {
          args.text = await redraftRequest(args.text);
          if (typeof args.draft === "string") args.draft = args.text;
          if (args.next === "paypal_link") args.merchant_note = text;
        }
        const followUps = p.followUps
          ? await Promise.all(
              p.followUps.map(async (f) =>
                f.tool === "send_message" && typeof f.args.body === "string" ? { ...f, args: { ...f.args, body: await redraftEmail("buyer_recovery", f.args.body, p.args.next === "bank_details") } } : f,
              ),
            )
          : undefined;
        proposals.push({ ...p, id: newId("prop"), args, ...(followUps ? { followUps } : {}) });
      }
      const request = proposals.find((p) => p.tool === "draft_request" && typeof p.args.text === "string" && p.args.request !== REQUEST_KINDS.invoice);
      if (request) note(ctx, kase, { kind: N.requestDraft, request: request.args.request, text: request.args.text, redrafted: true }, kase.payment_id ?? kase.id);
      return { reason: "RAY redrafted it with your note.", proposals };
    },
  };

  const investigate = spec.investigate.bind(spec);
  const verify = spec.verify.bind(spec);
  const onApproval = spec.onApproval.bind(spec);
  spec.investigate = async (ctx, kase, e) => asking(ctx, kase, await investigate(ctx, kase, e));
  spec.verify = async (ctx, kase, e) => asking(ctx, kase, await verify(ctx, kase, e));
  spec.onApproval = async (ctx, kase, approval) => asking(ctx, kase, await onApproval(ctx, kase, approval));
  return spec;
}

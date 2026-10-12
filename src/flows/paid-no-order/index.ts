// Moment 1: paid, no order (build guide Step 7). The Specialist for every
// situation A to F. Matching and situations are code, against Razorpay's own
// records; the investigate loop finds whose side a store failure is on;
// decide orders the merchant's options; understand, converse, write and
// verify read and write the conversation. Money only moves through
// guardedCall, after a tap or under an approved rule.
//
//   A  authorised, not captured      capture (rule, else ask with time left),
//                                     or let it go back: return date + pay-again link
//   B  captured, store order unpaid   Mark paid & ship, or refund (merchant decides)
//   C  failed, bank debited, polling  "checking with your bank" + new link; reversal
//                                     date once polling ends; can turn into B or E
//   D  payment and order both there   resend the confirmation (runs alone)
//   E  paid twice                     refund the extra one (tap or duplicate rule)
//   F  no match                       ask for a screenshot or UPI reference;
//                                     a person after two tries
import { and, eq, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import type { Payment } from "@/adapters/razorpay";
import { firstNameOf } from "@/adapters/voice";
import { createAi, type Ai } from "@/ai";
import { createReadTools } from "@/tools";
import type { Candidate, CodeMatch } from "@/ai/jobs/converse";
import * as s from "@/db/schema";
import { normalizeEmail, normalizePhone } from "@/engine/events";
import { openProposals } from "@/engine/orchestrator";
import {
  CALL_TIMER,
  PROMISED_TIME_TIMER,
  type Approval,
  type Decision,
  type EngineContext,
  type Finding,
  type InvestigateResult,
  type ProposedAction,
  type Specialist,
  type TimerRequest,
} from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { CAPTURE_RULE_TEXT } from "@/engine/setup-rules";
import { caseFacts, formatDate, formatMoney, formatTime, guardedCall, type GuardedResult } from "@/guards";
import { CAPTURE_TIMEOUT_MS } from "@/guards/checks";
import { idAliases } from "../shared/stable-ids";
import {
  adaptersOf,
  customerOf,
  inbound,
  messageArgs,
  outbound,
  paymentBits,
  recipientOf,
  send,
  settingsOf,
  went,
  type Customer,
  type MessageArgs,
} from "./customer";
import { CAUSES, diagnose, isCause } from "./diagnose";
import * as L from "./lines";
import { duplicatesOf, matchClaim, recentPayments, type Claim, type MatchResult } from "./match";
import { fulfilFor, isPaidFor, orderNumberGuess, ordersWithPayment, readStoreOrder, type StoreRead } from "./store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Detection and timers (Step 7).
export const CONFIRM_MS = 15 * MIN; // connector still unpaid -> Confirmed
export const CUSTOMER_MS = 30 * MIN; // first message to the customer, if opted in
export const HEAL_MS = 2 * HOUR; // healed before RAY acted -> Fixed itself
export const ARRIVAL_MS = 48 * HOUR; // "did it arrive?" after fulfil
export const NO_REPLY_MS = 72 * HOUR; // no reply -> Closed, no reply
export const PROMISE_MS = 2 * HOUR; // "You'll hear from us by ..."
export const POLLING_MS = 3 * DAY; // Razorpay polls the bank for a failed payment
// Banks return money within 5 to 7 working days; the date RAY gives is 7 days.
export const BANK_RETURN_MS = 7 * DAY;
export const ASK_TRIES = 2; // then a person

export const TIMERS = {
  confirm: "confirm_check",
  customer: "customer_message",
  heal: "heal_check",
  arrival: "arrival_check",
  noReply: "no_reply",
  polling: "polling_end",
  refund: "refund_check",
  bankReturn: "bank_return",
} as const;

// Flow bookkeeping on the timeline (case_events notes, payload.kind).
const N = {
  situation: "pno_situation",
  understood: "pno_understood",
  ask: "pno_ask",
  promise: "pno_promise_sent",
  arrived: "pno_arrived",
  brief: "pno_developer_brief",
  noConnector: "pno_no_connector",
  person: "pno_to_person",
  resolution: "pno_resolution",
  wrongMatch: "pno_wrong_match",
  proof: "pno_dispute_proof",
} as const;
export const DEVELOPER_BRIEF_NOTE = N.brief;

const UPSET = new Set(["angry"]);

export type PaidNoOrderOptions = { ai?: (ctx: EngineContext) => Ai };

type Situation = (typeof s.SITUATIONS)[number];

export function createPaidNoOrderSpecialist(opts: PaidNoOrderOptions = {}): Specialist {
  const aiOf = opts.ai ?? ((ctx: EngineContext) => createAi({ repo: ctx.repo }));
  // understand is asked once per message; detect and investigate share it.
  const understood = new Map<string, Awaited<ReturnType<Ai["understand"]>>>();

  // ---- Small helpers

  const note = (ctx: EngineContext, kase: Case, payload: Record<string, unknown>, ref: string) =>
    ctx.repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: ctx.clock.now(), type: "note", payload, evidence_ref: ref });
  const notes = (ctx: EngineContext, caseId: string, kind: string) => ctx.repo.caseEvents.listByCase(caseId).filter((e) => e.payload.kind === kind);
  const lastNote = (ctx: EngineContext, caseId: string, kind: string) => notes(ctx, caseId, kind).at(-1);
  const stay = (kase: Case, reason: string, findings: Finding[] = []): InvestigateResult => ({ to: kase.state, reason, findings });
  const fresh = (ctx: EngineContext, kase: Case) => ctx.repo.cases.get(kase.id)!;

  async function paymentOf(a: Adapters, kase: Case): Promise<Payment | null> {
    if (!kase.payment_id) return null;
    try {
      return await a.razorpay(kase.merchant_id).fetchPayment(kase.payment_id);
    } catch {
      return null;
    }
  }

  async function understand(ctx: EngineContext, messageId: string, text: string, caseId: string | null) {
    const hit = understood.get(messageId);
    if (hit) return hit;
    const r = await aiOf(ctx).understand({ text }, { caseId });
    understood.set(messageId, r);
    return r;
  }

  function language(ctx: EngineContext, kase: Case, customer: Customer | null): L.Lang {
    const u = lastNote(ctx, kase.id, N.understood);
    return L.langOf((u?.payload.language as string | undefined) ?? customer?.language);
  }

  // The time a promise names, as a timer on the case so the number is in
  // the case data the message is checked against.
  const timeLabel = (at: number, now: number) => (formatDate(at) === formatDate(now) ? formatTime(at) : `${formatTime(at)} on ${formatDate(at)}`);

  // The time promised to the customer, set before the message that quotes
  // it (so the number is case data). Replaces any earlier promise.
  function promiseAt(ctx: EngineContext, kase: Case, due: number) {
    for (const t of ctx.repo.timers.list(and(eq(s.timers.case_id, kase.id), eq(s.timers.kind, PROMISED_TIME_TIMER)))) {
      if (t.fired_at === null && t.cancelled_at === null) ctx.repo.timers.update(t.id, { cancelled_at: ctx.clock.now() });
    }
    const t = ctx.repo.timers.insert({ id: newId("tmr"), case_id: kase.id, kind: PROMISED_TIME_TIMER, due_at: due });
    ctx.repo.cases.update(kase.id, { promised_by: due });
    note(ctx, kase, { kind: "timer_set", timer_kind: PROMISED_TIME_TIMER, due_at: due }, t.id);
    return t;
  }

  function storeOrderNumber(read: StoreRead | null, guess: string | null) {
    return read?.kind === "found" ? (read.order.number.startsWith("#") ? read.order.number : `#${read.order.number}`) : guess;
  }

  async function context(ctx: EngineContext, kase: Case) {
    const a = adaptersOf(ctx);
    const p = await paymentOf(a, kase);
    const customer = customerOf(ctx, kase, p);
    const read = p ? await readStoreOrder(a, kase.merchant_id, p) : null;
    const guess = p ? await orderNumberGuess(a, kase.merchant_id, p) : null;
    const order = storeOrderNumber(read, guess);
    const settings = settingsOf(ctx, kase);
    const lang = language(ctx, kase, customer);
    return { a, p, customer, read, order, settings, lang, merchant: ctx.repo.merchants.get(kase.merchant_id)! };
  }

  // Sets the case's payment and what follows from it (only case fields, never state).
  function attachPayment(ctx: EngineContext, kase: Case, p: Payment) {
    ctx.repo.cases.update(kase.id, { payment_id: p.id, amount: p.currency === "INR" ? p.amount : (p.base_amount ?? p.amount) });
  }

  async function writeDraft(
    ctx: EngineContext,
    kase: Case,
    input: { audience: "customer" | "developer"; kind: string; language: string; extra?: Record<string, unknown> },
    fallback: string,
  ): Promise<string> {
    const ids = idAliases();
    const settings = settingsOf(ctx, kase);
    const facts = ids.hide({ ...caseFacts(ctx.db, kase.id), sign_off: settings.signOff, ...input.extra });
    const r = await aiOf(ctx).write(
      { audience: input.audience, kind: input.kind, first_customer_message: false, facts, tone: settings.tone, language: input.language },
      { caseId: kase.id },
    );
    return r.source !== "fallback" && r.output.draft ? ids.show(r.output.draft) : fallback;
  }

  // ---- Talking to the customer

  // The promise line, once per payment: checkable details, no link, and
  // the time they'll hear back by. A reply when they wrote in; otherwise
  // the approved template (with the call line when a call may follow).
  async function sendPromise(ctx: EngineContext, kase: Case, opts2: { proactive: boolean }): Promise<{ timers: TimerRequest[]; sent: boolean; blocked?: string }> {
    if (notes(ctx, kase.id, N.promise).length) return { timers: [], sent: false };
    const c = await context(ctx, kase);
    if (!c.p) return { timers: [], sent: false };
    const r = recipientOf(ctx, kase, c.customer, c.p);
    if (!r) return { timers: [], sent: false };
    const now = ctx.clock.now();
    const due = now + PROMISE_MS;
    // The promised time goes on the case first, so the message can quote it.
    const promiseTimer = promiseAt(ctx, kase, due);
    const bits = paymentBits(c.p, c.customer, c.order);
    const by = timeLabel(due, now);
    const downtime = await hadDowntime(c.a, kase, c.p);
    // A call may follow only after a text that says so, to someone who opted in.
    const callable = opts2.proactive && r.channel === "whatsapp" && !!c.customer && c.a.messaging.consent(c.customer.id, "call") === "opted_in";
    const params: Record<string, string> = {
      name: bits.name,
      merchant: c.merchant.name,
      amount: bits.amount,
      time: bits.time,
      date: bits.date,
      utr_last4: c.p.utr ? c.p.utr.slice(-4) : (c.p.card_last4 ?? ""),
      update_by: by,
    };
    const body = L.promiseLine(bits, by, c.settings.signOff, c.lang, downtime) + (callable ? " If we don't hear back from you by then, we'll call you from this number." : "");
    const args = messageArgs(ctx, kase, r, "promise_line", body, { id: callable ? "payment_seen_promise_call" : "payment_seen_promise", params });
    const res = await send(ctx, kase, args);
    if (!went(res)) {
      ctx.repo.timers.update(promiseTimer.id, { cancelled_at: now });
      ctx.repo.cases.update(kase.id, { promised_by: null });
      return { timers: [], sent: false, blocked: res.status === "blocked" ? res.failures[0].reason : "the message didn't go" };
    }
    note(ctx, kase, { kind: N.promise, due_at: due, call_may_follow: callable }, res.action.id);
    const timers: TimerRequest[] = [];
    if (callable) timers.push({ kind: CALL_TIMER, inMs: PROMISE_MS });
    return { timers, sent: true };
  }

  async function hadDowntime(a: Adapters, kase: Case, p: Payment) {
    const r = await createReadTools(a, kase.merchant_id)("get_downtimes", p.id);
    return r.evidence_ids.length > 0;
  }

  async function downtimeFinding(a: Adapters, kase: Case, p: Payment): Promise<Finding[]> {
    const r = await createReadTools(a, kase.merchant_id)("get_downtimes", p.id);
    const rows = (r.data ?? []) as { id: string; method: string; bank: string | null }[];
    return rows.slice(0, 1).map((d) => ({
      text: `There was a ${d.method.toUpperCase()} outage${d.bank ? ` at ${d.bank}` : ""} when the payment was made.`,
      evidenceRef: d.id,
    }));
  }

  // ---- Situations

  // What the payment and the store say, in code. Returns the step to take.
  async function assess(ctx: EngineContext, kase: Case, p: Payment, reason: string): Promise<InvestigateResult> {
    const a = adaptersOf(ctx);
    attachPayment(ctx, kase, p);
    kase = fresh(ctx, kase);
    const payments = await recentPayments(a, kase.merchant_id, ctx.clock.now());
    const amount = formatMoney(p.amount, p.currency);
    const at = `${formatTime(p.created_at)} on ${formatDate(p.created_at)}`;
    const situationNote = (situation: Situation, extra: Record<string, unknown> = {}) => note(ctx, kase, { kind: N.situation, situation, payment_id: p.id, ...extra }, p.id);

    if (p.status === "captured") {
      const dups = duplicatesOf(payments, p);
      if (dups.length) {
        const all = [p, ...dups].sort((x, y) => x.created_at - y.created_at);
        const linked = ordersWithPayment(a, kase.merchant_id, p.id).length ? p : dups.find((d) => ordersWithPayment(a, kase.merchant_id, d.id).length);
        const extra = all.find((x) => x.id !== (linked ?? all[0]).id)!;
        situationNote("E", { extra_payment_id: extra.id, kept_payment_id: (linked ?? all[0]).id });
        return {
          to: "confirmed",
          reason: `Paid twice: two payments of ${amount} from the same customer.`,
          situation: "E",
          side: "customer_or_bank",
          confidence: "sure",
          cause: "paid_twice",
          findings: all.map((x) => ({ text: `Razorpay captured ${formatMoney(x.amount)} at ${formatTime(x.created_at)} on ${formatDate(x.created_at)}.`, evidenceRef: x.id })),
        };
      }
      const read = await readStoreOrder(a, kase.merchant_id, p);
      if (read.kind === "found") ctx.repo.cases.update(kase.id, { store_order_id: read.order.id });
      if (read.kind === "found" && isPaidFor(read.order, p)) return situationD(ctx, fresh(ctx, kase), p, read.order);
      situationNote("B");
      if (read.kind === "no_connector") {
        note(ctx, kase, { kind: N.noConnector }, p.id);
        return {
          to: "confirmed",
          reason: "Razorpay has the payment, but RAY can't see your store to check the order.",
          situation: "B",
          confidence: "likely",
          findings: [{ text: `Razorpay captured ${amount} at ${at}. RAY can't see your store to check the order.`, evidenceRef: p.id }],
        };
      }
      const c = await context(ctx, fresh(ctx, kase));
      const d = await diagnose(ctx, a, aiOf(ctx), fresh(ctx, kase), p, c.order);
      ctx.repo.cases.update(kase.id, { razorpay_plugin: d.razorpayPlugin, covered: d.side === "razorpay" });
      const findings = [...d.findings, ...(await downtimeFinding(a, kase, p))];
      if (d.side === "merchant" && isCause(d.cause)) await developerBrief(ctx, fresh(ctx, kase), d.cause, findings);
      return {
        to: "confirmed",
        reason: d.cause && isCause(d.cause) ? CAUSES[d.cause].merchant : reason,
        situation: "B",
        side: d.side ?? undefined,
        cause: d.cause ?? undefined,
        confidence: d.confidence,
        findings,
      };
    }

    if (p.status === "authorized") {
      situationNote("A");
      return {
        to: "confirmed",
        reason: "The bank paid, but the payment was never captured.",
        situation: "A",
        side: "merchant",
        confidence: "sure",
        cause: "not_captured",
        findings: [
          { text: `Razorpay has ${amount} from ${at} authorised but not captured. If it isn't captured by ${formatDate(p.created_at + CAPTURE_TIMEOUT_MS)}, it goes back to the customer.`, evidenceRef: p.id },
          ...(await downtimeFinding(a, kase, p)),
        ],
      };
    }

    // Failed at Razorpay; the bank may still have debited it (C).
    situationNote("C");
    return situationC(ctx, kase, p);
  }

  // What code has just established goes on the case at once, so a message
  // sent in the same step is checked against it (Unsure only asks).
  function settle(ctx: EngineContext, kase: Case, fields: Partial<Pick<Case, "confidence" | "situation" | "side">>) {
    ctx.repo.cases.update(kase.id, fields);
    return fresh(ctx, kase);
  }

  async function situationD(ctx: EngineContext, kase: Case, p: Payment, order: { id: string; number: string; status: string }): Promise<InvestigateResult> {
    note(ctx, kase, { kind: N.situation, situation: "D", payment_id: p.id }, p.id);
    kase = settle(ctx, kase, { confidence: "sure", situation: "D", side: "customer_or_bank" });
    const c = await context(ctx, kase);
    const findings = [
      { text: `Razorpay captured ${formatMoney(p.amount)} and order ${c.order} already has it (${order.status}).`, evidenceRef: order.id },
    ];
    const r = recipientOf(ctx, kase, c.customer, c.p);
    if (r) {
      const bits = paymentBits(p, c.customer, c.order);
      const res = await send(ctx, kase, messageArgs(ctx, kase, r, "resend_confirmation", L.resendLine(bits, order.status, c.settings.signOff, c.lang), {
        id: "order_update",
        params: { name: bits.name, order: c.order ?? order.number, merchant: c.merchant.name, status: order.status },
      }));
      if (!went(res)) return { to: "waiting_merchant", reason: "RAY couldn't resend the confirmation.", situation: "D", confidence: "sure", findings };
    }
    return {
      to: "waiting_customer",
      reason: "The payment and the order are both there; RAY resent the confirmation.",
      situation: "D",
      side: "customer_or_bank",
      confidence: "sure",
      findings,
      timers: [{ kind: TIMERS.noReply, inMs: NO_REPLY_MS }],
    };
  }

  async function situationC(ctx: EngineContext, kase: Case, p: Payment): Promise<InvestigateResult> {
    const a = adaptersOf(ctx);
    // Matched to Razorpay's record: Likely (the bank's side isn't known yet).
    kase = settle(ctx, kase, { confidence: "likely", situation: "C", side: "customer_or_bank" });
    const now = ctx.clock.now();
    const pollingEnd = p.created_at + POLLING_MS;
    const findings: Finding[] = [
      { text: `Razorpay shows ${formatMoney(p.amount)} from ${formatTime(p.created_at)} on ${formatDate(p.created_at)} as failed. Razorpay keeps checking with the bank until ${formatDate(pollingEnd)}.`, evidenceRef: p.id },
      ...(await downtimeFinding(a, kase, p)),
    ];
    if (pollingEnd <= now) return pollingEnded(ctx, kase, p, findings);
    const c = await context(ctx, kase);
    const r = recipientOf(ctx, kase, c.customer, p);
    const timers: TimerRequest[] = [{ kind: TIMERS.polling, inMs: pollingEnd - now }];
    if (r && !notes(ctx, kase.id, N.promise).length) {
      // The promised time is when polling ends.
      const t = promiseAt(ctx, kase, pollingEnd);
      const bits = paymentBits(p, c.customer, c.order);
      const first = await send(ctx, kase, messageArgs(ctx, kase, r, "status", L.bankCheckLine(bits, timeLabel(pollingEnd, now), c.settings.signOff, c.lang, findings.length > 1)));
      if (!went(first)) {
        ctx.repo.timers.update(t.id, { cancelled_at: now });
        return { to: "waiting_merchant", reason: "RAY couldn't write to the customer.", situation: "C", findings };
      }
      note(ctx, kase, { kind: N.promise, due_at: pollingEnd }, first.action.id);
      // Then a new link, in its own message: Razorpay-hosted, in the
      // merchant's name, with what it's for.
      const link = await guardedCall(
        "payment_link",
        { amount: p.amount, description: `${c.merchant.name}: ${c.order ? `order ${c.order}` : "your order"}`, customer: { contact: p.contact ?? undefined, email: p.email ?? undefined } },
        { adapters: a, caseId: kase.id },
      );
      if (link.status === "done" && typeof link.result.short_url === "string") {
        await send(ctx, kase, messageArgs(ctx, kase, r, "recovery_link", L.payAgainLine(bits, c.merchant.name, link.result.short_url, c.settings.signOff, c.lang)));
      }
    }
    return {
      to: "waiting_customer",
      reason: "The payment failed at Razorpay; the bank may still have debited it. RAY is checking with the bank.",
      situation: "C",
      side: "customer_or_bank",
      confidence: "likely",
      cause: "failed_bank_debited",
      findings,
      timers,
    };
  }

  // Polling is over and the payment never went through: the reversal date.
  async function pollingEnded(ctx: EngineContext, kase: Case, p: Payment, findings: Finding[] = []): Promise<InvestigateResult> {
    const c = await context(ctx, kase);
    const now = ctx.clock.now();
    const returnBy = now + BANK_RETURN_MS;
    const t = ctx.repo.timers.insert({ id: newId("tmr"), case_id: kase.id, kind: TIMERS.bankReturn, due_at: returnBy });
    note(ctx, kase, { kind: "timer_set", timer_kind: TIMERS.bankReturn, due_at: returnBy }, t.id);
    const r = recipientOf(ctx, kase, c.customer, p);
    if (r) {
      const bits = paymentBits(p, c.customer, c.order);
      await send(ctx, kase, messageArgs(ctx, kase, r, "status", L.reversalLine(bits, formatDate(returnBy), c.settings.signOff, c.lang)));
    }
    return {
      to: "fixed_itself",
      reason: `Razorpay stopped checking with the bank and the payment never went through. Any debit goes back by ${formatDate(returnBy)}.`,
      situation: "C",
      findings: [...findings, { text: `Razorpay finished checking with the bank: ${formatMoney(p.amount)} never went through.`, evidenceRef: p.id }],
    };
  }

  async function developerBrief(ctx: EngineContext, kase: Case, cause: keyof typeof CAUSES, findings: Finding[]) {
    const fallback = [
      `Cause: ${cause}.`,
      ...findings.map((f) => `- ${f.text} (evidence ${f.evidenceRef})`),
      "Fix: check the Razorpay plugin's webhook settings and that the site answers the webhook URL, then send a test payment and check the order turns Processing.",
    ].join("\n");
    const text = await writeDraft(ctx, kase, { audience: "developer", kind: "developer_brief", language: "en", extra: { cause, findings } }, fallback);
    note(ctx, kase, { kind: N.brief, cause, text }, kase.payment_id ?? kase.id);
  }

  // ---- The customer wrote

  async function onMessage(ctx: EngineContext, kase: Case, e: Parameters<Specialist["investigate"]>[2]): Promise<InvestigateResult> {
    const a = adaptersOf(ctx);
    const text = String(e.payload.body ?? "");
    const u = await understand(ctx, e.sourceId, text, kase.id);
    note(ctx, kase, {
      kind: N.understood,
      language: u.output.language,
      mood: u.output.mood,
      intent: u.output.intent,
      legal_or_chargeback_words: u.output.legal_or_chargeback_words,
      confidence: u.output.confidence,
      source: u.source,
    }, e.sourceId);
    const upset = UPSET.has(u.output.mood) && u.source !== "fallback";
    if (upset) note(ctx, kase, { kind: N.person, why: "upset" }, e.sourceId);

    // Reopened by a new message.
    if (kase.state === "unconfirmed") return { to: "likely", reason: "The customer wrote again.", findings: [], timers: [{ kind: TIMERS.confirm, inMs: 0 }] };

    const p = await paymentOf(a, kase);
    if (p) {
      // A follow-up on a case RAY already has. Writing in skips the wait.
      if (kase.state === "likely") return assess(ctx, kase, p, "The customer wrote in.");
      if (kase.state === "waiting_merchant") {
        const r = await sendPromise(ctx, kase, { proactive: false });
        return { to: "waiting_merchant", reason: upset ? "The customer is upset; this needs you." : "The customer wrote; you still need to decide.", findings: [], timers: r.timers };
      }
      if (kase.state === "waiting_customer" && lastNote(ctx, kase.id, N.situation)?.payload.situation === "C") {
        return stay(kase, "The customer wrote while Razorpay checks with the bank.");
      }
      if (kase.state === "waiting_customer") return { to: "fixed_itself", reason: "The customer answered; the order was already there.", findings: [] };
    }

    const payments = await recentPayments(a, kase.merchant_id, ctx.clock.now());
    const asked = notes(ctx, kase.id, N.ask);
    const pending = asked.at(-1);

    // Answer to the one question about two candidates.
    if (pending?.payload.mode === "converse") {
      const ids = (pending.payload.candidate_ids as string[]) ?? [];
      const candidates = payments.filter((x) => ids.includes(x.id));
      const r = await converseTurn(ctx, kase, candidates, String(e.payload.from));
      if (r.status === "matched") return assess(ctx, kase, r.payment, "The customer's answer matches one payment.");
      return askAgainOrPerson(ctx, kase, candidates, String(e.payload.from), asked.length);
    }

    const claim: Claim = {
      sender: String(e.payload.from),
      amount: u.output.amount === null ? null : Math.round(u.output.amount * 100),
      utr: u.output.utr,
      paymentId: u.output.payment_id,
      at: e.at,
    };
    const m = matchClaim(payments, claim);
    note(ctx, kase, { kind: "pno_match", status: m.status, ...("payment" in m ? { payment_id: m.payment.id } : {}), ...("candidates" in m ? { candidate_ids: m.candidates.map((x) => x.id) } : {}) }, e.sourceId);
    if (m.status === "matched") return assess(ctx, kase, m.payment, "The customer's message matches a payment.");
    if (m.status === "near" || m.status === "ambiguous") return askOneQuestion(ctx, kase, m, claim.sender);
    return noMatch(ctx, kase, asked.filter((x) => x.payload.mode === "proof").length);
  }

  const toCandidate = (p: Payment): Candidate => ({ id: p.id, amount: p.amount / 100, time: `${formatTime(p.created_at)} on ${formatDate(p.created_at)}`, utr_last4: p.utr ? p.utr.slice(-4) : null });

  function thread(ctx: EngineContext, kase: Case) {
    const ids = new Set([...inbound(ctx, kase.id), ...outbound(ctx, kase.id)].map((m) => m.id));
    // In the order they were written, ties on the clock kept in insert order.
    const msgs = ctx.db.select().from(s.messages).orderBy(s.messages.at, sql`rowid`).all().filter((m) => ids.has(m.id));
    return msgs.map((m) => ({ from: m.direction === "in" ? ("customer" as const) : ("business" as const), text: m.body }));
  }

  // A near-match is never acted on: one question, case Unsure.
  async function askOneQuestion(ctx: EngineContext, kase: Case, m: Extract<MatchResult, { candidates: Payment[] }>, sender: string): Promise<InvestigateResult> {
    const ids = idAliases();
    const input = ids.hide({ thread: thread(ctx, kase), candidates: m.candidates.map(toCandidate) });
    const r = await aiOf(ctx).converse(input, () => ({ status: "none" }), { caseId: kase.id });
    const signOff = settingsOf(ctx, kase).signOff;
    // Always as the merchant, with the playbook's sign-off.
    const question = r.source !== "fallback" && r.output.kind === "question" && r.output.question ? `${ids.show(r.output.question)} ${signOff}` : null;
    const findings = m.candidates.map((p) => ({ text: `A payment close to what the customer described: ${formatMoney(p.amount)} at ${formatTime(p.created_at)} on ${formatDate(p.created_at)}.`, evidenceRef: p.id }));
    const c = await context(ctx, kase);
    promiseAt(ctx, kase, ctx.clock.now() + PROMISE_MS);
    const fallback = L.askProofLine(firstNameOf(c.customer?.name ?? "there"), timeLabel(ctx.clock.now() + PROMISE_MS, ctx.clock.now()), c.settings.signOff, c.lang, false);
    const sent = await sendQuestion(ctx, kase, question ?? fallback, sender);
    note(ctx, kase, { kind: N.ask, mode: "converse", candidate_ids: m.candidates.map((x) => x.id), question: question ?? fallback }, sent?.action.id ?? kase.id);
    return {
      to: "waiting_customer",
      reason: m.status === "near" ? "A payment is close to what the customer said but doesn't match. RAY asked one question." : "Two payments could match. RAY asked one question.",
      confidence: "unsure",
      findings,
      timers: [{ kind: TIMERS.noReply, inMs: NO_REPLY_MS }],
    };
  }

  async function sendQuestion(ctx: EngineContext, kase: Case, body: string, to: string): Promise<GuardedResult | null> {
    const c = await context(ctx, kase);
    const r = recipientOf(ctx, kase, c.customer, c.p) ?? { channel: to.includes("@") ? ("email" as const) : ("whatsapp" as const), to, windowOpen: true };
    const res = await send(ctx, kase, messageArgs(ctx, kase, r, "question", body));
    return went(res) ? res : null;
  }

  async function converseTurn(ctx: EngineContext, kase: Case, candidates: Payment[], sender: string) {
    const ids = idAliases();
    const input = ids.hide({ thread: thread(ctx, kase), candidates: candidates.map(toCandidate) });
    // Code re-runs the match on every turn: exact UTR, else contact + amount.
    const rematch = (read: { amount: number | null; utr_last4: string | null } | null): CodeMatch => {
      if (!read) return { status: "none" };
      const left = candidates.filter(
        (p) =>
          (read.utr_last4 === null || (p.utr ?? "").endsWith(read.utr_last4)) &&
          (read.amount === null || p.amount === Math.round(read.amount * 100)) &&
          (read.utr_last4 !== null || read.amount !== null),
      );
      const contact = (p: Payment) =>
        (!!p.contact && normalizePhone(p.contact) === normalizePhone(sender)) || (!!p.email && normalizeEmail(p.email) === normalizeEmail(sender));
      if (left.length === 1 && contact(left[0])) return { status: "matched", paymentId: ids.hide(left[0].id) };
      return left.length > 1 ? { status: "ambiguous", candidateIds: left.map((x) => ids.hide(x.id)) } : { status: "none" };
    };
    const r = await aiOf(ctx).converse(input, rematch, { caseId: kase.id });
    // Also a full UTR or payment id in the answer: exact match in code.
    if (r.match.status === "matched") {
      const id = ids.show(r.match.paymentId);
      return { status: "matched" as const, payment: candidates.find((x) => x.id === id)! };
    }
    const lastIn = inbound(ctx, kase.id).at(-1);
    const utr = lastIn?.body.match(/\b\d{12}\b/)?.[0];
    const exact = utr ? candidates.find((p) => p.utr === utr) : undefined;
    if (exact) return { status: "matched" as const, payment: exact };
    return { status: "none" as const };
  }

  async function askAgainOrPerson(ctx: EngineContext, kase: Case, candidates: Payment[], sender: string, tries: number): Promise<InvestigateResult> {
    if (tries >= ASK_TRIES) return toPerson(ctx, kase, "No match after two tries.");
    return askOneQuestion(ctx, kase, { status: "ambiguous", candidates }, sender);
  }

  function toPerson(ctx: EngineContext, kase: Case, why: string): InvestigateResult {
    note(ctx, kase, { kind: N.person, why }, kase.id);
    return { to: "waiting_merchant", reason: `${why} This needs you.`, confidence: "unsure", findings: [] };
  }

  // F: nothing matches at Razorpay.
  async function noMatch(ctx: EngineContext, kase: Case, tries: number): Promise<InvestigateResult> {
    const c = await context(ctx, kase);
    const now = ctx.clock.now();
    const name = firstNameOf(c.customer?.name ?? "there");
    if (tries >= ASK_TRIES) return toPerson(ctx, kase, `${c.customer?.name ?? "The customer"} says they paid, but nothing matches at Razorpay after asking twice.`);
    promiseAt(ctx, kase, now + PROMISE_MS);
    note(ctx, kase, { kind: N.situation, situation: "F" }, kase.id);
    ctx.repo.cases.update(kase.id, { situation: "F" });
    const otherGateway = c.a.store.hasStore(kase.merchant_id) && ctx.repo.storeSettings.get(kase.merchant_id)?.other_gateway;
    const by = timeLabel(now + PROMISE_MS, now);
    if (otherGateway) {
      await sendQuestion(ctx, kase, L.otherGatewayLine(name, by, c.settings.signOff, c.lang), "");
      note(ctx, kase, { kind: N.person, why: "other_gateway" }, kase.id);
      return {
        to: "waiting_merchant",
        reason: "No payment at Razorpay matches. You also take payments through another gateway, so it's likely that gateway's payment. Can you check there?",
        situation: "F",
        confidence: "unsure",
        findings: [{ text: "No payment at Razorpay matches what the customer described.", evidenceRef: inbound(ctx, kase.id).at(-1)?.id ?? kase.id }],
      };
    }
    const sent = await sendQuestion(ctx, kase, L.askProofLine(name, by, c.settings.signOff, c.lang, tries > 0), "");
    note(ctx, kase, { kind: N.ask, mode: "proof", try: tries + 1 }, sent?.action.id ?? kase.id);
    return {
      to: "waiting_customer",
      reason: "No payment at Razorpay matches yet. RAY asked for a screenshot or the UPI reference.",
      situation: "F",
      confidence: "unsure",
      findings: [{ text: "No payment at Razorpay matches what the customer described.", evidenceRef: inbound(ctx, kase.id).at(-1)?.id ?? kase.id }],
      timers: [{ kind: TIMERS.noReply, inMs: NO_REPLY_MS }],
    };
  }

  // ---- Timers before RAY acts

  async function onConfirmCheck(ctx: EngineContext, kase: Case): Promise<InvestigateResult> {
    if (kase.state !== "likely") return stay(kase, "Already past the first check.");
    const a = adaptersOf(ctx);
    const p = await paymentOf(a, kase);
    if (!p) return stay(kase, "No payment on the case yet.");
    const read = await readStoreOrder(a, kase.merchant_id, p);
    if (read.kind === "found" && isPaidFor(read.order, p)) {
      return { to: "fixed_itself", reason: "Your store updated the order on its own.", findings: [{ text: `Order ${read.order.number} has the payment now.`, evidenceRef: read.order.id }] };
    }
    return assess(ctx, kase, p, "The order is still unpaid 15 min later.");
  }

  async function onHeal(ctx: EngineContext, kase: Case): Promise<InvestigateResult> {
    const a = adaptersOf(ctx);
    const acted = ctx.repo.actions.list(eq(s.actions.case_id, kase.id)).some((x) => x.tool !== "send_message" && x.tool !== "payment_link" && ["done", "held"].includes(x.status));
    const p = await paymentOf(a, kase);
    if (acted || !p) return stay(kase, "Nothing to check.");
    const read = await readStoreOrder(a, kase.merchant_id, p);
    if (read.kind === "found" && isPaidFor(read.order, p)) {
      return { to: "fixed_itself", reason: "Fixed itself: your store updated the order before RAY acted.", findings: [{ text: `Order ${read.order.number} has the payment now.`, evidenceRef: read.order.id }] };
    }
    return stay(kase, "Still not fixed at 2 hr.");
  }

  async function onCustomerTimer(ctx: EngineContext, kase: Case): Promise<InvestigateResult> {
    if (!settingsOf(ctx, kase).autoMessages) return stay(kase, "Automatic customer messages are off.");
    const r = await sendPromise(ctx, kase, { proactive: true });
    return { to: kase.state, reason: r.sent ? "RAY told the customer it can see the payment." : `No message went to the customer${r.blocked ? `: ${r.blocked}` : "."}`, findings: [], timers: r.timers };
  }

  // The follow-up call: only after the first text said one may come, only if
  // there's no reply by the promised time, from the merchant's number.
  async function onCall(ctx: EngineContext, kase: Case): Promise<string> {
    const promise = lastNote(ctx, kase.id, N.promise);
    const replied = promise && inbound(ctx, kase.id).some((m) => m.at >= promise.at);
    if (!promise?.payload.call_may_follow) return "No call: the first text didn't say one may come.";
    if (replied) return "No call: the customer replied.";
    const c = await context(ctx, kase);
    if (!c.p || !c.customer?.phone) return "No call: no number.";
    const r = await guardedCall(
      "place_call",
      {
        kind: "paid_no_order_follow_up",
        to: c.customer.phone,
        opening: `Hi ${firstNameOf(c.customer.name)}, this is ${c.merchant.name} about your ${formatMoney(c.p.amount)} payment on ${formatDate(c.p.created_at)}.`,
        lines: ["We can see it on our side, and we're sorting out your order.", "We'll send you the details by text."],
      },
      { adapters: c.a, caseId: kase.id },
    );
    return r.status === "done" ? `Called ${firstNameOf(c.customer.name)}: ${String(r.result.summary ?? "")}` : `The call didn't go: ${r.status === "blocked" ? r.failures[0].reason : r.status}`;
  }

  // A dispute on the payment: proof goes on it automatically once the order
  // was fulfilled; before that, the customer hears from RAY at once.
  async function onDispute(ctx: EngineContext, kase: Case, disputeId: string | null): Promise<string> {
    const fulfilled = ctx.repo.actions
      .list(and(eq(s.actions.case_id, kase.id), eq(s.actions.status, "done")))
      .find((x) => ["mark_paid", "restore_order", "create_order_for_payment"].includes(x.tool));
    if (!fulfilled || !disputeId) {
      if (settingsOf(ctx, kase).autoMessages) await sendPromise(ctx, kase, { proactive: true });
      return "A dispute appeared before the order went out.";
    }
    const messages = [...inbound(ctx, kase.id), ...outbound(ctx, kase.id)].map((m) => m.id);
    const r = await guardedCall(
      "attach_dispute_proof",
      {
        dispute_id: disputeId,
        summary: `Order ${String(fulfilled.result?.number ?? "")} was marked paid and sent after the payment. The customer was told on the case.`,
        documents: { billing_proof: [String(fulfilled.result?.id ?? fulfilled.id)], ...(messages.length ? { customer_communication: messages } : {}) },
      },
      { adapters: adaptersOf(ctx), caseId: kase.id },
    );
    note(ctx, kase, { kind: N.proof, dispute_id: disputeId, status: r.status }, r.action.id);
    return r.status === "done" ? "Proof attached to the dispute." : "RAY couldn't attach proof to the dispute.";
  }

  // ---- Proposals

  const ruleFor = (ctx: EngineContext, kase: Case, match: (j: Record<string, unknown>) => boolean) =>
    ctx.repo.playbookRules
      .list(and(eq(s.playbookRules.merchant_id, kase.merchant_id), eq(s.playbookRules.moment, "paid_no_order"), eq(s.playbookRules.status, "approved")))
      .find((r) => typeof r.rule_json.setting !== "string" && match(r.rule_json));

  async function confirmationFollowUp(ctx: EngineContext, kase: Case, kind: "fulfil_confirmation" | "refund_confirmation", amountOverride?: Payment) {
    const c = await context(ctx, kase);
    const p = amountOverride ?? c.p!;
    const r = recipientOf(ctx, kase, c.customer, p);
    if (!r) return null;
    const bits = paymentBits(p, c.customer, c.order);
    const fallback = kind === "fulfil_confirmation" ? L.fulfilConfirmationLine(bits, c.settings.signOff, c.lang) : L.refundConfirmationLine(bits, c.settings.signOff, c.lang);
    const body = await writeDraft(ctx, kase, { audience: "customer", kind, language: c.lang, extra: { customer_name: bits.name, order: c.order, amount: bits.amount } }, fallback);
    const template =
      kind === "fulfil_confirmation" && c.order && p.utr
        ? { id: "order_confirmed_payment", params: { name: bits.name, merchant: c.merchant.name, amount: bits.amount, time: bits.time, date: bits.date, utr_last4: p.utr.slice(-4), order: c.order } }
        : undefined;
    const args = messageArgs(ctx, kase, r, kind, body, template);
    return { tool: "send_message", args: args as unknown as Record<string, unknown> };
  }

  async function refundProposals(ctx: EngineContext, kase: Case, p: Payment, label: string, primaryCovered = false): Promise<ProposedAction[]> {
    const speed = settingsOf(ctx, kase).refundSpeed;
    const follow = await confirmationFollowUp(ctx, kase, "refund_confirmation", p);
    const followUps = follow ? [follow] : [];
    const out: ProposedAction[] = [
      { id: newId("prop"), label: `${label} ${formatMoney(p.amount)}`, tool: "refund", args: { payment_id: p.id, amount: p.amount, speed }, covered: primaryCovered, followUps },
    ];
    if (speed !== "optimum") {
      out.push({ id: newId("prop"), label: `Make it instant: ${label.toLowerCase()} ${formatMoney(p.amount)}`, tool: "refund", args: { payment_id: p.id, amount: p.amount, speed: "optimum" }, covered: primaryCovered, followUps });
    }
    return out;
  }

  // The customer's claim, when there is one, so the match guard checks it again.
  function claimArgs(ctx: EngineContext, kase: Case, p: Payment) {
    const m = lastNote(ctx, kase.id, "pno_match");
    const msg = inbound(ctx, kase.id).find((x) => x.id === m?.evidence_ref);
    if (!m || m.payload.status !== "matched" || m.payload.payment_id !== p.id || !msg) return {};
    const utr = msg.body.match(/\b\d{12}\b/)?.[0];
    return { match: utr && utr === p.utr ? { sender: msg.from, utr } : { sender: msg.from, contact: msg.from, amount: p.amount, at: msg.at } };
  }

  async function proposalsFor(ctx: EngineContext, kase: Case, situation: Situation | null): Promise<{ summary: string; proposals: ProposedAction[]; ruleId?: string }> {
    const c = await context(ctx, kase);
    const p = c.p!;
    const name = c.customer?.name ?? "A customer";
    const first = firstNameOf(name);
    const amount = formatMoney(p.amount, p.currency);
    const order = c.order ?? "the order";

    if (situation === "E") {
      const sit = lastNote(ctx, kase.id, N.situation)!;
      const extra = await c.a.razorpay(kase.merchant_id).fetchPayment(String(sit.payload.extra_payment_id));
      const rule = ruleFor(ctx, kase, (j) => j.tool === "refund" && j.when === "duplicate" && (typeof j.max !== "number" || extra.amount <= j.max));
      const proposals = await refundProposals(ctx, kase, extra, "Refund the extra");
      return {
        summary: `${name} paid ${formatMoney(extra.amount)} twice for ${order}. Want me to refund the extra ${formatMoney(extra.amount)}?`,
        proposals,
        ruleId: rule?.id,
      };
    }

    if (situation === "A") {
      const rule = ruleFor(ctx, kase, (j) => j.tool === "capture");
      const left = p.created_at + CAPTURE_TIMEOUT_MS - ctx.clock.now();
      const days = Math.floor(left / DAY);
      const hours = Math.floor((left % DAY) / HOUR);
      return {
        summary: `${name}'s bank paid ${amount} for ${order}, but it was never captured. ${days} days ${hours} hr left before Razorpay sends it back. Want me to capture it?`,
        proposals: [
          { id: newId("prop"), label: `Capture ${amount}`, tool: "capture", args: { payment_id: p.id }, covered: false },
          { id: newId("prop"), label: `Let it go back to ${first}`, tool: "none", args: { choice: "let_go" }, covered: false },
        ],
        ruleId: rule && rule.text === CAPTURE_RULE_TEXT ? rule.id : rule?.id,
      };
    }

    // B
    if (notes(ctx, kase.id, N.noConnector).length) {
      return {
        summary: `Likely: please check order ${order}. ${name} paid ${amount} at ${formatTime(p.created_at)}. Is it marked paid in your store?`,
        proposals: [
          { id: newId("prop"), label: "It's paid", tool: "none", args: { choice: "its_paid" }, covered: false },
          { id: newId("prop"), label: "It's not paid", tool: "none", args: { choice: "not_paid" }, covered: false },
        ],
      };
    }
    const fulfil = fulfilFor(c.a, kase.merchant_id, c.read!, p, c.customer?.id ?? null);
    const item = c.read?.kind === "found" ? c.read.order.items[0] : null;
    const stock = item ? `${item.stock} in stock.` : "";
    const cause = kase.cause && isCause(kase.cause) ? CAUSES[kase.cause].merchant : "";
    const status = c.read?.kind === "found" ? c.read.order.status[0].toUpperCase() + c.read.order.status.slice(1) : "not there";
    const what = item ? ` for a ${item.name}` : "";
    const refunds = await refundProposals(ctx, kase, p, "Refund");
    if (!fulfil) {
      const why = c.read?.kind === "unreachable" ? "I can't reach your store to mark it paid." : "I can't fix the order from here.";
      return { summary: `${name} paid ${amount}${what}, but order ${order} is ${status}. ${cause} ${why} Want me to refund ${first}?`.replace(/\s+/g, " "), proposals: refunds };
    }
    const follow = await confirmationFollowUp(ctx, kase, "fulfil_confirmation");
    const fulfilProposal: ProposedAction = {
      id: newId("prop"),
      label: "Mark paid & ship",
      tool: fulfil.tool,
      args: { ...fulfil.args, ...claimArgs(ctx, kase, p) },
      covered: true,
      followUps: follow ? [follow] : [],
    };
    // decide orders the options; the merchant still taps.
    const ai = await aiOf(ctx).decide(
      idAliases().hide({
        moment: "paid_no_order",
        case: { amount, side: kase.side, cause: kase.cause, in_stock: item ? item.stock > 0 : null, confidence: kase.confidence },
        findings: ctx.repo.caseEvents.listByCase(kase.id).filter((e) => e.type === "finding").map((e) => ({ text: String(e.payload.text), evidenceRef: e.evidence_ref ?? "" })),
        playbook: ctx.repo.playbookRules
          .list(and(eq(s.playbookRules.merchant_id, kase.merchant_id), eq(s.playbookRules.moment, "paid_no_order")))
          .filter((r) => typeof r.rule_json.setting !== "string")
          .map((r) => ({ id: r.id, moment: r.moment, text: r.text, status: r.status })),
        memory: [],
      }),
      { caseId: kase.id },
    );
    const refundFirst = ai.source !== "fallback" && ai.output.proposal === "refund";
    const question = refundFirst ? `Want me to refund ${first}?` : `Want me to mark ${order} paid and tell ${first} it's confirmed?`;
    return {
      summary: `${name} paid ${amount}${what}, but order ${order} is still ${status}. ${cause} ${stock} ${question}`.replace(/\s+/g, " ").trim(),
      proposals: refundFirst ? [...refunds, fulfilProposal] : [fulfilProposal, ...refunds],
    };
  }

  // ---- After the tap

  async function runProposal(ctx: EngineContext, kase: Case, proposal: ProposedAction, approval: Approval) {
    const a = adaptersOf(ctx);
    if (proposal.tool === "none") return choice(ctx, kase, String(proposal.args.choice));
    const r = await guardedCall(proposal.tool, proposal.args, { adapters: a, caseId: kase.id, approval });
    if (r.status === "blocked" || r.status === "failed") {
      return { to: "waiting_merchant" as const, reason: r.status === "blocked" ? `A check stopped it: ${r.failures[0].reason}` : `It didn't go through: ${r.error}` };
    }
    if (r.status === "held") {
      return { to: "verifying" as const, reason: `${proposal.label}: on hold for 10 min, with Undo.`, timers: [{ kind: TIMERS.refund, inMs: r.runAfter - ctx.clock.now() }] };
    }
    const action = r.action;
    if (proposal.tool === "capture") {
      const p = (await paymentOf(a, kase))!;
      const read = await readStoreOrder(a, kase.merchant_id, p);
      if (read.kind === "found" && isPaidFor(read.order, p)) return { to: "verifying" as const, reason: "Captured, and your store has the order.", timers: [{ kind: TIMERS.arrival, inMs: ARRIVAL_MS }, { kind: TIMERS.noReply, inMs: NO_REPLY_MS }] };
      const next = await proposalsFor(ctx, fresh(ctx, kase), "B");
      return { to: "waiting_merchant" as const, reason: `Captured ${formatMoney(p.amount)}. ${next.summary}`, proposals: next.proposals };
    }
    if (proposal.tool === "cancel_order") {
      note(ctx, kase, { kind: N.resolution, outcome: "cancelled_wrong_match" }, action.id);
      return { to: "verifying" as const, reason: "Order cancelled." };
    }
    // Fulfilled: flag a second order with the same payment, then the
    // confirmation the merchant approved with the same tap.
    const second = ordersWithPayment(a, kase.merchant_id, String(proposal.args.payment_id));
    if (second.length > 1) note(ctx, kase, { kind: N.wrongMatch, order_ids: second.map((o) => o.id) }, action.id);
    for (const f of proposal.followUps ?? []) {
      const res = await send(ctx, kase, { ...(f.args as MessageArgs), confirms_action_id: action.id }, approval);
      if (!went(res)) return { to: "waiting_merchant" as const, reason: `Order ${String(action.result?.number ?? "")} marked paid ✓, but the message didn't go.` };
    }
    return {
      to: "verifying" as const,
      reason: `Order ${String(action.result?.number ?? "")} marked paid ✓`,
      timers: [{ kind: TIMERS.arrival, inMs: ARRIVAL_MS }, { kind: TIMERS.noReply, inMs: NO_REPLY_MS }],
    };
  }

  async function choice(ctx: EngineContext, kase: Case, which: string) {
    const c = await context(ctx, kase);
    if (which === "its_paid") {
      note(ctx, kase, { kind: N.resolution, outcome: "merchant_says_paid" }, kase.id);
      return { to: "verifying" as const, reason: "You said the order is paid." };
    }
    if (which === "not_paid") {
      return { to: "waiting_merchant" as const, reason: "You said it's not paid. Mark it paid in your store, or RAY can refund.", proposals: await refundProposals(ctx, kase, c.p!, "Refund") };
    }
    if (which === "let_go") {
      // A: the bank gets it back after the capture timeout, at refund speed.
      const p = c.p!;
      const returnBy = p.created_at + CAPTURE_TIMEOUT_MS + (c.settings.refundSpeed === "optimum" ? 0 : BANK_RETURN_MS);
      ctx.repo.timers.insert({ id: newId("tmr"), case_id: kase.id, kind: TIMERS.bankReturn, due_at: returnBy });
      const r = recipientOf(ctx, kase, c.customer, p);
      if (r) {
        const bits = paymentBits(p, c.customer, c.order);
        await send(ctx, kase, messageArgs(ctx, kase, r, "status", L.returnDateLine(bits, formatDate(returnBy), c.settings.signOff, c.lang)));
        const link = await guardedCall("payment_link", { amount: p.amount, description: `${c.merchant.name}: ${c.order ? `order ${c.order}` : "your order"}` }, { adapters: c.a, caseId: kase.id });
        if (link.status === "done" && typeof link.result.short_url === "string") {
          await send(ctx, kase, messageArgs(ctx, kase, recipientOf(ctx, kase, c.customer, p)!, "recovery_link", L.payAgainLine(bits, c.merchant.name, link.result.short_url, c.settings.signOff, c.lang)));
        }
      }
      note(ctx, kase, { kind: N.resolution, outcome: "returned_to_customer" }, kase.id);
      return { to: "verifying" as const, reason: `RAY told ${firstNameOf(c.customer?.name ?? "the customer")} the date the bank returns it, with a pay-again link.` };
    }
    return { to: "waiting_merchant" as const, reason: "RAY noted it." };
  }

  // ---- The Specialist

  return {
    id: "paid_no_order",
    moment: "paid_no_order",

    async detect(ctx, e) {
      const a = ctx.adapters;
      if (!a) return null;
      if (e.kind === "webhook") {
        if (!["payment.captured", "order.paid"].includes(String(e.payload.event)) || !e.keys.paymentId) return null;
        const d = (e.payload.delivery ?? {}) as { http_status?: number | null };
        // No webhook configured: Razorpay sent nothing, only the connector can tell.
        if (d.http_status === null || d.http_status === undefined) return null;
        const failed = d.http_status < 200 || d.http_status >= 300;
        const settings = ctx.repo.storeSettings.get(e.merchantId);
        const report = settings
          ? ctx.db.select().from(s.pluginReports).where(and(eq(s.pluginReports.plugin, settings.plugin), eq(s.pluginReports.plugin_version, settings.plugin_version))).get()
          : undefined;
        if (!failed && !report) return null;
        const p = await a.razorpay(e.merchantId).fetchPayment(e.keys.paymentId).catch(() => null);
        if (!p || p.status !== "captured") return null;
        const who = customerOf(ctx, { id: "", merchant_id: e.merchantId } as Case, p);
        return {
          moment: "paid_no_order",
          confidence: "likely",
          alert: `${who?.name ?? "A customer"} paid ${formatMoney(p.amount, p.currency)}, but the order may not have updated. RAY is checking.`,
          paymentId: p.id,
          amount: p.amount,
        };
      }
      if (e.kind === "store" && e.payload.kind === "paid_order_pending" && e.keys.paymentId) {
        const p = await a.razorpay(e.merchantId).fetchPayment(e.keys.paymentId).catch(() => null);
        if (!p) return null;
        return {
          moment: "paid_no_order",
          confidence: "likely",
          alert: `Order ${String(e.payload.order_number ?? "")} is still unpaid in your store, but Razorpay has ${formatMoney(p.amount)} for it. RAY is checking.`,
          paymentId: p.id,
          amount: p.amount,
          storeOrderId: typeof e.payload.order_id === "string" ? e.payload.order_id : undefined,
        };
      }
      if (e.kind === "message_in") {
        const u = await understand(ctx, e.sourceId, String(e.payload.body ?? ""), null);
        if (u.output.intent !== "paid_no_order") return null;
        return { moment: "paid_no_order", confidence: "unsure", alert: "A customer says they paid but has no order. RAY is checking." };
      }
      return null;
    },

    async investigate(ctx, kase, e) {
      const a = adaptersOf(ctx);
      if (e.kind === "message_in") return onMessage(ctx, kase, e);
      if (e.kind === "webhook" || e.kind === "store") {
        const event = String(e.payload.event ?? "");
        if (event.startsWith("payment.dispute")) {
          const entities = e.payload.entities as { dispute?: { entity?: { id?: string } } } | undefined;
          return stay(kase, await onDispute(ctx, kase, entities?.dispute?.entity?.id ?? null));
        }
        const opened = ctx.repo.caseEvents.listByCase(kase.id).filter((x) => x.type === "webhook").length <= 1 && kase.state === "likely";
        if (opened) {
          return {
            to: "likely",
            reason: `Checking: Razorpay has the payment; RAY looks at your store at ${formatTime(ctx.clock.now() + CONFIRM_MS)}.`,
            findings: [],
            timers: [
              { kind: TIMERS.confirm, inMs: CONFIRM_MS },
              { kind: TIMERS.customer, inMs: CUSTOMER_MS },
              { kind: TIMERS.heal, inMs: HEAL_MS },
            ],
          };
        }
        // A later update on the payment (C turning into B or E during polling).
        const p = await paymentOf(a, kase);
        if (p && kase.state === "waiting_customer" && p.status !== "failed") return assess(ctx, kase, p, "Razorpay has an update on the payment.");
        return stay(kase, "Razorpay sent another update.");
      }
      if (e.kind === "timer") {
        switch (e.payload.timer_kind) {
          case TIMERS.confirm:
            return onConfirmCheck(ctx, kase);
          case TIMERS.customer:
            return onCustomerTimer(ctx, kase);
          case TIMERS.heal:
            return onHeal(ctx, kase);
          case TIMERS.noReply:
            if (kase.state === "waiting_customer" && !inbound(ctx, kase.id).some((m) => m.at > (Number(e.payload.due_at) - NO_REPLY_MS))) {
              return { to: "unconfirmed", reason: "No reply in 72 hr.", findings: [] };
            }
            return stay(kase, "Nothing to do.");
          case TIMERS.polling: {
            const p = await paymentOf(a, kase);
            if (!p || kase.state !== "waiting_customer") return stay(kase, "Nothing to do.");
            if (p.status === "failed") return pollingEnded(ctx, kase, p);
            return assess(ctx, kase, p, "Razorpay finished checking with the bank.");
          }
          case CALL_TIMER:
            return stay(kase, await onCall(ctx, kase));
          default:
            return stay(kase, "Nothing to do.");
        }
      }
      return stay(kase, "Nothing to do.");
    },

    async decide(ctx, kase) {
      const situation = kase.situation;
      // Writing in got a promise line; proactive messages wait for the 30 min timer.
      const promise = inbound(ctx, kase.id).length ? await sendPromise(ctx, kase, { proactive: false }) : { timers: [] as TimerRequest[] };
      const person = notes(ctx, kase.id, N.person).length > 0;
      const { summary, proposals, ruleId } = await proposalsFor(ctx, kase, situation);
      const above = (kase.amount ?? 0) > ctx.repo.merchants.get(kase.merchant_id)!.approval_limit;
      const useRule = ruleId && !person && !above && kase.confidence !== "unsure";
      const d: Decision & { proposals: ProposedAction[] } = useRule
        ? { to: "acting", reason: "An approved rule covers this", summary, ruleId, proposals, timers: promise.timers }
        : { to: "waiting_merchant", reason: person ? "This needs a person." : "Needs your tap.", summary: person ? `${summary} The customer is upset, so this one is yours.` : summary, proposals, timers: promise.timers };
      return d;
    },

    async proposeActions(_ctx, _kase, d) {
      return (d as Decision & { proposals?: ProposedAction[] }).proposals ?? [];
    },

    async onApproval(ctx, kase, approval) {
      const offered = openProposals(ctx, kase.id);
      const proposal =
        approval.by === "tap"
          ? offered.find((p) => p.id === approval.tap.proposalId)
          : offered.find((p) => {
              const rule = ctx.repo.playbookRules.get(approval.ruleId);
              return rule && (rule.rule_json.tool === undefined || rule.rule_json.tool === p.tool);
            });
      if (!proposal) return { to: "waiting_merchant", reason: "RAY can't find what was approved." };
      return runProposal(ctx, kase, proposal, approval);
    },

    async verify(ctx, kase, e) {
      const a = adaptersOf(ctx);
      const resolution = lastNote(ctx, kase.id, N.resolution);
      if (!e) {
        if (resolution) return { to: "closed", reason: "Done.", outcome: String(resolution.payload.outcome) };
        return { to: "verifying", reason: "Checking it worked." };
      }
      // Wrong match after fulfil: another order already has this payment.
      const fulfilled = ctx.repo.actions.list(and(eq(s.actions.case_id, kase.id), eq(s.actions.status, "done"))).find((x) => ["mark_paid", "restore_order", "create_order_for_payment"].includes(x.tool));
      const sharing = fulfilled && kase.payment_id ? ordersWithPayment(a, kase.merchant_id, kase.payment_id) : [];
      if (sharing.length > 1 && !lastNote(ctx, kase.id, "pno_wrong_match_offered")) {
        note(ctx, kase, { kind: N.wrongMatch, order_ids: sharing.map((o) => o.id) }, fulfilled!.id);
        note(ctx, kase, { kind: "pno_wrong_match_offered" }, fulfilled!.id);
        const orderId = String(fulfilled?.result?.id ?? "");
        const order = orderId ? await a.store.getOrder(kase.merchant_id, { id: orderId }).catch(() => null) : null;
        const value = formatMoney(kase.amount ?? 0);
        const proposals: ProposedAction[] =
          order && order.status !== "completed"
            ? [{ id: newId("prop"), label: `Cancel order ${order.number}`, tool: "cancel_order", args: { order_id: order.id, reason: "Payment belongs to another order" }, covered: true }]
            : [{ id: newId("prop"), label: `Claim cover up to ${value}`, tool: "none", args: { choice: "cover" }, covered: true }];
        return { to: "waiting_merchant", reason: `Another order has the same payment, so this may be the wrong match. ${order && order.status !== "completed" ? "It hasn't shipped, so RAY can cancel it." : `It has shipped; the proposed cover is up to ${value}.`}`, proposals };
      }
      if (e.kind === "webhook" && String(e.payload.event ?? "").startsWith("payment.dispute")) {
        const entities = e.payload.entities as { dispute?: { entity?: { id?: string } } } | undefined;
        return { to: "verifying", reason: await onDispute(ctx, kase, entities?.dispute?.entity?.id ?? null) };
      }
      if (e.kind === "timer") {
        const kind = e.payload.timer_kind;
        if (kind === TIMERS.refund) {
          const refund = ctx.repo.actions.list(and(eq(s.actions.case_id, kase.id), eq(s.actions.tool, "refund"))).at(-1);
          if (refund?.status !== "done") return { to: "verifying", reason: "The refund hasn't gone yet." };
          const approval = (refund.guard_result?.approval ?? undefined) as Approval | undefined;
          const proposal = ctx.repo.caseEvents
            .listByCase(kase.id)
            .filter((x) => x.payload.kind === "actions_proposed")
            .flatMap((x) => x.payload.actions as ProposedAction[])
            .findLast((p) => approval?.by === "tap" && p.id === approval.tap.proposalId);
          for (const f of proposal?.followUps ?? []) {
            const res = await send(ctx, kase, { ...(f.args as MessageArgs), confirms_action_id: refund.id }, approval);
            if (!went(res)) return { to: "waiting_merchant", reason: "Refunded ✓, but the message didn't go." };
          }
          return { to: "verifying", reason: `Refunded ${formatMoney(Number(refund.args.amount))} ✓`, timers: [{ kind: TIMERS.noReply, inMs: NO_REPLY_MS }] };
        }
        if (kind === TIMERS.arrival) {
          const c = await context(ctx, kase);
          const r = recipientOf(ctx, kase, c.customer, c.p);
          if (r && c.order) {
            const name = firstNameOf(c.customer?.name ?? "there");
            await send(ctx, kase, messageArgs(ctx, kase, r, "status", L.arrivalCheckLine(name, c.order, c.settings.signOff, c.lang), {
              id: "delivery_check",
              params: { name, merchant: c.merchant.name, order: c.order },
            }));
          }
          return { to: "verifying", reason: "RAY asked if the order arrived." };
        }
        if (kind === TIMERS.noReply) return { to: "unconfirmed", reason: "No reply in 72 hr." };
        if (kind === CALL_TIMER) return { to: "verifying", reason: await onCall(ctx, kase) };
        return { to: "verifying", reason: "Nothing new." };
      }
      if (e.kind === "message_in") {
        const r = await aiOf(ctx).verify(String(e.payload.body ?? ""), { caseId: kase.id });
        if (r.confirmed) {
          note(ctx, kase, { kind: N.arrived }, e.sourceId);
          return { to: "closed", reason: "The customer confirmed it arrived.", outcome: lastNote(ctx, kase.id, N.situation)?.payload.situation === "E" ? "refund_accepted" : "arrived" };
        }
        if (r.source !== "fallback" && r.output.status === "not_arrived") return { to: "waiting_merchant", reason: "The customer says it hasn't arrived." };
        return { to: "verifying", reason: "The reply doesn't say it arrived." };
      }
      return { to: "verifying", reason: "Nothing new." };
    },

    async onPromisedTime(ctx, kase) {
      if (kase.state !== "waiting_merchant") return { reason: "Promised time reached; RAY is already on it." };
      // Nothing refunds on its own: a holding message to the customer and a
      // nudge to the merchant, then a new time.
      const c = await context(ctx, kase);
      const now = ctx.clock.now();
      const r = c.p ? recipientOf(ctx, kase, c.customer, c.p) : null;
      const next = now + PROMISE_MS;
      promiseAt(ctx, kase, next);
      let sent = false;
      if (r && c.p) {
        const bits = paymentBits(c.p, c.customer, c.order);
        const by = timeLabel(next, now);
        const res = await send(ctx, kase, messageArgs(ctx, kase, r, "holding", L.holdingLine(bits, by, c.settings.signOff, c.lang), {
          id: "payment_update_holding",
          params: { name: bits.name, merchant: c.merchant.name, amount: bits.amount, update_by: by },
        }));
        sent = went(res);
      }
      const name = c.customer?.name ?? "The customer";
      ctx.repo.alerts.insert({
        id: newId("alert"),
        merchant_id: kase.merchant_id,
        case_id: kase.id,
        kind: "nudge",
        text: `${name} was promised an update by now. ${sent ? `RAY told ${firstNameOf(name)} it's still being looked at.` : ""} This still needs your tap.`.replace(/\s+/g, " "),
        channel: "whatsapp",
        sent_at: now,
      });
      return { reason: sent ? "Holding message sent and you were nudged." : "You were nudged." };
    },

    countsAsSaved(ctx, kase) {
      return notes(ctx, kase.id, N.arrived).length > 0;
    },

    async onChange(ctx, kase, text) {
      const offered = openProposals(ctx, kase.id);
      if (!offered.length) return { reason: "Nothing to redraft." };
      const c = await context(ctx, kase);
      const redraft = async (args: Record<string, unknown>) => {
        if (typeof args.body !== "string") return args;
        const body = await writeDraft(
          ctx,
          kase,
          { audience: "customer", kind: `${String(args.kind)}_redraft`, language: c.lang, extra: { current_draft: args.body, merchant_change: text } },
          args.body,
        );
        return { ...args, body };
      };
      const proposals: ProposedAction[] = [];
      for (const p of offered) {
        const followUps = p.followUps ? await Promise.all(p.followUps.map(async (f) => (f.tool === "send_message" ? { ...f, args: await redraft(f.args) } : f))) : undefined;
        const args = p.tool === "send_message" ? await redraft(p.args) : p.args;
        proposals.push({ ...p, id: newId("prop"), args, ...(followUps ? { followUps } : {}) });
      }
      return { reason: "RAY redrafted the message with your note.", proposals };
    },
  };
}

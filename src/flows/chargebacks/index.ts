// Moment 4: chargeback (build guide Step 10). The Specialist for situations
// A to F. The dispute.created handler opens the case first, so any draft
// has an open case to log to. Code decides the type, the situation, the
// odds, the expected-value rule, the lane and the deadlines; the investigate
// job reads the evidence (bounded, read-only); money only moves through
// guardedCall, after a tap, or under an automatic lane with every bound.
//
//   A  customer threatens a chargeback   the paid-no-order flow on the same case,
//                                         before a dispute exists; always asks
//   B  fraud or unauthorised              accept if Vulcan flagged (and offer to
//                                         block the card), otherwise ask
//   C  not received / not as described /  contest if Sure, accept if never shipped,
//      cancelled                          ask for quality; customer outreach
//   D  already refunded or duplicate      contest without asking
//   E  pre-arbitration or arbitration     always ask, with the stage fee
//   F  repeat pattern                     the weekly insight; the fix needs a tap
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import type { Dispute, Payment } from "@/adapters/razorpay";
import { firstNameOf, merchantPhone } from "@/adapters/voice";
import { createAi, type Ai } from "@/ai";
import * as s from "@/db/schema";
import { openProposals } from "@/engine/orchestrator";
import type { Approval, ApprovalResult, Decision, EngineContext, Finding, InvestigateResult, ProposedAction, Specialist, TimerRequest, VerifyResult } from "@/engine/specialist";
import { transition, type Case } from "@/engine/state-machine";
import { caseFacts, formatDate, formatMoney, formatTime, guardedCall, type GuardedResult } from "@/guards";
import { clockLabel, minutesIst } from "@/guards/checks";
import { readSettings } from "@/surfaces/playbook";
import { createPaidNoOrderSpecialist } from "../paid-no-order";
import { adaptersOf } from "../paid-no-order/customer";
import { idAliases } from "../shared/stable-ids";
import { customerFor, findEvidence, type Pack } from "./evidence";
import { checkLane, LANE_NAME, LANE_TOOL, LANE_USED_NOTE, laneAccuracy, laneRules, proposeLanes, switchLaneOffAfterWrongCall, type Lane } from "./lanes";
import * as L from "./lines";
import { weeklyInsight } from "./patterns";
import { deadlineOf, disputeType, FINAL_BEFORE_MS, nextStageFee, shouldContest, situationOf, stopWindowEnd, TYPE_LABEL, URGENT_BEFORE_MS, type DisputeType, type Situation } from "./rules";
import { filingOf, FILING_LABEL } from "./sim";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IST_MS = (5 * 60 + 30) * MIN;

export const TIMERS = {
  eve: "cb_deadline_eve",
  final: "cb_deadline_final",
  deadline: "cb_deadline",
  stop: "cb_stop_window",
  call: "cb_urgent_call",
  weekly: "cb_weekly",
} as const;

// Flow bookkeeping on the timeline (case_events notes, payload.kind).
export const N = {
  threat: "cb_threat",
  dispute: "cb_dispute",
  pack: "cb_pack",
  decision: "cb_decision",
  laneUsed: LANE_USED_NOTE,
  fyi: "cb_fyi",
  filed: "cb_filed",
  outreach: "cb_outreach_sent",
  reply: "cb_customer_reply",
  urgent: "cb_urgent_ask",
  deadlineDue: "cb_deadline_due",
  lapsed: "cb_lapsed",
  deadlinePassed: "cb_deadline_passed",
  outcome: "cb_outcome",
  block: "cb_block_card",
  approvedUnchanged: "cb_approved_unchanged",
  stopOffer: "cb_stop_asking_offer",
  replacement: "cb_replacement",
  laneAccuracy: "cb_lane_accuracy",
  agrees: "cb_customer_agrees",
  complaint: "cb_customer_complaint",
} as const;

// Approved unchanged this many times: RAY offers to stop asking for that type.
export const STOP_ASKING_AFTER = 3;
const DISPUTE_EVENTS = ["payment.dispute.created", "payment.dispute.action_required"];
const OUTCOME_EVENTS: Record<string, Outcome> = { "payment.dispute.won": "won", "payment.dispute.lost": "lost", "payment.dispute.closed": "withdrawn" };
type Outcome = "won" | "lost" | "withdrawn" | "accepted";
const SAVED: readonly Outcome[] = ["won", "withdrawn"];

export type ChargebacksOptions = { ai?: (ctx: EngineContext) => Ai };

type DisputeNote = { dispute_id: string; type: DisputeType; situation: Situation; phase: string; deadline: number; onset: number };
type PackNote = Omit<Pack, "candidates" | "findings" | "customer"> & { customer_name: string | null };

export function createChargebacksSpecialist(opts: ChargebacksOptions = {}): Specialist {
  const aiOf = opts.ai ?? ((ctx: EngineContext) => createAi({ repo: ctx.repo }));
  // Situation A reuses the paid-no-order flow on the same case.
  const pno = createPaidNoOrderSpecialist({ ai: opts.ai });

  // ---- Small helpers

  const note = (ctx: EngineContext, kase: Case, payload: Record<string, unknown>, ref: string) =>
    ctx.repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: ctx.clock.now(), type: "note", payload, evidence_ref: ref });
  const notes = (ctx: EngineContext, caseId: string, kind: string) => ctx.repo.caseEvents.listByCase(caseId).filter((e) => e.payload.kind === kind);
  const lastNote = (ctx: EngineContext, caseId: string, kind: string) => notes(ctx, caseId, kind).at(-1);
  const stay = (kase: Case, reason: string, findings: Finding[] = []): InvestigateResult => ({ to: kase.state, reason, findings });
  const fresh = (ctx: EngineContext, kase: Case) => ctx.repo.cases.get(kase.id)!;

  const disputeNote = (ctx: EngineContext, kase: Case) => lastNote(ctx, kase.id, N.dispute)?.payload as unknown as DisputeNote | undefined;
  const packNote = (ctx: EngineContext, kase: Case) => lastNote(ctx, kase.id, N.pack)?.payload as unknown as PackNote | undefined;
  // A threat with no dispute yet: the paid-no-order flow handles it.
  const isThreat = (ctx: EngineContext, kase: Case) => kase.situation === "A" && !disputeNote(ctx, kase);
  // The paid-no-order hooks read the case's situation letter, which means
  // something else in that moment (its A is "authorised, not captured").
  // They get the case with their own situation, from their own notes.
  const asPno = (ctx: EngineContext, kase: Case): Case => ({
    ...kase,
    situation: (lastNote(ctx, kase.id, "pno_situation")?.payload.situation as Case["situation"] | undefined) ?? null,
  });

  const eventName = (e: { kind: string; payload: Record<string, unknown> }) => (e.kind === "webhook" ? String(e.payload.event ?? "") : "");
  const disputeIdIn = (e: { payload: Record<string, unknown> }) =>
    (e.payload.entities as { dispute?: { entity?: { id?: string } } } | undefined)?.dispute?.entity?.id ?? null;

  async function paymentOf(a: Adapters, kase: Case, id: string): Promise<Payment | null> {
    return a.razorpay(kase.merchant_id).fetchPayment(id).catch(() => null);
  }

  function bitsOf(ctx: EngineContext, kase: Case, d: Dispute, dn: DisputeNote): L.DisputeBits {
    const pk = packNote(ctx, kase);
    const who = pk?.customer_name ?? "A customer";
    return { who, first: firstNameOf(who), amount: formatMoney(d.amount), type: dn.type, order: pk?.orderNumber ?? null, deadline: L.when(dn.deadline) };
  }

  function alert(ctx: EngineContext, kase: Case, kind: string, text: string, channel = "whatsapp") {
    return ctx.repo.alerts.insert({ id: newId("alert"), merchant_id: kase.merchant_id, case_id: kase.id, kind, text, channel, sent_at: ctx.clock.now() });
  }

  function cancelTimers(ctx: EngineContext, kase: Case, kinds: string[]) {
    const now = ctx.clock.now();
    const open = ctx.db
      .select()
      .from(s.timers)
      .where(and(eq(s.timers.case_id, kase.id), inArray(s.timers.kind, kinds), isNull(s.timers.fired_at), isNull(s.timers.cancelled_at)))
      .all();
    for (const t of open) ctx.repo.timers.update(t.id, { cancelled_at: now });
  }

  // Next Monday 9 AM IST.
  function nextWeeklyAt(now: number) {
    const ist = new Date(now + IST_MS);
    const days = (8 - ist.getUTCDay()) % 7 || 7;
    const monday = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 9, 0) - IST_MS;
    return monday;
  }

  function weeklyPending(ctx: EngineContext, merchantId: string) {
    return ctx.db
      .select({ id: s.timers.id })
      .from(s.timers)
      .innerJoin(s.cases, eq(s.cases.id, s.timers.case_id))
      .where(and(eq(s.cases.merchant_id, merchantId), eq(s.timers.kind, TIMERS.weekly), isNull(s.timers.fired_at), isNull(s.timers.cancelled_at)))
      .get();
  }

  // ---- A dispute reached the case: open it first, then the pack and the draft.

  async function onDispute(ctx: EngineContext, kase: Case, disputeId: string, at: number): Promise<InvestigateResult & { timers: TimerRequest[] }> {
    const a = adaptersOf(ctx);
    const d = await a.razorpay(kase.merchant_id).fetchDispute(disputeId);
    const type = disputeType(d);
    const situation = situationOf(type, d.phase);
    const now = ctx.clock.now();
    const deadline = deadlineOf(d, at);
    cancelTimers(ctx, kase, [TIMERS.eve, TIMERS.final, TIMERS.deadline, TIMERS.call, TIMERS.stop]);
    proposeLanes(ctx.db, kase.merchant_id);
    const dn: DisputeNote = { dispute_id: d.id, type, situation, phase: d.phase, deadline, onset: at };
    note(ctx, kase, { kind: N.dispute, ...dn }, d.id);
    ctx.repo.cases.update(kase.id, { payment_id: d.payment_id, amount: d.amount, situation });

    const pack = await findEvidence(ctx, a, aiOf(ctx), fresh(ctx, kase), d, type);
    const { candidates: _c, findings, customer, ...rest } = pack;
    void _c;
    note(ctx, kase, { kind: N.pack, ...rest, customer_name: customer?.name ?? null }, d.id);
    // What code knows goes on the case now (so a guard reads it).
    ctx.repo.cases.update(kase.id, { confidence: pack.confidence, side: "customer_or_bank", cause: type, covered: false });

    // The draft: the case is open, so it can be logged. Runs alone.
    if (filingOf(ctx.db, kase.merchant_id) !== "manual" && d.status === "open") {
      await guardedCall("attach_dispute_proof", { dispute_id: d.id, summary: pack.summary, amount: d.amount, documents: pack.documents }, { adapters: a, caseId: kase.id });
    }

    const timers: TimerRequest[] = [];
    const at_ = (due: number) => due - now;
    if (deadline - URGENT_BEFORE_MS > now) timers.push({ kind: TIMERS.eve, inMs: at_(deadline - URGENT_BEFORE_MS) });
    if (deadline - FINAL_BEFORE_MS > now) timers.push({ kind: TIMERS.final, inMs: at_(deadline - FINAL_BEFORE_MS) });
    if (deadline > now) timers.push({ kind: TIMERS.deadline, inMs: at_(deadline) });
    if (!weeklyPending(ctx, kase.merchant_id)) timers.push({ kind: TIMERS.weekly, inMs: at_(nextWeeklyAt(now)) });

    return {
      to: "confirmed",
      reason: `${TYPE_LABEL[type][0].toUpperCase()}${TYPE_LABEL[type].slice(1)} chargeback for ${formatMoney(d.amount)}. Reply due by ${L.when(deadline)}.`,
      findings,
      confidence: pack.confidence,
      situation,
      side: "customer_or_bank",
      cause: type,
      timers,
    };
  }

  // ---- What to do: the expected-value rule, then the lane or the Ask card.

  type Plan = {
    recommend: "contest" | "accept";
    lane: ReturnType<typeof checkLane> | null;
    proposals: ProposedAction[];
    summary: string;
    reason: string;
  };

  async function planFor(ctx: EngineContext, kase: Case, opts2: { atDeadline?: boolean } = {}): Promise<Plan> {
    const a = adaptersOf(ctx);
    const dn = disputeNote(ctx, kase)!;
    const pk = packNote(ctx, kase)!;
    const d = await a.razorpay(kase.merchant_id).fetchDispute(dn.dispute_id);
    const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
    const now = ctx.clock.now();
    const fee = nextStageFee(d.phase, d.network);
    const evContest = shouldContest(pk.odds, d.amount, fee);
    const b = bitsOf(ctx, kase, d, dn);

    let recommend: "contest" | "accept" = evContest ? "contest" : "accept";
    if (dn.type === "fraud" && pk.facts.fraud?.vulcan === "flagged") recommend = "accept";
    if (dn.situation === "C" && pk.facts.neverShipped) recommend = "accept";

    // Which lane fits, if any. E always asks; quality disputes always ask;
    // contest only on a strong pack; accept only for flagged fraud or an
    // order that never shipped.
    let laneName: Lane | null = null;
    if (dn.situation !== "E" && dn.type !== "not_as_described" && dn.type !== "other") {
      if (recommend === "contest" && pk.strong) laneName = "contest";
      if (recommend === "accept" && (pk.facts.fraud?.vulcan === "flagged" || pk.facts.neverShipped)) laneName = "accept";
    }
    if (opts2.atDeadline) laneName = recommend === "contest" && pk.strong ? "contest" : null;
    const lane = laneName
      ? checkLane(ctx.db, {
          merchantId: kase.merchant_id,
          lane: laneName,
          type: dn.type,
          phase: d.phase,
          deducted: d.deducted,
          confidence: fresh(ctx, kase).confidence,
          amount: d.amount,
          approvalLimit: merchant.approval_limit,
          now,
          deadline: dn.deadline,
          atDeadline: opts2.atDeadline,
        })
      : null;

    const covered = pk.confidence === "sure";
    const contestP: ProposedAction = { id: newId("prop"), label: "Contest dispute", tool: "contest_dispute", args: { dispute_id: d.id }, covered };
    const acceptP: ProposedAction = { id: newId("prop"), label: "Accept dispute", tool: "accept_dispute", args: { dispute_id: d.id }, covered: false };
    if (dn.type === "fraud" && pk.facts.fraud?.vulcan === "flagged") {
      const p = await paymentOf(a, kase, d.payment_id);
      if (p?.card_last4) {
        acceptP.label = `Accept dispute & block card ending ${p.card_last4}`;
        acceptP.followUps = [{ tool: "none", label: `Block card ending ${p.card_last4} (Simulated)`, args: { choice: "block_card", card_last4: p.card_last4 } }];
      }
    }
    if (dn.situation === "C" && pk.facts.neverShipped) {
      const msg = await customerMessage(ctx, kase, d, (o) => L.neverShippedLine(o));
      if (msg) acceptP.followUps = [{ tool: "send_message", label: `Message ${msg.first}`, args: msg.args }];
    }
    const primary = recommend === "contest" ? contestP : acceptP;
    const secondary = recommend === "contest" ? acceptP : contestP;
    const proposals: ProposedAction[] = [];

    // Customer outreach, non-fraud only: a fix or refund offer and a withdraw request.
    const outreach = await outreachProposal(ctx, kase, d, dn);
    const outreachFirst = !!outreach && !pk.facts.neverShipped && d.amount <= merchant.approval_limit && now < dn.deadline - 2 * DAY;
    if (outreach && outreachFirst) proposals.push(outreach, primary, secondary);
    else proposals.push(primary, secondary, ...(outreach ? [outreach] : []));

    // No percentages on merchant screens: the proof is described, the odds stay in the pack note.
    const proof = pk.strong ? "the proof is strong" : "the proof is thin";
    const why =
      dn.situation === "E"
        ? `This is ${d.phase === "arbitration" ? "arbitration" : "pre-arbitration"}; losing costs ${formatMoney(fee)} more, so ${evContest ? "contesting is still worth it" : "accepting costs less"}: ${proof}.`
        : d.amount > merchant.approval_limit
          ? `${formatMoney(d.amount)} is above your approval limit of ${formatMoney(merchant.approval_limit)}, so this one is your call.`
          : `${proof[0].toUpperCase()}${proof.slice(1)}.`;
    const question = outreachFirst ? `Want me to message ${b.first} first and ask for the dispute to be withdrawn?` : recommend === "contest" ? "Contest it?" : "Accept it?";
    return {
      recommend,
      lane,
      proposals,
      summary: L.askLine(b, why, question),
      reason: lane && !lane.ok ? lane.why.join(" ") : why,
    };
  }

  // A message to the customer as the merchant: checkable details (amount,
  // time, last 4), no link, on the channel they can get free text on.
  async function customerMessage(ctx: EngineContext, kase: Case, d: Dispute, body: (o: L.OutreachBits) => string): Promise<{ first: string; args: Record<string, unknown> } | null> {
    const a = adaptersOf(ctx);
    const p = await paymentOf(a, kase, d.payment_id);
    if (!p) return null;
    const customer = customerFor(ctx, kase.merchant_id, p);
    if (!customer) return null;
    const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
    const settings = readSettings(ctx.db, kase.merchant_id, "chargeback");
    const window = customer.phone ? a.messaging.window(kase.merchant_id, customer.phone) : { open: false };
    // WhatsApp only inside the customer's 24-hour window (there is no
    // approved dispute template); email otherwise.
    const channel = window.open && merchant.whatsapp_on ? "whatsapp" : customer.email ? "email" : null;
    if (!channel) return null;
    const to = channel === "whatsapp" ? customer.phone! : customer.email!;
    const sender_mode = channel === "whatsapp" && settings.sendFrom === "verified_domain" ? "merchant_inbox" : settings.sendFrom;
    const pk = packNote(ctx, kase);
    const text = body({
      first: firstNameOf(customer.name),
      amount: formatMoney(p.amount, p.currency),
      time: formatTime(p.created_at),
      date: formatDate(p.created_at),
      ref: p.utr ? `UTR ending ${p.utr.slice(-4)}` : p.card_last4 ? `card ending ${p.card_last4}` : null,
      order: pk?.orderNumber ?? null,
      item: pk?.item ?? null,
      merchant: merchant.name,
      signOff: settings.signOff,
    });
    return { first: firstNameOf(customer.name), args: { channel, to, sender_mode, kind: "dispute_outreach", body: text } };
  }

  async function outreachProposal(ctx: EngineContext, kase: Case, d: Dispute, dn: DisputeNote): Promise<ProposedAction | null> {
    if (dn.situation !== "C" || notes(ctx, kase.id, N.outreach).length) return null;
    const msg = await customerMessage(ctx, kase, d, (o) => L.outreachLine(o, dn.type));
    if (!msg) return null;
    return { id: newId("prop"), label: `Send message to ${msg.first}`, tool: "send_message", args: msg.args, covered: false };
  }

  // A real complaint in the customer's reply: refund or a replacement, the
  // merchant's tap. Nothing in the reply is followed; only the case's own
  // amount and order are used.
  async function complaintProposals(ctx: EngineContext, kase: Case, d: Dispute): Promise<ProposedAction[]> {
    const pk = packNote(ctx, kase);
    const amount = formatMoney(d.amount);
    const out: ProposedAction[] = [];
    const refundMsg = await customerMessage(ctx, kase, d, (o) => L.refundByAcceptLine(o));
    if (d.deducted) {
      // The amount already went back to the customer at onset: accepting
      // the dispute is the refund.
      out.push({
        id: newId("prop"), label: `Refund ${amount} by accepting the dispute`, tool: "accept_dispute", args: { dispute_id: d.id }, covered: false,
        ...(refundMsg ? { followUps: [{ tool: "send_message", label: `Message ${refundMsg.first}`, args: refundMsg.args }] } : {}),
      });
    } else {
      out.push({ id: newId("prop"), label: `Refund ${amount}`, tool: "refund", args: { payment_id: d.payment_id, amount: d.amount, speed: "normal" }, covered: false });
    }
    if (pk?.item) {
      const msg = await customerMessage(ctx, kase, d, (o) => L.replacementLine(o));
      out.push({
        id: newId("prop"), label: `Send a new ${pk.item}`, tool: "none", args: { choice: "replacement", item: pk.item, order: pk.orderNumber }, covered: false,
        ...(msg ? { followUps: [{ tool: "send_message", label: `Message ${msg.first}`, args: msg.args }] } : {}),
      });
    }
    return out;
  }

  // ---- Acting: file, hold under a lane, or message the customer.

  async function act(ctx: EngineContext, kase: Case, proposal: ProposedAction, approval: Approval, holdUntil?: number): Promise<ApprovalResult> {
    const a = adaptersOf(ctx);
    const dn = disputeNote(ctx, kase)!;
    const d = await a.razorpay(kase.merchant_id).fetchDispute(dn.dispute_id);
    const b = bitsOf(ctx, kase, d, dn);

    if (proposal.tool === "none") {
      const done = simulated(ctx, kase, proposal.args, approval.evidenceRef);
      const after = await followUps(ctx, kase, proposal, approval, b);
      return after ?? { to: "verifying", reason: done };
    }

    if (proposal.tool === "send_message") {
      const r = await guardedCall("send_message", proposal.args, { adapters: a, caseId: kase.id, approval });
      if (!went(r)) return { to: "waiting_merchant", reason: r.status === "blocked" ? r.failures[0].reason : `The message to ${b.first} didn't go.` };
      note(ctx, kase, { kind: N.outreach, message_action_id: r.action.id }, r.action.id);
      return { to: "verifying", reason: `Message sent to ${b.first}. I'll tell you if ${b.first} replies or the bank withdraws the dispute.` };
    }

    const filing = filingOf(ctx.db, kase.merchant_id);
    if (proposal.tool === "contest_dispute" && filing === "manual") {
      note(ctx, kase, { kind: N.filed, via: "manual", dispute_id: d.id }, approval.evidenceRef);
      return { to: "verifying", reason: "The reply pack is ready for you to upload. I'll watch for the outcome." };
    }
    if (proposal.tool === "contest_dispute" && filing === "dispute_responder") {
      note(ctx, kase, { kind: N.filed, via: "dispute_responder", stage: "handed_off", dispute_id: d.id, simulated: true }, approval.evidenceRef);
    }

    const r = await guardedCall(proposal.tool, proposal.args, { adapters: a, caseId: kase.id, approval, holdUntil });
    const verb = proposal.tool === "contest_dispute" ? "contest" : "accept";
    if (r.status === "held") {
      const lane: Lane = proposal.tool === "contest_dispute" ? "contest" : "accept";
      note(ctx, kase, { kind: N.laneUsed, action_id: r.action.id, type: dn.type, lane, rule_id: approval.by === "rule" ? approval.ruleId : null, run_after: r.runAfter }, r.action.id);
      ctx.repo.disputes.update(d.id, { lane });
      const fyi = alert(ctx, kase, "lane_fyi", L.fyiLine(b, lane, r.runAfter));
      note(ctx, kase, { kind: N.fyi, alert_id: fyi.id, run_after: r.runAfter }, r.action.id);
      return { to: "verifying", reason: `${proposal.tool === "contest_dispute" ? "Contesting" : "Accepting"} this dispute at ${formatTime(r.runAfter)} under "${LANE_NAME[lane]}". Stop works until then.`, timers: [{ kind: TIMERS.stop, inMs: r.runAfter - ctx.clock.now() }] };
    }
    if (r.status === "done" || r.status === "duplicate") {
      if (proposal.tool === "contest_dispute") note(ctx, kase, { kind: N.filed, via: filing, dispute_id: d.id, action_id: r.action.id }, r.action.id);
      if (approval.by === "tap") offerToStopAsking(ctx, kase, proposal, dn, verb);
      // The action's own follow-ups, covered by the same tap.
      const after = approval.by === "tap" ? await followUps(ctx, kase, proposal, approval, b) : null;
      if (after) return after;
      return { to: "verifying", reason: proposal.tool === "contest_dispute" ? `Contested ✓ through ${FILING_LABEL[filing]}` : "Accepted ✓" };
    }
    return { to: "waiting_merchant", reason: r.status === "blocked" ? r.failures[0].reason : `I couldn't ${verb} this dispute.` };
  }

  // A reply from the customer after outreach. The understand job reads it;
  // code sorts it: agrees to withdraw (noted, the case waits for the bank),
  // a real complaint (refund or replacement card, the merchant's tap), or
  // anything else (shown to the merchant). Nothing in the reply is followed.
  async function onReply(ctx: EngineContext, kase: Case, e: { sourceId: string; payload: Record<string, unknown> }): Promise<{ reason: string; complaint: boolean; proposals?: ProposedAction[] }> {
    const text = String(e.payload.body ?? "");
    const dn = disputeNote(ctx, kase);
    const asked = notes(ctx, kase.id, N.outreach).length > 0;
    if (!dn || !asked) {
      note(ctx, kase, { kind: N.reply, message_id: e.sourceId, class: null }, e.sourceId);
      return { reason: "The customer replied. It's on the case.", complaint: false };
    }
    const u = await aiOf(ctx).understand({ text }, { caseId: kase.id });
    const cls = u.source === "fallback" ? "other" : (u.output.dispute_reply ?? "other");
    note(ctx, kase, { kind: N.reply, message_id: e.sourceId, class: cls, mood: u.output.mood, language: u.output.language, source: u.source }, e.sourceId);
    const d = await adaptersOf(ctx).razorpay(kase.merchant_id).fetchDispute(dn.dispute_id);
    const b = bitsOf(ctx, kase, d, dn);
    if (cls === "agrees_to_withdraw") {
      note(ctx, kase, { kind: N.agrees, message_id: e.sourceId }, e.sourceId);
      return { reason: `${b.first} says they'll ask the bank to withdraw the dispute. The case stays open until the bank does.`, complaint: false };
    }
    if (cls === "complaint" && d.status === "open") {
      note(ctx, kase, { kind: N.complaint, message_id: e.sourceId }, e.sourceId);
      const proposals = await complaintProposals(ctx, kase, d);
      return { reason: L.complaintLine(b.first, text, b.amount, packNote(ctx, kase)?.item ?? null), complaint: true, proposals };
    }
    alert(ctx, kase, "customer_reply", L.replyLine(b.first, text));
    return { reason: L.replyLine(b.first, text), complaint: false };
  }

  // A Simulated step with no tool: blocking a card, a replacement order.
  function simulated(ctx: EngineContext, kase: Case, args: Record<string, unknown>, ref: string): string {
    if (args.choice === "block_card") {
      note(ctx, kase, { kind: N.block, card_last4: args.card_last4, simulated: true }, ref);
      return `Card ending ${String(args.card_last4)} is blocked for your store (Simulated).`;
    }
    if (args.choice === "replacement") {
      note(ctx, kase, { kind: N.replacement, item: args.item, order: args.order, simulated: true }, ref);
      return `A new ${String(args.item)} is queued in your store (Simulated).`;
    }
    return "Noted.";
  }

  // Runs the follow-ups the card listed with the action, under the same
  // approval (the guard matches each one to the tapped proposal). null when
  // all went; otherwise the case comes back to the merchant.
  async function followUps(ctx: EngineContext, kase: Case, proposal: ProposedAction, approval: Approval, b: L.DisputeBits): Promise<ApprovalResult | null> {
    const done: string[] = [];
    for (const f of proposal.followUps ?? []) {
      if (f.tool === "none") {
        done.push(simulated(ctx, kase, f.args, approval.evidenceRef));
        continue;
      }
      const r = await guardedCall(f.tool, f.args, { adapters: adaptersOf(ctx), caseId: kase.id, approval });
      if (!went(r)) return { to: "waiting_merchant", reason: `${proposal.label} ✓, but ${f.label ?? "the next step"} didn't go: ${r.status === "blocked" ? r.failures[0].reason : "it failed"}` };
      if (f.tool === "send_message") note(ctx, kase, { kind: N.outreach, message_action_id: r.action.id, follow_up_of: proposal.id }, r.action.id);
      done.push(`Message sent to ${b.first}.`);
    }
    if (!done.length) return null;
    const head = proposal.tool === "none" ? "" : proposal.tool === "contest_dispute" ? "Contested ✓ " : "Accepted ✓ ";
    return { to: "verifying", reason: `${head}${done.join(" ")}`.trim() };
  }

  // Approved RAY's recommendation unchanged several times for one type:
  // offer to stop asking (a proposed lane rule; never assumed).
  function offerToStopAsking(ctx: EngineContext, kase: Case, proposal: ProposedAction, dn: DisputeNote, verb: "contest" | "accept") {
    const offered = ctx.repo.caseEvents.listByCase(kase.id).filter((e) => e.payload.kind === "actions_proposed").at(-1);
    const first = (offered?.payload.actions as ProposedAction[] | undefined)?.find((p) => p.tool === "contest_dispute" || p.tool === "accept_dispute");
    const changed = notes(ctx, kase.id, "change_requested").length > 0;
    if (!first || first.id !== proposal.id || changed || dn.situation === "E") return;
    note(ctx, kase, { kind: N.approvedUnchanged, type: dn.type, lane: verb }, proposal.id);
    const lane: Lane = verb;
    if (laneRules(ctx.db, kase.merchant_id, lane).some((r) => r.rule_json.types.includes(dn.type))) return;
    const count = ctx.db
      .select({ id: s.caseEvents.id, payload: s.caseEvents.payload })
      .from(s.caseEvents)
      .innerJoin(s.cases, eq(s.cases.id, s.caseEvents.case_id))
      .where(eq(s.cases.merchant_id, kase.merchant_id))
      .all()
      .filter((e) => e.payload.kind === N.approvedUnchanged && e.payload.type === dn.type && e.payload.lane === lane).length;
    const id = `rule_cb_stop_asking_${lane}_${dn.type}_${kase.merchant_id}`;
    if (count < STOP_ASKING_AFTER || ctx.repo.playbookRules.get(id)) return;
    const text = `You've approved ${lane === "contest" ? "contesting" : "accepting"} ${TYPE_LABEL[dn.type]} disputes ${count} times. Stop asking for this type?`;
    ctx.repo.playbookRules.insert({ id, merchant_id: kase.merchant_id, moment: "chargeback", rule_json: { lane, tool: LANE_TOOL[lane], types: [dn.type] }, text, source: "pattern", status: "proposed", approved_at: null });
    alert(ctx, kase, "rule_offer", text);
    note(ctx, kase, { kind: N.stopOffer, rule_id: id, count }, proposal.id);
  }

  const went = (r: GuardedResult) => r.status === "done" || r.status === "duplicate";

  // ---- Deadlines

  // The day before: one urgent ask, and the urgent call if the merchant
  // opted in (within calling hours), ending with the decision card on WhatsApp.
  async function urgentAsk(ctx: EngineContext, kase: Case): Promise<{ reason: string; timers: TimerRequest[] }> {
    if (notes(ctx, kase.id, N.urgent).length) return { reason: "Already asked.", timers: [] };
    const a = adaptersOf(ctx);
    const dn = disputeNote(ctx, kase)!;
    const d = await a.razorpay(kase.merchant_id).fetchDispute(dn.dispute_id);
    const b = bitsOf(ctx, kase, d, dn);
    const ask = alert(ctx, kase, "urgent_ask", L.urgentLine(b));
    note(ctx, kase, { kind: N.urgent, alert_id: ask.id }, ask.id);
    const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
    if (!merchant.urgent_call_opt_in) return { reason: "Urgent ask sent.", timers: [] };
    const now = ctx.clock.now();
    const mins = minutesIst(now);
    if (mins >= merchant.calling_hours_start && mins < merchant.calling_hours_end) return { reason: await urgentCall(ctx, kase), timers: [] };
    // Outside calling hours: the next start, if it's still before the final hours.
    const wait = ((merchant.calling_hours_start - mins + 1440) % 1440) * MIN;
    if (now + wait < dn.deadline - FINAL_BEFORE_MS) return { reason: `Urgent ask sent. I'll call you at ${clockLabel(merchant.calling_hours_start)}.`, timers: [{ kind: TIMERS.call, inMs: wait }] };
    return { reason: "Urgent ask sent. It's outside your calling hours, so no call.", timers: [] };
  }

  async function urgentCall(ctx: EngineContext, kase: Case): Promise<string> {
    if (kase.state !== "waiting_merchant" && kase.state !== "verifying") return "No call needed.";
    const a = adaptersOf(ctx);
    const dn = disputeNote(ctx, kase)!;
    const d = await a.razorpay(kase.merchant_id).fetchDispute(dn.dispute_id);
    if (d.status !== "open") return "No call needed.";
    const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
    const b = bitsOf(ctx, kase, d, dn);
    const script = L.urgentCall(b, merchant.name);
    const r = await guardedCall("place_call", { kind: "urgent_merchant", to: merchantPhone(merchant.id), ...script }, { adapters: a, caseId: kase.id });
    if (!went(r)) return `The urgent call didn't go: ${r.status === "blocked" ? r.failures[0].reason : "it failed"}`;
    // Every urgent call ends with the decision card on WhatsApp.
    alert(ctx, kase, "decision_card", L.urgentLine(b));
    return "Called you and sent the decision card on WhatsApp.";
  }

  // A few hours before: a strong pack is sent under the contest lane's
  // "at the deadline" opt-in (every lane bound); a weak one lapses.
  async function lapseNotice(ctx: EngineContext, kase: Case, why: string) {
    const a = adaptersOf(ctx);
    const dn = disputeNote(ctx, kase)!;
    const d = await a.razorpay(kase.merchant_id).fetchDispute(dn.dispute_id);
    const pk = packNote(ctx, kase)!;
    const b = bitsOf(ctx, kase, d, dn);
    const text = pk.strong ? `${L.urgentLine(b)} ${why}` : L.lapseLine(b);
    alert(ctx, kase, "deadline_lapse", text);
    note(ctx, kase, { kind: N.lapsed, strong: pk.strong, why }, d.id);
    return text;
  }

  // ---- Outcomes

  // The outcome of a dispute, the same whether Razorpay's webhook or the dev
  // panel fired it (both come through handleEvent): the dispute record is
  // updated, the merchant told, and an automatic lane's accuracy updated.
  async function outcomeOf(ctx: EngineContext, kase: Case, outcome: Outcome, ref: string): Promise<{ reason: string }> {
    const dn = disputeNote(ctx, kase);
    const d = dn ? ctx.repo.disputes.get(dn.dispute_id) : undefined;
    const back = SAVED.includes(outcome);
    if (d && outcome !== "accepted") {
      const status = outcome === "withdrawn" ? "closed" : outcome;
      // Won or withdrawn: the deducted amount goes back to the merchant's balance.
      ctx.repo.disputes.update(d.id, { status, ...(back ? { deducted: false } : {}) });
    }
    // An automatic lane's call: right when won or withdrawn after a contest,
    // or an accept; wrong when an automatic contest was lost.
    const used = notes(ctx, kase.id, N.laneUsed).find((u) => ctx.repo.actions.get(String(u.payload.action_id))?.status === "done");
    const laneRule = used?.payload.rule_id ? String(used.payload.rule_id) : null;
    const wrong = !!laneRule && used!.payload.lane === "contest" && outcome === "lost";
    note(ctx, kase, { kind: N.outcome, outcome, saved: back, returned_to_balance: back ? d?.amount ?? null : null, lane_rule_id: laneRule, lane_wrong: laneRule ? wrong : null }, ref);
    if (laneRule) {
      const acc = laneAccuracy(ctx.db, laneRule);
      note(ctx, kase, { kind: N.laneAccuracy, rule_id: laneRule, ...acc }, ref);
      if (wrong) switchLaneOffAfterWrongCall(ctx.db, ctx.clock.now(), laneRule, kase.id, ref);
    }
    const amount = formatMoney(d?.amount ?? kase.amount ?? 0);
    const words: Record<Outcome, string> = {
      won: `Dispute won ✓ ${amount} is back in your balance.`,
      lost: "The dispute was lost.",
      withdrawn: `The customer's bank withdrew the dispute ✓ ${amount} is back in your balance.`,
      accepted: "Dispute accepted.",
    };
    if (outcome !== "accepted") alert(ctx, kase, "dispute_outcome", words[outcome]);
    return { reason: words[outcome] };
  }

  // A dispute's outcome on a case that isn't verifying (it lapsed while
  // waiting on the merchant): closed through the state machine here.
  async function closeOutside(ctx: EngineContext, kase: Case, outcome: Outcome, ref: string): Promise<InvestigateResult> {
    const { reason } = await outcomeOf(ctx, kase, outcome, ref);
    if (kase.state === "waiting_merchant") {
      transition(ctx.db, ctx.clock, kase.id, "closed", { reason, evidenceRef: ref, patch: { closed_at: ctx.clock.now(), outcome, counts_as_saved: SAVED.includes(outcome) } });
      return { to: "closed", reason, findings: [] };
    }
    return stay(kase, reason);
  }

  // ---- The Specialist

  return {
    id: "chargebacks",
    moment: "chargeback",

    async detect(ctx, e) {
      const a = ctx.adapters;
      if (!a) return null;
      if (e.kind === "webhook" && DISPUTE_EVENTS.includes(eventName(e))) {
        const id = disputeIdIn(e);
        if (!id) return null;
        const d = await a.razorpay(e.merchantId).fetchDispute(id).catch(() => null);
        if (!d) return null;
        const p = await a.razorpay(e.merchantId).fetchPayment(d.payment_id).catch(() => null);
        const who = p ? customerFor(ctx, e.merchantId, p) : null;
        const type = disputeType(d);
        return {
          moment: "chargeback",
          confidence: "likely",
          situation: situationOf(type, d.phase),
          alert: L.alertLine({ who: who?.name ?? "A customer", first: "", amount: formatMoney(d.amount), type, order: null, deadline: L.when(deadlineOf(d, e.at)) }),
          paymentId: d.payment_id,
          amount: d.amount,
          side: "customer_or_bank",
          cause: type,
        };
      }
      if (e.kind === "message_in") {
        // Before a dispute exists: a customer threatening a chargeback. The
        // paid-no-order flow detects first (registry order); this takes the rest.
        const u = await aiOf(ctx).understand({ text: String(e.payload.body ?? "") }, {});
        if (u.source === "fallback" || u.output.legal_or_chargeback_words.length === 0) return null;
        return { moment: "chargeback", confidence: "unsure", situation: "A", alert: L.threatAlert };
      }
      return null;
    },

    async investigate(ctx, kase, e) {
      const name = eventName(e);
      // A dispute: the case is open, so build the reply. A threat case
      // turns into a dispute case here.
      if (DISPUTE_EVENTS.includes(name)) {
        const id = disputeIdIn(e);
        if (!id) return stay(kase, "No dispute in the event.");
        if (kase.state === "unconfirmed") return { to: "likely", reason: "A dispute arrived.", findings: [] };
        return onDispute(ctx, kase, id, e.at);
      }
      if (name in OUTCOME_EVENTS) return closeOutside(ctx, kase, OUTCOME_EVENTS[name], e.sourceId);

      if (isThreat(ctx, kase)) {
        if (e.kind === "message_in" && !notes(ctx, kase.id, N.threat).length) note(ctx, kase, { kind: N.threat }, e.sourceId);
        const r = await pno.investigate(ctx, asPno(ctx, kase), e);
        // Still situation A for this moment; the paid-no-order situation is on its notes.
        ctx.repo.cases.update(kase.id, { situation: "A" });
        return { ...r, situation: "A" };
      }

      if (e.kind === "message_in") {
        const r = await onReply(ctx, kase, e);
        return { to: kase.state, reason: r.reason, findings: [], ...(r.proposals ? { proposals: r.proposals } : {}) };
      }
      if (e.kind === "timer") {
        const kind = e.payload.timer_kind;
        if (kind === TIMERS.weekly) {
          const found = weeklyInsight(ctx.db, kase.merchant_id, kase.id, ctx.clock.now());
          return stay(kase, found.length ? `Weekly insight: ${found.length} pattern${found.length > 1 ? "s" : ""}.` : "No pattern this week.");
        }
        if (!disputeNote(ctx, kase)) return stay(kase, "Nothing to do.");
        if (kase.state !== "waiting_merchant") return stay(kase, "Nothing to do.");
        if (kind === TIMERS.eve) {
          const r = await urgentAsk(ctx, kase);
          return { ...stay(kase, r.reason), timers: r.timers };
        }
        if (kind === TIMERS.call) return stay(kase, await urgentCall(ctx, kase));
        if (kind === TIMERS.final) {
          note(ctx, kase, { kind: N.deadlineDue }, e.sourceId);
          return { to: "confirmed", reason: "A few hours to the deadline and no answer yet.", findings: [] };
        }
        if (kind === TIMERS.deadline) {
          note(ctx, kase, { kind: N.deadlinePassed }, e.sourceId);
          return stay(kase, "The deadline passed without a reply.");
        }
      }
      return stay(kase, "Nothing to do.");
    },

    async decide(ctx, kase) {
      if (isThreat(ctx, kase)) {
        // Always asks: a rule from another moment never acts here.
        const d = await pno.decide(ctx, asPno(ctx, kase));
        return d.to === "acting" ? { ...d, to: "waiting_merchant", ruleId: undefined, reason: "Needs your tap." } : d;
      }
      const due = lastNote(ctx, kase.id, N.deadlineDue);
      const decided = lastNote(ctx, kase.id, N.decision);
      const atDeadline = !!due && (!decided || (decided.seq ?? 0) < (due.seq ?? 0));
      const plan = await planFor(ctx, kase, { atDeadline });
      note(ctx, kase, { kind: N.decision, recommend: plan.recommend, lane: plan.lane?.ok ? plan.lane.rule.id : null, why: plan.lane && !plan.lane.ok ? plan.lane.why : [], at_deadline: atDeadline }, kase.id);
      const proposals = plan.proposals;
      if (plan.lane?.ok) {
        // The lane's action first, so onApproval finds it by the rule's tool.
        const tool = plan.lane.rule.rule_json.tool;
        const first = proposals.find((p) => p.tool === tool)!;
        if (atDeadline) {
          const dn = disputeNote(ctx, kase)!;
          const d = await adaptersOf(ctx).razorpay(kase.merchant_id).fetchDispute(dn.dispute_id);
          alert(ctx, kase, "deadline_reply", L.deadlineReplyLine(bitsOf(ctx, kase, d, dn)));
        }
        const d: Decision & { proposals: ProposedAction[] } = { to: "acting", reason: `Under your rule: ${LANE_NAME[plan.lane.rule.rule_json.lane]}`, summary: plan.summary, ruleId: plan.lane.rule.id, proposals: [first, ...proposals.filter((p) => p !== first)] };
        return d;
      }
      if (atDeadline) await lapseNotice(ctx, kase, plan.reason);
      const d: Decision & { proposals: ProposedAction[] } = { to: "waiting_merchant", reason: plan.reason, summary: plan.summary, proposals };
      return d;
    },

    async proposeActions(ctx, kase, d) {
      if (isThreat(ctx, kase)) return pno.proposeActions(ctx, asPno(ctx, kase), d);
      return (d as Decision & { proposals?: ProposedAction[] }).proposals ?? [];
    },

    async onApproval(ctx, kase, approval) {
      if (isThreat(ctx, kase)) return pno.onApproval(ctx, asPno(ctx, kase), approval);
      const offered = openProposals(ctx, kase.id);
      let proposal: ProposedAction | undefined;
      let holdUntil: number | undefined;
      if (approval.by === "tap") proposal = offered.find((p) => p.id === approval.tap.proposalId);
      else {
        const rule = ctx.repo.playbookRules.get(approval.ruleId);
        proposal = offered.find((p) => p.tool === rule?.rule_json.tool);
        holdUntil = stopWindowEnd(ctx.clock.now(), disputeNote(ctx, kase)!.deadline) ?? undefined;
        // Never without a Stop window.
        if (holdUntil === undefined) return { to: "waiting_merchant", reason: "There isn't time left for a Stop window, so this needs your tap." };
      }
      if (!proposal) return { to: "waiting_merchant", reason: "RAY can't find what was approved." };
      return act(ctx, kase, proposal, approval, holdUntil);
    },

    async verify(ctx, kase, e): Promise<VerifyResult> {
      if (isThreat(ctx, kase) && !(e && DISPUTE_EVENTS.includes(eventName(e)))) return pno.verify(ctx, asPno(ctx, kase), e);
      const accepted = () =>
        ctx.repo.actions.list(and(eq(s.actions.case_id, kase.id), eq(s.actions.tool, "accept_dispute"), eq(s.actions.status, "done"))).at(-1);
      if (!e) {
        const acc = accepted();
        if (acc && !lastNote(ctx, kase.id, N.outcome)) return { to: "closed", outcome: "accepted", ...(await outcomeOf(ctx, kase, "accepted", acc.id)) };
        return { to: "verifying", reason: "Waiting for the card network." };
      }
      const name = eventName(e);
      if (name in OUTCOME_EVENTS) {
        const outcome = OUTCOME_EVENTS[name];
        return { to: "closed", outcome, ...(await outcomeOf(ctx, kase, outcome, e.sourceId)) };
      }
      if (DISPUTE_EVENTS.includes(name)) {
        // A new stage (pre-arbitration) or a dispute on a threat case: always ask.
        const id = disputeIdIn(e);
        if (!id) return { to: "verifying", reason: "Nothing new." };
        const r = await onDispute(ctx, kase, id, e.at);
        for (const f of r.findings) ctx.repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: ctx.clock.now(), type: "finding", payload: { text: f.text, cited_by: e.sourceId }, evidence_ref: f.evidenceRef });
        const plan = await planFor(ctx, kase);
        const dn2 = () => disputeNote(ctx, kase)!;
        note(ctx, kase, { kind: N.decision, recommend: plan.recommend, lane: null, why: [dn2().situation === "E" ? "A new stage always asks." : "A dispute arrived on a case RAY was already handling, so it asks."], at_deadline: false }, kase.id);
        return { to: "waiting_merchant", reason: plan.summary, timers: r.timers, proposals: plan.proposals };
      }
      if (e.kind === "message_in") {
        const r = await onReply(ctx, kase, e);
        return { to: r.complaint ? "waiting_merchant" : "verifying", reason: r.reason, ...(r.proposals ? { proposals: r.proposals } : {}) };
      }
      if (e.kind === "timer") {
        const kind = e.payload.timer_kind;
        if (kind === TIMERS.stop) {
          const used = lastNote(ctx, kase.id, N.laneUsed);
          const action = used ? ctx.repo.actions.get(String(used.payload.action_id)) : undefined;
          if (action?.status === "done") {
            if (action.tool === "accept_dispute") return { to: "closed", outcome: "accepted", ...(await outcomeOf(ctx, kase, "accepted", action.id)) };
            note(ctx, kase, { kind: N.filed, via: filingOf(ctx.db, kase.merchant_id), dispute_id: action.args.dispute_id, action_id: action.id, under_rule: used!.payload.rule_id }, action.id);
            return { to: "verifying", reason: `Contested ✓ under your rule: ${LANE_NAME.contest}` };
          }
          return { to: "verifying", reason: "Nothing new." };
        }
        if (kind === TIMERS.weekly) {
          weeklyInsight(ctx.db, kase.merchant_id, kase.id, ctx.clock.now());
          return { to: "verifying", reason: "Weekly insight checked." };
        }
        // After outreach the dispute is still open: back to the merchant
        // the day before, with the urgent ask.
        const dn = disputeNote(ctx, kase);
        if (!dn) return { to: "verifying", reason: "Nothing new." };
        const d = await adaptersOf(ctx).razorpay(kase.merchant_id).fetchDispute(dn.dispute_id);
        if (d.status !== "open") return { to: "verifying", reason: "Waiting for the card network." };
        if (kind === TIMERS.eve || kind === TIMERS.final) {
          const plan = await planFor(ctx, kase);
          const r = kind === TIMERS.eve ? await urgentAsk(ctx, kase) : { reason: await lapseNotice(ctx, kase, plan.reason), timers: [] };
          return { to: "waiting_merchant", reason: `${plan.summary} ${r.reason}`, timers: r.timers, proposals: plan.proposals.filter((p) => p.tool !== "send_message") };
        }
        if (kind === TIMERS.call) return { to: "verifying", reason: await urgentCall(ctx, kase) };
      }
      return { to: "verifying", reason: "Nothing new." };
    },

    async onPromisedTime(ctx, kase, e) {
      if (isThreat(ctx, kase)) return pno.onPromisedTime(ctx, asPno(ctx, kase), e);
      return { reason: "Nothing was promised to the cardholder." };
    },

    countsAsSaved(ctx, kase) {
      if (isThreat(ctx, kase)) return pno.countsAsSaved(ctx, asPno(ctx, kase));
      const o = lastNote(ctx, kase.id, N.outcome);
      return !!o?.payload.saved;
    },

    async onChange(ctx, kase, text, e) {
      if (isThreat(ctx, kase) && pno.onChange) return pno.onChange(ctx, asPno(ctx, kase), text, e);
      // The merchant's note is data: the write job redrafts each customer
      // message on the card (the action's own and its follow-ups) from the
      // case facts and the note; it never follows it. The same card comes
      // back. Every number is checked against the case (write's guard, then
      // the grounding guard when it's sent).
      const offered = openProposals(ctx, kase.id);
      if (!offered.length) return { reason: "Nothing to redraft." };
      const a = adaptersOf(ctx);
      const settings = readSettings(ctx.db, kase.merchant_id, "chargeback");
      let redrafted = 0;
      const redraft = async (args: Record<string, unknown>) => {
        if (typeof args.body !== "string") return args;
        const ids = idAliases();
        const first = !a.messaging.thread(kase.merchant_id, String(args.to)).some((m) => m.direction === "out");
        const facts = ids.hide({ ...caseFacts(ctx.db, kase.id), sign_off: settings.signOff, current_draft: args.body, merchant_change: text });
        const r = await aiOf(ctx).write({ audience: "customer", kind: "dispute_outreach_redraft", first_customer_message: first, facts, tone: settings.tone, language: "en" }, { caseId: kase.id });
        if (r.source === "fallback" || !r.output.draft) return args;
        redrafted++;
        return { ...args, body: ids.show(r.output.draft) };
      };
      const proposals: ProposedAction[] = [];
      for (const p of offered) {
        const args = p.tool === "send_message" ? await redraft(p.args) : p.args;
        const followUps = p.followUps ? await Promise.all(p.followUps.map(async (f) => (f.tool === "send_message" ? { ...f, args: await redraft(f.args) } : f))) : undefined;
        proposals.push({ ...p, id: newId("prop"), args, ...(followUps ? { followUps } : {}) });
      }
      return { reason: redrafted ? "RAY redrafted the message with your note." : "RAY couldn't redraft the message, so the draft is unchanged.", proposals };
    },
  };
}

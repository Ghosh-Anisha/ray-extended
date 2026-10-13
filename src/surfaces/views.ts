// What every merchant surface and simulator shows, built by code from the
// database. Pages render these; nothing here is held only in memory. Every
// string a merchant reads comes from here or from words.ts.
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { CaseState, Moment } from "@/db/schema";
import { openProposals } from "@/engine/orchestrator";
import type { ProposedAction } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { actLabel } from "@/guards";
import { killSwitchOn } from "@/guards/kill-switch";
import type { ActToolName } from "@/tools/names";
import { callView, preCallNotice, voiceNoteView, type CallView, type PreCallNotice, type VoiceNoteView } from "./calls";
import { age, countdown, dateTime, firstName, formatTime, money, orderLabel, shortId } from "./format";
import { isSettingRow, readSettings } from "./playbook";
import {
  CONFIDENCE_LABEL,
  causeLabel,
  CONFIDENCE_TONE,
  INBOX_TABS,
  MOMENT_LABEL,
  RAZORPAY_PLUGIN_NOTE,
  SENDER_MODE_LABEL,
  SIDE_LABEL,
  SIDE_NOTE,
  STATE_LABEL,
  STATE_TONE,
  tabFor,
  type FindingSource,
  type InboxTab,
  type Tone,
} from "./words";

type Repo = ReturnType<typeof createRepository>;
type Message = typeof s.messages.$inferSelect;
type CaseEvent = typeof s.caseEvents.$inferSelect;

export type Chip = { label: string; tone: Tone };

export type Merchant = { id: string; name: string; rayOn: boolean; killSwitch: "global" | "merchant" | null };

export function merchantView(a: Adapters, merchantId: string): Merchant {
  const m = createRepository(a.db).merchants.get(merchantId);
  if (!m) throw new Error(`Merchant ${merchantId} not found`);
  return { id: m.id, name: m.name, rayOn: m.ray_on, killSwitch: killSwitchOn(a.db, m.id) };
}

export const merchantList = (a: Adapters) => createRepository(a.db).merchants.list().map((m) => ({ id: m.id, name: m.name, rayOn: m.ray_on }));

// ---- Who and how much a case is about

type Subject = {
  name: string;
  amountMinor: number | null;
  amount: string;
  paymentId: string | null;
  orderNumber: string | null;
};

function caseKeys(repo: Repo, caseId: string) {
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const e of repo.caseEvents.listByCase(caseId)) {
    const keys = e.payload.keys as { email?: string; phone?: string } | undefined;
    if (keys?.email) emails.add(keys.email);
    if (keys?.phone) phones.add(keys.phone);
  }
  return { emails, phones };
}

// A list screen asks about many cases of one merchant: it reads that
// merchant's customers and buyers once instead of once per case.
export type SubjectCache = { customers: Map<string, Customer[]>; buyers: Map<string, Buyer[]> };
type Customer = typeof s.customers.$inferSelect;
type Buyer = typeof s.buyers.$inferSelect;
export const subjectCache = (): SubjectCache => ({ customers: new Map(), buyers: new Map() });

export function subjectOf(a: Adapters, kase: Case, cache?: SubjectCache): Subject {
  const repo = createRepository(a.db);
  const customersOf = (merchantId: string) => {
    if (!cache) return repo.customers.list(eq(s.customers.merchant_id, merchantId));
    if (!cache.customers.has(merchantId)) cache.customers.set(merchantId, repo.customers.list(eq(s.customers.merchant_id, merchantId)));
    return cache.customers.get(merchantId)!;
  };
  const buyersOf = (merchantId: string) => {
    if (!cache) return repo.buyers.list(eq(s.buyers.merchant_id, merchantId));
    if (!cache.buyers.has(merchantId)) cache.buyers.set(merchantId, repo.buyers.list(eq(s.buyers.merchant_id, merchantId)));
    return cache.buyers.get(merchantId)!;
  };
  const payment = kase.payment_id ? repo.rzpPayments.get(kase.payment_id) : undefined;
  const order = kase.store_order_id
    ? repo.storeOrders.get(kase.store_order_id)
    : kase.payment_id
      ? a.db.select().from(s.storeOrders).where(and(eq(s.storeOrders.merchant_id, kase.merchant_id), eq(s.storeOrders.payment_id, kase.payment_id))).get()
      : undefined;
  const { emails, phones } = caseKeys(repo, kase.id);
  if (payment?.email) emails.add(payment.email.toLowerCase());
  if (payment?.contact) phones.add(payment.contact);
  const customer =
    (order?.customer_id ? repo.customers.get(order.customer_id) : undefined) ??
    customersOf(kase.merchant_id).find((c) => (c.email && emails.has(c.email.toLowerCase())) || (c.phone && phones.has(c.phone)));
  // Collect (Step 11): the case is about a buyer, named by their business.
  const buyer = customer
    ? undefined
    : buyersOf(kase.merchant_id).find((b) => (b.email && emails.has(b.email.toLowerCase())) || (b.phone && phones.has(b.phone)));
  const amountMinor = kase.amount ?? payment?.amount ?? order?.total ?? null;
  const currency = kase.amount === null && payment ? payment.currency : "INR";
  let amount = money(amountMinor, currency);
  // Foreign amounts show both: $49 (₹4,100).
  if (amountMinor !== null && currency !== "INR" && payment?.base_amount) amount = `${amount} (${money(payment.base_amount)})`;
  // No payment yet (Step 8 F: an expired link or an abandoned checkout): the
  // amount of the link or order the case cites.
  if (amountMinor === null) {
    const cited = repo.caseEvents.listByCase(kase.id).map((e) => e.evidence_ref).filter((x): x is string => !!x);
    const rec = cited.map((id) => repo.rzpLinks.get(id) ?? repo.rzpOrders.get(id)).find((r) => r && r.merchant_id === kase.merchant_id);
    if (rec) amount = money(rec.amount, rec.currency);
  }
  return {
    name: customer?.name ?? buyer?.name ?? payment?.email ?? payment?.contact ?? "A customer",
    amountMinor: currency === "INR" ? amountMinor : (payment?.base_amount ?? amountMinor),
    amount,
    paymentId: kase.payment_id,
    orderNumber: order ? orderLabel(order.number) : null,
  };
}

// ---- Held actions: the refund hold and the dispute Stop window

export type Hold = {
  actionId: string;
  kind: "hold" | "stop";
  text: string; // "Refunding ₹1,299"
  runAfter: number;
  remainingMs: number;
  remaining: { clock: string; words: string };
  control: "Undo" | "Stop";
};

const HOLD_TEXT: Partial<Record<ActToolName, (amount: string) => string>> = {
  refund: (amt) => `Refunding ${amt}`,
  contest_dispute: () => "Contesting this dispute",
  accept_dispute: () => "Accepting this dispute",
};

export function holdsOf(a: Adapters, kase: Case): Hold[] {
  const now = a.clock.now();
  return a.db
    .select()
    .from(s.actions)
    .where(and(eq(s.actions.case_id, kase.id), eq(s.actions.status, "held"), isNotNull(s.actions.run_after)))
    .all()
    .filter((x) => x.run_after! > now)
    .map((x) => {
      const tool = x.tool as ActToolName;
      const argAmount = typeof x.args.amount === "number" ? money(x.args.amount) : subjectOf(a, kase).amount;
      const stop = tool === "contest_dispute" || tool === "accept_dispute";
      return {
        actionId: x.id,
        kind: stop ? "stop" : "hold",
        text: (HOLD_TEXT[tool] ?? (() => `Doing ${actLabel(tool)}`))(argAmount),
        runAfter: x.run_after!,
        remainingMs: x.run_after! - now,
        remaining: countdown(x.run_after! - now),
        control: stop ? "Stop" : "Undo",
      };
    });
}

// ---- Cases inbox

export type CaseRow = {
  id: string;
  moment: string;
  name: string;
  amount: string;
  amountMinor: number;
  state: Chip;
  confidence: Chip;
  age: string;
  openedAt: number;
  action: string;
  holds: Hold[];
  // Gmail-style row: the moment key for filters, a one-line summary, and (only
  // on Needs you) RAY's recommended tap, so a hover can offer it.
  momentKey: Moment;
  summary: string;
  quick: { proposalId: string; label: string; covered: boolean } | null;
};

function summaryOf(kase: Case, sub: Subject): string {
  const order = sub.orderNumber ? `, order ${sub.orderNumber}` : "";
  switch (kase.moment) {
    case "paid_no_order":
      return `Paid ${sub.amount}${order}${kase.state === "waiting_merchant" ? " still Pending" : ""}`;
    case "international":
      return `Card declined abroad, ${sub.amount}`;
    case "subscription":
      return `Subscription stopped, ${sub.amount}`;
    case "chargeback":
      return `Dispute on ${sub.amount}`;
    case "collect":
      return `Invoice of ${sub.amount} overdue`;
  }
}

function caseRow(a: Adapters, kase: Case, cache?: SubjectCache): CaseRow {
  const sub = subjectOf(a, kase, cache);
  return {
    id: kase.id,
    moment: MOMENT_LABEL[kase.moment],
    name: sub.name,
    amount: sub.amount,
    amountMinor: sub.amountMinor ?? 0,
    state: { label: STATE_LABEL[kase.state], tone: STATE_TONE[kase.state] },
    confidence: { label: CONFIDENCE_LABEL[kase.confidence], tone: CONFIDENCE_TONE[kase.confidence] },
    age: age(kase.opened_at, a.clock.now()),
    openedAt: kase.opened_at,
    action: kase.state === "waiting_merchant" ? "Review & decide" : "Open case",
    holds: holdsOf(a, kase),
    momentKey: kase.moment,
    summary: summaryOf(kase, sub),
    quick: null,
  };
}

// ₹ at stake first, then the oldest.
const byStakeThenAge = (x: CaseRow, y: CaseRow) => y.amountMinor - x.amountMinor || x.openedAt - y.openedAt;

export type InboxView = { waitingOnYou: string; tabs: { key: InboxTab; label: string; rows: CaseRow[] }[] };

// The Closed tab shows the last 30 days; older cases are in the numbers on Home.
const CLOSED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function inboxView(a: Adapters, merchantId: string, moment: Moment | null = null): InboxView {
  const now = a.clock.now();
  const cases = createRepository(a.db)
    .cases.list(eq(s.cases.merchant_id, merchantId))
    .filter((c) => !moment || c.moment === moment)
    .filter((c) => tabFor(c.state) !== "closed" || (c.closed_at ?? c.opened_at) >= now - CLOSED_WINDOW_MS);
  const cache = subjectCache();
  const rows = cases.map((c) => ({ c, row: caseRow(a, c, cache) }));
  // The Needs you rows carry RAY's recommended tap for the hover action.
  for (const { c, row } of rows) {
    if (c.state !== "waiting_merchant") continue;
    const yc = caseView(a, c.id).yourCall;
    if (yc.canTap && yc.primary) row.quick = { proposalId: yc.primary.id, label: yc.primary.label, covered: yc.primary.covered };
  }
  const tabs = INBOX_TABS.map((t) => ({
    key: t.key,
    label: t.label,
    rows: rows.filter(({ c }) => tabFor(c.state) === t.key).map(({ row }) => row).sort(byStakeThenAge),
  }));
  const waiting = tabs.find((t) => t.key === "needs_you")!.rows.reduce((sum, r) => sum + r.amountMinor, 0);
  return { waitingOnYou: `${money(waiting)} waiting on you`, tabs };
}

// ---- Free alerts

export type AlertRow = { id: string; at: string; age: string; caseId: string | null; moment: string; name: string; amount: string; cause: string; state: Chip | null };

export function alertsView(a: Adapters, merchantId: string): { merchant: Merchant; alerts: AlertRow[] } {
  const repo = createRepository(a.db);
  const now = a.clock.now();
  const alerts = a.db.select().from(s.alerts).where(eq(s.alerts.merchant_id, merchantId)).orderBy(desc(s.alerts.sent_at)).all();
  return {
    merchant: merchantView(a, merchantId),
    alerts: alerts.map((al) => {
      const kase = al.case_id ? repo.cases.get(al.case_id) : undefined;
      const sub = kase ? subjectOf(a, kase) : null;
      return {
        id: al.id,
        at: dateTime(al.sent_at),
        age: age(al.sent_at, now),
        caseId: kase?.id ?? null,
        moment: kase ? MOMENT_LABEL[kase.moment] : "",
        name: sub?.name ?? "",
        amount: sub?.amount ?? "",
        cause: kase?.cause ? causeLabel(kase.cause) : al.text,
        state: kase ? { label: STATE_LABEL[kase.state], tone: STATE_TONE[kase.state] } : null,
      };
    }),
  };
}

// ---- Case page

export type Finding = { id: string; ok: boolean; text: string; source: FindingSource; evidenceRef: string | null };
export type TimelineStep = { label: string; failed: boolean };
export type TimelineEvent = { id: string; at: string; what: string; who: string; evidenceRef: string | null; details: Record<string, unknown> };
export type ConversationItem = {
  id: string;
  at: string;
  direction: "in" | "out";
  channel: string;
  from: string;
  body: string;
  // A voice note: ▶ · duration · transcript. A call: the Call card.
  voice: VoiceNoteView | null;
  call: CallView | null;
};
// then: the action's own follow-ups, done on the same tap and covered by the
// same approval (a confirmation, the email after a request), listed on the card.
// alsoDoes: the same follow-ups as bare labels (a follow-up's own label when
// it has one, e.g. "Block card ending 4417 (Simulated)"). Both also list
// any later steps the approval covers (ProposedAction.covers, Step 11).
export type Proposal = { id: string; label: string; covered: boolean; draft: string | null; then: string[]; alsoDoes: string[] };
export type ApprovalCard = {
  caseId: string;
  lines: string[];
  primary: Proposal;
  changeAsked: string | null;
  // The merchant's voice note this card answers, if any. It never approves.
  voiceNote: VoiceNoteView | null;
};

export type YourCall = {
  question: string;
  primary: Proposal | null;
  secondary: Proposal[];
  draft: string | null;
  sendFrom: string;
  // Unsure: only the question, never an action button.
  unsure: boolean;
  canTap: boolean;
  changes: { at: string; text: string }[];
};

export type CaseView = {
  id: string;
  merchant: Merchant;
  moment: string;
  name: string;
  amount: string;
  paymentId: string | null;
  paymentShort: string | null;
  orderNumber: string | null;
  open: boolean;
  state: Chip;
  confidence: Chip & { reason: string };
  side: { label: string; note: string } | null;
  promiseLine: string | null;
  timeline: TimelineStep[];
  events: TimelineEvent[];
  findings: Finding[];
  checking: boolean;
  conversation: ConversationItem[];
  yourCall: YourCall;
  holds: Hold[];
  underRule: { ruleId: string; text: string }[];
  results: string[];
  card: ApprovalCard | null;
  preCall: PreCallNotice | null;
  // When the cause is on the merchant's side: the brief for their developer
  // (technical words are fine inside it).
  developerBrief: string | null;
};

const FINAL: CaseState[] = ["closed", "fixed_itself"];

function findingSource(repo: Repo, ref: string | null, payload: Record<string, unknown>): FindingSource {
  const given = payload.source;
  if (given === "Razorpay" || given === "Store" || given === "Customer" || given === "Bank") return given;
  if (!ref) return "Razorpay";
  if (repo.messages.get(ref)) return "Customer";
  if (repo.storeOrders.get(ref)) return "Store";
  if (repo.bankCredits.get(ref)) return "Bank";
  const ev = repo.caseEvents.get(ref);
  if (ev?.type === "message_in") return "Customer";
  if (ev?.payload.source === "store") return "Store";
  return "Razorpay";
}

// Webhook event names as the merchant reads them, for the timeline line.
const EVENT_STEP: Record<string, string> = {
  "payment.authorized": "Paid",
  "payment.captured": "Captured",
  "payment.failed": "Payment failed",
  "order.paid": "Order paid",
  "refund.created": "Refund started",
  "refund.processed": "Refunded",
  "payment.dispute.created": "Dispute opened",
  "subscription.halted": "Subscription stopped",
  "subscription.pending": "Renewal failed",
  "invoice.expired": "Invoice expired",
};

function stepOf(e: CaseEvent): TimelineStep | null {
  const p = e.payload;
  if (e.type === "webhook") {
    const event = String(p.event ?? "");
    const delivery = p.delivery as { processed?: boolean } | undefined;
    const label = EVENT_STEP[event] ?? "Razorpay update";
    if (delivery && delivery.processed === false) return { label: `${label}, then dropped`, failed: true };
    return { label, failed: false };
  }
  if (e.type === "message_in") return { label: p.voice_note ? "Customer sent a voice note" : "Customer wrote", failed: false };
  if (e.type === "message_out") return { label: "Message sent", failed: false };
  if (e.type === "approval") {
    if (p.choice === "change") return null;
    return { label: p.choice === "approve" ? "You approved" : p.choice === "decline" ? "You said no" : "You took over", failed: false };
  }
  if (e.type === "tool_call") {
    if (p.kind === "action_done") return { label: "Done", failed: false };
    if (p.kind === "action_blocked" || p.kind === "action_failed") return { label: "Stopped by a check", failed: true };
    if (p.kind === "action_held") return { label: "On hold", failed: false };
    if (p.kind === "action_undone") return { label: "Undone", failed: false };
  }
  if (e.type === "note" && p.kind === "state_changed") {
    const to = p.to as CaseState;
    if (to === "closed" || to === "fixed_itself" || to === "unconfirmed") return { label: STATE_LABEL[to], failed: false };
  }
  return null;
}

function describe(repo: Repo, e: CaseEvent): { what: string; who: string } {
  const p = e.payload;
  switch (e.type) {
    case "webhook":
      return { what: `Razorpay: ${EVENT_STEP[String(p.event)] ?? "update"}`, who: "Razorpay" };
    case "message_in":
      return { what: p.voice_note ? `Customer sent a voice note: ${String(p.body ?? "")}` : `Customer wrote: ${String(p.body ?? "")}`, who: "Customer" };
    case "message_out":
      return { what: `Sent: ${String(p.body ?? "")}`, who: "RAY" };
    case "approval":
      if (p.choice === "change") return { what: `You tapped Change: ${String(p.text ?? "")}`, who: "You (tap)" };
      return { what: p.choice === "approve" ? "You approved" : p.choice === "decline" ? "You said no to this option" : "You chose to handle it yourself", who: "You (tap)" };
    case "finding":
      return { what: `Found: ${String(p.text)}`, who: "RAY" };
    case "timer":
      return { what: "A follow-up time came up", who: "RAY" };
    case "tool_call": {
      const by = p.approved_by === "tap" ? "You (tap)" : p.approved_by ? `Your rule: ${repo.playbookRules.get(String(p.approved_by))?.text ?? p.approved_by}` : "RAY";
      const label = actLabel(String(p.tool));
      const what = {
        action_done: `Done: ${label}`,
        action_held: `On hold: ${label}`,
        action_blocked: `A check stopped ${label}: ${String(p.reason ?? "")}`,
        action_failed: `Couldn't finish ${label}`,
        action_undone: `Undone: ${label}`,
        action_cancelled: `Called off: ${label}`,
      }[String(p.kind)] ?? label;
      return { what, who: by };
    }
    case "note":
      if (p.kind === "state_changed") return { what: `${STATE_LABEL[p.to as CaseState]}: ${String(p.reason ?? "")}`, who: "RAY" };
      if (p.kind === "alert_sent") return { what: "Alert sent to you", who: "RAY" };
      if (p.kind === "change_requested") return { what: `You asked: ${String(p.text)}`, who: "You" };
      if (p.kind === "change_handled") return { what: `RAY redrafted: ${String(p.reason ?? "")}`, who: "RAY" };
      if (p.kind === "promised_time_reached") return { what: "The time promised to the customer came up", who: "RAY" };
      if (p.kind === "actions_proposed") return { what: "RAY proposed what to do", who: "RAY" };
      if (p.kind === "decided") return { what: `RAY's recommendation: ${String(p.summary ?? "")}`, who: "RAY" };
      if (p.kind === "investigated") return { what: `Checked: ${String(p.reason ?? "")}`, who: "RAY" };
      if (p.kind === "timer_set") return { what: `RAY will follow up at ${formatTime(Number(p.due_at))}`, who: "RAY" };
      if (p.kind === "proposal_declined") return { what: "You said no to this option", who: "You (tap)" };
      if (p.kind === "takeover_cancelled") return { what: "RAY called off what it had planned", who: "RAY" };
      if (p.kind === "call_summary") return { what: String(p.summary ?? "Call ended"), who: "RAY (Simulated call)" };
      if (p.kind === "merchant_voice_note") return { what: `You sent a voice note: ${String(p.transcript ?? "")}`, who: "You (voice note)" };
      if (p.kind === "call_cancelled") return { what: "You cancelled the call", who: "You" };
      if (p.kind === "verified") return { what: `Checked it worked: ${String(p.reason ?? "")}`, who: "RAY" };
      if (p.kind === "approval_handled") return { what: String(p.reason ?? "Done"), who: "RAY" };
      if (p.kind === "tap_ignored") return { what: "Your tap came after the case had moved on, so nothing changed", who: "RAY" };
      if (p.kind === "promised_time_handled") return { what: String(p.reason ?? "Followed up on the promised time"), who: "RAY" };
      // Internal bookkeeping: the full record is under Show evidence.
      return { what: "RAY updated the case", who: "RAY" };
  }
}

function proposalOf(p: ProposedAction): Proposal {
  // The draft is the message the customer gets: the action's own, or the
  // confirmation that follows it on the same tap.
  const message = p.tool === "send_message" ? p.args : p.followUps?.find((f) => f.tool === "send_message")?.args;
  const draft = typeof p.args.draft === "string" ? p.args.draft : typeof message?.body === "string" ? message.body : null;
  const then = [
    ...(p.followUps ?? []).map((f) => `Also on this tap: ${f.label ?? `${actLabel(f.tool)}${typeof f.args.to === "string" ? ` to ${f.args.to}` : ""}`}`),
    ...(p.covers ?? []).map((c) => `Also on this tap: ${c}`),
  ];
  const alsoDoes = [...(p.followUps ?? []).map((f) => f.label ?? (f.tool === "send_message" ? "Send the message below" : actLabel(f.tool))), ...(p.covers ?? [])];
  return { id: p.id, label: p.label, covered: p.covered, draft, then, alsoDoes };
}

export const CHANNEL_LABEL: Record<Message["channel"], string> = { whatsapp: "WhatsApp", email: "Email", voice_note: "WhatsApp voice note", call: "Call" };
const merchantName = (a: Adapters, kase: Case) => createRepository(a.db).merchants.get(kase.merchant_id)?.name ?? "";

function conversationOf(a: Adapters, kase: Case, customerName: string): ConversationItem[] {
  const repo = createRepository(a.db);
  const ids = new Set(
    repo.caseEvents
      .listByCase(kase.id)
      .filter((e) => e.type === "message_in" || e.type === "message_out")
      .map((e) => e.evidence_ref)
      .filter((x): x is string => !!x),
  );
  const rows: Message[] = a.db.select().from(s.messages).where(eq(s.messages.case_id, kase.id)).all();
  if (ids.size) for (const m of a.db.select().from(s.messages).where(inArray(s.messages.id, [...ids])).all()) if (!rows.some((r) => r.id === m.id)) rows.push(m);
  return rows
    .sort((x, y) => x.at - y.at)
    .map((m) => ({
      id: m.id,
      at: dateTime(m.at),
      direction: m.direction,
      channel: CHANNEL_LABEL[m.channel],
      from:
        m.direction === "in"
          ? customerName
          : m.channel === "call"
            ? merchantName(a, kase)
            : m.channel === "email"
              ? `${a.messaging.senderLabel(m.from)} (${m.from})`
              : a.messaging.senderLabel(m.from),
      body: m.body,
      voice: m.channel === "voice_note" ? voiceNoteView(m) : null,
      call: m.channel === "call" ? callView(a, m) : null,
    }));
}

export function caseView(a: Adapters, caseId: string): CaseView {
  const repo = createRepository(a.db);
  const kase = repo.cases.get(caseId);
  if (!kase) throw new Error(`Case ${caseId} not found`);
  const merchant = merchantView(a, kase.merchant_id);
  const sub = subjectOf(a, kase);
  const timeline = repo.caseEvents.listByCase(caseId);

  const lastInvestigated = timeline.findLast((e) => e.payload.kind === "investigated");
  const decided = timeline.findLast((e) => e.payload.kind === "decided");
  const proposals = openProposals({ db: a.db, repo, clock: a.clock }, caseId).map(proposalOf);
  const settings = readSettings(a.db, kase.merchant_id, kase.moment);
  const unsure = kase.confidence === "unsure";
  const waiting = kase.state === "waiting_merchant";

  const findings: Finding[] = timeline
    .filter((e) => e.type === "finding")
    .map((e) => ({ id: e.id, ok: e.payload.ok !== false, text: String(e.payload.text), source: findingSource(repo, e.evidence_ref, e.payload), evidenceRef: e.evidence_ref }));

  const steps = timeline.map(stepOf).filter((x): x is TimelineStep => x !== null);
  const dedup = steps.filter((st, i) => i === 0 || st.label !== steps[i - 1].label);

  const ruleIds = [
    ...new Set(
      a.db
        .select()
        .from(s.actions)
        .where(eq(s.actions.case_id, caseId))
        .all()
        .map((x) => x.approved_by)
        .filter((x): x is string => !!x && x !== "tap"),
    ),
  ];

  const results = timeline
    .filter((e) => e.type === "tool_call" && e.payload.kind === "action_done")
    .map((e) => {
      return `Done: ${actLabel(String(e.payload.tool))} ✓`;
    });

  const changes = timeline.filter((e) => e.payload.kind === "change_requested").map((e) => ({ at: dateTime(e.at), text: String(e.payload.text) }));

  const primary = proposals[0] ?? null;
  // A flow that hands the case back after deciding (Step 8: a near-match
  // transfer, a buyer's reply) records its question as a merchant_question
  // note; the newer of that and the decision is what the merchant is asked.
  const asked = timeline.findLast((e) => e.payload.kind === "merchant_question");
  const askedLatest = asked && (!decided || (asked.seq ?? 0) > (decided.seq ?? 0));
  const question = unsure
    ? String(lastInvestigated?.payload.reason ?? "RAY needs one answer before it can act.")
    : askedLatest
      ? String(asked.payload.text)
      : String(decided?.payload.summary ?? "What should RAY do?");

  const view: CaseView = {
    id: kase.id,
    merchant,
    moment: MOMENT_LABEL[kase.moment],
    name: sub.name,
    amount: sub.amount,
    paymentId: sub.paymentId,
    paymentShort: sub.paymentId ? shortId(sub.paymentId) : null,
    orderNumber: sub.orderNumber,
    open: !FINAL.includes(kase.state),
    state: { label: STATE_LABEL[kase.state], tone: STATE_TONE[kase.state] },
    confidence: {
      label: CONFIDENCE_LABEL[kase.confidence],
      tone: CONFIDENCE_TONE[kase.confidence],
      reason: String(lastInvestigated?.payload.reason ?? "Based on what RAY has checked so far."),
    },
    side: kase.side
      ? { label: SIDE_LABEL[kase.side], note: kase.side === "razorpay" && kase.razorpay_plugin ? `${SIDE_NOTE.razorpay} ${RAZORPAY_PLUGIN_NOTE}.` : SIDE_NOTE[kase.side] }
      : null,
    promiseLine:
      kase.promised_by && !FINAL.includes(kase.state)
        ? `${firstName(sub.name)} was told to expect a reply by ${formatTime(kase.promised_by)}`
        : null,
    timeline: dedup,
    events: timeline.map((e) => ({ id: e.id, at: dateTime(e.at), ...describe(repo, e), evidenceRef: e.evidence_ref, details: e.payload })),
    findings,
    checking: kase.state === "likely",
    conversation: conversationOf(a, kase, sub.name),
    yourCall: {
      question,
      primary: unsure ? null : primary,
      secondary: unsure ? [] : proposals.slice(1),
      draft: primary?.draft ?? null,
      // A verified domain shows its real address: "support@leafybakes.in".
      sendFrom: `RAY will send this from ${settings.sendFrom === "verified_domain" ? a.messaging.senderAddress(kase.merchant_id, "email", "verified_domain") : SENDER_MODE_LABEL[settings.sendFrom](merchant.name)}`,
      unsure,
      canTap: waiting && !merchant.killSwitch,
      changes,
    },
    holds: holdsOf(a, kase),
    underRule: ruleIds.map((id) => ({ ruleId: id, text: `Under your rule: ${repo.playbookRules.get(id)?.text ?? id}` })),
    results,
    card: null,
    preCall: FINAL.includes(kase.state) ? null : preCallNotice(a, kase.id, sub.name),
    developerBrief: (timeline.findLast((e) => e.payload.kind === "pno_developer_brief")?.payload.text as string | undefined) ?? null,
  };
  view.card = cardOf(view, voiceNoteFor(timeline, proposals));
  return view;
}

// The merchant's latest voice note since RAY last proposed, and the open
// option it was about. It only picks which option the card shows.
function voiceNoteFor(timeline: CaseEvent[], proposals: Proposal[]) {
  const since = timeline.findLastIndex((e) => e.payload.kind === "actions_proposed");
  const note = timeline.slice(since + 1).findLast((e) => e.payload.kind === "merchant_voice_note");
  if (!note) return null;
  const p = note.payload;
  return {
    view: voiceNoteView({ transcript: String(p.transcript), body: String(p.transcript), duration_s: Number(p.duration_s ?? 0), audio_ref: (p.audio_ref as string | null) ?? null }),
    about: proposals.find((x) => x.id === p.points_to) ?? null,
  };
}

// The WhatsApp approval card: max 3 lines before the buttons, one ask.
function cardOf(v: CaseView, voice: ReturnType<typeof voiceNoteFor> = null): ApprovalCard | null {
  // Unsure: no action card, voice note or not.
  if (!v.yourCall.primary || !v.yourCall.canTap) return null;
  const p = voice?.about ?? v.yourCall.primary;
  const why = v.side ? `${v.side.label}. ${v.side.note}` : v.confidence.reason;
  return {
    caseId: v.id,
    lines: [`${v.name}, ${v.amount}: ${v.moment}${v.orderNumber ? `, order ${v.orderNumber}` : ""}.`, why, v.yourCall.question],
    primary: p,
    changeAsked: v.yourCall.changes.at(-1)?.text ?? null,
    voiceNote: voice?.view ?? null,
  };
}

// Every card waiting on the merchant, one per case.
export function approvalCards(a: Adapters, merchantId: string): ApprovalCard[] {
  return createRepository(a.db)
    .cases.list(and(eq(s.cases.merchant_id, merchantId), eq(s.cases.state, "waiting_merchant")))
    .map((c) => caseView(a, c.id).card)
    .filter((c): c is ApprovalCard => c !== null);
}

// ---- Twice-daily digest (10 AM and 6 PM)

export const DIGEST_HOURS = [10, 18] as const;
const IST_MS = (5 * 60 + 30) * 60_000;

export function nextDigestAt(now: number): number {
  const day = Math.floor((now + IST_MS) / 86_400_000) * 86_400_000 - IST_MS;
  for (const d of [0, 1]) for (const h of DIGEST_HOURS) {
    const at = day + d * 86_400_000 + h * 3_600_000;
    if (at > now) return at;
  }
  return day + 86_400_000 + DIGEST_HOURS[0] * 3_600_000;
}

export type DigestView = { count: number; total: string; text: string; nextAt: string; details: { n: number; caseId: string; line: string }[] };

export function digestView(a: Adapters, merchantId: string): DigestView {
  const rows = inboxView(a, merchantId).tabs.find((t) => t.key === "needs_you")!.rows;
  const total = money(rows.reduce((sum, r) => sum + r.amountMinor, 0));
  const count = rows.length;
  return {
    count,
    total,
    text: count === 0 ? "Nothing needs you right now." : `${count} ${count === 1 ? "case needs" : "cases need"} you, ${total} at stake. Reply details to see them.`,
    nextAt: formatTime(nextDigestAt(a.clock.now())),
    details: rows.map((r, i) => ({ n: i + 1, caseId: r.id, line: `${r.name} · ${r.amount} · ${r.moment}` })),
  };
}

// ---- Playbook

export type PlaybookView = {
  merchant: Merchant;
  approvalLimit: string;
  approvalLimitRupees: number;
  moments: {
    moment: Moment;
    label: string;
    rules: { id: string; text: string; status: "proposed" | "approved" | "off"; limit: string | null }[];
    settings: ReturnType<typeof readSettings>;
    sendFromOptions: { value: string; label: string }[];
  }[];
};

export function playbookView(a: Adapters, merchantId: string): PlaybookView {
  const repo = createRepository(a.db);
  const m = repo.merchants.get(merchantId)!;
  const rules = repo.playbookRules.list(eq(s.playbookRules.merchant_id, merchantId)).filter((r) => !isSettingRow(r));
  return {
    merchant: merchantView(a, merchantId),
    approvalLimit: money(m.approval_limit),
    approvalLimitRupees: m.approval_limit / 100,
    moments: s.MOMENTS.map((moment) => ({
      moment,
      label: MOMENT_LABEL[moment],
      rules: rules
        .filter((r) => r.moment === moment)
        .map((r) => ({
          id: r.id,
          text: r.text,
          status: r.status,
          limit: typeof r.rule_json.max === "number" ? `Up to ${money(r.rule_json.max)}` : typeof r.rule_json.min === "number" ? `Above ${money(r.rule_json.min)}` : null,
        })),
      settings: readSettings(a.db, merchantId, moment),
      sendFromOptions: s.SENDER_MODES.map((mode) => ({ value: mode, label: SENDER_MODE_LABEL[mode](m.name) })),
    })),
  };
}

// ---- Evidence: the raw record behind a finding or timeline event

export function evidence(a: Adapters, merchantId: string, ref: string): unknown {
  const repo = createRepository(a.db);
  const mine = <T extends { merchant_id?: string | null }>(r: T | undefined) => (r && (!r.merchant_id || r.merchant_id === merchantId) ? r : undefined);
  const ev = repo.caseEvents.get(ref);
  if (ev && repo.cases.get(ev.case_id)?.merchant_id === merchantId) return ev;
  const msg = repo.messages.get(ref);
  if (msg && (!msg.case_id || repo.cases.get(msg.case_id)?.merchant_id === merchantId)) return msg;
  const action = repo.actions.get(ref);
  if (action && repo.cases.get(action.case_id)?.merchant_id === merchantId) return action;
  const timer = repo.timers.get(ref);
  if (timer && repo.cases.get(timer.case_id)?.merchant_id === merchantId) return timer;
  return (
    mine(repo.webhookDeliveries.get(ref)) ??
    mine(repo.rzpPayments.get(ref)) ??
    mine(repo.rzpOrders.get(ref)) ??
    mine(repo.rzpRefunds.get(ref)) ??
    mine(repo.storeOrders.get(ref)) ??
    mine(repo.disputes.get(ref)) ??
    mine(repo.bankCredits.get(ref)) ??
    null
  );
}

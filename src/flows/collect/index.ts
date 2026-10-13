// Moment 5: Invoice overdue (build guide Step 11). One loop in three parts:
// chase, read the reply, match the money. A reply changes the next chase; a
// match closes it. Runs for Banking+ merchants; others get the read-only
// overdue view with a Banking+ offer (morning.ts).
//
// One case per buyer with money owed. Stages, replies and matching are code
// (stages.ts, replies.ts, match.ts); the model only reads bank remarks and
// remittance advice (advice.ts). Every act goes through guardedCall: before
// due and gentle reminders run alone; firm reminders, calls and MSME notices
// wait for the merchant's tap; Sure credits post alone with undo, Likely
// waits for a tap, Unsure only asks.
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import { firstNameOf } from "@/adapters/voice";
import * as s from "@/db/schema";
import type { EngineEvent } from "@/engine/events";
import { openProposals } from "@/engine/orchestrator";
import type { Approval, Detection, EngineContext, Finding, InvestigateResult, ProposedAction, Specialist, TimerRequest, VerifyResult } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { formatDate, formatMoney, guardedCall, type GuardedResult } from "@/guards";
import { createAi } from "@/ai";
import { writeSpec, type WriteInput, type WriteOutput } from "@/ai/jobs/write";
import { runJob } from "@/ai/runner";
import type { AiResult } from "@/ai/types";
import { caseFacts } from "@/guards/facts";
import { readSettings } from "@/surfaces/playbook";
import { idAliases } from "../shared/stable-ids";
import { defaultReader, type RemittanceReader } from "./advice";
import {
  addPending,
  addPromise,
  brokenCount,
  buyerOf,
  chaseable,
  CHECK_TIMER,
  creditCaseOf,
  invoicesOf,
  N,
  note,
  notes,
  openCaseForBuyer,
  openInvoicesOfBuyer,
  owedOn,
  pausedBy,
  pendingItems,
  promisesFor,
  resolve,
  settled,
  stagesDone,
  stagesFor,
  tdsClaimed,
  writeFacts,
  type Ctx,
  type Pending,
  type PendingMeta,
} from "./data";
import { readDate } from "./dates";
import { matchCredit, type Allocation, type MatchResult, type OpenInvoice } from "./match";
import * as M from "./messages";
import { invoicesNamed, readReply, type Reading } from "./replies";
import { buyerAtAddress, buyerByName, buyerFromRemark, creditByUtrOrAmount, fullLoop, kindOf, resolveHandoff, type EventKind } from "./resolve";
import {
  DAY,
  daysOverdue,
  HOUR,
  istMidnight,
  ladderStage,
  LADDER,
  msmeDue,
  nextCheckAt,
  nextStage,
  STAGE_LABEL,
  type Buyer,
  type Invoice,
  type Stage,
} from "./stages";

export { COLLECT_HANDOFF, BANK_CREDIT_EVENT, BANKING_SOURCE, COLLECT_SOURCE, MORNING_KIND } from "./resolve";
export { CHECK_TIMER } from "./data";

// Ladder stages are at least this far apart for one invoice, so an invoice
// found late doesn't get gentle, firm and a call on three days running.
export const STAGE_GAP_MS = 3 * DAY;
// "Says paid" with no credit yet: chasing waits this long for the money.
export const SAYS_PAID_PAUSE_MS = 3 * DAY;
// Call attempts per Call stage.
export const CALL_ATTEMPTS = 3;
// A hardship plan: this many weekly parts.
export const PLAN_PARTS = 3;

// writer: the write job, for Change redrafts (replay by default).
export type CollectOptions = { reader?: RemittanceReader; writer?: DraftWriter };
export type DraftWriter = (ctx: EngineContext, input: WriteInput, caseId: string) => Promise<AiResult<WriteOutput>>;
const defaultWriter: DraftWriter = (ctx, input, caseId) => runJob(createAi({ repo: ctx.repo }).ctx, writeSpec, input, { caseId });

type Outcome = { to: "chasing" | "merchant" | "closed"; reason: string; findings: Finding[]; outcome?: string };

const tail = (number: string) => number.match(/(\d{3,})$/)?.[1] ?? number;
const nums = (invs: Pick<Invoice, "number">[]) => {
  const t = invs.map((i) => tail(i.number));
  return `${t.length > 1 ? "invoices" : "invoice"} ${t.length <= 1 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`}`;
};

export function createCollectSpecialist(opts: CollectOptions = {}): Specialist {
  const reader = opts.reader ?? defaultReader();
  const writer = opts.writer ?? defaultWriter;

  const adaptersOf = (ctx: Ctx) => {
    if (!ctx.adapters) throw new Error("Collect needs adapters");
    return ctx.adapters;
  };
  const merchantOf = (ctx: Ctx, kase: Case) => ctx.repo.merchants.get(kase.merchant_id)!;
  // WhatsApp and call consent is for the buyer's number on file.
  const consented = (ctx: Ctx, b: Buyer, channel: "email" | "whatsapp" | "call") =>
    adaptersOf(ctx).messaging.buyerConsent(b.id, channel, channel === "email" ? null : b.phone) === "opted_in";

  // An approved playbook rule for this step, thresholds included ("call
  // buyers who owe more than ₹1 lakh"). Key accounts never run under a
  // rule: a tap for anything firm and a tap per call. MSME notices always
  // need a tap. The approval guard checks the rule and its threshold again.
  function ruleFor(ctx: Ctx, kase: Case, b: Buyer, tool: string, kind: string): string | null {
    if (b.key_account) return null;
    const amount = syncAmount(ctx, kase);
    const rule = ctx.repo.playbookRules
      .list(and(eq(s.playbookRules.merchant_id, kase.merchant_id), eq(s.playbookRules.moment, "collect"), eq(s.playbookRules.status, "approved")))
      .find((r) => {
        const j = r.rule_json;
        if (j.tool !== tool || (j.kind !== undefined && j.kind !== kind)) return false;
        if (typeof j.min === "number" && amount <= j.min) return false;
        if (typeof j.max === "number" && amount > j.max) return false;
        return true;
      });
    return rule?.id ?? null;
  }
  const line = (ctx: Ctx, inv: Invoice): M.Line => ({ id: inv.id, number: inv.number, due_date: inv.due_date, accepted_at: inv.accepted_at, owed: owedOn(ctx.db, inv) });
  const openInv = (ctx: Ctx, inv: Invoice): OpenInvoice => ({
    id: inv.id,
    number: inv.number,
    due_date: inv.due_date,
    amount: inv.amount,
    outstanding: owedOn(ctx.db, inv),
    taxable: inv.taxable_value ?? inv.amount,
  });
  const call = (ctx: Ctx, kase: Case, tool: string, args: Record<string, unknown>, approval?: Approval, idempotencyKey?: string) =>
    guardedCall(tool, args, { adapters: adaptersOf(ctx), caseId: kase.id, approval, idempotencyKey });
  const failure = (r: GuardedResult) => (r.status === "blocked" ? r.failures[0].reason : r.status === "failed" ? r.error : null);

  function ensureCheck(ctx: Ctx, kase: Case): TimerRequest[] {
    const pending = ctx.db
      .select()
      .from(s.timers)
      .where(and(eq(s.timers.case_id, kase.id), eq(s.timers.kind, CHECK_TIMER), isNull(s.timers.fired_at), isNull(s.timers.cancelled_at)))
      .get();
    if (pending) return [];
    const now = ctx.clock.now();
    return [{ kind: CHECK_TIMER, inMs: nextCheckAt(now) - now }];
  }

  // ---- Who the event is about

  function buyerForEvent(ctx: Ctx, e: EngineEvent, k: EventKind | null): Buyer | undefined {
    if (k === "morning") return ctx.repo.buyers.get(String(e.payload.buyer_id));
    if (k === "handoff") return resolveHandoff(ctx, e)?.buyer;
    if (k === "buyer_message") return buyerAtAddress(ctx, e.merchantId, e);
    if (k === "credit") {
      const credit = ctx.repo.bankCredits.get(String(e.payload.credit_id));
      return credit ? buyerFromCredit(ctx, e.merchantId, credit) : undefined;
    }
    return undefined;
  }

  // The payer of a credit, in code: the remark, a UTR the buyer already
  // gave RAY, or the payment on a pay link RAY sent them.
  function buyerFromCredit(ctx: Ctx, merchantId: string, credit: typeof s.bankCredits.$inferSelect): Buyer | undefined {
    const byRemark = buyerFromRemark(ctx, merchantId, credit.remark);
    if (byRemark) return byRemark;
    const cases = ctx.repo.cases.list(and(eq(s.cases.merchant_id, merchantId), eq(s.cases.moment, "collect")));
    for (const c of cases) {
      const viaUtr = notes(ctx, c.id, N.utr).some((u) => String(u.payload.utr).toUpperCase() === credit.utr.toUpperCase());
      const viaLink = notes(ctx, c.id, N.link).some((l) => {
        const link = ctx.repo.rzpLinks.get(String(l.payload.link_id));
        const paid = link?.payment_id ? ctx.repo.rzpPayments.get(link.payment_id) : undefined;
        return credit.remark.includes(String(l.payload.link_id)) || (!!paid?.utr && paid.utr === credit.utr);
      });
      const b = viaUtr || viaLink ? buyerOf(ctx, c.id) : null;
      if (b) return b;
    }
    return undefined;
  }

  // ---- Setup: the case's buyer and invoices

  function attach(ctx: Ctx, kase: Case, e: EngineEvent | null, k: EventKind | null) {
    let buyer = buyerOf(ctx, kase.id);
    if (!notes(ctx, kase.id, N.case).length) {
      buyer = (e && buyerForEvent(ctx, e, k)) ?? null;
      const creditId = k === "credit" && !buyer ? String(e!.payload.credit_id) : null;
      note(ctx, kase.id, { kind: N.case, buyer_id: buyer?.id ?? null, credit_id: creditId }, buyer?.id ?? creditId ?? kase.id);
    }
    if (!buyer) return null;
    const have = new Set(invoicesOf(ctx, kase.id).map((i) => i.id));
    const now = ctx.clock.now();
    const add = [...chaseable(ctx.db, buyer, now)];
    if (k === "handoff" && e) {
      const h = resolveHandoff(ctx, e);
      if (h && h.buyer.id === buyer.id) add.push(h.invoice);
    }
    for (const inv of add) {
      if (have.has(inv.id)) continue;
      have.add(inv.id);
      note(ctx, kase.id, { kind: N.invoice, invoice_id: inv.id, number: inv.number, via: k }, inv.id);
    }
    return buyer;
  }

  function syncAmount(ctx: Ctx, kase: Case) {
    const owed = invoicesOf(ctx, kase.id).reduce((n, i) => n + owedOn(ctx.db, i), 0);
    if (owed !== kase.amount) ctx.repo.cases.update(kase.id, { amount: owed });
    return owed;
  }

  // ---- Chase

  type Due = { inv: Invoice; stage: Exclude<Stage, "msme"> };

  function nextFor(ctx: Ctx, kase: Case, inv: Invoice, now: number): Due | null {
    if (owedOn(ctx.db, inv) <= 0 || pausedBy(ctx, kase.id, inv, now)) return null;
    const done = stagesFor(ctx, kase.id, inv.id).filter((d) => d.stage !== "msme");
    const last = done.at(-1);
    const lastIdx = Math.max(-1, ...done.map((d) => LADDER.indexOf(d.stage)));
    const flagged = notes(ctx, kase.id, N.flag).findLast((f) => f.payload.invoice_id === inv.id && !f.payload.used);
    let target = ladderStage(inv, now);
    if (flagged) {
      // Two broken promises: on to the next stage now, whatever the dates say.
      const next = nextStage((LADDER[Math.max(lastIdx, 0)] ?? "gentle") as Exclude<Stage, "msme">);
      if (!target || LADDER.indexOf(next) > LADDER.indexOf(target)) target = next;
    }
    if (!target) return null;
    if (target === "before_due" && now >= inv.due_date) return null;
    if (target === "call" && !done.some((d) => d.stage === "gentle" || d.stage === "firm")) target = "firm";
    if (LADDER.indexOf(target) <= lastIdx) return null;
    if (!flagged && last && now - last.at < STAGE_GAP_MS) return null;
    return { inv, stage: target };
  }

  function markStage(ctx: Ctx, kase: Case, stage: Stage, invoiceIds: string[], how: string, ref: string) {
    note(ctx, kase.id, { kind: N.stage, stage, invoice_ids: invoiceIds, how }, ref);
    for (const f of notes(ctx, kase.id, N.flag).filter((x) => invoiceIds.includes(String(x.payload.invoice_id)) && !x.payload.used)) {
      note(ctx, kase.id, { kind: N.flag, invoice_id: f.payload.invoice_id, reason: f.payload.reason, used: true }, f.id);
    }
  }

  async function sendAuto(ctx: Ctx, kase: Case, b: Buyer, stage: "before_due" | "gentle", invs: Invoice[], ref: string, out: Outcome) {
    const m = merchantOf(ctx, kase);
    const email = !!b.email && consented(ctx, b, "email");
    const wa = stage === "gentle" && !!b.phone && m.whatsapp_on && consented(ctx, b, "whatsapp");
    const lines = invs.map((i) => line(ctx, i));
    if (!email && !wa) return unreachable(ctx, kase, b, ref);
    const totalOwed = lines.reduce((n, l) => n + l.owed, 0);
    let link: string | null = null;
    if (email) {
      const r = await call(ctx, kase, "payment_link", {
        amount: totalOwed,
        description: `${m.name} invoice ${lines.map((l) => l.number).join(", ")}`.slice(0, 2048),
        customer: { name: b.name, email: b.email ?? undefined, contact: b.phone ?? undefined },
      });
      if (r.status === "done") {
        link = String(r.result.short_url);
        note(ctx, kase.id, { kind: N.link, link_id: r.result.id, short_url: link, invoice_ids: invs.map((i) => i.id) }, r.action.id);
      }
    }
    const built = stage === "before_due" ? M.beforeDue(b, m.name, lines, link, ctx.clock.now()) : M.gentle(b, m.name, lines, link, ctx.clock.now());
    writeFacts(ctx, kase.id, built.facts, ref);
    const kind = stage === "before_due" ? "before_due_reminder" : "gentle_reminder";
    const sent: string[] = [];
    if (email) {
      const r = await call(ctx, kase, "send_message", { channel: "email", to: b.email, sender_mode: "via_razorpay", kind, body: built.body });
      if (r.status === "done") sent.push("email");
      else return blocked(ctx, kase, r, ref);
    }
    if (wa) {
      for (const l of lines) {
        const r = await call(ctx, kase, "send_message", {
          channel: "whatsapp", to: b.phone, sender_mode: "merchant_inbox", kind, template_id: "invoice_reminder",
          params: { name: firstNameOf(b.contact_name), invoice: l.number, amount: M.exact(l.owed), merchant: m.name, date: formatDate(l.due_date) },
        });
        if (r.status !== "done") return blocked(ctx, kase, r, ref);
      }
      sent.push("WhatsApp");
    }
    markStage(ctx, kase, stage, invs.map((i) => i.id), sent.join(" and "), ref);
    out.findings.push({ text: `${STAGE_LABEL[stage]} sent to ${b.contact_name} by ${sent.join(" and ")} for ${nums(invs)}.`, evidenceRef: invs[0].id });
  }

  function unreachable(ctx: Ctx, kase: Case, b: Buyer, ref: string) {
    const channels = (["email", "whatsapp", "call"] as const).filter((c) => consented(ctx, b, c));
    addPending(ctx, kase.id, {
      itemId: `unreachable_${b.id}`,
      ask: `I can't message ${b.name}: they haven't opted in to email, WhatsApp or calls. Add their consent, or handle this one yourself?`,
      proposal: null,
      meta: { type: "unreachable" },
    }, ref);
    note(ctx, kase.id, { kind: N.unreachable, buyer_id: b.id, channels }, b.id);
  }

  function blocked(ctx: Ctx, kase: Case, r: GuardedResult, ref: string) {
    const why = failure(r) ?? "A check stopped it.";
    addPending(ctx, kase.id, { itemId: `blocked_${r.action.id}`, ask: `${why} What should I do instead?`, proposal: null, meta: { type: "blocked" } }, ref);
  }

  // A proposal plus the facts its message quotes, written now so the
  // grounding check finds them when the tap sends it.
  function offer(ctx: Ctx, kase: Case, itemId: string, ask: string, proposal: ProposedAction, meta: PendingMeta, facts: Record<string, string>, ref: string, replaces?: string) {
    if (replaces) for (const p of pendingItems(ctx, kase.id).filter((x) => x.meta.type === replaces && x.itemId !== itemId)) resolve(ctx, kase.id, p.itemId, "replaced", ref);
    if (addPending(ctx, kase.id, { itemId, ask, proposal: { ...proposal, id: itemId }, meta }, ref)) writeFacts(ctx, kase.id, facts, ref);
  }

  async function firmOffer(ctx: Ctx, kase: Case, b: Buyer, invs: Invoice[], ref: string) {
    const m = merchantOf(ctx, kase);
    const now = ctx.clock.now();
    const lines = invs.map((i) => line(ctx, i));
    const built = M.firm(b, m.name, lines, now);
    const actions: { tool: string; args: Record<string, unknown> }[] = [];
    if (b.email && consented(ctx, b, "email")) actions.push({ tool: "send_message", args: { channel: "email", to: b.email, sender_mode: "via_razorpay", kind: "firm_reminder", body: built.body } });
    if (b.phone && m.whatsapp_on && consented(ctx, b, "whatsapp")) {
      for (const l of lines) {
        actions.push({
          tool: "send_message",
          args: { channel: "whatsapp", to: b.phone, sender_mode: "merchant_inbox", kind: "firm_reminder", template_id: "invoice_reminder", params: { name: firstNameOf(b.contact_name), invoice: l.number, amount: M.exact(l.owed), merchant: m.name, date: formatDate(l.due_date) } },
        });
      }
    }
    if (!actions.length) return unreachable(ctx, kase, b, ref);
    const oldest = Math.max(...invs.map((i) => daysOverdue(i, now)));
    const owed = lines.reduce((n, l) => n + l.owed, 0);
    const itemId = `firm_${invs.map((i) => tail(i.number)).sort().join("_")}`;
    const ruleId = ruleFor(ctx, kase, b, "send_message", "firm_reminder");
    if (ruleId) return underRule(ctx, kase, ruleId, actions, built.facts, ref, async () => {
      markStage(ctx, kase, "firm", invs.map((i) => i.id), "under your rule", ref);
    });
    const key = b.key_account ? " They're a key account, so this waits for you." : "";
    offer(
      ctx, kase, itemId,
      `${b.name} owes ${formatMoney(owed)} on ${nums(invs)}, the oldest ${oldest} days overdue.${key} Send a firm reminder?`,
      { id: itemId, label: "Send firm reminder", tool: actions[0].tool, args: actions[0].args, covered: false, followUps: actions.slice(1) },
      { type: "firm", stage: "firm", invoice_ids: invs.map((i) => i.id) },
      built.facts, ref, "firm",
    );
  }

  function msmeOffer(ctx: Ctx, kase: Case, b: Buyer, invs: Invoice[], ref: string) {
    if (!b.email || !consented(ctx, b, "email")) return;
    const m = merchantOf(ctx, kase);
    const lines = invs.map((i) => line(ctx, i));
    const built = M.msme(b, m.name, lines, ctx.clock.now());
    const owed = lines.reduce((n, l) => n + l.owed, 0);
    const itemId = `msme_${invs.map((i) => tail(i.number)).sort().join("_")}`;
    offer(
      ctx, kase, itemId,
      `${b.name} is past the 45-day MSME limit on ${nums(invs)} (${formatMoney(owed)}). Send an MSME notice?`,
      { id: itemId, label: "Send MSME notice", tool: "send_message", args: { channel: "email", to: b.email, sender_mode: "via_razorpay", kind: "msme_notice", body: built.body }, covered: false },
      { type: "msme", stage: "msme", invoice_ids: invs.map((i) => i.id) },
      built.facts, ref, "msme",
    );
  }

  function callArgs(ctx: Ctx, kase: Case, b: Buyer, invs: Invoice[]) {
    const m = merchantOf(ctx, kase);
    const lines = invs.map((i) => line(ctx, i));
    const script = M.callScript(b, m.name, lines, syncAmount(ctx, kase), ctx.clock.now());
    return { args: { kind: "collect_call", to: b.phone, opening: script.opening, lines: script.lines }, facts: script.facts };
  }

  // The call's own follow-up: the details by email, as the call promises.
  function callFollowUps(ctx: Ctx, kase: Case, b: Buyer, invs: Invoice[]) {
    if (!b.email || !consented(ctx, b, "email")) return { followUps: [], facts: {} };
    const built = M.callDetails(b, merchantOf(ctx, kase).name, invs.map((i) => line(ctx, i)), ctx.clock.now());
    return { followUps: [{ tool: "send_message", args: { channel: "email", to: b.email, sender_mode: "via_razorpay", kind: "status", body: built.body } }], facts: built.facts };
  }

  const RETRIES_LINE = `Up to ${CALL_ATTEMPTS - 1} more tries on the next days if there's no answer`;

  async function callOffer(ctx: Ctx, kase: Case, b: Buyer, invs: Invoice[], attempt: number, ref: string, out?: Outcome) {
    if (!b.phone || !consented(ctx, b, "call")) {
      markStage(ctx, kase, "call", invs.map((i) => i.id), "skipped: no call consent", ref);
      return false;
    }
    const { args, facts } = callArgs(ctx, kase, b, invs);
    const fu = callFollowUps(ctx, kase, b, invs);
    const ruleId = attempt === 1 ? ruleFor(ctx, kase, b, "place_call", "collect_call") : null;
    if (ruleId && out) {
      writeFacts(ctx, kase.id, { ...facts, ...fu.facts }, ref);
      const approval: Approval = { by: "rule", ruleId, evidenceRef: ref };
      const r = await call(ctx, kase, "place_call", args, approval);
      if (r.status !== "done") {
        blocked(ctx, kase, r, ref);
        return true;
      }
      for (const f of fu.followUps) {
        const fr = await call(ctx, kase, f.tool, f.args, { ...approval, followUpOf: r.action.id });
        if (fr.status !== "done") note(ctx, kase.id, { kind: "collect_follow_up_failed", tool: f.tool, why: failure(fr) }, fr.action.id);
      }
      afterCall(ctx, kase, b, invs, r.result, { by: "rule", ruleId, evidenceRef: ref, args }, attempt, out, ref);
      out.findings.push({ text: `Called ${firstNameOf(b.contact_name)} under your rule. (Simulated)`, evidenceRef: r.action.id });
      return true;
    }
    const itemId = `call_${kase.id.slice(-6)}_${attempt}`;
    const owed = invs.reduce((n, i) => n + owedOn(ctx.db, i), 0);
    const why = b.key_account ? " They're a key account, so each call waits for your tap." : attempt > 1 ? "" : " One tap covers this call and up to two retries.";
    offer(
      ctx, kase, itemId,
      `${b.name} still owes ${formatMoney(owed)} after the reminders.${why} Call ${firstNameOf(b.contact_name)} to ask for a payment date?`,
      { id: itemId, label: `Call ${firstNameOf(b.contact_name)}`, tool: "place_call", args, covered: false, followUps: fu.followUps, covers: b.key_account ? [] : [RETRIES_LINE] },
      { type: "call", stage: "call", invoice_ids: invs.map((i) => i.id), attempt },
      { ...facts, ...fu.facts }, ref, "call",
    );
    return true;
  }

  // Runs an action and its own follow-ups now, under an approved rule.
  async function underRule(ctx: Ctx, kase: Case, ruleId: string, actions: { tool: string; args: Record<string, unknown> }[], facts: Record<string, string>, ref: string, after: () => Promise<void>) {
    writeFacts(ctx, kase.id, facts, ref);
    const approval: Approval = { by: "rule", ruleId, evidenceRef: ref };
    const [main, ...rest] = actions;
    const r = await call(ctx, kase, main.tool, main.args, approval);
    if (r.status !== "done") return blocked(ctx, kase, r, ref);
    for (const f of rest) {
      const fr = await call(ctx, kase, f.tool, f.args, { ...approval, followUpOf: r.action.id });
      if (fr.status !== "done") return blocked(ctx, kase, fr, ref);
    }
    await after();
  }

  // Promises whose date has passed: kept if the money came, else broken.
  // The second broken promise moves the invoice on a stage and flags it.
  function checkPromises(ctx: Ctx, kase: Case, out: Outcome) {
    const now = ctx.clock.now();
    for (const inv of invoicesOf(ctx, kase.id)) {
      for (const p of promisesFor(ctx.repo, inv.id).filter((x) => x.status === "open" && x.promised_date + DAY <= now)) {
        if (settled(ctx.db, inv) || owedOn(ctx.db, inv) <= 0) {
          ctx.repo.promises.update(p.id, { status: "kept" });
          note(ctx, kase.id, { kind: N.kept, promise_id: p.id, invoice_id: inv.id }, p.id);
          continue;
        }
        ctx.repo.promises.update(p.id, { status: "broken" });
        const count = brokenCount(ctx.repo, inv.id);
        note(ctx, kase.id, { kind: N.broken, promise_id: p.id, invoice_id: inv.id, count }, p.id);
        out.findings.push({ text: `${inv.number}: the promise to pay by ${formatDate(p.promised_date)} was broken${count >= 2 ? ` (${count} broken promises)` : ""}.`, evidenceRef: p.id });
        if (count >= 2) {
          note(ctx, kase.id, { kind: N.flag, invoice_id: inv.id, reason: `${count} broken promises` }, p.id);
        }
      }
    }
  }

  // Declined stage proposals don't come back: the stage counts as done.
  function recordDeclines(ctx: Ctx, kase: Case, ref: string) {
    const timeline = ctx.repo.caseEvents.listByCase(kase.id);
    const declined = new Set(timeline.filter((e) => e.payload.kind === "proposal_declined").map((e) => String(e.payload.proposal_id)));
    const handled = new Set(timeline.filter((e) => e.payload.kind === N.resolved).map((e) => String(e.payload.item_id)));
    for (const e of timeline.filter((x) => x.payload.kind === N.pending)) {
      const id = String(e.payload.item_id);
      if (!declined.has(id) || handled.has(id)) continue;
      handled.add(id);
      const meta = e.payload.meta as PendingMeta;
      resolve(ctx, kase.id, id, "declined", ref);
      if (meta.stage) markStage(ctx, kase, meta.stage as Stage, meta.invoice_ids as string[], "declined by you", ref);
      // A dispute the merchant doesn't accept is chased in full again.
      if (meta.type === "credit_note" || meta.type === "correction") ctx.repo.invoices.update(String(meta.invoice_id), { disputed_part: null });
    }
  }

  // A chase step waiting on a tap is withdrawn once an invoice in it is
  // paused (a promise, a dispute) or paid; the rest is offered again.
  function withdrawStale(ctx: Ctx, kase: Case, ref: string) {
    const now = ctx.clock.now();
    for (const p of pendingItems(ctx, kase.id).filter((x) => x.meta.stage)) {
      const ids = (p.meta.invoice_ids as string[]) ?? [];
      const stale = ids.some((id) => {
        const inv = ctx.repo.invoices.get(id)!;
        return owedOn(ctx.db, inv) <= 0 || !!pausedBy(ctx, kase.id, inv, now);
      });
      if (stale) resolve(ctx, kase.id, p.itemId, "no longer needed", ref);
    }
  }

  // offersOnly: after a reply or a credit, only re-offer what waits on a
  // tap; reminders that run alone go out on the daily check.
  async function chase(ctx: Ctx, kase: Case, b: Buyer, out: Outcome, ref: string, offersOnly = false) {
    const now = ctx.clock.now();
    const m = merchantOf(ctx, kase);
    withdrawStale(ctx, kase, ref);
    const invs = invoicesOf(ctx, kase.id).filter((i) => owedOn(ctx.db, i) > 0);
    const due = invs.map((i) => nextFor(ctx, kase, i, now)).filter((x): x is Due => !!x);
    const group = (st: Stage) => due.filter((d) => d.stage === st).map((d) => d.inv);

    if (!offersOnly) {
      for (const st of ["before_due", "gentle"] as const) {
        const g = group(st);
        if (g.length) await sendAuto(ctx, kase, b, st, g, ref, out);
      }
    }
    const firm = group("firm");
    if (firm.length) await firmOffer(ctx, kase, b, firm, ref);
    const calls = group("call");
    if (calls.length && !pendingItems(ctx, kase.id).some((p) => p.meta.type === "call") && !callRunning(ctx, kase)) await callOffer(ctx, kase, b, calls, 1, ref, offersOnly ? undefined : out);
    if (!offersOnly) await retryCall(ctx, kase, b, out, ref);

    if (m.udyam) {
      const done = new Set(stagesDone(ctx, kase.id).filter((d) => d.stage === "msme").flatMap((d) => d.invoice_ids));
      const msme = invs.filter((i) => msmeDue(i, true, now) && !done.has(i.id) && !pausedBy(ctx, kase.id, i, now));
      if (msme.length) msmeOffer(ctx, kase, b, msme, ref);
    }
  }

  // ---- Calls

  const callResults = (ctx: Ctx, kase: Case) => notes(ctx, kase.id, N.call);
  // A Call stage is running when its last attempt asks for a retry.
  const callRunning = (ctx: Ctx, kase: Case) => {
    const last = callResults(ctx, kase).at(-1);
    return !!last && last.payload.retry === true;
  };

  async function retryCall(ctx: Ctx, kase: Case, b: Buyer, out: Outcome, ref: string) {
    const last = callResults(ctx, kase).at(-1);
    if (!last || last.payload.retry !== true) return;
    if (ctx.clock.now() - last.at < 20 * HOUR) return;
    const attempt = Number(last.payload.attempt) + 1;
    const invoiceIds = last.payload.invoice_ids as string[];
    const invs = invoicesOf(ctx, kase.id).filter((i) => invoiceIds.includes(i.id) && owedOn(ctx.db, i) > 0);
    // Mark this retry as taken, whatever happens next.
    note(ctx, kase.id, { kind: N.call, outcome: "retrying", retry: false, attempt: last.payload.attempt, invoice_ids: invoiceIds }, last.id);
    if (!invs.length) return;
    const by = last.payload.tap as CallApproval;
    if (b.key_account || !by) {
      // Key accounts: a fresh tap for every call.
      await callOffer(ctx, kase, b, invs, attempt, ref);
      return;
    }
    // One approval covers the Call stage: the retry runs under the same tap
    // (checked again against the tapped proposal) or the same rule.
    let args: Record<string, unknown> | undefined;
    let approval: Approval;
    if (by.by === "rule") {
      args = by.args;
      approval = { by: "rule", ruleId: by.ruleId, evidenceRef: by.evidenceRef };
    } else {
      args = ctx.repo.caseEvents
        .listByCase(kase.id)
        .filter((e) => e.payload.kind === "actions_proposed")
        .flatMap((e) => e.payload.actions as ProposedAction[])
        .findLast((p) => p.id === by.proposalId)?.args;
      approval = { by: "tap", tap: { choice: "approve", proposalId: by.proposalId }, evidenceRef: by.evidenceRef };
    }
    if (!args) return;
    const r = await call(ctx, kase, "place_call", args, approval, `${by.evidenceRef}_try${attempt}`);
    if (r.status !== "done") {
      // Something changed since the approval (the amount, the hours): ask again.
      await callOffer(ctx, kase, b, invs, attempt, ref);
      return;
    }
    afterCall(ctx, kase, b, invs, r.result, by, attempt, out, ref);
  }

  type CallApproval = { by?: "tap"; proposalId: string; evidenceRef: string } | { by: "rule"; ruleId: string; evidenceRef: string; args: Record<string, unknown> };

  function afterCall(ctx: Ctx, kase: Case, b: Buyer, invs: Invoice[], result: Record<string, unknown>, tap: CallApproval, attempt: number, out: Outcome, ref: string) {
    const outcome = String(result.outcome);
    const ids = invs.map((i) => i.id);
    const msgRef = String(result.message_id);
    if (outcome === "answered") {
      const date = typeof result.promise === "string" ? readDate(result.promise, ctx.clock.now()) : null;
      let promiseIds: string[] = [];
      if (date !== null) {
        promiseIds = invs.map((i) => addPromise(ctx, kase.id, i, date, owedOn(ctx.db, i), "call", msgRef).id);
        out.findings.push({ text: `${firstNameOf(b.contact_name)} answered and promised to pay by ${formatDate(date)}. Logged in the promise ledger.`, evidenceRef: msgRef });
      } else {
        out.findings.push({ text: `${firstNameOf(b.contact_name)} answered but didn't give a date.`, evidenceRef: msgRef });
      }
      note(ctx, kase.id, { kind: N.call, outcome, retry: false, attempt, invoice_ids: ids, promise_ids: promiseIds, tap }, msgRef);
      markStage(ctx, kase, "call", ids, "answered", ref);
      return;
    }
    if (outcome === "asked_not_to_call") {
      note(ctx, kase.id, { kind: N.call, outcome, retry: false, attempt, invoice_ids: ids, tap }, msgRef);
      markStage(ctx, kase, "call", ids, "asked not to call", ref);
      out.findings.push({ text: `${firstNameOf(b.contact_name)} asked not to be called. Recorded; no more calls.`, evidenceRef: msgRef });
      return;
    }
    const retry = attempt < CALL_ATTEMPTS;
    note(ctx, kase.id, { kind: N.call, outcome, retry, attempt, invoice_ids: ids, tap }, msgRef);
    if (!retry) markStage(ctx, kase, "call", ids, `${outcome} after ${attempt} tries`, ref);
    out.findings.push({ text: `Call to ${firstNameOf(b.contact_name)}: ${outcome === "busy" ? "busy" : "no answer"}.${retry ? " I'll try again tomorrow." : ""}`, evidenceRef: msgRef });
  }

  // ---- Money in

  async function onCredit(ctx: Ctx, kase: Case, creditId: string, out: Outcome, ref: string, hint: { exact?: string[] } = {}) {
    const credit = ctx.repo.bankCredits.get(creditId);
    if (!credit || credit.merchant_id !== kase.merchant_id) return;
    if (credit.matched_invoices.length) return;
    out.findings.push({ text: `${formatMoney(credit.amount)} came in on ${formatDate(credit.date)} with the remark "${credit.remark}". (Banking+, Simulated)`, evidenceRef: credit.id });
    let buyer = buyerOf(ctx, kase.id);
    // The payer, if code couldn't place them: the model reads the remark,
    // and code checks the name against the merchant's buyers.
    if (!buyer) {
      const read = await reader(ctx, "bank_remark", credit.remark, kase.id);
      if (read.source !== "fallback" && read.output.payer_name) buyer = buyerByName(ctx, kase.merchant_id, read.output.payer_name) ?? null;
    }
    if (!buyer) return unknownPayer(ctx, kase, credit, ref);

    const invs = openInvoicesOfBuyer(ctx.db, buyer);
    const exact = new Set(hint.exact ?? []);
    for (const l of notes(ctx, kase.id, N.link)) {
      const linkId = String(l.payload.link_id);
      const link = ctx.repo.rzpLinks.get(linkId);
      const paid = link?.payment_id ? ctx.repo.rzpPayments.get(link.payment_id) : undefined;
      if (credit.remark.includes(linkId) || (paid?.utr && paid.utr === credit.utr)) (l.payload.invoice_ids as string[]).forEach((x) => exact.add(x));
    }
    for (const u of notes(ctx, kase.id, N.utr)) if (String(u.payload.utr).toUpperCase() === credit.utr.toUpperCase()) (u.payload.invoice_ids as string[]).forEach((x) => exact.add(x));
    const advice = notes(ctx, kase.id, N.advice).findLast((a) => !a.payload.used)?.payload.allocations as Allocation[] | undefined;
    const named = invoicesNamed(credit.remark, invs);
    const match = matchCredit({ amount: credit.amount, invoices: invs.map((i) => openInv(ctx, i)), tdsRate: buyer.usual_tds_rate, exact: [...exact], advice: advice ?? null, named });
    note(ctx, kase.id, { kind: "collect_match", credit_id: credit.id, match }, credit.id);
    await settleMatch(ctx, kase, buyer, credit, match, out, ref);
  }

  async function settleMatch(ctx: Ctx, kase: Case, b: Buyer, credit: typeof s.bankCredits.$inferSelect, match: MatchResult, out: Outcome, ref: string) {
    const byId = new Map(openInvoicesOfBuyer(ctx.db, b).map((i) => [i.id, i]));
    const label = (alloc: Allocation[]) => `Post ${formatMoney(alloc.reduce((n, x) => n + x.amount, 0))} to ${nums(alloc.map((x) => byId.get(x.invoice_id)!))}`;
    if (match.confidence === "unsure") return unknownPayer(ctx, kase, credit, ref, match, b);

    // Posting is a bookkeeping entry with Undo, not a money action: Sure
    // posts on its own at any amount.
    if (match.confidence === "sure") {
      ctx.repo.cases.update(kase.id, { confidence: "sure" });
      const r = await call(ctx, kase, "post_match", { credit_id: credit.id, allocations: match.options[0] });
      if (r.status === "done") {
        markAdviceUsed(ctx, kase, match, ref);
        out.findings.push({ text: `Posted to the books: ${label(match.options[0]).slice(5)}. ${match.reason} (Bookkeeping Agent, Simulated) You can undo this.`, evidenceRef: r.action.id });
        return;
      }
      return blocked(ctx, kase, r, ref);
    }

    // Likely, or Sure above the approval limit: one tap.
    ctx.repo.cases.update(kase.id, { confidence: "likely" });
    const m = merchantOf(ctx, kase);
    const options = match.options.slice(0, 3);
    for (const [i, alloc] of options.entries()) {
      const itemId = `post_${credit.id}_${i + 1}`;
      const followUps: { tool: string; args: Record<string, unknown> }[] = [];
      let facts: Record<string, string> = {};
      if (i === 0 && match.kind === "tds" && b.email && consented(ctx, b, "email")) {
        const tds = match.tds.map((t) => ({ number: byId.get(t.invoice_id)!.number, amount: t.amount }));
        const built = M.askTdsCertificate(b, m.name, credit.amount, tds, b.usual_tds_rate, ctx.clock.now());
        facts = built.facts;
        followUps.push({ tool: "send_message", args: { channel: "email", to: b.email, sender_mode: "via_razorpay", kind: "question", body: built.body } });
      }
      if (i === 0 && match.kind === "part" && b.email && consented(ctx, b, "email")) {
        const rest = invoicesOf(ctx, kase.id).reduce((n, x) => n + owedOn(ctx.db, x), 0) - credit.amount;
        const built = M.askRest(b, m.name, credit.amount, rest);
        if (rest > 0) {
          facts = built.facts;
          followUps.push({ tool: "send_message", args: { channel: "email", to: b.email, sender_mode: "via_razorpay", kind: "question", body: built.body } });
        }
      }
      const tdsLine = match.kind === "tds" && i === 0 ? ` and ask ${firstNameOf(b.contact_name)} for the TDS certificate` : "";
      const why = match.reason;
      offer(
        ctx, kase, itemId,
        `${formatMoney(credit.amount)} came in from ${b.name}. ${why} ${label(alloc)}${tdsLine}?`,
        { id: itemId, label: label(alloc), tool: "post_match", args: { credit_id: credit.id, allocations: alloc }, covered: false, followUps },
        { type: "post", credit_id: credit.id, kind: match.kind, tds: i === 0 ? match.tds : [], option: i + 1, of: options.length },
        facts, ref,
      );
    }
  }

  function markAdviceUsed(ctx: Ctx, kase: Case, match: MatchResult, ref: string) {
    if (match.kind !== "advice") return;
    const a = notes(ctx, kase.id, N.advice).findLast((x) => !x.payload.used);
    if (a) note(ctx, kase.id, { kind: N.advice, allocations: a.payload.allocations, used: true }, ref);
  }

  // No match: ask the merchant, with the closest open invoices. Unsure
  // never shows a button, only the question.
  function unknownPayer(ctx: Ctx, kase: Case, credit: typeof s.bankCredits.$inferSelect, ref: string, match?: MatchResult, b?: Buyer) {
    const pool = b
      ? openInvoicesOfBuyer(ctx.db, b)
      : ctx.db.select().from(s.invoices).where(eq(s.invoices.merchant_id, kase.merchant_id)).all().filter((i) => i.status !== "paid" && !settled(ctx.db, i));
    const closest = (match?.closest.length ? match.closest.map((c) => pool.find((i) => i.id === c.id)!).filter(Boolean) : [...pool].sort((x, y) => Math.abs(owedOn(ctx.db, x) - credit.amount) - Math.abs(owedOn(ctx.db, y) - credit.amount))).slice(0, 3);
    const names = new Map(ctx.repo.buyers.list(eq(s.buyers.merchant_id, kase.merchant_id)).map((x) => [x.id, x.name]));
    const opts = closest.map((i) => `${i.number} (${formatMoney(owedOn(ctx.db, i))}, ${names.get(i.buyer_id)})`).join("; ");
    if (!b) ctx.repo.cases.update(kase.id, { confidence: "unsure" });
    addPending(ctx, kase.id, {
      itemId: `which_${credit.id}`,
      ask: `${formatMoney(credit.amount)} came in on ${formatDate(credit.date)} with the remark "${credit.remark}", and I can't tell what it's for. Closest open invoices: ${opts || "none"}. Which invoice is it for?`,
      proposal: null,
      meta: { type: "credit_question", credit_id: credit.id },
    }, ref);
  }

  // ---- Replies

  async function onReply(ctx: Ctx, kase: Case, b: Buyer, e: EngineEvent, out: Outcome, ref: string) {
    const now = ctx.clock.now();
    const text = String(e.payload.body ?? "");
    const channel = e.payload.channel === "email" ? "email" : "whatsapp";
    const from = String(e.payload.from ?? "");
    const open = openInvoicesOfBuyer(ctx.db, b);
    const caseInvs = invoicesOf(ctx, kase.id).filter((i) => owedOn(ctx.db, i) > 0);
    const voice = e.payload.voice_note === true;

    // Remittance advice in an email: the model reads it, code checks it.
    if (channel === "email" && /\bremittance\b|\badvice\b|\bpayment details\b/i.test(text)) {
      const read = await reader(ctx, "remittance_advice", text, kase.id);
      const allocations: Allocation[] = [];
      if (read.source !== "fallback") {
        for (const x of read.output.allocations) {
          const inv = open.find((i) => invoicesNamed(x.invoice_ref, [i]).length || i.number.endsWith(x.invoice_ref.replace(/\D/g, "").slice(-4)));
          if (inv) allocations.push({ invoice_id: inv.id, amount: Math.round(x.amount * 100) });
        }
      }
      if (allocations.length) {
        note(ctx, kase.id, { kind: N.advice, allocations, text_event: e.sourceId }, e.sourceId);
        note(ctx, kase.id, { kind: N.reply, type: "remittance_advice", why: "They sent a remittance advice.", voice_note: voice }, e.sourceId);
        out.findings.push({ text: `${b.contact_name} sent a remittance advice for ${nums(allocations.map((x) => open.find((i) => i.id === x.invoice_id)!))}.`, evidenceRef: e.sourceId });
        const total = allocations.reduce((n, x) => n + x.amount, 0);
        const credit = creditByUtrOrAmount(ctx, kase.merchant_id, { amount: total, near: now });
        if (credit) await onCredit(ctx, kase, credit.id, out, ref);
        else pause(ctx, kase, allocations.map((x) => x.invoice_id), SAYS_PAID_PAUSE_MS, "says paid", ref);
        return;
      }
    }

    const reading = readReply(text, now, open);
    note(ctx, kase.id, { kind: N.reply, type: reading.type, why: reading.why, voice_note: voice, date: reading.date, amount: reading.amount, utr: reading.utr, invoice_ids: reading.invoiceIds }, e.sourceId);
    out.findings.push({ text: `${b.contact_name} replied${voice ? " by voice note" : ""}: ${reading.why}`, evidenceRef: e.sourceId });
    const targets = reading.invoiceIds.length ? open.filter((i) => reading.invoiceIds.includes(i.id)) : caseInvs.length ? caseInvs : open;
    await REPLY[reading.type](ctx, kase, b, reading, { targets, channel, from, e, out, ref });
  }

  type ReplyCtx = { targets: Invoice[]; channel: "email" | "whatsapp"; from: string; e: EngineEvent; out: Outcome; ref: string };
  const m0 = (ctx: Ctx, kase: Case) => merchantOf(ctx, kase).name;

  function pause(ctx: Ctx, kase: Case, ids: string[], ms: number, why: string, ref: string) {
    note(ctx, kase.id, { kind: N.pause, invoice_ids: ids, until: ctx.clock.now() + ms, why }, ref);
  }

  // A reply on the channel they wrote on, if they've opted in to it.
  async function answer(ctx: Ctx, kase: Case, b: Buyer, channel: "email" | "whatsapp", kind: "status" | "question", built: M.Built, ref: string) {
    const to = channel === "email" ? b.email : b.phone;
    if (!to || !consented(ctx, b, channel)) return false;
    writeFacts(ctx, kase.id, built.facts, ref);
    const r = await call(ctx, kase, "send_message", { channel, to, sender_mode: channel === "email" ? "via_razorpay" : "merchant_inbox", kind, body: built.body });
    if (r.status !== "done") blocked(ctx, kase, r, ref);
    return r.status === "done";
  }

  const REPLY: Record<Reading["type"], (ctx: Ctx, kase: Case, b: Buyer, r: Reading, x: ReplyCtx) => Promise<void>> = {
    async promise(ctx, kase, b, r, x) {
      const date = r.date!;
      for (const inv of x.targets) addPromise(ctx, kase.id, inv, date, owedOn(ctx.db, inv), "reply", x.e.sourceId);
      const lines = x.targets.map((i) => line(ctx, i));
      x.out.findings.push({ text: `Logged a promise: ${formatMoney(lines.reduce((n, l) => n + l.owed, 0))} by ${formatDate(date)}. Chasing is paused until then.`, evidenceRef: x.e.sourceId });
      await answer(ctx, kase, b, x.channel, "status", M.promiseNoted(b, m0(ctx, kase), lines, date, ctx.clock.now()), x.ref);
    },

    async dispute(ctx, kase, b, r, x) {
      const inv = x.targets[0];
      if (!inv) return;
      const owed = owedOn(ctx.db, inv);
      const m = m0(ctx, kase);
      if (r.correction) {
        ctx.repo.invoices.update(inv.id, { disputed_part: (inv.disputed_part ?? 0) + owed });
        const built = M.correctedInvoice(b, m, line(ctx, inv));
        const itemId = `correct_${tail(inv.number)}`;
        note(ctx, kase.id, { kind: N.draft, what: "corrected invoice", invoice_id: inv.id, simulated: true }, x.e.sourceId);
        offer(
          ctx, kase, itemId,
          `${b.contact_name} says a detail on ${inv.number} is wrong, so I've paused chasing it. I drafted a corrected invoice. Send it?`,
          { id: itemId, label: "Send corrected invoice", tool: "send_message", args: { channel: "email", to: b.email, sender_mode: "via_razorpay", kind: "status", body: built.body }, covered: false },
          { type: "correction", invoice_id: inv.id },
          built.facts, x.ref,
        );
        return;
      }
      const part = Math.min(r.amount ?? owed, owed);
      ctx.repo.invoices.update(inv.id, { disputed_part: (inv.disputed_part ?? 0) + part });
      const after = ctx.repo.invoices.get(inv.id)!;
      const built = M.creditNote(b, m, line(ctx, after), part);
      const itemId = `creditnote_${tail(inv.number)}`;
      note(ctx, kase.id, { kind: N.draft, what: "credit note", invoice_id: inv.id, amount: part, simulated: true }, x.e.sourceId);
      offer(
        ctx, kase, itemId,
        `${b.contact_name} disputes ${formatMoney(part)} of ${inv.number}. I'll chase only the ${formatMoney(owedOn(ctx.db, after))} that isn't disputed. Send a credit note for ${formatMoney(part)}?`,
        { id: itemId, label: `Send credit note for ${formatMoney(part)}`, tool: "send_message", args: { channel: "email", to: b.email, sender_mode: "via_razorpay", kind: "status", body: built.body }, covered: false },
        { type: "credit_note", invoice_id: inv.id, amount: part },
        built.facts, x.ref,
      );
    },

    async document_request(ctx, kase, b, r, x) {
      const doc = r.document ?? "invoice";
      const built = M.documentCopy(b, m0(ctx, kase), doc, x.targets.map((i) => line(ctx, i)));
      const itemId = `doc_${x.e.sourceId}`;
      offer(
        ctx, kase, itemId,
        `${b.contact_name} asked for the ${doc} for ${nums(x.targets)}. I found it and drafted the reply. Send it?`,
        { id: itemId, label: `Send the ${doc}`, tool: "send_message", args: { channel: "email", to: b.email, sender_mode: "via_razorpay", kind: "status", body: built.body }, covered: false },
        { type: "doc", document: doc, simulated: true },
        built.facts, x.ref,
      );
    },

    async says_paid(ctx, kase, b, r, x) {
      if (r.utr) note(ctx, kase.id, { kind: N.utr, utr: r.utr, invoice_ids: x.targets.map((i) => i.id) }, x.e.sourceId);
      const credit = creditByUtrOrAmount(ctx, kase.merchant_id, { utr: r.utr, amount: r.amount, near: ctx.clock.now() });
      if (credit) {
        await onCredit(ctx, kase, credit.id, x.out, x.ref, { exact: r.utr && credit.utr.toUpperCase() === r.utr ? x.targets.map((i) => i.id) : undefined });
        return;
      }
      pause(ctx, kase, x.targets.map((i) => i.id), SAYS_PAID_PAUSE_MS, "says paid", x.ref);
      if (!r.utr) await answer(ctx, kase, b, x.channel, "question", M.askUtr(b, m0(ctx, kase)), x.ref);
      x.out.findings.push({ text: r.utr ? "No credit with that UTR yet. I'll match it when it lands." : "No credit from them yet, so I asked for the UTR.", evidenceRef: x.e.sourceId });
    },

    async part_payment(ctx, kase, b, r, x) {
      const credit = r.amount ? creditByUtrOrAmount(ctx, kase.merchant_id, { utr: r.utr, amount: r.amount, near: ctx.clock.now() }) : undefined;
      if (credit) await onCredit(ctx, kase, credit.id, x.out, x.ref);
      if (r.date !== null) {
        // The rest: the ledger holds what's left after the part.
        let part = credit ? 0 : (r.amount ?? 0);
        for (const inv of [...x.targets].sort((p, q) => p.due_date - q.due_date)) {
          const owed = owedOn(ctx.db, ctx.repo.invoices.get(inv.id)!);
          const rest = Math.max(0, owed - part);
          part = Math.max(0, part - owed);
          if (rest > 0) addPromise(ctx, kase.id, inv, r.date, rest, "reply", x.e.sourceId);
        }
        x.out.findings.push({ text: `Logged a promise for the rest by ${formatDate(r.date)}.`, evidenceRef: x.e.sourceId });
      } else if (!credit) {
        pause(ctx, kase, x.targets.map((i) => i.id), SAYS_PAID_PAUSE_MS, "part paid", x.ref);
      }
    },

    async wrong_person(ctx, kase, b, r, x) {
      if (!r.newEmail && !r.newPhone) {
        addPending(ctx, kase.id, { itemId: `who_${x.e.sourceId}`, ask: `${b.contact_name} says they're the wrong person but didn't say who to write to. Who should I send ${b.name}'s reminders to?`, proposal: null, meta: { type: "who" } }, x.ref);
        return;
      }
      // The new contact is from the buyer's message, so the merchant
      // approves it (rule 5: stricter than the guide on purpose, so a reply
      // can't redirect chasing). Email consent carries over to a new address
      // at the same buyer; WhatsApp and call consent belong to a number, so
      // a new number needs its own opt-in first.
      const m = merchantOf(ctx, kase);
      const lines = x.targets.map((i) => line(ctx, i));
      const itemId = `contact_${x.e.sourceId}`;
      if (r.newEmail) {
        const built = M.gentle({ ...b, contact_name: "there" }, m.name, lines, null, ctx.clock.now());
        const carries = consented(ctx, b, "email");
        offer(
          ctx, kase, itemId,
          `${b.contact_name} says they're the wrong person and pointed to ${r.newEmail}. Update ${b.name}'s email and resend the reminder?`,
          {
            id: itemId, label: "Update contact & resend", tool: "send_message", covered: false,
            args: { channel: "email", to: r.newEmail, sender_mode: "via_razorpay", kind: "gentle_reminder", body: built.body },
            covers: [`Update ${b.name}'s email to ${r.newEmail}${carries ? "; their email consent carries over" : ""}`],
          },
          { type: "contact", email: r.newEmail, phone: r.newPhone },
          built.facts, x.ref,
        );
        return;
      }
      const text = `Contact change for ${b.name}: ${b.contact_name} says payments go to ${r.newPhone}. WhatsApp and calls to the new number wait until it opts in.`;
      offer(
        ctx, kase, itemId,
        `${b.contact_name} says they're the wrong person and pointed to ${r.newPhone}. Update ${b.name}'s number? WhatsApp and calls to it wait for its own opt-in.`,
        {
          id: itemId, label: "Update contact", tool: "draft_request", covered: false,
          args: { request: "billing_details", text, evidence_refs: [x.e.sourceId] },
          covers: [`Update ${b.name}'s phone to ${r.newPhone}`, "No WhatsApp or calls to the new number until it opts in"],
        },
        { type: "contact", email: null, phone: r.newPhone },
        {}, x.ref,
      );
    },

    async hardship(ctx, kase, b, _r, x) {
      const owed = x.targets.reduce((n, i) => n + owedOn(ctx.db, i), 0);
      if (owed <= 0) return;
      const start = istMidnight(ctx.clock.now()) + 7 * DAY;
      const each = Math.floor(owed / PLAN_PARTS / 10_000) * 10_000;
      const parts = Array.from({ length: PLAN_PARTS }, (_, i) => ({ amount: i === PLAN_PARTS - 1 ? owed - each * (PLAN_PARTS - 1) : each, by: start + i * 7 * DAY }));
      const built = M.splitPlan(b, m0(ctx, kase), owed, parts);
      const itemId = `plan_${x.e.sourceId}`;
      offer(
        ctx, kase, itemId,
        `${b.contact_name} says money is tight. ${b.name} owes ${formatMoney(owed)}. Offer a ${PLAN_PARTS}-part plan, weekly from ${formatDate(start)}?`,
        { id: itemId, label: `Offer ${PLAN_PARTS}-part plan`, tool: "send_message", args: { channel: x.channel === "email" || !b.phone ? "email" : "whatsapp", to: x.channel === "email" || !b.phone ? b.email : b.phone, sender_mode: x.channel === "email" || !b.phone ? "via_razorpay" : "merchant_inbox", kind: "status", body: built.body }, covered: false },
        { type: "plan", parts, invoice_ids: x.targets.map((i) => i.id) },
        built.facts, x.ref,
      );
    },

    async unclear(ctx, kase, b, _r, x) {
      addPending(ctx, kase.id, { itemId: `unclear_${x.e.sourceId}`, ask: `${b.contact_name} replied and I couldn't tell what they meant. How should I answer?`, proposal: null, meta: { type: "unclear" } }, x.ref);
    },
  };

  // The merchant's own note: "spoke to them, paying on 20th" is a promise.
  function onMerchantNote(ctx: Ctx, kase: Case, b: Buyer, e: EngineEvent, out: Outcome) {
    const text = String(e.payload.body ?? "");
    const date = readDate(text, ctx.clock.now());
    note(ctx, kase.id, { kind: N.reply, type: "merchant_note", date }, e.sourceId);
    if (date === null) {
      out.findings.push({ text: "You added a note. There's no date in it, so the chase carries on.", evidenceRef: e.sourceId });
      return;
    }
    const open = openInvoicesOfBuyer(ctx.db, b);
    const named = invoicesNamed(text, open);
    const targets = named.length ? open.filter((i) => named.includes(i.id)) : invoicesOf(ctx, kase.id).filter((i) => owedOn(ctx.db, i) > 0);
    for (const inv of targets) addPromise(ctx, kase.id, inv, date, owedOn(ctx.db, inv), "merchant", e.sourceId);
    out.findings.push({ text: `You logged a promise from ${b.name}: paying by ${formatDate(date)}. I've paused the chase until then.`, evidenceRef: e.sourceId });
  }

  // ---- One step of the loop

  async function step(ctx: Ctx, kase: Case, e: EngineEvent | null): Promise<Outcome> {
    const k = kindOf(e, CHECK_TIMER);
    const out: Outcome = { to: "chasing", reason: "Chasing.", findings: [] };
    const ref = e?.sourceId ?? kase.id;
    const b = attach(ctx, kase, e, k);
    recordDeclines(ctx, kase, ref);

    if (!b) {
      // A credit from a payer code can't place.
      const creditId = creditCaseOf(ctx, kase.id);
      const credit = creditId ? ctx.repo.bankCredits.get(creditId) : undefined;
      if (credit?.matched_invoices.length) return { to: "closed", reason: "The payment is posted.", findings: [{ text: `${formatMoney(credit.amount)} is posted to the books.`, evidenceRef: credit.id }], outcome: "collected" };
      if (k === "credit" && creditId) await onCredit(ctx, kase, creditId, out, ref);
      return compose(ctx, kase, out);
    }

    if (k === "credit") await onCredit(ctx, kase, String(e!.payload.credit_id), out, ref);
    if (k === "buyer_message") await onReply(ctx, kase, b, e!, out, ref);
    if (k === "merchant_note") onMerchantNote(ctx, kase, b, e!, out);
    if (k === "credit" || k === "buyer_message" || k === "merchant_note") await chase(ctx, kase, b, out, ref, true);
    if (k === "morning" || k === "check" || k === "handoff") {
      checkPromises(ctx, kase, out);
      const invs = invoicesOf(ctx, kase.id);
      const waitingOnPost = pendingItems(ctx, kase.id).some((p) => p.meta.type === "post" || p.meta.type === "credit_question");
      if (invs.length && invs.every((i) => settled(ctx.db, ctx.repo.invoices.get(i.id)!)) && !waitingOnPost) {
        syncAmount(ctx, kase);
        return { to: "closed", reason: `${b.name} has paid. Every invoice on this case is settled.`, findings: [...out.findings, { text: `Paid in full: ${nums(invs)}.`, evidenceRef: invs[0].id }], outcome: "collected" };
      }
      await chase(ctx, kase, b, out, ref);
    }
    syncAmount(ctx, kase);
    return compose(ctx, kase, out);
  }

  // The case waits on the merchant while anything is pending; otherwise RAY
  // keeps chasing. The offer on the card is kept in step with what's pending.
  function compose(ctx: Ctx, kase: Case, out: Outcome): Outcome {
    const pend = pendingItems(ctx, kase.id);
    const desired = rank(pend).flatMap((p) => (p.proposal ? [p.proposal] : []));
    const current = openProposals(ctx, kase.id);
    if (JSON.stringify(current) !== JSON.stringify(desired)) note(ctx, kase.id, { kind: "actions_proposed", actions: desired }, kase.id);
    if (!pend.length) return out;
    const top = rank(pend)[0];
    const last = notes(ctx, kase.id, N.ask).at(-1);
    if (last?.payload.text !== top.ask) note(ctx, kase.id, { kind: N.ask, text: top.ask }, kase.id);
    return { ...out, to: "merchant", reason: top.ask };
  }

  // RAY's recommendation first: money to post, then answers to the buyer,
  // then the strongest chase step.
  const ORDER = ["post", "credit_question", "correction", "credit_note", "doc", "contact", "plan", "who", "unclear", "blocked", "call", "firm", "msme", "unreachable"];
  const rank = (items: Pending[]) => [...items].sort((x, y) => ORDER.indexOf(x.meta.type) - ORDER.indexOf(y.meta.type) || x.at - y.at);

  const toInvestigate = (r: Outcome, timers: TimerRequest[]): InvestigateResult => ({
    to: r.to === "chasing" ? "waiting_customer" : r.to === "merchant" ? "waiting_merchant" : "closed",
    reason: r.reason,
    findings: r.findings,
    timers: r.to === "closed" ? [] : timers,
    outcome: r.outcome,
  });

  return {
    id: "collect",
    moment: "collect",

    detect(ctx, e) {
      const k = kindOf(e, CHECK_TIMER);
      if (!k || !["morning", "handoff", "credit", "buyer_message"].includes(k)) return null;
      // The handoff's invoice is recorded either way, so the read-only view shows it.
      const handoff = k === "handoff" ? resolveHandoff(ctx, e) : null;
      if (!fullLoop(ctx, e.merchantId)) return null;
      const now = ctx.clock.now();
      if (k === "credit") {
        const credit = ctx.repo.bankCredits.get(String(e.payload.credit_id));
        if (!credit || credit.merchant_id !== e.merchantId || credit.matched_invoices.length) return null;
        const b = buyerFromCredit(ctx, e.merchantId, credit);
        return {
          moment: "collect",
          confidence: b ? "likely" : "unsure",
          amount: credit.amount,
          alert: b ? `${formatMoney(credit.amount)} came in from ${b.name}. Matching it to their invoices.` : `${formatMoney(credit.amount)} came in and I can't tell who sent it yet.`,
        } satisfies Detection;
      }
      const b = handoff?.buyer ?? buyerForEvent(ctx, e, k);
      if (!b) return null;
      const invs = k === "handoff" && handoff ? [handoff.invoice, ...chaseable(ctx.db, b, now).filter((i) => i.id !== handoff.invoice.id)] : k === "buyer_message" ? openInvoicesOfBuyer(ctx.db, b) : chaseable(ctx.db, b, now);
      if (!invs.length) return null;
      const owed = invs.reduce((n, i) => n + owedOn(ctx.db, i), 0);
      const oldest = Math.max(...invs.map((i) => daysOverdue(i, now)));
      return { moment: "collect", confidence: "sure", amount: owed, alert: M.owes(b, owed, oldest) } satisfies Detection;
    },

    route(ctx, e) {
      const k = kindOf(e, CHECK_TIMER);
      if (!k || !["morning", "handoff", "credit", "buyer_message"].includes(k)) return null;
      if (!fullLoop(ctx, e.merchantId)) return null;
      const b = buyerForEvent(ctx, e, k);
      return b ? (openCaseForBuyer(ctx.db, e.merchantId, b.id)?.id ?? null) : null;
    },

    async investigate(ctx, kase, e) {
      const r = await step(ctx, kase, e);
      return toInvestigate(r, ensureCheck(ctx, kase));
    },

    async decide(ctx, kase) {
      const r = compose(ctx, kase, { to: "chasing", reason: "Chasing.", findings: [] });
      return { to: r.to === "merchant" ? "waiting_merchant" : "waiting_customer", reason: r.reason, summary: r.reason, timers: ensureCheck(ctx, kase) };
    },

    async proposeActions() {
      return [];
    },

    async onApproval(ctx, kase, approval) {
      if (approval.by !== "tap") return { to: "waiting_merchant", reason: "Collect only acts on your tap." };
      const proposal = openProposals(ctx, kase.id).find((p) => p.id === approval.tap.proposalId);
      const item = pendingItems(ctx, kase.id).find((p) => p.itemId === approval.tap.proposalId);
      if (!proposal || !item) return { to: "waiting_merchant", reason: "RAY can't find what was approved." };
      const b = buyerOf(ctx, kase.id) ?? (item.meta.buyer_id ? ctx.repo.buyers.get(String(item.meta.buyer_id)) ?? null : null);
      const out: Outcome = { to: "chasing", reason: "", findings: [] };
      const ref = approval.evidenceRef;
      const meta = item.meta;

      // The new contact first, so the resend goes to it.
      if (meta.type === "contact" && b) ctx.repo.buyers.update(b.id, { ...(meta.email ? { email: String(meta.email) } : {}), ...(meta.phone ? { phone: String(meta.phone) } : {}) });

      const r = await call(ctx, kase, proposal.tool, proposal.args, approval);
      if (r.status !== "done") return { to: "waiting_merchant", reason: failure(r) ?? "It didn't go through." };
      for (const f of proposal.followUps ?? []) {
        const fr = await call(ctx, kase, f.tool, f.args, approval);
        if (fr.status !== "done") note(ctx, kase.id, { kind: "collect_follow_up_failed", tool: f.tool, why: failure(fr) }, fr.action.id);
      }
      resolve(ctx, kase.id, item.itemId, "approved", ref);

      const invIds = (meta.invoice_ids as string[] | undefined) ?? [];
      switch (meta.type) {
        case "firm":
        case "msme":
          markStage(ctx, kase, meta.type, invIds, "tap", ref);
          break;
        case "call": {
          const invs = invoicesOf(ctx, kase.id).filter((i) => invIds.includes(i.id));
          if (b) afterCall(ctx, kase, b, invs, r.result, { proposalId: proposal.id, evidenceRef: ref }, Number(meta.attempt ?? 1), out, ref);
          break;
        }
        case "post":
          for (const t of (meta.tds as Allocation[] | undefined) ?? []) note(ctx, kase.id, { kind: N.tds, invoice_id: t.invoice_id, amount: t.amount, credit_id: meta.credit_id }, r.action.id);
          markAdviceUsed(ctx, kase, { kind: meta.kind } as MatchResult, ref);
          // The other options for this credit are gone.
          for (const p of pendingItems(ctx, kase.id).filter((x) => x.meta.credit_id === meta.credit_id)) resolve(ctx, kase.id, p.itemId, "another option posted", ref);
          out.findings.push({ text: `Posted to the books (Bookkeeping Agent, Simulated). You can undo this.`, evidenceRef: r.action.id });
          break;
        case "correction":
          ctx.repo.invoices.update(String(meta.invoice_id), { disputed_part: null });
          break;
        case "credit_note":
          note(ctx, kase.id, { kind: N.creditNote, invoice_id: meta.invoice_id, amount: meta.amount }, r.action.id);
          break;
        case "plan": {
          const parts = meta.parts as { amount: number; by: number }[];
          const invs = invoicesOf(ctx, kase.id).filter((i) => invIds.includes(i.id)).sort((p, q) => p.due_date - q.due_date);
          // Each part goes on the oldest invoice it covers.
          let i = 0;
          let left = invs.length ? owedOn(ctx.db, invs[0]) : 0;
          for (const part of parts) {
            while (i < invs.length - 1 && left <= 0) left = owedOn(ctx.db, invs[++i]);
            if (invs[i]) addPromise(ctx, kase.id, invs[i], part.by, part.amount, "plan", r.action.id);
            left -= part.amount;
          }
          break;
        }
      }
      syncAmount(ctx, kase);
      for (const f of out.findings) ctx.repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: ctx.clock.now(), type: "finding", payload: { text: f.text, cited_by: ref }, evidence_ref: f.evidenceRef });
      return { to: "verifying", reason: `Done: ${proposal.label}.`, timers: ensureCheck(ctx, kase) };
    },

    async verify(ctx, kase, e): Promise<VerifyResult> {
      if (!e) return { to: "verifying", reason: "Checking it worked." };
      const r = await step(ctx, kase, e);
      if (r.to === "closed") return { to: "closed", reason: r.reason, outcome: r.outcome };
      if (r.to === "merchant") return { to: "waiting_merchant", reason: r.reason, timers: ensureCheck(ctx, kase) };
      return { to: "verifying", reason: r.reason, timers: ensureCheck(ctx, kase) };
    },

    async onPromisedTime() {
      return { reason: "Collect keeps buyers' promises in its own ledger." };
    },

    // Counts as saved when the overdue amount is collected.
    countsAsSaved(ctx, kase) {
      const invs = invoicesOf(ctx, kase.id);
      const now = ctx.clock.now();
      return invs.length > 0 && invs.some((i) => i.due_date < now) && invs.every((i) => settled(ctx.db, ctx.repo.invoices.get(i.id)!)) && invs.some((i) => (ctx.repo.invoices.get(i.id)!.paid_amount > 0 || tdsClaimed(ctx.db, i.id) > 0));
    },

    async onChange(ctx, kase, text, e) {
      const ref = e.sourceId;
      if (/samadhaan/i.test(text)) return samadhaan(ctx, kase);
      // An answer to "which invoice is it for?": the invoices the merchant names.
      const q = pendingItems(ctx, kase.id).find((p) => p.meta.type === "credit_question");
      if (q) {
        const credit = ctx.repo.bankCredits.get(String(q.meta.credit_id))!;
        const all = ctx.db.select().from(s.invoices).where(eq(s.invoices.merchant_id, kase.merchant_id)).all().filter((i) => owedOn(ctx.db, i) > 0);
        const named = invoicesNamed(text, all, true);
        if (!named.length) return { reason: "I couldn't find an open invoice number in that. Which invoice is it for?" };
        const invs = all.filter((i) => named.includes(i.id)).sort((x, y) => x.due_date - y.due_date);
        let left = credit.amount;
        const alloc: Allocation[] = [];
        for (const inv of invs) {
          if (left <= 0) break;
          const take = Math.min(left, owedOn(ctx.db, inv));
          alloc.push({ invoice_id: inv.id, amount: take });
          left -= take;
        }
        if (left > 0) return { reason: `${formatMoney(credit.amount)} is more than those invoices have open. Which other invoice is it for?` };
        resolve(ctx, kase.id, q.itemId, "you named the invoice", ref);
        // Your answer is the evidence: Likely, and still your tap.
        ctx.repo.cases.update(kase.id, { confidence: "likely" });
        const itemId = `post_${credit.id}_you`;
        const label = `Post ${formatMoney(credit.amount)} to ${nums(invs)}`;
        offer(ctx, kase, itemId, `You said ${formatMoney(credit.amount)} is for ${nums(invs)}. ${label}?`, { id: itemId, label, tool: "post_match", args: { credit_id: credit.id, allocations: alloc }, covered: false }, { type: "post", credit_id: credit.id, kind: "merchant", tds: [], buyer_id: invs[0].buyer_id }, {}, ref);
        compose(ctx, kase, { to: "merchant", reason: "", findings: [] });
        return { reason: "Drafted from your answer." };
      }
      return redraft(ctx, kase, text);
    },
  };

  // Change: the merchant's text goes to the write job with the draft on the
  // card; the redraft passes the write guard (numbers in the case, no banned
  // words) and the same card comes back with it. The text is data, never
  // an instruction. WhatsApp templates aren't redrafted.
  async function redraft(ctx: Ctx, kase: Case, text: string) {
    const items = pendingItems(ctx, kase.id).filter((p) => p.proposal);
    if (!items.length) return { reason: "There's no draft to change. RAY keeps chasing as before." };
    const ids = idAliases();
    const facts = ids.hide(caseFacts(ctx.db, kase.id));
    const tone = readSettings(ctx.db, kase.merchant_id, "collect").tone;
    let changed = 0;
    const rewrite = async (args: Record<string, unknown>) => {
      if (typeof args.body !== "string") return args;
      const r = await writer(ctx, { audience: "buyer", kind: `${String(args.kind)}_redraft`, first_customer_message: false, facts: { ...facts, current_draft: ids.hide(args.body), merchant_change: text }, tone, language: "en" }, kase.id);
      if (r.source === "fallback" || !r.output.draft) return args;
      changed++;
      return { ...args, body: ids.show(r.output.draft) };
    };
    for (const p of items) {
      const prop = p.proposal!;
      const args = prop.tool === "send_message" ? await rewrite(prop.args) : prop.args;
      const followUps = prop.followUps ? await Promise.all(prop.followUps.map(async (f) => (f.tool === "send_message" ? { ...f, args: await rewrite(f.args) } : f))) : undefined;
      if (args !== prop.args || followUps?.some((f, i) => f !== prop.followUps![i])) {
        // The same card (same id), with the new draft.
        note(ctx, kase.id, { kind: N.pending, item_id: p.itemId, ask: p.ask, proposal: { ...prop, args, ...(followUps ? { followUps } : {}) }, meta: p.meta }, kase.id);
      }
    }
    compose(ctx, kase, { to: "merchant", reason: "", findings: [] });
    return { reason: changed ? "RAY redrafted the message with your note." : "I couldn't redraft that, so the draft is unchanged." };
  }

  async function samadhaan(ctx: Ctx, kase: Case) {
    const b = buyerOf(ctx, kase.id);
    const m = merchantOf(ctx, kase);
    if (!b || !m.udyam) return { reason: "MSME Samadhaan is only for Udyam-registered merchants with an overdue buyer." };
    const now = ctx.clock.now();
    const invs = invoicesOf(ctx, kase.id).filter((i) => owedOn(ctx.db, i) > 0 && msmeDue(i, true, now));
    if (!invs.length) return { reason: "No invoice on this case is past the 45-day MSME limit yet." };
    const lines = invs.map((i) => `${i.number}: ${M.exact(owedOn(ctx.db, i))}, accepted ${formatDate(i.accepted_at ?? i.due_date)}, ${daysOverdue({ due_date: (i.accepted_at ?? i.due_date) + 45 * DAY }, now)} days past the 45-day limit`);
    const text = `MSME Samadhaan filing (draft for you to file)\nSupplier: ${m.name} (Udyam registered)\nBuyer: ${b.name}, contact ${b.contact_name}\nInvoices:\n${lines.join("\n")}\nReminders sent: ${stagesDone(ctx, kase.id).filter((d) => d.how !== "declined by you").map((d) => STAGE_LABEL[d.stage]).join(", ") || "none"}`;
    const r = await guardedCall("draft_request", { request: "other", text, evidence_refs: invs.map((i) => i.id) }, { adapters: adaptersOf(ctx), caseId: kase.id });
    note(ctx, kase.id, { kind: N.draft, what: "samadhaan", text, simulated: true }, r.action.id);
    return { reason: r.status === "done" ? "Drafted the MSME Samadhaan filing. You file it on the Samadhaan portal." : (failure(r) ?? "Couldn't draft it.") };
  }
}

export type CollectSpecialist = ReturnType<typeof createCollectSpecialist>;
export type { Stage } from "./stages";
export type { EngineContext };

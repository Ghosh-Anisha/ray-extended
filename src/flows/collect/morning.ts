// The morning list (Step 11): one row per buyer who owes money, highest
// priority first. Priority = amount overdue × days overdue, adjusted by pay
// history and relationship. Banking+ merchants get the full loop and see
// what RAY will do today; everyone else gets the read-only overdue view
// with a Banking+ offer and no actions.
import { and, eq, gte } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { STATE_LABEL } from "@/surfaces/words";
import { formatDate, formatMoney } from "@/guards";
import { renderTemplate } from "@/adapters/messaging";
import { brokenCount, N, openCaseForBuyer, openInvoicesOfBuyer, owedOn, pendingItems, promisesFor } from "./data";
import { daysOverdue, ladderStage, STAGE_LABEL, type Buyer, type Invoice } from "./stages";
import { exact, firm as firmMessage, gentle as gentleMessage, type Line } from "./messages";

// Pay history: slow payers and broken promises rank higher; a key account
// ranks higher because anything firm waits for the merchant's tap.
export const HISTORY_SPAN_DAYS = 60;
export const BROKEN_WEIGHT = 0.25;
export const KEY_ACCOUNT_WEIGHT = 1.25;

export function historyFactor(b: Pick<Buyer, "avg_days_late">, broken: number) {
  return 1 + Math.min(b.avg_days_late, HISTORY_SPAN_DAYS) / HISTORY_SPAN_DAYS + BROKEN_WEIGHT * broken;
}

// Σ owed × days overdue (rupee-days), × history × relationship.
export function priorityScore(lines: { owed: number; days: number }[], b: Pick<Buyer, "avg_days_late" | "key_account">, broken: number): number {
  const base = lines.reduce((n, l) => n + (l.owed / 100) * Math.max(0, l.days), 0);
  return Math.round(base * historyFactor(b, broken) * (b.key_account ? KEY_ACCOUNT_WEIGHT : 1));
}

export type MorningRow = {
  buyerId: string;
  buyer: string;
  contact: string;
  keyAccount: boolean;
  overdue: string;
  overdueMinor: number;
  invoices: number;
  oldestDays: number;
  stage: string;
  priority: number;
  next: string;
  needsYou: boolean;
  state: string | null;
  caseId: string | null;
  promise: string | null;
  flagged: string | null;
  previewTone: string;
  previewText: string;
  previewChannel: string;
  previewNote: string;
  lastActivity: string | null;
};

export type MorningList = {
  merchantId: string;
  merchant: string;
  bankingPlus: boolean;
  date: string;
  total: string;
  rows: MorningRow[];
  // At the top: Sure matches RAY posted on its own above the approval
  // limit in the last day, each with Undo.
  posted: { actionId: string; caseId: string; text: string }[];
  // Non-Banking+ only.
  offer: { title: string; text: string } | null;
  empty: string;
};

export const BANKING_PLUS_OFFER = {
  title: "Let RAY chase these for you",
  text: "With Banking+, RAY reminds your buyers on time, reads their replies, matches every payment to its invoice and tells you only when it needs your tap. Until then, this list is read only.",
};

export function morningList(a: Adapters, merchantId: string): MorningList {
  const repo = createRepository(a.db);
  const m = repo.merchants.get(merchantId);
  if (!m) throw new Error(`Merchant ${merchantId} not found`);
  const now = a.clock.now();
  const ctx = { db: a.db, repo, clock: a.clock, adapters: a };
  const rows: MorningRow[] = [];
  for (const b of repo.buyers.list(eq(s.buyers.merchant_id, merchantId))) {
    const overdue = openInvoicesOfBuyer(a.db, b).filter((i) => i.due_date < now && owedOn(a.db, i) > 0);
    if (!overdue.length) continue;
    const lines = overdue.map((i) => ({ inv: i, owed: owedOn(a.db, i), days: daysOverdue(i, now) }));
    const broken = overdue.reduce((n, i) => n + brokenCount(repo, i.id), 0);
    const owedTotal = lines.reduce((n, l) => n + l.owed, 0);
    const oldest = Math.max(...lines.map((l) => l.days));
    const kase = m.banking_plus ? openCaseForBuyer(a.db, merchantId, b.id) : undefined;
    const pending = kase ? pendingItems(ctx, kase.id) : [];
    const promise = overdue
      .flatMap((i) => promisesFor(repo, i.id).filter((p) => p.status === "open"))
      .sort((x, y) => x.promised_date - y.promised_date)[0];
    const flags = kase ? repo.caseEvents.listByCase(kase.id).filter((e) => e.payload.kind === N.flag && !e.payload.used) : [];
    const furthest = overdue.map((i) => ladderStage(i, now)).filter(Boolean).at(-1);
    const emailOptedIn = a.db.select().from(s.messagingConsents).where(and(eq(s.messagingConsents.buyer_id, b.id), eq(s.messagingConsents.channel, "email"), eq(s.messagingConsents.status, "opted_in"))).get() !== undefined;
    const whatsappOptedIn = a.db.select().from(s.messagingConsents).where(and(eq(s.messagingConsents.buyer_id, b.id), eq(s.messagingConsents.channel, "whatsapp"), eq(s.messagingConsents.status, "opted_in"))).get() !== undefined;
    const firmTone = furthest === "firm" || furthest === "call";
    const messageLines: Line[] = overdue.map((inv) => ({ id: inv.id, number: inv.number, due_date: inv.due_date, accepted_at: inv.accepted_at, owed: owedOn(a.db, inv) }));
    const built = firmTone ? firmMessage(b, m.name, messageLines, now) : gentleMessage(b, m.name, messageLines, null, now);
    const useEmail = !!b.email && emailOptedIn;
    const useWhatsApp = !!b.phone && m.whatsapp_on && whatsappOptedIn;
    const previewChannel = useEmail ? "Email" : useWhatsApp ? "WhatsApp" : "No opted-in channel";
    const firstLine = messageLines[0]!;
    const previewText = useEmail ? built.body : useWhatsApp
      ? renderTemplate("invoice_reminder", { name: b.contact_name.split(/\s+/)[0]!, invoice: firstLine.number, amount: exact(firstLine.owed), merchant: m.name, date: formatDate(firstLine.due_date) })
      : "No message preview: this buyer has no opted-in email or WhatsApp channel. The workflow will show a follow-up instead of sending.";
    const stageEvents = kase ? repo.caseEvents.listByCase(kase.id).filter((e) => e.payload.kind === N.stage) : [];
    const latestStage = stageEvents.at(-1);
    const lastActivity = latestStage ? `${STAGE_LABEL[String(latestStage.payload.stage) as keyof typeof STAGE_LABEL] ?? "Reminder"} completed · ${String(latestStage.payload.how)}` : null;
    rows.push({
      buyerId: b.id,
      buyer: b.name,
      contact: b.contact_name,
      keyAccount: b.key_account,
      overdue: formatMoney(owedTotal),
      overdueMinor: owedTotal,
      invoices: overdue.length,
      oldestDays: oldest,
      stage: furthest ? STAGE_LABEL[furthest] : "Due",
      priority: priorityScore(lines, b, broken),
      next: !m.banking_plus ? "Read only" : nextLine(pending, kase ? STATE_LABEL[kase.state] : null),
      needsYou: pending.length > 0,
      state: kase ? STATE_LABEL[kase.state] : null,
      caseId: kase?.id ?? null,
      promise: promise ? `${b.contact_name} promised ${formatMoney(promise.amount)} by ${formatDate(promise.promised_date)}` : null,
      flagged: flags.length ? `Flagged: ${String(flags.at(-1)!.payload.reason)}` : null,
      previewTone: firmTone ? "Firm reminder · merchant approval required before message" : "Gentle reminder · simulated workflow",
      previewText,
      previewChannel,
      previewNote: useEmail && !firmTone ? "The Collect engine may add a simulated Razorpay-hosted pay link after this review. This preview omits that link." : messageLines.length > 1 && useWhatsApp ? `Preview shows the first of ${messageLines.length} invoice messages; the engine rechecks each invoice before sending.` : "Generated from the listed invoice facts. Consent and timing are checked again by the Collect engine.",
      lastActivity,
    });
  }
  rows.sort((x, y) => y.priority - x.priority || y.overdueMinor - x.overdueMinor);
  const posted = m.banking_plus ? postedAboveLimit(a, merchantId, m.approval_limit) : [];
  const total = rows.reduce((n, r) => n + r.overdueMinor, 0);
  return {
    merchantId,
    merchant: m.name,
    bankingPlus: m.banking_plus,
    date: formatDate(now),
    total: formatMoney(total),
    rows,
    posted,
    offer: m.banking_plus ? null : BANKING_PLUS_OFFER,
    empty: "No invoices are overdue. RAY will list buyers here, highest priority first, once an invoice passes its due date.",
  };
}

export const POSTED_WINDOW_MS = 24 * 60 * 60 * 1000;

function postedAboveLimit(a: Adapters, merchantId: string, limit: number) {
  const repo = createRepository(a.db);
  const since = a.clock.now() - POSTED_WINDOW_MS;
  const rows = a.db
    .select({ ev: s.caseEvents, kase: s.cases })
    .from(s.caseEvents)
    .innerJoin(s.cases, eq(s.cases.id, s.caseEvents.case_id))
    .where(and(eq(s.cases.merchant_id, merchantId), eq(s.cases.moment, "collect"), eq(s.caseEvents.type, "tool_call"), gte(s.caseEvents.at, since)))
    .all()
    .filter((r) => r.ev.payload.kind === "action_done" && r.ev.payload.tool === "post_match" && r.ev.payload.approved_by === null);
  return rows.flatMap(({ ev, kase }) => {
    const action = repo.actions.get(String(ev.payload.action_id));
    if (!action || action.status !== "done") return [];
    const allocations = action.args.allocations as { invoice_id: string; amount: number }[];
    const amount = allocations.reduce((n, x) => n + x.amount, 0);
    if (amount <= limit) return [];
    const numbers = allocations.map((x) => repo.invoices.get(x.invoice_id)?.number ?? x.invoice_id);
    const list = numbers.length > 1 ? `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}` : numbers[0];
    return [{ actionId: action.id, caseId: kase.id, text: `Posted ${formatMoney(amount)} to ${list}` }];
  });
}

function nextLine(pending: ReturnType<typeof pendingItems>, state: string | null): string {
  const top = pending.find((p) => p.proposal) ?? pending[0];
  if (top) return top.proposal ? `Needs you: ${top.proposal.label}` : "Needs you: one question";
  return state ? `RAY is handling it (${state})` : "RAY will start on the next morning run";
}

export const overdueInvoices = (a: Adapters, b: Buyer): Invoice[] => openInvoicesOfBuyer(a.db, b).filter((i) => i.due_date < a.clock.now());

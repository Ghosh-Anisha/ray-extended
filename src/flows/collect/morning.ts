// The morning list (Step 11): one row per buyer who owes money, highest
// priority first. Priority = amount overdue × days overdue, adjusted by pay
// history and relationship. Banking+ merchants get the full loop and see
// what RAY will do today; everyone else gets the read-only overdue view
// with a Banking+ offer and no actions.
import { eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { STATE_LABEL } from "@/surfaces/words";
import { formatDate, formatMoney } from "@/guards";
import { brokenCount, N, openCaseForBuyer, openInvoicesOfBuyer, owedOn, pendingItems, promisesFor } from "./data";
import { daysOverdue, ladderStage, STAGE_LABEL, type Buyer, type Invoice } from "./stages";

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
};

export type MorningList = {
  merchantId: string;
  merchant: string;
  bankingPlus: boolean;
  date: string;
  total: string;
  rows: MorningRow[];
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
    });
  }
  rows.sort((x, y) => y.priority - x.priority || y.overdueMinor - x.overdueMinor);
  const total = rows.reduce((n, r) => n + r.overdueMinor, 0);
  return {
    merchantId,
    merchant: m.name,
    bankingPlus: m.banking_plus,
    date: formatDate(now),
    total: formatMoney(total),
    rows,
    offer: m.banking_plus ? null : BANKING_PLUS_OFFER,
    empty: "No invoices are overdue. RAY will list buyers here, highest priority first, once an invoice passes its due date.",
  };
}

function nextLine(pending: ReturnType<typeof pendingItems>, state: string | null): string {
  const top = pending.find((p) => p.proposal) ?? pending[0];
  if (top) return top.proposal ? `Needs you: ${top.proposal.label}` : "Needs you: one question";
  return state ? `RAY is handling it (${state})` : "RAY will start on the next morning run";
}

export const overdueInvoices = (a: Adapters, b: Buyer): Invoice[] => openInvoicesOfBuyer(a.db, b).filter((i) => i.due_date < a.clock.now());

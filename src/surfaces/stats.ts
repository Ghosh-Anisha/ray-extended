// The numbers on Home and My dashboard. Every one is computed from rows
// (cases, payments, disputes, invoices); none is typed in. The definitions
// are written here once so a screen can show them under the number.
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import * as s from "@/db/schema";
import type { Moment } from "@/db/schema";
import { HANDLED_BY_MERCHANT } from "@/engine/outcomes";
import { groupIndian } from "@/guards/format";
import { MOMENT_LABEL } from "./words";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const IST_MS = (5 * 60 + 30) * MIN;

// Minutes of the merchant's own work that RAY took over, per closed case.
export const MINUTES_PER_CASE: Record<Moment, number> = {
  paid_no_order: 30,
  international: 40,
  subscription: 30,
  chargeback: 60,
  collect: 30,
  whose_side: 0,
  ticket: 0,
  settlement_hold: 0,
  ai_chat_order: 0,
};

export const DEFINITIONS = {
  saved: "Money kept or recovered on cases RAY closed in the last 30 days.",
  time: "Minutes you would have spent on each case RAY resolved, added up. Cases that fixed themselves, got no reply or that you took over do not count.",
  closed: "Cases that ended in the last 30 days, whoever finished them.",
  kept: "Customers whose case ended with their money or order sorted out.",
  success: "Captured payments divided by captured and failed payments, last 7 days.",
} as const;

const FINAL = ["closed", "fixed_itself", "unconfirmed"] as const;
const isFinalState = (st: string) => (FINAL as readonly string[]).includes(st);

export type MomentStat = { moment: Moment; label: string; open: number; stake: number };

export type MerchantStats = {
  now: number;
  window: { from: number; to: number };
  needsYou: { count: number; stake: number };
  saved: { amount: number; previous: number; changePct: number | null; topMoment: Moment | null };
  timeSavedMinutes: number;
  closed: { count: number; byRay: number };
  kept: number;
  byMoment: MomentStat[];
  successRatePct: number | null;
  disputesThisMonth: { total: number; won: number; open: number };
  overdue: { amount: number; buyers: number; invoices: number };
  subscriptionsAtRisk: number;
  todaysSales: number;
};

export function merchantStats(a: Adapters, merchantId: string): MerchantStats {
  const now = a.clock.now();
  const from = now - 30 * DAY;
  const cases = a.db.select().from(s.cases).where(eq(s.cases.merchant_id, merchantId)).all();
  const endedAt = (c: (typeof cases)[number]) => c.closed_at ?? c.opened_at;
  const closedIn = (lo: number, hi: number) => cases.filter((c) => isFinalState(c.state) && endedAt(c) >= lo && endedAt(c) < hi);
  const closed = closedIn(from, now + 1);
  const previous = closedIn(from - 30 * DAY, from);
  const savedOf = (list: typeof cases) => list.filter((c) => c.counts_as_saved).reduce((sum, c) => sum + (c.amount ?? 0), 0);
  const saved = savedOf(closed);
  const before = savedOf(previous);

  const savedByMoment = new Map<Moment, number>();
  for (const c of closed.filter((x) => x.counts_as_saved)) savedByMoment.set(c.moment, (savedByMoment.get(c.moment) ?? 0) + (c.amount ?? 0));
  const topMoment = [...savedByMoment].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;

  // Resolved by RAY: closed (not fixed itself, not closed with no reply) and not taken over.
  const byRay = closed.filter((c) => c.state === "closed" && c.outcome !== HANDLED_BY_MERCHANT);
  const waiting = cases.filter((c) => c.state === "waiting_merchant");
  const open = cases.filter((c) => !isFinalState(c.state));

  const week = a.db
    .select({ status: s.rzpPayments.status, n: sql<number>`count(*)` })
    .from(s.rzpPayments)
    .where(and(eq(s.rzpPayments.merchant_id, merchantId), gte(s.rzpPayments.created_at, now - 7 * DAY)))
    .groupBy(s.rzpPayments.status)
    .all();
  const captured = week.find((w) => w.status === "captured")?.n ?? 0;
  const failed = week.find((w) => w.status === "failed")?.n ?? 0;

  const monthStart = Math.floor((now + IST_MS) / DAY) * DAY - IST_MS - (new Date(now + IST_MS).getUTCDate() - 1) * DAY;
  const disputes = a.db.select().from(s.disputes).where(and(eq(s.disputes.merchant_id, merchantId), gte(s.disputes.created_at, monthStart))).all();

  const overdue = a.db
    .select()
    .from(s.invoices)
    .where(and(eq(s.invoices.merchant_id, merchantId), eq(s.invoices.status, "open"), lt(s.invoices.due_date, now)))
    .all();

  const dayStart = Math.floor((now + IST_MS) / DAY) * DAY - IST_MS;
  const today = a.db
    .select({ total: sql<number>`coalesce(sum(${s.rzpPayments.amount}), 0)` })
    .from(s.rzpPayments)
    .where(and(eq(s.rzpPayments.merchant_id, merchantId), eq(s.rzpPayments.status, "captured"), eq(s.rzpPayments.currency, "INR"), gte(s.rzpPayments.created_at, dayStart)))
    .get();

  const atRisk = a.db
    .select({ n: sql<number>`count(*)` })
    .from(s.subscriptions)
    .where(and(eq(s.subscriptions.merchant_id, merchantId), sql`${s.subscriptions.status} in ('pending', 'halted')`))
    .get();

  return {
    now,
    window: { from, to: now },
    needsYou: { count: waiting.length, stake: waiting.reduce((sum, c) => sum + (c.amount ?? 0), 0) },
    saved: { amount: saved, previous: before, changePct: before > 0 ? Math.round(((saved - before) / before) * 100) : null, topMoment },
    timeSavedMinutes: byRay.reduce((sum, c) => sum + MINUTES_PER_CASE[c.moment], 0),
    closed: { count: closed.length, byRay: byRay.length },
    kept: closed.filter((c) => c.counts_as_saved).length,
    byMoment: (Object.keys(MOMENT_LABEL) as Moment[]).map((moment) => {
      const mine = open.filter((c) => c.moment === moment);
      return { moment, label: MOMENT_LABEL[moment], open: mine.length, stake: mine.reduce((sum, c) => sum + (c.amount ?? 0), 0) };
    }),
    successRatePct: captured + failed > 0 ? Math.round((captured / (captured + failed)) * 1000) / 10 : null,
    disputesThisMonth: {
      total: disputes.length,
      won: disputes.filter((d) => d.status === "won").length,
      open: disputes.filter((d) => d.status === "open" || d.status === "under_review").length,
    },
    overdue: { amount: overdue.reduce((sum, i) => sum + i.amount - i.paid_amount, 0), buyers: new Set(overdue.map((i) => i.buyer_id)).size, invoices: overdue.length },
    subscriptionsAtRisk: atRisk?.n ?? 0,
    todaysSales: today?.total ?? 0,
  };
}

// "11.5 h", "45 min"
export function hoursLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h} h`;
}

// ₹1,84,300: whole rupees with Indian grouping, never shortened to lakh.
export const rupees = (minor: number) => `₹${groupIndian(Math.round(minor / 100))}`;

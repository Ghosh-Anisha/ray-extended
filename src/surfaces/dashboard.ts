// My dashboard (docs/ui-rebuild.md 3.6 and 12): the widgets, the watch, the
// reports and the one daily suggestion. Every number is computed from rows
// (payments, refunds, disputes, invoices, cases); the choices the merchant
// makes live in ui_state. Nothing here moves money or opens a case by itself.
import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import * as s from "@/db/schema";
import { formatDate } from "@/guards/format";
import { merchantStats, rupees, type MerchantStats } from "./stats";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const IST_MS = (5 * 60 + 30) * MIN;
const istDayStart = (at: number) => Math.floor((at + IST_MS) / DAY) * DAY - IST_MS;

// ---- Saved choices

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export function readState<T>(a: Adapters, merchantId: string, key: string): T | null {
  const row = a.db.select().from(s.uiState).where(and(eq(s.uiState.merchant_id, merchantId), eq(s.uiState.key, key))).get();
  return (row?.value as T | undefined) ?? null;
}

export function writeState(a: Adapters, merchantId: string, key: string, value: Json) {
  const updated_at = a.clock.now();
  a.db
    .insert(s.uiState)
    .values({ merchant_id: merchantId, key, value, updated_at })
    .onConflictDoUpdate({ target: [s.uiState.merchant_id, s.uiState.key], set: { value, updated_at } })
    .run();
}

// ---- The three questions


export type Setup = { business: string; daily: string[]; audience: string; request?: string };

// Pre-selected from Leafy's data: it sells online, has invoices and disputes.
export function suggestedSetup(a: Adapters, merchantId: string): Setup {
  const st = merchantStats(a, merchantId);
  const daily = ["Sales today"];
  if (st.disputesThisMonth.total > 0) daily.push("Refunds and disputes");
  if (st.overdue.invoices > 0) daily.push("Overdue invoices");
  return { business: "Online store", daily, audience: "Me and my CA" };
}

// ---- Widgets

export type WidgetKind =
  | "sales_today"
  | "success_rate"
  | "saved"
  | "needs_you"
  | "refunds"
  | "disputes"
  | "overdue"
  | "subs_risk"
  | "refunds_by_product"
  | "success_by_bank";

export type Row = { label: string; value: string; sub?: string };
export type WidgetData = { value: string; note?: string; trend?: { text: string; good: boolean }; rows?: Row[]; href?: string };

export type SavedWidget = { id: string; kind: WidgetKind; source: "starter" | "asked" | "suggested"; watch: boolean };

export const WIDGET_TITLE: Record<WidgetKind, string> = {
  sales_today: "Today's sales",
  success_rate: "Success rate",
  saved: "Demo amount marked saved",
  needs_you: "Cases needing you",
  refunds: "Refunds",
  disputes: "Disputes and deadlines",
  overdue: "Overdue invoices",
  subs_risk: "Subscriptions at risk",
  refunds_by_product: "Refunds by product",
  success_by_bank: "Success rate by bank",
};

export const WIDGET_DEFINITION: Record<WidgetKind, string> = {
  sales_today: "Captured rupee payments since midnight today.",
  success_rate: "Captured payments ÷ captured and failed payments, last 7 days.",
  saved: "Sum of demo case amounts marked saved in the last 30 days. Not verified recovered revenue.",
  needs_you: "Cases waiting for your tap, with the money they hold.",
  refunds: "Refunds ÷ captured payments, last 30 days.",
  disputes: "Chargebacks raised this month, and the next reply deadline.",
  overdue: "Open invoices past their due date, minus what has been paid.",
  subs_risk: "Subscriptions whose last charge failed or is pending.",
  refunds_by_product: "Refunds ÷ captured payments, by product, last 30 days.",
  success_by_bank: "Captured ÷ captured and failed, by UPI app and cards, last 7 days.",
};

export const STARTER: WidgetKind[] = ["sales_today", "success_rate", "saved", "needs_you", "refunds", "disputes", "overdue", "subs_risk"];

const DAILY_WIDGET: Record<string, WidgetKind[]> = {
  "Sales today": ["sales_today"],
  "Success rate": ["success_rate"],
  "Refunds and disputes": ["refunds", "disputes"],
  "Overdue invoices": ["overdue"],
  Subscriptions: ["subs_risk"],
};

// What RAY keeps an eye on is what the merchant said they check every day.
export function starterWidgets(setup: Setup): SavedWidget[] {
  const watched = new Set(setup.daily.flatMap((d) => DAILY_WIDGET[d] ?? []));
  return STARTER.map((kind) => ({ id: `w_${kind}`, kind, source: "starter", watch: watched.has(kind) }));
}

export function setupWidgets(setup: Setup): SavedWidget[] {
  const widgets = starterWidgets(setup);
  const seen = new Set(widgets.map((w) => w.kind));
  const phrases = (setup.request ?? "").toLowerCase().split(/,|\band\b/).map((part) => part.trim()).filter(Boolean);
  for (const phrase of phrases) {
    const kind = parseWidgetAsk(phrase);
    if (kind && !seen.has(kind)) {
      widgets.push({ id: `w_${kind}`, kind, source: "asked", watch: false });
      seen.add(kind);
    }
  }
  return widgets;
}

const UPI_APP = (vpa: string | null) => {
  const handle = vpa?.split("@")[1] ?? "";
  return ({ okaxis: "Axis Bank UPI", okicici: "ICICI Bank UPI", okhdfcbank: "HDFC Bank UPI", oksbi: "SBI UPI" } as Record<string, string>)[handle] ?? "Other UPI";
};

function windowPayments(a: Adapters, merchantId: string, from: number, to: number) {
  return a.db
    .select()
    .from(s.rzpPayments)
    .where(and(eq(s.rzpPayments.merchant_id, merchantId), gte(s.rzpPayments.created_at, from), lt(s.rzpPayments.created_at, to)))
    .all()
    .filter((p) => p.status === "captured" || p.status === "failed");
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
const pctLabel = (v: number | null) => (v === null ? "No payments yet" : `${v}%`);

function refundsIn(a: Adapters, merchantId: string, from: number, to: number) {
  return a.db
    .select()
    .from(s.rzpRefunds)
    .where(and(eq(s.rzpRefunds.merchant_id, merchantId), gte(s.rzpRefunds.created_at, from), lt(s.rzpRefunds.created_at, to)))
    .all();
}

// The product a refund was for: the store order of its payment, found by
// payment id or, when the store did not record it, by the order receipt.
function productOf(a: Adapters, merchantId: string) {
  const orders = a.db.select().from(s.storeOrders).where(eq(s.storeOrders.merchant_id, merchantId)).all();
  const payments = new Map(a.db.select().from(s.rzpPayments).where(eq(s.rzpPayments.merchant_id, merchantId)).all().map((p) => [p.id, p]));
  return (r: { payment_id: string }) => {
    const receipt = payments.get(r.payment_id)?.receipt;
    const order = orders.find((o) => o.payment_id === r.payment_id) ?? orders.find((o) => receipt && o.receipt === receipt);
    return order?.items[0]?.name ?? "Not linked to a product";
  };
}

export function widgetData(a: Adapters, merchantId: string, kind: WidgetKind, st: MerchantStats = merchantStats(a, merchantId)): WidgetData {
  const base = `/merchant/${merchantId}`;
  const now = st.now;
  switch (kind) {
    case "sales_today": {
      const today = windowPayments(a, merchantId, istDayStart(now), now + 1).filter((p) => p.status === "captured" && p.currency === "INR");
      return { value: rupees(st.todaysSales), note: `${today.length} payments since midnight` };
    }
    case "success_rate":
      return { value: pctLabel(st.successRatePct), note: "Last 7 days" };
    case "saved":
      return { value: rupees(st.saved.amount), note: "Last 30 days", trend: st.saved.changePct && st.saved.changePct > 0 ? { text: `↑ ${st.saved.changePct}% vs last month`, good: true } : undefined, href: `${base}/cases?tab=closed` };
    case "needs_you":
      return { value: String(st.needsYou.count), note: "Case amounts use different bases and are not added", href: `${base}/cases` };
    case "refunds": {
      const refunds = refundsIn(a, merchantId, now - 30 * DAY, now + 1);
      const captured = windowPayments(a, merchantId, now - 30 * DAY, now + 1).filter((p) => p.status === "captured").length;
      const total = refunds.reduce((sum, r) => sum + r.amount, 0);
      return { value: `${refunds.length}`, note: `${rupees(total)} refunded · ${pctLabel(pct(refunds.length, captured))} of captured payments` };
    }
    case "disputes": {
      const next = a.db
        .select()
        .from(s.disputes)
        .where(and(eq(s.disputes.merchant_id, merchantId), eq(s.disputes.status, "open")))
        .orderBy(s.disputes.respond_by)
        .all()[0];
      const d = st.disputesThisMonth;
      return {
        value: `${d.total}`,
        note: `${d.won} won · ${d.open} open${next?.respond_by ? ` · reply by ${formatDate(next.respond_by)}` : ""}`,
        href: `${base}/cases?moment=chargeback`,
      };
    }
    case "overdue":
      return { value: rupees(st.overdue.amount), note: `${st.overdue.invoices} invoices from ${st.overdue.buyers} buyers`, href: `${base}/cases?moment=collect` };
    case "subs_risk":
      return { value: String(st.subscriptionsAtRisk), note: "Last charge failed or pending", href: `${base}/cases?moment=subscription` };
    case "refunds_by_product": {
      const refunds = refundsIn(a, merchantId, now - 30 * DAY, now + 1);
      const productName = productOf(a, merchantId);
      const byProduct = new Map<string, { n: number; amount: number }>();
      for (const r of refunds) {
        const name = productName(r);
        const cur = byProduct.get(name) ?? { n: 0, amount: 0 };
        byProduct.set(name, { n: cur.n + 1, amount: cur.amount + r.amount });
      }
      const rows = [...byProduct].sort((x, y) => y[1].amount - x[1].amount).map(([label, v]) => ({ label, value: rupees(v.amount), sub: `${v.n} ${v.n === 1 ? "refund" : "refunds"}` }));
      return { value: rupees(refunds.reduce((sum, r) => sum + r.amount, 0)), note: `${refunds.length} refunds in 30 days`, rows };
    }
    case "success_by_bank": {
      const rows = bankRows(a, merchantId, now - 7 * DAY, now + 1);
      return { value: pctLabel(st.successRatePct), note: "All methods, last 7 days", rows: rows.map((r) => ({ label: r.label, value: pctLabel(r.rate), sub: `${r.failed} failed of ${r.total}` })) };
    }
  }
}

type BankRow = { label: string; rate: number | null; total: number; failed: number };
function bankRows(a: Adapters, merchantId: string, from: number, to: number): BankRow[] {
  const groups = new Map<string, { ok: number; failed: number }>();
  for (const p of windowPayments(a, merchantId, from, to)) {
    const label = p.method === "upi" ? UPI_APP(p.vpa) : p.method === "card" ? "Cards" : "Other";
    const cur = groups.get(label) ?? { ok: 0, failed: 0 };
    if (p.status === "captured") cur.ok += 1;
    else cur.failed += 1;
    groups.set(label, cur);
  }
  return [...groups].map(([label, g]) => ({ label, rate: pct(g.ok, g.ok + g.failed), total: g.ok + g.failed, failed: g.failed })).sort((x, y) => y.total - x.total);
}

// ---- Asking for a widget


export function parseWidgetAsk(text: string): WidgetKind | null {
  const t = text.toLowerCase().replace(/[?.!]/g, "").replace(/\s+/g, " ").trim();
  if (/^(show )?refunds? by product$/.test(t)) return "refunds_by_product";
  if (/^(show )?success( rate)? by (bank|method)$/.test(t)) return "success_by_bank";
  if (/^(show |add )?overdue invoices?$/.test(t)) return "overdue";
  if (/^(show )?success( rate)?$/.test(t)) return "success_rate";
  if (/^(show )?sales today$/.test(t)) return "sales_today";
  if (/^(show )?(disputes|chargebacks)( this month)?$/.test(t)) return "disputes";
  if (/^(show )?subscriptions?( at risk)?$/.test(t)) return "subs_risk";
  if (/^(show )?refunds?$/.test(t)) return "refunds";
  if (/^(show )?(saved|savings)$/.test(t)) return "saved";
  if (/^(show )?(cases|cases waiting|waiting on me|cases that need my attention|cases needing my attention)$/.test(t)) return "needs_you";
  return null;
}

// ---- Watch it for me

export type WatchAlert = {
  widgetId: string;
  kind: WidgetKind;
  headline: string;
  why: { title: string; rows: Row[]; lines: string[] };
  action: { label: string; href: string } | null;
};

const SERIES_DAYS = 7;

// Normal for this hour and weekday: the same weekday earlier when there are
// two or more, else the days before it (too few of this weekday yet).
function normalDays(a: Adapters, merchantId: string, now: number) {
  const todayStart = istDayStart(now);
  const earlier = Array.from({ length: SERIES_DAYS + 21 }, (_, i) => todayStart - (i + 1) * DAY);
  const weekday = (t: number) => new Date(t + IST_MS).getUTCDay();
  const dense = (start: number) => windowPayments(a, merchantId, start, start + DAY).length >= 20;
  const sameWeekday = earlier.filter((d) => weekday(d) === weekday(todayStart) && dense(d));
  if (sameWeekday.length >= 2) return { days: sameWeekday, basis: "the same weekday" };
  return { days: earlier.slice(0, SERIES_DAYS).filter(dense), basis: "the days before" };
}

const REASON_WORDS: Record<string, string> = {
  amount_exceeds_maximum_amount_allowed: "the amount was above the card limit your account allows",
  international_transaction_not_allowed: "the customer's bank blocks international cards",
  payment_failed: "the bank declined it",
};

function formatClock(at: number) {
  const d = new Date(at + IST_MS);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function watchAlerts(a: Adapters, merchantId: string, widgets: SavedWidget[]): WatchAlert[] {
  const now = a.clock.now();
  const out: WatchAlert[] = [];
  const todayStart = istDayStart(now);
  const { days, basis } = normalDays(a, merchantId, now);
  if (days.length === 0) return out;
  const byOffset = (fn: (from: number, to: number) => number | null) => {
    const normal = days.map((d) => fn(d, d + (now - todayStart))).filter((v): v is number => v !== null);
    return normal.length ? normal.reduce((x, y) => x + y, 0) / normal.length : null;
  };

  for (const w of widgets.filter((x) => x.watch)) {
    if (w.kind === "success_rate") {
      const rate = (m: string) => (from: number, to: number) => {
        const ps = windowPayments(a, merchantId, from, to).filter((p) => p.method === m);
        return pct(ps.filter((p) => p.status === "captured").length, ps.length);
      };
      const rows: Row[] = [];
      let worst: { m: string; now: number; normal: number } | null = null;
      for (const m of ["card", "upi"]) {
        const cur = rate(m)(todayStart, now + 1);
        const normal = byOffset(rate(m));
        if (cur === null || normal === null) continue;
        rows.push({ label: m === "card" ? "Cards" : "UPI", value: `${cur}%`, sub: `usually ${Math.round(normal * 10) / 10}% by this time` });
        if (normal - cur >= 8 && (!worst || normal - cur > worst.normal - worst.now)) worst = { m, now: cur, normal };
      }
      if (!worst) continue;
      const failures = a.db
        .select()
        .from(s.rzpPayments)
        .where(and(eq(s.rzpPayments.merchant_id, merchantId), eq(s.rzpPayments.status, "failed"), eq(s.rzpPayments.method, worst.m), gte(s.rzpPayments.created_at, todayStart)))
        .orderBy(desc(s.rzpPayments.created_at))
        .all();
      const reasons = new Map<string, number>();
      for (const f of failures) reasons.set(f.error_reason ?? "unknown", (reasons.get(f.error_reason ?? "unknown") ?? 0) + 1);
      const reasonLines = [...reasons].map(([r, n]) => `${n} ${n === 1 ? "payment" : "payments"}: ${REASON_WORDS[r] ?? r.replace(/_/g, " ")}`);
      // The one action: the open case that holds one of these failed payments.
      const linked = failures.map((f) => a.db.select().from(s.cases).where(and(eq(s.cases.merchant_id, merchantId), eq(s.cases.payment_id, f.id))).get()).find(Boolean);
      const base = `/merchant/${merchantId}`;
      const label = worst.m === "card" ? "Card" : "UPI";
      out.push({
        widgetId: w.id,
        kind: w.kind,
        headline: `${label} payments are succeeding ${worst.now}% of the time, usually ${Math.round(worst.normal * 10) / 10}% by this time.`,
        why: { title: `Why ${label.toLowerCase()} payments dipped`, rows, lines: [`Compared with ${basis}, up to ${formatClock(now)}.`, ...reasonLines] },
        action: linked ? { label: "Open the related case", href: `${base}/cases/${linked.id}` } : { label: "Open cases", href: `${base}/cases` },
      });
    }
    if (w.kind === "sales_today") {
      const sum = (from: number, to: number) => windowPayments(a, merchantId, from, to).filter((p) => p.status === "captured" && p.currency === "INR").reduce((x, p) => x + p.amount, 0);
      const cur = sum(todayStart, now + 1);
      const normal = byOffset(sum);
      if (normal !== null && normal > 0 && cur < normal * 0.6) {
        out.push({
          widgetId: w.id,
          kind: w.kind,
          headline: `Sales are ${rupees(cur)} so far, usually ${rupees(normal)} by this time.`,
          why: { title: "Why sales are lower", rows: [], lines: [`Compared with ${basis}, up to ${formatClock(now)}.`] },
          action: { label: "Open cases", href: `/merchant/${merchantId}/cases` },
        });
      }
    }
  }
  return out;
}

// ---- One suggestion a day

export type Suggestion = { id: string; text: string; kind: WidgetKind };
export type Ask = { kind: WidgetKind; at: number };

export function recordAsk(a: Adapters, merchantId: string, kind: WidgetKind) {
  const asks = readState<Ask[]>(a, merchantId, "dash.asks") ?? [];
  writeState(a, merchantId, "dash.asks", [...asks, { kind, at: a.clock.now() }]);
}

// The most-asked widget this week that is not already watched, once a day.
export function suggestion(a: Adapters, merchantId: string, widgets: SavedWidget[]): Suggestion | null {
  const now = a.clock.now();
  const dismissed = readState<{ day: number }>(a, merchantId, "dash.suggestion_dismissed");
  if (dismissed && dismissed.day === istDayStart(now)) return null;
  const asks = (readState<Ask[]>(a, merchantId, "dash.asks") ?? []).filter((x) => x.at >= now - 7 * DAY);
  const counts = new Map<WidgetKind, number>();
  for (const x of asks) counts.set(x.kind, (counts.get(x.kind) ?? 0) + 1);
  const top = [...counts].filter(([k]) => !widgets.some((w) => w.kind === k && w.watch)).sort((x, y) => y[1] - x[1])[0];
  if (!top || top[1] < 2) return null;
  const [kind, n] = top;
  return { id: `sug_${kind}`, kind, text: `You asked about ${WIDGET_TITLE[kind].toLowerCase()} ${n} times this week. Pin it?` };
}

// ---- Reports in words

export type Report = { id: string; title: string; summary: string[]; columns: string[]; rows: string[][]; total: string[] };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// No settlement feed is available: this is an estimated net-collections view,
// never a settlement or bank-reconciliation report.
const FEE_RATE = 0.02;
const GST_RATE = 0.18;

type ReportIntent = { kind: "collections" | "refunds" | "disputes"; monthIndex: number | null };

export function parseReportRequest(text: string): ReportIntent | null {
  const t = text.toLowerCase().replace(/[?.!]/g, "").replace(/\s+/g, " ").trim();
  const month = `(${MONTHS.join("|")})`;
  const collections = t.match(new RegExp(`^(?:show )?(?:estimated net collections|settlements?)(?: for ${month})?(?: with fees and gst)?$`));
  if (collections) return { kind: "collections", monthIndex: collections[1] ? MONTHS.indexOf(collections[1]) : null };
  const refunds = t.match(new RegExp(`^(?:show )?refunds?(?: for ${month})?$`));
  if (refunds) return { kind: "refunds", monthIndex: refunds[1] ? MONTHS.indexOf(refunds[1]) : null };
  const disputes = t.match(new RegExp(`^(?:show )?(?:disputes|chargebacks)(?: this month| for ${month})?$`));
  if (disputes) return { kind: "disputes", monthIndex: disputes[1] ? MONTHS.indexOf(disputes[1]) : null };
  return null;
}

export function buildReport(a: Adapters, merchantId: string, text: string): Report | null {
  const intent = parseReportRequest(text);
  if (!intent) return null;
  const now = a.clock.now();
  const year = new Date(now + IST_MS).getUTCFullYear();
  const m = intent.monthIndex ?? new Date(now + IST_MS).getUTCMonth();
  const from = Date.UTC(year, m, 1) - IST_MS;
  const to = Date.UTC(year, m + 1, 1) - IST_MS;
  const month = `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1)} ${year}`;

  if (intent.kind === "collections") {
    const paid = windowPayments(a, merchantId, from, to).filter((p) => p.status === "captured" && p.currency === "INR");
    const byDay = new Map<number, number[]>();
    for (const p of paid) byDay.set(istDayStart(p.created_at), [...(byDay.get(istDayStart(p.created_at)) ?? []), p.amount]);
    const rows: string[][] = [];
    let gross = 0;
    let fee = 0;
    let gst = 0;
    let net = 0;
    for (const [day, amounts] of [...byDay].sort((x, y) => x[0] - y[0])) {
      const g = amounts.reduce((x, y) => x + y, 0);
      const f = Math.round(g * FEE_RATE);
      const gs = Math.round(f * GST_RATE);
      // Reports display whole rupees. Round each displayed component, then
      // derive displayed net so every visible row and total reconciles.
      const gd = Math.round(g / 100);
      const fd = Math.round(f / 100);
      const gsd = Math.round(gs / 100);
      const nd = gd - fd - gsd;
      gross += gd;
      fee += fd;
      gst += gsd;
      net += nd;
      rows.push([formatDate(day), String(amounts.length), rupees(gd * 100), rupees(fd * 100), rupees(gsd * 100), rupees(nd * 100)]);
    }
    return {
      id: `report_estimated_net_collections_${MONTHS[m]}`,
      title: `Estimated net collections for ${month}`,
      summary: [
        `${paid.length} captured payments total ${rupees(gross * 100)} in ${month}; this is not a settlement or bank-credit report.`,
        `Estimated fees are ${rupees(fee * 100)} and GST on those fees is ${rupees(gst * 100)}, using assumed ${FEE_RATE * 100}% fee and ${GST_RATE * 100}% GST rates.`,
        `Estimated net collections are ${rupees(net * 100)} after displayed whole-rupee rounding.`,
      ],
      columns: ["Day", "Payments", "Gross", "Est. fees", "Est. GST", "Est. net"],
      rows,
      total: ["Total", String(paid.length), rupees(gross * 100), rupees(fee * 100), rupees(gst * 100), rupees(net * 100)],
    };
  }
  if (intent.kind === "refunds") {
    const refunds = refundsIn(a, merchantId, from, to);
    const productName = productOf(a, merchantId);
    const rows = refunds.map((r) => [formatDate(r.created_at), productName(r), rupees(r.amount)]);
    const total = refunds.reduce((x, r) => x + r.amount, 0);
    return {
      id: `report_refunds_${MONTHS[m]}`,
      title: `Refunds for ${month}`,
      summary: [`${refunds.length} ${refunds.length === 1 ? "refund" : "refunds"} came to ${rupees(total)} in ${month}.`],
      columns: ["Day", "Product", "Amount"],
      rows,
      total: ["Total", `${refunds.length} refunds`, rupees(total)],
    };
  }
  if (intent.kind === "disputes") {
    const ds = a.db.select().from(s.disputes).where(and(eq(s.disputes.merchant_id, merchantId), gte(s.disputes.created_at, from), lt(s.disputes.created_at, to))).all();
    const total = ds.reduce((x, d) => x + d.amount, 0);
    return {
      id: `report_disputes_${MONTHS[m]}`,
      title: `Disputes for ${month}`,
      summary: [`${ds.length} ${ds.length === 1 ? "dispute" : "disputes"} worth ${rupees(total)} in ${month}.`, `${ds.filter((d) => d.status === "won").length} won and ${ds.filter((d) => d.status === "open").length} open.`],
      columns: ["Raised", "Reason", "Amount", "Status"],
      rows: ds.map((d) => [formatDate(d.created_at), d.reason, rupees(d.amount), d.status.replace(/_/g, " ")]),
      total: ["Total", `${ds.length} disputes`, rupees(total), ""],
    };
  }
  return null;
}

// Month-end CA pack: the reports a CA asks for, for the month that just ended.
export function caPack(a: Adapters, merchantId: string): { month: string; reports: Report[] } {
  const d = new Date(a.clock.now() + IST_MS);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const name = MONTHS[prev.getUTCMonth()];
  const reports = [`Estimated net collections for ${name} with fees and GST`, `Refunds for ${name}`, `Disputes for ${name}`].map((q) => buildReport(a, merchantId, q)!);
  return { month: `${name[0].toUpperCase()}${name.slice(1)} ${prev.getUTCFullYear()}`, reports };
}

export type SavedReportPreview = { id: string; reportId: string; title: string; savedAt: number; status: "preview_only" };

// ---- The whole page

export type DashboardView = {
  setup: Setup | null;
  suggested: Setup;
  widgets: (SavedWidget & { title: string; definition: string; data: WidgetData })[];
  kept: boolean;
  alerts: WatchAlert[];
  suggestion: Suggestion | null;
  savedPreviews: SavedReportPreview[];
  pack: { month: string; reports: Report[] };
  nowLabel: string;
};

export function dashboardView(a: Adapters, merchantId: string): DashboardView {
  const st = merchantStats(a, merchantId);
  const setup = readState<Setup>(a, merchantId, "dash.setup");
  const saved = setup ? (readState<SavedWidget[]>(a, merchantId, "dash.widgets") ?? starterWidgets(setup)) : [];
  return {
    setup,
    suggested: suggestedSetup(a, merchantId),
    widgets: saved.map((w) => ({ ...w, title: WIDGET_TITLE[w.kind], definition: WIDGET_DEFINITION[w.kind], data: widgetData(a, merchantId, w.kind, st) })),
    kept: readState<boolean>(a, merchantId, "dash.kept") ?? false,
    alerts: watchAlerts(a, merchantId, saved),
    suggestion: setup ? suggestion(a, merchantId, saved) : null,
    savedPreviews: readState<SavedReportPreview[]>(a, merchantId, "dash.report_previews") ?? [],
    pack: caPack(a, merchantId),
    nowLabel: formatClock(st.now),
  };
}

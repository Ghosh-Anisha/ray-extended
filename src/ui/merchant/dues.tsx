"use client";

import Link from "next/link";
import { CalendarClock, CircleAlert, FileWarning, IndianRupee, ShieldAlert } from "lucide-react";
import { formatDate } from "@/guards/format";
import { rupees } from "@/surfaces/stats";
import { CoachMark } from "../coach-mark";
import { NudgeBar } from "../nudge";

const DUE_EXAMPLE = [
  { name: "Flour & packaging", dueAt: Date.parse("2026-10-15T00:00:00+05:30"), amount: 1_840_000 },
  { name: "Courier partner", dueAt: Date.parse("2026-10-18T00:00:00+05:30"), amount: 980_000 },
  { name: "Kitchen rent", dueAt: Date.parse("2026-11-01T00:00:00+05:30"), amount: 2_800_000 },
];

const EXAMPLE_CASH = 4_200_000;
const monthAt = (at: number) => {
  const d = new Date(at + 330 * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const dueLabel = (at: number) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(at);
const balanceLabel = (minor: number) => minor < 0 ? `${rupees(-minor)} short` : rupees(minor);
export function duesExampleSummary(now: number) {
  const dueThisMonth = DUE_EXAMPLE.filter((d) => monthAt(d.dueAt) === monthAt(now)).reduce((sum, d) => sum + d.amount, 0);
  return { openingCash: EXAMPLE_CASH, dueThisMonth, afterThisMonth: EXAMPLE_CASH - dueThisMonth };
}

export function Dues({ merchantId, now }: { merchantId: string; now: number }) {
  const isLeafy = merchantId === "m_leafy_bakes";
  const summary = duesExampleSummary(now);
  return (
    <section className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 className="page-title">Dues</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>Pay on time, stay liquid</p>
        </div>
        <span className="chip simulated"><CalendarClock size={14} /> Simulated example · {formatDate(now)}</span>
      </div>
      {!isLeafy && <div className="panel">No Dues example is seeded for this account. These figures are not account data.</div>}
      {isLeafy && <div className="banner promise" role="note">Illustrative only. There is no connected complete ledger, settlement or reconciliation feed, supplier payment rail, or verified supplier recipient. Nothing on this screen can send a supplier payment.</div>}
      <div className="grid-3">
        <div className="panel metric"><span className="muted">Example cash balance</span><strong>{isLeafy ? rupees(summary.openingCash) : "Not available"}</strong><span className="insight">Simulated value, not connected to a bank.</span></div>
        <div className="panel metric"><span className="muted">Due this month</span><strong>{isLeafy ? rupees(summary.dueThisMonth) : "Not available"}</strong><span className="insight">{isLeafy ? `${rupees(summary.afterThisMonth)} remains in this example after these dues.` : "No account-specific obligations are loaded."}</span></div>
        <div className="panel metric"><span className="muted">Cash after this month</span><strong>{isLeafy ? rupees(summary.afterThisMonth) : "Not available"}</strong><span className="insight">Excludes all unlisted bills and expected inflows.</span></div>
      </div>
      {isLeafy && <section id="invoices" className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Example obligations</h2><span className="chip simulated">Simulated · no payment rail</span></div>
        <p className="muted">Dated arithmetic example only, not a cash-flow forecast or payment recommendation. It omits unlisted bills, reserves and expected inflows.</p>
        <div className="dues-list">{(() => { let cash = EXAMPLE_CASH; return DUE_EXAMPLE.map((d) => { const before = cash; cash -= d.amount; return <div className="due-row" key={d.name}><div><strong>{d.name}</strong><div className="muted">Due {dueLabel(d.dueAt)} · {monthAt(d.dueAt) === monthAt(now) ? "This month" : "Next month"}</div></div><span className="num">{rupees(d.amount)}</span><span className="chip neutral">{balanceLabel(before)} before · {balanceLabel(cash)} after</span></div>; }); })()}</div>
      </section>}
      {isLeafy && <section className="panel stack">
        <div className="row"><h2 style={{ margin: 0 }}>Invoices in</h2><span className="chip simulated">Simulated email</span></div>
        <div className="invoice-row"><FileWarning size={18} color="var(--warning)" /><div className="grow"><strong>INV-884 · Flour Mart</strong><div className="muted">₹18,400 · Duplicate of INV-881 · received today</div></div><span className="chip notice">Duplicate flagged</span><button className="btn secondary small" type="button">Review</button></div>
        <div className="invoice-row"><ShieldAlert size={18} color="var(--critical)" /><div className="grow"><strong>INV-885 · PackRight</strong><div className="muted">₹9,800 · Bank account changed in the email</div></div><span className="chip negative">Bank-change hold</span><button className="btn secondary small" type="button">Verify</button></div>
        <div className="invoice-row"><CircleAlert size={18} color="var(--warning)" /><div className="grow"><strong>INV-886 · Quick Supplies</strong><div className="muted">₹31,200 · 2.4× the last 3 months · supplier invoice, not a fetched bill</div></div><span className="chip notice">Odd bill · review first</span><button className="btn secondary small" type="button" disabled><IndianRupee size={14} /> No payment rail configured</button></div>
      </section>}
      <NudgeBar text={isLeafy ? "These simulated rows do not include a complete cash forecast or a payment rail." : "No account-specific dues data is loaded for this merchant."} action={isLeafy ? { label: "Review invoices", href: "#invoices" } : { label: "View cases", href: `/merchant/${merchantId}/cases` }} />
      <CoachMark id="dues" steps={["These simulated figures demonstrate date-based arithmetic only. No bank balance or complete obligations ledger is connected.", "Supplier invoices are not BBPS bills. Review duplicate, bank-change and unusual-amount warnings before any payment."]} />
      <Link className="sr-only" href={`/merchant/${merchantId}/cases`}>Back to cases</Link>
    </section>
  );
}

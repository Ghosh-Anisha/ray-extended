"use client";

import Link from "next/link";
import { CalendarClock, CircleAlert, FileWarning, ShieldAlert } from "lucide-react";
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

function InvoiceReview({ label, title, details }: { label: string; title: string; details: string[] }) {
  return (
    <details className="invoice-review">
      <summary className="btn secondary small" style={{ listStyle: "none", cursor: "pointer" }}>{label}</summary>
      <div className="panel stack" role="region" aria-label={title} style={{ marginTop: 8, padding: 12, gap: 6 }}>
        <strong>{title}</strong>
        {details.map((line) => <span className="muted" key={line}>{line}</span>)}
        <span className="chip simulated" style={{ alignSelf: "flex-start" }}>Review only · no payment or verification performed</span>
      </div>
    </details>
  );
}

export function InvoiceInbox() {
  return (
    <section className="panel stack" aria-label="Simulated invoice inbox">
      <div className="row"><h2 style={{ margin: 0 }}>Invoices in</h2><span className="chip simulated">Simulated email</span></div>
      <div className="invoice-row">
        <FileWarning size={18} color="var(--warning)" />
        <div className="grow"><strong>INV-884 · Flour Mart</strong><div className="muted">₹18,400 · demo flag says duplicate of INV-881 · received in seeded example</div></div>
        <span className="chip notice">Duplicate flag · unverified</span>
        <InvoiceReview label="Review duplicate flag" title="INV-884 · demo review" details={[
          "The simulated email labels this ₹18,400 invoice as a duplicate of INV-881.",
          "INV-881 and the source email are not loaded here, so the duplicate cannot be verified from this demo.",
        ]} />
      </div>
      <div className="invoice-row">
        <ShieldAlert size={18} color="var(--critical)" />
        <div className="grow"><strong>INV-885 · PackRight</strong><div className="muted">₹9,800 · simulated email says bank details changed</div></div>
        <span className="chip negative">Payment hold · unverified</span>
        <InvoiceReview label="Review bank-change hold" title="INV-885 · payment hold" details={[
          "The demo email says the bank details changed.",
          "No previously verified contact or independent bank record is connected, so this demo cannot verify the change. Keep the hold in place and contact the supplier through a known channel outside this prototype.",
        ]} />
      </div>
      <div className="invoice-row">
        <CircleAlert size={18} color="var(--warning)" />
        <div className="grow"><strong>INV-886 · Quick Supplies</strong><div className="muted">₹31,200 · illustrative supplier invoice; no comparison invoices loaded</div></div>
        <span className="chip notice">Example only · no anomaly evidence</span>
        <InvoiceReview label="Review invoice limits" title="INV-886 · example only" details={[
          "₹31,200 is an illustrative amount in this UI example, not a verified bill or a calculated anomaly.",
          "The comparison invoices, biller identity and fetched bill are not available. No BBPS or supplier-payment action is configured.",
        ]} />
        <button className="btn secondary small" type="button" disabled aria-disabled="true">Supplier payment unavailable</button>
      </div>
    </section>
  );
}

export function Dues({ merchantId, now }: { merchantId: string; now: number }) {
  const isLeafy = merchantId === "m_leafy_bakes";
  const summary = duesExampleSummary(now);
  return (
    <section className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 className="page-title">Dues</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>Illustrative dated arithmetic, not a liquidity assessment</p>
        </div>
        <span className="chip simulated"><CalendarClock size={14} /> Simulated example · {formatDate(now)}</span>
      </div>
      {!isLeafy && <div className="panel">No Dues example is seeded for this account. These figures are not account data.</div>}
      {isLeafy && <div className="banner promise" role="note">Illustrative only. There is no connected complete ledger, settlement or reconciliation feed, supplier payment rail, or verified supplier recipient. Nothing on this screen can send a supplier payment.</div>}
      <div className="grid-3">
        <div className="panel metric"><span className="muted">Illustrative starting amount · 13 Oct</span><strong>{isLeafy ? rupees(summary.openingCash) : "Not available"}</strong><span className="insight">Example only; not a bank balance.</span></div>
        <div className="panel metric"><span className="muted">Example dues dated this month</span><strong>{isLeafy ? rupees(summary.dueThisMonth) : "Not available"}</strong><span className="insight">{isLeafy ? `If all listed dues were paid, ${rupees(summary.afterThisMonth)} would remain in this arithmetic example.` : "No account-specific obligations are loaded."}</span></div>
        <div className="panel metric"><span className="muted">Example remainder if listed dues are paid</span><strong>{isLeafy ? rupees(summary.afterThisMonth) : "Not available"}</strong><span className="insight">Excludes unlisted bills, reserves and expected inflows; payment status is not connected.</span></div>
      </div>
      {isLeafy && <section id="invoices" className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Example obligations</h2><span className="chip simulated">Simulated · no payment rail</span></div>
        <p className="muted">Dated arithmetic example only, not a cash-flow forecast or payment recommendation. It omits unlisted bills, reserves and expected inflows.</p>
        <div className="dues-list">{(() => { let cash = EXAMPLE_CASH; return DUE_EXAMPLE.map((d) => { const before = cash; cash -= d.amount; return <div className="due-row" key={d.name}><div><strong>{d.name}</strong><div className="muted">Due {dueLabel(d.dueAt)} · payment status not connected</div></div><span className="num">{rupees(d.amount)}</span><span className="chip neutral">Example amount: {balanceLabel(before)} before · {balanceLabel(cash)} after</span></div>; }); })()}</div>
      </section>}
      {isLeafy && <InvoiceInbox />}
      <NudgeBar text={isLeafy ? "These simulated rows do not include a complete cash forecast or a payment rail." : "No account-specific dues data is loaded for this merchant."} action={isLeafy ? { label: "Review invoices", href: "#invoices" } : { label: "View cases", href: `/merchant/${merchantId}/cases` }} />
      <CoachMark id="dues" steps={["These simulated figures demonstrate date-based arithmetic only. No bank balance or complete obligations ledger is connected.", "Supplier invoices are not BBPS bills. Review the demo flags, but they are not independently verified and no payment action is available."]} />
      <Link className="sr-only" href={`/merchant/${merchantId}/cases`}>Back to cases</Link>
    </section>
  );
}

"use client";

import Link from "next/link";
import { CalendarClock, CircleAlert, FileWarning, IndianRupee, ShieldAlert } from "lucide-react";
import { CoachMark } from "../coach-mark";
import { NudgeBar } from "../nudge";

const dues = [
  { name: "Flour & packaging", to: "15 Oct", amount: "₹18,400", cash: "₹42,000", status: "Due in 2 days" },
  { name: "Courier partner", to: "18 Oct", amount: "₹9,800", cash: "₹42,000", status: "Due in 5 days" },
  { name: "Kitchen rent", to: "1 Nov", amount: "₹28,000", cash: "₹42,000", status: "Due in 19 days" },
];

export function Dues({ merchantId }: { merchantId: string }) {
  return (
    <section className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 className="page-title">Dues</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>Pay on time, stay liquid</p>
        </div>
        <span className="chip information"><CalendarClock size={14} /> Updated 2 min ago</span>
      </div>
      <div className="grid-3">
        <div className="panel metric"><span className="muted">Cash in bank</span><strong>₹42,000</strong><span className="insight">✦ Insight by RAY · Enough for the next 2 dues</span></div>
        <div className="panel metric"><span className="muted">Due this month</span><strong>₹56,200</strong><span className="insight">✦ Insight by RAY · ₹14,200 shortfall if all are paid now</span></div>
        <div className="panel metric"><span className="muted">Suggested order</span><strong>43B(h)</strong><span className="insight">Pay accepted invoices before disputed bills</span></div>
      </div>
      <section className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0 }}>Pay on time</h2><span className="chip neutral">43B(h) order</span></div>
        <p className="muted">RAY puts accepted, older dues first so you can see the shortfall before paying.</p>
        <div className="dues-list">
          {dues.map((d) => <div className="due-row" key={d.name}><div><strong>{d.name}</strong><div className="muted">Due {d.to} · {d.status}</div></div><span className="num">{d.amount}</span><span className="chip neutral">{d.cash} available</span><button className="btn secondary small" type="button">Choose shortfall</button></div>)}
        </div>
      </section>
      <section className="panel stack">
        <div className="row"><h2 style={{ margin: 0 }}>Invoices in</h2><span className="chip simulated">Simulated email</span></div>
        <div className="invoice-row"><FileWarning size={18} color="var(--warning)" /><div className="grow"><strong>INV-884 · Flour Mart</strong><div className="muted">₹18,400 · Duplicate of INV-881 · received today</div></div><span className="chip notice">Duplicate flagged</span><button className="btn secondary small" type="button">Review</button></div>
        <div className="invoice-row"><ShieldAlert size={18} color="var(--critical)" /><div className="grow"><strong>INV-885 · PackRight</strong><div className="muted">₹9,800 · Bank account changed in the email</div></div><span className="chip negative">Bank-change hold</span><button className="btn secondary small" type="button">Verify</button></div>
        <div className="invoice-row"><CircleAlert size={18} color="var(--warning)" /><div className="grow"><strong>INV-886 · Quick Supplies</strong><div className="muted">₹31,200 · 2.4× the last 3 months</div></div><span className="chip notice">Odd bill</span><button className="btn primary small" type="button"><IndianRupee size={14} /> Pay with BBPS</button></div>
      </section>
      <NudgeBar text="Start with the oldest accepted due, then check the duplicate before paying." action={{ label: "Review invoices", href: "#invoices" }} />
      <CoachMark id="dues" steps={["Cash in bank and the 43B(h) order show what RAY would pay first.", "Invoices from email are checked for duplicates, bank changes and unusual amounts before you pay."]} />
      <Link className="sr-only" href={`/merchant/${merchantId}/cases`}>Back to cases</Link>
    </section>
  );
}

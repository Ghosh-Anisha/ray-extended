import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { merchantParam } from "../merchant";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { merchantView } from "@/surfaces/views";
import { money, shortId, dateTime } from "@/surfaces/format";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function PaymentsPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const rows = a.db.select().from(s.rzpPayments).where(eq(s.rzpPayments.merchant_id, merchantId)).orderBy(desc(s.rzpPayments.created_at)).limit(30).all();
  const repo = createRepository(a.db);
  const relatedCase = (paymentId: string) => a.db.select({ id: s.cases.id, moment: s.cases.moment }).from(s.cases).where(eq(s.cases.payment_id, paymentId)).all().find((c) => repo.cases.get(c.id)?.merchant_id === merchantId);
  return <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
    <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}/cases` }, { label: "Payments" }]} />
    <div><h1 className="page-title">Payments</h1><p className="page-sub">Recent payment activity from fictional seeded demo records. No live payment account is connected.</p></div>
    <section className="panel stack"><div className="row"><h2 style={{ margin: 0 }}>Recent activity</h2><span className="chip simulated">Simulated demo records</span></div>
      <div className="table-wrap"><table className="data"><thead><tr><th>Payment</th><th>Created</th><th>Method</th><th>Amount</th><th>Status</th><th>Details / next step</th></tr></thead><tbody>
        {rows.map((p) => { const kase = relatedCase(p.id); return <tr key={p.id}><td title={p.id}>{shortId(p.id)}</td><td>{dateTime(p.created_at)}</td><td>{p.method ?? "Not recorded"}</td><td>{money(p.amount, p.currency)}</td><td><span className={`chip ${p.status === "failed" ? "negative" : p.status === "captured" ? "positive" : "notice"}`}>{p.status}</span></td><td><details><summary className="btn secondary small">View payment</summary><div className="stack" style={{ padding: 10 }}><span>Payment ID: {p.id}</span><span>Order ID: {p.order_id ?? "Not recorded"}</span><span>Gateway failure reason: {p.error_reason ?? "No failure reason recorded"}</span>{p.status === "failed" && <span className="muted">Demo evidence indicates this payment did not complete. No capture or retry action is available here.</span>}{kase ? <Link href={`/merchant/${merchantId}/cases/${kase.id}`}>Open related {kase.moment === "international" ? "card-declined" : "payment"} case</Link> : <Link href={`/merchant/${merchantId}/cases`}>Review cases and follow-up</Link>}</div></details></td></tr>; })}
        {rows.length === 0 && <tr><td colSpan={6}>No seeded payment activity for this account.</td></tr>}
      </tbody></table></div>
      <p className="muted">Read-only preview. No capture, refund, transfer or payment action is available on this page. Failed-payment evidence is demo data, not a live gateway determination.</p><Link className="btn tertiary" href={`/merchant/${merchantId}/cases?moment=international`}>Review card-declined cases</Link>
    </section>
  </PageShell>;
}

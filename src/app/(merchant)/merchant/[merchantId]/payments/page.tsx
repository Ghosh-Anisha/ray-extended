import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { merchantParam } from "../merchant";
import * as s from "@/db/schema";
import { merchantView } from "@/surfaces/views";
import { money, shortId, dateTime } from "@/surfaces/format";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function PaymentsPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const rows = a.db.select().from(s.rzpPayments).where(eq(s.rzpPayments.merchant_id, merchantId)).orderBy(desc(s.rzpPayments.created_at)).limit(30).all();
  return <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
    <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}/cases` }, { label: "Payments" }]} />
    <div><h1 className="page-title">Payments</h1><p className="page-sub">Recent payment activity from fictional seeded demo records. No live payment account is connected.</p></div>
    <section className="panel stack"><div className="row"><h2 style={{ margin: 0 }}>Recent activity</h2><span className="chip simulated">Simulated demo records</span></div>
      <div className="table-wrap"><table className="data"><thead><tr><th>Payment</th><th>Created</th><th>Method</th><th>Amount</th><th>Status</th></tr></thead><tbody>
        {rows.map((p) => <tr key={p.id}><td title={p.id}>{shortId(p.id)}</td><td>{dateTime(p.created_at)}</td><td>{p.method ?? "Not recorded"}</td><td>{money(p.amount, p.currency)}</td><td>{p.status}</td></tr>)}
        {rows.length === 0 && <tr><td colSpan={5}>No seeded payment activity for this account.</td></tr>}
      </tbody></table></div>
      <p className="muted">Read-only preview. No capture, refund, transfer or payment action is available on this page.</p><Link className="btn tertiary" href={`/merchant/${merchantId}/cases`}>Review related cases</Link>
    </section>
  </PageShell>;
}

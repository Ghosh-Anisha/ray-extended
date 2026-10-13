import { merchantParam } from "../merchant";
import { Dues } from "@/ui/merchant/dues";
import { morningList } from "@/flows/collect/morning";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";
import { merchantView } from "@/surfaces/views";

export default async function DuesPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Dues & Liquidity" }]} />
      <Dues merchantId={merchantId} now={a.clock.now()} collectRequests={morningList(a, merchantId).rows.map((r) => ({ buyer: r.buyer, overdue: r.overdue, overdueMinor: r.overdueMinor, stage: r.stage, state: r.state, promise: r.promise, caseId: r.caseId }))} />
    </PageShell>
  );
}

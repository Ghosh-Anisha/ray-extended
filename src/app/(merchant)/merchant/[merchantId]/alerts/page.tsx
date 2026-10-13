import { merchantParam } from "../merchant";
import { alertsView } from "@/surfaces/views";
import { Alerts } from "@/ui/merchant/alerts";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function AlertsPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const v = alertsView(a, merchantId);
  return (
    <PageShell killSwitch={v.merchant.killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Cases", href: `/merchant/${merchantId}/cases` }, { label: "Alerts" }]} />
      <Alerts merchant={v.merchant} alerts={v.alerts} />
    </PageShell>
  );
}

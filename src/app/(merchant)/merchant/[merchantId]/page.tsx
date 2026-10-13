import { merchantParam } from "./merchant";
import { merchantStats } from "@/surfaces/stats";
import { approvalCards, inboxView, merchantView } from "@/surfaces/views";
import { Home } from "@/ui/home/home";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";
import { PageShell } from "@/ui/merchant/page-shell";
import { createRepository } from "@/db/repository";
import { dashboardView, readState, watchedWidgetPreviews } from "@/surfaces/dashboard";
import { chaseCard, emiCard } from "@/surfaces/grow";

export default async function HomePage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const merchant = createRepository(a.db).merchants.get(merchantId)!;
  const name = merchant.name;
  const top = inboxView(a, merchantId).tabs[0].rows[0];
  const card = approvalCards(a, merchantId).at(-1) ?? null;
  const customDashboard = dashboardView(a, merchantId);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}/cases` }, { label: "Home" }]} />
      <Home merchantId={merchantId} merchantName={name} stats={merchantStats(a, merchantId)} card={card} topCase={top ? { id: top.id, name: top.name, amount: top.amount } : null}
        extras={{ emi: emiCard(a, merchantId), chase: chaseCard(a, merchantId), rayOn: merchant.ray_on, dashboardSet: readState(a, merchantId, "dash.setup") !== null, dashboardWidgets: watchedWidgetPreviews(customDashboard.widgets) }}
      />
    </PageShell>
  );
}

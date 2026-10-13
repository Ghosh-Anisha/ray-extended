import { merchantParam } from "../merchant";
import { dashboardView } from "@/surfaces/dashboard";
import { merchantView } from "@/surfaces/views";
import { Dashboard } from "@/ui/dashboard/dashboard";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function DashboardPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "My dashboard" }]} />
      <div>
        <h1 className="page-title">My dashboard</h1>
        <p className="page-sub">Your numbers, with what each one means.</p>
      </div>
      <Dashboard view={dashboardView(a, merchantId)} merchantId={merchantId} />
    </PageShell>
  );
}

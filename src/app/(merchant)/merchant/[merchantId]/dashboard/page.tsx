import { merchantParam } from "../merchant";
import { merchantView } from "@/surfaces/views";
import { PageShell } from "@/ui/merchant/page-shell";
import { Soon } from "@/ui/home/soon";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function DashboardPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "My dashboard" }]} />
      <Soon
        title="My dashboard"
        line="Your own numbers, built from three questions: sales, success rate, refunds and disputes. The builder arrives in the next build."
        action={{ label: "Back to Home", href: `/merchant/${merchantId}` }}
      />
    </PageShell>
  );
}

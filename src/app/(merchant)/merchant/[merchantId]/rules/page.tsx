import { merchantParam } from "../merchant";
import { rulesView } from "@/ask/rules-view";
import { PageShell } from "@/ui/merchant/page-shell";
import { Rules } from "@/ui/merchant/rules";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function RulesPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const view = rulesView(a, merchantId);
  return (
    <PageShell killSwitch={view.settings.merchant.killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Rules" }]} />
      <Rules view={view} />
    </PageShell>
  );
}

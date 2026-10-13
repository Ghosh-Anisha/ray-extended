import { merchantParam } from "../merchant";
import { playbookView } from "@/surfaces/views";
import { PageShell } from "@/ui/merchant/page-shell";
import { Playbook } from "@/ui/merchant/playbook";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function RulesPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const p = playbookView(a, merchantId);
  return (
    <PageShell killSwitch={p.merchant.killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Rules" }]} />
      <Playbook p={p} />
    </PageShell>
  );
}

import { merchantParam } from "../merchant";
import { Dues } from "@/ui/merchant/dues";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";
import { merchantView } from "@/surfaces/views";

export default async function DuesPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Dues" }]} />
      <Dues merchantId={merchantId} />
    </PageShell>
  );
}

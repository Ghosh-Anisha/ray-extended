import { merchantParam } from "../merchant";
import { morningList } from "@/flows/collect/morning";
import { MorningListView } from "@/flows/collect/morning-list";
import { merchantView } from "@/surfaces/views";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function CollectPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Cases", href: `/merchant/${merchantId}/cases` }, { label: "Invoice overdue" }]} />
      <MorningListView list={morningList(a, merchantId)} />
    </PageShell>
  );
}

import { merchantParam } from "./merchant";
import { merchantStats } from "@/surfaces/stats";
import { merchantView } from "@/surfaces/views";
import { Home } from "@/ui/home/home";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";
import { PageShell } from "@/ui/merchant/page-shell";
import { createRepository } from "@/db/repository";

export default async function HomePage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const name = createRepository(a.db).merchants.get(merchantId)!.name;
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}/cases` }, { label: "Home" }]} />
      <Home merchantId={merchantId} merchantName={name} stats={merchantStats(a, merchantId)} />
    </PageShell>
  );
}

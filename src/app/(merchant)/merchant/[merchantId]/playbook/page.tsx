import { merchantParam } from "../merchant";
import { playbookView } from "@/surfaces/views";
import { PageShell } from "@/ui/merchant/page-shell";
import { Playbook } from "@/ui/merchant/playbook";

export default async function PlaybookPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const p = playbookView(a, merchantId);
  return (
    <PageShell killSwitch={p.merchant.killSwitch !== null}>
      <Playbook p={p} />
    </PageShell>
  );
}

import { merchantParam } from "./merchant";
import { inboxView, merchantView } from "@/surfaces/views";
import { Inbox } from "@/ui/merchant/inbox";
import { PageShell } from "@/ui/merchant/page-shell";

export default async function CasesPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null}>
      <Inbox merchantId={merchantId} inbox={inboxView(a, merchantId)} />
    </PageShell>
  );
}

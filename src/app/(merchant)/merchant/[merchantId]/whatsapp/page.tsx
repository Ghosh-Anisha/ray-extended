import { merchantParam } from "../merchant";
import { voiceSamples } from "@/surfaces/sims";
import { approvalCards, digestView, merchantView } from "@/surfaces/views";
import { PageShell } from "@/ui/merchant/page-shell";
import { WhatsAppThread } from "@/ui/merchant/whatsapp";

export default async function WhatsAppPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const m = merchantView(a, merchantId);
  return (
    <PageShell killSwitch={m.killSwitch !== null}>
      <WhatsAppThread cards={approvalCards(a, merchantId)} digest={digestView(a, merchantId)} merchantId={merchantId} killSwitch={m.killSwitch !== null} voiceSamples={voiceSamples("merchant")} voiceLive={a.voice.live} />
    </PageShell>
  );
}

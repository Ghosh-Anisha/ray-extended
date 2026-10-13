import { merchantParam } from "../merchant";
import { voiceSamples } from "@/surfaces/sims";
import { approvalCards, digestView, merchantView } from "@/surfaces/views";
import { allCalls } from "@/surfaces/calls";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";
import { WhatsAppThread } from "@/ui/merchant/whatsapp";
import { NudgeBar } from "@/ui/nudge";

export default async function WhatsAppPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const m = merchantView(a, merchantId);
  return (
    <PageShell killSwitch={m.killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Channels" }, { label: "RAY on WhatsApp" }]} />
      <WhatsAppThread cards={approvalCards(a, merchantId)} digest={digestView(a, merchantId)} merchantId={merchantId} killSwitch={m.killSwitch !== null} voiceSamples={voiceSamples("merchant")} voiceLive={a.voice.live} calls={allCalls(a).slice(0, 1)} />
      <NudgeBar text="Rahul's duplicate charge is waiting for your tap." action={{ label: "Open cases", href: `/merchant/${merchantId}/cases` }} />
    </PageShell>
  );
}

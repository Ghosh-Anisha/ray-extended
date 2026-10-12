import { merchantParam } from "../merchant";
import { digestView, merchantView } from "@/surfaces/views";
import { Digest } from "@/ui/merchant/digest";
import { PageShell } from "@/ui/merchant/page-shell";

export default async function DigestPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null}>
      <Digest d={digestView(a, merchantId)} merchantId={merchantId} />
    </PageShell>
  );
}

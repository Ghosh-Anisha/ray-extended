import { merchantParam } from "../merchant";
import { merchantView } from "@/surfaces/views";
import { PageShell } from "@/ui/merchant/page-shell";
import { Soon } from "@/ui/home/soon";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function AskPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Ask RAY" }]} />
      <Soon
        title="Ask RAY"
        line="Ask about any payment, case or rule, and tell RAY how to handle things. Chat arrives in the next build."
        action={{ label: "Open cases", href: `/merchant/${merchantId}/cases` }}
      />
    </PageShell>
  );
}

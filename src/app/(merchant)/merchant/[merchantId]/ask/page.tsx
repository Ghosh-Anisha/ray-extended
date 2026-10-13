import { merchantParam } from "../merchant";
import { rulesView } from "@/ask/rules-view";
import { merchantView } from "@/surfaces/views";
import { AskPage } from "@/ui/ask/ask-page";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function Page({ params, searchParams }: { params: Promise<{ merchantId: string }>; searchParams: Promise<{ q?: string | string[] }> }) {
  const { a, merchantId } = await merchantParam(params);
  const q = (await searchParams).q;
  // The nudge is one line, so it names the shortest suggestion.
  const suggested = rulesView(a, merchantId).suggested.find((r) => !r.detail) ?? null;
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Ask RAY" }]} />
      <AskPage merchantId={merchantId} initialQuery={(Array.isArray(q) ? q[0] : q)?.slice(0, 400) ?? ""} suggestion={suggested?.sentence ?? null} />
    </PageShell>
  );
}

import { merchantParam } from "../merchant";
import type { Moment } from "@/db/schema";
import { MOMENT_LABEL } from "@/surfaces/words";
import { inboxView, merchantView } from "@/surfaces/views";
import { Inbox } from "@/ui/merchant/inbox";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function CasesPage({ params, searchParams }: { params: Promise<{ merchantId: string }>; searchParams: Promise<{ moment?: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const { moment } = await searchParams;
  const filter = moment && moment in MOMENT_LABEL ? (moment as Moment) : null;
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null}>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Cases" }]} />
      <Inbox merchantId={merchantId} inbox={inboxView(a, merchantId, filter)} filter={filter ? { label: MOMENT_LABEL[filter], clearHref: `/merchant/${merchantId}/cases` } : null} />
    </PageShell>
  );
}

import { merchantParam } from "../merchant";
import type { Moment } from "@/db/schema";
import { INBOX_TABS, MOMENT_LABEL, type InboxTab } from "@/surfaces/words";
import { inboxView, merchantView } from "@/surfaces/views";
import { Inbox } from "@/ui/merchant/inbox";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function CasesPage({ params, searchParams }: { params: Promise<{ merchantId: string }>; searchParams: Promise<{ moment?: string; tab?: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const { moment, tab } = await searchParams;
  const initialMoment = moment && moment in MOMENT_LABEL ? (moment as Moment) : null;
  const initialTab = INBOX_TABS.find((t) => t.key === tab)?.key as InboxTab | undefined;
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
      <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}` }, { label: "Cases" }]} />
      <Inbox merchantId={merchantId} inbox={inboxView(a, merchantId)} initialTab={initialTab} initialMoment={initialMoment} />
    </PageShell>
  );
}

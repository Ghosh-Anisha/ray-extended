import { notFound } from "next/navigation";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { caseView } from "@/surfaces/views";
import { CasePage } from "@/ui/merchant/case-page";
import { PageShell } from "@/ui/merchant/page-shell";
import { caseRef } from "@/surfaces/refs";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function CaseRoute({ params, searchParams }: { params: Promise<{ merchantId: string; caseId: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const { merchantId, caseId } = await params;
  const query = await searchParams;
  const returnTo = query.returnTo?.startsWith(`/merchant/${merchantId}/cases`) && !query.returnTo.startsWith("//") ? query.returnTo : undefined;
  const a = getAdapters();
  const kase = createRepository(a.db).cases.get(caseId);
  if (!kase || kase.merchant_id !== merchantId) notFound();
  const v = caseView(a, caseId);
  return (
    <PageShell killSwitch={v.merchant.killSwitch !== null}>
      <Breadcrumbs
        trail={[
          { label: "Agentic Dashboard", href: `/merchant/${merchantId}` },
          { label: "Cases", href: `/merchant/${merchantId}/cases` },
          { label: `#${caseRef(a, caseId)}` },
        ]}
      />
      <CasePage v={v} returnTo={returnTo} />
    </PageShell>
  );
}

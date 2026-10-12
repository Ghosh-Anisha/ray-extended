import { notFound } from "next/navigation";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { caseView } from "@/surfaces/views";
import { CasePage } from "@/ui/merchant/case-page";
import { PageShell } from "@/ui/merchant/page-shell";

export default async function CaseRoute({ params }: { params: Promise<{ merchantId: string; caseId: string }> }) {
  const { merchantId, caseId } = await params;
  const a = getAdapters();
  const kase = createRepository(a.db).cases.get(caseId);
  if (!kase || kase.merchant_id !== merchantId) notFound();
  const v = caseView(a, caseId);
  return (
    <PageShell killSwitch={v.merchant.killSwitch !== null}>
      <CasePage v={v} />
    </PageShell>
  );
}

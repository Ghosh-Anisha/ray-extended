import Link from "next/link";
import { merchantParam } from "../merchant";
import { merchantView } from "@/surfaces/views";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

// Placeholder until the guided demo (docs/ui-rebuild.md section 6) is built.
export default async function DemoPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  return (
    <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
      <Breadcrumbs trail={[{ label: "Home", href: `/merchant/${merchantId}` }, { label: "Guided demo" }]} />
      <div className="panel stack" style={{ maxWidth: 560 }}>
        <h1 className="page-title">The guided demo is coming soon</h1>
        <p className="muted">It will walk you through one day at Leafy Bakes. Until then, open the biggest case and see what RAY found.</p>
        <div className="row">
          <Link className="btn primary" href={`/merchant/${merchantId}/cases`}>
            Review cases
          </Link>
          <Link className="btn secondary" href={`/merchant/${merchantId}`}>
            Back to Home
          </Link>
        </div>
      </div>
    </PageShell>
  );
}

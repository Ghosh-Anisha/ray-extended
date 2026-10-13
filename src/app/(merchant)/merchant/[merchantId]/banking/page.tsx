import Link from "next/link";
import { merchantParam } from "../merchant";
import { morningList } from "@/flows/collect/morning";
import { createRepository } from "@/db/repository";
import { merchantView } from "@/surfaces/views";
import { PageShell } from "@/ui/merchant/page-shell";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function BankingPage({ params }: { params: Promise<{ merchantId: string }> }) {
  const { a, merchantId } = await merchantParam(params);
  const merchant = createRepository(a.db).merchants.get(merchantId)!;
  const collect = morningList(a, merchantId);
  return <PageShell killSwitch={merchantView(a, merchantId).killSwitch !== null} wide>
    <Breadcrumbs trail={[{ label: "Agentic Dashboard", href: `/merchant/${merchantId}/cases` }, { label: "Banking+" }]} />
    <div><h1 className="page-title">Banking+</h1><p className="page-sub">A simulated merchant finance workflow preview, not an account or connected banking service.</p></div>
    <div className="banner promise">All balances, credits and payment rails in this prototype are seeded examples. No bank, payout, lending or bill-pay integration is connected; no money can move here. Seeded path flag: {merchant.banking_plus ? "on in demo data only" : "off in demo data"}.</div>
    <section className="grid-2">
      <article className="panel stack"><div className="row"><h2 style={{ margin: 0 }}>Incoming business payments</h2><span className="chip simulated">Simulated</span></div><p>Preview how invoice requests, buyer replies and seeded bank-credit examples could be brought into one review queue.</p><strong>{collect.rows.length} demo buyer rows</strong><Link className="btn secondary" href={`/merchant/${merchantId}/collect`}>Start Collect workflow</Link><Link className="btn tertiary" href={`/merchant/${merchantId}/dues`}>Compare incoming requests and dues</Link></article>
      <article className="panel stack"><h2 style={{ margin: 0 }}>Why this could matter</h2><div><strong>For the merchant:</strong> fewer manual follow-ups and clearer invoice-to-credit reconciliation, if the relevant data and rails are connected.</div><div><strong>For Razorpay:</strong> a potential product relationship through merchant adoption and retention. This demo has no verified pricing, take rate, adoption, or revenue data, so it shows no revenue estimate.</div><span className="chip neutral">Preview only · no live eligibility or offer</span></article>
    </section>
    <section className="panel stack"><h2 style={{ margin: 0 }}>What would need to be connected</h2><ul><li>Merchant-authorized account or settlement data</li><li>Verified invoice, buyer and payment matching</li><li>Explicit product terms and merchant approval before any consequential action</li></ul><p className="muted">This fictional workflow demonstrates a product concept only. The merchant flag says whether a demo path is seeded; it does not establish real eligibility.</p></section>
  </PageShell>;
}

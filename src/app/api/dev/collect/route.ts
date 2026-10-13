// Dev panel, Collect: a Banking+ credit lands (Simulated), a seeded credit
// is handed in, or Subscriptions hands an unpaid B2B renewal over. Each
// goes through handleEvent.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { bankCreditArrives, collectHandoff, creditEvent } from "@/flows/collect/run";
import { handle } from "../handle";

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("credit"), merchantId: z.string().min(1), rupees: z.number().positive(), remark: z.string().trim().min(1).max(140), utr: z.string().trim().min(6).max(22) }),
  z.object({ action: z.literal("seeded_credit"), merchantId: z.string().min(1), creditId: z.string().min(1) }),
  z.object({ action: z.literal("handoff"), merchantId: z.string().min(1), invoiceId: z.string().optional(), subscriptionId: z.string().optional(), subInvoiceId: z.string().optional() }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const x = input.parse(await req.json());
    const engine = getEngine();
    const a = getAdapters();
    const r =
      x.action === "credit"
        ? await bankCreditArrives(engine, a, x.merchantId, { amount: Math.round(x.rupees * 100), remark: x.remark, utr: x.utr })
        : x.action === "seeded_credit"
          ? await creditEvent(engine, a, x.merchantId, x.creditId)
          : await collectHandoff(engine, a, x.merchantId, { invoice_id: x.invoiceId || undefined, subscription_id: x.subscriptionId || undefined, sub_invoice_id: x.subInvoiceId || undefined });
    return { outcome: r.outcome, caseId: "caseId" in r ? r.caseId : null };
  });
}

// Whose side: the investigate job's bounded loop (read tools only, step cap
// 6, evidence on every finding) over Razorpay's records, the webhook log,
// plugin reports, the store order and its history, and the store settings.
// Random ids are aliased so the same case asks the same question every run.
import type { Adapters } from "@/adapters";
import type { Payment } from "@/adapters/razorpay";
import type { Ai } from "@/ai";
import type { CaseEvidence } from "@/ai/jobs/investigate";
import type { EngineContext, Finding } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { formatMoney } from "@/guards";
import { createReadTools, type ReadToolRunner } from "@/tools";
import { idAliases } from "../shared/stable-ids";

// The causes this moment knows, and whose side each is on.
export const CAUSES = {
  plugin_dropped_capture: { side: "razorpay", razorpayPlugin: true, merchant: "Razorpay's plugin got the payment and dropped it. The evidence points to Razorpay's plugin; compensation terms are not confirmed." },
  site_down: { side: "merchant", razorpayPlugin: false, merchant: "Your site was down when the payment came in, so the order didn't update." },
  webhook_disabled: { side: "merchant", razorpayPlugin: false, merchant: "Payment updates are turned off in your plugin settings, so your site never heard about the payment." },
  wrong_settings: { side: "merchant", razorpayPlugin: false, merchant: "Your plugin's secret doesn't match your Razorpay account, so your site turned the payment update away." },
  auto_cancelled: { side: "merchant", razorpayPlugin: false, merchant: "Your store cancelled the order for time before the payment arrived." },
  order_missing: { side: "merchant", razorpayPlugin: false, merchant: "Your store has no order for this payment." },
} as const;
export type Cause = keyof typeof CAUSES;
export const isCause = (c: string | null): c is Cause => !!c && c in CAUSES;

export type Diagnosis = {
  findings: Finding[];
  cause: string | null;
  side: "razorpay" | "merchant" | "customer_or_bank" | null;
  confidence: "sure" | "likely" | "unsure";
  razorpayPlugin: boolean;
  steps: number;
};

function evidenceOf(ctx: EngineContext, kase: Case): CaseEvidence[] {
  return ctx.repo.caseEvents
    .listByCase(kase.id)
    .filter((e) => (e.type === "webhook" || e.type === "message_in") && e.evidence_ref)
    .map((e) => {
      const p = e.payload;
      if (e.type === "message_in") return { id: e.evidence_ref!, type: "message_in", summary: `Customer wrote: ${String(p.body ?? "")}` };
      if (p.source === "store") return { id: e.evidence_ref!, type: "store", summary: `Store connector: order ${String(p.order_number ?? "")} is still pending while Razorpay has a captured payment for it` };
      const d = (p.delivery ?? {}) as { http_status?: number | null };
      return { id: e.evidence_ref!, type: "webhook", summary: `${String(p.event)} delivered to the store, answer ${d.http_status ?? "none (not sent)"}` };
    });
}

export async function diagnose(ctx: EngineContext, a: Adapters, ai: Ai, kase: Case, p: Payment, storeOrder: string | null): Promise<Diagnosis> {
  const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
  const ids = idAliases();
  const real = createReadTools(a, kase.merchant_id);
  const tools: ReadToolRunner = async (tool, id) => ids.hide(await real(tool, id === null ? null : ids.show(id)));
  const req = ids.hide({
    case: {
      moment: "paid_no_order",
      merchant: merchant.name,
      amount: formatMoney(p.amount, p.currency),
      payment_id: p.id,
      razorpay_order_id: p.order_id,
      store_order: storeOrder,
      causes: Object.keys(CAUSES),
    },
    evidence: evidenceOf(ctx, kase),
  });
  const out = await ai.investigate(req, tools, { caseId: kase.id });
  const findings = ids.show(out.findings);
  const known = isCause(out.cause) ? CAUSES[out.cause] : null;
  // A cause outside the known list, or a side that disagrees with it, is
  // never Sure.
  let confidence = out.confidence;
  if (!known && confidence === "sure") confidence = "likely";
  if (known && out.side && out.side !== known.side && confidence === "sure") confidence = "likely";
  return {
    findings,
    cause: out.cause,
    side: known?.side ?? out.side,
    confidence,
    razorpayPlugin: known?.razorpayPlugin ?? false,
    steps: out.steps,
  };
}

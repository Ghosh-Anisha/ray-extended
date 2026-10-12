// The one place Collect asks the model: reading a bank credit's remark or a
// buyer's remittance advice into who paid, which invoices and how much
// (the understand job, with this prompt). Code then checks every invoice
// and amount against the buyer's open invoices and the credit (match.ts).
// Nothing the model returns can move money by itself.
import { z } from "zod";
import { createAi } from "@/ai";
import { confidence, numbersIn } from "@/ai/jobs/shared";
import { CONFIDENCE, UNTRUSTED, type Prompt } from "@/ai/prompts/prompt";
import { runJob } from "@/ai/runner";
import type { AiContext, AiResult, JobSpec } from "@/ai/types";
import type { EngineContext } from "@/engine/specialist";

export const READ_KINDS = ["bank_remark", "remittance_advice"] as const;
export type ReadKind = (typeof READ_KINDS)[number];

export const remittanceOutput = z.object({
  // The payer's name as written, or null.
  payer_name: z.string().nullable(),
  // Invoice numbers as written ("PR/26-27/2405", "INV 2405", "2405").
  invoice_refs: z.array(z.string()),
  // What the advice says each invoice gets, in rupees as written.
  allocations: z.array(z.object({ invoice_ref: z.string(), amount: z.number().positive() })),
  tds_mentioned: z.boolean(),
  confidence,
});
export type RemittanceOutput = z.infer<typeof remittanceOutput>;
export type RemittanceInput = { task: "collect_remittance"; kind: ReadKind; text: string };

export const remittancePrompt: Prompt = {
  version: "collect-remittance.v1",
  system: `You read one short piece of text about a B2B payment to a small Indian manufacturer: either the remark on a bank credit (NEFT, RTGS, IMPS) or a remittance advice email from the buyer.

Return:
- payer_name: the paying business or person as written in the text, or null.
- invoice_refs: every invoice number written in the text, copied exactly.
- allocations: only when the text says how much goes to which invoice: the invoice number as written and the rupee amount as a number. Empty otherwise.
- tds_mentioned: true if the text mentions TDS or tax deducted.
- confidence.

Copy only what is written. Never add an invoice or amount that isn't in the text. You do not match payments; code does that against the merchant's own records.
${UNTRUSTED}
${CONFIDENCE}`,
};

const digits = (s: string) => s.replace(/\D/g, "");

export const remittanceSpec: JobSpec<RemittanceInput, RemittanceOutput> = {
  job: "understand",
  schema: remittanceOutput,
  prompt: remittancePrompt,
  fallback: () => ({ payer_name: null, invoice_refs: [], allocations: [], tds_mentioned: false, confidence: "unsure" }),
  // Nothing may be invented: every name, invoice and amount is in the text.
  guard(out, { text }) {
    const problems: string[] = [];
    const lower = text.toLowerCase();
    const textDigits = digits(text);
    if (out.payer_name && !lower.includes(out.payer_name.toLowerCase())) problems.push("payer_name is not in the text");
    for (const ref of [...out.invoice_refs, ...out.allocations.map((a) => a.invoice_ref)]) {
      if (!digits(ref) || !textDigits.includes(digits(ref))) problems.push(`invoice ${ref} is not in the text`);
    }
    const nums = numbersIn(text);
    for (const a of out.allocations) if (!nums.has(String(a.amount))) problems.push(`amount ${a.amount} is not in the text`);
    return problems;
  },
};

export type RemittanceReader = (ctx: EngineContext, kind: ReadKind, text: string, caseId: string | null) => Promise<AiResult<RemittanceOutput>>;

export function defaultReader(aiCtx?: (ctx: EngineContext) => AiContext): RemittanceReader {
  return (ctx, kind, text, caseId) => {
    const c = aiCtx ? aiCtx(ctx) : aiContextOf(ctx);
    return runJob(c, remittanceSpec, { task: "collect_remittance", kind, text }, { caseId });
  };
}

// The same AI context the rest of the app uses (AI_MODE, fixtures dir).
function aiContextOf(ctx: EngineContext): AiContext {
  return createAi({ repo: ctx.repo }).ctx;
}

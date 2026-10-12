// learn: merchant edits and choices -> at most one proposed rule. It is
// always "proposed"; it applies only after the merchant approves it.
import { z } from "zod";
import type { Moment } from "@/db/schema";
import { learnPrompt } from "../prompts";
import { runJob } from "../runner";
import type { AiContext, AiResult, CallMeta, JobSpec } from "../types";
import { confidence } from "./shared";

export const learnOutput = z.object({
  rule: z
    .object({
      text: z.string(),
      when: z.object({
        max_amount: z.number().nullable(),
        in_stock: z.boolean().nullable(),
        customer_confirmed: z.boolean().nullable(),
      }),
      then: z.string(),
    })
    .nullable(),
  evidence: z.array(z.string()),
  confidence,
});
export type LearnOutput = z.infer<typeof learnOutput>;

export type LearnInput = {
  moment: Moment;
  approval_limit_rupees: number;
  choices: { id: string; text: string }[];
};

export const learnSpec: JobSpec<LearnInput, LearnOutput> = {
  job: "learn",
  schema: learnOutput,
  prompt: learnPrompt,
  fallback: () => ({ rule: null, evidence: [], confidence: "unsure" }),
  guard(out, input) {
    const problems: string[] = [];
    const ids = new Set(input.choices.map((c) => c.id));
    for (const e of out.evidence) if (!ids.has(e)) problems.push(`evidence ${e} is not one of the choices`);
    if (out.rule && out.evidence.length === 0) problems.push("a rule needs the choices it comes from");
    const max = out.rule?.when.max_amount;
    if (max != null && max > input.approval_limit_rupees) problems.push("rule is above the merchant's approval limit");
    return problems;
  },
};

export type ProposedRule = NonNullable<LearnOutput["rule"]> & { moment: Moment; status: "proposed"; evidence: string[] };

export async function learn(
  ctx: AiContext,
  input: LearnInput,
  meta?: CallMeta,
): Promise<AiResult<LearnOutput> & { proposal: ProposedRule | null }> {
  const r = await runJob(ctx, learnSpec, input, meta);
  const rule = r.source === "fallback" || r.output.confidence === "unsure" ? null : r.output.rule;
  return { ...r, proposal: rule ? { ...rule, moment: input.moment, status: "proposed", evidence: r.output.evidence } : null };
}

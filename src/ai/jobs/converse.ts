// converse: a thread with two candidate payments -> the one question that
// separates them, or the read of the customer's answer. Every turn re-runs
// the code match; the model's reading never picks the payment.
import { z } from "zod";
import { conversePrompt } from "../prompts";
import { runJob } from "../runner";
import type { AiContext, AiResult, CallMeta, JobSpec } from "../types";
import { confidence } from "./shared";

export const converseOutput = z.object({
  kind: z.enum(["question", "read"]),
  question: z.string().nullable(),
  read: z.object({ amount: z.number().nullable(), utr_last4: z.string().nullable(), rough_time: z.string().nullable() }).nullable(),
  points_to: z.string().nullable(),
  confidence,
});
export type ConverseOutput = z.infer<typeof converseOutput>;

export type Candidate = { id: string; amount: number; time: string; utr_last4: string | null };
export type ConverseInput = {
  thread: { from: "customer" | "business"; text: string }[];
  candidates: Candidate[];
};

// What the code matcher says (rule 3). A near-match is never acted on.
export type CodeMatch = { status: "matched"; paymentId: string } | { status: "ambiguous"; candidateIds: string[] } | { status: "none" };
export type Rematch = (read: ConverseOutput["read"]) => CodeMatch | Promise<CodeMatch>;

export const converseSpec: JobSpec<ConverseInput, ConverseOutput> = {
  job: "converse",
  schema: converseOutput,
  prompt: conversePrompt,
  fallback: () => ({ kind: "read", question: null, read: null, points_to: null, confidence: "unsure" }),
  guard(out, input) {
    const problems: string[] = [];
    const lastFromCustomer = input.thread.at(-1)?.from === "customer";
    if (out.kind === "question" && !out.question) problems.push("a question turn needs a question");
    if (out.kind === "read" && !lastFromCustomer) problems.push("there is no customer answer to read");
    if (out.points_to != null && !input.candidates.some((c) => c.id === out.points_to)) problems.push(`${out.points_to} is not a candidate`);
    return problems;
  },
};

export async function converse(
  ctx: AiContext,
  input: ConverseInput,
  rematch: Rematch,
  meta?: CallMeta,
): Promise<AiResult<ConverseOutput> & { match: CodeMatch; agrees: boolean }> {
  const r = await runJob(ctx, converseSpec, input, meta);
  const match = await rematch(r.output.read);
  const agrees = match.status === "matched" ? r.output.points_to === match.paymentId : r.output.points_to == null;
  return { ...r, match, agrees };
}

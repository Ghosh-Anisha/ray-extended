// write: facts + tone + language -> a draft (or a developer brief). Code
// checks every draft: every number is in the facts, no em dash, no banned
// words outside the developer brief, and no link in a first message to a
// customer. The facts are built by code from the case data, display-ready.
import { z } from "zod";
import { bannedWordsIn, hasEmDash, hasLink, ungroundedNumbers } from "../grounding";
import { writePrompt } from "../prompts";
import { runJob } from "../runner";
import type { AiContext, CallMeta, JobSpec } from "../types";
import { confidence } from "./shared";

export const AUDIENCES = ["merchant", "customer", "buyer", "developer"] as const;

export const writeOutput = z.object({ draft: z.string().nullable(), confidence });
export type WriteOutput = z.infer<typeof writeOutput>;

export type WriteInput = {
  audience: (typeof AUDIENCES)[number];
  // e.g. merchant_card, customer_first, customer_update, buyer_gentle, developer_brief.
  kind: string;
  first_customer_message: boolean;
  facts: Record<string, unknown>;
  tone: string;
  language: string;
};

export function draftProblems(draft: string, input: Pick<WriteInput, "audience" | "first_customer_message" | "facts">): string[] {
  const problems: string[] = [];
  const stray = ungroundedNumbers(draft, input.facts);
  if (stray.length) problems.push(`numbers not in the case: ${stray.join(", ")}`);
  if (hasEmDash(draft)) problems.push("has an em dash");
  if (input.audience !== "developer") {
    const banned = bannedWordsIn(draft);
    if (banned.length) problems.push(`banned words: ${banned.join(", ")}`);
  }
  if (input.first_customer_message && hasLink(draft.replace(/\S+@\S+/g, ""))) problems.push("first message to a customer has a link");
  return problems;
}

export const writeSpec: JobSpec<WriteInput, WriteOutput> = {
  job: "write",
  schema: writeOutput,
  prompt: writePrompt,
  fallback: () => ({ draft: null, confidence: "unsure" }),
  guard(out, input) {
    if (out.draft == null) return out.confidence === "unsure" ? [] : ["no draft but not unsure"];
    return draftProblems(out.draft, input);
  },
};

export function write(ctx: AiContext, input: WriteInput, meta?: CallMeta) {
  return runJob(ctx, writeSpec, input, meta);
}

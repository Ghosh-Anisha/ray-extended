// verify: a reply -> arrived, not arrived or unclear. Silence never goes to
// the model: no reply stays unconfirmed. Only a confirmed arrival counts.
import { z } from "zod";
import { verifyPrompt } from "../prompts";
import { canAct, runJob } from "../runner";
import { fixtureKey } from "../key";
import type { AiContext, AiResult, CallMeta, JobSpec } from "../types";
import { confidence } from "./shared";

export const verifyOutput = z.object({ status: z.enum(["arrived", "not_arrived", "unclear"]), confidence });
export type VerifyOutput = z.infer<typeof verifyOutput>;
export type VerifyInput = { reply: string };

export const verifySpec: JobSpec<VerifyInput, VerifyOutput> = {
  job: "verify",
  schema: verifyOutput,
  prompt: verifyPrompt,
  fallback: () => ({ status: "unclear", confidence: "unsure" }),
};

export async function verify(
  ctx: AiContext,
  reply: string | null,
  meta?: CallMeta,
): Promise<AiResult<VerifyOutput> & { confirmed: boolean }> {
  if (reply == null || reply.trim() === "") {
    // Silence: answered in code, never confirmed.
    return { output: { status: "unclear", confidence: "unsure" }, source: "fallback", key: fixtureKey("verify", null), confirmed: false };
  }
  const r = await runJob(ctx, verifySpec, { reply }, meta);
  return { ...r, confirmed: canAct(r) && r.output.status === "arrived" };
}

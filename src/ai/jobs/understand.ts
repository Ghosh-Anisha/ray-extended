// understand: message, screenshot text or voice note transcript -> what it
// says. A transcript goes in exactly like text: the model never sees where
// the words came from. Matching stays in code.
import { z } from "zod";
import { runJob } from "../runner";
import { understandPrompt } from "../prompts";
import type { AiContext, CallMeta, JobSpec } from "../types";
import { confidence, numbersIn } from "./shared";

export const INTENTS = [
  "paid_no_order",
  "refund_or_cancel",
  "payment_failed_abroad",
  "subscription",
  "dispute",
  "invoice",
  "other",
] as const;

export const DISPUTE_REPLIES = ["agrees_to_withdraw", "complaint", "other"] as const;

export const understandOutput = z.object({
  amount: z.number().nullable(),
  rough_time: z.string().nullable(),
  utr: z.string().nullable(),
  payment_id: z.string().nullable(),
  intent: z.enum(INTENTS),
  language: z.string(),
  mood: z.enum(["calm", "worried", "angry"]),
  legal_or_chargeback_words: z.array(z.string()),
  // Step 10: a reply to the business about a dispute. Optional, so earlier
  // fixtures stay valid.
  dispute_reply: z.enum(DISPUTE_REPLIES).nullable().optional(),
  confidence,
});
export type UnderstandOutput = z.infer<typeof understandOutput>;

export type UnderstandInput = { text: string };
export type UnderstandRequest = UnderstandInput & { source?: "text" | "screenshot" | "voice_note" };

export const understandSpec: JobSpec<UnderstandInput, UnderstandOutput> = {
  job: "understand",
  schema: understandOutput,
  prompt: understandPrompt,
  fallback: () => ({
    amount: null,
    rough_time: null,
    utr: null,
    payment_id: null,
    intent: "other",
    language: "en",
    mood: "calm",
    legal_or_chargeback_words: [],
    confidence: "unsure",
  }),
  // Nothing extracted may be invented: it has to be in the message.
  guard(out, { text }) {
    const problems: string[] = [];
    const lower = text.toLowerCase();
    if (out.amount != null && !numbersIn(text).has(String(out.amount))) problems.push(`amount ${out.amount} is not in the message`);
    if (out.utr != null && !text.replace(/\s/g, "").includes(out.utr)) problems.push("utr is not in the message");
    if (out.payment_id != null && !text.includes(out.payment_id)) problems.push("payment_id is not in the message");
    for (const w of out.legal_or_chargeback_words) {
      if (!lower.includes(w.toLowerCase())) problems.push(`"${w}" is not in the message`);
    }
    return problems;
  },
};

export function understand(ctx: AiContext, req: UnderstandRequest, meta?: CallMeta) {
  return runJob(ctx, understandSpec, { text: req.text }, meta);
}

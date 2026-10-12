// decide: case + findings + playbook + memory -> one proposal. Code checks
// it: only this moment's options, Unsure can only ask or escalate, and a
// rule id must be an approved rule for this moment. The merchant still taps.
import { z } from "zod";
import type { Finding } from "@/engine/specialist";
import type { Moment } from "@/db/schema";
import { decidePrompt } from "../prompts";
import { runJob } from "../runner";
import type { AiContext, CallMeta, Confidence, JobSpec } from "../types";
import { confidence } from "./shared";

// The shared four plus each moment's own. Moment steps may refine these.
export const DECIDE_OPTIONS = {
  paid_no_order: ["fulfil", "refund", "ask", "escalate"],
  international: ["send_payment_link", "refund", "ask", "escalate"],
  subscription: ["send_update_link", "pause_subscription", "cancel_subscription", "ask", "escalate"],
  chargeback: ["contest_dispute", "accept_dispute", "refund", "ask", "escalate"],
  collect: ["send_reminder", "propose_payment_plan", "ask", "escalate"],
} as const satisfies Record<Moment, readonly string[]>;

const ALL_OPTIONS = [...new Set(Object.values(DECIDE_OPTIONS).flat())] as [string, ...string[]];
export const NO_MONEY_OPTIONS = ["ask", "escalate"] as const;

export const decideOutput = z.object({
  proposal: z.enum(ALL_OPTIONS),
  reason: z.string(),
  rule_id: z.string().nullable(),
  confidence,
});
export type DecideOutput = z.infer<typeof decideOutput>;

export type PlaybookRule = { id: string; moment: Moment; text: string; status: "proposed" | "approved" | "off" };

export type DecideInput = {
  moment: Moment;
  case: Record<string, unknown> & { confidence: Confidence };
  findings: Finding[];
  playbook: PlaybookRule[];
  memory: string[];
  options: readonly string[];
};

export const decideSpec: JobSpec<DecideInput, DecideOutput> = {
  job: "decide",
  schema: decideOutput,
  prompt: decidePrompt,
  fallback: () => ({ proposal: "escalate", reason: "I'm not sure what's right here, so it's your call.", rule_id: null, confidence: "unsure" }),
  guard(out, input) {
    const problems: string[] = [];
    if (!input.options.includes(out.proposal)) problems.push(`${out.proposal} is not an option for ${input.moment}`);
    const unsure = out.confidence === "unsure" || input.case.confidence === "unsure";
    const noMoney = (NO_MONEY_OPTIONS as readonly string[]).includes(out.proposal);
    if (unsure && !noMoney) problems.push("an Unsure case can only ask or escalate");
    if (out.rule_id != null) {
      const rule = input.playbook.find((r) => r.id === out.rule_id);
      if (!rule || rule.status !== "approved" || rule.moment !== input.moment) problems.push(`${out.rule_id} is not an approved rule`);
    }
    return problems;
  },
};

export function decide(ctx: AiContext, input: Omit<DecideInput, "options">, meta?: CallMeta) {
  return runJob(ctx, decideSpec, { ...input, options: DECIDE_OPTIONS[input.moment] }, meta);
}

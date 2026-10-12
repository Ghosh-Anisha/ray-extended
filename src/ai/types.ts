import type { z } from "zod";
import type { Repository } from "@/db/repository";
import { CONFIDENCES } from "@/db/schema";
import type { ModelClient } from "./client";
import type { Prompt } from "./prompts/prompt";

export const JOBS = ["understand", "investigate", "decide", "converse", "write", "verify", "learn"] as const;
export type JobName = (typeof JOBS)[number];

export const AI_RUN_MODES = ["replay", "live", "record"] as const;
export type AiRunMode = (typeof AI_RUN_MODES)[number];

export type Confidence = (typeof CONFIDENCES)[number];

export const FIXTURE_LABELS = ["recorded in Claude Code", "recorded live"] as const;
export type FixtureLabel = (typeof FIXTURE_LABELS)[number];

// Why a call fell back to the Unsure answer.
export type FallbackReason = "replay_miss" | "invalid_output" | "guard_failed" | "live_error";

export type AiResult<O> = {
  output: O;
  source: "replay" | "live" | "fallback";
  fallbackReason?: FallbackReason;
  problems?: string[];
  // Shown in the UI next to anything a replayed answer produced.
  label?: FixtureLabel;
  key: string;
};

export type AiContext = {
  repo: Repository;
  mode: AiRunMode;
  fixturesDir: string;
  // Needed for live and record only.
  client?: ModelClient;
};

export type CallMeta = { caseId?: string | null; names?: string[] };

// What every job hands the runner: its output schema, prompt, the Unsure
// answer for when anything goes wrong, and the code guard.
export type JobSpec<I, O extends { confidence: Confidence }> = {
  job: JobName;
  schema: z.ZodType<O>;
  prompt: Prompt;
  fallback(input: I): O;
  // Returns the problems found; any problem rejects the output.
  guard?(output: O, input: I): string[];
};

// The AI layer: seven jobs, each a typed function with a zod schema and a
// code guard. AI_MODE picks replay (default, fixtures), live or record.
import { createRepository, type Repository } from "@/db/repository";
import type { Db } from "@/db/client";
import { anthropicClient, type ModelClient } from "./client";
import { DEFAULT_FIXTURES_DIR } from "./fixtures";
import { converse, type ConverseInput, type Rematch } from "./jobs/converse";
import { decide, type DecideInput } from "./jobs/decide";
import { investigate, type InvestigateRequest } from "./jobs/investigate";
import { learn, type LearnInput } from "./jobs/learn";
import { understand, type UnderstandRequest } from "./jobs/understand";
import { verify } from "./jobs/verify";
import { write, type WriteInput } from "./jobs/write";
import type { ReadToolRunner } from "./read-tools";
import { AI_RUN_MODES, type AiContext, type AiRunMode, type CallMeta } from "./types";

export { canAct } from "./runner";
export type { AiContext, AiResult, AiRunMode } from "./types";

export function aiModeFrom(env: Record<string, string | undefined> = process.env): AiRunMode {
  const mode = env.AI_MODE ?? "replay";
  if (!(AI_RUN_MODES as readonly string[]).includes(mode)) throw new Error(`AI_MODE must be one of ${AI_RUN_MODES.join(", ")}`);
  return mode as AiRunMode;
}

export function createAi(opts: {
  db?: Db;
  repo?: Repository;
  mode?: AiRunMode;
  fixturesDir?: string;
  client?: ModelClient;
}) {
  const repo = opts.repo ?? createRepository(opts.db!);
  const mode = opts.mode ?? aiModeFrom();
  const ctx: AiContext = {
    repo,
    mode,
    fixturesDir: opts.fixturesDir ?? process.env.AI_FIXTURES_DIR ?? DEFAULT_FIXTURES_DIR,
    client: opts.client ?? (mode === "replay" ? undefined : anthropicClient()),
  };
  return {
    ctx,
    understand: (req: UnderstandRequest, meta?: CallMeta) => understand(ctx, req, meta),
    investigate: (req: InvestigateRequest, tools: ReadToolRunner, meta?: CallMeta) => investigate(ctx, req, tools, meta),
    decide: (input: Omit<DecideInput, "options">, meta?: CallMeta) => decide(ctx, input, meta),
    converse: (input: ConverseInput, rematch: Rematch, meta?: CallMeta) => converse(ctx, input, rematch, meta),
    write: (input: WriteInput, meta?: CallMeta) => write(ctx, input, meta),
    verify: (reply: string | null, meta?: CallMeta) => verify(ctx, reply, meta),
    learn: (input: LearnInput, meta?: CallMeta) => learn(ctx, input, meta),
  };
}
export type Ai = ReturnType<typeof createAi>;

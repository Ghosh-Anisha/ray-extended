// Every AI call goes through runJob. It serves a fixture (replay) or calls
// the model (live, record), checks the output against the job's schema and
// code guard, and logs the call in ai_calls. Anything that goes wrong gives
// the job's Unsure fallback, which can never act. Invalid output never
// reaches a flow.
import { performance } from "node:perf_hooks";
import { newId } from "@/adapters/ids";
import { readFixture, writeFixture } from "./fixtures";
import { fixtureKey } from "./key";
import { createMasker } from "./mask";
import { MODEL_FOR } from "./models";
import type { AiContext, AiResult, CallMeta, Confidence, FallbackReason, JobSpec } from "./types";

export async function runJob<I, O extends { confidence: Confidence }>(
  ctx: AiContext,
  spec: JobSpec<I, O>,
  input: I,
  meta: CallMeta = {},
): Promise<AiResult<O>> {
  const started = performance.now();
  const key = fixtureKey(spec.job, input);
  const model = ctx.mode === "replay" ? null : MODEL_FOR[spec.job];

  const log = (output: unknown, valid: boolean, usedModel: string | null) =>
    ctx.repo.aiCalls.insert({
      id: newId("ai"),
      case_id: meta.caseId ?? null,
      job: spec.job,
      // record is a live call that also saves a fixture.
      mode: ctx.mode === "replay" ? "replay" : "live",
      model: usedModel,
      input_hash: key,
      output,
      valid,
      ms: Math.round(performance.now() - started),
    });

  const fallback = (reason: FallbackReason, problems: string[], usedModel: string | null): AiResult<O> => {
    const output = spec.fallback(input);
    if (reason === "replay_miss") console.warn(`[ai] replay miss: ${spec.job} ${key}`);
    log({ fallback: reason, problems, output }, false, usedModel);
    return { output, source: "fallback", fallbackReason: reason, problems, key };
  };

  const check = (raw: unknown): { output?: O; reason?: FallbackReason; problems: string[] } => {
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) {
      return { reason: "invalid_output", problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    }
    const problems = spec.guard?.(parsed.data, input) ?? [];
    if (problems.length) return { reason: "guard_failed", problems };
    return { output: parsed.data, problems: [] };
  };

  if (ctx.mode === "replay") {
    const { fixture, problem } = readFixture(ctx.fixturesDir, spec.job, key);
    if (problem) return fallback("invalid_output", [problem], null);
    if (!fixture) return fallback("replay_miss", [], null);
    const checked = check(fixture.output);
    if (!checked.output) return fallback(checked.reason!, checked.problems, fixture.model);
    log(checked.output, true, fixture.model);
    return { output: checked.output, source: "replay", label: fixture.label, key };
  }

  if (!ctx.client) throw new Error(`AI_MODE=${ctx.mode} needs a model client`);
  const masker = createMasker(meta.names);
  let raw: unknown;
  try {
    raw = masker.unmask(
      await ctx.client.complete({ model: model!, system: spec.prompt.system, input: masker.mask(input), schema: spec.schema }),
    );
  } catch (err) {
    return fallback("live_error", [err instanceof Error ? err.message : String(err)], model);
  }
  const checked = check(raw);
  if (!checked.output) return fallback(checked.reason!, checked.problems, model);
  if (ctx.mode === "record") {
    writeFixture(ctx.fixturesDir, {
      job: spec.job,
      label: "recorded live",
      promptVersion: spec.prompt.version,
      model,
      input,
      output: checked.output,
    });
  }
  log(checked.output, true, model);
  return { output: checked.output, source: "live", key };
}

// Nothing acts on Unsure, and nothing acts on a fallback.
export const canAct = (r: AiResult<{ confidence: Confidence }>) =>
  r.source !== "fallback" && r.output.confidence !== "unsure";

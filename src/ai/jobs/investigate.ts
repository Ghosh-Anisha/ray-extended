// investigate: a bounded loop. Each step the model reads what it has and
// names the next read tool, or stops. Code runs the tool, refuses anything
// that isn't a read tool, caps the loop at 6 steps and stops as soon as two
// findings agree on a cause. Every finding cites evidence it was given.
import { z } from "zod";
import type { Finding } from "@/engine/specialist";
import { SIDES, SITUATIONS } from "@/db/schema";
import { investigatePrompt } from "../prompts";
import { isReadTool, READ_TOOLS, type ReadToolResult, type ReadToolRunner } from "../read-tools";
import { runJob } from "../runner";
import type { AiContext, CallMeta, Confidence, JobSpec } from "../types";
import { confidence } from "./shared";

export const INVESTIGATE_STEP_CAP = 6;

export const investigateStepOutput = z.object({
  findings: z.array(z.object({ text: z.string(), evidence_id: z.string(), supports: z.string() })),
  next: z.object({ tool: z.string(), id: z.string().nullable() }).nullable(),
  cause: z.string().nullable(),
  side: z.enum(SIDES).nullable(),
  situation: z.enum(SITUATIONS).nullable(),
  confidence,
});
export type InvestigateStepOutput = z.infer<typeof investigateStepOutput>;

export type CaseEvidence = { id: string; type: string; summary: string };
export type HistoryEntry = { tool: string; id: string | null; result: ReadToolResult | { error: string } };

export type InvestigateRequest = {
  case: Record<string, unknown>;
  // What is already on the case: case_events ids and source record ids.
  evidence: CaseEvidence[];
};
export type InvestigateStepInput = InvestigateRequest & { tools: readonly string[]; history: HistoryEntry[] };

const seenEvidence = (input: InvestigateStepInput) => {
  const ids = new Set(input.evidence.map((e) => e.id));
  for (const h of input.history) if ("evidence_ids" in h.result) h.result.evidence_ids.forEach((id) => ids.add(id));
  return ids;
};

export const investigateStepSpec: JobSpec<InvestigateStepInput, InvestigateStepOutput> = {
  job: "investigate",
  schema: investigateStepOutput,
  prompt: investigatePrompt,
  fallback: () => ({ findings: [], next: null, cause: null, side: null, situation: null, confidence: "unsure" }),
  guard(out, input) {
    const seen = seenEvidence(input);
    return out.findings.filter((f) => !seen.has(f.evidence_id)).map((f) => `finding cites unknown evidence ${f.evidence_id}`);
  },
};

export type StoppedBy = "agreed" | "done" | "step_cap" | "refused_tool" | "fallback";

export type InvestigateOutcome = {
  cause: string | null;
  side: InvestigateStepOutput["side"];
  situation: InvestigateStepOutput["situation"];
  confidence: Confidence;
  findings: Finding[];
  steps: number;
  stoppedBy: StoppedBy;
  refusedTool?: string;
  // Fixture labels of replayed steps, for the UI.
  labels: string[];
};

// Two findings from different evidence supporting the same cause.
function agreedCause(findings: InvestigateStepOutput["findings"]): string | null {
  const bySupport = new Map<string, Set<string>>();
  for (const f of findings) {
    const set = bySupport.get(f.supports) ?? new Set();
    set.add(f.evidence_id);
    bySupport.set(f.supports, set);
    if (set.size >= 2) return f.supports;
  }
  return null;
}

export async function investigate(
  ctx: AiContext,
  req: InvestigateRequest,
  tools: ReadToolRunner,
  meta?: CallMeta,
): Promise<InvestigateOutcome> {
  const history: HistoryEntry[] = [];
  const found: InvestigateStepOutput["findings"] = [];
  const labels = new Set<string>();
  let last: InvestigateStepOutput = investigateStepSpec.fallback(undefined as never);
  let stoppedBy: StoppedBy = "step_cap";
  let refusedTool: string | undefined;
  let steps = 0;

  while (steps < INVESTIGATE_STEP_CAP) {
    steps++;
    const r = await runJob(ctx, investigateStepSpec, { ...req, tools: READ_TOOLS, history: [...history] }, meta);
    if (r.label) labels.add(r.label);
    if (r.source === "fallback") {
      stoppedBy = "fallback";
      break;
    }
    last = r.output;
    found.push(...r.output.findings);
    if (agreedCause(found)) {
      stoppedBy = "agreed";
      break;
    }
    if (!r.output.next) {
      stoppedBy = "done";
      break;
    }
    if (!isReadTool(r.output.next.tool)) {
      stoppedBy = "refused_tool";
      refusedTool = r.output.next.tool;
      break;
    }
    // The last step's tool would never be read, so it isn't run.
    if (steps === INVESTIGATE_STEP_CAP) break;
    const { tool, id } = r.output.next;
    let result: HistoryEntry["result"];
    try {
      result = await tools(tool, id);
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    history.push({ tool, id, result });
  }

  let conf: Confidence = last.confidence;
  if (stoppedBy === "fallback" || stoppedBy === "refused_tool" || found.length === 0) conf = "unsure";
  else if (stoppedBy === "step_cap" && conf === "sure") conf = "likely";

  return {
    cause: last.cause,
    side: last.side,
    situation: last.situation,
    confidence: conf,
    findings: found.map((f) => ({ text: f.text, evidenceRef: f.evidence_id })),
    steps,
    stoppedBy,
    refusedTool,
    labels: [...labels],
  };
}

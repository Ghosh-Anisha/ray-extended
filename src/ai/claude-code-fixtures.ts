// Fixtures written by Claude Code acting as the model (no API key needed).
// Sources live in fixtures/ai/sources/claude-code.json; this turns each into
// a keyed replay fixture labelled "recorded in Claude Code", refusing any
// output its job's schema or guard would reject.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_FIXTURES_DIR, writeFixture } from "./fixtures";
import { converseSpec } from "./jobs/converse";
import { decideSpec } from "./jobs/decide";
import { investigateStepSpec, type HistoryEntry, type InvestigateRequest, type InvestigateStepInput } from "./jobs/investigate";
import { learnSpec } from "./jobs/learn";
import { understandSpec } from "./jobs/understand";
import { verifySpec } from "./jobs/verify";
import { writeSpec } from "./jobs/write";
import { READ_TOOLS, type ReadToolResult } from "./read-tools";
import { JOBS, type JobSpec } from "./types";

export const CLAUDE_CODE_SOURCES = path.join(DEFAULT_FIXTURES_DIR, "sources", "claude-code.json");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SPECS: Record<string, JobSpec<any, any>> = {
  understand: understandSpec,
  investigate: investigateStepSpec,
  decide: decideSpec,
  converse: converseSpec,
  write: writeSpec,
  verify: verifySpec,
  learn: learnSpec,
};

const step = z.object({ output: z.unknown(), result: z.object({ evidence_ids: z.array(z.string()), data: z.unknown() }).optional() });
const entry = z.union([
  z.object({ name: z.string(), job: z.literal("investigate"), request: z.custom<InvestigateRequest>(), steps: z.array(step) }),
  z.object({ name: z.string(), job: z.enum(JOBS).exclude(["investigate"]), input: z.unknown(), output: z.unknown() }),
]);
const sources = z.object({ label: z.literal("recorded in Claude Code"), entries: z.array(entry) });
export type ClaudeCodeEntry = z.infer<typeof entry>;

export function loadClaudeCodeSources(file = CLAUDE_CODE_SOURCES): ClaudeCodeEntry[] {
  return sources.parse(JSON.parse(fs.readFileSync(file, "utf8"))).entries;
}

// The per-step inputs and outputs the investigate loop will ask for.
export function investigateCalls(e: Extract<ClaudeCodeEntry, { job: "investigate" }>) {
  const history: HistoryEntry[] = [];
  return e.steps.map((s) => {
    const input: InvestigateStepInput = { ...e.request, tools: READ_TOOLS, history: [...history] };
    const out = s.output as { next: { tool: string; id: string | null } | null };
    if (s.result && out.next) history.push({ tool: out.next.tool, id: out.next.id, result: s.result as ReadToolResult });
    return { input, output: s.output };
  });
}

export function writeClaudeCodeFixtures(dir = DEFAULT_FIXTURES_DIR, file = CLAUDE_CODE_SOURCES): string[] {
  const written: string[] = [];
  for (const e of loadClaudeCodeSources(file)) {
    const spec = SPECS[e.job];
    const calls = e.job === "investigate" ? investigateCalls(e) : [{ input: e.input, output: e.output }];
    for (const c of calls) {
      const parsed = spec.schema.safeParse(c.output);
      if (!parsed.success) throw new Error(`${e.name}: output does not match the ${e.job} schema`);
      const problems = spec.guard?.(parsed.data, c.input) ?? [];
      if (problems.length) throw new Error(`${e.name}: ${problems.join("; ")}`);
      written.push(
        writeFixture(dir, {
          job: e.job,
          label: "recorded in Claude Code",
          promptVersion: spec.prompt.version,
          model: null,
          input: c.input,
          output: parsed.data,
        }),
      );
    }
  }
  return written;
}

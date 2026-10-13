// Collect's replay fixtures, written by Claude Code acting as the model (no
// API key needed). Sources: fixtures/ai/sources/collect.json. Each becomes a
// keyed fixture labelled "recorded in Claude Code": understand (the
// remittance reader, the default) or write (Change redrafts). Any output
// the job's schema or guard would reject is refused.
// Run: npx tsx src/flows/collect/fixtures.ts
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DEFAULT_FIXTURES_DIR, writeFixture } from "@/ai/fixtures";
import { writeSpec } from "@/ai/jobs/write";
import type { JobSpec } from "@/ai/types";
import { remittanceSpec } from "./advice";

export const COLLECT_SOURCES = path.join(DEFAULT_FIXTURES_DIR, "sources", "collect.json");

const sources = z.object({
  label: z.literal("recorded in Claude Code"),
  entries: z.array(z.object({ name: z.string(), job: z.enum(["understand", "write"]).default("understand"), input: z.unknown(), output: z.unknown() })),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const specFor = (job: "understand" | "write"): JobSpec<any, any> => (job === "write" ? writeSpec : remittanceSpec);

export const loadCollectSources = (file = COLLECT_SOURCES) => sources.parse(JSON.parse(fs.readFileSync(file, "utf8"))).entries;

export function writeCollectFixtures(dir = DEFAULT_FIXTURES_DIR, file = COLLECT_SOURCES): string[] {
  return loadCollectSources(file).map((e) => {
    const spec = specFor(e.job);
    const parsed = spec.schema.safeParse(e.output);
    if (!parsed.success) throw new Error(`${e.name}: output does not match the ${e.job} schema`);
    const problems = spec.guard?.(parsed.data, e.input) ?? [];
    if (problems.length) throw new Error(`${e.name}: ${problems.join("; ")}`);
    return writeFixture(dir, { job: e.job, label: "recorded in Claude Code", promptVersion: spec.prompt.version, model: null, input: e.input, output: parsed.data });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const written = writeCollectFixtures();
  console.log(`Wrote ${written.length} Collect fixtures labelled "recorded in Claude Code".`);
}

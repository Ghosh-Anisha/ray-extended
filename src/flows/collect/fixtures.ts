// Collect's replay fixtures, written by Claude Code acting as the model (no
// API key needed). Sources: fixtures/ai/sources/collect.json. Each becomes a
// keyed understand fixture labelled "recorded in Claude Code", and any
// output the remittance reader's schema or guard would reject is refused.
// Run: npx tsx src/flows/collect/fixtures.ts
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DEFAULT_FIXTURES_DIR, writeFixture } from "@/ai/fixtures";
import { remittanceSpec, type RemittanceInput } from "./advice";

export const COLLECT_SOURCES = path.join(DEFAULT_FIXTURES_DIR, "sources", "collect.json");

const sources = z.object({
  label: z.literal("recorded in Claude Code"),
  entries: z.array(z.object({ name: z.string(), input: z.custom<RemittanceInput>(), output: z.unknown() })),
});

export const loadCollectSources = (file = COLLECT_SOURCES) => sources.parse(JSON.parse(fs.readFileSync(file, "utf8"))).entries;

export function writeCollectFixtures(dir = DEFAULT_FIXTURES_DIR, file = COLLECT_SOURCES): string[] {
  return loadCollectSources(file).map((e) => {
    const parsed = remittanceSpec.schema.safeParse(e.output);
    if (!parsed.success) throw new Error(`${e.name}: output does not match the remittance schema`);
    const problems = remittanceSpec.guard?.(parsed.data, e.input) ?? [];
    if (problems.length) throw new Error(`${e.name}: ${problems.join("; ")}`);
    return writeFixture(dir, { job: "understand", label: "recorded in Claude Code", promptVersion: remittanceSpec.prompt.version, model: null, input: e.input, output: parsed.data });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const written = writeCollectFixtures();
  console.log(`Wrote ${written.length} Collect fixtures labelled "recorded in Claude Code".`);
}

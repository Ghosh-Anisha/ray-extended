// Recording only. Turns write-job fixtures captured from the scenario tests
// (run with RAY_AI_BOOK=src/flows/international/book.ts) into this flow's
// Claude Code sources file, then writes the keyed replay fixtures from it,
// labelled "recorded in Claude Code". Usage:
//   npx tsx src/flows/international/record-fixtures.ts <capture dir>
import fs from "node:fs";
import path from "node:path";
import { writeClaudeCodeFixtures } from "@/ai/claude-code-fixtures";
import { DEFAULT_FIXTURES_DIR } from "@/ai/fixtures";

export const INTERNATIONAL_SOURCES = path.join(DEFAULT_FIXTURES_DIR, "sources", "international.json");

const dir = process.argv[2];
if (!dir) throw new Error("Give the capture directory");
const writeDir = path.join(dir, "write");
const entries = fs
  .readdirSync(writeDir)
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(writeDir, f), "utf8")))
  .map((f) => ({ name: `international ${f.input.kind} ${f.key}`, job: "write", input: f.input, output: f.output }))
  .sort((x, y) => x.name.localeCompare(y.name));
fs.writeFileSync(INTERNATIONAL_SOURCES, JSON.stringify({ label: "recorded in Claude Code", entries }, null, 2) + "\n");
const written = writeClaudeCodeFixtures(DEFAULT_FIXTURES_DIR, INTERNATIONAL_SOURCES);
console.log(`Wrote ${written.length} fixtures labelled "recorded in Claude Code" from ${entries.length} entries.`);

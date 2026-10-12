// Writes Step 9's AI fixtures (recorded in Claude Code) into fixtures/ai/
// from fixtures/ai/sources/subscriptions.json, refusing any output its job's
// schema or guard would reject. Run: npx tsx src/flows/subscriptions/fixtures.ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeClaudeCodeFixtures } from "@/ai/claude-code-fixtures";
import { DEFAULT_FIXTURES_DIR } from "@/ai/fixtures";

export const SUBSCRIPTION_SOURCES = path.join(DEFAULT_FIXTURES_DIR, "sources", "subscriptions.json");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const written = writeClaudeCodeFixtures(DEFAULT_FIXTURES_DIR, SUBSCRIPTION_SOURCES);
  console.log(`Wrote ${written.length} Step 9 fixtures labelled "recorded in Claude Code".`);
}

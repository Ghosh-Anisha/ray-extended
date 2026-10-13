// npx tsx src/flows/chargebacks/record-fixtures.ts: writes this step's
// Claude Code fixtures (fixtures.claude-code.json) into fixtures/ai/, each
// labelled "recorded in Claude Code" and checked against its job's schema
// and guard first.
import path from "node:path";
import { writeClaudeCodeFixtures } from "@/ai/claude-code-fixtures";
import { DEFAULT_FIXTURES_DIR } from "@/ai/fixtures";

export const CHARGEBACK_SOURCES = path.join(process.cwd(), "src", "flows", "chargebacks", "fixtures.claude-code.json");

const written = writeClaudeCodeFixtures(DEFAULT_FIXTURES_DIR, CHARGEBACK_SOURCES);
console.log(`Wrote ${written.length} chargeback fixtures labelled "recorded in Claude Code".`);

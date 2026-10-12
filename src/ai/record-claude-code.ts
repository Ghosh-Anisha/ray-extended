// npm run ai:fixtures: write the Claude Code fixtures into fixtures/ai/.
import { writeClaudeCodeFixtures } from "./claude-code-fixtures";

const written = writeClaudeCodeFixtures();
console.log(`Wrote ${written.length} fixtures labelled "recorded in Claude Code".`);

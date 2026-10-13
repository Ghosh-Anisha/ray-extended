import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  // .claude/ holds Claude Code sessions' own checkouts (worktrees), not this project's source.
  { ignores: [".next/**", "node_modules/**", "evals/**", "next-env.d.ts", ".claude/**"] },
];

export default config;

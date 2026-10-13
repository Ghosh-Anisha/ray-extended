You are running unattended as one phase of an automatic UI rebuild. Nobody will answer questions, so never stop to ask and never wait for plan approval.

Before you start:
- Read CLAUDE.md and docs/ui-rebuild.md in full.
- Read docs/ui-progress.md (create it if missing) and git log -15. If this phase was started before and stopped, continue from where it stopped; don't redo finished work.

While you work:
- Work directly on the main branch. Never reset, rebase or force-push. Never delete or weaken a test.
- Don't change engine, guard or flow behaviour. UI, seed and speed changes only; anything else must be additive.
- When you'd normally ask, decide using docs/ui-rebuild.md, CLAUDE.md and docs/design-language.md, and write the decision (what, why, alternative) to docs/ui-decisions.md.
- Commit and push after each milestone, and update docs/ui-progress.md with what's done and what's left in this phase.
- Keep usage low: don't re-read large files you've already read; use /compact if the conversation gets long.

Before you finish (section 9 of docs/ui-rebuild.md):
- Stop any server already on port 3000, run npm run demo in the background, wait until it answers, take Playwright screenshots of every page at 1440x900 and 390x844 into docs/screenshots/<phase>/, look at them, fix anything empty, broken, slow or off-spec, then stop the server.
- npm test, npm run lint and npm run typecheck must pass.
- Mark the phase DONE in docs/ui-progress.md (a line "PHASE <name>: DONE"), commit and push.

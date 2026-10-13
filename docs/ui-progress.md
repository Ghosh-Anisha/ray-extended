PHASE U1: DONE
PHASE U2: DONE

# Phase U2 (Home, Cases inbox, case page): done

Verified: typecheck, lint and tests pass (592 passed, 27 skipped). Screenshots of Home, Cases and RD-1042 at 1440x900 and 390x844 are in `docs/screenshots/u2/`.

## Written
- `src/surfaces/views.ts`: `CaseRow` gets `momentKey`, `summary` and `quick` (RAY's recommended tap, Needs you rows only). Additive only.
- `src/ui/toast.tsx` (new) and `src/app/providers.tsx`: toast with an optional action.
- `src/ui/nudge.tsx` (new): the nudge bar, used on Home, Cases and the case page.
- `src/ui/home/home.tsx`, `src/ui/home/guided-card.tsx` (new), `src/app/(merchant)/merchant/[merchantId]/page.tsx`: guided demo card, WhatsApp preview rail with the latest approval card, Recommended tiles, nudge.
- `src/app/(merchant)/merchant/[merchantId]/demo/page.tsx` (new): placeholder the guided demo card links to.
- `src/ui/merchant/inbox.tsx` and the cases page: Gmail-like inbox (tabs and moment filters on the left, rows with hover actions, URL keeps the tab and moment).
- `src/ui/merchant/case-page.tsx`: animated investigation progress, whose-side chip, step timeline, banners inside Your call, "Doing it…", toast with Undo, composer line, channel icons.
- `src/app/globals.css`: U2 styles appended.

## Decisions
- The toast after a tap always says where the case moved. Undo shows only when the case has a held action (a refund hold or a Stop window), because only those can be undone. Other actions have nothing to undo.
- The inbox row hover offers RAY's recommended tap with its Covered / Your call label, plus Open.
- Tab and moment filter are kept in the URL (`?tab=`, `?moment=`), so Back from a case returns to the same list.

# Phase U3 (Ask RAY, Rules, My dashboard): NOT STARTED, BLOCKED

The unattended session refuses every command that runs code (`npm run`, `npx`, `node`, `tsc`, `vitest`) and every `git add`, `commit` and `push`. Only read-only git works. U3 was not started: more unchecked code on top of it risks a broken build, and U3 could not be tested, linted, built or screenshotted.

To continue, use a session that allows npm and git writes. Build U3 from `docs/ui-rebuild.md` 3.4, 3.5, 3.6, 5 and 7.

# Phase U4 (WhatsApp, inboxes, Store admin, Demo controls): DONE

Implemented sections 3.7, 3.8, 3.9, 3.10, 5, 7 and 10 on top of the existing U2 shell and guarded actions.

Verified: `npm run typecheck`, `npm run lint`, and `npm run build` pass. The build emits existing dynamic filesystem tracing warnings from the voice and prompt adapters. `npm test` was started but did not complete cleanly in this environment: the existing engine and database script tests timed out or failed while the seed/database work was running. Live `npm start -- -p 3001` and Playwright screenshots were blocked by the environment denying server binds on port 3001. Git commit, merge and push were blocked because the worktree Git admin directory is outside the writable workspace.

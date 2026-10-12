# Step 10: Chargebacks (overnight run)

Branch `step-10-chargebacks`, built unattended. This file is the plan, the
decision log and the list of shared changes. It is updated as the work goes.

## Shared changes (outside src/flows/chargebacks)

All additive. No existing behaviour or existing test changed.

| File | Change | Why |
|---|---|---|
| `src/guards/index.ts` | `GuardedCallContext.holdUntil?: number` (optional). When set and every guard passes, the action is held until then, exactly like the refund hold; Undo (Stop) and release reuse the existing hold code. Without it nothing changes. | The Stop window on the automatic dispute lanes. The UI already shows a held `contest_dispute`/`accept_dispute` as the Stop banner (`src/surfaces/views.ts` holdsOf). |
| `src/adapters/webhooks/index.ts` | Three more Razorpay events in `WEBHOOK_EVENTS`: `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed` (ref `disputeId`, they report the dispute as it is). | The outcome of a dispute reaches the case through `handleEvent`, like every other event. The existing per-event test covers them. |
| `src/engine/index.ts` | One line: `createChargebacksSpecialist()` in the registry. | Registers the flow. |
| `src/db/seed.ts` | One call, `seedChargebacks(db, now)`, plus its import, from `src/db/seed/chargebacks.ts`. | Seed for this step. It only writes the flow's own tables. |
| `src/db/migrations/1000_chargebacks.sql` + one entry in `meta/_journal.json` | Three new tables (below). | Rule 11: everything a case or guard reads lives in the database. |
| `fixtures/ai/investigate/*.json` (6 new), `fixtures/ai/understand/*.json` (1 new) | New replay fixtures, labelled "recorded in Claude Code". | Written from `src/flows/chargebacks/fixtures.claude-code.json` by `npx tsx src/flows/chargebacks/record-fixtures.ts` (reuses `writeClaudeCodeFixtures`; the shared `fixtures/ai/sources/claude-code.json` is untouched, so parallel steps don't collide). |

The new tables are declared in `src/flows/chargebacks/schema.ts`, not in
`src/db/schema.ts`, so the seed test's "covers every table in the schema" and
row-count assertions stay exactly as they are.

## Plan: every rule from Step 10

Files: `src/flows/chargebacks/{index,rules,evidence,lanes,lines,patterns,sim,schema}.ts`,
tests `chargebacks.test.ts` (scenarios, 27) and `rules.test.ts` (unit, 12),
helpers `test-helpers.ts`, `threat-fixture.ts`, fixture source
`fixtures.claude-code.json` and `record-fixtures.ts`.

### Situations (code decides the situation from the dispute record)

| | Situation | What RAY does | Usual lane |
|---|---|---|---|
| A | Customer threatens a chargeback (message with chargeback words, no dispute yet) | Delegates to the paid-no-order Specialist (same case) so it is resolved before a dispute exists; never acts on a rule (always asks). A dispute that later arrives on that payment joins the case and becomes B to E. | Per that flow |
| B | Fraud or unauthorised (reason codes 10.x, 4837, 4863, 4870, 4871, "fraud", "unauthorised") | Reads device and IP, prior orders, delivery address and the Vulcan result (Simulated). Flagged: accept and offer to block the card. Not flagged: ask. Never contacts the cardholder. | Accept if flagged, else Ask |
| C | Not received / not as described / cancelled but charged | Delivery proof, chats, policy; customer outreach (merchant taps); refund if it's the merchant's fault. | Contest if Sure; accept if never shipped; Ask for quality disputes |
| D | Already refunded or duplicate | Refund proof or proof of a single charge. | Contest without asking |
| E | Pre-arbitration or arbitration | Recomputes with the stage fee. | Always Ask |
| F | Repeat pattern | Root cause (statement name, refund policy, one product, courier) and the fix, as an insight. Fix needs a tap (Approve rule). | Insight |

### Decision rule (code, `rules.ts`)

Contest if `odds × amount > (1 − odds) × fee at the next stage`. Stage 1
(chargeback) fee is nil. Pre-arbitration and arbitration use the arbitration
fee: Visa USD 600, Mastercard USD 675, others USD 675 (the higher one), at a
fixed simulated rate of ₹84 per USD. Odds come from the evidence in code,
never from a model. Test: ₹4,000 at Visa arbitration needs over 92% (exactly 92.65%).

### Lanes: contest without asking, accept without asking, ask

Every bound, checked in `lanes.ts` before RAY uses a lane, and again by the
guards when the held action is released:

1. Opt-in: the merchant switches each lane on. A lane is a playbook rule
   (`moment: chargeback`, `rule_json.lane`, `tool`, `types`). RAY proposes both
   lanes (status proposed, off) the first time a merchant gets a chargeback;
   nothing runs until Approve rule.
2. First stage only: `phase === "chargeback"`. Pre-arbitration and arbitration always ask.
3. No new money moves: only when the dispute amount is already deducted (`deducted`).
4. FYI with a Stop window: 2 hours, shorter when the deadline is closer (half
   the time left to RAY's deadline). The action is held (`holdUntil`), the
   case shows "Contesting this dispute in 1 hr 52 min · Stop", and the merchant
   gets the FYI. Stop works until the timer ends (Undo on the held action).
5. Auto-off: one wrong call switches the lane off (rule status `off`) with an
   alert. Wrong call: an automatically contested dispute is lost.
6. Override rule: two merchant overrides (Stop, or taking the case over while
   the lane's action is held) on a type move that type back to Ask.
7. Plus the shared guards: confidence not Unsure, the rule approved for the
   tool, the merchant's approval limit (amount cap), kill switch.

### Deadlines and timers

RAY's deadline = the earlier of Razorpay's `respond_by` and onset + 3 business
days (chargeback), + 2 (pre-arbitration), + 1 (arbitration). Business days are
Monday to Friday, IST.

- `cb_deadline_eve` (24 h before): if still waiting on the merchant, one urgent
  ask (alert) and, if the merchant opted in, the urgent call (`place_call`,
  kind `urgent_merchant`) within calling hours, ending with the decision card
  on WhatsApp. Never a call to the cardholder (guard enforces it too).
- `cb_deadline_final` (4 h before): a strong pack (odds ≥ 65% and the EV rule
  says contest) is submitted only under the contest lane's "at the deadline"
  opt-in with every lane bound; otherwise the pack lapses and the merchant is
  told.
- `cb_stop_window` (end of the Stop window): reads what happened to the held action.
- `cb_weekly` (next Monday 9 AM IST): the weekly pattern insight, once per merchant per week.

### Evidence finder (bounded agent step, `evidence.ts`)

Code gathers the candidates (delivery proof from the store order history,
chats on any case for this customer, past orders, any earlier RAY case on that
payment, refunds and other charges, Simulated fraud signals, an open Buyer
Protection claim on the same payment). The investigate job (read-only tools,
step cap 6, evidence on every finding) reads them and Razorpay's records and
returns findings. The pack's contents, its strength and the odds are computed
in code from the records, so a replay miss only loses the model's wording.

### Filing

Per-merchant filing setting (`cb_settings.filing`):
- `dispute_responder`: Simulated hand-off of the pack; the submit still goes
  through `guardedCall('contest_dispute')` with the same approval.
- `disputes_api`: `attach_dispute_proof` (draft, runs alone) then
  `contest_dispute` (submit) on approval.
- `manual`: RAY prepares the pack for the merchant to upload; nothing is filed.

Draft events are the existing `dispute_draft_*` notes; the case is open first.

### Customer outreach (non-fraud only)

C and D only, never B. A fix or refund offer and a withdraw request, written as
the merchant, with checkable details (amount, date and time, card ending) and
no link. `send_message` kind `dispute_outreach`: the merchant's tap. Email from
the merchant's sending address unless the customer's WhatsApp window is open.

### Other

- "Approved unchanged several times": after 3 approvals of RAY's
  recommendation for one type, RAY proposes a lane rule for that type (Rule
  card, never assumed).
- Counts as saved when the dispute is won or withdrawn.
- Voice: only the opt-in urgent merchant call. Leafy Bakes is seeded opted in.

## Done when (tests)

- Leafy Bakes' three disputes end to end: the duplicate (Sanjay, ₹1,299)
  auto-contests with a Stop window; one "not received" (Deepa, ₹1,850) is
  withdrawn after outreach; one (Meera, ₹6,900) goes to Ask.
- Expected-value rule (₹4,000 at Visa arbitration needs over 92%), deadline
  handling (business days, eve call, final lapse), lane auto-off, override rule.

## Decisions

(what, why, the alternative not taken)

1. **Lanes are playbook rules, proposed at runtime, not seeded.**
   What: the first chargeback a merchant gets makes RAY propose both lanes
   (status proposed). The merchant's Approve rule switches one on. Tests
   switch Leafy's contest lane on with the same `setRuleStatus` the
   playbook screen calls.
   Why: the approval guard only lets an act run on a tap or an approved
   playbook rule id, so a lane has to be one; and the seed test pins the
   exact `playbook_rules` count (8), which "don't change existing tests"
   rules out touching. Proposing on first use is also the honest opt-in.
   Not taken: seeding Leafy's lanes as approved (edits the seed test), or a
   lane approval kind in the guard (changes shared guard behaviour).

2. **The Stop window is a held action (`holdUntil` on `guardedCall`).**
   Why: the refund hold already gives Undo, release-time re-checks (kill
   switch, rule still approved, amount cap) and the Stop banner in the UI.
   Stop is the existing Undo route. Not taken: a flow-only timer that calls
   `contest_dispute` later (the hold would not show, and Stop would need a
   new path).

3. **Bounds checked twice.** `checkLane` checks all of them in the flow
   (opt-in, type, first stage, deducted, Sure, approval limit, time for a
   window, two overrides); the guards check approval, amount cap and kill
   switch again at release. A lane switched off during the window blocks
   the filing (tested).

4. **Wrong call = an automatically contested dispute that was lost.** It
   switches that lane rule to `off` and alerts the merchant. For the accept
   lane there is no outcome that proves it wrong in the prototype (an
   accepted dispute is lost by definition), so it only goes off when the
   merchant switches it off. Not taken: inventing a "that was wrong" tap,
   which the engine's taps don't support outside Needs you.

5. **Override = Stop (Undo of the held lane action) or taking the case
   over while it is held.** Counted from the actions table each time (no
   stored counter); two on a type move that type back to Ask.

6. **RAY's deadline = the earlier of Razorpay's `respond_by` and onset + 3/2/1
   business days (Mon to Fri, IST).** Why: never later than Razorpay's
   date. The seeded respond-by dates (4 to 9 days) are later, so the guide's
   T+3 applies.

7. **The deadline submit is part of the contest lane opt-in.** "A few hours
   before, a strong pack is submitted" would otherwise be money without a
   tap. It runs only under an approved contest lane (proposed text says so,
   `at_deadline: true`), with every lane bound (Sure, within the limit,
   first stage) and still a Stop window. Otherwise the merchant is told and
   the pack lapses. Meera (₹6,900, above the ₹2,000 limit) lapses; tested.

8. **Odds come from code, not the model.** A table in `rules.ts` maps the
   records (delivery confirmed, shipped, refund on file, single charge,
   chats, Buyer Protection claim, Vulcan) to odds and Sure/Likely. The
   investigate job adds findings only. Strong pack = odds ≥ 65%. Not taken:
   model-estimated odds (they would decide money, rule 1).

9. **Fees:** Visa USD 600, Mastercard USD 675, unknown networks the higher
   one, at a fixed simulated ₹84 per USD. Pre-arbitration and arbitration
   both use the arbitration fee; stage 1 is nil. ₹4,000 at Visa
   arbitration needs over 92.6%.

10. **Why Meera asks and Deepa gets outreach first.** Both are "not
    received", shipped by courier, delivery not confirmed (Likely), so
    neither can use the contest lane. Meera's ₹6,900 is above the approval
    limit, so the card leads with the money decision (Contest dispute) and
    keeps outreach as an option. Deepa's ₹1,850 is within the limit and the
    deadline is more than 2 days out, so the card leads with "Send message
    to Deepa" (dispute_outreach, the merchant's tap).

11. **Outreach goes by email** unless the customer's WhatsApp window is
    open: there is no approved WhatsApp template for disputes, and adding
    one would change the shared messaging adapter. Non-fraud (situation C)
    only; never to a cardholder on fraud.

12. **Situation A delegates to the paid-no-order Specialist on the same
    case** (moment chargeback, situation A). The paid-no-order hooks get the
    case with their own situation letter from their notes (their A means
    "authorised, not captured"). A threat never acts on a rule: a decide
    that would act is turned into Needs you. A dispute that later arrives on
    that payment joins the case and becomes B to E; it then asks.

13. **New Razorpay events for outcomes** (`payment.dispute.won/lost/closed`).
    A withdrawal is `closed`. The simulator (`sim.ts settleDispute`) sets
    the dispute's status, then emits the webhook, so outcomes reach the case
    through `handleEvent`. An outcome on a case in Needs you (it lapsed)
    closes through `transition()` from the flow, because the orchestrator's
    investigate path can't set the outcome fields.

14. **Situation F is the weekly insight, not its own case.** A timer on the
    case (next Monday 9 AM IST), once per merchant per week, groups the last
    30 days' disputes by reason, product and unflagged fraud ("statement
    name"). Each pattern is an alert with ₹ at stake and its fix as a
    proposed playbook setting (`tool: none`, so it can never approve an
    action). Leafy's two "not received" give: "2 chargebacks in the last 30
    days say the order never arrived: ₹8,750 at stake."

15. **Fraud signals and Buyer Protection claims are Simulated tables** in
    the flow (`cb_fraud_signals`, `cb_buyer_protection_claims`), declared in
    `src/flows/chargebacks/schema.ts` so the seed test's table list doesn't
    change. Existing `bank_complaint` notes on the payment count as well.
    Meera is seeded with an open claim; it lands in her pack.

16. **Filing path is a per-merchant table (`cb_settings`)**, Leafy on
    the Disputes API. Dispute Responder is a Simulated hand-off note, then
    the same guarded submit; "manual" files nothing and says the pack is
    ready to upload.

17. **"Stop asking for this type"**: after 3 unchanged approvals of RAY's
    recommendation on one type, a proposed lane rule for that type and an
    alert (Rule card). Never applied until Approve rule.

18. **No percentages on merchant screens.** Odds stay in the pack note;
    cards say "the proof is strong" or "thin". A test checks every alert,
    summary, finding and button label for banned words, % and em dashes.

19. **Fixtures**: Claude Code acted as the model for the evidence finder on
    the three seeded disputes and for understanding Rahul's threat. Scenario
    disputes made inside tests miss replay on purpose and fall back
    (Unsure for the model's part only; code findings and odds still apply).

## Not done / left for later

- No dev panel control for dispute outcomes; the new webhook events show in
  the dev panel's list, but `settleDispute` (which also sets the status) is
  only called from tests. Adding a button means touching `src/app`, which
  is outside this step's folder.
- Customer replies on a dispute case are recorded as evidence, not read by
  the understand job (the bank's withdrawal is what closes it).

## Checks run at the end

`git fetch` + rebase on `origin/main` (already up to date), then
`npm test` (372 passed, 27 skipped; 39 of them new in `src/flows/chargebacks`),
`npm run lint` (clean) and `npm run typecheck` (clean).

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
| `src/db/seed.ts` | One line: `seedChargebacks(db, now)` from `src/db/seed/chargebacks.ts`. | Seed for this step. |
| `src/db/migrations/1000_chargebacks.sql` + one entry in `meta/_journal.json` | Three new tables (below). | Rule 11: everything a case or guard reads lives in the database. |

The new tables are declared in `src/flows/chargebacks/schema.ts`, not in
`src/db/schema.ts`, so the seed test's "covers every table in the schema" and
row-count assertions stay exactly as they are.

## Plan: every rule from Step 10

Files: `src/flows/chargebacks/{index,rules,evidence,lanes,lines,patterns,sim,schema,threat}.ts`,
tests `chargebacks.test.ts` (scenarios) and `rules.test.ts` (unit), fixtures
source `src/flows/chargebacks/fixtures.claude-code.json` written to `fixtures/ai/`
by `npm run ai:fixtures:chargebacks`... (see Decisions: fixtures).

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

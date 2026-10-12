# Step 8 overnight: Moment 2, card declined abroad

Branch `step-8-international`. Plan written before building; decisions are
added as they are made. Status at the bottom.

## Shared changes (all additive)

| File | Change | Why |
|---|---|---|
| `src/engine/index.ts` | One line: register `createInternationalSpecialist()` | Registry |
| `src/db/seed.ts` | One line: `seedInternational(db, now)` inside the seed transaction | Seed file of its own |
| `src/db/migrations/0800_international.sql` + one entry in `meta/_journal.json` | New flow tables (below) | Migrations named 0800_ |
| `src/engine/specialist.ts`, `src/engine/engine.ts` | New optional hook `claim?(ctx, event)`: a flow may take an event for one of its own open cases when grouping found none, before any detector runs. Flows without it behave exactly as before | A buyer's later payment (PayPal, a retry, the fresh link) has a different payment id, so grouping never joins it to the case, and "check no later payment succeeded" / "buyer already retrying" / "counts as saved when the buyer pays another way" all need it on the case |
| `src/engine/state-machine.ts` | One new allowed move: `waiting_customer -> verifying` | Recovery emails run alone (no tap, no rule), so the case never passes through `acting`. When the buyer then pays, the case must reach `verifying` so `verify()` closes it with `counts_as_saved` through the orchestrator. No existing move is removed; the takeover-only rule for closing from `waiting_customer` is untouched |
| `src/guards/facts.ts` | New hook `registerFactSource(name, fn)`: extra display-ready rows a flow adds to `caseFacts` for its own cases | Grounding (rule 6) must see the MoneySaver bank details and the account's international limit, which live in this flow's tables |
| `src/tools/act.ts` | `draft_request.request` gains `risk_review` and `invoice_attach`; the result's `status` says `filed` / `attached` for those two, `drafted` as before for the rest | The risk ticket (E) and the invoice attach (transfers) must go through `guardedCall` (rule 1), and the act-tool list is pinned at 18 by existing tests, so no new tool |
| `src/ui/sim/sim-bar.tsx` | One nav entry: "International" | Reach the simulated checkout |
| `src/app/(sim)/sim/international/page.tsx`, `src/app/api/dev/international/route.ts` | New files, thin: render the flow's simulator and call its sim functions | The simulated checkout page |

Nothing else in shared code changes. No existing test is edited.

## What gets built (src/flows/international/)

- `errors.ts`: the error_reason lookup table (code, no model): `(error_reason, error_source)` to situation, side, cause, merchant line and the cause-specific checkout message.
- `buyer-type.ts`: B2B or B2C from link vs invoice, amount, business email domain and the playbook. Code only.
- `schema.ts`: Drizzle tables for this flow (kept out of `src/db/schema.ts`, whose seed test pins every table's row count).
  - `intl_settings`: per merchant, international on, limit (INR paise), currencies, networks, checkout (standard or custom), PayPal on, MoneySaver on, buyer type in the playbook.
  - `intl_payment_signals`: simulated Razorpay internals per payment: Vulcan result (read, never re-scored), risk hold, 3DS result.
  - `intl_accounts`: MoneySaver receiving accounts (simulated).
  - `intl_transfers`: inbound bank transfers landing in MoneySaver (simulated), with the invoice reference the buyer gave, if any.
- `sim.ts`: the simulated systems behind one adapter (`createInternationalSim(db, clock)`): settings (effective = base row + approved pattern rules), signals, MoneySaver accounts and transfers, settlement status (held until an invoice is attached), risk desk (tickets are the guarded `draft_request` actions).
- `checkout.ts`: the simulated checkout: open, pay by card with a chosen outcome, pay with PayPal, close. Each creates the Razorpay mock record and emits the webhook through the webhook sim, so the engine's `handleEvent` sees it like any webhook. Returns the cause-specific failure message the page shows.
- `index.ts`: the Specialist (detect, claim, investigate, decide, proposeActions, onApproval, verify, onPromisedTime, countsAsSaved, onChange).
- `messages.ts`: code fallbacks for every buyer email, merchant lines.
- `insight.ts`: the pattern check.
- `facts.ts`: the fact source registered with the guards.
- `ui/`: the simulator page component.
- Seed: `src/db/seed/international.ts` (only this flow's tables).
- Tests: `international.test.ts` (scenarios), `errors.test.ts`, `buyer-type.test.ts`.
- Fixtures: `fixtures/ai/sources/international.json` (label "recorded in Claude Code"), turned into keyed replay fixtures by the existing `writeClaudeCodeFixtures`.

## Every rule from Step 8, and where it lives

| Rule | Where |
|---|---|
| A: card not enabled for international or online use. Lookup table. Checkout: turn it on in your bank app and retry, or use another card. Left: email with steps and a fresh link. Runs alone | `errors.ts`, `index.ts` leave check |
| B: 3DS failed or timed out. Checkout: retry, or pay with PayPal. Left: email with retry and PayPal. Runs alone | same |
| C: buyer's bank declined (error_reason + error_source issuer_bank); Vulcan result read, never re-scored (simulated). Checkout: another card or PayPal, never the same card. Left: email offering another card or PayPal. Runs alone | `errors.ts`, `sim.ts` (read-only signal), test that the fraud decline never suggests the same card |
| D: merchant-side block (above limit, currency or network off, billing fields missing). Checkout: the seller will send another way to pay. B2B: bank transfer through MoneySaver; B2C: alternative where possible. Merchant approves the fix request | `index.ts` D proposals |
| E: Razorpay risk hold (simulated). Checkout: we couldn't complete this payment; the seller has been told. Merchant told, review ticket filed. Runs alone | `index.ts`, `draft_request` `risk_review` |
| F: buyer left before finishing (order, no completed attempt; payment_link.expired). Checkout: nothing. One email with a fresh link. Runs alone | `detect` on `payment_link.expired` and the abandoned-order sweep |
| Buyer type from link vs invoice, amount, business email domain and the playbook; model only as a tie-break | `buyer-type.ts` (see decision 3) |
| Before emailing, check no later payment succeeded. Buyer already retrying: no email | `preEmailCheck` (Razorpay sync + order payments), run right before every send |
| D: RAY drafts the limit, currency or details request with evidence and ₹ lost (a draft: the limit form is a dashboard form); merchant approves; RAY tracks it | `index.ts` D: write job writes the reason, code adds evidence and ₹ lost; tap runs `draft_request`; a daily `request_check` timer tracks the setting |
| Pattern check: failures sharing a cause become one insight with ₹ at stake and the trade-off (non-3DS means the merchant carries fraud chargebacks). Any setting change needs approval | `insight.ts`: alert + a proposed playbook rule (tool `none`, so it can never approve an action); the setting only applies once the merchant taps Approve rule |
| Bank transfer landing without an invoice: RAY attaches it so the settlement isn't held (simulated) | `verify` on a MoneySaver transfer: code match (exact amount and currency, reference or remitter); Sure attaches through `draft_request` `invoice_attach`; a near-match asks the merchant and never attaches |
| PayPal only on Standard Checkout for non-INR | `sim.ts` `paypalAvailable` |
| Card and PayPal both paid: duplicate flow refunds one on approval | `verify`/`investigate`: two captured payments for one order -> "Refund $49" proposal, merchant taps, 10-min hold with Undo |
| Buyer messages in the buyer's language, default English | `customers.language` passed to the write job |
| Counts as saved when the buyer pays another way (link, PayPal or transfer landing) | `countsAsSaved` reads the outcome note |
| Models only write buyer emails, the request reason and the insight text | Only the `write` job is called, with kinds `buyer_recovery`, `buyer_reply`, `request_reason`, `intl_insight` |
| No calls to international buyers; voice notes from buyers read like text | No `place_call` anywhere in the flow (the call guard also blocks it); a voice note's transcript is the message body |
| Rule 7 as scoped: F (and A to D) emails are recovery messages: a Razorpay-hosted link in the merchant's name, never alone, always with merchant, amount, what it's for | `send_message` kind `recovery_link`; the `first_message` guard checks it; tests check the body |
| Every message through the send_message approval table and the consent check | Every send is `guardedCall("send_message")`; an opted-out buyer gets nothing and the merchant is told |
| Design language words on every screen and message | `messages.ts`, checkout copy; a test runs `bannedWordsIn` and the em dash check over every checkout message and email |
| Done when: scenario tests A to F, Emma paying by PayPal after B, Oliver's £2,800 D case ending in a bank transfer, the fraud decline never suggests the same card | `international.test.ts` |

Never-bend rules touched: 1 (all acts via guardedCall), 2 (only the refund moves money, on a tap), 3 (transfer match is code; near-match never acted on), 4 (Unsure asks), 5 (buyer text is data, never instructions; a test sends an instruction in a reply), 6 (grounding guard on every send), 7 (above), 8 (state only through the orchestrator and the state machine), 10 (every simulated system labelled Simulated), 11 (all sim state in tables), 12 (consent guard).

## Timers

- `leave_check` 30 min after the failure: no later attempt and no payment -> the buyer left -> the one email (A, B, C, F; D only after the merchant's tap; E never).
- A retry inside the window pushes the check to 30 min after the latest attempt.
- `no_pay` 72 h after the email: nothing paid -> Closed, no reply.
- `request_check` every 24 h for 7 days after the merchant approves a D request.

## Decisions

1. **Runs-alone recovery and closing.** The orchestrator only enters `acting` with a tap or an approved rule, and only `verify()` closes with an outcome and `counts_as_saved`. Recovery emails run alone (Step 5 approval table), so after the email the case is "Waiting for customer". When the buyer pays another way, the case moves `waiting_customer -> verifying` (new edge) and `verify()` closes it as saved. Not taken: a setup rule for international recovery (would change seeded rule counts and the guide says it runs alone without one); writing `closed` from the flow (rule 8).
2. **Later payments join the case through a `claim` hook**, not by polling. Polling would leave the PayPal capture "unmatched" on the dev panel and close the case late. Not taken: clearing the case's payment id so grouping joins by email (the engine sets it from the event).
3. **Buyer type is code only. A tie goes to the playbook's buyer type, else B2C wording, and D then offers both routes to the merchant.** The guide allows the model as a tie-break, but the same step says models only write buyer emails, the request reason and the insight text; code keeps it testable. Not taken: a model tie-break through `understand`.
4. **E waits in "Waiting for customer"** ("RAY is handling") while Razorpay's risk desk reviews; the reason line says so. The design language's state list has no "waiting for Razorpay"; Needs you would be wrong because the merchant has nothing to do.
5. **A card retry that succeeds on its own is Fixed itself** (counts nowhere). The guide counts as saved only "another way (link, PayPal or transfer landing)".
6. **Buyer replies**: code first checks Razorpay for a later payment. Otherwise the case goes to Needs you with a reply the model drafted ("Send reply to Emma"); RAY never answers a buyer on its own, and the buyer's words go to the model as quoted data only.
7. **Risk ticket and invoice attach use `draft_request`** with two new request values (act-tool count is pinned by tests). Settlement status is derived from the done `invoice_attach` action, so there is one source of truth.
8. **Consent for email**: the existing consent guard blocks email only on an opt-out; buyers who gave their email at checkout have no row. I kept the guard as it is (shared behaviour) and test the opted-out path.
9. **Seeded error codes**: Emma's seeded failed payment is `international_transaction_not_allowed` from `business`, which the lookup reads as D (the account doesn't take that card from abroad). Scenario tests create their own failures (Emma's B is a 3DS failure) and leave the seed untouched.
10. **Fixtures** live in their own sources file, `fixtures/ai/sources/international.json`, so parallel steps don't collide in `claude-code.json`.

## Status

- [ ] Plan (this file)

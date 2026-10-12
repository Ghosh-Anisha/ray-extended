# Step 9 overnight log: Subscription stopped

Branch `step-9-subscriptions`, built unattended. Plan first, then decisions, then what was run.

## Shared changes (all additive)

Every change outside `src/flows/subscriptions/` and `src/db/seed/subscriptions.ts`. None changes an existing behaviour; each only adds a path that nothing before Step 9 takes.

1. **Engine, `src/engine/events.ts`**: `keys.subscriptionId` (optional). `fromWebhook` sets it from the event's subscription (or the cancelled token's subscription). Payment, refund, dispute and downtime events never carry it.
2. **Engine, `src/engine/grouping.ts`**: an event with a `subscriptionId` key joins the open case that already has an event with the same key. Events without the key take the existing path unchanged.
3. **Engine, `src/engine/specialist.ts` + `orchestrator.ts`**: optional `Decision.alone` and optional `Specialist.onRunAlone` hook. When decide says `alone` and every proposed action runs alone in code (send_message kinds and tools whose approval is "none", checked by a new `runsAlone` export from `src/guards`), the case moves confirmed → acting and the orchestrator calls `onRunAlone` instead of `onApproval`. Without it, the engine had no way to close a "Runs alone" case (A, B, C, F) as saved: acting needed a tap or a rule. Flows that don't set `alone` see no change.
4. **Guards, `src/guards/index.ts`**: new export `runsAlone(tool, args)` (reads the tool's approval need). No existing check changed.
5. **Guards, `src/guards/facts.ts`**: `authorised_at` and `notified_at` format as times, and a subscription's mandates come along with it, so the "didn't authorise" reply can quote the mandate approval and pre-debit notice dates (rule 6). Only subscription records have these fields.
6. **Webhooks sim, `src/adapters/webhooks/index.ts`**: two events, `subscription.activated` (sign-up finished: mandate authorised, first invoice paid, active) and `subscription.charged` (the pending invoice paid: by its link or by the bank retry; a second charge for an already-paid cycle is recorded as a second payment, which is what the duplicate path needs). `subscription.pending` now issues the next cycle's invoice when the subscription has none pending; when one is pending (the only case before Step 9) it does exactly what it did.
7. **Migration `0900_subscriptions`** (+ `schema.ts` columns): `mandates.authorised_at`, `mandates.auth_ref`, `sub_invoices.notified_at` (pre-debit notice), `merchants.sub_call_value_limit` (the value above which RAY may call, playbook), `merchants.sub_pause_days` (how long a pause lasts; Sharma Tutorials: 30, "skip a month"). Columns only, no new table, so the seed test's table list and row counts are untouched.
8. **Seed**: `src/db/seed.ts` gets one line calling `seedSubscriptions(db)` from `src/db/seed/subscriptions.ts`, which only fills the new columns on rows Step 1 already seeds (no new rows; seed counts unchanged).
9. **Registry, `src/engine/index.ts`**: one line registering `createSubscriptionsSpecialist()` (plus its import).
10. **Dev panel**: a new route `src/app/api/dev/subscription-sweep/route.ts` and one "Check … for unfinished sign-ups" button block in `src/app/(sim)/dev/controls.tsx`, inside a Simulated box, calling `handleEvent` through the sweep like the connector sweep does. The new webhook events appear in the existing generic emitter on their own.
11. **Fixtures**: new files only: `fixtures/ai/sources/subscriptions.json` (10 entries, "recorded in Claude Code") and the keyed fixtures it writes under `fixtures/ai/{understand,decide,write}/`. `fixtures/ai/sources/claude-code.json` is untouched, so the shared replay test is unchanged.

No existing test was edited, deleted or weakened. `npm test` passes with the same 27 skips as main (Razorpay test-mode contract tests that need keys).

## Plan: every rule from Step 9

| Rule from the guide | Where |
|---|---|
| A: sign-up started, mandate not authorised after 30 min → one message with a finish-setup link, explaining the failure if known. Runs alone | `sweep.ts` finds `created` subscriptions older than 30 min, `index.ts` situation A |
| B: retries ran out (`subscription.halted`); `subscription.pending` is the early warning | detect: pending opens Likely: checking (dashboard only, RAY waits for Razorpay's retries); halted starts B |
| B no funds: pay the subscription's own pending invoice; bank paused / over the AutoPay limit needs PIN: steps and link; card replaced or expired: card-update steps and link. Runs alone | `lines.ts` variant by the invoice's `error_reason`; link only from `pay_pending_invoice` |
| B never a fresh link and never a charge | B only calls `pay_pending_invoice` (read only) and `send_message`; test asserts no `payment_link` action and no new rzp_links row |
| C: `token.cancelled` → asks once why; payment trouble → set up again; otherwise treat as D. Runs alone | one `question` message; reply read by understand + code reason table |
| D: reads the reason; one matching save offer from the playbook; cancels cleanly if refused; no rule: ask the merchant with 2 or 3 options, act, save the answer as a rule. Runs alone when the playbook covers it | `offers.ts` (reason table, offer matching), proposed rule written on the merchant's pick |
| E: "didn't authorise": pull proof (mandate approval, pre-debit notice), draft the reply, propose a refund if the playbook allows or proof is weak. Merchant decides | evidence pack as findings, write job drafts the reply, `didnt_authorise_reply` needs the tap |
| F: B2B renewal failed → email the billing contact with the invoice and a bank-transfer option; move to Collect if unpaid | email with the pending invoice link; `collect.handoff` event after 7 days unpaid |
| Razorpay's retries and Revenue-Protect stay as they are (simulated) | RAY does nothing on `subscription.pending` except watch |
| One save offer only | `sub_offer_made` note checked before any offer |
| Pause has no end date in the API, so RAY schedules the resume | `resume` timer at pause + `sub_pause_days` |
| No plan change on domestic-card subscriptions | no option or tool changes a plan; test checks the options |
| Channels: email by default, WhatsApp with consent, SMS for short links | `channel.ts`; SMS see decisions |
| One call through place_call to subscribers above the merchant's value limit, with the playbook's save offer; call opt-in and calling hours apply; post-call summary feeds decide | B, 24 h after the link, unpaid: "Call Karan" proposal; call_rules guard; decide reads the summary |
| Duplicate: pays by link and the bank retry also succeeds → duplicate refund on approval | second `subscription.charged` for a paid cycle opens a case with "Refund ₹499" (tap) |
| No response: halts per Razorpay's rules, case closes as lost | `no_response` timer, 7 days → closed, outcome `lost` |
| Sharma Tutorials: pause means skip a month | `sub_pause_days = 30` |
| Counts as saved when the subscription is active again | `countsAsSaved` reads Razorpay's subscription status |
| Rule 7 as scoped: A and B (and C's set-up link, F) are recovery messages: Razorpay-hosted link in the merchant's name, never alone, checkable details | `recovery_link` kind; first_message guard checks it; E reply carries no link |
| Every message through send_message approval table and the consent check | all sends go through `guardedCall("send_message")` |
| "Didn't authorise" reply needs the merchant's tap | kind `didnt_authorise_reply` (required) |
| B2B hand-off only emits an event, no Collect logic | `handoff.ts`: `collect.handoff` note with invoice and buyer, plus a reader for Step 11 |
| Design language words on every screen and message | merchant cards and alerts in `lines.ts`; generic case page renders the cases |

## Decisions

(Each: what, why, the alternative not taken.)

1. **Runs alone needed an engine path.** What: optional `Decision.alone` + `Specialist.onRunAlone`. Why: the state machine only reaches verifying (and so a saved close) through acting, and acting only accepted a tap or a rule; A, B, C and F "run alone" in the guide. The orchestrator checks in code that every proposal runs alone (`runsAlone`), so a flow can't use it to skip a tap. Not taken: a seeded "send recovery links" rule per merchant (the guide says these need no rule), or new state-machine transitions such as waiting_customer → closed (changes the shared table and its tests).
2. **Grouping by subscription.** What: a `subscriptionId` key on events and a same-subscription join. Why: subscription and token webhooks carry no payment, email or phone, so a follow-up (halted after pending, charged after the link) would open a new case. Not taken: putting the subscription id in `paymentId` (breaks the "different payment never joins" rule).
3. **A uses the subscription's own first invoice, not a fresh link.** What: the finish-setup link is the created subscription's first invoice, shared through `pay_pending_invoice`; paying it authorises the AutoPay (`subscription.activated`). Why: same "never a fresh link" safety as B, and no new act tool (the shared tool list is pinned at 18 by a test). Not taken: a new `subscription_auth_link` act tool or `short_url` on the Subscription type.
4. **B variants share the same pending-invoice link.** No funds, needs PIN / bank paused, and card replaced each get their own steps, but every link is the pending invoice's (paying it with the new card updates the card). The "over ₹15,000 needs PIN" wording drops the number, because ₹15,000 isn't case data (rule 6). Not taken: a card-update payment link (a fresh link).
5. **The call needs the merchant's tap.** `place_call`'s `subscription_save` kind is "required" in the shared table, so a day after the link, if still unpaid, above `sub_call_value_limit` and opted in to calls, RAY offers "Call Karan" (calling hours and every call rule are checked by the guard at call time). The post-call summary goes to the decide job (with ids aliased so the fixture key is stable), and its proposal leads the next card. Not taken: calling without a tap (would change the shared call table).
6. **Save offers: pause and another way to pay; no discount.** Razorpay can't put a discount on a live subscription through the API and there's no act tool for one; adding one changes the pinned tool list. Discount is documented as a gap. A plan change is never offered (none on domestic-card subscriptions).
7. **A save-offer rule approves one tool.** The approval guard matches `rule_json.tool` exactly, so a pause rule covers `pause_subscription` only. Under a tap, the pause and its scheduled resume are one proposal (resume is a listed follow-up) and the resume runs alone on the day. Under a rule, RAY schedules the resume and asks "Resume Karan's plan" on the day. A refused offer cancels with the merchant's tap, or alone if they approved a cancel rule. Not taken: rules with no `tool` (they would approve every subscription tool, including refunds).
8. **The merchant's pick becomes a proposed rule.** Any option tapped on a no-rule D card (offer pause, offer another way to pay, cancel) is written as a `proposed` rule with the reason it came from; nothing applies until Approve rule. `other_method` rules also carry `kind: "question"` so they can't approve other messages.
9. **Reasons and yes/no are code.** understand gives intent and mood (fixtures), but the reason table, "didn't authorise" detection and the yes/no answer are regex tables in `offers.ts`, like Step 8's error_reason table. Not taken: adding a reason field to understand's shared schema (changes every understand fixture key).
10. **Channel choice: email by default.** WhatsApp only with consent and inside the 24-hour window (outside it only templates go, and none carry a link); B2B always email to the billing contact. **SMS isn't built**: the messaging adapter has no SMS channel, and adding one changes the shared channel enum and consent table. Not taken: a WhatsApp template with a link parameter.
11. **Playbook values as merchant columns.** `sub_call_value_limit` and `sub_pause_days` live on `merchants`, following migration 0008's calling hours. Why: playbook_rules rows would change the seed test's exact row counts. Sharma Tutorials' 30 days reads as "skip a month"; FitLoop uses the default month's pause.
12. **Proof dates are case data.** Mandate approval time and reference, and the pre-debit notice time, are new columns that `caseFacts` formats, so the "didn't authorise" reply can quote them and pass grounding. Strong proof (approval + reference + notice) offers the reply; weak proof (or a refund rule) adds the refund, first when proof is weak.
13. **Collect hand-off is an event only.** After 7 days unpaid, a `collect.handoff` note goes on the subscription case with the invoice (id, amount, period, link, attempts) and the buyer; `listCollectHandoffs(db)` reads them for Step 11. The subscription case closes `handed_to_collect`, not saved.
14. **Duplicate charge.** A second `subscription.charged` for an already-paid cycle opens its own case with "Refund ₹499" (tap, 10-minute hold with Undo). Not saved.
15. **No response = lost after 7 days** (A, B), also when a call card is open; the subscription stays halted at Razorpay. C's lost timer runs from the next due date.
16. **Webhook sim:** `subscription.charged` with nothing pending records a second payment on the latest paid invoice (that's what the duplicate path needs); `subscription.pending` issues the next cycle's invoice only when none is pending.

## Gaps left on purpose

- Discount save offer (see 6) and SMS (see 10).
- Subscribers' voice notes go through the existing `receiveVoiceNote` and are read like text; no Step 9-specific voice test.
- `onChange` (redraft) isn't implemented for this flow; Change is still recorded by the engine.

## What was run

- `npm test`: 27 files passed, 1 skipped; 352 tests passed, 27 skipped (the same Razorpay test-mode skips as main). Step 9: 20 tests in `src/flows/subscriptions/subscriptions.test.ts`, every AI call served from replay, no fallbacks.
- `npm run lint`: clean. `npm run typecheck`: clean.

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
9. **Registry, `src/engine/index.ts`**: one line registering `createSubscriptionsSpecialist()`.

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

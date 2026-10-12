# Step 11 overnight log: Invoice overdue (Collect)

Branch `step-11-collect`, from `main` at 4924e1a (Step 7). Built in a separate git
worktree (`../ray-extended-step11`) because the main checkout had uncommitted
Step 10 work in it that belongs to another session; that work was left untouched
on `step-10-chargebacks`.

## Shared changes (additive only)

Every change outside `src/flows/collect/`, with why. No existing behaviour or
existing test changes, except one expected seed count (see the last item).

| File | Change | Why |
|---|---|---|
| `src/db/migrations/1100_collect.sql` (+ journal entry) | Rebuilds `messaging_consents` with `customer_id` nullable and a new `buyer_id` (FK buyers), a CHECK that exactly one is set, and a unique index on (buyer_id, channel). Every existing row is copied over unchanged. Adds `invoices.taxable_value` (nullable). | Buyers need consent rows on every channel (build guide, Approved changes, Step 5). TDS is a percent of taxable value; null means "same as the invoice amount", which is what the seeded bank credits assume. |
| `src/db/schema.ts` | The two columns above. | Matches the migration. |
| `src/adapters/messaging/index.ts` | New `setBuyerConsent` / `buyerConsent`. `send()` now also looks up a buyer at the address: a buyer needs an `opted_in` row on that channel for every message, reply or not. Customers are unchanged. | "Email, WhatsApp and calls to a buyer all need an opt-in row." |
| `src/guards/checks.ts` | `consent`: if the recipient is a buyer, every channel needs `opted_in`. `callRules` and `place_call`: the callee can be a buyer (name is the contact name; "Asked not to call" records a buyer opt-out). `firstMessage`: on a Collect case, a message carrying a Razorpay link must state that link's own amount (a reminder link covers some invoices, not the whole case). | Buyer consent on every channel; calls to buyers in the Call stage; rule 7 as scoped for reminders. |
| `src/tools/act.ts` | `place_call` looks up a buyer when the number isn't a customer's. | Same. |
| `src/guards/facts.ts` | `caseFacts` also takes `note` events with `payload.kind === "case_facts"` (written by code only). | Rule 6: "18 days overdue", "2 invoices", "45 days", "43B(h)" must be case data. Code computes them and writes them on the case before a message uses them. |
| `src/engine/specialist.ts` | Optional `route?(ctx, event)` hook: return the id of an open case of this moment the event belongs to. `InvestigateResult` gets optional `outcome`. | A buyer reply or a bank credit can come weeks after the last activity, past the 7-day grouping window. |
| `src/engine/engine.ts` | When grouping finds no case, ask each specialist's `route` before running detectors. | Same. |
| `src/engine/state-machine.ts` | `SETTLED_ONLY`: `likely`/`waiting_customer` → `closed` is allowed only with outcome `collected`. | The money landing closes a case that never needed a tap. Without it the only way to closed is acting (a tap or rule), but Sure credits post alone. |
| `src/engine/orchestrator.ts` | When `investigate` returns `to: "closed"`, it sets `closed_at`, `outcome` and `counts_as_saved` the same way the verify branch does. | Same; no existing flow returns closed from investigate. |
| `src/engine/index.ts` | One line registering the Collect specialist. | As asked. |
| `src/db/seed.ts` | One line calling `seedCollect`. | As asked. |
| `src/db/seed.test.ts` | `messaging_consents` expected count 13 → 23, with a comment. | The 10 buyer consent rows Step 11 seeds. The count is still exact (not weakened). |
| `src/surfaces/views.ts` | `subjectOf`: when no customer matches the case's keys, a buyer's business name is used (Collect cases). `caseView`: on Collect cases only, the question comes from the flow's latest `collect_ask` note. | The case page has to name the buyer and show Collect's one question; other moments are untouched. |
| `src/app/...`, `src/ui/merchant/top-bar.tsx` | New page `merchant/[id]/collect`, new routes `api/merchant/collect` and `api/dev/collect`, one nav link ("Invoice overdue"), and one dev panel section (two lines in `dev/page.tsx`). | The morning list and dev controls. The components themselves live in `src/flows/collect/`. |

## Plan

### Rules this step must keep (CLAUDE.md and Step 11)

1. Models never move money: `post_match`, `send_message`, `payment_link`, `place_call` and `draft_request` all go through `guardedCall`.
2. Firm reminders, the Call stage and MSME notices need the merchant's tap (send_message approval table, collect_call needs approval). Before-due and gentle reminders run alone. Key accounts: a tap for anything firm, and a tap for every call.
3. Matching is code. Sure posts with undo; Likely waits for a tap; Unsure only asks. A near-match is never acted on.
4. Nothing acts on Unsure.
5. Buyer and merchant text is data. The reply reader is code over the words; nothing in a reply is followed. "Wrong person" never re-routes on its own: the new contact goes to the merchant as a one-tap proposal.
6. Every number in an outgoing message is case data (`case_facts` notes written by code).
7. Reminders may carry a Razorpay-hosted pay link, never alone, always with the merchant, the amount and the invoices.
8. Every state change goes through the state machine; events are append only.
9. No keys anywhere.
10. Banking+ credits and the Bookkeeping Agent are Simulated and labelled.
11. Everything a case or guard reads is in the database: invoices, promises, bank credits, stage notes, consents.
12. Buyer consent on every channel (email, WhatsApp, call); an opt-out blocks; no row blocks.
13. Calls follow design language section 5: open as the merchant with the buyer's name and the amount, ask for a date, never take payment or read a link, stop and record an opt-out on "don't call", only within calling hours, never a first contact.

### Shape

- **One Collect case per buyer** with money owed (decision 1). The case cites each of its invoices, so case facts hold them.
- **Chase stages** (`stages.ts`), per invoice, from its due date: Before due (due − 3 d, email, alone), Gentle (due + 3, email and WhatsApp, alone), Firm (due + 15, email and WhatsApp, one tap per buyer), Call (due + 25, `place_call`, one tap; key accounts a tap per call), MSME rights (accepted + 45 d, Udyam merchants only, always a tap), Samadhaan (only on request, a draft the merchant files). Each stage runs once per invoice (a `collect_stage_done` note). A daily check timer (9:30 AM IST) on each case moves stages along. Invoices with an open promise are paused.
- **Morning list** (`morning.ts`): one row per buyer, priority = Σ(outstanding × days overdue) × pay history (1 + avg days late / 60, + 0.25 per broken promise) × relationship (key account 1.25). Sorted high to low. Each row says what RAY will do today, or "Needs you".
- **Opening cases**: `collectMorningRun(engine, adapters, merchantId)` sends one event per buyer with something to chase through `handleEvent` (deduped per day by source id). Dev panel and the morning list page's button call it.
- **Reply reader** (`replies.ts`, code): promise, dispute, document request, says paid, part payment, wrong person, hardship, unclear. Voice notes arrive as their transcript and are read the same way.
- **Promise ledger** (`promises` table): from replies, calls and the merchant's own note ("spoke to them, paying on 20th"). An open promise pauses that invoice; the day after the date RAY checks; no money means broken; the second broken promise moves the invoice to the next stage and flags it.
- **Money matcher** (`match.ts`, code): exact (pay link UTR, the buyer's own UTR with exact amount), subset-sum over the buyer's open invoices (one fit Sure, several Likely), TDS short-pay at the buyer's usual rate (Likely, ask for the certificate), remittance advice (Sure when it agrees with the credit), part payment (oldest first unless the advice says otherwise, Likely), no match (ask with the closest options). The model (the understand job, with a Collect prompt) only reads the credit remark and the advice text into invoice numbers and amounts, and code checks every one is in the text.
- **Banking+ gate**: only Banking+ merchants get cases. Others see the read-only overdue view with the Banking+ offer.
- **Subscriptions handoff**: an event with `payload.event === "collect.handoff"` opens (or joins) the buyer's Collect case for that invoice. Payload contract in decision 9.

### Tests ("Done when" and the brief)

PackRight's morning list renders with priorities; subset-sum; TDS short-pay; part payment; promise pause; broken promises (two → next stage and flagged); non-Banking+ sees only the read-only view; nothing reaches the buyer with no consent; approvals per stage (gentle alone, firm needs a tap, key account call needs a tap each time); Call stage logs a promise; buyer voice note read like text; every reply type; remittance advice; handoff event; numbers grounded and no banned words.

## Decisions

Each: what, why, and the alternative not taken.

1. **One case per buyer, not per invoice.** The guide batches firm reminders "one tap per buyer", one transfer often pays several invoices (subset-sum), and replies are about the buyer's account. Alternative: a case per invoice; rejected because one credit would have to post across several cases and the merchant would get several cards for one buyer.
2. **Reply reading is code, not the model.** The brief says "in code with the model only for remarks and advice text". Keyword and date rules in `replies.ts`; anything they can't read is Unsure and goes to the merchant as a question. Alternative: the understand job; rejected per the brief.
3. **Buyers need an opt-in row for every message, replies included.** Customers may get a reply inside 24 hours without a row; buyers may not. Stricter, and "nothing reaches that buyer" stays true even if Kohli writes in. Alternative: the customer rule (replies allowed); rejected as weaker.
4. **"Wrong person" asks the merchant to approve the new contact** (one tap) instead of updating it alone. A new address inside a buyer's message is an instruction from that message (rule 5). Alternative: update and resend alone, as the guide's line reads; rejected as it would let a reply redirect chasing.
5. **Firm reminders never use a playbook rule.** Always a tap. Key accounts already need a tap for anything firm; this applies it to everyone. Alternative: allow an approved rule for non-key accounts; rejected because the brief lists firm as tap-only.
6. **Non-key Call stage: one tap covers the stage** (a retry after No answer the next day reuses that tap; the approval guard re-checks it). Key accounts get a fresh card for every call. Alternative: a tap per call for everyone; rejected because the guide distinguishes the two.
7. **Taxable value.** TDS = rate × taxable value; `invoices.taxable_value` null means the invoice amount (the seeded credits were built that way). Alternative: assume 18% GST on every invoice; rejected because the seed data would not match.
8. **Closing.** Money posted → the next daily check confirms the invoice is still paid (undo is possible until then) and closes with outcome `collected`; counts as saved if any of the case's invoices were overdue. Needs the additive `SETTLED_ONLY` move. Alternative: close straight after posting; rejected because undo would then hit a closed case.
9. **Handoff contract** for Step 9 (`collect.handoff`): `handleEvent({ kind: "webhook", merchantId, at, sourceId, payload: { source: "subscriptions", event: "collect.handoff", invoice_id?, subscription_id?, sub_invoice_id?, customer_id?, amount?, due_date? } })`. With `invoice_id` RAY uses that invoice; otherwise it creates the invoice from the subscription invoice and finds (or adds) the buyer from the subscription's customer. A new buyer has no consent rows, so nothing is sent until the merchant adds them. Alternative: wait for Step 9 to define it; rejected because both sessions run in parallel.
10. **Bank credits arrive as an event** `{ kind: "webhook", payload: { source: "banking_plus", event: "bank_credit.received", credit_id } }`, labelled Simulated. A credit from an unknown payer opens its own Collect case that asks the merchant.
11. **Seeded buyer consents** (10 rows): Gill Agro email, WhatsApp, call; Bansal email, WhatsApp; Sidhu email, WhatsApp opted out; Mehra email, WhatsApp, call; Kohli none.
12. **Samadhaan** is drafted on request through Change ("Draft a Samadhaan filing") with `draft_request`; the merchant files it. Alternative: a standing button; rejected because the guide says only on request.

13. **Buyers see exact amounts** (₹1,07,600); merchant screens keep the short form (₹1.1 lakh) from design language section 1. An invoice reminder has to match the buyer's books to the rupee. Alternative: the lakh form everywhere; rejected because "₹1.1 lakh" can't be checked against an invoice.
14. **Climbing the ladder**: one stage at a time per invoice, at least 3 days apart, and never the Call stage before a text (the call guard forbids a first contact anyway). An invoice first seen 36 days overdue starts at Firm, not Call. Two broken promises skip the gap. Alternative: jump straight to the stage the dates say; rejected because it would send gentle, firm and a call on three days running.
15. **Sure but above the approval limit waits for a tap.** The amount cap guard applies to `post_match`; the card says why ("above your approval limit of ₹50,000") and is labelled Covered. Alternative: post anyway because it's Sure; rejected because the guard is shared and the merchant set the limit.
16. **A credit from a payer code can't place opens its own case**, Unsure, with the closest open invoices in the question and no button. The merchant answers through Change ("It's Sidhu's, for 2433"); that answer becomes a Likely card, still a tap. Such a case never counts as saved (the buyer's own case does). An unknown payer's credit never posts alone.
17. **After a tap the case sits in "Checking it worked"** (verifying) while RAY waits for the buyer, because the state machine has no verifying → waiting_customer move and I didn't add one. The morning list still shows "RAY is handling it".
18. **Consent belongs to the buyer, not the address.** After the merchant approves a new contact ("wrong person"), the buyer's existing opt-ins cover it. Alternative: require new consent for the new address; rejected for now as heavier than the brief asks, and noted here for review.
19. **The morning run is on demand** (the "Run today's chase" button and the dev panel), through `handleEvent`. After that, each case's own 10:30 AM check timer drives it. The engine has no merchant-level timer, so a buyer with no case yet waits for the next run. Alternative: a new engine-level daily timer; rejected as a bigger shared change.
20. **Seeded data quirks I kept**: Mehra's 2409 and 2414 are both ₹38,700, and Kohli's 2405, 2410 and 2415 are all ₹58,100, so several sets often fit. RAY offers them as options (Likely) and never guesses. The seeded Kohli credit (₹1,13,876) fits 2% TDS on three pairs, so it's Likely with options.

## Progress

- Plan and decisions: this file.
- Shared changes: committed separately ("additive shared changes for Collect"), with every existing test passing before the flow was added.
- Flow: `src/flows/collect/` (stages, dates, reply reader, matcher, remittance reader, data, resolve, messages, Specialist, morning run, morning list, UI, dev controls).
- Seed: `src/db/seed/collect.ts`, called with one line from `src/db/seed.ts`.
- Fixtures: `fixtures/ai/sources/collect.json` → 4 understand fixtures labelled "recorded in Claude Code" (`npx tsx src/flows/collect/fixtures.ts`).
- Registry: one line in `src/engine/index.ts`.

### Tests

`src/flows/collect/units.test.ts` (matcher, reply reader, dates, stages, priority), `collect.test.ts` (the loop through handleEvent), `fixtures.test.ts`, `morning-list.test.tsx` (renders in both views; read-only view; Collect case on the case page). Done when, mapped:

- PackRight's morning list renders with priorities: `morning-list.test.tsx`, `collect.test.ts` "renders PackRight's morning list…".
- Subset-sum: units, plus "subset-sum with one fit posts alone, and Undo hands it back" and "several fits are only Likely".
- TDS short-pay: units, plus "TDS short-pay at the buyer's usual rate…" (seeded bc_PR_1) and the Kohli options test.
- Part payment: units, plus "part payment: oldest invoice first…", "part payment follows the advice…", "part payment reply: match the part, log a promise for the rest".
- Promise pause and broken promises: "a promise pauses the chase…", "a kept promise…", "two broken promises: the next stage, and flagged".
- A non-Banking+ merchant sees the read-only view only: `collect.test.ts` and `morning-list.test.tsx`.
- From the brief: nothing reaches Kohli (no consent rows) on any channel, also checked at the guard and adapter; Sidhu's WhatsApp opt-out; gentle runs alone; firm, Call and MSME need a tap; key accounts get a tap per call; one tap covers a non-key Call stage; "don't call" records the opt-out; call promise goes into the ledger; buyer voice note read like text; every reply type; remittance advice (agrees → Sure; instructions inside → nothing marked paid); collect.handoff fired directly; Samadhaan only on request; every outgoing message grounded, no banned words, no em dashes, links only Razorpay links.

### Final run (after rebasing on main)

See the bottom of this file.

## Notes for review

- **Migration journal**: `1100_collect` is journal idx 10. Step 10's `1000_chargebacks` (in progress on its own branch) also takes idx 10. Whichever merges second needs its entry renumbered to 11, with its `when` after the other's.
- **Seed count**: `messaging_consents` 13 → 23 in `src/db/seed.test.ts` (exact, not loosened). Any other branch that adds consent rows will conflict on that number.
- **Worktree**: built in `../ray-extended-step11`, because the main checkout had uncommitted Step 10 work. An early commit picked up the worktree's `node_modules` symlink (`.gitignore` has `node_modules/`, which doesn't match a symlink); I rewrote the branch's commits to drop it and force-pushed with lease. No commit on the branch contains it now.
- **Not built**: a real Samadhaan submission (it's a draft for the merchant to file), real attachments (the document and corrected-invoice replies say "attached"; Simulated), and new consent for a changed contact (decision 18).

## Final run

On `step-11-collect`, rebased on `origin/main` (4924e1a; no new commits on main since the branch was cut), 13 Oct 2026:

- `npm test`: 30 files passed, 1 skipped; 414 tests passed, 27 skipped (the same 27 were skipped before this step: live Razorpay test-mode tests that need keys).
- `npm run lint`: clean.
- `npm run typecheck`: clean.
- `npx next build`: compiles, including `/merchant/[merchantId]/collect`, `/api/merchant/collect` and `/api/dev/collect`.

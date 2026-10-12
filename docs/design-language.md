# RAY design and experience language

Every screen, message and AI prompt in this repo follows this file. If something here conflicts with a step in `docs/build-guide.html`, this file wins on how things look and sound; the guide wins on what gets built.

RAY is an account manager that acts. Every surface should feel like a good account manager: it says what happened and what it costs, shows how it knows, asks one clear question, and never hides what it did.

---

## 1. Words and states

Use these exact words everywhere: UI, WhatsApp cards, digests, emails to the merchant, tests. Don't invent synonyms.

### The five moments (merchant-facing names)

| Internal | Shown as |
|---|---|
| paid_no_order | Paid, no order |
| international | Card declined abroad |
| subscription | Subscription stopped |
| chargeback | Chargeback |
| collect | Invoice overdue |

### Case states

| State | Label | Chip colour | Shown where |
|---|---|---|---|
| likely | Likely: checking | neutral | Dashboard only, no notification |
| confirmed | Confirmed | info | Inbox, alert |
| waiting_merchant | Needs you | warning | Inbox "Needs you" tab, digest, WhatsApp |
| waiting_customer | Waiting for customer | neutral | Inbox "RAY is handling" |
| acting | Doing it | info | Case page |
| verifying | Checking it worked | info | Case page |
| closed | Resolved | success | Closed tab |
| fixed_itself | Fixed itself | neutral | Closed tab, counts nowhere |
| unconfirmed | Closed, no reply | neutral | Closed tab |

### Confidence

Always a chip plus one line of reason. Never a percentage on merchant screens.

- **Sure**: "Payment, email and amount all match."
- **Likely**: "Amount and time match; email is different."
- **Unsure**: "Two payments could match." Unsure never shows an action button, only a question.

### Whose side

| Side | Label | Note shown |
|---|---|---|
| razorpay | Razorpay's side | "Free. Razorpay owns this." Add "Razorpay's own plugin" when it is |
| merchant | Your side | "Here's the fix." |
| customer_or_bank | Customer's bank | "RAY will handle the customer." |

### Approval labels

Every action button carries one of these, under or beside it:

- **Covered**: if RAY gets this wrong, the proposed error cover applies.
- **Your call**: this depends on the merchant's judgement (stock, policy, relationship).

### Buttons

Verb, object, amount when money moves: "Mark paid & ship", "Refund ₹1,299", "Send update link", "Contest dispute", "Approve rule". Never "Submit", "OK", "Proceed", "Confirm action".

### Numbers, dates, times

- Indian grouping: ₹1,299 · ₹14,20,000 → show as ₹14.2 lakh above ₹1 lakh · ₹1.5 crore.
- Foreign amounts show both: $49 (₹4,100).
- Dates: 6 Oct. Times: 7:52 PM. Relative within a day: 14 min ago, 3 hr ago.
- Payment IDs shortened: pay_Q8x… ; full ID on hover or tap.
- UTR: last 4 only on customer messages ("UTR ending 4821").

### Words never shown to merchants or customers

webhook, cron, HTTP 200, idempotency, payload, orchestrator, agent, LLM, AI model, MCP, situation B. Say what it means instead: "Your site got the payment message but didn't update the order." Technical words are fine inside the developer brief and the "Details for your developer" expander.

---

## 2. RAY's voice

### To the merchant (WhatsApp card, digest, case page)

- RAY speaks as "I". Short. The ₹ amount and the person's name come first.
- Shape: what happened → why (whose side) → stock or context → one question.
- One ask per message. Max 3 lines before the buttons.
- No apologies for Razorpay's own systems beyond one plain line: "This one's on Razorpay's plugin, so it's free."

Good: "Priya Sharma paid ₹1,299 for a Chocolate box last night, but order #1234 is still Pending. Razorpay's plugin got the payment and dropped it. 12 in stock. Want me to mark #1234 paid and tell her it's confirmed?"

Not this: "Hi! I've detected a potential discrepancy between a captured payment and your order system. Would you like me to take action?"

### To customers (always as the merchant)

- RAY never appears. It's the merchant speaking: "we", signed with the merchant's sign-off.
- Mirror the customer's language (Hinglish in, Hinglish out), in the playbook's tone.
- First message: exact amount, time, last 4 of the UTR, "check this in your UPI app". No link.
- Every message that isn't a final answer gives a time: "You'll hear from us by 8:30 PM."
- No blame, no internal terms. "Our system missed your order", never "the webhook failed".
- Don't promise what code hasn't checked ("you won't be charged twice" is banned).

### To B2B buyers (Collect)

- Polite and factual at every stage; firmness comes from facts (days overdue, amount, the 45-day rule), not adjectives.
- Gentle: "A quick reminder that INV-112 for ₹48,000 was due on 2 Oct. Pay link and bank details below."
- Firm: "INV-112 for ₹48,000 is now 18 days overdue. Can you share a payment date this week?"

### Developer brief

Technical is fine. Cause, evidence with timestamps, what to change, how to check it. One page.

### These rules go into the prompts

The `write` job's prompt in `src/ai/prompts/` includes sections 1 and 2 of this file. The grounding check enforces numbers; a test checks drafts contain none of the banned words.

---

## 3. Look

### Direction: Razorpay-native

It should look like it already lives inside Razorpay's Agentic Dashboard. Build with **Blade**, Razorpay's open-source design system (`@razorpay/blade`, MIT): its theme, typography, spacing and components (Table, Badge, Button, Card, Alert, Toast, Tabs, Drawer).

Do a short spike first: install Blade and render one Card, Badge and Button in our Next.js app. If it won't run cleanly with our Next.js and React versions within that spike, stop and report; the fallback is plain CSS with the tokens below. Don't fork or copy Blade's source.

No Razorpay logo file. The top bar shows the text "Razorpay" and a small "Prototype" tag.

### Tokens (fallback, and for anything Blade lacks)

| Token | Use |
|---|---|
| primary | Razorpay blue (take the exact value from Blade's theme): primary buttons, links, active tab |
| surface / surface-raised | Page and cards |
| text / text-muted | Body and secondary text |
| success / warning / critical / info / neutral | State chips only; never decoration |
| simulated | A purple tag for every simulated system (store, WhatsApp, email, webhook logs, Dispute Responder, Banking+ credits) |
| covered / your-call | Small labels under buttons: covered uses success, your-call uses warning |

Colour never carries meaning alone: every chip has text, every finding has ✓ or ✗.

### Two views, one switch

The merchant area has a **View: Phone | Desktop** switch in the top bar. It defaults by screen width and remembers the choice for that browser.

| Surface | Phone view | Desktop view |
|---|---|---|
| Free alerts | Stacked cards | Table |
| Cases inbox | Cards: name, ₹, label, age | Table, sorted by ₹ then age |
| Case page | One column: findings first, then conversation; action bar fixed to the bottom | Three panes: conversation, what RAY found, your call |
| Approval | WhatsApp card in a phone frame | WhatsApp card in a side panel beside the case |
| Digest | WhatsApp message | Same message in a panel |
| Playbook, metrics | Stacked sections | Two columns |

The simulators (customer inbox, buyer inbox, store admin, dev panel) are always desktop and always carry the Simulated tag.

### Components

| Component | Anatomy |
|---|---|
| Case row | Moment · name · ₹ (bold, right-aligned, tabular figures) · state chip · confidence chip · age · one action |
| Finding | ✓ or ✗ · one plain sentence · source tag (Razorpay, Store, Customer, Bank) · "Show evidence" opens the raw record |
| Case timeline | One line of steps: "Paid → Captured → Accepted, then dropped → Complaint", the failing step in critical colour |
| Your call panel | The question · primary button (RAY's recommendation) · secondary button · "Something else" link · the draft message · "RAY will send this from …" |
| Approval card | WhatsApp bubble · Approve · Change · Open case |
| Hold banner | "Refunding ₹1,299 in 9:42 · Undo" with a live countdown |
| Stop banner | "Contesting this dispute in 1 hr 52 min · Stop" |
| Promise line | "Priya was told she'll hear back by 8:30 PM" |
| Rule card | "You've refunded duplicates under ₹500 three times. Make it a rule?" · Approve rule · Edit · Not now |
| Investigation progress | While RAY investigates: a short live list ("Checked payment ✓", "Checked webhook log ✓", "Checking store order…"), then the findings |
| Kill switch banner | "RAY's actions are paused for this account. Reading still works." |
| Empty state | What will show up here and what makes it appear: "No cases need you. RAY will show paid orders that didn't update here." |
| Error | What went wrong and what to do: "Couldn't reach your store. RAY will retry at 8:05 PM, or check the connector." |

---

## 4. Interaction rules

Same behaviour in every moment.

1. **One primary action per screen**, and it's RAY's recommendation. Alternatives are secondary.
2. **Nothing moves money silently.** After a tap: button shows "Doing it…", then the result only after the check passes ("Order #1234 marked paid ✓"). If the check fails, say so and move the case to Needs you.
3. **Refunds hold for 10 minutes** with Undo, visible on the case page, the inbox row and the WhatsApp thread.
4. **Automatic dispute lanes** always show a Stop window banner and send an FYI. Stop works until the timer ends.
5. **Change** opens free text ("refund instead", "add a note"), RAY redrafts, and the same card comes back with the new draft. Never more than one card per case at a time.
6. **Rules are proposed, never assumed.** A rule card appears after repeated identical choices. Nothing applies until Approve rule. Every action taken under a rule shows "Under your rule: …" with a link to turn it off.
7. **Promised times are visible** on the case. If the merchant hasn't tapped by then, the customer gets a holding message and the merchant a nudge, both shown in the timeline.
8. **Every action is explainable**: tapping any timeline event shows what happened, who approved it (tap or rule) and the evidence.
9. **Unsure asks, never acts.** The only control is the question RAY wants to send.
10. **Kill switch**: action buttons disappear and the banner shows; reading still works.
11. **Accessibility**: keyboard focus visible, text contrast at least 4.5:1, countdowns also given as text, nothing by colour alone.

---

## 5. Voice

Voice uses **ElevenLabs** only (Razorpay already runs outbound Hinglish voice agents on ElevenLabs, and it's a connector in Agent Studio). In the prototype, voice notes are real (speech-to-text on ElevenLabs' free tier, with recorded samples as fallback) and calls are **Simulated**: a call screen with the transcript, a few lines of generated audio, and the post-call summary.

### Where voice is used

| Where | Direction | When | Rules |
|---|---|---|---|
| Merchant voice notes | In | The merchant replies to RAY on WhatsApp by voice | RAY transcribes, reads the intent, and sends back the approval card. A voice note never approves money on its own: the merchant still taps. |
| Customer and buyer voice notes | In | A customer or buyer sends a voice note instead of text | Transcribed, then read by the understand job like any message. The transcript shows in the conversation with a ▶ play control. |
| Paid, no order: follow-up call | Out | Text first, always. A call only if the customer hasn't replied by the promised time | The first text says a call may follow and from which number ("If we don't hear back, we'll call you from +91 98xxx xx210, Leafy Bakes"). Calls come only from the merchant's own number or verified identity. Proactive calls only to opted-in customers. |
| Subscription stopped | Out | Retries ran out, subscriber value above the merchant's limit | One call, the playbook's save offer, then the post-call summary to the merchant. |
| Invoice overdue | Out | The Call stage (due + 25 days), after the merchant's one tap | Asks for a payment date and logs it as a promise. Key accounts only with a tap per call. |
| Urgent merchant call | Out | The day before a chargeback deadline, merchant hasn't answered | Opt-in only. Ends by sending the decision card on WhatsApp. |

Not voice: international buyers, chargeback cardholders (who may not be the buyer), and any first contact with a customer.

### Call rules (every call)

- The call opens with who is calling and why, as the merchant: "Hi Priya, this is Leafy Bakes about your ₹1,299 payment on 6 Oct."
- Never asks for a card number, UPI PIN, OTP or password, and never asks the person to pay on the call. Anything that moves money ends as a text with checkable details, and the merchant's tap.
- Never reads out a link.
- If the person says they're busy or asks not to be called, stop and record the opt-out in messaging_consents.
- Calls happen only within the times the merchant sets in the playbook (default 10 AM to 7 PM).
- Every call ends with a post-call summary on the case: outcome, promise or choice, and the transcript. That summary is what the decide job reads next.

### How voice looks

| Component | Anatomy |
|---|---|
| Voice note bubble | ▶ play · duration · transcript below, in the original language |
| Call card | "Call to Priya · 1 min 42 s · Simulated" · outcome chip (Answered, No answer, Busy, Asked not to call) · transcript expander · ▶ for generated audio lines |
| Pre-call notice | On the case: "RAY will call Priya at 8:30 PM if she hasn't replied · Cancel call" |

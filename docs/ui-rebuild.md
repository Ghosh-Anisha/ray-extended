# RAY UI rebuild (13 Oct): demo-first

This file wins over `docs/build-guide.html` Step 6 and over section 3 of `docs/design-language.md` wherever they differ. The engine, guards, tools, flows and tests stay. This rebuild replaces how the product looks and how someone walks through it.

## Why

A judge opens the app and must, within 10 seconds, see a Razorpay dashboard with money at stake and one obvious next step. Today the app opens on a list of links, every page is empty until someone fires events from a dev panel, there is no way back to Home, and the Agentic Dashboard, RAY chat and My dashboard screens are missing.

## Non-negotiables

1. **Data from the first second.** A rich demo world is seeded (section 4). No screen is empty on first load.
2. **One shell everywhere.** Top bar plus left nav on every page. Home is one click away from anywhere.
3. **Nothing needs the dev panel.** A guided story (section 6) drives the timeline. Dev controls move into a hidden "Demo controls" drawer.
4. **Looks like Razorpay.** Section 2 is taken from a live Razorpay dashboard. Match it.
5. **Nudges everywhere.** Every screen tells the viewer what to do next.
6. **Fast.** Every page loads under 1 second in production mode (section 8).
7. The engine rules still hold: every action goes through `guardedCall`, every state change through the state machine, and the design-language words for states and buttons.

## 1. Information architecture

```
Top bar (black): Razorpay logo · Razorpay Home · Payments · Agentic Dashboard (active) · Banking+ · [search] · [RAY ✦ button] · [Leafy Bakes ▾ avatar] · "Prototype" tag
Left nav (white):
  Home
  AGENTIC DASHBOARD
    Cases                (badge: count needing you)
    Ask RAY              (chat)
    My dashboard
    Rules                (playbook, chat-first)
  CHANNELS
    RAY on WhatsApp      (phone view)
  SEE IT FROM THE OTHER SIDE   (all tagged Simulated)
    Customer inbox       (Gmail-style)
    Buyer inbox          (Gmail-style)
    Store admin          (WooCommerce-style)
  ─────────
  Demo controls          (opens a drawer, not a page)
```

- The account switcher (top right) defaults to **Leafy Bakes**, the demo account that has all five moments. Other seeded merchants stay for tests and can be switched to.
- Breadcrumbs on every inner page: `Agentic Dashboard › Cases › #RD-1042`.
- The Phone | Desktop switch stays in the top bar, but the phone story is told through **RAY on WhatsApp**.
- Remove the old link-list home page and the standalone Simulators header.

## 2. Visual spec (from the live Razorpay dashboard)

Use Blade components where already installed; otherwise CSS variables plus small components. Match these values:

| Token | Value | Use |
|---|---|---|
| `--topbar` | #0B0B0D | Top bar background; nav text white at 85%, active tab white with a soft blue glow underline |
| `--canvas` | #F5F6F8 | Page background |
| `--surface` | #FFFFFF | Cards, left nav, inbox |
| `--border` | #E6E8EC | 1px card and table borders |
| `--text` | #0F172A | Primary text |
| `--muted` | #64748B | Secondary text, labels |
| `--primary` | Blade primary (fallback #2563EB) | Primary buttons, links, active nav icon |
| `--primary-soft` | #EEF3FF | Selected nav item, info chips |
| `--success` / `--success-soft` | #0F7B4E / #E7F6EE | Resolved, ₹ saved, "↑ vs last week" |
| `--warning` / `--warning-soft` | #B45309 / #FEF3C7 | Needs you, Your call |
| `--critical` / `--critical-soft` | #C62828 / #FDECEC | Failed step, dispute deadline |
| `--sim` / `--sim-soft` | #6D4ED6 / #F1ECFF | Simulated tag only |
| `--wa` | #075E54, bubble #DCF8C6, chat bg #ECE5DD | WhatsApp phone view only |

- **Type:** Inter (Google Fonts), 14px body, 13px table text, 12px uppercase nav section labels with 0.06em letter-spacing, page titles 22px/600, big numbers 32px/700 with tabular figures.
- **Cards:** radius 12px, 1px border, no heavy shadow; 24px padding; 16px gaps.
- **Left nav:** 248px wide, items 40px tall, icon + label, selected item has `--primary-soft` background and 8px radius. Section labels small, uppercase, muted.
- **Chips:** pill, 12px text, icon on the left. "✦ Insight by RAY" chip (grey background, like Razorpay Home) appears under every metric RAY explains.
- **Date chips:** "📅 6 Oct – 13 Oct" and "🕒 Updated 2 min ago" next to section titles, like Razorpay Home.
- **Primary button:** filled `--primary`, white text, 8px radius, 36px tall. Secondary: white with border.
- **Icons:** lucide-react line icons, 16px.
- **Motion:** 150ms fades only; the investigation progress list animates step by step (section 3.3).
- No emoji as section markers. Empty states use one line of text and one action.

## 3. Screens

### 3.1 Home (Razorpay Home look)

Top to bottom:
1. **Attention banner** (white card): "**₹8,450 waiting on you.** 4 cases need a tap." + button **Review cases**. When none: "You're all caught up."
2. **Guided demo card** (only until dismissed): "See RAY in 3 minutes: follow one day at Leafy Bakes." + **Start guided demo** + "Explore on my own".
3. **"What RAY did this month"** with date chips: four metric cards: **₹ saved** (₹1,84,300, "↑ 18% vs last month"), **Time saved** (11.5 h), **Cases closed** (23), **Customers kept** (19). Each card has an "✦ Insight by RAY" line, e.g. "Most saves came from orders your store missed after payment."
4. **By moment**: five cards in a row (Paid, no order · Card declined abroad · Subscription stopped · Chargeback · Invoice overdue), each with open count, ₹ at stake and a link to the filtered inbox.
5. **Right rail**: "RAY on WhatsApp" phone preview showing the latest approval card, with **Open on WhatsApp**.
6. **Recommended for you** tiles (like Razorpay Home): Set up My dashboard · Ask RAY · Set a rule.

### 3.2 Agentic Dashboard › Cases (Gmail-like inbox)

- Left column inside the page: **Needs you (4)**, **RAY is handling (9)**, **Closed (23)**, then filters by moment.
- Rows like Gmail: unread bold, avatar initial, **customer name**, moment chip, one-line summary ("Paid ₹1,299, order #1234 still Pending"), confidence chip, ₹ amount right-aligned, relative time. Hover shows quick actions (the primary action and "Open").
- Sorted by ₹ at stake, then age. Top of list: "₹8,450 waiting on you · Sorted by money at stake".
- Clicking a row opens the case page. The back arrow returns to the same tab and scroll position.

### 3.3 Case page

Three panes on desktop, stacked on phone:
1. **Conversation** (left): the customer thread across email and WhatsApp in one timeline, chat bubbles, channel icons, voice notes with ▶ and transcript. Composer: "RAY will reply from support@leafybakes.in".
2. **What RAY found** (middle):
   - **Investigation progress** animates once on first open: "Checked payment pay_Q8x… ✓ → Checked webhook log ✓ → Checked store order ✓ → Found the cause".
   - Then findings: ✓/✗ lines with source tags (Razorpay, Store, Customer, Bank) and "Show evidence".
   - A step timeline: "Paid → Captured → Accepted, then dropped → Complaint" with the failed step in red.
   - A whose-side chip: "Razorpay's side · free, Razorpay owns this".
3. **Your call** (right): the question, primary button (RAY's recommendation), secondary, "Something else", the draft, a Covered / Your call label, the promise line ("Priya was told she'll hear back by 8:30 PM"), and the hold or Stop banners when active.

Below the panes: the **case timeline** (every event, tap to expand).

After an action: the button shows "Doing it…", then a green confirmation ("Order #1234 marked paid ✓"), and the case moves tab with a toast "Moved to RAY is handling · Undo".

### 3.4 Ask RAY (chat)

- Right-side panel opened from the top bar ✦ button on any page, and a full page in the nav.
- Starter chips on open: "Why did Priya's order not show up?" · "What's waiting on me?" · "Refund duplicate charges under ₹500 automatically" · "Show refunds by product".
- **Rules by chat:** when the merchant types a rule, RAY replies with a **rule card**: plain sentence, scope ("Leafy Bakes · Charged twice · up to ₹500"), what it will do, and **Approve rule** / **Edit** / **Not now**. Approved rules appear on the Rules page.
- Supported rule intents (deterministic parser plus replay fixtures; anything else gets "I can't set that yet. Here's what I can do:" with chips):
  - refund duplicates automatically under ₹X
  - always bring me cases above ₹X
  - capture authorised payments before the timeout
  - call subscribers above ₹X
  - contest duplicate or already-refunded disputes automatically (first stage)
  - message customers automatically when an order is missing after payment
  - tone: friendly / formal; sign off as …
- **Questions:** answered from seeded data with the numbers cited and a link to the cases they came from. Use replay fixtures for the starter chips; other questions get a short grounded answer from the case data or a polite fallback.
- On a case page the panel is scoped to that case ("Ask RAY about this case…").

### 3.5 Rules (playbook)

- The page opens with the chat box: "Tell RAY how to handle things. Example: 'Always ask me before refunding over ₹2,000.'"
- Below it: active rules as cards (sentence, moment, times used, last used, on/off toggle), then **Suggested by RAY** (rules RAY proposed from repeated choices, with Approve).
- Advanced settings (tone, sign-off, send-from, refund speed, calling hours) live in a collapsed "Settings" section, not as the main view.

### 3.6 My dashboard (custom dashboard)

- First visit: three questions as tappable chips (What kind of business? What do you check every day? Who else looks at the numbers?), pre-selected from Leafy's data. Then "Building your dashboard…" for 1 second, then a filled starter dashboard.
- Widgets (real numbers from seeded data, each with a definition line): Today's sales, Success rate, ₹ saved by RAY, Cases needing you, Refunds, Disputes and deadlines, Overdue invoices, Subscriptions at risk.
- "Ask to add a widget" input: supported phrases "show refunds by product", "show success rate by bank", "add overdue invoices". It adds the widget with its definition shown ("Refunds ÷ captured payments, by product, last 7 days").
- One RAY suggestion card per day: "You asked about success rate 4 times this week. Pin it?" **Pin** / **Not now**.
- Remove a widget with ✕; "Keep this layout" saves.

### 3.7 RAY on WhatsApp (phone view)

- A centred phone frame (390×780) with the RAY chat: twice-daily digest ("4 cases need you · ₹6,800 at stake. Reply details"), approval cards with **Approve / Change / Open case** buttons that call the same actions as the case page, a voice note from the merchant ("haan refund kar do") that turns into an approval card, and a simulated call card.
- Beside the phone: a short "What's happening" explainer that updates with each message.
- Tapping Approve on the phone updates the case page and Home.

### 3.8 Customer inbox and Buyer inbox (Gmail-style, Simulated)

- Gmail layout: folder list (Inbox, WhatsApp, Sent), message list (sender, subject, snippet, time), reading pane with the thread.
- Pre-filled threads for every seeded case, so it is never empty.
- The reply box offers **quick replies** relevant to the thread ("mil gaya, thanks", "I didn't authorise this", "will clear by Friday") plus free text, so a judge can reply in one click.
- A purple "Simulated" tag in the header: "You're seeing what Priya sees."

### 3.9 Store admin (WooCommerce-style, Simulated)

- Orders table with status pills (Pending payment, Processing, Completed, Cancelled) and order #1234 highlighted when relevant. Shows the plugin version and its failure mode as a small note.

### 3.10 Demo controls (drawer)

- Opened from the nav bottom. Contains: **Reset demo**, **Jump to chapter** (list from section 6), **Move clock forward** (15 min, 30 min, 2 h, 48 h, 72 h), **Fire an event** (advanced, collapsed), **Kill switch**. Tagged Simulated.
- The old `/dev` route redirects here.

## 4. Demo world (seed)

Fixed clock start: **Tue 13 Oct 2026, 10:00 AM IST**. Leafy Bakes is a home bakery selling online (WooCommerce, Razorpay plugin), with a monthly cookie-box subscription, buyers abroad, and corporate gifting invoices. Use the existing seed merchants for tests; add `src/db/seed/demo.ts` for this world, run by `npm run db:seed` and by **Reset demo**.

Open cases (Needs you: 4, ₹8,450 total):
| # | Moment | Who | ₹ | State | Story |
|---|---|---|---|---|---|
| RD-1042 | Paid, no order | Priya Sharma | 1,299 | Needs you, Sure | 200-but-dropped plugin; email "Money deducted but no order!!"; Chocolate box, 12 in stock |
| RD-1043 | Paid, no order | Rahul M | 499 | Needs you, Sure | Charged twice (pay-again link) |
| RD-1051 | Chargeback | Neha K | 2,400 | Needs you | "Not received", respond by Thu 15 Oct; delivery proof found |
| RD-1060 | Subscription stopped | Karan Mehta | 4,252 (lifetime value shown; ₹499/mo) | Needs you | "Cancel, too expensive"; no rule yet → 3 options |

RAY is handling (9): Emma Clarke (card declined abroad, $49, PayPal link sent), Oliver Bennett (£2,800, limit request drafted, awaiting Razorpay), ankit.s (₹2,150, asked for screenshot), duplicate dispute ₹1,299 (auto-contest, Stop window 1 h 40 min left), Acme Corporate Gifts (₹48,000 invoice, promise "Friday"), Sunrise Hotels (₹1,12,000 invoice, gentle reminder sent), Meera Iyer (pause scheduled, resumes 1 Nov), Deepa Nair (arrival check due tomorrow), Imran Qureshi (subscription pending invoice link sent).

Closed (23): a mix across all five moments over the last 30 days, with outcomes (Resolved, Fixed itself, Closed no reply, Handled by you), timestamps and ₹, so that Home and My dashboard compute: ₹ saved ₹1,84,300, time saved 11.5 h, 23 closed, 19 customers kept, success rate 94.2% this week, 3 disputes this month (2 won, 1 open), overdue invoices ₹6.1 lakh across 5 buyers.

Every case has: a full timeline, customer messages (email and WhatsApp, Hinglish where natural), RAY's findings with evidence, and drafts. Two voice notes (Priya, the merchant). One simulated call (Acme, promise logged). Two approved rules and one suggested rule ("Refund duplicate charges under ₹500 automatically", suggested after 3 identical choices).

All numbers on Home and My dashboard are computed from these rows, never typed in.

## 5. Nudges

- A slim **nudge bar** at the bottom of the main column on every screen with one sentence and one action, e.g. Cases: "4 cases need you. Start with the biggest: Priya, ₹1,299." **Open**.
- First-visit tooltips (once each, dismissible): the ✦ RAY button, the Covered / Your call label, the Undo banner, the Rules chat.
- Every empty state says what will appear and how to make it appear.

## 6. Guided demo (story mode)

Started from Home. Uses the coach-mark pop-up component from section 10: a floating card (bottom right) shows "Step 2 of 9", one sentence, **Next**, **Back**, **Exit**, and spotlights the element to click (soft blue ring). Steps that need time to pass have a button like **Skip to next morning**, which moves the clock through the engine.

1. **Home.** "This is Leafy Bakes. RAY saved ₹1,84,300 this month. ₹8,450 is waiting on you." → Review cases.
2. **Cases.** "Biggest first: Priya paid ₹1,299 but her order never showed up." → open RD-1042.
3. **Case page.** Investigation animates. "Razorpay's plugin accepted the payment and dropped it. Status codes said 'no issue'; RAY found the real cause. It's on Razorpay, so it's free." → Mark paid & ship.
4. **Customer inbox.** "Here's what Priya received." → Skip to next morning → Priya replies "mil gaya, thanks" → case Resolved, ₹ saved goes up by ₹1,299.
5. **RAY on WhatsApp.** "Most merchants live on WhatsApp. Rahul was charged twice." → Approve on the phone → 10-minute hold with Undo shows on the case.
6. **Ask RAY.** "You've refunded duplicates three times. Make it a rule?" → type or tap "Refund duplicate charges under ₹500 automatically" → Approve rule.
7. **Chargeback.** The duplicate dispute auto-contest with its Stop timer; then Neha's case with evidence and the outreach draft → approve.
8. **Subscription stopped.** Karan wants to cancel; pick "Pause for a month" → resume scheduled; RAY suggests making it a rule.
9. **Invoice overdue.** The morning list; Acme's promise; fire the bank credit → matched to two invoices, posted with Undo.
10. **My dashboard.** Answer three questions → starter dashboard → "show refunds by product" → widget added. End card: "That's RAY: an account manager that acts, for every small merchant." + Restart / Explore.

Each step's highlighted element must exist; the stepper never points at nothing. **Reset demo** returns to step 1 state.

## 7. Copy

Use `docs/design-language.md` sections 1 and 2 for words and RAY's voice. No banned words on any merchant, customer or buyer screen. No developer terms outside Demo controls.

## 8. Speed

- Find what makes pages slow (per-request seeding, timer ticks on every request, unindexed queries, large client bundles) and fix it. Seed only on reset. Tick only when the clock moves.
- Add `npm run demo`: `next build && next start` on port 3000. Demos and recordings use this, not dev mode.
- Target: each page interactive under 1 second in `npm run demo`.

## 9. Checking the result

At the end of every phase: start `npm run demo`, take Playwright screenshots of every screen at 1440×900 and 390×844 into `docs/screenshots/<phase>/`, look at them, fix anything that is empty, misaligned, unreadable or off-spec, then report. Keep all existing tests passing; add a Playwright smoke test that walks the guided demo from step 1 to 10.

## 10. Coach-mark pop-ups (replaces plain nudge bars where a first-time user needs guiding)

- First visit to each screen: a sequence of 2 to 4 pop-ups anchored to real elements (arrow, one sentence, **Next** / **Got it**, step dots), e.g. Cases: "These need your tap" → "Sorted by money at stake" → "Open the biggest one".
- Pop-ups never repeat once dismissed (per browser), and "Show me around" in the account menu replays them.
- The guided demo (section 6) uses the same pop-up component.

## 11. RAY as guide: showing what's possible

A small merchant doesn't know what Razorpay and RAY can do. RAY tells them.
- **Home › "What RAY can do for you"**: cards for every capability, each marked **On**, **Try it**, or **Coming soon**: Fixes paid orders that didn't show up · Rescues declined cards abroad · Saves stopping subscriptions · Fights chargebacks · Chases overdue invoices · Tells you if it's you or Razorpay · Follows up your support tickets · Explains held settlements · Checks AI-chat orders · Plans your dues · Grows sales with features you already have · Builds your dashboard. **Try it** opens a short guided example on seeded data.
- **Proactive suggestions from RAY** (Home and Ask RAY): "Your carts above ₹5,000 drop at payment. Cardless EMI is off. Turn it on?" with ₹ estimate, trade-off, **Turn on** / **Not now**, and a two-weeks-later before/after card (Grow lane 1). "You chase invoices by hand. Want RAY to do it?" (opens Collect).
- **Ask RAY** answers "What can you do?" and "What should I set up first?" with the same capability list, ordered by the merchant's own data.

## 12. Custom dashboard, complete (extends 3.6)

- **Watch it for me:** each pinned widget compares with the merchant's normal for that hour and weekday; an unusual move shows a badge and a "Why?" that drills into method, bank or product, with one action that opens the right case.
- **Ask about this widget:** a ✦ button on each widget opens Ask RAY scoped to it; answers cite the numbers used.
- **Reports in words:** "Settlements for September with fees and GST" → preview table → 3-line summary on top → **Schedule to CA on WhatsApp** (simulated). A ready **Month-end CA pack**.
- Seed history so recommendations make sense ("You asked for success rate 4 times this week").

## 13. Every other design from the map, at demo depth

Each gets seeded cases in the Cases inbox with a full case page (findings, Your call, timeline), its own moment filter, and a "Try it" from section 11. They reuse the case page and shell; their logic is replayed and labelled Simulated where the engine has no flow. No new engine rules.
| Design | What to show |
|---|---|
| Is it me or Razorpay? | Success-rate drop alert; RAY splits it by method and bank; "HDFC netbanking down 7:40 to 8:10 PM (Razorpay downtime feed)"; your side vs Razorpay's side; hot fix "Re-enable your disabled webhook" with a tap; developer brief |
| Ticket went into a black hole | Open ticket with stage; RAY answers first from live data; chases on SLA with Escalate Now; "asked once, never again" note |
| Settlement held or account frozen | Plain reason, cash impact (₹ held, days), evidence pack checklist, timeline; LEA case shows the clock |
| AI-chat order went wrong | Order placed in a chat app; intent record vs order vs payment three-way check; drift flagged; fix proposed |
| Pay on time, stay liquid | A **Dues** page: one list of dues with dates, cash in bank, shortfall options, 43B(h) order; "Invoices in" from email with a duplicate flagged and a bank-change hold; odd bill flagged (jump vs last 3 months) with BBPS pay |
| Grow | Lever cards from section 11 with before/after results |

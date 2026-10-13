// A month of cases that already ended, and cases RAY is already handling,
// for Leafy Bakes (docs/ui-rebuild.md section 4). Each one gets its
// supporting records (customer, payment, order, dispute, invoice) and a full
// timeline through the case builder. The numbers on Home are computed from
// these rows, so the lists below are what make 23 closed cases, ₹1,84,300
// saved and 11.5 hours saved true.
import { formatDate, formatMoney, formatTime } from "@/guards/format";
import type { ProposedAction } from "@/engine/specialist";
import type { Db } from "../client";
import { createRepository } from "../repository";
import { createBuilder, type CaseSpec, type Step } from "./demo-build";
import { ABROAD, DAY, HISTORY_PEOPLE, HOUR, ist, LEAFY, MIN, rupees, type Person } from "./demo-people";

const money = (r: number) => formatMoney(rupees(r));
const first = (name: string) => name.split(/[\s,]+/)[0];
const WA = "wa:leafy-bakes";
const SUPPORT = "support@leafybakes.in";
const LB = (id: string) => id; // readable at the call sites

type Kind = "resolved" | "fixed" | "noreply" | "handled";
type Row = { n: number; person: string; amount: number; opened: string; kind: Kind; extra?: string };

// Paid, no order: nine that closed in the last 30 days.
const PNO: Row[] = [
  { n: 1, person: "Ananya Rao", amount: 1299, opened: "2026-09-15T11:12", kind: "resolved" },
  { n: 2, person: "Vikram Desai", amount: 899, opened: "2026-09-18T19:40", kind: "resolved", extra: "wa" },
  { n: 3, person: "Pooja Nambiar", amount: 2499, opened: "2026-09-21T09:05", kind: "resolved" },
  { n: 4, person: "Rohit Sethi", amount: 1899, opened: "2026-09-24T14:30", kind: "fixed" },
  // Charged twice: the same choice three times, which is why RAY suggests a rule for it.
  { n: 5, person: "Sneha Kulkarni", amount: 499, opened: "2026-09-27T16:20", kind: "resolved", extra: "twice" },
  { n: 6, person: "Arjun Bhat", amount: 6900, opened: "2026-10-01T10:45", kind: "resolved" },
  { n: 7, person: "Divya Menon", amount: 449, opened: "2026-10-06T12:10", kind: "resolved", extra: "twice" },
  { n: 8, person: "Manish Joshi", amount: 749, opened: "2026-10-04T21:15", kind: "noreply" },
  { n: 9, person: "Ritu Agarwal", amount: 349, opened: "2026-10-09T18:25", kind: "resolved", extra: "twice-wa" },
];
// And the month before (only the ones RAY saved matter for last month's number).
const PNO_OLD: Row[] = [
  { n: 11, person: "Tarun Gupta", amount: 3199, opened: "2026-08-17T10:05", kind: "resolved" },
  { n: 12, person: "Zoya Merchant", amount: 2299, opened: "2026-08-24T13:50", kind: "resolved", extra: "wa" },
  { n: 13, person: "Prakash Hegde", amount: 1499, opened: "2026-09-02T17:35", kind: "resolved" },
  { n: 14, person: "Aarti Deshmukh", amount: 899, opened: "2026-09-08T11:00", kind: "resolved", extra: "twice" },
];

const WRITES_EMAIL = [
  "Hi, money got deducted from my account for the order but it still shows pending. Please check.",
  "I paid and haven't got any confirmation. Can you look into it?",
  "Payment went through on my phone but your site says order pending. Help please.",
  "Paise kat gaye par order confirm nahi hua. Kripya check karein.",
];
const WRITES_WA = ["Bhaiya paise kat gaye, order abhi bhi pending dikha raha hai", "Payment ho gaya par confirmation nahi aaya, please check karo", "Hello? I paid 20 min ago and no order confirmation yet"];
const THANKS = ["mil gaya, thanks", "Got it, thank you!", "Order aa gaya, shukriya", "Received the confirmation, thanks"];

function personRows(db: Db, p: Person) {
  const repo = createRepository(db);
  if (!repo.customers.get(p.id)) repo.customers.insert({ id: p.id, merchant_id: LEAFY, name: p.name, email: p.email, phone: p.phone || null, country: p.country ?? "IN" });
}

let orderNo = 1100;

// Razorpay order + payment + store order for one paid-no-order or chargeback case.
function sale(db: Db, p: Person, amount: number, at: number, item: string, opts: { status?: "pending" | "completed" | "processing"; card?: boolean; key: string }) {
  const repo = createRepository(db);
  const no = ++orderNo;
  const orderId = `order_LBH${opts.key}`;
  const payId = `pay_LBH${opts.key}`;
  const utr = String(628_510_000_000 + no * 137).slice(0, 12);
  repo.rzpOrders.insert({ id: orderId, merchant_id: LEAFY, status: "paid", amount: rupees(amount), receipt: `wc_${no}`, created_at: at - 2 * MIN });
  repo.rzpPayments.insert({
    id: payId, merchant_id: LEAFY, order_id: orderId, status: "captured", amount: rupees(amount), method: opts.card ? "card" : "upi",
    contact: p.phone, email: p.email, vpa: opts.card ? null : `${first(p.name).toLowerCase()}@okaxis`, utr: opts.card ? null : utr,
    card_last4: opts.card ? String(4000 + (no % 900)) : null, card_country: opts.card ? "IN" : null, receipt: `wc_${no}`, created_at: at, captured_at: at + 5_000,
  });
  const status = opts.status ?? "completed";
  repo.storeOrders.insert({
    id: `so_LBH${opts.key}`, number: `#${no}`, merchant_id: LEAFY, customer_id: p.id, status,
    status_history: status === "completed" ? [{ status: "pending", at: at - 2 * MIN }, { status: "processing", at: at + 30 * MIN }, { status: "completed", at: at + 2 * DAY, note: "Shipped by courier" }] : [{ status: "pending", at: at - 2 * MIN }],
    razorpay_order_id: orderId, receipt: `wc_${no}`, payment_id: status === "pending" ? null : payId, total: rupees(amount),
    items: [{ name: item, qty: 1, price: rupees(amount), stock: 10 }], stock: 10, created_at: at - 2 * MIN,
  });
  return { no, orderId, payId, soId: `so_LBH${opts.key}`, utr };
}

const ITEMS = ["Chocolate box", "Banana bread loaf", "Cookie hamper", "Party cake, 2 kg", "Brownie tray", "Festive gift box"];

function pnoCase(db: Db, row: Row, old = false): CaseSpec {
  const p = HISTORY_PEOPLE.find((x) => x.name === row.person)!;
  personRows(db, p);
  const repo = createRepository(db);
  const t0 = ist(row.opened);
  const k = `${old ? "o" : "n"}${row.n}`;
  const sl = sale(db, p, row.amount, t0 - 38 * MIN, ITEMS[row.n % ITEMS.length], { status: row.kind === "fixed" ? "completed" : "pending", key: k });
  const amt = money(row.amount);
  const stamp = `${formatTime(t0 - 38 * MIN)} on ${formatDate(t0 - 38 * MIN)}`;
  const twice = row.extra?.startsWith("twice") ?? false;
  const wa = row.extra === "wa" || row.extra === "twice-wa";
  const channel = wa ? "whatsapp" : "email";
  const to = wa ? p.phone : p.email;
  const mine = wa ? WA : SUPPORT;
  const write = (wa ? WRITES_WA : WRITES_EMAIL)[row.n % (wa ? WRITES_WA.length : WRITES_EMAIL.length)];
  const caseId = `case_h_pno_${k}`;
  const keys = { email: p.email, phone: p.phone, paymentId: sl.payId };
  const steps: Step[] = [{ at: t0, kind: "webhook", event: "payment.captured", id: `evt_LBH${k}`, processed: row.kind === "fixed" }];
  if (row.kind === "fixed") {
    steps.push(
      { at: t0 + 2 * MIN, kind: "finding", source: "Razorpay", text: `Razorpay captured ${amt} at ${stamp}, so the money reached Razorpay.`, ref: sl.payId },
      { at: t0 + 100 * MIN, kind: "finding", source: "Store", text: `Order #${sl.no} updated to Processing on its own, about an hour and a half later.`, ref: sl.soId },
      { at: t0 + 101 * MIN, kind: "move", to: "fixed_itself", reason: "The store caught up on its own, so nothing was left to fix.", outcome: "fixed_itself" },
    );
  } else if (twice) {
    // Charged twice: the second payment is the extra one.
    const second = `${sl.payId}b`;
    const utr2 = String(Number(sl.utr) + 1);
    repo.rzpPayments.insert({
      id: second, merchant_id: LEAFY, order_id: sl.orderId, status: "captured", amount: rupees(row.amount), method: "upi", contact: p.phone, email: p.email,
      vpa: `${first(p.name).toLowerCase()}@okaxis`, utr: utr2, receipt: `wc_${sl.no}`, created_at: t0 - 36 * MIN, captured_at: t0 - 36 * MIN + 5_000,
    });
    repo.storeOrders.update(sl.soId, { status: "completed", payment_id: sl.payId });
    steps.push(
      { at: t0 + 2 * MIN, kind: "finding", source: "Razorpay", text: `Two payments of ${amt} came in two minutes apart for order #${sl.no}, UTRs ending ${sl.utr.slice(-4)} and ${utr2.slice(-4)}.`, ref: second },
      { at: t0 + 3 * MIN, kind: "finding", source: "Store", text: `Order #${sl.no} took the first payment, so the second ${amt} is extra.`, ref: sl.soId },
      { at: t0 + 4 * MIN, kind: "in", channel, from: to, to: mine, body: wa ? "Bhaiya do baar paise kat gaye, ek wapas karo" : "I was charged twice for the same order. Please refund the extra payment." },
      { at: t0 + 5 * MIN, kind: "move", to: "waiting_merchant", reason: "Sure: two payments, one order." },
      { at: t0 + 5 * MIN, kind: "proposals", actions: [{ id: `prop_${k}`, label: `Refund the extra ${amt}`, tool: "refund", args: { payment_id: second, amount: rupees(row.amount) }, covered: true }] },
      { at: t0 + 20 * MIN, kind: "action", tool: "refund", args: { payment_id: second, amount: rupees(row.amount) }, status: "done", approvedBy: "tap", result: { refund: `rfnd_LBH${k}`, status: "processed" } },
      { at: t0 + 20 * MIN, kind: "move", to: "acting", reason: "Merchant tapped approve" },
      { at: t0 + 21 * MIN, kind: "out", channel, to, from: mine, senderMode: wa ? "merchant_inbox" : "verified_domain", body: `Hi ${first(p.name)}, this is Leafy Bakes. We charged ${amt} twice for order #${sl.no} (UTRs ending ${sl.utr.slice(-4)} and ${utr2.slice(-4)}). We have refunded the extra ${amt}; it reaches your account in 5 to 7 working days.` },
      { at: t0 + 22 * MIN, kind: "move", to: "verifying", reason: "Refund started; checking the customer got it." },
      { at: t0 + 2 * DAY, kind: "in", channel, from: to, to: mine, body: "Got the refund, thanks." },
      { at: t0 + 2 * DAY + MIN, kind: "move", to: "closed", reason: "The customer confirmed the refund arrived.", outcome: "duplicate_refunded", saved: true },
    );
    repo.rzpRefunds.insert({ id: `rfnd_LBH${k}`, merchant_id: LEAFY, payment_id: second, status: "processed", amount: rupees(row.amount), created_at: t0 + 20 * MIN });
  } else {
    steps.push(
      { at: t0 + 2 * MIN, kind: "finding", source: "Razorpay", text: `Razorpay captured ${amt} at ${stamp}, so the money reached Razorpay.`, ref: sl.payId },
      { at: t0 + 3 * MIN, kind: "finding", source: "Store", ok: false, text: `Order #${sl.no} is still Pending with no payment on it.`, ref: sl.soId },
      { at: t0 + 4 * MIN, kind: "finding", source: "Razorpay", text: "Your site answered OK when Razorpay sent the payment update, so status codes alone say no issue.", ref: `evt_LBH${k}` },
      { at: t0 + 5 * MIN, kind: "finding", source: "Razorpay", text: "Another store on the same plugin version reported the same thing: an OK reply, then the order stayed Pending. Razorpay's plugin dropped it.", ref: "pr_woo_482_1" },
    );
    if (row.kind === "noreply") {
      steps.push(
        { at: t0 + 6 * MIN, kind: "move", to: "waiting_customer", reason: "Asked the customer to confirm the payment." },
        { at: t0 + 7 * MIN, kind: "out", channel, to, from: mine, senderMode: wa ? "merchant_inbox" : "verified_domain", body: `Hi ${first(p.name)}, this is Leafy Bakes. We can see your payment of ${amt} at ${stamp}, UTR ending ${sl.utr.slice(-4)}. You can check this in your UPI app. You'll hear from us with an update by ${formatTime(t0 + 2 * HOUR)}.` },
        { at: t0 + 72 * HOUR, kind: "move", to: "unconfirmed", reason: "No reply to the arrival check, so RAY stopped following up.", outcome: "closed_no_reply" },
      );
    } else {
      steps.push(
        { at: t0 + 6 * MIN, kind: "in", channel, from: to, to: mine, body: write },
        { at: t0 + 7 * MIN, kind: "move", to: "waiting_merchant", reason: "Sure: the payment, amount and order all match, and the plugin dropped the update." },
        {
          at: t0 + 7 * MIN, kind: "proposals",
          actions: [{ id: `prop_${k}`, label: "Mark paid & ship", tool: "mark_paid", args: { store_order_id: sl.soId, payment_id: sl.payId }, covered: true }],
        },
      );
      if (row.kind === "handled") {
        steps.push(
          { at: t0 + 30 * MIN, kind: "note", payload: { kind: "tap", choice: "handle_myself" } },
          { at: t0 + 30 * MIN, kind: "move", to: "closed", reason: "Merchant will handle it", outcome: "handled_by_merchant" },
        );
      } else {
        steps.push(
          { at: t0 + 22 * MIN, kind: "action", tool: "mark_paid", args: { store_order_id: sl.soId, payment_id: sl.payId }, status: "done", approvedBy: "tap", result: { order: `#${sl.no}`, status: "processing" } },
          { at: t0 + 22 * MIN, kind: "move", to: "acting", reason: "Merchant tapped approve" },
          { at: t0 + 23 * MIN, kind: "out", channel, to, from: mine, senderMode: wa ? "merchant_inbox" : "verified_domain", body: `Hi ${first(p.name)}, this is Leafy Bakes. We got your payment of ${amt} at ${stamp}, UTR ending ${sl.utr.slice(-4)}, and your order #${sl.no} is confirmed.` },
          { at: t0 + 24 * MIN, kind: "move", to: "verifying", reason: "Order marked paid; checking the customer got it." },
          { at: t0 + 3 * HOUR, kind: "in", channel, from: to, to: mine, body: THANKS[row.n % THANKS.length] },
          { at: t0 + 3 * HOUR + MIN, kind: "move", to: "closed", reason: "The customer confirmed the order arrived.", outcome: "arrived", saved: true },
        );
      }
    }
  }
  return {
    id: caseId, merchantId: LEAFY, moment: "paid_no_order", situation: twice ? "E" : "B", confidence: "sure", side: twice ? "merchant" : "razorpay", plugin: !twice, covered: true,
    amount: rupees(row.amount), paymentId: sl.payId, storeOrderId: sl.soId, cause: twice ? "duplicate_charge" : "plugin_dropped_capture", openedAt: t0, keys,
    alert: twice ? `${p.name} was charged ${amt} twice for order #${sl.no}.` : `${p.name} paid ${amt} but order #${sl.no} is still Pending.`, steps,
  };
}

// Card declined abroad: five that closed (three resolved), and last month's two.
type Intl = { n: number; person: string; amountInr: number; foreign: string; opened: string; kind: "resolved" | "fixed" | "noreply"; why: string; fix: string };
const INTL: Intl[] = [
  { n: 1, person: "Grace Turner", amountInr: 8300, foreign: "$100", opened: "2026-09-17T08:20", kind: "resolved", why: "her bank blocked international card payments", fix: "PayPal" },
  { n: 2, person: "Daniel Whitfield", amountInr: 12450, foreign: "£120", opened: "2026-09-29T21:10", kind: "resolved", why: "the card is not switched on for online payments abroad", fix: "a new payment link" },
  { n: 3, person: "Hannah Weber", amountInr: 5411, foreign: "€59", opened: "2026-10-05T07:45", kind: "resolved", why: "the bank asked for an extra check that timed out", fix: "a new payment link" },
  { n: 4, person: "Mei Tan", amountInr: 4150, foreign: "S$67", opened: "2026-10-08T22:30", kind: "noreply", why: "her bank declined the payment", fix: "PayPal" },
];
const INTL_OLD: Intl[] = [
  { n: 11, person: "Grace Turner", amountInr: 9850, foreign: "$118", opened: "2026-08-20T09:15", kind: "resolved", why: "her bank blocked international card payments", fix: "PayPal" },
  { n: 12, person: "Daniel Whitfield", amountInr: 8154, foreign: "£78", opened: "2026-09-05T20:00", kind: "resolved", why: "the card is not switched on for online payments abroad", fix: "a new payment link" },
];

function intlCase(db: Db, row: Intl, old = false): CaseSpec {
  const p = ABROAD.find((x) => x.name === row.person)!;
  personRows(db, p);
  const repo = createRepository(db);
  const k = `${old ? "o" : "n"}${row.n}`;
  const t0 = ist(row.opened);
  const payId = `pay_LBI${k}`;
  const amt = money(row.amountInr);
  const cur = row.foreign.startsWith("$") ? "USD" : row.foreign.startsWith("£") ? "GBP" : row.foreign.startsWith("€") ? "EUR" : "SGD";
  repo.rzpOrders.insert({ id: `order_LBI${k}`, merchant_id: LEAFY, status: "attempted", amount: Math.round(rupees(row.amountInr) / 83), currency: cur, receipt: `lb_intl_${k}`, created_at: t0 - 2 * MIN });
  repo.rzpPayments.insert({
    id: payId, merchant_id: LEAFY, order_id: `order_LBI${k}`, status: "failed", amount: Math.round(rupees(row.amountInr) / 83), currency: cur, base_amount: rupees(row.amountInr),
    method: "card", email: p.email, card_last4: String(4200 + row.n), card_country: p.country, error_code: "BAD_REQUEST_ERROR", error_source: "issuer",
    error_reason: "international_transaction_not_allowed", receipt: `lb_intl_${k}`, created_at: t0, captured_at: null,
  });
  const linkId = `plink_LBI${k}`;
  const url = `https://pay.sim.example/l/LBI${k}`;
  repo.rzpLinks.insert({ id: linkId, merchant_id: LEAFY, payment_id: null, short_url: url, status: row.kind === "resolved" ? "paid" : "created", amount: Math.round(rupees(row.amountInr) / 83), currency: cur, created_at: t0 + 4 * MIN });
  const body = `Hi ${first(p.name)}, this is Leafy Bakes. Your payment of ${row.foreign} (${amt}) on ${formatDate(t0)} did not go through because ${row.why}. You can finish your order with ${row.fix} here: ${url}`;
  const steps: Step[] = [
    { at: t0, kind: "webhook", event: "payment.failed", id: `evt_LBI${k}`, processed: true },
    { at: t0 + MIN, kind: "finding", source: "Razorpay", text: `${row.foreign} (${amt}) was declined: ${row.why}.`, ref: payId },
    { at: t0 + 2 * MIN, kind: "finding", source: "Bank", text: "Razorpay's checks were clean, so this was the card issuer's decision, not a fraud block.", ref: payId },
    { at: t0 + 3 * MIN, kind: "move", to: "waiting_customer", reason: "Sent the customer a way to finish paying." },
    { at: t0 + 4 * MIN, kind: "out", channel: "email", to: p.email, from: SUPPORT, senderMode: "verified_domain", body },
  ];
  if (row.kind === "noreply") {
    steps.push({ at: t0 + 72 * HOUR, kind: "move", to: "unconfirmed", reason: "No reply or payment in 72 hours, so RAY stopped following up.", outcome: "closed_no_reply" });
  } else if (row.n % 3 === 0) {
    steps.push(
      { at: t0 + 6 * HOUR, kind: "in", channel: "email", from: p.email, to: SUPPORT, body: "Tried again with the link, it went through this time. Thanks!" },
      { at: t0 + 6 * HOUR + MIN, kind: "move", to: "verifying", reason: "The customer says it worked; checking the payment." },
      { at: t0 + 6 * HOUR + 2 * MIN, kind: "move", to: "closed", reason: "The payment arrived.", outcome: "paid_after_link", saved: true },
    );
  } else {
    steps.push(
      { at: t0 + 3 * HOUR, kind: "in", channel: "email", from: p.email, to: SUPPORT, body: `Thanks, paid with ${row.fix === "PayPal" ? "PayPal" : "the link"} just now.` },
      { at: t0 + 3 * HOUR + MIN, kind: "move", to: "verifying", reason: "The customer says it worked; checking the payment." },
      { at: t0 + 3 * HOUR + 2 * MIN, kind: "move", to: "closed", reason: "The payment arrived.", outcome: "paid_after_link", saved: true },
    );
  }
  return {
    id: `case_h_intl_${k}`, merchantId: LEAFY, moment: "international", situation: "F", confidence: "sure", side: "customer_or_bank", amount: rupees(row.amountInr),
    paymentId: payId, cause: "international_declined", openedAt: t0, keys: { email: p.email, paymentId: payId },
    alert: `${p.name}'s ${row.foreign} (${amt}) payment was declined.`, steps,
  };
}

// Subscription stopped.
type Sub = { n: number; person: string; amount: number; opened: string; months: number };
const SUBS: Sub[] = [
  { n: 1, person: "Faisal Khan", amount: 499, opened: "2026-09-20T10:30", months: 1 },
  { n: 2, person: "Tanvi Shah", amount: 499, opened: "2026-10-03T08:10", months: 1 },
  { n: 3, person: "Nikhil Verma", amount: 1497, opened: "2026-10-10T13:25", months: 3 },
];

function subCase(db: Db, row: Sub): CaseSpec {
  const p = HISTORY_PEOPLE.find((x) => x.name === row.person)!;
  personRows(db, p);
  const t0 = ist(row.opened);
  const amt = money(row.amount);
  const link = `https://pay.sim.example/i/inv_LBH_sub${row.n}`;
  return {
    id: `case_h_sub_${row.n}`, merchantId: LEAFY, moment: "subscription", situation: "B", confidence: "sure", side: "customer_or_bank", amount: rupees(row.amount),
    cause: "retries_ran_out", openedAt: t0, keys: { phone: p.phone, email: p.email }, alert: `${p.name}'s ${amt} cookie box payment failed and Razorpay's retries ran out.`,
    steps: [
      { at: t0, kind: "webhook", event: "subscription.halted", id: `evt_LBH_sub${row.n}` },
      { at: t0 + MIN, kind: "finding", source: "Razorpay", text: `The monthly cookie box payment of ${amt} failed three times: insufficient balance in the bank account.`, ref: `inv_LBH_sub${row.n}` },
      { at: t0 + 2 * MIN, kind: "finding", source: "Razorpay", text: "The mandate is still active, so the same invoice can be paid with its link and the plan carries on.", ref: `inv_LBH_sub${row.n}` },
      { at: t0 + 3 * MIN, kind: "move", to: "confirmed", reason: "Sure: retries ran out on an active mandate." },
      { at: t0 + 4 * MIN, kind: "move", to: "waiting_customer", reason: "Sending the invoice's own link; no tap needed." },
      { at: t0 + 5 * MIN, kind: "out", channel: "whatsapp", to: p.phone, from: WA, senderMode: "merchant_inbox", template: "subscription_payment_due", body: `Hi ${first(p.name)}, your Monthly cookie box payment of ${amt} to Leafy Bakes did not go through. Pay here: ${link}` },
      { at: t0 + 5 * HOUR, kind: "in", channel: "whatsapp", from: p.phone, to: WA, body: "paid, salary aa gayi thi aaj" },
      { at: t0 + 5 * HOUR + MIN, kind: "move", to: "verifying", reason: "The customer says they paid; checking the invoice." },
      { at: t0 + 5 * HOUR + 2 * MIN, kind: "move", to: "closed", reason: "The invoice is paid and the plan is active again.", outcome: "active_again", saved: true },
    ],
  };
}

// Chargebacks.
type Cb = { n: number; person: string; amount: number; opened: string; created: string; kind: "won" | "handled" | "lost"; reason: string; code: string; network: string };
const CBS: Cb[] = [
  { n: 1, person: "Isha Kapoor", amount: 5400, opened: "2026-09-19T11:00", created: "2026-09-19T10:20", kind: "won", reason: "Product not received", code: "13.1", network: "Visa" },
  { n: 2, person: "Harish Patel", amount: 3200, opened: "2026-10-02T12:30", created: "2026-10-02T11:50", kind: "won", reason: "Duplicate charge", code: "4834", network: "Mastercard" },
  { n: 3, person: "Lakshmi Iyer", amount: 2150, opened: "2026-10-05T09:40", created: "2026-10-05T09:00", kind: "won", reason: "Product not received", code: "13.1", network: "Visa" },
  { n: 4, person: "Gaurav Malhotra", amount: 2950, opened: "2026-09-25T15:10", created: "2026-09-25T14:30", kind: "handled", reason: "Not as described", code: "13.3", network: "Visa" },
];
const CB_OLD: Cb[] = [
  { n: 11, person: "Zoya Merchant", amount: 8400, opened: "2026-08-22T10:10", created: "2026-08-22T09:30", kind: "won", reason: "Product not received", code: "13.1", network: "Visa" },
  { n: 12, person: "Tarun Gupta", amount: 6900, opened: "2026-09-03T14:15", created: "2026-09-03T13:40", kind: "won", reason: "Duplicate charge", code: "4834", network: "Mastercard" },
];

function cbCase(db: Db, row: Cb, old = false): CaseSpec {
  const p = HISTORY_PEOPLE.find((x) => x.name === row.person)!;
  personRows(db, p);
  const repo = createRepository(db);
  const k = `${old ? "o" : "n"}${row.n}`;
  const t0 = ist(row.opened);
  const sl = sale(db, p, row.amount, t0 - 9 * DAY, ITEMS[row.n % ITEMS.length], { card: true, key: `c${k}` });
  const dispId = `disp_LBH${k}`;
  const amt = money(row.amount);
  repo.disputes.insert({
    id: dispId, merchant_id: LEAFY, payment_id: sl.payId, amount: rupees(row.amount), reason_code: row.code, reason: row.reason, network: row.network, phase: "chargeback",
    deducted: true, respond_by: t0 + 7 * DAY, status: row.kind === "handled" ? "closed" : "won", lane: null, created_at: ist(row.created),
  });
  const steps: Step[] = [
    { at: t0, kind: "webhook", event: "payment.dispute.created", id: `evt_LBH_cb${k}` },
    { at: t0 + MIN, kind: "finding", source: "Razorpay", text: `${p.name} disputed ${amt} with their bank: ${row.reason.toLowerCase()}. The money was already taken back from your balance.`, ref: dispId },
    { at: t0 + 2 * MIN, kind: "finding", source: "Store", text: row.reason === "Duplicate charge" ? `Only one payment of ${amt} exists for order #${sl.no}; the second charge was never taken.` : `Order #${sl.no} was shipped by courier two days after payment and marked Completed.`, ref: sl.soId },
    { at: t0 + 3 * MIN, kind: "move", to: "waiting_merchant", reason: row.kind === "handled" ? "Needs the merchant's call." : "Strong proof; asking before contesting." },
    {
      at: t0 + 3 * MIN, kind: "proposals",
      actions: [{ id: `prop_cb${k}`, label: "Contest dispute", tool: "contest_dispute", args: { dispute_id: dispId }, covered: false }],
    },
  ];
  if (row.kind === "handled") {
    steps.push(
      { at: t0 + 2 * HOUR, kind: "note", payload: { kind: "tap", choice: "handle_myself" } },
      { at: t0 + 2 * HOUR, kind: "move", to: "closed", reason: "Merchant will handle it", outcome: "handled_by_merchant" },
    );
  } else {
    steps.push(
      { at: t0 + 90 * MIN, kind: "action", tool: "contest_dispute", args: { dispute_id: dispId }, status: "done", approvedBy: "tap", result: { filed: true } },
      { at: t0 + 90 * MIN, kind: "move", to: "acting", reason: "Merchant tapped approve" },
      { at: t0 + 91 * MIN, kind: "move", to: "verifying", reason: "Reply filed with the bank; waiting for the result." },
      { at: t0 + 6 * DAY, kind: "note", payload: { kind: "dispute_outcome", outcome: "won", dispute_id: dispId } },
      { at: t0 + 6 * DAY, kind: "move", to: "closed", reason: "The bank ruled for you; the money is back in your balance.", outcome: "won", saved: true },
    );
  }
  return {
    id: `case_h_cb_${k}`, merchantId: LEAFY, moment: "chargeback", situation: row.reason === "Duplicate charge" ? "D" : "C", confidence: "sure", side: "customer_or_bank",
    amount: rupees(row.amount), paymentId: sl.payId, storeOrderId: sl.soId, cause: "dispute", openedAt: t0, keys: { email: p.email, phone: p.phone, paymentId: sl.payId },
    alert: `${p.name} disputed ${amt} (${row.reason.toLowerCase()}). Reply by ${formatDate(t0 + 7 * DAY)}.`, steps,
  };
}

// Invoice overdue: three that were paid (this month) and two from last month.
type Col = { n: number; invoice: string; opened: string; paid: string };
const COLS: Col[] = [
  { n: 1, invoice: "inv_LB_098", opened: "2026-09-19T10:00", paid: "2026-09-26T12:20" },
  { n: 2, invoice: "inv_LB_101", opened: "2026-09-23T10:00", paid: "2026-10-02T15:05" },
  { n: 3, invoice: "inv_LB_096", opened: "2026-09-27T10:00", paid: "2026-10-08T11:40" },
];
const COLS_OLD: Col[] = [
  { n: 11, invoice: "inv_LB_083", opened: "2026-08-17T10:00", paid: "2026-08-28T16:10" },
  { n: 12, invoice: "inv_LB_087", opened: "2026-08-25T10:00", paid: "2026-08-30T10:30" },
];

function colCase(db: Db, row: Col): CaseSpec {
  const repo = createRepository(db);
  const inv = repo.invoices.get(row.invoice)!;
  const buyer = repo.buyers.get(inv.buyer_id)!;
  const t0 = ist(row.opened);
  const paid = ist(row.paid);
  const amt = formatMoney(inv.amount);
  const day = formatDate(inv.due_date);
  return {
    id: `case_h_col_${row.n}`, merchantId: LEAFY, moment: "collect", confidence: "sure", side: "customer_or_bank", amount: inv.amount, cause: "invoice_overdue", openedAt: t0,
    keys: { email: buyer.email ?? undefined, phone: buyer.phone ?? undefined }, alert: `${buyer.name} has not paid invoice ${inv.number} (${amt}), due ${day}.`,
    steps: [
      { at: t0, kind: "note", payload: { kind: "invoice_overdue", invoice_id: inv.id } , ref: inv.id },
      { at: t0 + MIN, kind: "finding", source: "Bank", ok: false, text: `Invoice ${inv.number} for ${amt} was due on ${day} and no bank credit matches it yet.`, ref: inv.id },
      { at: t0 + 2 * MIN, kind: "finding", source: "Customer", text: `${buyer.name}: ${buyer.pay_history}`, ref: buyer.id },
      { at: t0 + 3 * MIN, kind: "move", to: "confirmed", reason: "Sure: the invoice is overdue and the buyer opted in to email." },
      { at: t0 + 4 * MIN, kind: "move", to: "waiting_customer", reason: "Sent the first reminder under your reminder rule." },
      { at: t0 + 5 * MIN, kind: "out", channel: "email", to: buyer.email!, from: SUPPORT, senderMode: "verified_domain", body: `Hello ${first(buyer.contact_name)}, invoice ${inv.number} for ${amt} from Leafy Bakes was due on ${day}. Please reply with the date you plan to pay.` },
      { at: t0 + 2 * DAY, kind: "in", channel: "email", from: buyer.email!, to: SUPPORT, body: `Thanks for the reminder. Payment will go out on ${formatDate(paid)}.` },
      { at: paid, kind: "note", payload: { kind: "bank_credit_matched", invoice_id: inv.id, amount: inv.amount }, ref: inv.id },
      { at: paid + MIN, kind: "move", to: "verifying", reason: "A bank credit matches the invoice; checking it." },
      { at: paid + 2 * MIN, kind: "move", to: "closed", reason: `The bank credit of ${amt} matched invoice ${inv.number}.`, outcome: "collected", saved: true },
    ],
  };
}

export function seedHistory(db: Db) {
  const b = createBuilder(db);
  const repo = createRepository(db);
  const specs: CaseSpec[] = [];
  for (const r of PNO) specs.push(pnoCase(db, r));
  for (const r of INTL) specs.push(intlCase(db, r));
  for (const r of SUBS) specs.push(subCase(db, r));
  for (const r of CBS) specs.push(cbCase(db, r));
  for (const r of COLS) specs.push(colCase(db, r));
  // Last month: only what RAY saved, for the "vs last month" number.
  for (const r of PNO_OLD) specs.push(pnoCase(db, r, true));
  for (const r of INTL_OLD) specs.push(intlCase(db, r, true));
  for (const r of CB_OLD) specs.push(cbCase(db, r, true));
  for (const r of COLS_OLD) specs.push(colCase(db, r));
  for (const spec of specs) b.build(spec);
  return { count: specs.length, repo, b };
}

export type { ProposedAction };
export { LB };

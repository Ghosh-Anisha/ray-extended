// The cases RAY is already handling on Tue 13 Oct, 10:00 AM (docs/ui-rebuild.md
// section 4, "RAY is handling"). The chargeback with the Stop window is not
// here: it runs through the engine in demo.ts. These are built through the
// case builder, with their timers, promises and links in the same tables the
// flows read.
import { createVoice, loadVoiceConfig } from "@/adapters/voice";
import { merchantCallNumber } from "@/adapters/voice";
import { CHECK_TIMER } from "@/flows/collect/data";
import { TIMERS } from "@/flows/paid-no-order";
import { formatDate, formatTime } from "@/guards/format";
import type { Db } from "../client";
import { createRepository } from "../repository";
import { createBuilder, stubClock, type Builder, type CaseSpec } from "./demo-build";
import { ABROAD, BUYERS, DAY, HOUR, ist, KARAN, LEAFY, MIN, rupees } from "./demo-people";

const WA = "wa:leafy-bakes";
const SUPPORT = "support@leafybakes.in";

export const HANDLING_REFS = { emma: "RD-1048", oliver: "RD-1049", ankit: "RD-1050", acme: "RD-1052", sunrise: "RD-1054", meera: "RD-1055", deepa: "RD-1056", imran: "RD-1057" } as const;

// Subscription records for the three Leafy subscribers (Karan, Meera, Imran).
export function seedLeafySubscriptions(db: Db, now: number) {
  const repo = createRepository(db);
  const month = 30 * DAY;
  repo.customers.insert({ id: KARAN.id, merchant_id: LEAFY, name: KARAN.name, email: KARAN.email, phone: KARAN.phone });
  repo.messagingConsents.insertMany([
    { id: "cons_lb_karan_wa", customer_id: KARAN.id, channel: "whatsapp", status: "opted_in", source: "checkout", updated_at: now - 200 * DAY },
    { id: "cons_lb_karan_call", customer_id: KARAN.id, channel: "call", status: "opted_in", source: "checkout", updated_at: now - 200 * DAY },
  ]);
  const subs = [
    { id: "sub_LB_karan", customer_id: KARAN.id, status: "active" as const, started: now - 8 * month - 6 * DAY, ltv: rupees(4252), pending: null as string | null, mandate: "UMNLEAFY2210" },
    { id: "sub_LB_meera", customer_id: "cus_meera", status: "paused" as const, started: now - 5 * month - 2 * DAY, ltv: rupees(2495), pending: null, mandate: "UMNLEAFY2211" },
    { id: "sub_LB_imran", customer_id: "cus_imran", status: "pending" as const, started: now - 2 * month - 9 * DAY, ltv: rupees(998), pending: "inv_LB_imran_3", mandate: "UMNLEAFY2212" },
  ];
  for (const sub of subs) {
    repo.subscriptions.insert({
      id: sub.id, merchant_id: LEAFY, customer_id: sub.customer_id, status: sub.status, plan: "Monthly cookie box", amount: rupees(499), retries_left: sub.status === "pending" ? 2 : 3,
      pending_invoice_id: sub.pending, b2b: false, lifetime_value: sub.ltv, resume_at: sub.id === "sub_LB_meera" ? ist("2026-11-01T10:00") : null, started_at: sub.started,
    });
    repo.mandates.insert({
      id: `mdt_${sub.id.slice(4)}`, subscription_id: sub.id, method: "upi_autopay", token_id: `token_${sub.id.slice(4)}`, status: "active", max_amount: rupees(2000),
      authorised_at: sub.started + MIN, auth_ref: sub.mandate,
    });
    const cycles = sub.id === "sub_LB_imran" ? 3 : 6;
    for (let n = 1; n <= cycles; n++) {
      const start = now - (cycles - n + 1) * month + 3 * DAY;
      const last = n === cycles && sub.id === "sub_LB_imran";
      repo.subInvoices.insert({
        id: `inv_LB_${sub.id.slice(7)}_${n}`, subscription_id: sub.id, amount: rupees(499), status: last ? "issued" : "paid", attempts: last ? 3 : 1,
        error_reason: last ? "Insufficient balance in bank account" : null, billing_start: start, billing_end: start + month, notified_at: start - DAY,
      });
    }
  }
  repo.merchants.update(LEAFY, { sub_discount_offer_id: "offer_LB_20off", sub_discount_percent: 20 });
}

export async function seedHandling(db: Db): Promise<Builder> {
  const b = createBuilder(db);
  const repo = createRepository(db);
  const specs: CaseSpec[] = [];
  // Work that needs the case to exist first (the Simulated call).
  const afterBuild: (() => Promise<void>)[] = [];
  const stamp = (t: number) => `${formatTime(t)} on ${formatDate(t)}`;

  // ---- Emma Clarke, $49: bank blocked a card abroad; a PayPal link went out last night.
  {
    const emma = ABROAD[0];
    const t0 = ist("2026-10-12T21:40");
    repo.customers.insert({ id: emma.id, merchant_id: LEAFY, name: emma.name, email: emma.email, phone: null, country: "US" });
    repo.rzpOrders.insert({ id: "order_LB_emma", merchant_id: LEAFY, status: "attempted", amount: 4_900, currency: "USD", receipt: "lb_gift_882", created_at: t0 - 2 * MIN });
    repo.rzpPayments.insert({
      id: "pay_LB_emma_failed", merchant_id: LEAFY, order_id: "order_LB_emma", status: "failed", amount: 4_900, currency: "USD", base_amount: rupees(4100), method: "card",
      email: emma.email, card_last4: "4242", card_country: "US", error_code: "BAD_REQUEST_ERROR", error_source: "issuer", error_reason: "international_transaction_not_allowed",
      receipt: "lb_gift_882", created_at: t0,
    });
    const url = "https://pay.sim.example/l/LBemma49";
    repo.rzpLinks.insert({ id: "plink_LB_emma", merchant_id: LEAFY, payment_id: null, short_url: url, status: "created", amount: 4_900, currency: "USD", created_at: t0 + 4 * MIN });
    specs.push({
      id: "case_demo_emma", merchantId: LEAFY, moment: "international", situation: "F", confidence: "sure", side: "customer_or_bank", amount: rupees(4100), paymentId: "pay_LB_emma_failed",
      cause: "international_declined", openedAt: t0, ref: HANDLING_REFS.emma, keys: { email: emma.email, paymentId: "pay_LB_emma_failed" },
      alert: "Emma Clarke's $49 (₹4,100) payment was declined.",
      steps: [
        { at: t0, kind: "webhook", event: "payment.failed", id: "evt_LB_emma_failed" },
        { at: t0 + MIN, kind: "finding", source: "Razorpay", text: "$49 (₹4,100) was declined: the card is not enabled for international payments.", ref: "pay_LB_emma_failed" },
        { at: t0 + 2 * MIN, kind: "finding", source: "Bank", text: "Razorpay's checks were clean, so this was the card issuer's decision, not a fraud block.", ref: "pay_LB_emma_failed" },
        { at: t0 + 3 * MIN, kind: "move", to: "waiting_customer", reason: "Sent the customer a PayPal link to finish the order." },
        { at: t0 + 4 * MIN, kind: "out", channel: "email", to: emma.email, from: SUPPORT, senderMode: "verified_domain", body: `Hi Emma, this is Leafy Bakes. Your payment of $49 (₹4,100) on ${formatDate(t0)} for the festive gift box did not go through because your bank blocked international card payments. You can finish your order with PayPal here: ${url}` },
      ],
    });
  }

  // ---- Oliver Bennett, £2,800: above the international limit; RAY drafted the request to Razorpay.
  {
    const oliver = ABROAD[1];
    const t0 = ist("2026-10-13T07:50");
    repo.customers.insert({ id: oliver.id, merchant_id: LEAFY, name: oliver.name, email: oliver.email, phone: null, country: "GB" });
    repo.rzpOrders.insert({ id: "order_LB_oliver", merchant_id: LEAFY, status: "attempted", amount: 280_000, currency: "GBP", receipt: "lb_corp_2041", created_at: t0 - 2 * MIN });
    repo.rzpPayments.insert({
      id: "pay_LB_oliver_failed", merchant_id: LEAFY, order_id: "order_LB_oliver", status: "failed", amount: 280_000, currency: "GBP", base_amount: rupees(310_000), method: "card",
      email: oliver.email, card_last4: "8810", card_country: "GB", error_code: "BAD_REQUEST_ERROR", error_source: "business", error_reason: "amount_exceeds_maximum_amount_allowed",
      receipt: "lb_corp_2041", created_at: t0,
    });
    specs.push({
      id: "case_demo_oliver", merchantId: LEAFY, moment: "international", situation: "F", confidence: "sure", side: "razorpay", amount: rupees(310_000), paymentId: "pay_LB_oliver_failed",
      cause: "above_international_limit", openedAt: t0, ref: HANDLING_REFS.oliver, keys: { email: oliver.email, paymentId: "pay_LB_oliver_failed" },
      alert: "Oliver Bennett's £2,800 (₹3.1 lakh) payment was declined.",
      steps: [
        { at: t0, kind: "webhook", event: "payment.failed", id: "evt_LB_oliver_failed" },
        { at: t0 + MIN, kind: "finding", source: "Razorpay", text: "£2,800 (₹3.1 lakh) is above the ₹2 lakh limit on international payments for your account.", ref: "pay_LB_oliver_failed" },
        { at: t0 + 2 * MIN, kind: "finding", source: "Bank", text: "The card itself is fine: the same card paid a smaller amount earlier this year.", ref: "pay_LB_oliver_failed" },
        { at: t0 + 4 * MIN, kind: "move", to: "waiting_merchant", reason: "Raising the limit is Razorpay's decision; RAY drafted the request." },
        { at: t0 + 4 * MIN, kind: "proposals", actions: [{ id: "prop_oliver", label: "Send limit request to Razorpay", tool: "send_message", args: { to: "support@razorpay.example.com", channel: "email", body: "Please raise our international limit to ₹4 lakh for a corporate order of £2,800." }, covered: false }] },
        { at: t0 + 40 * MIN, kind: "action", tool: "send_message", args: { to: "support@razorpay.example.com", channel: "email", body: "Please raise our international limit to ₹4 lakh for a corporate order of £2,800. Payment pay_LB_oliver_failed failed because the amount exceeded the current account limit." }, status: "done", approvedBy: "tap", result: { sent: true, recipient: "support@razorpay.example.com", audience: "Razorpay support", simulated: true } },
        { at: t0 + 40 * MIN, kind: "move", to: "acting", reason: "Merchant tapped approve" },
        { at: t0 + 41 * MIN, kind: "note", payload: { kind: "approval_handled", to: "verifying", reason: "Request sent to Razorpay. They usually answer in 2 working days." } },
        { at: t0 + 41 * MIN, kind: "move", to: "verifying", reason: "Waiting for Razorpay to answer the limit request." },
      ],
    });
  }

  // ---- ankit.s, ₹2,150: says he paid yesterday; no matching payment, so RAY asked for the UTR.
  {
    const t0 = ist("2026-10-13T08:55");
    const ankit = repo.customers.get("cus_ankit")!;
    specs.push({
      id: "case_demo_ankit", merchantId: LEAFY, moment: "paid_no_order", situation: "E", confidence: "likely", side: "customer_or_bank", amount: rupees(2150), cause: "no_matching_payment", openedAt: t0,
      ref: HANDLING_REFS.ankit, keys: { phone: ankit.phone! }, alert: "ankit.s says he paid ₹2,150 but no payment matches yet.",
      steps: [
        { at: t0, kind: "in", channel: "whatsapp", from: ankit.phone!, to: WA, body: "Maine kal 2150 pay kiya tha, order nahi aaya" },
        { at: t0 + MIN, kind: "finding", source: "Customer", text: "ankit.s says he paid ₹2,150 yesterday and the order did not come." },
        { at: t0 + 2 * MIN, kind: "finding", source: "Razorpay", ok: false, text: "No payment of ₹2,150 from this number in the last 48 hours.", ref: "order_LB1235" },
        { at: t0 + 3 * MIN, kind: "finding", source: "Razorpay", text: "A screenshot or UTR alone does not count; RAY needs the UTR to match it to Razorpay's own record.", ref: "order_LB1235" },
        { at: t0 + 4 * MIN, kind: "move", to: "waiting_customer", reason: "Asked ankit.s for the UTR or the bank statement line." },
        { at: t0 + 5 * MIN, kind: "out", channel: "whatsapp", from: WA, to: ankit.phone!, senderMode: "merchant_inbox", body: "Hi ankit.s, this is Leafy Bakes. We could not find a payment of ₹2,150 from this number yet. Could you send the UTR from your UPI app, or a screenshot of the payment? We will check it against our payment record and get back to you by 12:00 PM." },
      ],
    });
  }

  // ---- Acme Corporate Gifts, ₹48,000: promised Friday; RAY called and logged the promise.
  {
    const buyer = BUYERS.find((x) => x.id === "buy_lb_acme")!;
    const t0 = ist("2026-10-05T10:00");
    const call = ist("2026-10-12T16:10");
    const friday = ist("2026-10-16T10:00");
    specs.push({
      id: "case_demo_acme", merchantId: LEAFY, moment: "collect", confidence: "sure", side: "customer_or_bank", amount: rupees(48_000), cause: "invoice_overdue", openedAt: t0,
      ref: HANDLING_REFS.acme, keys: { email: buyer.email, phone: buyer.phone }, alert: "Acme Corporate Gifts has not paid invoice LB/26-27/118 (₹48,000), due 3 Oct.",
      steps: [
        { at: t0, kind: "note", payload: { kind: "invoice_overdue", invoice_id: "inv_LB_118" }, ref: "inv_LB_118" },
        { at: t0 + MIN, kind: "finding", source: "Bank", ok: false, text: "Invoice LB/26-27/118 for ₹48,000 was due on 3 Oct and no bank credit matches it.", ref: "inv_LB_118" },
        { at: t0 + 2 * MIN, kind: "finding", source: "Customer", text: `Acme Corporate Gifts: ${buyer.history}`, ref: buyer.id },
        { at: t0 + 3 * MIN, kind: "move", to: "confirmed", reason: "Sure: overdue invoice, buyer opted in to email." },
        { at: t0 + 4 * MIN, kind: "move", to: "waiting_customer", reason: "Sent the first reminder under your reminder rule." },
        { at: t0 + 5 * MIN, kind: "out", channel: "email", to: buyer.email, from: SUPPORT, senderMode: "verified_domain", body: "Hello Meenal, invoice LB/26-27/118 for ₹48,000 from Leafy Bakes was due on 3 Oct. Please reply with the date you plan to pay." },
        { at: ist("2026-10-09T11:30"), kind: "in", channel: "email", from: buyer.email, to: SUPPORT, body: "Hi, sorry for the delay. Our accounts team is releasing a batch on Friday. We will pay this one then." },
      ],
    });
    // The call and the promise it produced (a Simulated call).
    const stub = stubClock(call);
    const voice = createVoice(db, stub, loadVoiceConfig({}));
    voice.setCallSim(buyer.phone, { outcome: "answered", reply: "Yes, it is in this Friday's payment run. I have the invoice in front of me.", promise: "Pay on Friday 16 Oct" });
    repo.promises.insert({ id: "prm_LB_acme", invoice_id: "inv_LB_118", buyer_id: buyer.id, promised_date: friday, amount: rupees(48_000), made_at: call, status: "open" });
    afterBuild.push(
      async () => {
        const rec = await voice.call({
          merchantId: LEAFY, caseId: "case_demo_acme", to: buyer.phone, calleeName: buyer.contact, from: merchantCallNumber(LEAFY), callerName: "Leafy Bakes",
          opening: "Hello Meenal, this is Leafy Bakes about invoice LB/26-27/118 for ₹48,000, due on 3 Oct.",
          lines: ["You mentioned Friday by email. Can you confirm the date so we can note it?"],
        });
        repo.caseEvents.insert({
          id: "cev_demo_acme_call", case_id: "case_demo_acme", at: call, type: "note",
          payload: { kind: "call_summary", call_kind: "collect_call", simulated: true, message_id: rec.messageId, outcome: rec.outcome, outcome_label: "Answered", duration_s: rec.durationS, promise: rec.promise, summary: rec.summary, transcript: rec.transcript, audio: rec.audio, audio_error: rec.audioError, opted_out: false },
          evidence_ref: rec.messageId,
        });
        repo.caseEvents.insert({ id: "cev_demo_acme_promise", case_id: "case_demo_acme", at: call + MIN, type: "note", payload: { kind: "promise_logged", promised: "Friday 16 Oct", amount: rupees(48_000) }, evidence_ref: "prm_LB_acme" });
        repo.timers.insert({ id: "tmr_demo_acme_promise", case_id: "case_demo_acme", kind: CHECK_TIMER, due_at: friday });
      },
    );
  }

  // ---- Sunrise Hotels, ₹1,12,000: a gentle reminder went out yesterday.
  {
    const buyer = BUYERS.find((x) => x.id === "buy_lb_sunrise")!;
    const t0 = ist("2026-10-07T10:00");
    specs.push({
      id: "case_demo_sunrise", merchantId: LEAFY, moment: "collect", confidence: "sure", side: "customer_or_bank", amount: rupees(112_000), cause: "invoice_overdue", openedAt: t0,
      ref: HANDLING_REFS.sunrise, keys: { email: buyer.email, phone: buyer.phone }, alert: "Sunrise Hotels has not paid invoice LB/26-27/112 (₹1.1 lakh), due 28 Sep.",
      steps: [
        { at: t0, kind: "note", payload: { kind: "invoice_overdue", invoice_id: "inv_LB_112" }, ref: "inv_LB_112" },
        { at: t0 + MIN, kind: "finding", source: "Bank", ok: false, text: "Invoice LB/26-27/112 for ₹1.1 lakh was due on 28 Sep and no bank credit matches it.", ref: "inv_LB_112" },
        { at: t0 + 2 * MIN, kind: "finding", source: "Customer", text: `Sunrise Hotels: ${buyer.history}`, ref: buyer.id },
        { at: t0 + 3 * MIN, kind: "move", to: "confirmed", reason: "Sure: overdue invoice, buyer opted in to email." },
        { at: t0 + 4 * MIN, kind: "move", to: "waiting_customer", reason: "Sent a gentle reminder." },
        { at: ist("2026-10-12T11:00"), kind: "out", channel: "email", to: buyer.email, from: SUPPORT, senderMode: "verified_domain", body: "Hello Rajiv, a gentle reminder that invoice LB/26-27/112 for ₹1,12,000 from Leafy Bakes was due on 28 Sep. If it is already on its way, please ignore this. Otherwise, could you tell us the date you plan to pay?" },
      ],
    });
  }

  // ---- Meera Iyer: asked to pause; the merchant approved; it resumes on 1 Nov.
  {
    const meera = repo.customers.get("cus_meera")!;
    const t0 = ist("2026-10-08T18:20");
    const resume = ist("2026-11-01T10:00");
    specs.push({
      id: "case_demo_meera", merchantId: LEAFY, moment: "subscription", situation: "D", confidence: "sure", side: "customer_or_bank", amount: rupees(499), cause: "cancel_request", openedAt: t0,
      ref: HANDLING_REFS.meera, keys: { phone: meera.phone!, email: meera.email! }, alert: "Meera Iyer wants to cancel her ₹499 cookie box plan.",
      steps: [
        { at: t0, kind: "in", channel: "whatsapp", from: meera.phone!, to: WA, body: "Hi, I'm travelling for a few weeks. Can I stop the cookie box for now? I'll be back in November." },
        { at: t0 + MIN, kind: "finding", source: "Customer", text: "Meera is travelling and wants a break, not to leave for good." },
        { at: t0 + 2 * MIN, kind: "finding", source: "Razorpay", text: "Her plan is active and her last six payments all went through.", ref: "sub_LB_meera" },
        { at: t0 + 3 * MIN, kind: "move", to: "waiting_merchant", reason: "Needs the merchant's pick: pause, offer, or cancel." },
        { at: t0 + 3 * MIN, kind: "proposals", actions: [{ id: "prop_meera", label: "Offer Meera a month's pause", tool: "pause_subscription", args: { subscription_id: "sub_LB_meera" }, covered: false }] },
        { at: t0 + 20 * HOUR, kind: "action", tool: "pause_subscription", args: { subscription_id: "sub_LB_meera" }, status: "done", approvedBy: "tap", result: { status: "paused", resume_at: resume } },
        { at: t0 + 20 * HOUR, kind: "move", to: "acting", reason: "Merchant tapped approve" },
        { at: t0 + 20 * HOUR + MIN, kind: "out", channel: "whatsapp", from: WA, to: meera.phone!, senderMode: "merchant_inbox", body: "Hi Meera, your Monthly cookie box is paused until 1 Nov. We will restart it then and you can cancel any time before that." },
        { at: t0 + 20 * HOUR + 2 * MIN, kind: "move", to: "verifying", reason: "Paused; RAY will resume it on 1 Nov." },
        { at: t0 + 21 * HOUR, kind: "in", channel: "whatsapp", from: meera.phone!, to: WA, body: "Perfect, thank you!" },
        { at: t0 + 21 * HOUR + MIN, kind: "timer", timer: "sub_resume", dueAt: resume },
      ],
    });
  }

  // ---- Deepa Nair: her order was marked paid yesterday; the arrival check is due tomorrow.
  {
    const deepa = repo.customers.get("cus_deepa")!;
    const t0 = ist("2026-10-12T09:35");
    const amount = 1299;
    repo.rzpOrders.insert({ id: "order_LB1240", merchant_id: LEAFY, status: "paid", amount: rupees(amount), receipt: "wc_1240", created_at: t0 - 40 * MIN });
    repo.rzpPayments.insert({
      id: "pay_LB1240DEEPA", merchant_id: LEAFY, order_id: "order_LB1240", status: "captured", amount: rupees(amount), method: "upi", contact: deepa.phone, email: deepa.email,
      vpa: "deepa.nair@okicici", utr: "628514731204", receipt: "wc_1240", created_at: t0 - 38 * MIN, captured_at: t0 - 38 * MIN + 5_000,
    });
    repo.storeOrders.insert({
      id: "so_leafy_1240", number: "#1240", merchant_id: LEAFY, customer_id: deepa.id, status: "processing",
      status_history: [{ status: "pending", at: t0 - 40 * MIN }, { status: "processing", at: t0 + 25 * MIN }], razorpay_order_id: "order_LB1240", receipt: "wc_1240", payment_id: "pay_LB1240DEEPA",
      total: rupees(amount), items: [{ name: "Chocolate box", qty: 1, price: rupees(amount), stock: 12 }], stock: 12, created_at: t0 - 40 * MIN,
    });
    const check = ist("2026-10-14T10:00");
    specs.push({
      id: "case_demo_deepa", merchantId: LEAFY, moment: "paid_no_order", situation: "B", confidence: "sure", side: "razorpay", plugin: true, covered: true, amount: rupees(amount),
      paymentId: "pay_LB1240DEEPA", storeOrderId: "so_leafy_1240", cause: "plugin_dropped_capture", openedAt: t0, ref: HANDLING_REFS.deepa, keys: { phone: deepa.phone!, email: deepa.email!, paymentId: "pay_LB1240DEEPA" },
      alert: "Deepa Nair paid ₹1,299 but order #1240 is still Pending.",
      steps: [
        { at: t0, kind: "webhook", event: "payment.captured", id: "evt_LB_deepa_cap", processed: false },
        { at: t0 + 2 * MIN, kind: "finding", source: "Razorpay", text: `Razorpay captured ₹1,299 at ${stamp(t0 - 38 * MIN)}, so the money reached Razorpay.`, ref: "pay_LB1240DEEPA" },
        { at: t0 + 3 * MIN, kind: "finding", source: "Store", ok: false, text: "Order #1240 is still Pending with no payment on it.", ref: "so_leafy_1240" },
        { at: t0 + 4 * MIN, kind: "finding", source: "Razorpay", text: "Your site answered OK when Razorpay sent the payment update, so status codes alone say no issue.", ref: "evt_LB_deepa_cap" },
        { at: t0 + 5 * MIN, kind: "finding", source: "Razorpay", text: "Another store on the same plugin version reported the same thing. Razorpay's plugin dropped it.", ref: "pr_woo_482_1" },
        { at: t0 + 16 * MIN, kind: "move", to: "waiting_merchant", reason: "Sure: the payment, amount and order all match." },
        { at: t0 + 16 * MIN, kind: "proposals", actions: [{ id: "prop_deepa", label: "Mark paid & ship", tool: "mark_paid", args: { store_order_id: "so_leafy_1240", payment_id: "pay_LB1240DEEPA" }, covered: true }] },
        { at: t0 + 25 * MIN, kind: "action", tool: "mark_paid", args: { store_order_id: "so_leafy_1240", payment_id: "pay_LB1240DEEPA" }, status: "done", approvedBy: "tap", result: { order: "#1240", status: "processing" } },
        { at: t0 + 25 * MIN, kind: "move", to: "acting", reason: "Merchant tapped approve" },
        { at: t0 + 26 * MIN, kind: "out", channel: "whatsapp", from: WA, to: deepa.phone!, senderMode: "merchant_inbox", template: "order_confirmed_payment", body: `Hi Deepa, this is Leafy Bakes. We got your payment of ₹1,299 at ${stamp(t0 - 38 * MIN)}, UTR ending 1204, and your order #1240 is confirmed.` },
        { at: t0 + 27 * MIN, kind: "move", to: "verifying", reason: "Order marked paid; RAY will check it arrived on 14 Oct." },
        { at: t0 + 27 * MIN, kind: "timer", timer: TIMERS.arrival, dueAt: check },
      ],
    });
  }

  // ---- Imran Qureshi: his ₹499 renewal failed; the invoice's own link went to his email (no WhatsApp consent).
  {
    const imran = repo.customers.get("cus_imran")!;
    const t0 = ist("2026-10-12T19:10");
    const link = "https://pay.sim.example/i/inv_LB_imran_3";
    specs.push({
      id: "case_demo_imran", merchantId: LEAFY, moment: "subscription", situation: "B", confidence: "sure", side: "customer_or_bank", amount: rupees(499), cause: "retries_ran_out", openedAt: t0,
      ref: HANDLING_REFS.imran, keys: { email: imran.email!, phone: imran.phone! }, alert: "Imran Qureshi's ₹499 cookie box payment failed.",
      steps: [
        { at: t0, kind: "webhook", event: "subscription.pending", id: "evt_LB_imran_pending" },
        { at: t0 + MIN, kind: "finding", source: "Razorpay", text: "The monthly payment of ₹499 failed: insufficient balance in the bank account. Razorpay will retry twice more.", ref: "inv_LB_imran_3" },
        { at: t0 + 2 * MIN, kind: "finding", source: "Customer", text: "Imran has not agreed to WhatsApp messages, so RAY used email.", ref: "cus_imran" },
        { at: t0 + 3 * MIN, kind: "move", to: "confirmed", reason: "Sure: the renewal failed on an active mandate." },
        { at: t0 + 4 * MIN, kind: "move", to: "waiting_customer", reason: "Sent the invoice's own link; no tap needed." },
        { at: t0 + 5 * MIN, kind: "out", channel: "email", to: imran.email!, from: SUPPORT, senderMode: "verified_domain", body: `Hi Imran, your Monthly cookie box payment of ₹499 to Leafy Bakes did not go through. You can pay it here and your plan carries on: ${link}` },
      ],
    });
  }

  for (const spec of specs) b.build(spec);
  for (const f of afterBuild) await f();
  return b;
}

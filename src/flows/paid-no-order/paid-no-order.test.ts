// Step 7, Done when: scenario tests for situations A to F on the fake clock,
// the 200-but-dropped case from webhook to closed in under 40 minutes, the
// no-connector "Likely: please check" path, fixed itself at 2 h, closed with
// no reply at 72 h, the near-match that asks one question, a newer payment
// found by the pre-check, Priya's case page, and the follow-up call. Every
// AI call is served from replay fixtures (recorded in Claude Code).
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bannedWordsIn } from "@/ai/grounding";
import * as s from "@/db/schema";
import { CALL_TIMER } from "@/engine/specialist";
import { undoAction } from "@/guards";
import { requestChange, setRuleStatus } from "@/surfaces/actions";
import { caseView, inboxView } from "@/surfaces/views";
import { connectorSweep } from "./sweep";
import { HOUR, LEAFY, MIN, PRIYA_EMAIL, PRIYA_PAY, PRIYA_PHONE, pnoWorld, type PnoWorld } from "./test-helpers";

// Whole scenarios on the fake clock: give them room when the full suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

let w: PnoWorld;
beforeEach(async () => {
  w = await pnoWorld();
});
afterEach(() => w.close());

const emitPriya = () => w.a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: PRIYA_PAY });
const actions = (caseId: string, tool?: string) =>
  w.repo.actions.list(eq(s.actions.case_id, caseId)).filter((x) => !tool || x.tool === tool);
const storeOrder = (id: string) => w.repo.storeOrders.get(id)!;
const noFallbacks = () => expect(w.repo.aiCalls.list().filter((c) => !c.valid).map((c) => `${c.job} ${c.input_hash}`)).toEqual([]);

// Webhook only, nobody writes: Confirmed at 15 min.
async function webhookToNeedsYou() {
  await emitPriya();
  const kase = w.caseFor(PRIYA_PAY)!;
  await w.engine.advanceBy(15 * MIN);
  expect(w.state(kase.id).state).toBe("waiting_merchant");
  return kase.id;
}

describe("B: the 200-but-dropped plugin failure (the hero case)", () => {
  async function priyaWritesIn() {
    const t0 = w.a.clock.now();
    await emitPriya();
    const kase = w.caseFor(PRIYA_PAY)!;
    // Likely: checking. Dashboard only, no notification.
    expect(kase.state).toBe("likely");
    expect(w.repo.alerts.list().filter((x) => x.case_id === kase.id).map((x) => x.channel)).toEqual(["in_app"]);
    await w.engine.advanceBy(3 * MIN);
    // Writing in skips the 15 min wait.
    await w.says(PRIYA_EMAIL, "Hi, I paid Rs 1299 for order #1234 this morning but it still says pending. Please check.", "email");
    return { t0, caseId: kase.id };
  }

  it("goes from webhook to closed in under 40 simulated minutes", async () => {
    const { t0, caseId } = await priyaWritesIn();
    const k = w.state(caseId);
    expect(k).toMatchObject({ state: "waiting_merchant", situation: "B", side: "razorpay", razorpay_plugin: true, confidence: "sure", cause: "plugin_dropped_capture" });

    await w.engine.advanceBy(7 * MIN);
    await w.tapLabel(caseId, "Mark paid & ship");
    expect(storeOrder("so_leafy_1234")).toMatchObject({ status: "processing", payment_id: PRIYA_PAY });
    expect(actions(caseId, "mark_paid")[0]).toMatchObject({ status: "done", approved_by: "tap" });
    const confirmation = w.sent(caseId).at(-1)!;
    expect(confirmation.body).toMatch(/#1234/);
    expect(w.state(caseId).state).toBe("verifying");
    expect(caseView(w.a, caseId).results).toContain("Simulated action recorded. No customer outcome is verified yet.");

    await w.engine.advanceBy(20 * MIN);
    await w.says(PRIYA_EMAIL, "The order arrived, thank you!", "email");
    const done = w.state(caseId);
    expect(done).toMatchObject({ state: "closed", outcome: "arrived", counts_as_saved: true, razorpay_plugin: true });
    expect(caseView(w.a, caseId).results[0]).toMatch(/^Simulated outcome checked in demo data:/);
    expect(caseView(w.a, caseId).events.some((event) => event.what.startsWith("Simulated demo-data check:"))).toBe(true);
    expect(done.closed_at! - t0).toBeLessThan(40 * MIN);
    noFallbacks();
  });

  it("Priya's case page shows the five findings, Mark paid & ship, order #1234 and the reply from support@leafybakes.in", async () => {
    const { caseId } = await priyaWritesIn();
    const v = caseView(w.a, caseId);
    expect(v.findings).toHaveLength(5);
    expect(v.findings.map((f) => f.text).join(" ")).toMatch(/status codes alone say no issue/i);
    expect(v.yourCall.primary?.label).toBe("Mark paid & ship");
    expect(v.yourCall.primary?.covered).toBe(true);
    expect(v.orderNumber).toBe("#1234");
    expect(v.side).toEqual({ label: "Razorpay's side", note: "The evidence points to Razorpay; this does not confirm compensation terms. Razorpay's own plugin." });
    expect(v.yourCall.sendFrom).toBe("RAY will send this from support@leafybakes.in");
    const reply = v.conversation.find((m) => m.direction === "out")!;
    expect(reply.from).toBe("Leafy Bakes (support@leafybakes.in)");
    expect(reply.body).toMatch(/₹1,299/);
    expect(reply.body).toMatch(/UTR ending 0021/);
    expect(reply.body).not.toMatch(/https?:\/\//);
    expect(v.promiseLine).toMatch(/^Priya was told to expect a reply by /);
    expect(v.yourCall.question).toMatch(/^Priya Sharma paid ₹1,299 for a Chocolate box, but order #1234 is still Pending\..*12 in stock\./);
    for (const text of [v.yourCall.question, ...v.findings.map((f) => f.text), reply.body]) expect(bannedWordsIn(text)).toEqual([]);
    expect(v.developerBrief).toBeNull(); // Razorpay's side: nothing for their developer
    noFallbacks();
  });

  it("a newer payment found by the pre-check stops Mark paid & ship and asks the merchant", async () => {
    const { caseId } = await priyaWritesIn();
    // Priya paid again on a new order before the merchant tapped.
    w.payment({ id: "pay_LB1260PRIYA", amount: 129_900, contact: PRIYA_PHONE, email: PRIYA_EMAIL, utr: "628514731260", minutesAgo: 0, receipt: "wc_1260" });
    await w.tapLabel(caseId, "Mark paid & ship");
    const blocked = actions(caseId, "mark_paid")[0];
    expect(blocked.status).toBe("failed");
    expect((blocked.guard_result!.failed as { code: string }[]).map((f) => f.code)).toContain("newer_payment");
    expect(w.state(caseId).state).toBe("waiting_merchant");
    expect(storeOrder("so_leafy_1234").status).toBe("pending");
  });

  it("Change sends the merchant's words to the write job and the same card comes back with the new draft", async () => {
    const { caseId } = await priyaWritesIn();
    const before = caseView(w.a, caseId).yourCall;
    await requestChange(w.engine, w.a, { caseId, text: "Add that we're putting a free cookie in the box" });
    const after = caseView(w.a, caseId);
    expect(after.yourCall.primary?.label).toBe("Mark paid & ship");
    expect(after.yourCall.draft).not.toEqual(before.draft);
    expect(after.yourCall.draft).toMatch(/cookie/i);
    expect(after.card?.changeAsked).toBe("Add that we're putting a free cookie in the box");
    // The redrafted message is what goes out on the tap.
    await w.tapLabel(caseId, "Mark paid & ship");
    expect(w.sent(caseId).at(-1)!.body).toMatch(/cookie/i);
    noFallbacks();
  });
});

describe("detection and timers", () => {
  it("no connector: Likely: please check order #1234, with It's paid and It's not paid", async () => {
    w.repo.merchants.update(LEAFY, { connector_on: false });
    const caseId = await webhookToNeedsYou();
    const v = caseView(w.a, caseId);
    expect(w.state(caseId).confidence).toBe("likely");
    expect(v.yourCall.question).toMatch(/^Likely: please check order #1234\./);
    expect(w.proposals(caseId).map((p) => p.label)).toEqual(["It's paid", "It's not paid"]);
    await w.tapLabel(caseId, "It's paid");
    expect(w.state(caseId)).toMatchObject({ state: "closed", outcome: "merchant_says_paid", counts_as_saved: false });
    noFallbacks();
  });

  it("no connector: It's not paid offers the refund", async () => {
    w.repo.merchants.update(LEAFY, { connector_on: false });
    const caseId = await webhookToNeedsYou();
    await w.tapLabel(caseId, "It's not paid");
    expect(w.state(caseId).state).toBe("waiting_merchant");
    expect(w.proposals(caseId).map((p) => p.label)).toEqual(["Refund ₹1,299", "Make it instant: refund ₹1,299"]);
  });

  it("heals before RAY acts: Fixed itself at 2 hr, counted nowhere", async () => {
    const caseId = await webhookToNeedsYou();
    await w.engine.advanceBy(45 * MIN);
    // The merchant fixes it in the store without telling RAY.
    await w.a.store.markPaid(LEAFY, "so_leafy_1234", PRIYA_PAY);
    expect(w.state(caseId).state).toBe("waiting_merchant");
    await w.engine.advanceBy(HOUR);
    expect(w.state(caseId)).toMatchObject({ state: "fixed_itself", counts_as_saved: false });
    expect(actions(caseId).filter((x) => x.tool !== "send_message")).toEqual([]);
  });

  it("no reply after fulfil: did it arrive at 48 hr, Closed, no reply at 72 hr; a new message reopens", async () => {
    const caseId = await webhookToNeedsYou();
    await w.tapLabel(caseId, "Mark paid & ship");
    expect(w.state(caseId).state).toBe("verifying");
    // The confirmation was the first message, so it carries checkable details.
    expect(w.sent(caseId)[0]).toMatchObject({ template_id: "order_confirmed_payment" });
    expect(w.sent(caseId)[0].body).toMatch(/UTR ending 0021/);
    await w.engine.advanceBy(48 * HOUR);
    expect(w.sent(caseId).at(-1)).toMatchObject({ template_id: "delivery_check" });
    expect(w.state(caseId).state).toBe("verifying");
    await w.engine.advanceBy(24 * HOUR);
    expect(w.state(caseId)).toMatchObject({ state: "unconfirmed", counts_as_saved: false });
    expect(inboxView(w.a, LEAFY).tabs[2].rows.map((r) => r.state.label)).toContain("Closed, no reply");
    await w.says(PRIYA_PHONE, "Hello? My order never came.");
    expect(w.state(caseId).state).toBe("likely");
    noFallbacks();
  });

  it("no webhook configured: only the connector sweep finds it", async () => {
    w.a.store.setFailure(LEAFY, "webhook_disabled");
    await emitPriya();
    expect(w.repo.cases.list()).toEqual([]);
    await connectorSweep(w.engine, w.a, LEAFY);
    const caseId = w.caseFor(PRIYA_PAY)!.id;
    await w.engine.advanceBy(15 * MIN);
    expect(w.state(caseId)).toMatchObject({ state: "waiting_merchant", side: "merchant", cause: "webhook_disabled", razorpay_plugin: false });
    expect(caseView(w.a, caseId).developerBrief).toMatch(/webhook/i);
    // A second sweep is the same event, recorded once.
    await connectorSweep(w.engine, w.a, LEAFY);
    expect(w.repo.cases.list()).toHaveLength(1);
    noFallbacks();
  });
});

describe("investigate finds each cause", () => {
  it("site down: your side, a developer brief, and only a refund (the store can't be reached)", async () => {
    w.a.store.setFailure(LEAFY, "site_down");
    const caseId = await webhookToNeedsYou();
    expect(w.state(caseId)).toMatchObject({ side: "merchant", cause: "site_down" });
    expect(caseView(w.a, caseId).developerBrief).toBeTruthy();
    expect(w.proposals(caseId).map((p) => p.tool)).toEqual(["refund", "refund"]);
    noFallbacks();
  });

  it("wrong settings: your side, Mark paid & ship", async () => {
    w.a.store.setFailure(LEAFY, "wrong_settings");
    const caseId = await webhookToNeedsYou();
    expect(w.state(caseId)).toMatchObject({ side: "merchant", cause: "wrong_settings" });
    expect(w.proposals(caseId)[0]).toMatchObject({ label: "Mark paid & ship", tool: "mark_paid" });
    noFallbacks();
  });

  it("auto-cancelled order: restored and marked paid", async () => {
    w.a.store.setFailure(LEAFY, "none");
    await w.engine.advanceBy(25 * MIN);
    w.a.store.runCron(LEAFY);
    expect(storeOrder("so_leafy_1234").status).toBe("cancelled");
    const caseId = await webhookToNeedsYou();
    expect(w.state(caseId)).toMatchObject({ cause: "auto_cancelled" });
    expect(w.proposals(caseId)[0]).toMatchObject({ label: "Mark paid & ship", tool: "restore_order" });
    await w.tapLabel(caseId, "Mark paid & ship");
    expect(storeOrder("so_leafy_1234")).toMatchObject({ status: "processing", payment_id: PRIYA_PAY });
    noFallbacks();
  });

  it("no store order: one is created for the payment, totalling the captured amount", async () => {
    w.payment({ id: "pay_LB1255KAVYA", amount: 690_000, contact: "+919800000107", email: "kavya.rao@example.com", utr: "628514731255", minutesAgo: 10, receipt: "wc_1255" });
    await w.a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1255KAVYA" });
    const caseId = w.caseFor("pay_LB1255KAVYA")!.id;
    await w.engine.advanceBy(15 * MIN);
    expect(w.state(caseId)).toMatchObject({ cause: "order_missing" });
    expect(w.proposals(caseId)[0]).toMatchObject({ tool: "create_order_for_payment" });
    await w.tapLabel(caseId, "Mark paid & ship");
    const created = w.a.db.select().from(s.storeOrders).where(eq(s.storeOrders.payment_id, "pay_LB1255KAVYA")).all();
    expect(created).toHaveLength(1);
    expect(created[0].total).toBe(690_000);
    noFallbacks();
  });
});

describe("before the tap", () => {
  it("the 30 min message (opted in) says a call may follow; at the promised time: holding message, nudge, then the follow-up call. Nothing refunds", async () => {
    w.setAutoMessages(true);
    const caseId = await webhookToNeedsYou();
    await w.engine.advanceBy(15 * MIN);
    const first = w.sent(caseId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ template_id: "payment_seen_promise_call", channel: "whatsapp" });
    expect(first[0].body).toMatch(/we'll call you from this number/);
    expect(caseView(w.a, caseId).preCall?.text).toMatch(/^RAY will call Priya at /);

    await w.engine.advanceBy(2 * HOUR);
    const out = w.sent(caseId);
    expect(out.map((m) => m.template_id)).toContain("payment_update_holding");
    expect(w.repo.alerts.list().some((x) => x.case_id === caseId && x.kind === "nudge")).toBe(true);
    const call = w.a.db.select().from(s.messages).where(and(eq(s.messages.case_id, caseId), eq(s.messages.channel, "call"))).all();
    expect(call).toHaveLength(1);
    expect(call[0].from).toBe("call:leafy-bakes");
    expect(w.events(caseId).some((e) => e.payload.kind === "call_summary")).toBe(true);
    expect(actions(caseId, "refund")).toEqual([]);
    expect(w.state(caseId).state).toBe("waiting_merchant");
    noFallbacks();
  });

  it("no call when the customer replied by the promised time", async () => {
    w.setAutoMessages(true);
    const caseId = await webhookToNeedsYou();
    await w.engine.advanceBy(15 * MIN);
    await w.says(PRIYA_PHONE, "Ok, thanks for letting me know.");
    await w.engine.advanceBy(2 * HOUR);
    expect(w.a.db.select().from(s.messages).where(eq(s.messages.channel, "call")).all()).toEqual([]);
    expect(w.repo.timers.list(and(eq(s.timers.case_id, caseId), eq(s.timers.kind, CALL_TIMER)))[0].fired_at).not.toBeNull();
  });
});

describe("after the tap", () => {
  it("a dispute after fulfil gets the proof attached automatically", async () => {
    const caseId = await webhookToNeedsYou();
    await w.tapLabel(caseId, "Mark paid & ship");
    w.repo.disputes.insert({
      id: "disp_LB_priya", merchant_id: LEAFY, payment_id: PRIYA_PAY, amount: 129_900, reason_code: "13.1", reason: "Product not received",
      network: "Visa", phase: "chargeback", deducted: true, respond_by: w.a.clock.now() + 7 * 24 * HOUR, status: "open", lane: null, created_at: w.a.clock.now(),
    });
    await w.a.webhooks.emit({ merchantId: LEAFY, event: "payment.dispute.created", disputeId: "disp_LB_priya" });
    const proof = actions(caseId, "attach_dispute_proof")[0];
    expect(proof).toMatchObject({ status: "done", approved_by: null });
    expect(w.repo.disputes.get("disp_LB_priya")!.draft_status).toBe("draft");
  });

  it("a wrong match after fulfil: unshipped, so RAY offers to cancel through the connector", async () => {
    const caseId = await webhookToNeedsYou();
    await w.tapLabel(caseId, "Mark paid & ship");
    // The store also put this payment on another order.
    w.repo.storeOrders.insert({
      id: "so_leafy_1239", number: "#1239", merchant_id: LEAFY, customer_id: "cus_priya", status: "processing", status_history: [],
      razorpay_order_id: null, receipt: "wc_1239", payment_id: PRIYA_PAY, total: 129_900, items: [], stock: null, created_at: w.a.clock.now(),
    });
    await w.engine.advanceBy(48 * HOUR);
    expect(w.state(caseId).state).toBe("waiting_merchant");
    expect(w.proposals(caseId)[0]).toMatchObject({ label: "Cancel order #1234", tool: "cancel_order" });
    await w.tapLabel(caseId, "Cancel order #1234");
    expect(storeOrder("so_leafy_1234").status).toBe("cancelled");
    expect(w.state(caseId)).toMatchObject({ state: "closed", outcome: "cancelled_wrong_match", counts_as_saved: false });
  });
});

describe("A: authorised, never captured", () => {
  const meera = () =>
    w.payment({
      id: "pay_LB1240MEERA", amount: 185_000, contact: "+919800000104", email: "meera.iyer@example.com", status: "authorized", utr: "628514731240",
      minutesAgo: 20, receipt: "wc_1240", order: { number: "#1240", status: "pending", customerId: "cus_meera", item: "Cookie hamper" },
    });
  const meeraWrites = () => w.says("+919800000104", "I paid 1850 for the cookie hamper 20 min ago, money is gone from my account but no order");

  it("without the capture rule, RAY asks and shows the time left", async () => {
    meera();
    await meeraWrites();
    const kase = w.only();
    expect(kase).toMatchObject({ state: "waiting_merchant", situation: "A", payment_id: "pay_LB1240MEERA" });
    expect(caseView(w.a, kase.id).yourCall.question).toMatch(/4 days 23 hr left before Razorpay sends it back/);
    expect(w.proposals(kase.id).map((p) => p.label)).toEqual(["Capture ₹1,850", "Let it go back to Meera"]);
    expect(w.sent(kase.id)[0].body).toMatch(/₹1,850/);
    noFallbacks();
  });

  it("with the capture rule approved, the capture runs alone, then Mark paid & ship", async () => {
    meera();
    setRuleStatus(w.a, { merchantId: LEAFY, ruleId: "rule_setup_capture_m_leafy_bakes", status: "approved" });
    await meeraWrites();
    const kase = w.only();
    expect(actions(kase.id, "capture")[0]).toMatchObject({ status: "done", approved_by: "rule_setup_capture_m_leafy_bakes" });
    expect(w.repo.rzpPayments.get("pay_LB1240MEERA")!.status).toBe("captured");
    expect(w.state(kase.id).state).toBe("waiting_merchant");
    expect(w.proposals(kase.id)[0]).toMatchObject({ label: "Mark paid & ship", tool: "mark_paid" });
    noFallbacks();
  });

  it("let it go back: the return date and a pay-again link, as two messages", async () => {
    meera();
    await meeraWrites();
    const kase = w.only();
    await w.tapLabel(kase.id, "Let it go back to Meera");
    const out = w.sent(kase.id);
    expect(out.at(-2)!.body).toMatch(/your bank will return it by 24 Oct/);
    expect(out.at(-1)!.body).toMatch(/https:\/\/pay\.sim\.example\/l\//);
    expect(out.at(-1)!.body).toMatch(/Leafy Bakes for ₹1,850 for order #1240/);
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "returned_to_customer", counts_as_saved: false });
  });
});

describe("C: failed at Razorpay, bank debited", () => {
  const imran = () =>
    w.payment({
      id: "pay_LB1250IMRAN", amount: 49_900, contact: "+919800000108", email: "imran.q@example.com", status: "failed",
      minutesAgo: 25, receipt: "wc_1250", order: { number: "#1250", status: "pending", customerId: "cus_imran", item: "Banana bread loaf" },
    });
  const imranWrites = () =>
    w.says("imran.q@example.com", "I paid 499 for the banana bread and the money was debited from my bank, but your site says the payment failed.", "email");

  it("says it's checking with the bank, then sends a new link; the reversal date only once polling ends", async () => {
    imran();
    await imranWrites();
    const kase = w.only();
    expect(kase).toMatchObject({ state: "waiting_customer", situation: "C" });
    const [first, link] = w.sent(kase.id);
    expect(first.body).toMatch(/We're checking with your bank/);
    expect(first.body).not.toMatch(/https?:/);
    expect(link.body).toMatch(/new payment link from Leafy Bakes for ₹499/);
    expect(first.body).not.toMatch(/return it by/);
    await w.engine.advanceBy(3 * 24 * HOUR);
    const end = w.sent(kase.id).at(-1)!;
    expect(end.body).toMatch(/your bank will return it by 22 Oct/);
    expect(w.state(kase.id).state).toBe("fixed_itself");
    noFallbacks();
  });

  it("turns into E when the first payment comes through after a pay-again", async () => {
    imran();
    await imranWrites();
    const kase = w.only();
    w.payment({ id: "pay_LB1251IMRAN", amount: 49_900, contact: "+919800000108", email: "imran.q@example.com", utr: "628514731251", minutesAgo: 0, receipt: "wc_1251" });
    w.repo.rzpPayments.update("pay_LB1250IMRAN", { status: "captured", captured_at: w.a.clock.now(), utr: "628514731250" });
    await w.a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1250IMRAN" });
    expect(w.state(kase.id)).toMatchObject({ state: "waiting_merchant", situation: "E" });
    expect(w.proposals(kase.id)[0].label).toBe("Refund the extra ₹499");
    noFallbacks();
  });
});

describe("D: payment and order both there", () => {
  it("resends the confirmation on its own", async () => {
    w.payment({
      id: "pay_LB1245DEEPA", amount: 49_900, contact: "+919800000106", email: "deepa.nair@example.com", utr: "628514731245",
      minutesAgo: 50, receipt: "wc_1245", order: { number: "#1245", status: "processing", customerId: "cus_deepa", item: "Banana bread loaf", withPayment: true },
    });
    await w.says("+919800000106", "Paid 499 for banana bread but didn't get any confirmation");
    const kase = w.only();
    expect(kase).toMatchObject({ state: "waiting_customer", situation: "D" });
    expect(w.sent(kase.id)[0].body).toMatch(/is on order #1245, and the order is processing/);
    expect(actions(kase.id, "send_message")[0]).toMatchObject({ approved_by: null, status: "done" });
    await w.says("+919800000106", "Ok got it, thanks");
    expect(w.state(kase.id).state).toBe("fixed_itself");
    noFallbacks();
  });
});

describe("E: paid twice", () => {
  const sanjay = () => {
    w.payment({
      id: "pay_LB1242SANJAY1", amount: 129_900, contact: "+919800000105", email: "sanjay.k@example.com", utr: "628514731242", minutesAgo: 20,
      receipt: "wc_1242", order: { number: "#1242", status: "processing", customerId: "cus_sanjay", item: "Chocolate box", withPayment: true },
    });
    w.payment({ id: "pay_LB1242SANJAY2", amount: 129_900, contact: "+919800000105", email: "sanjay.k@example.com", utr: "628514731243", minutesAgo: 18, receipt: "wc_1242b" });
  };
  const sanjayWrites = () => w.says("sanjay.k@example.com", "I was charged twice, 1299 two times for one chocolate box!", "email");

  it("refunds the extra one after the tap, with a 10 min hold, then closes when the customer accepts", async () => {
    sanjay();
    await sanjayWrites();
    const kase = w.only();
    expect(w.state(kase.id)).toMatchObject({ state: "waiting_merchant", situation: "E" });
    expect(w.proposals(kase.id).map((p) => p.label)).toEqual(["Refund the extra ₹1,299", "Make it instant: refund the extra ₹1,299"]);
    await w.tapLabel(kase.id, "Refund the extra ₹1,299");
    const held = actions(kase.id, "refund")[0];
    expect(held).toMatchObject({ status: "held" });
    expect(held.args.payment_id).toBe("pay_LB1242SANJAY2");
    expect(caseView(w.a, kase.id).holds[0].text).toBe("Refunding ₹1,299");
    await w.engine.advanceBy(10 * MIN);
    expect(actions(kase.id, "refund")[0].status).toBe("done");
    expect(w.sent(kase.id).at(-1)!.body).toMatch(/refunded/i);
    await w.says("sanjay.k@example.com", "Got the refund, thanks.", "email");
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "refund_accepted", counts_as_saved: true });
    noFallbacks();
  });

  it("Undo inside the hold cancels the refund and hands the case back", async () => {
    sanjay();
    await sanjayWrites();
    const kase = w.only();
    await w.tapLabel(kase.id, "Make it instant: refund the extra ₹1,299");
    const held = actions(kase.id, "refund")[0];
    expect(held.args.speed).toBe("optimum");
    await w.engine.advanceBy(4 * MIN);
    expect(await undoAction(w.a, held.id)).toMatchObject({ ok: true });
    await w.engine.advanceBy(10 * MIN);
    expect(w.repo.rzpRefunds.list()).toEqual([]);
    expect(w.state(kase.id).state).toBe("waiting_merchant");
  });

  it("an approved duplicate rule refunds the extra without a tap", async () => {
    sanjay();
    w.repo.playbookRules.insert({
      id: "rule_dup_leafy", merchant_id: LEAFY, moment: "paid_no_order", rule_json: { tool: "refund", when: "duplicate", max: 200_000 },
      text: "Refund duplicate payments under ₹2,000", source: "merchant", status: "approved", approved_at: w.a.clock.now(),
    });
    await sanjayWrites();
    const kase = w.only();
    expect(actions(kase.id, "refund")[0]).toMatchObject({ status: "held", approved_by: "rule_dup_leafy" });
    expect(caseView(w.a, kase.id).underRule[0].text).toBe("Under your rule: Refund duplicate payments under ₹2,000");
  });
});

describe("F: no matching payment", () => {
  it("asks for a screenshot or UPI reference, and goes to a person after two tries", async () => {
    await w.says("+919800000103", "Maine kal 2150 pay kiya tha, order nahi aaya");
    const kase = w.only();
    expect(w.state(kase.id)).toMatchObject({ state: "waiting_customer", situation: "F", confidence: "unsure" });
    expect(w.sent(kase.id)[0].body).toMatch(/screenshot ya UPI reference/);
    // A UTR alone that matches nothing never counts.
    await w.says("+919800000103", "UTR hai 123456789012");
    expect(w.state(kase.id).state).toBe("waiting_customer");
    expect(w.sent(kase.id)).toHaveLength(2);
    await w.says("+919800000103", "Maine bataya na, paise kat gaye");
    expect(w.state(kase.id).state).toBe("waiting_merchant");
    expect(caseView(w.a, kase.id).yourCall.primary).toBeNull();
    noFallbacks();
  });

  it("when the merchant also takes another gateway, says it's likely that gateway's payment", async () => {
    w.repo.storeSettings.update(LEAFY, { other_gateway: true });
    await w.says("+919800000103", "Maine kal 2150 pay kiya tha, order nahi aaya");
    const kase = w.only();
    expect(w.state(kase.id).state).toBe("waiting_merchant");
    expect(w.sent(kase.id)[0].body).toMatch(/doosre checkout option/);
    expect(w.events(kase.id).find((e) => e.payload.kind === "investigated")!.payload.reason).toMatch(/another gateway/);
  });
});

describe("talk", () => {
  it("a near-match asks one question and never acts; the answer is matched again in code", async () => {
    await w.says(PRIYA_PHONE, "I paid 1200 for the chocolate box this morning but no order yet");
    const kase = w.only();
    expect(w.state(kase.id)).toMatchObject({ state: "waiting_customer", confidence: "unsure", payment_id: null });
    expect(w.sent(kase.id)).toHaveLength(1);
    expect(caseView(w.a, kase.id).yourCall.primary).toBeNull();
    expect(w.repo.actions.list().filter((x) => x.tool !== "send_message")).toEqual([]);
    await w.says(PRIYA_PHONE, "Sorry, it was 1299. UTR 628514730021");
    expect(w.state(kase.id)).toMatchObject({ state: "waiting_merchant", payment_id: PRIYA_PAY, situation: "B" });
    noFallbacks();
  });

  it("reads a Hinglish voice note like text and replies in Hinglish", async () => {
    await w.engine.receiveVoiceNote({ merchantId: LEAFY, from: PRIYA_PHONE, sampleId: "priya_hinglish" });
    const kase = w.only();
    expect(w.state(kase.id)).toMatchObject({ state: "waiting_merchant", payment_id: PRIYA_PAY });
    expect(w.sent(kase.id)[0].body).toMatch(/humein aapka ₹1,299 ka payment dikh raha hai/);
    noFallbacks();
  });

  it("one case across email and WhatsApp, replying on the channel used last", async () => {
    await emitPriya();
    const caseId = w.caseFor(PRIYA_PAY)!.id;
    await w.engine.advanceBy(3 * MIN);
    await w.says(PRIYA_EMAIL, "Hi, I paid Rs 1299 for order #1234 this morning but it still says pending. Please check.", "email");
    await w.says(PRIYA_PHONE, "Any update?");
    expect(w.repo.cases.list()).toHaveLength(1);
    expect(w.sent(caseId)[0].channel).toBe("email");
    expect(w.state(caseId).state).toBe("waiting_merchant");
  });
});

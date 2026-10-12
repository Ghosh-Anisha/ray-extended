// Step 5: one passing and one failing test per guard, the refund hold with
// Undo, idempotency, and what a failed guard does to the case.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockRazorpay, type Payment, type RazorpayAdapter } from "@/adapters/razorpay";
import * as s from "@/db/schema";
import { transition } from "@/engine/state-machine";
import { caseFacts, formatMoney, formatTime, releaseDueActions, REFUND_HOLD_MS, setKillSwitch, undoAction, type GuardedResult } from ".";
import { guardWorld, LEAFY, MIN, PRIYA, PRIYA_ORDER, PRIYA_PAY, type GuardWorld } from "./test-helpers";

let w: GuardWorld;
beforeEach(() => {
  w = guardWorld();
});
afterEach(() => w.close());

const codes = (r: GuardedResult) => (r.status === "blocked" ? r.failures.map((f) => `${f.guard}:${f.code}`) : []);
const guards = (r: GuardedResult) => (r.status === "blocked" ? r.failures.map((f) => f.guard) : []);
const refundArgs = { payment_id: PRIYA_PAY, amount: 129_900 };
const markPaidArgs = { order_id: PRIYA_ORDER, payment_id: PRIYA_PAY };
const mock = () => createMockRazorpay(w.a.db, w.a.clock, LEAFY);
// The first WhatsApp to Priya: amount, time, date and UTR ending, from her payment.
const checkParams = { name: "Priya", merchant: "Leafy Bakes", amount: "₹1,299", time: "9:22 AM", date: "12 Oct", order: "#1234", utr_last4: "0021" };
const firstWhatsApp = { channel: "whatsapp", to: PRIYA, sender_mode: "merchant_inbox", template_id: "payment_received_check", params: checkParams };

describe("guard: approval", () => {
  it("passes with the merchant's tap on a proposal for this action", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "mark_paid", markPaidArgs, w.tapFor(k.id, "mark_paid", markPaidArgs));
    expect(r.status).toBe("done");
    expect(r.action.approved_by).toBe("tap");
    expect(w.repo.storeOrders.get(PRIYA_ORDER)).toMatchObject({ status: "processing", payment_id: PRIYA_PAY });
  });

  it("passes with an approved playbook rule, recorded on the action", async () => {
    const k = w.openCase();
    const rule = w.rule();
    const r = await w.call(k.id, "mark_paid", markPaidArgs, { by: "rule", ruleId: rule.id, evidenceRef: "evt_x" });
    expect(r.status).toBe("done");
    expect(r.action.approved_by).toBe(rule.id);
  });

  it("fails with no tap, a proposed (not approved) rule, or a tap on a different action", async () => {
    const k = w.openCase();
    expect(codes(await w.call(k.id, "mark_paid", markPaidArgs))).toContain("approval:missing");
    const proposed = w.rule("proposed");
    expect(codes(await w.call(k.id, "mark_paid", markPaidArgs, { by: "rule", ruleId: proposed.id, evidenceRef: "evt_y" }))).toContain(
      "approval:rule_not_approved",
    );
    const tappedRefund = w.tapFor(k.id, "refund", { payment_id: PRIYA_PAY, amount: 49_900 });
    expect(codes(await w.call(k.id, "refund", refundArgs, tappedRefund))).toContain("approval:different_action");
    expect(codes(await w.call(k.id, "mark_paid", markPaidArgs, tappedRefund))).toContain("approval:different_action");
    expect(w.repo.storeOrders.get(PRIYA_ORDER)?.status).toBe("pending");
  });
});

describe("guard: match", () => {
  const claimFromPriya = { sender: PRIYA, contact: PRIYA, amount: 129_900, at: Date.parse("2026-10-12T09:30:00+05:30") };

  it("passes on an exact UTR, and on contact + amount within 2 hours", async () => {
    const k = w.openCase();
    const byUtr = { ...markPaidArgs, match: { sender: PRIYA, utr: "628514730021" } };
    const r = await w.call(k.id, "mark_paid", byUtr, w.tapFor(k.id, "mark_paid", byUtr));
    expect(r.status).toBe("done");
    const k2 = w.openCase({ store_order_id: null });
    const create = { payment_id: PRIYA_PAY, items: [{ name: "Chocolate box", qty: 1 }], match: claimFromPriya };
    // The order is now paid, so create is stopped by the pre-check, never by the match.
    const r2 = await w.call(k2.id, "create_order_for_payment", create, w.tapFor(k2.id, "create_order_for_payment", create));
    expect(guards(r2)).not.toContain("match");
  });

  it("fails on a wrong UTR, a screenshot alone, a near-match, two possible payments and an unknown payment", async () => {
    const k = w.openCase();
    const tryClaim = async (match: Record<string, unknown>) => {
      const args = { ...markPaidArgs, match };
      return codes(await w.call(k.id, "mark_paid", args, w.tapFor(k.id, "mark_paid", args)));
    };
    expect(await tryClaim({ sender: PRIYA, utr: "628514730099" })).toContain("match:utr_mismatch");
    expect(await tryClaim({ sender: PRIYA, screenshot: true })).toContain("match:claim_alone");
    expect(await tryClaim({ ...claimFromPriya, amount: 129_800 })).toContain("match:near_match");
    expect(await tryClaim({ ...claimFromPriya, at: claimFromPriya.at + 3 * 60 * MIN })).toContain("match:near_match");
    mock().simulatePayment({ amount: 129_900, status: "captured", contact: PRIYA });
    expect(await tryClaim(claimFromPriya)).toContain("match:two_matches");
    const unknown = { order_id: PRIYA_ORDER, payment_id: "pay_DoesNotExist01" };
    expect(codes(await w.call(k.id, "mark_paid", unknown, w.tapFor(k.id, "mark_paid", unknown)))).toContain("match:no_payment");
    expect(w.repo.storeOrders.get(PRIYA_ORDER)?.status).toBe("pending");
  });

  it("needs the checkout contact to confirm when someone else sent the claim", async () => {
    const k = w.openCase();
    const other = { ...markPaidArgs, match: { sender: "+919811111111", utr: "628514730021" } };
    expect(codes(await w.call(k.id, "mark_paid", other, w.tapFor(k.id, "mark_paid", other)))).toContain("match:sender_not_checkout");
    const confirm = w.note(k.id, { channel: "whatsapp", from: PRIYA, body: "yes that was my payment" }, "message_in", "msg_priya");
    const confirmed = { ...markPaidArgs, match: { ...other.match, checkout_confirmation_event_id: confirm.id } };
    expect((await w.call(k.id, "mark_paid", confirmed, w.tapFor(k.id, "mark_paid", confirmed))).status).toBe("done");
  });
});

describe("guard: one refund per payment", () => {
  it("lets the first refund through and fails a second one on the same payment", async () => {
    const k = w.openCase();
    const first = await w.call(k.id, "refund", refundArgs, w.tapFor(k.id, "refund", refundArgs));
    expect(first.status).toBe("held");
    // A second tap is a new action, and still refused while the first is on hold...
    expect(codes(await w.call(k.id, "refund", refundArgs, w.tapFor(k.id, "refund", refundArgs)))).toContain("one_refund:refund_pending");
    w.a.clock.advance(REFUND_HOLD_MS);
    await releaseDueActions(w.a);
    // ...and after it reached Razorpay.
    const third = await w.call(k.id, "refund", refundArgs, w.tapFor(k.id, "refund", refundArgs));
    expect(codes(third)).toEqual(expect.arrayContaining(["one_refund:already_refunded", "one_refund:refund_pending"]));
    expect(await mock().listRefunds(PRIYA_PAY)).toHaveLength(1);
  });

  it("fails an over-refund", async () => {
    const k = w.openCase();
    const over = { payment_id: PRIYA_PAY, amount: 130_000 };
    expect(codes(await w.call(k.id, "refund", over, w.tapFor(k.id, "refund", over)))).toContain("one_refund:over_refund");
  });

  it("uses the idempotency key as the refund receipt, and the same call twice acts once", async () => {
    const k = w.openCase();
    const tap = w.tapFor(k.id, "refund", refundArgs);
    const first = await w.call(k.id, "refund", refundArgs, tap);
    const again = await w.call(k.id, "refund", refundArgs, tap);
    expect(again).toMatchObject({ status: "duplicate", action: { id: first.action.id } });
    w.a.clock.advance(REFUND_HOLD_MS);
    await releaseDueActions(w.a);
    const refunds = await mock().listRefunds(PRIYA_PAY);
    expect(refunds).toHaveLength(1);
    expect(refunds[0].receipt).toBe(first.action.idempotency_key);
    expect(first.action.idempotency_key.length).toBeLessThanOrEqual(40);
  });
});

describe("guard: amount cap", () => {
  it("passes under a rule when the amount is within the approval limit", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "refund", refundArgs, { by: "rule", ruleId: w.rule().id, evidenceRef: "evt_r" });
    expect(r.status).toBe("held");
  });

  it("sends anything above the approval limit to the merchant, even under a rule; a tap is fine", async () => {
    w.repo.merchants.update(LEAFY, { approval_limit: 100_000 });
    const k = w.openCase();
    const r = await w.call(k.id, "refund", refundArgs, { by: "rule", ruleId: w.rule().id, evidenceRef: "evt_r" });
    expect(codes(r)).toEqual(["amount_cap:above_limit"]);
    expect(r.status === "blocked" && r.failures[0].reason).toBe("₹1,299 is above your approval limit of ₹1,000, so this needs your tap.");
    expect((await w.call(k.id, "refund", refundArgs, w.tapFor(k.id, "refund", refundArgs))).status).toBe("held");
  });
});

describe("guard: refund hold with Undo", () => {
  it("holds the refund 10 minutes; Undo inside the hold cancels it before it reaches Razorpay", async () => {
    const k = w.openCase();
    const held = await w.call(k.id, "refund", refundArgs, w.tapFor(k.id, "refund", refundArgs));
    expect(held).toMatchObject({ status: "held", runAfter: w.a.clock.now() + REFUND_HOLD_MS });
    w.a.clock.advance(9 * MIN);
    const undo = await undoAction(w.a, held.action.id);
    expect(undo.ok).toBe(true);
    expect(w.repo.actions.get(held.action.id)?.status).toBe("undone");
    w.a.clock.advance(5 * MIN);
    expect(await releaseDueActions(w.a)).toEqual([]);
    expect(await mock().listRefunds(PRIYA_PAY)).toEqual([]);
    expect(w.repo.caseEvents.listByCase(k.id).map((e) => e.payload.kind)).toEqual(expect.arrayContaining(["action_held", "action_undone"]));
  });

  it("refunds when the hold ends, and refuses Undo after that", async () => {
    const k = w.openCase();
    const held = await w.call(k.id, "refund", refundArgs, w.tapFor(k.id, "refund", refundArgs));
    w.a.clock.advance(REFUND_HOLD_MS);
    expect(await undoAction(w.a, held.action.id)).toEqual({ ok: false, reason: "The 10-minute hold has ended, so this can't be undone." });
    const [released] = await releaseDueActions(w.a);
    expect(released.status).toBe("done");
    expect(await mock().listRefunds(PRIYA_PAY)).toHaveLength(1);
  });
});

describe("guard: pre-action check", () => {
  it("passes when the order is unpaid and nothing newer or disputed exists", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "mark_paid", markPaidArgs, w.tapFor(k.id, "mark_paid", markPaidArgs));
    expect(r.status).toBe("done");
    expect(r.action.guard_result?.passed).toContain("pre_action");
  });

  it("finds a newer payment from the same contact on a different order (a pay-again link)", async () => {
    w.a.clock.advance(20 * MIN);
    const again = mock().simulatePayment({ amount: 129_900, status: "captured", contact: PRIYA, email: "priya.sharma@example.com" });
    const k = w.openCase();
    const r = await w.call(k.id, "mark_paid", markPaidArgs, w.tapFor(k.id, "mark_paid", markPaidArgs));
    expect(codes(r)).toEqual(["pre_action:newer_payment"]);
    expect(r.status === "blocked" && r.failures[0].details?.payment_id).toBe(again.id);
    expect(w.repo.storeOrders.get(PRIYA_ORDER)?.status).toBe("pending");
  });

  it("syncs the mirror from Razorpay first, so a payment only Razorpay knows about is still found (test mode)", async () => {
    const real = mock();
    const onlyInRazorpay: Payment = {
      ...(await real.fetchPayment(PRIYA_PAY)),
      id: "pay_TM_payagain01",
      order_id: null,
      utr: "628514739999",
      created_at: w.a.clock.now() - 5 * MIN,
      captured_at: w.a.clock.now() - 5 * MIN,
    };
    const testMode: RazorpayAdapter = {
      ...real,
      mode: "test",
      listPayments: async (win) => [...(await real.listPayments(win)), onlyInRazorpay],
    };
    w.a.razorpay = () => testMode;
    expect(w.repo.rzpPayments.get(onlyInRazorpay.id)).toBeUndefined();
    const k = w.openCase();
    const r = await w.call(k.id, "mark_paid", markPaidArgs, w.tapFor(k.id, "mark_paid", markPaidArgs));
    expect(codes(r)).toEqual(["pre_action:newer_payment"]);
    expect(w.repo.rzpPayments.get(onlyInRazorpay.id)).toMatchObject({ order_id: null, contact: PRIYA, status: "captured" });
  });

  it("fails when the order is already paid, and on an open dispute or a bank complaint", async () => {
    const k = w.openCase();
    await w.call(k.id, "mark_paid", markPaidArgs, w.tapFor(k.id, "mark_paid", markPaidArgs));
    expect(codes(await w.call(k.id, "mark_paid", markPaidArgs, w.tapFor(k.id, "mark_paid", markPaidArgs)))).toContain("pre_action:order_paid");

    const meera = w.openCase({ moment: "chargeback", payment_id: "pay_LB1198MEERA", store_order_id: null, amount: 690_000 });
    const refund = { payment_id: "pay_LB1198MEERA", amount: 690_000 };
    expect(codes(await w.call(meera.id, "refund", refund, w.tapFor(meera.id, "refund", refund)))).toContain("pre_action:open_dispute");

    const sanjay = w.openCase({ moment: "chargeback", payment_id: "pay_LB1221DEEPA", store_order_id: null });
    await mock().acceptDispute("disp_LB_deepa");
    const deepa = { payment_id: "pay_LB1221DEEPA", amount: 1_000 };
    expect(guards(await w.call(sanjay.id, "refund", deepa, w.tapFor(sanjay.id, "refund", deepa)))).not.toContain("pre_action");
    w.note(sanjay.id, { kind: "bank_complaint", payment_id: "pay_LB1221DEEPA" });
    expect(codes(await w.call(sanjay.id, "refund", deepa, w.tapFor(sanjay.id, "refund", deepa)))).toContain("pre_action:bank_complaint");
  });
});

describe("guard: grounding", () => {
  it("passes a message whose numbers are all in the case", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "send_message", firstWhatsApp);
    expect(r.status).toBe("done");
    expect(caseFacts(w.a.db, k.id)).toMatchObject({ merchant: { name: "Leafy Bakes" } });
  });

  it("fails a message with a number that isn't in the case", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "send_message", { ...firstWhatsApp, params: { ...checkParams, amount: "₹1,399" } });
    expect(codes(r)).toContain("grounding:ungrounded");
    expect(r.status === "blocked" && r.failures.find((f) => f.guard === "grounding")?.details?.numbers).toEqual(["1399"]);
  });
});

describe("guard: first message (rule 7)", () => {
  it("about a payment: passes with amount, time and the UTR's last 4, and no link", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "send_message", firstWhatsApp);
    expect(r.status).toBe("done");
    expect(r.status === "done" && r.result.body).toContain("UTR ending 0021");
  });

  it("about a payment: fails with a link, or without the UTR's last 4", async () => {
    const k = w.openCase();
    await w.a.messaging.receive({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "where is my order" });
    const linked = await w.call(k.id, "send_message", {
      channel: "whatsapp", to: PRIYA, sender_mode: "merchant_inbox",
      body: "We got your ₹1,299 at 9:22 AM on 12 Oct, UTR ending 0021. Track it at https://leafybakes.example.com/track",
    });
    expect(codes(linked)).toContain("first_message:link");
    const noUtr = await w.call(k.id, "send_message", {
      channel: "whatsapp", to: PRIYA, sender_mode: "merchant_inbox", body: "We got your ₹1,299 at 9:22 AM on 12 Oct.",
    });
    expect(codes(noUtr)).toEqual(["first_message:not_checkable"]);
  });

  describe("recovery messages (international)", () => {
    const EMMA = "emma.clarke@example.com";
    const emmaCase = () =>
      w.openCase({ merchant_id: "m_notenest", moment: "international", payment_id: "pay_NN_emma_failed", store_order_id: null, amount: 410_000 });
    const link = async (caseId: string) => {
      const r = await w.call(caseId, "payment_link", { amount: 4_900, currency: "USD", description: "NoteNest Pro annual" });
      return r.status === "done" ? (r.result.short_url as string) : "";
    };

    it("may carry a Razorpay-hosted link in the merchant's name, with the merchant, amount and what it's for", async () => {
      const k = emmaCase();
      const url = await link(k.id);
      const body = `Hi Emma, this is NoteNest. Your $49 payment for Pro annual didn't go through. You can pay here: ${url}`;
      const r = await w.call(k.id, "send_message", { channel: "email", to: EMMA, sender_mode: "verified_domain", body });
      expect(r.status).toBe("done");
    });

    it("fails a link that isn't Razorpay's, or a link sent alone", async () => {
      const k = emmaCase();
      const url = await link(k.id);
      const other = await w.call(k.id, "send_message", {
        channel: "email", to: EMMA, sender_mode: "verified_domain",
        body: "Hi Emma, this is NoteNest. Your $49 payment for Pro annual didn't go through. Pay at https://notenest-pay.example.com/pro",
      });
      expect(codes(other)).toContain("first_message:link_not_razorpay");
      const alone = await w.call(k.id, "send_message", { channel: "email", to: EMMA, sender_mode: "verified_domain", body: url });
      expect(codes(alone)).toEqual(["first_message:link_alone"]);
    });
  });
});

describe("guard: channel rules", () => {
  it("passes an approved template outside the window, and free text inside it", async () => {
    const k = w.openCase();
    expect((await w.call(k.id, "send_message", firstWhatsApp)).status).toBe("done");
    await w.a.messaging.receive({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "YES" });
    const r = await w.call(k.id, "send_message", { channel: "whatsapp", to: PRIYA, sender_mode: "merchant_inbox", body: "Thanks Priya, order #1234 is confirmed." });
    expect(r.status).toBe("done");
  });

  it("fails free text outside the 24-hour window, an unapproved template, and WhatsApp when it's off", async () => {
    const k = w.openCase();
    await w.call(k.id, "send_message", firstWhatsApp);
    const free = { channel: "whatsapp", to: PRIYA, sender_mode: "merchant_inbox", body: "Order #1234 is confirmed." };
    expect(codes(await w.call(k.id, "send_message", free))).toEqual(["channel_rules:window_closed"]);
    const pending = { ...firstWhatsApp, template_id: "festive_offer", params: { name: "Priya", merchant: "Leafy Bakes" } };
    expect(codes(await w.call(k.id, "send_message", pending))).toContain("channel_rules:template_not_approved");
    w.repo.merchants.update(LEAFY, { whatsapp_on: false });
    expect(codes(await w.call(w.openCase().id, "send_message", firstWhatsApp))).toContain("channel_rules:whatsapp_off");
  });
});

describe("guard: confidence", () => {
  it("passes on Sure and Likely; on Unsure only a question can go out", async () => {
    const likely = w.openCase({ confidence: "likely" });
    expect((await w.call(likely.id, "refund", refundArgs, w.tapFor(likely.id, "refund", refundArgs))).status).toBe("held");
    const unsure = w.openCase({ confidence: "unsure" });
    const question = { ...firstWhatsApp, kind: "question" };
    expect((await w.call(unsure.id, "send_message", question)).status).toBe("done");
  });

  it("fails every act on Unsure, even with a tap", async () => {
    const unsure = w.openCase({ confidence: "unsure" });
    expect(codes(await w.call(unsure.id, "refund", refundArgs, w.tapFor(unsure.id, "refund", refundArgs)))).toEqual(["confidence:unsure"]);
    expect(codes(await w.call(unsure.id, "send_message", firstWhatsApp))).toEqual(["confidence:unsure"]);
  });
});

describe("guard: consent", () => {
  const to = (phone: string, name: string) => ({ ...firstWhatsApp, to: phone, params: { ...checkParams, name } });

  it("passes a proactive WhatsApp to an opted-in customer, and any reply inside the window", async () => {
    const k = w.openCase();
    expect(guards(await w.call(k.id, "send_message", firstWhatsApp))).not.toContain("consent");
    await w.a.messaging.receive({ merchantId: LEAFY, channel: "whatsapp", from: "+919800000107", body: "hi" });
    expect(guards(await w.call(k.id, "send_message", to("+919800000107", "Kavya")))).not.toContain("consent");
  });

  it("blocks a proactive WhatsApp to someone who opted out or never opted in", async () => {
    const k = w.openCase();
    const kavya = await w.call(k.id, "send_message", to("+919800000107", "Kavya"));
    expect(codes(kavya)).toContain("consent:opted_out");
    expect(kavya.status === "blocked" && kavya.failures.find((f) => f.guard === "consent")?.reason).toBe("Kavya Rao opted out of WhatsApp messages.");
    expect(codes(await w.call(k.id, "send_message", to("+919800000108", "Imran")))).toContain("consent:no_opt_in");
    expect(w.a.messaging.inbox("+919800000107")).toEqual([]);
  });
});

describe("guard: order total", () => {
  const newPayment = () => mock().simulatePayment({ amount: 129_900, status: "captured" });

  it("creates an order that totals the captured payment", async () => {
    const p = newPayment();
    const k = w.openCase({ payment_id: p.id, store_order_id: null });
    const args = { payment_id: p.id, items: [{ name: "Chocolate box", qty: 1 }] };
    const r = await w.call(k.id, "create_order_for_payment", args, w.tapFor(k.id, "create_order_for_payment", args));
    expect(r.status).toBe("done");
    expect(r.status === "done" && r.result).toMatchObject({ total: 129_900, payment_id: p.id, status: "processing" });
  });

  it("fails when the line items don't add up to the payment, and creates nothing", async () => {
    const p = newPayment();
    const k = w.openCase({ payment_id: p.id, store_order_id: null });
    const args = { payment_id: p.id, items: [{ name: "Banana bread loaf", qty: 2 }] };
    const r = await w.call(k.id, "create_order_for_payment", args, w.tapFor(k.id, "create_order_for_payment", args));
    expect(codes(r)).toEqual(["order_total:order_total_mismatch"]);
    expect(r.status === "blocked" && r.failures[0].details).toMatchObject({ payment_amount: 129_900, line_items_total: 99_800 });
    expect(await w.a.store.getOrder(LEAFY, { paymentId: p.id })).toBeNull();
  });
});

describe("guard: kill switch", () => {
  const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
    mark_paid: markPaidArgs,
    restore_order: markPaidArgs,
    create_order_for_payment: { payment_id: PRIYA_PAY, items: [{ name: "Chocolate box", qty: 1 }] },
    cancel_order: { order_id: PRIYA_ORDER, reason: "Wrong match" },
    refund: refundArgs,
    capture: { payment_id: PRIYA_PAY },
    payment_link: { amount: 129_900, description: "Order #1234" },
    send_message: firstWhatsApp,
    attach_dispute_proof: { dispute_id: "disp_LB_meera", documents: { shipping_proof: ["doc_1"] } },
    contest_dispute: { dispute_id: "disp_LB_meera" },
    accept_dispute: { dispute_id: "disp_LB_meera" },
    pay_pending_invoice: { subscription_id: "sub_FL_karan" },
    pause_subscription: { subscription_id: "sub_FL_karan" },
    resume_subscription: { subscription_id: "sub_FL_karan" },
    cancel_subscription: { subscription_id: "sub_FL_karan" },
    post_match: { credit_id: "bc_PR_1", allocations: [{ invoice_id: "inv_PR_2402", amount: 100 }] },
    draft_request: { request: "other", text: "Please raise the limit" },
  };

  it("passes when both switches are off", async () => {
    const k = w.openCase();
    const r = await w.call(k.id, "draft_request", SAMPLE_ARGS.draft_request);
    expect(r.status).toBe("done");
    expect(r.action.guard_result?.passed).toContain("kill_switch");
  });

  for (const scope of ["merchant", "global"] as const) {
    it(`with the ${scope} kill switch on, every act tool returns blocked and reads still work`, async () => {
      setKillSwitch(w.a.db, w.a.clock, scope === "global" ? "global" : { merchantId: LEAFY }, true);
      const { ACT_TOOLS, createReadTools } = await import("@/tools");
      expect(Object.keys(SAMPLE_ARGS).sort()).toEqual([...ACT_TOOLS].sort());
      for (const tool of ACT_TOOLS) {
        const k = w.openCase();
        const r = await w.call(k.id, tool, SAMPLE_ARGS[tool], w.tapFor(k.id, tool, SAMPLE_ARGS[tool]));
        expect(r.status, tool).toBe("blocked");
        expect(codes(r), tool).toContain(`kill_switch:${scope}`);
      }
      expect(w.repo.storeOrders.get(PRIYA_ORDER)?.status).toBe("pending");
      expect(await mock().listRefunds(PRIYA_PAY)).toEqual([]);
      expect(w.a.messaging.inbox(PRIYA)).toEqual([]);
      const read = createReadTools(w.a, LEAFY);
      expect((await read("get_payment", PRIYA_PAY)).evidence_ids).toEqual([PRIYA_PAY]);
    });
  }

  it("stops a held refund from running if the switch comes on during the hold", async () => {
    const k = w.openCase();
    await w.call(k.id, "refund", refundArgs, w.tapFor(k.id, "refund", refundArgs));
    setKillSwitch(w.a.db, w.a.clock, { merchantId: LEAFY }, true);
    w.a.clock.advance(REFUND_HOLD_MS);
    const [r] = await releaseDueActions(w.a);
    expect(codes(r)).toEqual(["kill_switch:merchant"]);
    expect(await mock().listRefunds(PRIYA_PAY)).toEqual([]);
  });
});

describe("a failed guard", () => {
  it("writes its reason to the case and moves the case to waiting_merchant through the state machine", async () => {
    const k = w.openCase({ state: "confirmed" });
    transition(w.a.db, w.a.clock, k.id, "acting", { reason: "Merchant tapped approve", evidenceRef: "tap_1" });
    setKillSwitch(w.a.db, w.a.clock, "global", true);
    const r = await w.call(k.id, "refund", refundArgs, w.tapFor(k.id, "refund", refundArgs));
    expect(r.status).toBe("blocked");
    expect(w.repo.actions.get(r.action.id)).toMatchObject({ status: "failed", approved_by: "tap" });
    const timeline = w.repo.caseEvents.listByCase(k.id);
    const blocked = timeline.find((e) => e.payload.kind === "action_blocked")!;
    expect(blocked).toMatchObject({ type: "tool_call", evidence_ref: r.action.id });
    expect(blocked.payload.reason).toBe("A check stopped the refund: RAY's actions are paused for every account right now. Reading still works.");
    expect(timeline.at(-1)?.payload).toMatchObject({ kind: "state_changed", from: "acting", to: "waiting_merchant" });
    expect(timeline.at(-1)?.evidence_ref).toBe(blocked.id);
    expect(w.repo.cases.get(k.id)?.state).toBe("waiting_merchant");
  });

  it("never retries by itself: the action stays failed until called again", async () => {
    const k = w.openCase();
    setKillSwitch(w.a.db, w.a.clock, { merchantId: LEAFY }, true);
    const tap = w.tapFor(k.id, "mark_paid", markPaidArgs);
    const r = await w.call(k.id, "mark_paid", markPaidArgs, tap);
    setKillSwitch(w.a.db, w.a.clock, { merchantId: LEAFY }, false);
    w.a.clock.advance(60 * MIN);
    await releaseDueActions(w.a);
    expect(w.repo.actions.get(r.action.id)?.status).toBe("failed");
    expect(w.repo.storeOrders.get(PRIYA_ORDER)?.status).toBe("pending");
    const again = await w.call(k.id, "mark_paid", markPaidArgs, tap);
    expect(again).toMatchObject({ status: "done", action: { id: r.action.id } });
  });

  it("reasons shown to the merchant use plain words", async () => {
    const { bannedWordsIn, hasEmDash } = await import("@/ai/grounding");
    const k = w.openCase({ confidence: "unsure" });
    setKillSwitch(w.a.db, w.a.clock, "global", true);
    const r = await w.call(k.id, "send_message", { channel: "whatsapp", to: "+919800000107", sender_mode: "verified_domain", body: "₹9,999 https://x.example.com" });
    const reasons = r.status === "blocked" ? r.failures.map((f) => f.reason) : [];
    expect(reasons.length).toBeGreaterThan(3);
    for (const reason of reasons) {
      expect(bannedWordsIn(reason), reason).toEqual([]);
      expect(hasEmDash(reason), reason).toBe(false);
    }
  });
});

describe("display formats", () => {
  it("formats money and times the design language way", () => {
    expect(formatMoney(129_900)).toBe("₹1,299");
    expect(formatMoney(142_000_000)).toBe("₹14.2 lakh");
    expect(formatMoney(4_900, "USD")).toBe("$49");
    expect(formatTime(Date.parse("2026-10-06T19:52:00+05:30"))).toBe("7:52 PM");
  });
});

it("keeps every action on the record, with its idempotency key", async () => {
  const k = w.openCase();
  await w.call(k.id, "draft_request", { request: "other", text: "x" });
  const rows = w.repo.actions.list(eq(s.actions.case_id, k.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].idempotency_key).toMatch(/^ik_[0-9a-f]{32}$/);
});

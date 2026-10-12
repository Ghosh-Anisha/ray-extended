import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { merchantPhone } from "@/adapters/voice";
import { bannedWordsIn, hasLink } from "@/ai/grounding";
import * as s from "@/db/schema";
import { guardedCall, setKillSwitch } from "@/guards";
import { holdsOf } from "@/surfaces/views";
import { checkLane, laneRuleId, overridesOn, proposeLanes, type LaneInput } from "./lanes";
import { N, TIMERS } from ".";
import { PATTERN_ALERT } from "./patterns";
import { cbFraudSignals } from "./schema";
import { escalateDispute, setFiling, settleDispute } from "./sim";
import { RAHUL_THREAT } from "./threat-fixture";
import { cbWorld, DAY, DISPUTES, HOUR, LEAFY, MIN, PAYMENTS, type CbWorld } from "./test-helpers";

let w: CbWorld;
beforeEach(() => {
  w = cbWorld();
});
afterEach(() => w.close());

// A fresh disputed card payment for Leafy Bakes, with its store order.
let n = 0;
function newDispute(o: {
  type: "duplicate" | "fraud" | "not_received" | "not_as_described";
  amount?: number;
  customerId?: string;
  orderStatus?: "completed" | "processing" | "pending";
  vulcan?: "flagged" | "clear";
  respondDays?: number;
}) {
  n++;
  const { repo, a } = w;
  const now = a.clock.now();
  const cus = repo.customers.get(o.customerId ?? "cus_imran")!;
  // A different amount each time, so two test payments never look like one charge twice.
  const amount = o.amount ?? 129_900 + n * 100;
  const pay = `pay_LBT${String(n).padStart(3, "0")}XYZ`;
  const order = `order_LBT${n}`;
  const codes = { duplicate: ["4834", "Duplicate charge", "Mastercard"], fraud: ["10.4", "Fraud, card absent", "Visa"], not_received: ["13.1", "Product not received", "Visa"], not_as_described: ["13.3", "Not as described", "Visa"] }[o.type];
  repo.rzpOrders.insert({ id: order, merchant_id: LEAFY, status: "paid", amount, receipt: `wc_t${n}`, created_at: now - 10 * DAY });
  repo.rzpPayments.insert({
    id: pay, merchant_id: LEAFY, order_id: order, status: "captured", amount, method: "card", contact: cus.phone, email: cus.email,
    card_last4: String(4100 + n), card_country: "IN", receipt: `wc_t${n}`, created_at: now - 10 * DAY, captured_at: now - 10 * DAY + 5_000,
  });
  const status = o.orderStatus ?? "completed";
  repo.storeOrders.insert({
    id: `so_t${n}`, number: `#T${n}`, merchant_id: LEAFY, customer_id: cus.id, status,
    status_history: status === "completed" ? [{ status: "processing", at: now - 10 * DAY }, { status: "completed", at: now - 8 * DAY, note: "Shipped by courier" }] : [{ status, at: now - 10 * DAY }],
    razorpay_order_id: order, receipt: `wc_t${n}`, payment_id: pay, total: amount,
    items: [{ name: "Chocolate box", qty: 1, price: amount, stock: 12 }], stock: 12, created_at: now - 10 * DAY,
  });
  if (o.vulcan) {
    a.db.insert(cbFraudSignals).values({ payment_id: pay, merchant_id: LEAFY, vulcan_result: o.vulcan, device_seen_before: false, ip_country: "RO", address_matches: false, checked_at: now }).run();
  }
  const id = `disp_LBT${n}`;
  repo.disputes.insert({
    id, merchant_id: LEAFY, payment_id: pay, amount, reason_code: codes[0], reason: codes[1], network: codes[2], phase: "chargeback",
    deducted: true, respond_by: now + (o.respondDays ?? 9) * DAY, status: "open", lane: null, created_at: now,
  });
  return { id, pay };
}

describe("Leafy Bakes' three disputes, end to end", () => {
  it("the duplicate auto-contests with a Stop window, then wins", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.sanjay);
    const c = w.caseFor(PAYMENTS.sanjay);
    expect(c.situation).toBe("D");
    expect(c.confidence).toBe("sure");
    expect(c.state).toBe("verifying"); // RAY is handling

    // Held under the lane with the Stop banner and an FYI.
    const held = w.actions(c.id, "contest_dispute")[0];
    expect(held.status).toBe("held");
    expect(held.approved_by).toBe(laneRuleId(LEAFY, "contest"));
    expect(held.run_after).toBe(w.a.clock.now() + 2 * HOUR);
    const hold = holdsOf(w.a, c)[0];
    expect(hold).toMatchObject({ kind: "stop", text: "Contesting this dispute", control: "Stop" });
    expect(w.alerts(c.id, "lane_fyi")[0].text).toMatch(/Under your rule, I'm contesting Sanjay Kulkarni's ₹1,299 chargeback \(duplicate charge\)\. Stop by 12:00 PM/);
    expect(w.dispute(DISPUTES.sanjay).lane).toBe("contest");
    // Not submitted during the window.
    expect(w.dispute(DISPUTES.sanjay).status).toBe("open");

    await w.engine.advanceBy(2 * HOUR);
    expect(w.actions(c.id, "contest_dispute")[0].status).toBe("done");
    expect(w.dispute(DISPUTES.sanjay).status).toBe("under_review");
    expect(w.notes(c.id, "dispute_draft_submitted")).toHaveLength(1);
    expect(w.notes(c.id, N.filed).at(-1)!.payload.under_rule).toBe(laneRuleId(LEAFY, "contest"));

    await settleDispute(w.a, LEAFY, DISPUTES.sanjay, "won");
    const done = w.repo.cases.get(c.id)!;
    expect(done.state).toBe("closed");
    expect(done.outcome).toBe("won");
    expect(done.counts_as_saved).toBe(true);
  });

  it("one 'not received' (Deepa) is withdrawn after outreach the merchant tapped", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.deepa);
    const c = w.caseFor(PAYMENTS.deepa);
    expect(c.state).toBe("waiting_merchant");
    expect(c.situation).toBe("C");
    // Likely (shipped, delivery not confirmed), so the contest lane doesn't run.
    expect(w.actions(c.id, "contest_dispute")).toHaveLength(0);
    expect(w.proposals(c.id).map((p) => p.label)).toEqual(["Send message to Deepa", "Contest dispute", "Accept dispute"]);
    expect(w.sent(c.id)).toHaveLength(0); // nothing goes to the customer before the tap

    await w.tapLabel(c.id, "Send message to Deepa");
    const msg = w.sent(c.id)[0];
    expect(msg.channel).toBe("email");
    expect(msg.to).toBe("deepa.nair@example.com");
    // Checkable details, no link, no internal words; a fix or refund offer and a withdraw request.
    expect(msg.body).toMatch(/₹1,850 at 10:00 AM on 24 Sep \(card ending 4093\) for order #1221/);
    expect(msg.body).toMatch(/fix it or give your money back/);
    expect(msg.body).toMatch(/ask your bank to withdraw the dispute/);
    expect(hasLink(msg.body)).toBe(false);
    expect(bannedWordsIn(msg.body)).toEqual([]);
    expect(w.actions(c.id, "send_message")[0].approved_by).toBe("tap");
    expect(w.repo.cases.get(c.id)!.state).toBe("verifying");

    // Deepa replies; the bank withdraws.
    await w.engine.receiveMessage({ merchantId: LEAFY, channel: "email", from: "deepa.nair@example.com", body: "Found it with my neighbour, sorry! I'll tell my bank." });
    expect(w.notes(c.id, N.reply)).toHaveLength(1);
    await settleDispute(w.a, LEAFY, DISPUTES.deepa, "withdrawn");
    const done = w.repo.cases.get(c.id)!;
    expect(done).toMatchObject({ state: "closed", outcome: "withdrawn", counts_as_saved: true });
  });

  it("one 'not received' (Meera, ₹6,900) goes to Ask", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.meera);
    const c = w.caseFor(PAYMENTS.meera);
    expect(c.state).toBe("waiting_merchant");
    expect(w.proposals(c.id)[0].label).toBe("Contest dispute");
    const decided = w.notes(c.id, "decided").at(-1)!.payload.summary as string;
    expect(decided).toMatch(/^Meera Iyer's ₹6,900 chargeback \(not received\)\. ₹6,900 is above your approval limit of ₹2,000, so this one is your call\. Contest it\?$/);
    // The open Buyer Protection claim on the same payment is in the pack.
    const pack = w.notes(c.id, N.pack)[0].payload as { documents: Record<string, string[]>; facts: { buyerProtectionClaim: boolean } };
    expect(pack.facts.buyerProtectionClaim).toBe(true);
    expect(pack.documents.customer_communication).toContain("bpc_LB_meera");
    // The merchant contests: filed through the Disputes API on the tap.
    await w.tapLabel(c.id, "Contest dispute");
    expect(w.dispute(DISPUTES.meera).status).toBe("under_review");
    expect(w.actions(c.id, "contest_dispute")[0].approved_by).toBe("tap");
  });

  it("the dispute.created handler opens the case before any draft", async () => {
    await w.open(DISPUTES.sanjay);
    const c = w.caseFor(PAYMENTS.sanjay);
    const ev = w.events(c.id);
    const opened = ev.findIndex((e) => e.type === "webhook");
    const draft = ev.findIndex((e) => e.payload.kind === "dispute_draft_created");
    expect(opened).toBe(0);
    expect(draft).toBeGreaterThan(opened);
    expect(ev[draft].type).toBe("note");
    // RAY proposed both lanes, off until the merchant switches them on.
    expect(w.repo.playbookRules.get(laneRuleId(LEAFY, "contest"))!.status).toBe("proposed");
    expect(w.repo.playbookRules.get(laneRuleId(LEAFY, "accept"))!.status).toBe("proposed");
    // Without the lane, even the strong duplicate asks.
    expect(c.state).toBe("waiting_merchant");
    expect(w.actions(c.id, "contest_dispute")).toHaveLength(0);
  });
});

describe("the lanes and their bounds", () => {
  it("Stop inside the window: nothing is filed, the case comes back to the merchant, and it counts as an override", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.sanjay);
    const c = w.caseFor(PAYMENTS.sanjay);
    await w.engine.advanceBy(HOUR);
    const r = await w.stop(w.actions(c.id, "contest_dispute")[0].id);
    expect(r.ok).toBe(true);
    await w.engine.advanceBy(2 * HOUR);
    expect(w.dispute(DISPUTES.sanjay).status).toBe("open");
    expect(w.repo.cases.get(c.id)!.state).toBe("waiting_merchant");
    expect(overridesOn(w.a.db, LEAFY, "duplicate")).toBe(1);
  });

  it("two overrides on a type move it back to Ask", async () => {
    w.switchOn("contest");
    for (let i = 0; i < 2; i++) {
      const d = newDispute({ type: "duplicate" });
      await w.open(d.id);
      const c = w.caseFor(d.pay);
      expect(c.state).toBe("verifying");
      await w.stop(w.actions(c.id, "contest_dispute")[0].id);
    }
    const d = newDispute({ type: "duplicate" });
    await w.open(d.id);
    const c = w.caseFor(d.pay);
    expect(c.state).toBe("waiting_merchant");
    expect(w.actions(c.id, "contest_dispute")).toHaveLength(0);
    expect(w.notes(c.id, N.decision)[0].payload.why).toContain("You stopped RAY on duplicate charge disputes twice, so RAY asks you about them now.");
  });

  it("one wrong call switches the lane off, and the next one asks", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.sanjay);
    await w.engine.advanceBy(2 * HOUR);
    await settleDispute(w.a, LEAFY, DISPUTES.sanjay, "lost");
    const c = w.caseFor(PAYMENTS.sanjay);
    expect(w.repo.cases.get(c.id)).toMatchObject({ state: "closed", outcome: "lost", counts_as_saved: false });
    expect(w.repo.playbookRules.get(laneRuleId(LEAFY, "contest"))!.status).toBe("off");
    expect(w.alerts(c.id, "lane_off")).toHaveLength(1);

    const d = newDispute({ type: "duplicate" });
    await w.open(d.id);
    expect(w.caseFor(d.pay).state).toBe("waiting_merchant");
  });

  it("checks every bound: opt-in, type, first stage, already deducted, Sure, approval limit, time for a Stop window", () => {
    const now = w.a.clock.now();
    const x: LaneInput = { merchantId: LEAFY, lane: "contest", type: "duplicate", phase: "chargeback", deducted: true, confidence: "sure", amount: 129_900, approvalLimit: 200_000, now, deadline: now + 3 * DAY };
    proposeLanes(w.a.db, LEAFY);
    expect(checkLane(w.a.db, x)).toMatchObject({ ok: false, why: ["Contest without asking is off."] });
    w.switchOn("contest");
    expect(checkLane(w.a.db, x).ok).toBe(true);
    const why = (patch: Partial<LaneInput>) => (checkLane(w.a.db, { ...x, ...patch }) as { why: string[] }).why;
    expect(why({ type: "fraud" })).toEqual(["Contest without asking doesn't cover fraud or unauthorised disputes."]);
    expect(why({ phase: "pre_arbitration" })).toEqual(["Only the first stage can go without asking."]);
    expect(why({ deducted: false })).toEqual(["The amount hasn't been deducted yet, so this would move new money."]);
    expect(why({ confidence: "likely" })).toEqual(["RAY isn't Sure."]);
    expect(why({ amount: 690_000 })).toEqual(["₹6,900 is above your approval limit of ₹2,000."]);
    expect(why({ deadline: now + 10 * MIN })).toEqual(["There isn't time left for a Stop window."]);
  });

  it("the guards run again when the Stop window ends: a lane switched off in the meantime blocks the filing", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.sanjay);
    w.repo.playbookRules.update(laneRuleId(LEAFY, "contest"), { status: "off" });
    await w.engine.advanceBy(2 * HOUR);
    const c = w.caseFor(PAYMENTS.sanjay);
    expect(w.actions(c.id, "contest_dispute")[0].status).toBe("failed");
    expect(w.dispute(DISPUTES.sanjay).status).toBe("open");
    expect(w.repo.cases.get(c.id)!.state).toBe("waiting_merchant");
  });

  it("the kill switch stops a held lane action too", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.sanjay);
    setKillSwitch(w.a.db, w.a.clock, { merchantId: LEAFY }, true);
    await w.engine.advanceBy(2 * HOUR);
    expect(w.dispute(DISPUTES.sanjay).status).toBe("open");
  });

  it("fraud Vulcan flagged: accept without asking (when on), else Ask with Accept first and Block card", async () => {
    const asked = newDispute({ type: "fraud", vulcan: "flagged" });
    await w.open(asked.id);
    const c1 = w.caseFor(asked.pay);
    expect(c1.situation).toBe("B");
    expect(c1.state).toBe("waiting_merchant");
    expect(w.proposals(c1.id).map((p) => p.label)).toEqual(["Accept dispute", "Contest dispute", expect.stringMatching(/^Block card ending \d{4}$/)]);
    // Never customer outreach on fraud.
    expect(w.proposals(c1.id).some((p) => p.tool === "send_message")).toBe(false);

    w.switchOn("accept");
    const auto = newDispute({ type: "fraud", vulcan: "flagged" });
    await w.open(auto.id);
    const c2 = w.caseFor(auto.pay);
    expect(w.actions(c2.id, "accept_dispute")[0].status).toBe("held");
    expect(holdsOf(w.a, c2)[0]).toMatchObject({ text: "Accepting this dispute", control: "Stop" });
    await w.engine.advanceBy(2 * HOUR);
    expect(w.repo.cases.get(c2.id)).toMatchObject({ state: "closed", outcome: "accepted", counts_as_saved: false });
  });

  it("fraud Vulcan didn't flag asks, even with the accept lane on", async () => {
    w.switchOn("accept");
    const d = newDispute({ type: "fraud", vulcan: "clear" });
    await w.open(d.id);
    const c = w.caseFor(d.pay);
    expect(c.state).toBe("waiting_merchant");
    expect(c.confidence).toBe("likely");
  });

  it("not received on an order that never shipped: Sure, accept", async () => {
    w.switchOn("accept");
    const d = newDispute({ type: "not_received", orderStatus: "processing" });
    await w.open(d.id);
    const c = w.caseFor(d.pay);
    expect(w.actions(c.id, "accept_dispute")[0].status).toBe("held");
  });

  it("quality disputes always ask", async () => {
    w.switchOn("contest");
    const d = newDispute({ type: "not_as_described" });
    await w.open(d.id);
    expect(w.caseFor(d.pay).state).toBe("waiting_merchant");
  });

  it("after three unchanged approvals of one type, RAY offers to stop asking (a proposed rule)", async () => {
    for (let i = 0; i < 3; i++) {
      const d = newDispute({ type: "duplicate" });
      await w.open(d.id);
      await w.tapLabel(w.caseFor(d.pay).id, "Contest dispute");
    }
    const rule = w.repo.playbookRules.get(`rule_cb_stop_asking_contest_duplicate_${LEAFY}`)!;
    expect(rule.status).toBe("proposed");
    expect(rule.text).toBe("You've approved contesting duplicate charge disputes 3 times. Stop asking for this type?");
  });
});

describe("deadlines", () => {
  it("the day before: one urgent ask and the opt-in urgent call to the merchant, ending with the decision card; never the cardholder", async () => {
    await w.open(DISPUTES.meera);
    const c = w.caseFor(PAYMENTS.meera);
    const deadline = w.notes(c.id, N.dispute)[0].payload.deadline as number;
    // Monday 10 AM + 3 business days.
    expect(deadline).toBe(w.a.clock.now() + 3 * DAY);
    await w.engine.advanceBy(2 * DAY);
    expect(w.alerts(c.id, "urgent_ask")).toHaveLength(1);
    const call = w.notes(c.id, "call_summary")[0];
    expect(call.payload.call_kind).toBe("urgent_merchant");
    const calls = w.repo.messages.list(eq(s.messages.case_id, c.id)).filter((m) => m.channel === "call");
    expect(calls.map((m) => m.to)).toEqual([merchantPhone(LEAFY)]);
    expect(w.alerts(c.id, "decision_card")).toHaveLength(1);

    // A call to the cardholder is refused by the guard.
    const r = await guardedCall("place_call", { kind: "paid_no_order_follow_up", to: "+919800000104", opening: "Hi Meera, this is Leafy Bakes about your ₹6,900 payment." }, { adapters: w.a, caseId: c.id });
    expect(r.status).toBe("blocked");
  });

  it("a few hours before: a strong pack above the limit isn't sent; the merchant is told and it lapses to lost", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.meera);
    const c = w.caseFor(PAYMENTS.meera);
    await w.engine.advanceBy(3 * DAY - 4 * HOUR);
    expect(w.notes(c.id, N.lapsed)).toHaveLength(1);
    expect(w.actions(c.id, "contest_dispute")).toHaveLength(0);
    expect(w.repo.cases.get(c.id)!.state).toBe("waiting_merchant");
    await w.engine.advanceBy(5 * HOUR);
    expect(w.notes(c.id, N.deadlinePassed)).toHaveLength(1);
    await settleDispute(w.a, LEAFY, DISPUTES.meera, "lost");
    expect(w.repo.cases.get(c.id)).toMatchObject({ state: "closed", outcome: "lost", counts_as_saved: false });
  });

  it("a few hours before: a strong pack within the limit is sent under the contest lane's deadline opt-in, still with a Stop window", async () => {
    // The lane was off when the dispute came in, so RAY asked.
    await w.open(DISPUTES.sanjay);
    const c = w.caseFor(PAYMENTS.sanjay);
    expect(c.state).toBe("waiting_merchant");
    // The merchant switches the lane on later but never answers this one.
    w.switchOn("contest");
    const deadline = w.notes(c.id, N.dispute)[0].payload.deadline as number;
    await w.engine.advanceBy(deadline - FINAL - w.a.clock.now());
    expect(w.alerts(c.id, "deadline_reply")).toHaveLength(1);
    const held = w.actions(c.id, "contest_dispute")[0];
    expect(held).toMatchObject({ status: "held", approved_by: laneRuleId(LEAFY, "contest") });
    expect(held.run_after).toBe(w.a.clock.now() + 2 * HOUR);
    await w.engine.advanceBy(2 * HOUR);
    expect(w.dispute(DISPUTES.sanjay).status).toBe("under_review");
    expect(w.a.clock.now()).toBeLessThan(deadline);
  });

  it("a few hours before: a weak pack lapses with a note to the merchant", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.deepa);
    const c = w.caseFor(PAYMENTS.deepa);
    const deadline = w.notes(c.id, N.dispute)[0].payload.deadline as number;
    await w.engine.advanceBy(deadline - FINAL - w.a.clock.now());
    expect(w.alerts(c.id, "deadline_lapse")[0].text).toMatch(/The proof is weak, so I'm not sending a reply; it will lapse unless you contest it\./);
    expect(w.actions(c.id, "contest_dispute")).toHaveLength(0);
  });

  it("the weekly insight finds the repeat pattern; its fix needs a tap", async () => {
    await w.open(DISPUTES.meera);
    await w.open(DISPUTES.deepa);
    const c = w.caseFor(PAYMENTS.meera);
    await w.engine.advanceBy(7 * DAY);
    const insight = w.repo.alerts.list(eq(s.alerts.kind, PATTERN_ALERT));
    expect(insight.map((x) => x.text)).toContain(
      "2 chargebacks in the last 30 days say the order never arrived: ₹8,750 at stake. Ask your courier for a delivery photo or OTP on every order, so the next reply has proof of delivery.",
    );
    expect(w.repo.playbookRules.get(`rule_cb_fix_reason_not_received_${LEAFY}`)!.status).toBe("proposed");
    expect(insight.every((x) => x.case_id === c.id || x.case_id === w.caseFor(PAYMENTS.deepa).id)).toBe(true);
    // Once a week.
    expect(insight).toHaveLength(1);
  });
});

const FINAL = 4 * HOUR;

describe("pre-arbitration (E) always asks, with the stage fee", () => {
  it("escalation after a lane contest comes back to the merchant", async () => {
    w.switchOn("contest");
    await w.open(DISPUTES.sanjay);
    await w.engine.advanceBy(2 * HOUR);
    const c = w.caseFor(PAYMENTS.sanjay);
    await escalateDispute(w.a, LEAFY, DISPUTES.sanjay, w.a.clock.now() + 5 * DAY);
    const k = w.repo.cases.get(c.id)!;
    expect(k.situation).toBe("E");
    expect(k.state).toBe("waiting_merchant");
    expect(w.notes(c.id, "verified").at(-1)!.payload.reason).toMatch(/pre-arbitration; losing costs ₹56,700 more/);
    // T+2 business days for pre-arbitration.
    expect(w.notes(c.id, N.dispute).at(-1)!.payload.deadline).toBe(w.a.clock.now() + 2 * DAY);
  });
});

describe("filing paths", () => {
  it("Dispute Responder: a Simulated hand-off, then the submit on the tap", async () => {
    setFiling(w.a.db, w.a.clock.now(), LEAFY, "dispute_responder");
    await w.open(DISPUTES.meera);
    const c = w.caseFor(PAYMENTS.meera);
    await w.tapLabel(c.id, "Contest dispute");
    expect(w.notes(c.id, N.filed)[0].payload).toMatchObject({ via: "dispute_responder", simulated: true });
    expect(w.dispute(DISPUTES.meera).status).toBe("under_review");
  });

  it("not enabled: RAY prepares the pack for the merchant to upload and files nothing", async () => {
    setFiling(w.a.db, w.a.clock.now(), LEAFY, "manual");
    await w.open(DISPUTES.meera);
    const c = w.caseFor(PAYMENTS.meera);
    expect(w.notes(c.id, "dispute_draft_created")).toHaveLength(0);
    await w.tapLabel(c.id, "Contest dispute");
    expect(w.notes(c.id, N.filed)[0].payload.via).toBe("manual");
    expect(w.dispute(DISPUTES.meera).status).toBe("open");
    expect(w.actions(c.id, "contest_dispute")).toHaveLength(0);
  });
});

describe("timers", () => {
  it("sets the deadline timers from RAY's deadline", async () => {
    await w.open(DISPUTES.deepa);
    const c = w.caseFor(PAYMENTS.deepa);
    const deadline = w.notes(c.id, N.dispute)[0].payload.deadline as number;
    const timers = w.repo.timers.list(eq(s.timers.case_id, c.id));
    const due = (k: string) => timers.find((t) => t.kind === k)!.due_at;
    expect(due(TIMERS.eve)).toBe(deadline - DAY);
    expect(due(TIMERS.final)).toBe(deadline - FINAL);
    expect(due(TIMERS.deadline)).toBe(deadline);
    // Razorpay's respond-by for Deepa is 9 days out; RAY's is T+3 business days.
    expect(deadline).toBeLessThan(w.dispute(DISPUTES.deepa).respond_by);
  });
});

describe("situation A: a chargeback threat before any dispute", () => {
  const RAHUL = "+919800000102";
  const EXTRA = "pay_LB1235RAHUL2";

  it("opens a chargeback case and resolves it through the paid-no-order flow: a refund, on the merchant's tap", async () => {
    await w.engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: RAHUL, body: RAHUL_THREAT });
    const c = w.repo.cases.list()[0];
    expect(c).toMatchObject({ moment: "chargeback", situation: "A", payment_id: EXTRA, state: "waiting_merchant" });
    expect(w.notes(c.id, N.threat)).toHaveLength(1);
    // The paid-no-order flow's own work, on this case: the match and its promise line.
    expect(w.notes(c.id, "pno_situation")[0].payload.situation).toBe("E");
    expect(w.sent(c.id)[0].body).toMatch(/we can see your payment of ₹499 at 7:04 AM on 12 Oct, UTR ending 0119/);
    // A threat never acts on a rule: it asks.
    expect(w.proposals(c.id)[0]).toMatchObject({ label: "Refund the extra ₹499", tool: "refund" });
    await w.tapLabel(c.id, "Refund the extra ₹499");
    expect(w.actions(c.id, "refund")[0]).toMatchObject({ status: "held", approved_by: "tap" });
    await w.engine.advanceBy(11 * MIN);
    expect(w.actions(c.id, "refund")[0].status).toBe("done");
  });

  it("a dispute that arrives later on that payment joins the case and becomes D, with the refund as proof", async () => {
    await w.engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: RAHUL, body: RAHUL_THREAT });
    const c = w.repo.cases.list()[0];
    await w.tapLabel(c.id, "Refund the extra ₹499");
    await w.engine.advanceBy(11 * MIN);
    w.repo.disputes.insert({
      id: "disp_LB_rahul", merchant_id: LEAFY, payment_id: EXTRA, amount: 49_900, reason_code: "4834", reason: "Duplicate charge", network: "Mastercard",
      phase: "chargeback", deducted: true, respond_by: w.a.clock.now() + 7 * DAY, status: "open", lane: null, created_at: w.a.clock.now(),
    });
    await w.open("disp_LB_rahul");
    expect(w.repo.cases.list()).toHaveLength(1);
    const k = w.repo.cases.get(c.id)!;
    expect(k.situation).toBe("D");
    expect(k.state).toBe("waiting_merchant");
    const pack = w.notes(c.id, N.pack).at(-1)!.payload as { facts: { refunded: boolean }; documents: Record<string, string[]> };
    expect(pack.facts.refunded).toBe(true);
    expect(pack.documents.refund_confirmation).toHaveLength(1);
    expect(w.proposals(c.id)[0].label).toBe("Contest dispute");
  });
});

describe("design language", () => {
  it("merchant-facing words: no banned words, no percentages, no em dashes", async () => {
    w.switchOn("contest");
    for (const k of ["sanjay", "deepa", "meera"] as const) await w.open(DISPUTES[k]);
    await w.engine.advanceBy(7 * DAY);
    const all = w.repo.cases.list().flatMap((c) => w.events(c.id));
    const texts = [
      ...w.repo.alerts.list().map((x) => x.text),
      ...all.filter((e) => e.payload.kind === "decided").map((e) => String(e.payload.summary)),
      ...all.filter((e) => e.type === "finding").map((e) => String(e.payload.text)),
      ...all.filter((e) => e.payload.kind === "actions_proposed").flatMap((e) => (e.payload.actions as { label: string }[]).map((p) => p.label)),
    ];
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) {
      expect(bannedWordsIn(t), t).toEqual([]);
      expect(t, t).not.toMatch(/%|—/);
    }
  });
});

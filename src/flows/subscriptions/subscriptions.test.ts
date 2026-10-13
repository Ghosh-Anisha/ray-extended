// Step 9, Done when: scenario tests for situations A to F on the fake clock,
// including Karan's D case with no rule (the merchant picks an option and it
// becomes a proposed rule) and Acme's F case handing off to Collect; B pays
// the subscription's own pending invoice, never a fresh link. Plus the call
// to subscribers above the value limit (post-call summary into decide), the
// duplicate refund, no response closing as lost, channel choice and consent.
// Every AI call is served from replay fixtures (recorded in Claude Code).
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bannedWordsIn, hasEmDash } from "@/ai/grounding";
import * as s from "@/db/schema";
import { guardedCall } from "@/guards";
import { requestChange, setRuleStatus, tap } from "@/surfaces/actions";
import { caseView } from "@/surfaces/views";
import { COLLECT_HANDOFF, listCollectHandoffs, setupSweep } from ".";
import { ACME, DAY, FITLOOP, HOUR, KARAN, MIN, NEHA, SHARMA, STACKLY, subWorld, type SubWorld } from "./test-helpers";

vi.setConfig({ testTimeout: 30_000 });

let w: SubWorld;
beforeEach(async () => {
  w = await subWorld();
});
afterEach(() => w.close());

const LINK = /https:\/\/pay\.sim\.example\/\S+/;
const noFallbacks = () => expect(w.fallbacks()).toEqual([]);
const cleanCopy = (body: string) => {
  expect(bannedWordsIn(body)).toEqual([]);
  expect(hasEmDash(body)).toBe(false);
};
// No fresh link and no charge: only the subscription's own invoice.
const noFreshLink = (caseId: string) => {
  expect(w.actions(caseId, "payment_link")).toEqual([]);
  expect(w.repo.rzpLinks.list()).toEqual([]);
};

describe("A: sign-up started, mandate never finished", () => {
  it("after 30 min sends one message with the first invoice's link and why it failed, then closes saved when activated", async () => {
    const sub = w.signUp({ minutesAgo: 20, errorReason: "The UPI app timed out before the AutoPay was approved." });
    expect(await setupSweep(w.engine, w.a, FITLOOP)).toEqual([]); // not 30 min yet
    w.a.clock.advance(11 * MIN);
    await setupSweep(w.engine, w.a, FITLOOP);
    const kase = w.only(FITLOOP);
    expect(w.state(kase.id)).toMatchObject({ situation: "A", state: "verifying", side: "customer_or_bank", confidence: "sure" });
    const out = w.sent(kase.id);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: "email", to: "riya.kapoor@example.com" });
    expect(out[0].body).toContain("https://pay.sim.example/i/inv_FL_riya_1");
    expect(out[0].body).toMatch(/FitLoop/);
    expect(out[0].body).toContain("₹499");
    expect(out[0].body).toMatch(/timed out/);
    cleanCopy(out[0].body);
    // Runs alone: no tap, no rule.
    expect(w.actions(kase.id).map((x) => [x.tool, x.status, x.approved_by])).toEqual([
      ["pay_pending_invoice", "done", null],
      ["send_message", "done", null],
    ]);
    expect(w.actions(kase.id, "send_message")[0].args.kind).toBe("recovery_link");
    noFreshLink(kase.id);
    // A second sweep is a duplicate.
    expect((await setupSweep(w.engine, w.a, FITLOOP))[0]).toMatchObject({ outcome: "duplicate" });

    await w.emit(FITLOOP, "subscription.activated", sub);
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "active_again", counts_as_saved: true });
    noFallbacks();
  });
});

describe("B: debit failed and retries ran out (Karan, ₹499)", () => {
  it("subscription.pending is only the early warning: Likely: checking, no message, Razorpay keeps retrying", async () => {
    await w.emit(FITLOOP, "subscription.pending", KARAN.sub);
    const kase = w.only(FITLOOP);
    expect(w.state(kase.id)).toMatchObject({ state: "likely", situation: "B", cause: "retrying" });
    expect(w.sent(kase.id)).toEqual([]);
    expect(w.repo.alerts.list().filter((x) => x.case_id === kase.id)[0].text).toBe(
      "Karan Mehta's ₹499 FitLoop Monthly payment didn't go through. Razorpay is retrying, and I'm watching it.",
    );
    // The retry works: fixed itself, counts nowhere.
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub);
    expect(w.state(kase.id)).toMatchObject({ state: "fixed_itself", counts_as_saved: false });
  });

  it("pays the subscription's own pending invoice by sharing its link, never a fresh link and never a charge", async () => {
    await w.emit(FITLOOP, "subscription.pending", KARAN.sub);
    await w.emit(FITLOOP, "subscription.halted", KARAN.sub);
    const kase = w.only(FITLOOP);
    expect(w.state(kase.id)).toMatchObject({ state: "verifying", cause: "retries_ran_out" });
    const [msg] = w.sent(kase.id);
    expect(msg).toMatchObject({ channel: "email", to: KARAN.email });
    expect(msg.body.match(LINK)![0]).toBe("https://pay.sim.example/i/inv_FL_karan_3");
    // No funds: the steps say so; the details are there to check.
    expect(msg.body).toMatch(/enough balance/);
    expect(msg.body).toContain("FitLoop");
    expect(msg.body).toContain("₹499");
    cleanCopy(msg.body);
    const inv = w.actions(kase.id, "pay_pending_invoice")[0];
    expect(inv.result).toMatchObject({ invoice_id: "inv_FL_karan_3", subscription_id: KARAN.sub });
    noFreshLink(kase.id);
    // Nothing was charged by RAY: the invoice is still waiting for Karan.
    expect(w.repo.subInvoices.get("inv_FL_karan_3")!.status).toBe("issued");
    expect(w.repo.rzpPayments.list(eq(s.rzpPayments.merchant_id, FITLOOP))).toEqual([]);

    // Karan pays by the link: active again, saved.
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub);
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "active_again", counts_as_saved: true });
    expect(w.repo.subscriptions.get(KARAN.sub)!.status).toBe("active");
  });

  it("calls Karan a day later under FitLoop's call rule (above ₹500, opted in, within calling hours) and the post-call summary feeds decide", async () => {
    w.a.voice.setCallSim(KARAN.phone, { outcome: "answered", reply: "My salary comes on the 15th, I'll pay it then.", promise: "Pay on 15 Oct" });
    await w.emit(FITLOOP, "subscription.halted", KARAN.sub);
    const kase = w.only(FITLOOP);
    await w.engine.advanceBy(24 * HOUR);
    // The playbook's call rule is the approval: no tap.
    const [call] = w.actions(kase.id, "place_call");
    expect(call).toMatchObject({ status: "done", approved_by: "rule_sub_call_m_fitloop" });
    expect(call.args).toMatchObject({ kind: "subscription_save", to: KARAN.phone, opening: "Hi Karan, this is FitLoop about your ₹499 FitLoop Monthly payment." });
    const summary = w.notes(kase.id, "call_summary");
    expect(summary).toHaveLength(1);
    expect(summary[0].payload).toMatchObject({ call_kind: "subscription_save", outcome: "answered", simulated: true });
    // decide read the summary.
    expect(w.repo.aiCalls.list().filter((c) => c.job === "decide" && c.case_id === kase.id)).toHaveLength(1);
    expect(w.notes(kase.id, "sub_call_decided")[0].payload).toMatchObject({ proposal: "send_update_link", source: "replay" });
    expect(w.state(kase.id).state).toBe("waiting_merchant");
    expect(w.proposals(kase.id).map((p) => p.label)).toEqual(["Send Karan the link again", "Cancel Karan's plan"]);
    // One call only.
    expect(w.a.db.select().from(s.messages).where(eq(s.messages.channel, "call")).all()).toHaveLength(1);

    // Paid while the card is open: closes, saved.
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub);
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "active_again", counts_as_saved: true });
    noFallbacks();
  });

  it("without the call rule, RAY offers the call for a tap", async () => {
    setRuleStatus(w.a, { merchantId: FITLOOP, ruleId: "rule_sub_call_m_fitloop", status: "off" });
    await w.emit(FITLOOP, "subscription.halted", KARAN.sub);
    const kase = w.only(FITLOOP);
    await w.engine.advanceBy(24 * HOUR);
    expect(w.actions(kase.id, "place_call")).toEqual([]);
    expect(w.state(kase.id).state).toBe("waiting_merchant");
    expect(w.proposals(kase.id).map((p) => p.label)).toEqual(["Call Karan"]);
    w.a.voice.setCallSim(KARAN.phone, { outcome: "answered", reply: "My salary comes on the 15th, I'll pay it then.", promise: "Pay on 15 Oct" });
    await w.tapLabel(kase.id, "Call Karan");
    expect(w.actions(kase.id, "place_call")[0]).toMatchObject({ status: "done", approved_by: "tap" });
  });

  it("never calls a subscriber who hasn't opted in to calls", async () => {
    w.a.messaging.setConsent(KARAN.id, "call", "opted_out", "test");
    await w.emit(FITLOOP, "subscription.halted", KARAN.sub);
    const kase = w.only(FITLOOP);
    await w.engine.advanceBy(24 * HOUR);
    expect(w.state(kase.id).state).toBe("verifying");
    expect(w.proposals(kase.id).some((p) => p.tool === "place_call")).toBe(false);
  });

  it("no response: Razorpay keeps it halted and the case closes as lost after 7 days", async () => {
    await w.emit(FITLOOP, "subscription.halted", KARAN.sub);
    const kase = w.only(FITLOOP);
    await w.engine.advanceBy(7 * DAY + MIN);
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "lost", counts_as_saved: false });
    expect(w.repo.subscriptions.get(KARAN.sub)!.status).toBe("halted");
  });

  it("paid by link and the bank retry also succeeds: the extra ₹499 is refunded on approval", async () => {
    await w.emit(FITLOOP, "subscription.halted", KARAN.sub);
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub);
    const first = w.only(FITLOOP);
    expect(w.state(first.id).state).toBe("closed");
    // The bank's retry for the same month also went through.
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub);
    const dup = w.cases(FITLOOP).find((c) => c.id !== first.id)!;
    expect(w.state(dup.id)).toMatchObject({ state: "waiting_merchant", cause: "duplicate_charge", situation: "B" });
    expect(w.proposals(dup.id).map((p) => p.label)).toEqual(["Refund ₹499"]);
    // Nothing moves without the tap.
    expect(w.actions(dup.id, "refund")).toEqual([]);
    await w.tapLabel(dup.id, "Refund ₹499");
    expect(w.actions(dup.id, "refund")[0]).toMatchObject({ status: "held", approved_by: "tap" });
    await w.engine.advanceBy(11 * MIN);
    expect(w.state(dup.id)).toMatchObject({ state: "closed", outcome: "duplicate_refunded", counts_as_saved: false });
    expect(w.repo.rzpRefunds.list()).toHaveLength(1);
  });
});

describe("C: mandate cancelled in the UPI app (Neha, Sharma Tutorials)", () => {
  it("asks once why; payment trouble sets it up again with the next invoice's link", async () => {
    await w.a.webhooks.emit({ merchantId: SHARMA, event: "token.cancelled", tokenId: "token_STU_neha" });
    const kase = w.only(SHARMA);
    expect(w.state(kase.id)).toMatchObject({ situation: "C", state: "waiting_customer" });
    const [q] = w.sent(kase.id);
    expect(q.body).toMatch(/Was that on purpose/);
    expect(q.body).not.toMatch(LINK);
    expect(w.actions(kase.id, "send_message")[0].args.kind).toBe("question");

    await w.says(SHARMA, NEHA.email, "I changed my bank account last week, the old one is closed.", "email");
    expect(w.state(kase.id).state).toBe("verifying");
    const steps = w.sent(kase.id)[1];
    expect(steps.body).toMatch(/set up AutoPay again/);
    expect(steps.body).not.toMatch(LINK);
    // Asked once only.
    expect(w.notes(kase.id, "sub_question_asked")).toHaveLength(1);

    // The next cycle falls due: Razorpay issues the invoice, RAY shares its link.
    await w.emit(SHARMA, "subscription.pending", NEHA.sub);
    expect(w.only(SHARMA).id).toBe(kase.id);
    const link = w.sent(kase.id)[2];
    expect(link.body.match(LINK)![0]).toBe("https://pay.sim.example/i/inv_STU_neha_3");
    noFreshLink(kase.id);
    await w.emit(SHARMA, "subscription.charged", NEHA.sub);
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "active_again", counts_as_saved: true });
    noFallbacks();
  });

  it("otherwise treats it as D: Sharma Tutorials' pause means skip a month", async () => {
    await w.a.webhooks.emit({ merchantId: SHARMA, event: "token.cancelled", tokenId: "token_STU_neha" });
    const kase = w.only(SHARMA);
    await w.says(SHARMA, NEHA.email, "Yes I cancelled it. The classes are too expensive for us now, please stop the plan.", "email");
    expect(w.state(kase.id)).toMatchObject({ situation: "D", state: "waiting_merchant", cause: "cancel_request" });
    expect(w.proposals(kase.id).map((p) => p.label)).toEqual(["Offer Neha a skipped month", "Offer Neha another way to pay", "Cancel Neha's plan"]);
    noFallbacks();
  });
});

describe("D: cancel my plan (Karan, FitLoop)", () => {
  async function karanActive() {
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub); // pays the pending invoice; no case
    expect(w.cases(FITLOOP)).toEqual([]);
  }

  it("no rule: the merchant picks from 3 options, RAY acts, and the pick becomes a proposed rule", async () => {
    await karanActive();
    await w.says(FITLOOP, KARAN.phone, "Please cancel my FitLoop plan, it's too expensive for me right now.");
    const kase = w.only(FITLOOP);
    expect(w.state(kase.id)).toMatchObject({ situation: "D", state: "waiting_merchant" });
    const options = w.proposals(kase.id);
    expect(options.map((p) => p.label)).toEqual(["Offer Karan 20% off next month", "Offer Karan a month's pause", "Cancel Karan's plan"]);
    // No plan change is ever offered.
    expect(options.some((p) => /plan change|upgrade|downgrade/i.test(p.label))).toBe(false);
    // The promise line went on WhatsApp (Karan wrote there, opted in).
    const [promise] = w.sent(kase.id);
    expect(promise).toMatchObject({ channel: "whatsapp", to: KARAN.phone });
    expect(promise.body).toMatch(/You'll hear from us by 12:00 PM/);
    // Only the seeded call rules so far; no save-offer rule.
    expect(w.repo.playbookRules.list(eq(s.playbookRules.moment, "subscription")).map((r) => r.rule_json.tool)).toEqual(["place_call", "place_call"]);

    await w.tapLabel(kase.id, "Offer Karan a month's pause");
    const offer = w.sent(kase.id)[1];
    expect(offer.body).toMatch(/pause your FitLoop Monthly for a month/);
    const rules = w.repo.playbookRules.list(eq(s.playbookRules.moment, "subscription")).filter((r) => r.rule_json.tool !== "place_call");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ status: "proposed", source: "merchant", rule_json: { tool: "pause_subscription", offer: "pause", reasons: ["price"] } });
    expect(rules[0].text).toBe("When a subscriber wants to cancel because it costs too much, offer to pause the plan for a month, then resume it.");

    await w.says(FITLOOP, KARAN.phone, "Yes please, pause it");
    expect(w.repo.subscriptions.get(KARAN.sub)!.status).toBe("paused");
    expect(w.actions(kase.id, "pause_subscription")[0]).toMatchObject({ status: "done", approved_by: "tap" });
    expect(w.sent(kase.id)[2].body).toMatch(/paused until 11 Nov/);
    // Pause has no end date in the API: RAY scheduled the resume.
    const resume = w.repo.timers.list(eq(s.timers.case_id, kase.id)).find((t) => t.kind === "sub_resume")!;
    expect(resume.due_at).toBe(w.a.clock.now() + 30 * DAY);
    expect(w.state(kase.id).state).toBe("verifying");

    await w.engine.advanceBy(30 * DAY);
    expect(w.repo.subscriptions.get(KARAN.sub)!.status).toBe("active");
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "resumed", counts_as_saved: true });
    noFallbacks();
  });

  it("with the rule approved, the one save offer runs alone and the same rule covers the scheduled resume", async () => {
    await karanActive();
    const rule = w.approveRule(FITLOOP, { tool: "pause_subscription", offer: "pause", reasons: ["price"] }, "When a subscriber wants to cancel because it costs too much, offer to pause the plan for a month, then resume it.");
    await w.says(FITLOOP, KARAN.phone, "Please cancel my FitLoop plan, it's too expensive for me right now.");
    const kase = w.only(FITLOOP);
    expect(w.state(kase.id).state).toBe("verifying");
    expect(w.sent(kase.id).map((m) => w.actions(kase.id, "send_message").find((x) => x.result?.message_id === m.id)?.args.kind)).toEqual(["question"]);
    await w.says(FITLOOP, KARAN.phone, "ok pause it");
    expect(w.actions(kase.id, "pause_subscription")[0]).toMatchObject({ status: "done", approved_by: rule.id });
    // The card listed the resume as a follow-up of the pause.
    const offered = w.events(kase.id).filter((e) => e.payload.kind === "actions_proposed").at(-1)!.payload.actions as { followUps?: { tool: string }[] }[];
    expect(offered[0].followUps!.map((f) => f.tool)).toEqual(["pause_subscription", "resume_subscription"]);
    await w.engine.advanceBy(30 * DAY);
    // No second ask on resume day.
    expect(w.actions(kase.id, "resume_subscription")[0]).toMatchObject({ status: "done", approved_by: rule.id });
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "resumed", counts_as_saved: true });
    expect(w.repo.subscriptions.get(KARAN.sub)!.status).toBe("active");
  });

  it("the discount: Karan says yes and FitLoop's Dashboard offer is linked to the subscription, with the merchant's tap", async () => {
    await karanActive();
    await w.says(FITLOOP, KARAN.phone, "Please cancel my FitLoop plan, it's too expensive for me right now.");
    const kase = w.only(FITLOOP);
    const card = w.proposals(kase.id)[0];
    expect(card.followUps).toEqual([{ tool: "apply_offer", args: { subscription_id: KARAN.sub, offer_id: "offer_FL_20off" } }]);
    await w.tapLabel(kase.id, "Offer Karan 20% off next month");
    expect(w.sent(kase.id)[1].body).toMatch(/take 20% off your next FitLoop Monthly payment/);
    expect(w.actions(kase.id, "apply_offer")).toEqual([]); // nothing applied before the yes
    const rule = w.repo.playbookRules.list(eq(s.playbookRules.moment, "subscription")).find((r) => r.status === "proposed")!;
    expect(rule).toMatchObject({ rule_json: { tool: "apply_offer", offer: "discount", reasons: ["price"] } });
    expect(rule.text).toBe("When a subscriber wants to cancel because it costs too much, offer 20% off the next payment.");

    await w.says(FITLOOP, KARAN.phone, "Yes, ok with the discount");
    expect(w.actions(kase.id, "apply_offer")[0]).toMatchObject({ status: "done", approved_by: "tap" });
    expect(w.repo.subscriptions.get(KARAN.sub)).toMatchObject({ status: "active", offer_id: "offer_FL_20off" });
    expect(w.sent(kase.id).at(-1)!.body).toMatch(/20% comes off your next FitLoop Monthly payment/);
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "discount_applied", counts_as_saved: true });
    noFallbacks();
  });

  it("an offer only links to an active subscription, and only the merchant's own offer", async () => {
    const rzp = w.a.razorpay(FITLOOP);
    await expect(rzp.applyOffer(KARAN.sub, "offer_FL_20off")).rejects.toMatchObject({ code: "INVALID_STATE" }); // Karan is pending
    await karanActive();
    await expect(rzp.applyOffer(KARAN.sub, "offer_someone_else")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rzp.applyOffer(KARAN.sub, "offer_FL_20off")).offer_id).toBe("offer_FL_20off");
  });

  it("a pause rule covers only its own scheduled resume, nothing else", async () => {
    await karanActive();
    const rule = w.approveRule(FITLOOP, { tool: "pause_subscription", offer: "pause", reasons: ["price"] }, "Pause rule");
    await w.says(FITLOOP, KARAN.phone, "Please cancel my FitLoop plan, it's too expensive for me right now.");
    const kase = w.only(FITLOOP);
    const ap = { by: "rule" as const, ruleId: rule.id, evidenceRef: kase.id };
    // Before it paused anything, the rule can't resume or cancel.
    expect((await guardedCall("resume_subscription", { subscription_id: KARAN.sub }, { adapters: w.a, caseId: kase.id, approval: ap })).status).toBe("blocked");
    expect((await guardedCall("cancel_subscription", { subscription_id: KARAN.sub }, { adapters: w.a, caseId: kase.id, approval: ap })).status).toBe("blocked");
    expect((await guardedCall("apply_offer", { subscription_id: KARAN.sub, offer_id: "offer_FL_20off" }, { adapters: w.a, caseId: kase.id, approval: ap })).status).toBe("blocked");
  });

  it("with a cancel rule too, a no to the offer cancels cleanly without a tap", async () => {
    await karanActive();
    w.approveRule(FITLOOP, { tool: "pause_subscription", offer: "pause", reasons: ["price"] }, "Pause rule");
    const cancelRule = w.approveRule(FITLOOP, { tool: "cancel_subscription", offer: "cancel", reasons: ["price"] }, "Cancel rule");
    await w.says(FITLOOP, KARAN.phone, "Please cancel my FitLoop plan, it's too expensive for me right now.");
    const kase = w.only(FITLOOP);
    await w.says(FITLOOP, KARAN.phone, "No thanks, just cancel");
    expect(w.actions(kase.id, "cancel_subscription")[0]).toMatchObject({ status: "done", approved_by: cancelRule.id });
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "cancelled", counts_as_saved: false });
  });

  it("one save offer only: a no cancels cleanly after the merchant's tap", async () => {
    await karanActive();
    await w.says(FITLOOP, KARAN.phone, "Please cancel my FitLoop plan, it's too expensive for me right now.");
    const kase = w.only(FITLOOP);
    await w.tapLabel(kase.id, "Offer Karan a month's pause");
    await w.says(FITLOOP, KARAN.phone, "No thanks, just cancel");
    expect(w.state(kase.id).state).toBe("waiting_merchant");
    expect(w.proposals(kase.id).map((p) => p.label)).toEqual(["Cancel Karan's plan"]);
    await w.tapLabel(kase.id, "Cancel Karan's plan");
    expect(w.repo.subscriptions.get(KARAN.sub)!.status).toBe("cancelled");
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "cancelled", counts_as_saved: false });
    expect(w.notes(kase.id, "sub_offer_made")).toHaveLength(1);
    expect(w.sent(kase.id).at(-1)!.body).toMatch(/cancelled as you asked/);
  });
});

describe("E: I didn't authorise this renewal", () => {
  async function karanCharged() {
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub);
  }

  it("pulls the proof, drafts the reply, and the reply needs the merchant's tap", async () => {
    await karanCharged();
    await w.says(FITLOOP, KARAN.phone, "I didn't authorise this renewal of 499. I'll raise a chargeback with my bank.");
    const kase = w.only(FITLOOP);
    expect(w.state(kase.id)).toMatchObject({ situation: "E", state: "waiting_merchant", cause: "didnt_authorise" });
    const findings = w.events(kase.id).filter((e) => e.type === "finding");
    expect(findings.map((f) => f.evidence_ref)).toEqual(expect.arrayContaining(["mdt_FL_karan", "inv_FL_karan_3"]));
    expect(findings.map((f) => String(f.payload.text)).join(" ")).toMatch(/approved the UPI AutoPay on .* reference ending 7302/);
    expect(findings.map((f) => String(f.payload.text)).join(" ")).toMatch(/pre-debit notice/);
    // Strong proof, no refund rule: reply only.
    const options = w.proposals(kase.id);
    expect(options.map((p) => p.label)).toEqual(["Send Karan the proof"]);
    const draft = String(options[0].args.body);
    expect(draft).not.toMatch(/https?:\/\//);
    expect(draft).toContain("7302");
    cleanCopy(draft);

    // Without the tap the reply can't go.
    const blocked = await guardedCall("send_message", options[0].args, { adapters: w.a, caseId: kase.id });
    expect(blocked.status).toBe("blocked");
    await w.tapLabel(kase.id, "Send Karan the proof");
    const reply = w.actions(kase.id, "send_message").find((x) => x.args.kind === "didnt_authorise_reply" && x.status === "done")!;
    expect(reply.approved_by).toBe("tap");
    expect(w.state(kase.id).state).toBe("verifying");
    noFallbacks();
  });

  it("weak proof: proposes the refund first", async () => {
    await karanCharged();
    w.repo.mandates.update("mdt_FL_karan", { authorised_at: null, auth_ref: null });
    await w.says(FITLOOP, KARAN.phone, "I didn't authorise this renewal of 499. I'll raise a chargeback with my bank.");
    const kase = w.only(FITLOOP);
    expect(w.proposals(kase.id).map((p) => p.label)).toEqual(["Refund ₹499", "Send Karan the proof"]);
  });
});

describe("F: B2B renewal failed (Acme Logistics, Stackly)", () => {
  it("emails the billing contact the invoice with a bank-transfer option, then hands off to Collect if unpaid", async () => {
    await w.emit(STACKLY, "subscription.halted", ACME.sub);
    const kase = w.only(STACKLY);
    expect(w.state(kase.id)).toMatchObject({ situation: "F", state: "verifying", cause: "b2b_renewal_failed" });
    const [msg] = w.sent(kase.id);
    expect(msg).toMatchObject({ channel: "email", to: ACME.email });
    expect(msg.body).toMatch(/bank transfer/);
    expect(msg.body).toContain("₹24,000");
    expect(msg.body.match(LINK)![0]).toBe("https://pay.sim.example/i/inv_ST_acme_3");
    noFreshLink(kase.id);
    expect(listCollectHandoffs(w.a.db)).toEqual([]);

    await w.engine.advanceBy(7 * DAY + MIN);
    const handoffs = listCollectHandoffs(w.a.db, STACKLY);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({
      kind: COLLECT_HANDOFF,
      case_id: kase.id,
      subscription_id: ACME.sub,
      invoice: { id: "inv_ST_acme_3", amount: 2_400_000, short_url: "https://pay.sim.example/i/inv_ST_acme_3" },
      buyer: { customer_id: ACME.id, name: "Acme Logistics", email: ACME.email },
    });
    expect(w.state(kase.id)).toMatchObject({ state: "closed", outcome: "handed_to_collect", counts_as_saved: false });
    // Stackly never calls.
    expect(w.a.db.select().from(s.messages).where(eq(s.messages.channel, "call")).all()).toEqual([]);
  });

  it("paid before the hand-off: no Collect event", async () => {
    await w.emit(STACKLY, "subscription.halted", ACME.sub);
    await w.emit(STACKLY, "subscription.charged", ACME.sub);
    await w.engine.advanceBy(7 * DAY + MIN);
    expect(listCollectHandoffs(w.a.db)).toEqual([]);
    expect(w.only(STACKLY)).toMatchObject({ state: "closed", counts_as_saved: true });
  });
});

describe("channels and consent", () => {
  it("an email opt-out blocks the recovery message; the case goes to the merchant", async () => {
    w.a.messaging.setConsent(KARAN.id, "email", "opted_out", "test");
    await w.emit(FITLOOP, "subscription.halted", KARAN.sub);
    const kase = w.only(FITLOOP);
    expect(w.sent(kase.id)).toEqual([]);
    expect(w.state(kase.id).state).toBe("waiting_merchant");
  });

  it("the case page shows the moment by its design-language name", async () => {
    await w.emit(FITLOOP, "subscription.halted", KARAN.sub);
    const v = await caseView(w.a, w.only(FITLOOP).id);
    expect(v.moment).toBe("Subscription stopped");
    expect(v.state.label).toBe("Checking it worked");
  });

  it("a rule only applies after Approve rule", async () => {
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub);
    await w.says(FITLOOP, KARAN.phone, "Please cancel my FitLoop plan, it's too expensive for me right now.");
    const kase = w.only(FITLOOP);
    await w.tapLabel(kase.id, "Offer Karan a month's pause");
    const rule = w.repo.playbookRules.list(eq(s.playbookRules.moment, "subscription")).find((r) => r.status === "proposed")!;
    setRuleStatus(w.a, { merchantId: FITLOOP, ruleId: rule.id, status: "approved" });
    expect(w.repo.playbookRules.get(rule.id)!.status).toBe("approved");
  });
});

describe("Step 9 fixtures", () => {
  it("are all on disk under their key, labelled recorded in Claude Code", async () => {
    const fs = await import("node:fs");
    const { loadClaudeCodeSources } = await import("@/ai/claude-code-fixtures");
    const { fixturePath, DEFAULT_FIXTURES_DIR } = await import("@/ai/fixtures");
    const { fixtureKey } = await import("@/ai/key");
    const { SUBSCRIPTION_SOURCES } = await import("./fixtures");
    const entries = loadClaudeCodeSources(SUBSCRIPTION_SOURCES);
    expect(new Set(entries.map((e) => e.job))).toEqual(new Set(["understand", "decide", "write"]));
    for (const e of entries) {
      if (e.job === "investigate") continue;
      const file = fixturePath(DEFAULT_FIXTURES_DIR, e.job, fixtureKey(e.job, e.input));
      expect(fs.existsSync(file), `${e.name}: run npx tsx src/flows/subscriptions/fixtures.ts`).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).label).toBe("recorded in Claude Code");
    }
  });
});

describe("Change", () => {
  async function eCard() {
    await w.emit(FITLOOP, "subscription.charged", KARAN.sub);
    await w.says(FITLOOP, KARAN.phone, "I didn't authorise this renewal of 499. I'll raise a chargeback with my bank.");
    return w.only(FITLOOP);
  }

  it("wording only: the write job redrafts the reply and the same card comes back", async () => {
    const kase = await eCard();
    const before = w.proposals(kase.id);
    await requestChange(w.engine, w.a, { caseId: kase.id, text: "Make it shorter and friendlier" });
    const after = w.proposals(kase.id);
    expect(after.map((p) => p.label)).toEqual(before.map((p) => p.label));
    expect(after[0].id).not.toBe(before[0].id);
    expect(after[0].args.body).not.toBe(before[0].args.body);
    expect(String(after[0].args.body)).toContain("7302");
    cleanCopy(String(after[0].args.body));
    noFallbacks();
  });

  it("a different action voids the old card; the new one needs a tap", async () => {
    const kase = await eCard();
    const old = w.proposals(kase.id)[0];
    await requestChange(w.engine, w.a, { caseId: kase.id, text: "Just refund him instead" });
    expect(w.proposals(kase.id).map((p) => p.label)).toEqual(["Refund ₹499", "Send Karan the proof"]);
    expect(w.notes(kase.id, "sub_change_voided")).toHaveLength(1);
    // The old card's tap no longer works.
    await tap(w.engine, w.a, { caseId: kase.id, choice: "approve", proposalId: old.id });
    expect(w.notes(kase.id, "tap_ignored")).toHaveLength(1);
    expect(w.actions(kase.id, "send_message").filter((x) => x.args.kind === "didnt_authorise_reply")).toEqual([]);
    expect(w.actions(kase.id, "refund")).toEqual([]);
    await w.tapLabel(kase.id, "Refund ₹499");
    expect(w.actions(kase.id, "refund")[0]).toMatchObject({ status: "held", approved_by: "tap" });
  });
});

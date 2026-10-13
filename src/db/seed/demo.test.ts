// The demo world (docs/ui-rebuild.md section 4): every number on Home is
// computed from rows, and the cases that need the merchant really are waiting
// with real proposals, from recorded answers (no AI call falls back).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdapters } from "@/adapters";
import { fakeClock } from "@/adapters/clock";
import { bannedWordsIn, hasEmDash } from "@/ai/grounding";
import { openMigratedDb } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { DEMO_NOW } from "@/db/seed";
import { openProposals } from "@/engine/orchestrator";
import { heroCases } from "@/surfaces/refs";
import { hoursLabel, merchantStats, rupees } from "@/surfaces/stats";
import { alertsView, caseView, evidence, inboxView } from "@/surfaces/views";
import { seedDemo } from "./demo";

vi.setConfig({ testTimeout: 60_000 });
const LEAFY = "m_leafy_bakes";

let db: ReturnType<typeof openMigratedDb>;
let a: ReturnType<typeof createAdapters>;
beforeAll(async () => {
  db = openMigratedDb(":memory:");
  await seedDemo(db);
  a = createAdapters(db, fakeClock(DEMO_NOW), { RAZORPAY_MODE: "mock" });
});
afterAll(() => db.$client.close());

describe("Leafy Bakes on Tue 13 Oct 2026, 10:00 AM", () => {
  it("has four cases waiting on the merchant, ₹8,450 in all", () => {
    const stats = merchantStats(a, LEAFY);
    expect(stats.needsYou.count).toBe(4);
    expect(rupees(stats.needsYou.stake)).toBe("₹8,450");
    const needs = inboxView(a, LEAFY).tabs[0].rows;
    expect(needs.map((r) => `${r.name} ${r.amount}`)).toEqual(["Karan Mehta ₹4,252", "Neha K ₹2,400", "Priya Sharma ₹1,299", "Rahul M ₹499"]);
  });

  it("splits the inbox into Needs you 4, RAY is handling 13 and Closed 23", () => {
    expect(inboxView(a, LEAFY).tabs.map((t) => [t.label, t.rows.length])).toEqual([["Needs you", 4], ["RAY is handling", 13], ["Closed", 23]]);
  });

  it("seeds an openable example for every moment and keeps filtered counts tied to returned cases", () => {
    const moments = ["paid_no_order", "international", "subscription", "chargeback", "collect", "whose_side", "ticket", "settlement_hold", "ai_chat_order"] as const;
    const repo = createRepository(db);
    for (const moment of moments) {
      const filtered = inboxView(a, LEAFY, moment);
      const rows = filtered.tabs.flatMap((tab) => tab.rows);
      expect(rows.length, moment).toBeGreaterThan(0);
      expect(rows.every((row) => row.momentKey === moment), moment).toBe(true);
      for (const row of rows) {
        expect(repo.cases.get(row.id)?.merchant_id).toBe(LEAFY);
        expect(caseView(a, row.id).id).toBe(row.id);
      }
      expect(filtered.tabs.reduce((sum, tab) => sum + tab.rows.length, 0)).toBe(rows.length);
    }
  });

  it("connects the failed international payment to its openable card-declined case", () => {
    const repo = createRepository(db);
    const payment = repo.rzpPayments.get("pay_LB_emma_failed");
    expect(payment).toMatchObject({ merchant_id: LEAFY, status: "failed", error_reason: "international_transaction_not_allowed" });
    const related = repo.cases.list(eq(s.cases.payment_id, "pay_LB_emma_failed")).find((c) => c.merchant_id === LEAFY);
    expect(related).toMatchObject({ id: "case_demo_emma", moment: "international", merchant_id: LEAFY });
    expect(caseView(a, related!.id).moment).toBe("Card declined abroad");
  });

  it("computes Home's numbers from the rows", () => {
    const st = merchantStats(a, LEAFY);
    expect(rupees(st.saved.amount)).toBe("₹1,84,300");
    expect(st.saved.changePct).toBe(18);
    expect(hoursLabel(st.timeSavedMinutes)).toBe("11.5 h");
    expect(st.closed.count).toBe(23);
    expect(st.kept).toBe(19);
    expect(st.successRatePct).toBe(94.2);
    expect(st.disputesThisMonth).toEqual({ total: 3, won: 2, open: 1 });
    expect(st.overdue).toMatchObject({ buyers: 5, amount: 61_000_000 });
  });

  it("gives the story's cases their numbers and real, tappable proposals", () => {
    const refs = heroCases(a, LEAFY);
    expect(Object.keys(refs).sort()).toEqual(["RD-1042", "RD-1043", "RD-1047", "RD-1048", "RD-1049", "RD-1050", "RD-1051", "RD-1052", "RD-1054", "RD-1055", "RD-1056", "RD-1057", "RD-1060", "RD-1071", "RD-1072", "RD-1073", "RD-1074"]);
    const labels = (ref: string) => openProposals({ db, repo: createRepository(db), clock: a.clock }, refs[ref]).map((p) => p.label);
    expect(labels("RD-1042")).toContain("Mark paid & ship");
    expect(labels("RD-1043")[0]).toBe("Refund the extra ₹499");
    expect(labels("RD-1051")[0]).toBe("Contest dispute");
    expect(labels("RD-1060")).toEqual(["Offer Karan 20% off next month", "Offer Karan a month's pause", "Cancel Karan's plan"]);
    const repo = createRepository(db);
    // Priya's and Rahul's cases are Sure, so their cards have buttons.
    expect(repo.cases.get(refs["RD-1042"])).toMatchObject({ state: "waiting_merchant", confidence: "sure", situation: "B" });
    expect(repo.cases.get(refs["RD-1043"])).toMatchObject({ state: "waiting_merchant", confidence: "sure" });
    expect(caseView(a, refs["RD-1042"]).yourCall.primary?.label).toBe("Mark paid & ship");
    expect(refs["RD-1060"]).toBe("case_demo_karan");
    expect(caseView(a, "case_demo_karan").id).toBe("case_demo_karan");
  });

  it("does not assign customer requests or unmatched payments to a bank", () => {
    const cases = createRepository(db).cases.list(eq(s.cases.merchant_id, LEAFY));
    const cancel = cases.find((c) => c.cause === "cancel_request")!;
    const unmatched = cases.find((c) => c.cause === "no_matching_payment")!;
    expect(caseView(a, cancel.id).side).toMatchObject({ label: "Customer request" });
    expect(caseView(a, unmatched.id).side).toMatchObject({ label: "Cause not established" });
    expect(caseView(a, "case_demo_emma").side).toMatchObject({ label: "Customer's bank", note: "The case includes a bank finding that records an issuer decline." });
  });

  it("marks U7 evidence as simulated and does not call it a customer wait", () => {
    const v = caseView(a, "case_u7_whose_side");
    expect(v.state.label).toBe("Simulated preview · Cause uncertain · review evidence");
    expect(inboxView(a, LEAFY).tabs[1]!.rows.find((row) => row.id === v.id)?.state.label).toBe(v.state.label);
    expect(alertsView(a, LEAFY).alerts.find((row) => row.caseId === v.id)?.state?.label).toBe(v.state.label);
    expect(v.findings[0]).toMatchObject({ source: "Simulated", text: expect.stringContaining("prior evening") });
    const cited = createRepository(db).caseEvents.get(v.findings[0]!.evidenceRef!)!;
    expect(cited.id).toBe(v.findings[0]!.id);
    expect(cited.payload.simulated).toBe(true);
    expect(v.side).toBeNull();
    expect(v.yourCall.unsure).toBe(true);
    expect(v.confidence.reason).toContain("Check the exact payment time, method, and Razorpay transaction");
    expect(v.findings.some((f) => /prior evening/.test(f.text) && /does not match/.test(f.text))).toBe(true);
  });

  it("keeps action authorization, actor, messages and support requests coherent for every seeded case", () => {
    const repo = createRepository(db);
    const all = repo.cases.list(eq(s.cases.merchant_id, LEAFY));
    expect(all.length).toBe(50);
    for (const kase of all) {
      const v = caseView(a, kase.id);
      expect(v.id).toBe(kase.id);
      const events = repo.caseEvents.listByCase(kase.id);
      const outbound = v.conversation.filter((message) => message.direction === "out");
      for (const message of [...repo.messages.list(eq(s.messages.case_id, kase.id))]) {
        const event = message.channel === "call"
          ? events.find((item) => item.type === "note" && item.payload.kind === "call_summary" && item.evidence_ref === message.id)
          : events.find((item) => item.type === (message.direction === "out" ? "message_out" : "message_in") && item.evidence_ref === message.id);
        expect(event, `${kase.id} (${kase.moment}): ${message.id} ${message.direction}/${message.channel} missing timeline event; events=${events.map((item) => `${item.type}:${item.evidence_ref}`).join(",")}`).toBeTruthy();
        expect(outbound.some((item) => item.id === message.id), `${kase.id}: message missing from conversation`).toBe(message.direction === "out");
      }
      for (const action of repo.actions.list(eq(s.actions.case_id, kase.id)).filter((item) => item.approved_by === "tap" && item.status === "done")) {
        const call = events.find((item) => item.type === "tool_call" && item.evidence_ref === action.id);
        const approval = events.find((item) => item.type === "approval" && item.payload.choice === "approve" && (item.payload.action_id === action.id || item.at <= (call?.at ?? -Infinity)));
        expect(call, `${kase.id}: action missing timeline event`).toBeTruthy();
        expect(approval, `${kase.id}: action lacks earlier merchant approval`).toBeTruthy();
        expect(approval!.at).toBeLessThanOrEqual(call!.at);
        expect(v.events.find((item) => item.id === approval!.id)?.who).toMatch(/You/);
        expect(v.events.find((item) => item.id === call!.id)?.who).toMatch(/You|rule/i);
      }
      if (kase.state === "waiting_customer") {
        expect(outbound.length, `${kase.id}: waiting for customer without an outbound message`).toBeGreaterThan(0);
      }
      expect(v.results.join(" ")).not.toContain("Action completed: the message");
    }
  });

  it("resolves the cited evidence behind every seeded finding", () => {
    const repo = createRepository(db);
    for (const kase of repo.cases.list(eq(s.cases.merchant_id, LEAFY))) {
      for (const finding of caseView(a, kase.id).findings) {
        if (finding.evidenceRef) expect(evidence(a, LEAFY, finding.evidenceRef), `${kase.id}: ${finding.text}`).not.toBeNull();
      }
    }
  });

  it("shows Oliver's internal request as support activity and waits on Razorpay, not the customer", () => {
    const v = caseView(a, "case_demo_oliver");
    expect(v.state.label).toBe("Simulated · Waiting on Razorpay");
    expect(v.conversation).toEqual([]);
    expect(v.internalActivity).toHaveLength(1);
    expect(v.internalActivity[0]).toMatchObject({ recipient: "support@razorpay.example.com", channel: "email", status: "Simulated request sent in the seeded demo; awaiting Razorpay in the story" });
    expect(v.results.join(" ")).toContain("Simulated Razorpay support request sent");
    const approvalAt = v.events.find((event) => event.what === "You approved")!.at;
    const requestAt = v.events.find((event) => event.what.includes("Simulated Razorpay support request sent"))!.at;
    expect(new Date(approvalAt).getTime()).toBeLessThanOrEqual(new Date(requestAt).getTime());
  });

  it("keeps Priya's WhatsApp status update distinct from the unapproved store action", () => {
    const kase = createRepository(db).cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0]!;
    const v = caseView(a, kase.id);
    expect(kase.state).toBe("waiting_merchant");
    expect(v.conversation.some((item) => item.channel === "WhatsApp voice note")).toBe(true);
    const autoUpdate = v.conversation.find((item) => item.direction === "out");
    expect(autoUpdate).toMatchObject({ channel: "WhatsApp", from: "Leafy Bakes" });
    expect(autoUpdate?.body).toContain("UTR ending 0021");
    expect(autoUpdate?.body).not.toContain("order confirmed");
    expect(v.results.join(" ")).toContain("recommended merchant action still needs your approval");
    expect(v.yourCall.primary?.label).toBe("Mark paid & ship");
  });

  it("opens Priya's case from payment and webhook signals before her first message", () => {
    const kase = createRepository(db).cases.get(heroCases(a, LEAFY)["RD-1042"]!)!;
    const events = createRepository(db).caseEvents.listByCase(kase.id);
    const signalAt = events.find((e) => e.type === "webhook" && e.payload.event === "payment.captured")!.at;
    const firstCustomerMessage = events.find((e) => e.type === "message_in")!.at;
    const v = caseView(a, kase.id);
    expect(signalAt).toBeLessThan(firstCustomerMessage);
    expect(v.findings.map((f) => f.text).join(" ")).toMatch(/webhook|plugin|pending/i);
    expect(v.side?.note).toContain("Razorpay's own plugin");
    expect(v.yourCall.primary?.label).toBe("Mark paid & ship");
  });

  it("contests the duplicate chargeback under the merchant's rule, with a Stop window of 1 h 40 min", () => {
    const refs = heroCases(a, LEAFY);
    const held = createRepository(db).actions.list(eq(s.actions.case_id, refs["RD-1047"])).find((x) => x.tool === "contest_dispute")!;
    expect(held.status).toBe("held");
    expect(held.run_after! - DEMO_NOW).toBe(100 * 60_000);
    expect(held.approved_by).toBe(`rule_cb_lane_contest_${LEAFY}`);
  });

  it("has two approved rules and one suggested rule", () => {
    const rules = createRepository(db).playbookRules.list(eq(s.playbookRules.merchant_id, LEAFY)).filter((r) => typeof r.rule_json.setting !== "string");
    expect(rules.filter((r) => r.status === "approved").length).toBe(2);
    expect(rules.filter((r) => r.status === "proposed" && r.source === "pattern").map((r) => r.text)).toContain("Refund duplicate charges under ₹500 automatically");
    expect(rules.find((r) => r.id === "rule_pattern_refund_dup_leafy")?.rule_json.max).toBe(49_999);
  });

  it("has two voice notes, one simulated call and a thread for every case", () => {
    const repo = createRepository(db);
    const msgs = repo.messages.list();
    // Priya's is a message; the merchant's is a note on Rahul's case (it only picks the card).
    expect(msgs.filter((m) => m.channel === "voice_note").length).toBe(1);
    const merchantNotes = db.$client.prepare("select count(*) as n from case_events where json_extract(payload, '$.kind') = 'merchant_voice_note'").get() as { n: number };
    expect(merchantNotes.n).toBe(1);
    expect(msgs.filter((m) => m.channel === "call").length).toBe(1);
    const leafy = repo.cases.list(eq(s.cases.merchant_id, LEAFY));
    const quiet = leafy.filter((c) => caseView(a, c.id).findings.length === 0 && c.moment !== "chargeback");
    expect(quiet).toEqual([]);
  });

  it("never falls back to the Unsure answer: every AI call was replayed", () => {
    const bad = createRepository(db).aiCalls.list().filter((c) => !c.valid);
    expect(bad.map((c) => `${c.job} ${c.input_hash}`)).toEqual([]);
  });

  it("shows no banned words or em dashes on what the merchant reads", () => {
    const repo = createRepository(db);
    for (const c of repo.cases.list(eq(s.cases.merchant_id, LEAFY))) {
      const v = caseView(a, c.id);
      const text = [v.name, v.yourCall.question, ...v.findings.map((f) => f.text), ...v.conversation.map((m) => m.body)].join(" ");
      expect(bannedWordsIn(text), c.id).toEqual([]);
      expect(hasEmDash(text), c.id).toBe(false);
    }
  });
});

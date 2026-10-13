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
import { caseView, inboxView } from "@/surfaces/views";
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

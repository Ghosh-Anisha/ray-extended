// case_events.at is when the event happened at the source. A submitted
// dispute response uses Razorpay's own submitted_at; a draft change has no
// source time, so it uses the clock.
import { describe, expect, it } from "vitest";
import { openMigratedDb } from "@/db/client";
import { createRepository } from "@/db/repository";
import { SEED_NOW, seed } from "@/db/seed";
import { fakeClock } from "../clock";
import { withDraftLog } from "./draft-log";
import { createMockRazorpay } from "./mock";
import type { RazorpayAdapter } from "./types";

const LEAFY = "m_leafy_bakes";
const MINUTE = 60_000;

function setup() {
  const db = openMigratedDb(":memory:");
  seed(db);
  const clock = fakeClock(SEED_NOW);
  const repo = createRepository(db);
  repo.cases.insert({
    id: "case_cb_meera", merchant_id: LEAFY, moment: "chargeback", state: "waiting_merchant", confidence: "sure",
    payment_id: "pay_LB1198MEERA", amount: 690_000, opened_at: SEED_NOW,
  });
  return { db, clock, repo, mock: createMockRazorpay(db, clock, LEAFY) };
}

describe("dispute draft events take their time from the source", () => {
  it("uses Razorpay's submitted_at for a submit, and the clock for a draft change", async () => {
    const { db, clock, repo, mock } = setup();
    // Razorpay recorded the submit 5 minutes before RAY got the response.
    const sourceTime = SEED_NOW + 10 * MINUTE;
    const rzp: RazorpayAdapter = {
      ...mock,
      async contestDispute(id, input) {
        const d = await mock.contestDispute(id, input);
        return d.evidence?.submitted_at ? { ...d, evidence: { ...d.evidence, submitted_at: sourceTime } } : d;
      },
    };
    const logged = withDraftLog(rzp, db, clock, LEAFY);

    clock.advance(1 * MINUTE);
    await logged.contestDispute("disp_LB_meera", {
      action: "draft", amount: 690_000, summary: "Delivered by courier", documents: { shipping_proof: ["doc_pod_1"] },
    });
    clock.advance(14 * MINUTE);
    await logged.contestDispute("disp_LB_meera", { action: "submit" });

    const events = repo.caseEvents.listByCase("case_cb_meera");
    expect(events.map((e) => [e.payload.kind, e.at])).toEqual([
      ["dispute_draft_created", SEED_NOW + 1 * MINUTE],
      ["dispute_draft_submitted", sourceTime],
    ]);
    expect(clock.now()).toBe(SEED_NOW + 15 * MINUTE);
    db.$client.close();
  });

  it("falls back to the clock when a submit has no submitted_at", async () => {
    const { db, clock, repo, mock } = setup();
    const rzp: RazorpayAdapter = {
      ...mock,
      async contestDispute(id, input) {
        const d = await mock.contestDispute(id, input);
        return d.evidence ? { ...d, evidence: { ...d.evidence, submitted_at: null } } : d;
      },
    };
    const logged = withDraftLog(rzp, db, clock, LEAFY);
    await logged.contestDispute("disp_LB_meera", {
      action: "submit", amount: 690_000, summary: "Delivered by courier", documents: { shipping_proof: ["doc_pod_1"] },
    });
    const [event] = repo.caseEvents.listByCase("case_cb_meera");
    expect(event).toMatchObject({ at: SEED_NOW, payload: { kind: "dispute_draft_submitted" } });
    db.$client.close();
  });

  it("keeps recorded order (seq) for two draft changes at the same time", async () => {
    const { db, clock, repo, mock } = setup();
    const logged = withDraftLog(mock, db, clock, LEAFY);
    await logged.contestDispute("disp_LB_meera", { action: "draft", summary: "Delivered by courier" });
    await logged.contestDispute("disp_LB_meera", { action: "draft", amount: 690_000 });
    const events = repo.caseEvents.listByCase("case_cb_meera");
    expect(events.map((e) => e.payload.kind)).toEqual(["dispute_draft_created", "dispute_draft_changed"]);
    expect(events[0].at).toBe(events[1].at);
    expect(events[0].seq!).toBeLessThan(events[1].seq!);
    db.$client.close();
  });
});

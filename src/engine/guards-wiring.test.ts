// How the engine and guardedCall fit together: tick() releases a held
// refund when its hold ends (in due order with timers), and the
// orchestrator copes with a guard that already moved the case.
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createMockRazorpay } from "@/adapters/razorpay";
import { seededAdapters } from "@/adapters/test-helpers";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { guardedCall, REFUND_HOLD_MS, setKillSwitch } from "@/guards";
import { createDummySpecialist } from "./dummy-specialist";
import { createEngine, type Engine } from "./engine";
import { createRegistry, type Specialist } from "./specialist";

const LEAFY = "m_leafy_bakes";
const PRIYA = "+919800000101";
const PAY = "pay_LB1234PRIYA";
const MIN = 60_000;

let a: ReturnType<typeof seededAdapters> | undefined;
let engine: Engine | undefined;
afterEach(() => {
  engine?.stop();
  a?.db.$client.close();
  a = engine = undefined;
});

// The dummy flow, but approving does a guarded refund of Priya's payment.
function refundingSpecialist(): Specialist {
  const dummy = createDummySpecialist();
  return {
    ...dummy,
    async proposeActions() {
      return [{ id: "prop_refund", label: "Refund ₹1,299", tool: "refund", args: { payment_id: PAY, amount: 129_900 }, covered: false }];
    },
    async onApproval(ctx, kase, approval) {
      const r = await guardedCall("refund", { payment_id: PAY, amount: 129_900 }, { adapters: ctx.adapters!, caseId: kase.id, approval });
      if (r.status === "blocked" || r.status === "failed") return { to: "waiting_merchant", reason: "A check stopped the refund" };
      return { to: "verifying", reason: "Refund on hold", timers: [{ kind: "verify_check", inMs: 30 * MIN }] };
    },
  };
}

async function toWaitingMerchant() {
  a = seededAdapters();
  engine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: createRegistry([refundingSpecialist()]) });
  const repo = createRepository(a.db);
  await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: PAY });
  const caseId = repo.cases.list(eq(s.cases.payment_id, PAY))[0].id;
  await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "I paid" });
  expect(repo.cases.get(caseId)?.state).toBe("waiting_merchant");
  const tap = { kind: "tap" as const, merchantId: LEAFY, caseId, at: a.clock.now(), sourceId: "tap_refund", payload: { choice: "approve", proposalId: "prop_refund" } };
  return { repo, caseId, tap };
}

describe("engine and guards", () => {
  it("tick() releases a held refund when its 10 minutes end, before a later timer", async () => {
    const { repo, caseId, tap } = await toWaitingMerchant();
    await engine!.handleEvent(tap);
    expect(repo.cases.get(caseId)?.state).toBe("verifying");
    const rzp = createMockRazorpay(a!.db, a!.clock, LEAFY);
    expect(await rzp.listRefunds(PAY)).toEqual([]);

    a!.clock.advance(5 * MIN);
    expect((await engine!.tick()).released).toEqual([]);
    a!.clock.advance(60 * MIN);
    const { released, fired } = await engine!.tick();
    expect(released).toMatchObject([{ caseId, status: "done" }]);
    expect(await rzp.listRefunds(PAY)).toHaveLength(1);
    // The refund was due at +10 min, before the 30-minute check timer.
    // Processing order is seq (a timer's event carries its due time as at).
    const bySeq = [...repo.caseEvents.listByCase(caseId)].sort((x, y) => x.seq! - y.seq!);
    const done = bySeq.findIndex((e) => e.payload.kind === "action_done");
    const firstTimerAfterTap = bySeq.findIndex((e) => e.type === "timer" && e.payload.timer_kind === "verify_check");
    expect(done).toBeLessThan(firstTimerAfterTap);
    expect(fired.map((f) => f.kind)).toContain("verify_check");
    expect(released[0].dueAt).toBe(repo.actions.list()[0].run_after);
    expect(REFUND_HOLD_MS).toBe(10 * MIN);
  });

  it("a guard that already moved the case to waiting_merchant doesn't make the orchestrator move it twice", async () => {
    const { repo, caseId, tap } = await toWaitingMerchant();
    setKillSwitch(a!.db, a!.clock, "global", true);
    await engine!.handleEvent(tap);
    expect(repo.cases.get(caseId)?.state).toBe("waiting_merchant");
    const moves = repo.caseEvents
      .listByCase(caseId)
      .filter((e) => e.payload.kind === "state_changed")
      .map((e) => `${e.payload.from}>${e.payload.to}`);
    expect(moves.slice(-2)).toEqual(["waiting_merchant>acting", "acting>waiting_merchant"]);
  });
});

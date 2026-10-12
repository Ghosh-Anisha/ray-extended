import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createMockRazorpay } from "@/adapters/razorpay";
import { seededAdapters } from "@/adapters/test-helpers";
import { createRepository } from "@/db/repository";
import { CASE_STATES, type CaseState } from "@/db/schema";
import * as s from "@/db/schema";
import { SEED_NOW } from "@/db/seed";
import { createDummySpecialist, DUMMY_CHECK_MS, DUMMY_PROMISED_MS, DUMMY_REPLY_MS } from "./dummy-specialist";
import { createEngine, type Engine } from "./engine";
import { fromWebhook } from "./events";
import { GROUPING_WINDOW_MS } from "./grouping";
import { HANDLED_BY_MERCHANT } from "./outcomes";
import { createRegistry, type Specialist } from "./specialist";
import { IllegalTransitionError, transition } from "./state-machine";

const LEAFY = "m_leafy_bakes";
const PRIYA = "+919800000101";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type World = { a: ReturnType<typeof seededAdapters>; engine: Engine; repo: ReturnType<typeof createRepository> };
let world: World | undefined;
afterEach(() => {
  world?.engine.stop();
  world?.a.db.$client.close();
  world = undefined;
});

function setup(specialists: Specialist[] = [createDummySpecialist()]): World {
  const a = seededAdapters();
  const engine: Engine = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: createRegistry(specialists) });
  const repo = createRepository(a.db);
  world = { a, engine, repo };
  return world;
}

const events = (repo: ReturnType<typeof createRepository>, caseId: string) => repo.caseEvents.listByCase(caseId);
const statePath = (repo: ReturnType<typeof createRepository>, caseId: string): CaseState[] => [
  "likely",
  ...events(repo, caseId)
    .filter((e) => e.payload.kind === "state_changed")
    .map((e) => e.payload.to as CaseState),
];
const tap = (caseId: string, choice: "approve" | "decline", at: number) => ({
  kind: "tap" as const,
  merchantId: LEAFY,
  caseId,
  at,
  sourceId: `tap_${caseId}_${choice}`,
  payload: { choice, proposalId: "prop_dummy_1" },
});

describe("engine: a dummy specialist moves cases through every state on the fake clock", () => {
  it("visits all nine states across two cases", async () => {
    const { a, engine, repo } = setup();

    // Case 1: Priya paid, order still pending (plugin drops the update).
    const d = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    expect(repo.cases.get(caseId)?.state).toBe("waiting_customer");
    expect(repo.alerts.list(eq(s.alerts.case_id, caseId))).toHaveLength(1);

    a.clock.advance(DUMMY_REPLY_MS);
    await engine.tick();
    expect(repo.cases.get(caseId)?.state).toBe("unconfirmed");

    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "I paid but my order says pending" });
    expect(repo.cases.get(caseId)?.state).toBe("likely");
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "UPI ref 628514730021" });
    expect(repo.cases.get(caseId)?.state).toBe("waiting_merchant");
    expect(events(repo, caseId).some((e) => e.payload.kind === "actions_proposed")).toBe(true);

    await engine.handleEvent(tap(caseId, "approve", a.clock.now()));
    expect(repo.cases.get(caseId)?.state).toBe("verifying");

    a.clock.advance(DUMMY_CHECK_MS);
    await engine.tick();
    const closed = repo.cases.get(caseId)!;
    expect(closed).toMatchObject({ state: "closed", outcome: "fixed", counts_as_saved: true, closed_at: a.clock.now() });
    expect(statePath(repo, caseId)).toEqual([
      "likely", "waiting_customer", "unconfirmed", "likely", "confirmed", "waiting_merchant", "acting", "verifying", "closed",
    ]);

    // Case 2: Rahul's payment, the store processed it after all.
    a.store.setFailure(LEAFY, "none");
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1235RAHUL1" });
    const case2 = repo.cases.list(eq(s.cases.payment_id, "pay_LB1235RAHUL1"))[0];
    expect(case2.state).toBe("fixed_itself");

    const visited = new Set([...statePath(repo, caseId), ...statePath(repo, case2.id)]);
    expect([...visited].sort()).toEqual([...CASE_STATES].sort());

    // Every row on both timelines cites evidence, and the webhook kept its delivery row.
    for (const id of [caseId, case2.id]) for (const e of events(repo, id)) expect(e.evidence_ref).toBeTruthy();
    expect(repo.webhookDeliveries.get(d.event.id)).toBeDefined();
    // Every state change has its state_changed row: path length matches the notes.
    expect(statePath(repo, caseId)).toHaveLength(9);
  });

  it("keeps the case open when the merchant says no, with the other options and Change", async () => {
    const { a, engine, repo } = setup();
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });
    expect(repo.cases.get(caseId)?.state).toBe("waiting_merchant");

    await engine.handleEvent(tap(caseId, "decline", a.clock.now()));
    expect(repo.cases.get(caseId)).toMatchObject({ state: "waiting_merchant", closed_at: null, outcome: null });
    const declined = events(repo, caseId).find((e) => e.payload.kind === "proposal_declined")!;
    expect(declined.payload).toMatchObject({
      proposal_id: "prop_dummy_1",
      alternatives: [{ id: "prop_dummy_2", label: "Refund the customer" }],
      change_prompt: "What should I do instead?",
      handle_myself_label: "I'll handle this myself",
    });
    expect(declined.evidence_ref).toBe(events(repo, caseId).find((e) => e.type === "approval")!.id);

    // The promised-time timer keeps running, so the customer still gets the holding message.
    a.clock.advance(DUMMY_PROMISED_MS);
    const { fired } = await engine.tick();
    expect(fired.map((f) => f.kind)).toContain("promised_time");
    const timeline = events(repo, caseId);
    const reached = timeline.findIndex((e) => e.payload.kind === "promised_time_reached");
    expect(reached).toBeGreaterThan(-1);
    expect(timeline[reached + 1].payload).toMatchObject({ kind: "promised_time_handled", reason: "Promised time reached; recorded" });
    expect(repo.cases.get(caseId)?.state).toBe("waiting_merchant");

    // The other option can still be approved.
    await engine.handleEvent({ ...tap(caseId, "approve", a.clock.now()), sourceId: "tap_alt", payload: { choice: "approve", proposalId: "prop_dummy_2" } });
    expect(repo.cases.get(caseId)?.state).toBe("verifying");
  });

  it("ignores a tap on a proposal that was already declined", async () => {
    const { a, engine, repo } = setup();
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });
    await engine.handleEvent(tap(caseId, "decline", a.clock.now()));
    await engine.handleEvent({ ...tap(caseId, "approve", a.clock.now()), sourceId: "tap_late" });
    expect(repo.cases.get(caseId)?.state).toBe("waiting_merchant");
    expect(events(repo, caseId).at(-1)?.payload).toMatchObject({ kind: "tap_ignored", proposal_id: "prop_dummy_1" });
  });

  it("closes only on 'I'll handle this myself': no more messages, not counted as saved", async () => {
    const { a, engine, repo } = setup();
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });
    await engine.handleEvent({ ...tap(caseId, "decline", a.clock.now()), sourceId: "tap_own", payload: { choice: "handle_myself" } });
    expect(repo.cases.get(caseId)).toMatchObject({ state: "closed", outcome: HANDLED_BY_MERCHANT, counts_as_saved: false });

    await expect(
      a.messaging.send({ merchantId: LEAFY, caseId, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", body: "Update on your order" }),
    ).rejects.toMatchObject({ code: "MERCHANT_HANDLING" });

    // Its timers were called off, so nothing fires later.
    const cancelled = events(repo, caseId).find((e) => e.payload.kind === "takeover_cancelled")!;
    expect((cancelled.payload.timers as { kind: string }[]).map((t) => t.kind).sort()).toEqual(["customer_reply", "promised_time"]);
    const before = events(repo, caseId).length;
    a.clock.advance(DUMMY_PROMISED_MS);
    expect((await engine.tick()).fired).toEqual([]);
    expect(events(repo, caseId)).toHaveLength(before);
    expect(repo.cases.get(caseId)?.state).toBe("closed");
  });

  it("acts without a tap only under an approved playbook rule", async () => {
    const rule = { merchant_id: LEAFY, moment: "paid_no_order" as const, rule_json: {}, text: "Mark paid orders under ₹2,000", source: "merchant" as const };
    for (const [status, expected] of [["approved", "verifying"], ["proposed", "waiting_merchant"]] as const) {
      const { a, engine, repo } = setup([createDummySpecialist({ ruleId: "rule_1" })]);
      repo.playbookRules.insert({ id: "rule_1", ...rule, status, approved_at: status === "approved" ? SEED_NOW : null });
      await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
      await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });
      const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
      expect(repo.cases.get(caseId)?.state).toBe(expected);
      if (status === "proposed") expect(events(repo, caseId).some((e) => e.payload.kind === "rule_not_approved")).toBe(true);
      engine.stop();
      a.db.$client.close();
      world = undefined;
    }
  });
});

describe("engine: the merchant takes a case over", () => {
  const takeOverTap = (caseId: string, at: number, sourceId = `tap_${caseId}_own`) => ({
    kind: "tap" as const, merchantId: LEAFY, caseId, at, sourceId, payload: { choice: "handle_myself" },
  });
  const seedCase = (repo: World["repo"], state: CaseState) =>
    repo.cases.insert({ id: `case_${state}`, merchant_id: LEAFY, moment: "paid_no_order", state, confidence: "likely", opened_at: SEED_NOW });

  it("works from every open state, and does nothing to a finished case", async () => {
    const { a, engine, repo } = setup();
    const open = CASE_STATES.filter((st) => st !== "closed" && st !== "fixed_itself");
    for (const st of open) {
      const kase = seedCase(repo, st);
      await engine.handleEvent(takeOverTap(kase.id, a.clock.now()));
      expect(repo.cases.get(kase.id)).toMatchObject({ state: "closed", outcome: HANDLED_BY_MERCHANT, counts_as_saved: false });
      const kinds = events(repo, kase.id).map((e) => e.payload.kind ?? e.type);
      expect(kinds.slice(-3)).toEqual(["approval", "takeover_cancelled", "state_changed"]);
    }
    for (const st of ["closed", "fixed_itself"] as const) {
      const kase = seedCase(repo, st);
      await engine.handleEvent(takeOverTap(kase.id, a.clock.now()));
      expect(repo.cases.get(kase.id)?.state).toBe(st);
      expect(events(repo, kase.id).at(-1)?.payload).toMatchObject({ kind: "tap_ignored" });
    }
  });

  it("during the refund hold: cancels the held refund and the hold timer, then closes", async () => {
    const holdMs = 10 * MIN;
    // A specialist whose approved action is a refund held for 10 minutes.
    const spec = createDummySpecialist();
    const refunder: Specialist = {
      ...spec,
      async onApproval(ctx, kase) {
        ctx.repo.actions.insert({
          id: "act_refund", case_id: kase.id, tool: "refund", args: { amount: 129_900 }, approved_by: "tap",
          idempotency_key: `refund_${kase.id}`, status: "held", run_after: ctx.clock.now() + holdMs,
        });
        return { to: "verifying", reason: "Refund held for 10 minutes", timers: [{ kind: "refund_hold", inMs: holdMs }] };
      },
    };
    const { a, engine, repo } = setup([refunder]);
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });
    await engine.handleEvent(tap(caseId, "approve", a.clock.now()));
    expect(repo.cases.get(caseId)?.state).toBe("verifying");
    expect(repo.actions.get("act_refund")?.status).toBe("held");

    a.clock.advance(4 * MIN); // still inside the hold
    await engine.handleEvent(takeOverTap(caseId, a.clock.now()));

    expect(repo.cases.get(caseId)).toMatchObject({ state: "closed", outcome: HANDLED_BY_MERCHANT, counts_as_saved: false });
    expect(repo.actions.get("act_refund")).toMatchObject({ status: "cancelled", result: { cancelled_because: HANDLED_BY_MERCHANT } });
    const cancelled = events(repo, caseId).find((e) => e.payload.kind === "takeover_cancelled")!;
    expect(cancelled.payload.actions).toEqual([{ id: "act_refund", tool: "refund", run_after: SEED_NOW + holdMs }]);
    expect((cancelled.payload.timers as { kind: string }[]).map((t) => t.kind)).toContain("refund_hold");
    expect(repo.timers.list(eq(s.timers.case_id, caseId)).filter((t) => t.fired_at === null).every((t) => t.cancelled_at !== null)).toBe(true);

    a.clock.advance(holdMs);
    expect((await engine.tick()).fired).toEqual([]);
  });

  it("waits for a running action to finish, then closes", async () => {
    let finish: () => void = () => {};
    const spec = createDummySpecialist();
    const slow: Specialist = {
      ...spec,
      onApproval: (ctx, kase, approval) =>
        new Promise((resolve) => {
          finish = () => resolve(spec.onApproval(ctx, kase, approval));
        }),
    };
    const { a, engine, repo } = setup([slow]);
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });

    const approving = engine.handleEvent(tap(caseId, "approve", a.clock.now()));
    await new Promise((r) => setTimeout(r, 0));
    expect(repo.cases.get(caseId)?.state).toBe("acting");
    const takingOver = engine.handleEvent(takeOverTap(caseId, a.clock.now()));
    await new Promise((r) => setTimeout(r, 0));
    expect(repo.cases.get(caseId)?.state).toBe("acting"); // still running the action

    finish();
    await approving;
    await takingOver;
    const kinds = events(repo, caseId).map((e) => e.payload.kind ?? e.type);
    expect(kinds.indexOf("approval_handled")).toBeLessThan(kinds.indexOf("takeover_cancelled"));
    expect(repo.cases.get(caseId)).toMatchObject({ state: "closed", outcome: HANDLED_BY_MERCHANT });
  });

  it("only a takeover may close a case from likely, confirmed, waiting_customer or acting", () => {
    const { a, repo } = setup([]);
    for (const st of ["likely", "confirmed", "waiting_customer", "acting"] as const) {
      const kase = seedCase(repo, st);
      expect(() => transition(a.db, a.clock, kase.id, "closed", { reason: "x", evidenceRef: "ev", patch: { outcome: "fixed" } })).toThrow(
        IllegalTransitionError,
      );
      expect(transition(a.db, a.clock, kase.id, "closed", { reason: "x", evidenceRef: "ev", patch: { outcome: HANDLED_BY_MERCHANT } }).state).toBe(
        "closed",
      );
    }
  });
});

describe("engine: promised time", () => {
  it("records promised_time_reached, calls onPromisedTime, and sets promised_by", async () => {
    const calls: string[] = [];
    const spec = createDummySpecialist();
    const watching: Specialist = {
      ...spec,
      async onPromisedTime(ctx, kase, e) {
        calls.push(`${kase.state}:${e.sourceId}`);
        return spec.onPromisedTime(ctx, kase, e);
      },
    };
    const { a, engine, repo } = setup([watching]);
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });
    const promisedBy = repo.cases.get(caseId)!.promised_by;
    expect(promisedBy).toBe(a.clock.now() + DUMMY_PROMISED_MS);

    a.clock.advance(DUMMY_PROMISED_MS);
    const { fired } = await engine.tick();
    const timer = fired.find((f) => f.kind === "promised_time")!;
    expect(calls).toEqual([`waiting_merchant:${timer.timerId}`]);
    const reached = events(repo, caseId).find((e) => e.payload.kind === "promised_time_reached")!;
    expect(reached.payload).toMatchObject({ promised_by: promisedBy, timer_id: timer.timerId });
    expect(reached.evidence_ref).toBe(events(repo, caseId).find((e) => e.type === "timer" && e.evidence_ref === timer.timerId)!.id);
  });
});

describe("engine: grouping", () => {
  it("joins messages from the same customer within 7 days; a different payment opens a second case", async () => {
    const { a, engine, repo } = setup();
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const case1 = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;

    a.clock.advance(1 * DAY);
    const m1 = await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "I paid but no order" });
    a.clock.advance(2 * DAY);
    const m2 = await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "Any update?" });
    expect(m1).toMatchObject({ caseId: case1, created: false });
    expect(m2).toMatchObject({ caseId: case1, created: false });
    expect(repo.messages.list(eq(s.messages.case_id, case1))).toHaveLength(2);

    // Same customer, a different payment: a second case.
    const other = createMockRazorpay(a.db, a.clock, LEAFY).simulatePayment({ amount: 49_900, status: "captured", contact: PRIYA });
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: other.id });
    const case2 = repo.cases.list(eq(s.cases.payment_id, other.id))[0];
    expect(case2.id).not.toBe(case1);
    expect(repo.cases.list(eq(s.cases.merchant_id, LEAFY))).toHaveLength(2);

    // More than 7 days after the last activity: a new case.
    a.clock.advance(GROUPING_WINDOW_MS + MIN);
    const late = await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "Hello again" });
    expect(late).toMatchObject({ created: true });
    expect([case1, case2.id]).not.toContain((late as { caseId: string }).caseId);
  });

  it("opens a new case for a new query, even within 7 days", async () => {
    const { a, engine } = setup();
    const r1 = await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "Where is my order?" });
    const m = await a.messaging.receive({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "Different question" });
    const r2 = await engine.handleEvent({
      kind: "message_in", merchantId: LEAFY, at: m.at, sourceId: m.id, keys: { phone: PRIYA }, newQuery: true, payload: { body: m.body },
    });
    expect(r2).toMatchObject({ created: true });
    expect((r2 as { caseId: string }).caseId).not.toBe((r1 as { caseId: string }).caseId);
  });
});

describe("engine: intake", () => {
  it("records a redelivered webhook once", async () => {
    const { a, engine, repo } = setup();
    const d = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const again = await engine.handleEvent(fromWebhook(d));
    expect(again.outcome).toBe("duplicate");
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    expect(events(repo, caseId).filter((e) => e.type === "webhook")).toHaveLength(1);
  });

  it("writes the event before anything is decided, with the source time as at", async () => {
    const { a, repo } = setup();
    a.clock.advance(5 * MIN);
    const d = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    const [firstEvent] = events(repo, caseId);
    expect(firstEvent).toMatchObject({ type: "webhook", evidence_ref: d.event.id, at: d.event.created_at, seq: 1 });
  });

  it("gives a RAY-off merchant the free alert and nothing more", async () => {
    const { a, repo } = setup();
    const p = createMockRazorpay(a.db, a.clock, "m_crumb_co").simulatePayment({ amount: 89_900, status: "captured", contact: "+919811111111" });
    await a.webhooks.emit({ merchantId: "m_crumb_co", event: "payment.captured", paymentId: p.id });
    const [kase] = repo.cases.list(eq(s.cases.merchant_id, "m_crumb_co"));
    expect(kase.state).toBe("likely");
    expect(repo.alerts.list(eq(s.alerts.case_id, kase.id))).toHaveLength(1);
    expect(events(repo, kase.id).map((e) => e.payload.kind ?? e.type)).toEqual(["webhook", "alert_sent"]);
  });

  it("leaves an event no detector claims unmatched, but keeps its delivery row", async () => {
    const { a, repo } = setup([]);
    const d = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    expect(repo.cases.list()).toHaveLength(0);
    expect(repo.webhookDeliveries.get(d.event.id)).toBeDefined();
  });

  it("marks unmatched webhooks and messages with why, and matched ones with their case", async () => {
    const { a, engine, repo } = setup([]);
    const d = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    expect(repo.webhookDeliveries.get(d.event.id)).toMatchObject({ handled_case_id: null, unmatched_reason: "no_flow" });
    const r = await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });
    expect(r.outcome).toBe("unmatched");
    expect(repo.messages.list(eq(s.messages.unmatched_reason, "no_flow"))).toHaveLength(1);
    engine.stop();

    const withFlow = createEngine({ db: a.db, clock: a.clock, adapters: a, registry: createRegistry([createDummySpecialist()]) });
    const d2 = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1235RAHUL1" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1235RAHUL1"))[0].id;
    expect(repo.webhookDeliveries.get(d2.event.id)).toMatchObject({ handled_case_id: caseId, unmatched_reason: null });
    const m = await withFlow.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: "+919800000102", body: "hi" });
    expect(m).toMatchObject({ outcome: "handled", caseId });
    expect(repo.messages.list(eq(s.messages.handled_case_id, caseId))).toMatchObject([{ case_id: caseId, unmatched_reason: null }]);
    withFlow.stop();
  });
});

describe("engine: timers", () => {
  it("fires due timers once, earliest first, with the due time as at", async () => {
    const { a, engine, repo } = setup([]);
    repo.cases.insert({ id: "case_t", merchant_id: LEAFY, moment: "paid_no_order", state: "likely", confidence: "likely", opened_at: SEED_NOW });
    for (const [id, inMs] of [["tmr_30m", 30 * MIN], ["tmr_15m", 15 * MIN], ["tmr_72h", 72 * 60 * MIN]] as const) {
      repo.timers.insert({ id, case_id: "case_t", kind: id, due_at: SEED_NOW + inMs });
    }
    expect((await engine.tick()).fired).toEqual([]);
    a.clock.advance(2 * 60 * MIN);
    expect((await engine.tick()).fired.map((f) => f.timerId)).toEqual(["tmr_15m", "tmr_30m"]);
    expect((await engine.tick()).fired).toEqual([]);
    a.clock.advance(72 * 60 * MIN);
    expect((await engine.tick()).fired.map((f) => f.timerId)).toEqual(["tmr_72h"]);
    const timerEvents = events(repo, "case_t").filter((e) => e.type === "timer");
    expect(timerEvents.map((e) => [e.evidence_ref, e.at])).toEqual([
      ["tmr_15m", SEED_NOW + 15 * MIN],
      ["tmr_30m", SEED_NOW + 30 * MIN],
      ["tmr_72h", SEED_NOW + 72 * 60 * MIN],
    ]);
  });
});

describe("state machine", () => {
  function caseIn(state: CaseState, confidence: "sure" | "likely" | "unsure" = "likely") {
    const { a, repo } = setup([]);
    repo.cases.insert({ id: "case_sm", merchant_id: LEAFY, moment: "paid_no_order", state, confidence, opened_at: SEED_NOW });
    return { a, repo };
  }

  it("throws on an illegal move and changes nothing", () => {
    const { a, repo } = caseIn("likely");
    expect(() => transition(a.db, a.clock, "case_sm", "closed", { reason: "x", evidenceRef: "ev" })).toThrow(IllegalTransitionError);
    expect(() => transition(a.db, a.clock, "case_sm", "acting", { reason: "x", evidenceRef: "ev" })).toThrow(IllegalTransitionError);
    expect(repo.cases.get("case_sm")?.state).toBe("likely");
    expect(events(repo, "case_sm")).toEqual([]);
  });

  it("never leaves a final state", () => {
    for (const state of ["closed", "fixed_itself"] as const) {
      const { a } = caseIn(state);
      for (const to of CASE_STATES) {
        expect(() => transition(a.db, a.clock, "case_sm", to, { reason: "x", evidenceRef: "ev" })).toThrow(IllegalTransitionError);
      }
      a.db.$client.close();
      world = undefined;
    }
  });

  it("never acts on Unsure confidence", () => {
    const { a } = caseIn("confirmed", "unsure");
    expect(() => transition(a.db, a.clock, "case_sm", "acting", { reason: "rule", evidenceRef: "ev" })).toThrow(/Unsure/);
  });

  it("rejects a state change that has no case_events row", () => {
    const { a, repo } = caseIn("likely");
    expect(() => repo.cases.update("case_sm", { state: "confirmed" })).toThrow(/state machine/);
    // A state_changed note for a different move does not count either.
    transition(a.db, a.clock, "case_sm", "waiting_customer", { reason: "ask", evidenceRef: "ev" });
    expect(() => repo.cases.update("case_sm", { state: "confirmed" })).toThrow(/state machine/);
    // Other fields can still be updated directly.
    expect(repo.cases.update("case_sm", { cause: "plugin dropped the update" })?.cause).toBe("plugin dropped the update");
    expect(repo.cases.get("case_sm")?.state).toBe("waiting_customer");
  });

  it("is the only code that writes a case's state", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f.name) && !/\.test\.tsx?$/.test(f.name) && !p.endsWith(path.join("engine", "state-machine.ts"))) {
          const src = fs.readFileSync(p, "utf8");
          if (/cases\.update\([^;]*\bstate\s*:/s.test(src) || /update\(\s*(s\.)?cases\s*\)/.test(src)) offenders.push(p);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});

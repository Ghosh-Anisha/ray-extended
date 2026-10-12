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
import { createDummySpecialist, DUMMY_CHECK_MS, DUMMY_REPLY_MS } from "./dummy-specialist";
import { createEngine, type Engine } from "./engine";
import { fromWebhook } from "./events";
import { GROUPING_WINDOW_MS } from "./grouping";
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

  it("closes the case when the merchant declines", async () => {
    const { a, engine, repo } = setup();
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    const caseId = repo.cases.list(eq(s.cases.payment_id, "pay_LB1234PRIYA"))[0].id;
    await engine.receiveMessage({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "hello" });
    await engine.handleEvent(tap(caseId, "decline", a.clock.now()));
    expect(repo.cases.get(caseId)).toMatchObject({ state: "closed", outcome: "declined_by_merchant", counts_as_saved: false });
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

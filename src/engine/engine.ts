// handleEvent is the one entry point for webhooks, store events, inbound
// messages, merchant taps and timers. Order of work for every event:
// 1. find the open case (grouping) or let a detector open one,
// 2. write the event to case_events,
// 3. new case: send the free alert; RAY off stops here,
// 4. run the orchestrator.
// Events are handled one at a time. A redelivered event (same source id) is
// recorded once.
import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import type { Clock } from "@/adapters/clock";
import { newId } from "@/adapters/ids";
import type { ReceiveInput } from "@/adapters/messaging";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { CASE_EVENT_TYPE, engineEvent, fromMessage, fromWebhook, type EngineEventInput } from "./events";
import { findCase } from "./grouping";
import { orchestrate } from "./orchestrator";
import type { EngineContext, Registry } from "./specialist";
import type { Case } from "./state-machine";

export type HandleResult =
  | { outcome: "unmatched" }
  | { outcome: "duplicate"; caseId: string }
  | { outcome: "alert_only" | "handled"; caseId: string; created: boolean; case: Case };

export type Engine = {
  handleEvent(event: EngineEventInput): Promise<HandleResult>;
  // Records a customer message, then hands it to handleEvent.
  receiveMessage(input: ReceiveInput): Promise<HandleResult>;
  // Fires every due timer, earliest first, through handleEvent.
  tick(): Promise<{ fired: { timerId: string; caseId: string; kind: string; dueAt: number }[] }>;
  stop(): void;
};

export function createEngine(opts: { db: Db; clock: Clock; registry: Registry; adapters?: Adapters }): Engine {
  const { db, clock, registry, adapters } = opts;
  const repo = createRepository(db);
  const ctx: EngineContext = { db, repo, clock, adapters };

  // One event at a time. Work started from inside the engine (a specialist
  // that triggers a webhook) is queued, not awaited, to avoid a deadlock.
  let chain: Promise<unknown> = Promise.resolve();
  const inside = new AsyncLocalStorage<true>();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(() => inside.run(true, fn));
    chain = run.catch(() => undefined);
    return run;
  };

  async function handle(raw: EngineEventInput): Promise<HandleResult> {
    const e = engineEvent.parse(raw);
    const type = CASE_EVENT_TYPE[e.kind];
    const seen = db
      .select({ caseId: s.caseEvents.case_id })
      .from(s.caseEvents)
      .where(and(eq(s.caseEvents.evidence_ref, e.sourceId), eq(s.caseEvents.type, type)))
      .get();
    if (seen) return { outcome: "duplicate", caseId: seen.caseId };

    let kase = findCase(db, e);
    let alertText: string | null = null;
    if (!kase) {
      let detection = null;
      for (const spec of registry.all()) {
        detection = await spec.detect(ctx, e);
        if (detection) break;
      }
      if (!detection) return { outcome: "unmatched" };
      kase = repo.cases.insert({
        id: newId("case"),
        merchant_id: e.merchantId,
        moment: detection.moment,
        situation: detection.situation ?? null,
        state: "likely",
        confidence: detection.confidence,
        side: detection.side ?? null,
        razorpay_plugin: detection.razorpayPlugin ?? false,
        covered: detection.covered ?? false,
        amount: detection.amount ?? null,
        payment_id: detection.paymentId ?? e.keys.paymentId ?? null,
        store_order_id: detection.storeOrderId ?? null,
        cause: detection.cause ?? null,
        opened_at: e.at,
      });
      alertText = detection.alert;
    } else if (!kase.payment_id && e.keys.paymentId) {
      kase = repo.cases.update(kase.id, { payment_id: e.keys.paymentId })!;
    }

    // The event goes on the timeline before anything is decided.
    const row = repo.caseEvents.insert({
      id: newId("cev"),
      case_id: kase.id,
      at: e.at,
      type,
      payload: { source: e.kind, keys: e.keys, ...e.payload },
      evidence_ref: e.sourceId,
    });
    if (e.kind === "message_in") repo.messages.update(e.sourceId, { case_id: kase.id });

    const merchant = repo.merchants.get(kase.merchant_id)!;
    const created = alertText !== null;
    if (alertText !== null) {
      const alert = repo.alerts.insert({
        id: newId("alert"),
        merchant_id: merchant.id,
        case_id: kase.id,
        kind: "case_opened",
        text: alertText,
        channel: "in_app",
        sent_at: clock.now(),
      });
      repo.caseEvents.insert({
        id: newId("cev"),
        case_id: kase.id,
        at: clock.now(),
        type: "note",
        payload: { kind: "alert_sent", alert_id: alert.id, ray_on: merchant.ray_on },
        evidence_ref: row.id,
      });
    }
    if (!merchant.ray_on) return { outcome: "alert_only", caseId: kase.id, created, case: repo.cases.get(kase.id)! };

    const after = await orchestrate({ ...ctx, registry }, kase.id, e, row.id);
    return { outcome: "handled", caseId: kase.id, created, case: after };
  }

  async function tickOnce() {
    const fired: { timerId: string; caseId: string; kind: string; dueAt: number }[] = [];
    // Timers set while handling a timer can be due already; keep going.
    for (;;) {
      const t = db
        .select()
        .from(s.timers)
        .where(and(isNull(s.timers.fired_at), lte(s.timers.due_at, clock.now())))
        .orderBy(asc(s.timers.due_at), sql`rowid`)
        .get();
      if (!t) return { fired };
      repo.timers.update(t.id, { fired_at: clock.now() });
      const kase = repo.cases.get(t.case_id)!;
      fired.push({ timerId: t.id, caseId: t.case_id, kind: t.kind, dueAt: t.due_at });
      await handle({
        kind: "timer",
        merchantId: kase.merchant_id,
        caseId: kase.id,
        at: t.due_at, // when it fell due
        sourceId: t.id,
        payload: { timer_kind: t.kind, due_at: t.due_at },
      });
    }
  }

  const unsubscribe = adapters?.webhooks.subscribe(async (d) => {
    const work = engine.handleEvent(fromWebhook(d));
    if (!inside.getStore()) await work;
  });

  const engine: Engine = {
    handleEvent: (event) => serial(() => handle(event)),
    async receiveMessage(input) {
      if (!adapters) throw new Error("This engine has no messaging adapter");
      const m = await adapters.messaging.receive(input);
      return engine.handleEvent(fromMessage(m, input.merchantId));
    },
    tick: () => serial(tickOnce),
    stop: () => unsubscribe?.(),
  };
  return engine;
}

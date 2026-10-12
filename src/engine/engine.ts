// handleEvent is the one entry point for webhooks, store events, inbound
// messages, merchant taps and timers. Order of work for every event:
// 1. find the open case (grouping) or let a detector open one,
// 2. write the event to case_events,
// 3. new case: send the free alert; RAY off stops here,
// 4. run the orchestrator.
// Events are handled one at a time. A redelivered event (same source id) is
// recorded once.
import { AsyncLocalStorage } from "node:async_hooks";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import type { Clock, FakeClock } from "@/adapters/clock";
import { newId } from "@/adapters/ids";
import type { ReceiveInput } from "@/adapters/messaging";
import type { AudioInput } from "@/adapters/voice";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import { nextDueAction, releaseHeldAction } from "@/guards";
import * as s from "@/db/schema";
import { CASE_EVENT_TYPE, engineEvent, fromMessage, fromWebhook, type EngineEvent, type EngineEventInput } from "./events";
import { findCase } from "./grouping";
import { orchestrate } from "./orchestrator";
import type { EngineContext, Registry } from "./specialist";
import { isFinal, type Case } from "./state-machine";

export type HandleResult =
  | { outcome: "unmatched" }
  | { outcome: "duplicate"; caseId: string }
  | { outcome: "alert_only" | "handled"; caseId: string; created: boolean; case: Case };

export type TickResult = {
  fired: { timerId: string; caseId: string; kind: string; dueAt: number }[];
  released: { actionId: string; caseId: string; status: string; dueAt: number }[];
};

export type Engine = {
  handleEvent(event: EngineEventInput): Promise<HandleResult>;
  // Records a customer message, then hands it to handleEvent.
  receiveMessage(input: ReceiveInput): Promise<HandleResult>;
  // A WhatsApp voice note: transcribed (ElevenLabs, or a recorded sample),
  // recorded with its audio and transcript, then handled like any message.
  receiveVoiceNote(input: VoiceNoteInput): Promise<HandleResult & { messageId: string; transcript: string }>;
  // Fires every due timer, earliest first, through handleEvent.
  // Also releases held actions whose hold has ended, in the same due order.
  tick(): Promise<TickResult>;
  // Fake clock only: moves forward ms, stopping at each due timer or held
  // action on the way so it runs with the clock set to its own due time.
  advanceBy(ms: number): Promise<TickResult & { now: number }>;
  stop(): void;
};

export type VoiceNoteInput = { merchantId: string; from: string; to?: string; audio?: AudioInput; sampleId?: string };

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

  // Webhook deliveries and inbound messages record which case took them.
  function markSource(e: EngineEvent, mark: { handled_case_id: string | null; unmatched_reason: "no_flow" | null }) {
    if (e.kind === "webhook") repo.webhookDeliveries.update(e.sourceId, mark);
    if (e.kind === "message_in") {
      repo.messages.update(e.sourceId, { ...mark, ...(mark.handled_case_id ? { case_id: mark.handled_case_id } : {}) });
    }
  }

  async function claimed(e: EngineEvent): Promise<Case | null> {
    for (const spec of registry.all()) {
      const id = spec.claim ? await spec.claim(ctx, e) : null;
      if (!id) continue;
      const kase = repo.cases.get(id);
      // Only an open case of the claiming flow, for the same merchant.
      if (kase && kase.merchant_id === e.merchantId && kase.moment === spec.moment && !isFinal(kase.state)) return kase;
    }
    return null;
  }

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
    // A flow may claim an event for one of its own open cases (Specialist.claim).
    if (!kase && !e.newQuery) kase = await claimed(e);
    let alertText: string | null = null;
    if (!kase) {
      let detection = null;
      for (const spec of registry.all()) {
        detection = await spec.detect(ctx, e);
        if (detection) break;
      }
      if (!detection) {
        markSource(e, { handled_case_id: null, unmatched_reason: "no_flow" });
        return { outcome: "unmatched" };
      }
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
    markSource(e, { handled_case_id: kase.id, unmatched_reason: null });

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
    const released: { actionId: string; caseId: string; status: string; dueAt: number }[] = [];
    // Timers set while handling a timer can be due already; keep going.
    // Held actions whose hold has ended (the refund hold) run in the same
    // due order, an action first when both fall due at once.
    for (;;) {
      const t = db
        .select()
        .from(s.timers)
        .where(and(isNull(s.timers.fired_at), isNull(s.timers.cancelled_at), lte(s.timers.due_at, clock.now())))
        .orderBy(asc(s.timers.due_at), sql`rowid`)
        .get();
      const held = adapters ? nextDueAction(adapters) : undefined;
      if (held && (!t || held.run_after! <= t.due_at)) {
        const r = await releaseHeldAction(adapters!, held.id);
        released.push({ actionId: held.id, caseId: held.case_id, status: r.status, dueAt: held.run_after! });
        continue;
      }
      if (!t) return { fired, released };
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

  // The earliest thing still to come: an unfired timer or a held action.
  function nextDueAt(): number | null {
    const t = db
      .select({ at: s.timers.due_at })
      .from(s.timers)
      .where(and(isNull(s.timers.fired_at), isNull(s.timers.cancelled_at)))
      .orderBy(asc(s.timers.due_at))
      .get();
    const h = db
      .select({ at: s.actions.run_after })
      .from(s.actions)
      .where(and(eq(s.actions.status, "held"), isNotNull(s.actions.run_after)))
      .orderBy(asc(s.actions.run_after))
      .get();
    const ats = [t?.at, h?.at].filter((x): x is number => typeof x === "number");
    return ats.length ? Math.min(...ats) : null;
  }

  async function advanceBy(ms: number) {
    const fake = clock as Partial<FakeClock>;
    if (!fake.set) throw new Error("Only the fake clock can be moved forward");
    if (!Number.isFinite(ms) || ms < 0) throw new Error("The clock only moves forward");
    const target = clock.now() + ms;
    const out: TickResult = { fired: [], released: [] };
    for (;;) {
      const due = nextDueAt();
      if (due === null || due > target) break;
      if (due > clock.now()) fake.set(due);
      const r = await tickOnce();
      out.fired.push(...r.fired);
      out.released.push(...r.released);
    }
    fake.set(target);
    return { ...out, now: clock.now() };
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
    async receiveVoiceNote(input) {
      if (!adapters) throw new Error("This engine has no voice adapter");
      const t = await adapters.voice.transcribe({ audio: input.audio, sampleId: input.sampleId });
      const m = await adapters.messaging.receive({
        merchantId: input.merchantId,
        channel: "whatsapp",
        from: input.from,
        to: input.to,
        body: t.transcript,
        voice: { audioRef: t.audioRef, durationS: t.durationS },
      });
      const r = await engine.handleEvent(fromMessage(m, input.merchantId));
      return { ...r, messageId: m.id, transcript: t.transcript };
    },
    tick: () => serial(tickOnce),
    advanceBy: (ms) => serial(() => advanceBy(ms)),
    stop: () => unsubscribe?.(),
  };
  return engine;
}

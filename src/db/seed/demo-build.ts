// Builds a finished or in-progress case through the repositories and the state
// machine, for the parts of the demo world no live event produces (a month of
// closed cases, cases RAY is already handling). The case row starts as
// "likely", exactly as the engine opens one; every state change after that
// goes through transition(), which writes the state_changed note. Messages
// land in the messages table too, so the case page, the customer inbox and
// the buyer inbox all show the same thread.
import type { Clock } from "@/adapters/clock";
import type { ProposedAction } from "@/engine/specialist";
import { transition } from "@/engine/state-machine";
import type { Db } from "../client";
import { createRepository } from "../repository";
import type { CaseState, Moment } from "../schema";
import * as s from "../schema";
import type { FindingSource } from "@/surfaces/words";

export type StubClock = Clock & { t: number };
export const stubClock = (t = 0): StubClock => ({ t, now() { return this.t; } });

export type Step =
  | { at: number; kind: "webhook"; event: string; id: string; processed?: boolean }
  | { at: number; kind: "in"; channel: "whatsapp" | "email"; body: string; from: string; to: string }
  | { at: number; kind: "out"; channel: "whatsapp" | "email"; body: string; from: string; to: string; senderMode: "merchant_inbox" | "verified_domain" | "via_razorpay"; template?: string }
  | { at: number; kind: "finding"; text: string; ok?: boolean; source: FindingSource; ref?: string }
  | { at: number; kind: "move"; to: CaseState; reason: string; outcome?: string; saved?: boolean; closed?: boolean }
  | { at: number; kind: "note"; payload: Record<string, unknown>; ref?: string }
  | { at: number; kind: "proposals"; actions: ProposedAction[] }
  | { at: number; kind: "timer"; timer: string; dueAt: number }
  | { at: number; kind: "action"; tool: string; args: Record<string, unknown>; status: "done" | "held"; approvedBy: string; result?: Record<string, unknown> };

export type CaseSpec = {
  id: string;
  merchantId: string;
  moment: Moment;
  situation?: (typeof s.SITUATIONS)[number];
  confidence: (typeof s.CONFIDENCES)[number];
  side?: (typeof s.SIDES)[number];
  plugin?: boolean;
  covered?: boolean;
  amount: number | null; // paise, in INR
  paymentId?: string;
  storeOrderId?: string;
  cause?: string;
  promisedBy?: number;
  openedAt: number;
  // The customer's or buyer's addresses, so events carry the keys the case page matches on.
  keys: { email?: string; phone?: string; paymentId?: string };
  ref?: string; // "RD-1042"
  alert: string;
  simulated?: boolean;
  steps: Step[];
};

export function createBuilder(db: Db) {
  const repo = createRepository(db);
  const clock = stubClock();
  let n = 0;
  const id = (prefix: string, caseId: string) => `${prefix}_${caseId.replace(/^case_/, "")}_${++n}`;

  function build(c: CaseSpec): string {
    clock.t = c.openedAt;
    repo.cases.insert({
      id: c.id,
      merchant_id: c.merchantId,
      moment: c.moment,
      situation: c.situation ?? null,
      state: "likely",
      confidence: c.confidence,
      side: c.side ?? null,
      razorpay_plugin: c.plugin ?? false,
      covered: c.covered ?? false,
      amount: c.amount,
      payment_id: c.paymentId ?? null,
      store_order_id: c.storeOrderId ?? null,
      cause: c.cause ?? null,
      promised_by: c.promisedBy ?? null,
      opened_at: c.openedAt,
    });
    if (c.ref) repo.caseEvents.insert({ id: id("cev", c.id), case_id: c.id, at: c.openedAt, type: "note", payload: { kind: "case_ref", ref: c.ref }, evidence_ref: c.id });
    const alert = repo.alerts.insert({ id: id("alert", c.id), merchant_id: c.merchantId, case_id: c.id, kind: "case_opened", text: c.alert, channel: "in_app", sent_at: c.openedAt });
    repo.caseEvents.insert({ id: id("cev", c.id), case_id: c.id, at: c.openedAt, type: "note", payload: { kind: "alert_sent", alert_id: alert.id, ray_on: true }, evidence_ref: c.id });

    let last = c.id; // the evidence a state change cites
    for (const step of [...c.steps].sort((x, y) => x.at - y.at)) {
      clock.t = step.at;
      switch (step.kind) {
        case "webhook": {
          const e = repo.caseEvents.insert({
            id: id("cev", c.id),
            case_id: c.id,
            at: step.at,
            type: "webhook",
            payload: { source: "webhook", keys: c.keys, event: step.event, delivery: { http_status: 200, processed: step.processed ?? true } },
            evidence_ref: step.id,
          });
          last = e.id;
          break;
        }
        case "in":
        case "out": {
          const inbound = step.kind === "in";
          const m = repo.messages.insert({
            id: id("msg", c.id),
            case_id: c.id,
            channel: step.channel,
            direction: step.kind,
            from: step.from,
            to: step.to,
            sender_mode: inbound ? null : step.senderMode,
            body: step.body,
            template_id: inbound ? null : (step.template ?? null),
            within_24h: step.channel === "whatsapp" ? true : null,
            at: step.at,
            handled_case_id: inbound ? c.id : null,
          });
          const e = repo.caseEvents.insert({
            id: id("cev", c.id),
            case_id: c.id,
            at: step.at,
            type: inbound ? "message_in" : "message_out",
            payload: { source: inbound ? "message_in" : "message_out", keys: c.keys, channel: step.channel, from: step.from, to: step.to, body: step.body },
            evidence_ref: m.id,
          });
          last = e.id;
          break;
        }
        case "finding": {
          const findingId = id("cev", c.id);
          repo.caseEvents.insert({
            id: findingId,
            case_id: c.id,
            at: step.at,
            type: "finding",
            payload: { text: step.text, ok: step.ok ?? true, source: c.simulated ? "Simulated" : step.source, simulated: c.simulated ?? false, cited_by: last },
            evidence_ref: step.ref ?? (c.simulated ? findingId : last),
          });
          break;
        }
        case "note": {
          const e = repo.caseEvents.insert({ id: id("cev", c.id), case_id: c.id, at: step.at, type: "note", payload: step.payload, evidence_ref: step.ref ?? last });
          last = e.id;
          break;
        }
        case "proposals":
          repo.caseEvents.insert({ id: id("cev", c.id), case_id: c.id, at: step.at, type: "note", payload: { kind: "actions_proposed", actions: step.actions }, evidence_ref: last });
          break;
        case "timer": {
          const t = repo.timers.insert({ id: id("tmr", c.id), case_id: c.id, kind: step.timer, due_at: step.dueAt });
          repo.caseEvents.insert({ id: id("cev", c.id), case_id: c.id, at: step.at, type: "note", payload: { kind: "timer_set", timer_kind: step.timer, due_at: step.dueAt }, evidence_ref: t.id });
          break;
        }
        case "action": {
          const actionId = id("act", c.id);
          // Seeded actions marked "tap" represent the merchant tap described
          // by the story. Keep that authorization in the same append-only
          // history, before the action it permits.
          if (step.approvedBy === "tap") {
            repo.caseEvents.insert({
              id: id("cev", c.id), case_id: c.id, at: step.at, type: "approval",
              payload: { choice: "approve", actor: "merchant", action_id: actionId }, evidence_ref: actionId,
            });
          }
          const a = repo.actions.insert({
            id: actionId,
            case_id: c.id,
            tool: step.tool,
            args: step.args,
            guard_result: { ok: true },
            approved_by: step.approvedBy,
            idempotency_key: `demo:${c.id}:${n}`,
            status: step.status,
            result: step.result ?? { ok: true },
            run_after: null,
          });
          repo.caseEvents.insert({
            id: id("cev", c.id),
            case_id: c.id,
            at: step.at,
            type: "tool_call",
            payload: { kind: step.status === "done" ? "action_done" : "action_held", tool: step.tool, approved_by: step.approvedBy, action_id: a.id },
            evidence_ref: a.id,
          });
          last = a.id;
          break;
        }
        case "move": {
          const closing = step.to === "closed" || step.to === "fixed_itself" || step.to === "unconfirmed" || step.closed;
          transition(db, clock, c.id, step.to, {
            reason: step.reason,
            evidenceRef: last,
            patch: closing ? { closed_at: step.at, outcome: step.outcome ?? "verified", counts_as_saved: step.saved ?? false } : undefined,
          });
          break;
        }
      }
    }
    return c.id;
  }

  return { build, repo, clock };
}
export type Builder = ReturnType<typeof createBuilder>;

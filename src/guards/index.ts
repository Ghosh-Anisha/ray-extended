// guardedCall is the only way an act tool runs (rule 1). For every call:
// 1. the idempotency key: the same call again returns the first result,
// 2. every guard that applies to the tool runs and all failures are kept,
// 3. a failed guard writes its reasons to case_events, marks the action
//    failed and moves the case to waiting_merchant through the state
//    machine. It never retries on its own.
// 4. otherwise the tool runs, or (refunds) is held for 10 minutes with Undo.
// Every outcome is an actions row plus a tool_call event on the case.
import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import { normalise } from "@/ai/key";
import { createRepository, type Repository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Approval } from "@/engine/specialist";
import { checkTransition, isFinal, transition, type Case } from "@/engine/state-machine";
import { ACT_TOOL_SPECS, type ActToolSpec, type GuardName } from "@/tools/act";
import { isActTool, type ActToolName } from "@/tools/names";
import { CHECKS, guardContext, guardsFor, liveRefundActions, type Failure } from "./checks";

export { runsAlone } from "./alone";
export { BANK_COMPLAINT, caseKnows, MATCH_WINDOW_MS, type Failure } from "./checks";
export { caseFacts } from "./facts";
export { formatDate, formatMoney, formatTime } from "./format";
export { GLOBAL_SETTINGS_ID, killSwitchOn, setKillSwitch, type KillSwitchScope } from "./kill-switch";
export { AUTO_CUSTOMER_MESSAGES, REFUND_HOLD_MS } from "@/tools/act";

// The merchant-facing name of an act tool ("the refund"), for screens.
// Read only: the tools themselves stay behind guardedCall.
export const actLabel = (tool: string): string => ACT_TOOL_SPECS[tool as ActToolName]?.label ?? "the action";

export type Action = typeof s.actions.$inferSelect;

// payload.kind of the tool_call events guardedCall writes.
export const ACTION_EVENT_KINDS = ["action_done", "action_held", "action_blocked", "action_failed", "action_undone", "action_cancelled"] as const;
export type ActionEventKind = (typeof ACTION_EVENT_KINDS)[number];

export type GuardedCallContext = {
  adapters: Adapters;
  caseId: string;
  approval?: Approval;
  idempotencyKey?: string;
  // Optional: hold the action until this time (the Stop window on an
  // automatic dispute lane). It is held exactly like the refund hold: Stop
  // (Undo) cancels it, and every guard runs again when it is released.
  holdUntil?: number;
};

export type GuardedResult =
  | { status: "done"; action: Action; result: Record<string, unknown> }
  | { status: "held"; action: Action; runAfter: number }
  | { status: "blocked"; action: Action; failures: Failure[] }
  | { status: "failed"; action: Action; error: string }
  | { status: "duplicate"; action: Action };

// Same case, tool, args and approval: same key. A new tap is a new key.
// Short enough (35 chars) to be a Razorpay refund receipt.
export function idempotencyKey(caseId: string, tool: string, args: unknown, approval?: Approval): string {
  const ap = approval ? (approval.by === "tap" ? { tap: approval.evidenceRef } : { rule: approval.ruleId, on: approval.evidenceRef }) : null;
  const hash = createHash("sha256").update(JSON.stringify(normalise({ caseId, tool, args, ap }))).digest("hex");
  return `ik_${hash.slice(0, 32)}`;
}

const actionByKey = (repo: Repository, key: string) => repo.actions.list(eq(s.actions.idempotency_key, key))[0];

function event(a: Adapters, kase: Case, kind: ActionEventKind, action: Action, extra: Record<string, unknown> = {}) {
  return createRepository(a.db).caseEvents.insert({
    id: newId("cev"),
    case_id: kase.id,
    at: a.clock.now(), // RAY's own act; there is no source time
    type: "tool_call",
    payload: { kind, tool: action.tool, action_id: action.id, approved_by: action.approved_by, ...extra },
    evidence_ref: action.id,
  });
}

// Hands the case back to the merchant, if the state machine allows it from
// where the case is now.
function toMerchant(a: Adapters, caseId: string, reason: string, evidenceRef: string) {
  const kase = createRepository(a.db).cases.get(caseId)!;
  if (kase.state === "waiting_merchant") return true;
  try {
    checkTransition(kase, "waiting_merchant");
  } catch {
    return false;
  }
  transition(a.db, a.clock, caseId, "waiting_merchant", { reason, evidenceRef });
  return true;
}

async function runChecks(
  a: Adapters,
  kase: Case,
  tool: ActToolName,
  spec: ActToolSpec,
  args: Record<string, unknown>,
  approval: Approval | undefined,
  key: string,
) {
  const repo = createRepository(a.db);
  const g = guardContext({
    a,
    repo,
    kase,
    merchant: repo.merchants.get(kase.merchant_id)!,
    tool,
    spec,
    args,
    approval,
    idempotencyKey: key,
    now: a.clock.now(),
  });
  const ran = guardsFor(spec);
  const failures: Failure[] = [];
  for (const name of ran) failures.push(...(await CHECKS[name](g)));
  const failed = new Set(failures.map((f) => f.guard));
  return { failures, passed: ran.filter((n) => !failed.has(n)) as GuardName[] };
}

function approvedBy(approval: Approval | undefined): string | null {
  if (!approval) return null;
  return approval.by === "tap" ? "tap" : approval.ruleId;
}

async function block(a: Adapters, kase: Case, spec: ActToolSpec, action: Action, failures: Failure[]): Promise<GuardedResult> {
  const repo = createRepository(a.db);
  const updated = repo.actions.update(action.id, { status: "failed" })!;
  const reason = `A check stopped ${spec.label}: ${failures[0].reason}`;
  const ev = event(a, kase, "action_blocked", updated, { failures, reason });
  const moved = toMerchant(a, kase.id, reason, ev.id);
  if (!moved) repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: a.clock.now(), type: "note", payload: { kind: "case_not_moved", state: repo.cases.get(kase.id)!.state, why: "blocked action" }, evidence_ref: ev.id });
  return { status: "blocked", action: updated, failures };
}

async function execute(a: Adapters, kase: Case, spec: ActToolSpec, action: Action, args: Record<string, unknown>): Promise<GuardedResult> {
  const repo = createRepository(a.db);
  try {
    const result = await spec.run({ a, kase, idempotencyKey: action.idempotency_key, actionId: action.id }, args);
    const done = repo.actions.update(action.id, { status: "done", result })!;
    event(a, kase, "action_done", done, { result });
    return { status: "done", action: done, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const failed = repo.actions.update(action.id, { status: "failed", result: { error } })!;
    const reason = `${spec.label[0].toUpperCase()}${spec.label.slice(1)} didn't go through: ${error}`;
    const ev = event(a, kase, "action_failed", failed, { error, reason });
    toMerchant(a, kase.id, reason, ev.id);
    return { status: "failed", action: failed, error };
  }
}

export async function guardedCall(tool: string, rawArgs: unknown, ctx: GuardedCallContext): Promise<GuardedResult> {
  if (!isActTool(tool)) throw new Error(`${tool} is not an act tool`);
  const a = ctx.adapters;
  const repo = createRepository(a.db);
  const spec = ACT_TOOL_SPECS[tool];
  const args = spec.args.parse(rawArgs) as Record<string, unknown>;
  const kase = repo.cases.get(ctx.caseId);
  if (!kase) throw new Error(`Case ${ctx.caseId} not found`);
  const key = ctx.idempotencyKey ?? idempotencyKey(kase.id, tool, args, ctx.approval);

  const seen = actionByKey(repo, key);
  if (seen && seen.status !== "failed") return { status: "duplicate", action: seen };

  const { failures, passed } = await runChecks(a, kase, tool, spec, args, ctx.approval, key);
  const approved = approvedBy(ctx.approval);

  // Written in one transaction, rechecking what an overlapping call could
  // have changed since the checks began.
  const written = a.db.transaction(() => {
    const again = actionByKey(repo, key);
    if (again && again.status !== "failed") return { duplicate: again };
    if (!failures.length && tool === "refund" && liveRefundActions(repo, args.payment_id as string, key).length) {
      failures.push({ guard: "one_refund", code: "refund_pending", reason: "A refund for this payment is already on hold or done." });
    }
    const now = a.clock.now();
    const asked = ctx.holdUntil !== undefined && ctx.holdUntil > now ? ctx.holdUntil : null;
    const hold = failures.length ? null : (asked ?? (spec.holdMs ? now + spec.holdMs : null));
    const fields = {
      case_id: kase.id,
      tool,
      args,
      guard_result: { passed: passed.filter((n) => !failures.some((f) => f.guard === n)), failed: failures, approval: ctx.approval ?? null },
      approved_by: approved,
      idempotency_key: key,
      // A held action with no run_after is one being run right now.
      status: "held" as const,
      result: null,
      run_after: hold,
    };
    return { action: again ? repo.actions.update(again.id, fields)! : repo.actions.insert({ id: newId("act"), ...fields }) };
  });
  if (written.duplicate) return { status: "duplicate", action: written.duplicate };
  const action = written.action!;
  if (failures.length) return block(a, kase, spec, action, failures);
  if (action.run_after !== null) {
    event(a, kase, "action_held", action, { run_after: action.run_after, args });
    return { status: "held", action, runAfter: action.run_after };
  }
  return execute(a, kase, spec, action, args);
}

// ---- The refund hold.

// The earliest held action whose hold has ended, if any.
export function nextDueAction(a: Adapters): Action | undefined {
  return a.db
    .select()
    .from(s.actions)
    .where(and(eq(s.actions.status, "held"), isNotNull(s.actions.run_after), lte(s.actions.run_after, a.clock.now())))
    .orderBy(asc(s.actions.run_after), asc(s.actions.idempotency_key))
    .get();
}

// The hold has ended: run every guard again (the kill switch may be on, a
// refund may have happened, the customer may have paid again), then act.
export async function releaseHeldAction(a: Adapters, actionId: string): Promise<GuardedResult> {
  const repo = createRepository(a.db);
  const action = repo.actions.get(actionId);
  if (!action || action.status !== "held" || action.run_after === null) throw new Error(`Action ${actionId} is not on hold`);
  if (action.run_after > a.clock.now()) throw new Error(`Action ${actionId} is still on hold`);
  const tool = action.tool as ActToolName;
  const spec = ACT_TOOL_SPECS[tool];
  const kase = repo.cases.get(action.case_id)!;
  if (isFinal(kase.state)) {
    const cancelled = repo.actions.update(action.id, { status: "cancelled", result: { cancelled_because: "case_finished" } })!;
    event(a, kase, "action_cancelled", cancelled, { reason: "The case finished before the hold ended" });
    return { status: "failed", action: cancelled, error: "case finished" };
  }
  const approval = (action.guard_result?.approval as Approval | null) ?? undefined;
  const { failures, passed } = await runChecks(a, kase, tool, spec, action.args, approval, action.idempotency_key);
  const checked = repo.actions.update(action.id, { guard_result: { ...action.guard_result, released: { passed, failed: failures } } })!;
  if (failures.length) return block(a, kase, spec, checked, failures);
  return execute(a, kase, spec, checked, action.args);
}

export async function releaseDueActions(a: Adapters): Promise<GuardedResult[]> {
  const out: GuardedResult[] = [];
  for (let next = nextDueAction(a); next; next = nextDueAction(a)) out.push(await releaseHeldAction(a, next.id));
  return out;
}

export type UndoResult = { ok: true; action: Action } | { ok: false; reason: string };

// Undo: a held refund inside its 10 minutes is cancelled before it reaches
// Razorpay; a done action with an undo (post_match) is reversed. The case
// goes back to the merchant.
export async function undoAction(a: Adapters, actionId: string): Promise<UndoResult> {
  const repo = createRepository(a.db);
  const action = repo.actions.get(actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);
  const spec = ACT_TOOL_SPECS[action.tool as ActToolName];
  const kase = repo.cases.get(action.case_id)!;
  let undone: Action;
  if (action.status === "held" && action.run_after !== null) {
    if (a.clock.now() >= action.run_after) return { ok: false, reason: "The 10-minute hold has ended, so this can't be undone." };
    undone = repo.actions.update(action.id, { status: "undone", result: { undone_at: a.clock.now() } })!;
  } else if (action.status === "done" && spec.undo) {
    const reversed = await spec.undo({ a, kase, idempotencyKey: action.idempotency_key, actionId }, action.args, action.result ?? {});
    undone = repo.actions.update(action.id, { status: "undone", result: { ...action.result, undo: reversed } })!;
  } else {
    return { ok: false, reason: "This can't be undone." };
  }
  const reason = `You undid ${spec.label}`;
  const ev = event(a, kase, "action_undone", undone, { reason });
  toMerchant(a, kase.id, reason, ev.id);
  return { ok: true, action: undone };
}

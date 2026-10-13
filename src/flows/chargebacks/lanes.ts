// The three lanes: contest without asking, accept without asking, ask.
// The automatic lanes are the one exception to "money needs a tap", so
// every bound is checked here before RAY uses one, and the shared guards
// check the rule again when the held action is released:
//   1. opt-in: the merchant switched the lane on (an approved playbook rule),
//   2. first stage only (phase chargeback),
//   3. no new money moves: the amount was already deducted at onset,
//   4. an FYI with a Stop window: 2 hours, shorter when the deadline is closer,
//   5. auto-off: one wrong call switches the lane off,
//   6. two merchant overrides on a type move that type back to Ask,
// plus: Sure only, within the merchant's approval limit, and the decision
// the expected-value rule makes is the lane's own.
import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { HANDLED_BY_MERCHANT } from "@/engine/outcomes";
import { formatMoney } from "@/guards";
import { stopWindowEnd, TYPE_LABEL, type DisputeType } from "./rules";

export const LANES = ["contest", "accept"] as const;
export type Lane = (typeof LANES)[number];
export const LANE_TOOL: Record<Lane, "contest_dispute" | "accept_dispute"> = { contest: "contest_dispute", accept: "accept_dispute" };
export const LANE_NAME: Record<Lane, string> = { contest: "Contest without asking", accept: "Accept without asking" };

// max_amount: the merchant's threshold ("without asking up to ₹X"), in
// paise. The threshold is part of the rule: an action under it is approved
// by the lane rule's id, like any rule.
export type LaneRuleJson = { lane: Lane; tool: string; types: DisputeType[]; at_deadline?: boolean; max_amount?: number };
type Rule = typeof s.playbookRules.$inferSelect;

export const OVERRIDES_BACK_TO_ASK = 2;
export const LANE_USED_NOTE = "cb_lane_used";

export const laneRuleId = (merchantId: string, lane: Lane) => `rule_cb_lane_${lane}_${merchantId}`;
const isLaneRule = (r: Rule): r is Rule & { rule_json: LaneRuleJson } => r.moment === "chargeback" && LANES.includes(r.rule_json.lane as Lane);

// The lanes RAY proposes the first time a merchant gets a chargeback. Both
// start proposed (off); nothing runs until the merchant taps Approve rule.
export const PROPOSED_LANES: Record<Lane, { types: DisputeType[]; at_deadline?: boolean; text: string }> = {
  contest: {
    types: ["duplicate", "already_refunded", "not_received", "cancelled"],
    at_deadline: true,
    text: "Contest without asking: duplicates and already refunded, and not received or cancelled when the proof is Sure. First stage only, with a 2-hour Stop window. If you haven't answered a few hours before the deadline, a strong reply is sent.",
  },
  accept: {
    types: ["fraud", "not_received"],
    text: "Accept without asking: fraud that Vulcan flagged, and not received when the order never shipped. First stage only, with a 2-hour Stop window.",
  },
};

export function proposeLanes(db: Db, merchantId: string) {
  const repo = createRepository(db);
  for (const lane of LANES) {
    const id = laneRuleId(merchantId, lane);
    if (repo.playbookRules.get(id)) continue;
    const p = PROPOSED_LANES[lane];
    const rule_json: LaneRuleJson = { lane, tool: LANE_TOOL[lane], types: p.types, ...(p.at_deadline ? { at_deadline: true } : {}) };
    repo.playbookRules.insert({ id, merchant_id: merchantId, moment: "chargeback", rule_json, text: p.text, source: "pattern", status: "proposed", approved_at: null });
  }
}

export function laneRules(db: Db, merchantId: string, lane: Lane, status: Rule["status"] = "approved") {
  return createRepository(db)
    .playbookRules.list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.moment, "chargeback"), eq(s.playbookRules.status, status)))
    .filter(isLaneRule)
    .filter((r) => r.rule_json.lane === lane);
}

// Overrides on a type: the merchant stopped a lane's held action (Stop), or
// took the case over while it was held. Read from the database each time.
export function overridesOn(db: Db, merchantId: string, type: DisputeType): number {
  const used = db
    .select({ payload: s.caseEvents.payload })
    .from(s.caseEvents)
    .innerJoin(s.cases, eq(s.cases.id, s.caseEvents.case_id))
    .where(and(eq(s.cases.merchant_id, merchantId), sql`json_extract(${s.caseEvents.payload}, '$.kind') = ${LANE_USED_NOTE}`))
    .all()
    .map((r) => r.payload as { action_id: string; type: DisputeType })
    .filter((p) => p.type === type);
  if (!used.length) return 0;
  const actions = db
    .select()
    .from(s.actions)
    .where(inArray(s.actions.id, used.map((u) => u.action_id)))
    .all();
  return actions.filter((x) => x.status === "undone" || (x.status === "cancelled" && x.result?.cancelled_because === HANDLED_BY_MERCHANT)).length;
}

export type LaneInput = {
  merchantId: string;
  lane: Lane;
  type: DisputeType;
  phase: string;
  deducted: boolean;
  confidence: "sure" | "likely" | "unsure";
  amount: number; // INR paise
  approvalLimit: number;
  now: number;
  deadline: number;
  // The lane's "at the deadline" path: a strong reply when the merchant
  // hasn't answered a few hours before the deadline.
  atDeadline?: boolean;
};

export type LaneCheck = { ok: true; rule: Rule & { rule_json: LaneRuleJson }; holdUntil: number } | { ok: false; why: string[] };

// Every bound, in order. The reasons are merchant-facing.
export function checkLane(db: Db, x: LaneInput): LaneCheck {
  const why: string[] = [];
  const name = LANE_NAME[x.lane];
  const label = TYPE_LABEL[x.type];
  const rules = laneRules(db, x.merchantId, x.lane);
  const rule = x.atDeadline ? rules.find((r) => r.rule_json.at_deadline) : rules.find((r) => r.rule_json.types.includes(x.type));
  if (!rules.length) why.push(`${name} is off.`);
  else if (!rule) why.push(x.atDeadline ? `${name} doesn't send a reply at the deadline.` : `${name} doesn't cover ${label} disputes.`);
  if (x.phase !== "chargeback") why.push("Only the first stage can go without asking.");
  if (!x.deducted) why.push("The amount hasn't been deducted yet, so this would move new money.");
  if (x.confidence !== "sure") why.push("RAY isn't Sure.");
  const max = rule?.rule_json.max_amount;
  if (typeof max === "number" && x.amount > max) why.push(`${formatMoney(x.amount)} is above the ${formatMoney(max)} you set for ${name}.`);
  if (x.amount > x.approvalLimit) why.push(`${formatMoney(x.amount)} is above your approval limit of ${formatMoney(x.approvalLimit)}.`);
  if (overridesOn(db, x.merchantId, x.type) >= OVERRIDES_BACK_TO_ASK) why.push(`You stopped RAY on ${label} disputes twice, so RAY asks you about them now.`);
  const holdUntil = stopWindowEnd(x.now, x.deadline);
  if (holdUntil === null) why.push("There isn't time left for a Stop window.");
  if (why.length || !rule || holdUntil === null) return { ok: false, why };
  return { ok: true, rule, holdUntil };
}

// The merchant sets (or clears) a lane's amount threshold in the playbook.
export function setLaneThreshold(db: Db, merchantId: string, lane: Lane, maxAmount: number | null) {
  const repo = createRepository(db);
  const id = laneRuleId(merchantId, lane);
  const rule = repo.playbookRules.get(id);
  if (!rule) throw new Error(`${LANE_NAME[lane]} isn't set up for ${merchantId}`);
  const { max_amount: _old, ...rest } = rule.rule_json as LaneRuleJson;
  void _old;
  return repo.playbookRules.update(id, { rule_json: maxAmount === null ? rest : { ...rest, max_amount: maxAmount } });
}

// How often an automatic lane got it right, from the outcomes on the
// timeline (written when each dispute closes).
export function laneAccuracy(db: Db, ruleId: string): { calls: number; wrong: number } {
  const rows = db
    .select({ payload: s.caseEvents.payload })
    .from(s.caseEvents)
    .where(and(sql`json_extract(${s.caseEvents.payload}, '$.kind') = 'cb_outcome'`, sql`json_extract(${s.caseEvents.payload}, '$.lane_rule_id') = ${ruleId}`))
    .all();
  return { calls: rows.length, wrong: rows.filter((r) => r.payload.lane_wrong === true).length };
}

// One wrong call (an automatically contested dispute that was lost)
// switches the lane off. The merchant can switch it back on in the playbook.
export function switchLaneOffAfterWrongCall(db: Db, now: number, ruleId: string, caseId: string, evidenceRef: string) {
  const repo = createRepository(db);
  const rule = repo.playbookRules.get(ruleId);
  if (!rule || rule.status !== "approved") return false;
  const lane = rule.rule_json.lane as Lane;
  repo.playbookRules.update(ruleId, { status: "off", approved_at: null });
  repo.caseEvents.insert({ id: newId("cev"), case_id: caseId, at: now, type: "note", payload: { kind: "cb_lane_off", rule_id: ruleId, lane, why: "wrong_call" }, evidence_ref: evidenceRef });
  repo.alerts.insert({
    id: newId("alert"),
    merchant_id: rule.merchant_id,
    case_id: caseId,
    kind: "lane_off",
    text: `I switched off "${LANE_NAME[lane]}" because a dispute I handled that way was lost. I'll ask you from now on. You can switch it back on in your playbook.`,
    channel: "whatsapp",
    sent_at: now,
  });
  return true;
}

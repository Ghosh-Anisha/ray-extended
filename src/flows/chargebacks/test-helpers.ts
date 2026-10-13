// A seeded world on the fake clock with the paid-no-order and chargeback
// flows registered (same order as the app), AI in replay mode.
import { and, eq } from "drizzle-orm";
import { seededAdapters } from "@/adapters/test-helpers";
import { createAi, type Ai } from "@/ai";
import { DEFAULT_FIXTURES_DIR } from "@/ai/fixtures";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { createEngine } from "@/engine/engine";
import { openProposals } from "@/engine/orchestrator";
import { createRegistry, type EngineContext } from "@/engine/specialist";
import { createPaidNoOrderSpecialist } from "@/flows/paid-no-order";
import { setRuleStatus, tap as tapSurface, undo } from "@/surfaces/actions";
import { createChargebacksSpecialist } from ".";
import { laneRuleId, proposeLanes, type Lane } from "./lanes";

export const LEAFY = "m_leafy_bakes";
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const DISPUTES = { meera: "disp_LB_meera", sanjay: "disp_LB_sanjay", deepa: "disp_LB_deepa" } as const;
export const PAYMENTS = { meera: "pay_LB1198MEERA", sanjay: "pay_LB1210SANJAY", deepa: "pay_LB1221DEEPA" } as const;

export function cbWorld(opts: { ai?: (ctx: EngineContext) => Ai } = {}) {
  const a = seededAdapters();
  const repo = createRepository(a.db);
  const ai = opts.ai ?? ((ctx: EngineContext) => createAi({ repo: ctx.repo, mode: "replay", fixturesDir: DEFAULT_FIXTURES_DIR }));
  const engine = createEngine({
    db: a.db,
    clock: a.clock,
    adapters: a,
    registry: createRegistry([createPaidNoOrderSpecialist({ ai }), createChargebacksSpecialist({ ai })]),
  });
  const ctx: EngineContext = { db: a.db, repo, clock: a.clock, adapters: a };

  const caseFor = (paymentId: string) => repo.cases.list(and(eq(s.cases.payment_id, paymentId), eq(s.cases.moment, "chargeback"))).at(-1)!;
  const events = (caseId: string) => repo.caseEvents.listByCase(caseId);
  const notes = (caseId: string, kind: string) => events(caseId).filter((e) => e.payload.kind === kind);
  const proposals = (caseId: string) => openProposals(ctx, caseId);
  const tapLabel = async (caseId: string, label: string | RegExp) => {
    const p = proposals(caseId).find((x) => (typeof label === "string" ? x.label === label : label.test(x.label)));
    if (!p) throw new Error(`No proposal ${String(label)} on ${caseId}: ${proposals(caseId).map((x) => x.label).join(", ")}`);
    return tapSurface(engine, a, { caseId, choice: "approve", proposalId: p.id });
  };
  const dispute = (id: string) => repo.disputes.get(id)!;
  const alerts = (caseId: string, kind?: string) => repo.alerts.list(eq(s.alerts.case_id, caseId)).filter((x) => !kind || x.kind === kind);
  const actions = (caseId: string, tool?: string) => repo.actions.list(eq(s.actions.case_id, caseId)).filter((x) => !tool || x.tool === tool);
  const sent = (caseId: string) => repo.messages.list(eq(s.messages.case_id, caseId)).filter((m) => m.direction === "out");

  const open = (disputeId: string) => a.webhooks.emit({ merchantId: LEAFY, event: "payment.dispute.created", disputeId });
  // The merchant switches a lane on (Approve rule in the playbook).
  const switchOn = (lane: Lane) => {
    proposeLanes(a.db, LEAFY);
    return setRuleStatus(a, { merchantId: LEAFY, ruleId: laneRuleId(LEAFY, lane), status: "approved" });
  };
  const stop = (actionId: string) => undo(a, LEAFY, actionId);

  return { a, repo, engine, ctx, caseFor, events, notes, proposals, tapLabel, dispute, alerts, actions, sent, open, switchOn, stop, close: () => { engine.stop(); a.db.$client.close(); } };
}
export type CbWorld = ReturnType<typeof cbWorld>;

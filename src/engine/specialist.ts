// The Specialist interface every flow implements, and the registry the
// detector and orchestrator use. Hooks return results; only the
// orchestrator writes them and only the state machine changes state.
import type { Adapters } from "@/adapters";
import type { Clock } from "@/adapters/clock";
import type { Db } from "@/db/client";
import type { Repository } from "@/db/repository";
import type { CaseState, Moment } from "@/db/schema";
import * as s from "@/db/schema";
import type { EngineEvent, TapPayload } from "./events";
import type { Case } from "./state-machine";

export type EngineContext = { db: Db; repo: Repository; clock: Clock; adapters?: Adapters };

export type Detection = {
  moment: Moment;
  confidence: (typeof s.CONFIDENCES)[number];
  // The free alert every merchant gets, RAY on or not.
  alert: string;
  situation?: (typeof s.SITUATIONS)[number];
  side?: (typeof s.SIDES)[number];
  cause?: string;
  amount?: number;
  paymentId?: string;
  storeOrderId?: string;
  razorpayPlugin?: boolean;
  covered?: boolean;
};

// Every finding cites evidence: a case_events id or a source record id.
export type Finding = { text: string; evidenceRef: string };
export type TimerRequest = { kind: string; inMs: number };

// A hook that hands the case back to the merchant may offer new proposals;
// the orchestrator writes them as the case's open proposals.
type Step<To extends CaseState> = { to: To; reason: string; timers?: TimerRequest[]; proposals?: ProposedAction[] };

export type InvestigateResult = Step<CaseState> & {
  findings: Finding[];
  confidence?: Detection["confidence"];
  side?: Detection["side"];
  cause?: string;
  situation?: Detection["situation"];
};

export type Decision = Step<"waiting_merchant" | "waiting_customer" | "acting" | "fixed_itself"> & {
  summary: string;
  // An approved playbook rule lets RAY act without a tap.
  ruleId?: string;
  // Step 9: every proposed action runs alone in code (a recovery link, a
  // question), so no tap or rule is needed. The orchestrator checks each
  // proposal with runsAlone and calls onRunAlone instead of onApproval.
  alone?: boolean;
};

export type ProposedAction = {
  id: string;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  covered: boolean;
  // Done after the main action with the same tap, each matched on tool and
  // args by the approval guard. The confirmation message the card shows as
  // its draft is one of these.
  followUps?: { tool: string; args: Record<string, unknown> }[];
};

export type Approval = { by: "tap"; tap: TapPayload; evidenceRef: string } | { by: "rule"; ruleId: string; evidenceRef: string };

// A flow sets a timer of this kind for the time it promised the customer.
// When it fires, the orchestrator records promised_time_reached and calls
// onPromisedTime. Setting it also sets cases.promised_by.
export const PROMISED_TIME_TIMER = "promised_time";

// A flow sets a timer of this kind for a follow-up call (Step 5b); the case
// shows the Pre-call notice with Cancel call until it fires. Flows wire it
// in from Step 7.
export const CALL_TIMER = "call";

export type PromisedTimeResult = { reason: string; to?: CaseState; timers?: TimerRequest[]; proposals?: ProposedAction[] };
export type ChangeResult = { reason: string; proposals?: ProposedAction[] };

export type ApprovalResult = Step<"verifying" | "waiting_merchant">;
export type VerifyResult = Step<"closed" | "verifying" | "acting" | "waiting_merchant" | "unconfirmed"> & { outcome?: string };

export interface Specialist {
  id: string;
  moment: Moment;
  detect(ctx: EngineContext, event: EngineEvent): Detection | null | Promise<Detection | null>;
  // Called for a new case and whenever new evidence arrives on an open one.
  investigate(ctx: EngineContext, kase: Case, event: EngineEvent): Promise<InvestigateResult>;
  decide(ctx: EngineContext, kase: Case): Promise<Decision>;
  proposeActions(ctx: EngineContext, kase: Case, decision: Decision): Promise<ProposedAction[]>;
  // Runs while the case is acting, after a tap or under an approved rule.
  onApproval(ctx: EngineContext, kase: Case, approval: Approval): Promise<ApprovalResult>;
  // Runs while the case is acting after a decision marked alone, where every
  // proposed action runs alone (Step 9). Flows without it never act alone.
  onRunAlone?(ctx: EngineContext, kase: Case): Promise<ApprovalResult>;
  verify(ctx: EngineContext, kase: Case, event: EngineEvent | null): Promise<VerifyResult>;
  // Required: what to do when the time promised to the customer has passed.
  onPromisedTime(ctx: EngineContext, kase: Case, event: EngineEvent): Promise<PromisedTimeResult>;
  countsAsSaved(ctx: EngineContext, kase: Case): boolean | Promise<boolean>;
  // The merchant tapped Change with free text: redraft and offer the same
  // card again. Flows without it only record the text.
  onChange?(ctx: EngineContext, kase: Case, text: string, event: EngineEvent): Promise<ChangeResult>;
  // Optional: when grouping finds no case for an event, a flow may claim it
  // for one of its own open cases (the id), before any detector runs. Used
  // when an event belongs to a case but carries a different payment, such as
  // a buyer's later payment by another method. Flows without it are unchanged.
  claim?(ctx: EngineContext, event: EngineEvent): string | null | Promise<string | null>;
}

export type Registry = {
  register(spec: Specialist): void;
  forMoment(moment: Moment): Specialist | undefined;
  all(): Specialist[];
};

export function createRegistry(specialists: Specialist[] = []): Registry {
  const byId = new Map<string, Specialist>();
  const reg: Registry = {
    register(spec) {
      if (byId.has(spec.id)) throw new Error(`Specialist ${spec.id} is already registered`);
      if ([...byId.values()].some((x) => x.moment === spec.moment)) {
        throw new Error(`A specialist already handles ${spec.moment}`);
      }
      byId.set(spec.id, spec);
    },
    forMoment: (moment) => [...byId.values()].find((x) => x.moment === moment),
    all: () => [...byId.values()],
  };
  for (const spec of specialists) reg.register(spec);
  return reg;
}

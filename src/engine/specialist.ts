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

type Step<To extends CaseState> = { to: To; reason: string; timers?: TimerRequest[] };

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
};

export type ProposedAction = {
  id: string;
  label: string;
  tool: string;
  args: Record<string, unknown>;
  covered: boolean;
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

export type PromisedTimeResult = { reason: string; to?: CaseState; timers?: TimerRequest[] };

export type ApprovalResult = Step<"verifying" | "waiting_merchant">;
export type VerifyResult = Step<"closed" | "verifying" | "acting" | "waiting_merchant"> & { outcome?: string };

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
  verify(ctx: EngineContext, kase: Case, event: EngineEvent | null): Promise<VerifyResult>;
  // Required: what to do when the time promised to the customer has passed.
  onPromisedTime(ctx: EngineContext, kase: Case, event: EngineEvent): Promise<PromisedTimeResult>;
  countsAsSaved(ctx: EngineContext, kase: Case): boolean | Promise<boolean>;
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

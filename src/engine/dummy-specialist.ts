// A scripted specialist for tests and for checking the surfaces render
// (Step 6). It never reads what a customer wrote; it reacts only to the kind
// of event, so every state can be reached on purpose:
//   new case from a webhook         -> waiting_customer (15 min reply timer)
//   webhook the store processed     -> fixed_itself
//   reply timer with no answer      -> unconfirmed
//   customer message (unconfirmed)  -> likely
//   customer message (likely/wait)  -> confirmed -> waiting_merchant
//   tap approve                     -> acting -> verifying (30 min check)
//   check timer                     -> closed, counts as saved
import type { Moment } from "@/db/schema";
import type { EngineEvent } from "./events";
import type { InvestigateResult, Specialist } from "./specialist";

export const DUMMY_REPLY_MS = 15 * 60_000;
export const DUMMY_CHECK_MS = 30 * 60_000;

export function createDummySpecialist(
  opts: { moment?: Moment; detectWhen?: (e: EngineEvent) => boolean; ruleId?: string } = {},
): Specialist {
  const processed = (e: EngineEvent) => (e.payload.delivery as { processed?: boolean } | undefined)?.processed === true;
  return {
    id: "dummy",
    moment: opts.moment ?? "paid_no_order",

    detect(_ctx, e) {
      if (e.kind !== "webhook" && e.kind !== "message_in") return null;
      if (opts.detectWhen && !opts.detectWhen(e)) return null;
      return {
        moment: opts.moment ?? "paid_no_order",
        confidence: "likely",
        alert: "A payment may need a look. RAY is checking.",
        paymentId: e.keys.paymentId,
      };
    },

    async investigate(_ctx, kase, e): Promise<InvestigateResult> {
      const cite = [{ text: `Saw a ${e.kind} event`, evidenceRef: e.sourceId }];
      if (e.kind === "webhook" && processed(e)) {
        return { to: "fixed_itself", reason: "The store processed the payment", findings: cite, confidence: "sure" };
      }
      if (e.kind === "timer") {
        return kase.state === "waiting_customer"
          ? { to: "unconfirmed", reason: "No reply in time", findings: cite }
          : { to: kase.state, reason: "Timer had nothing to do", findings: cite };
      }
      if (e.kind === "message_in") {
        if (kase.state === "unconfirmed") return { to: "likely", reason: "Customer wrote again", findings: cite };
        if (kase.state === "waiting_merchant") return { to: "waiting_merchant", reason: "Still waiting for the merchant", findings: cite };
        return { to: "confirmed", reason: "Customer gave the details", findings: cite, confidence: "sure", side: "merchant" };
      }
      if (kase.state === "likely") {
        return {
          to: "waiting_customer",
          reason: "Need the customer to confirm",
          findings: cite,
          timers: [{ kind: "customer_reply", inMs: DUMMY_REPLY_MS }],
        };
      }
      return { to: kase.state, reason: "Nothing new", findings: cite };
    },

    async decide() {
      return opts.ruleId
        ? { to: "acting", reason: "An approved rule covers this", summary: "Fix it under the rule", ruleId: opts.ruleId }
        : { to: "waiting_merchant", reason: "Needs the merchant's tap", summary: "Ask the merchant to fix it" };
    },

    async proposeActions() {
      return [{ id: "prop_dummy_1", label: "Mark paid & ship", tool: "mark_paid", args: {}, covered: false }];
    },

    async onApproval() {
      return { to: "verifying", reason: "Done, checking it worked", timers: [{ kind: "verify_check", inMs: DUMMY_CHECK_MS }] };
    },

    async verify(_ctx, _kase, e) {
      if (e?.kind === "timer" && e.payload.timer_kind === "verify_check") {
        return { to: "closed", reason: "Checked and it worked", outcome: "fixed" };
      }
      return { to: "verifying", reason: "Not checked yet" };
    },

    countsAsSaved: () => true,
  };
}

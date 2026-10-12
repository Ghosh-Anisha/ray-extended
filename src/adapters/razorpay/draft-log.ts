// Every change to a dispute draft is written to the case timeline, in mock
// and test mode alike. A draft needs an open case to log to, so RAY never
// edits a dispute response without a trail.
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Clock } from "../clock";
import { newId } from "../ids";
import type { RazorpayAdapter } from "./types";

// payload.kind of the note written for each draft change.
export const DISPUTE_DRAFT_EVENT_KINDS = ["dispute_draft_created", "dispute_draft_changed", "dispute_draft_submitted"] as const;
export type DisputeDraftEventKind = (typeof DISPUTE_DRAFT_EVENT_KINDS)[number];

export function withDraftLog(rzp: RazorpayAdapter, db: Db, clock: Clock, merchantId: string): RazorpayAdapter {
  const repo = createRepository(db);

  const caseFor = (paymentId: string) => {
    const open = and(eq(s.cases.merchant_id, merchantId), eq(s.cases.payment_id, paymentId), ne(s.cases.state, "closed"));
    const latest = (where: ReturnType<typeof and>) =>
      db.select().from(s.cases).where(where).orderBy(desc(s.cases.opened_at)).get();
    return latest(and(open, eq(s.cases.moment, "chargeback"))) ?? latest(open);
  };

  return {
    ...rzp,
    async contestDispute(disputeId, input) {
      const before = await rzp.fetchDispute(disputeId);
      const kase = caseFor(before.payment_id);
      if (!kase) {
        throw new Error(`No open case for payment ${before.payment_id}. Open a case before drafting a dispute response.`);
      }
      const after = await rzp.contestDispute(disputeId, input);
      const changed = JSON.stringify(before.evidence) !== JSON.stringify(after.evidence) || before.status !== after.status;
      if (changed) {
        const submitted = input.action === "submit";
        const kind: DisputeDraftEventKind = submitted
          ? "dispute_draft_submitted"
          : before.evidence
            ? "dispute_draft_changed"
            : "dispute_draft_created";
        // A submit has Razorpay's own submitted_at. A draft change has no
        // source time, so it falls back to the clock.
        const at = (submitted ? after.evidence?.submitted_at : null) ?? clock.now();
        repo.caseEvents.insert({
          id: newId("cev"),
          case_id: kase.id,
          at,
          type: "note",
          payload: {
            kind,
            dispute_id: disputeId,
            draft_status: submitted ? "submitted" : "draft",
            draft: after.evidence,
          },
          evidence_ref: disputeId,
        });
      }
      return after;
    },
  };
}

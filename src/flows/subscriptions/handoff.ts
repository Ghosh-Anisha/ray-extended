// The hand-off of an unpaid B2B renewal to Collect (Step 11, built in
// parallel). This flow only emits the event: a case_events note of kind
// collect.handoff on the subscription case, with the invoice and the buyer.
// Collect reads it from the database (rule 11); no Collect logic lives here.
import { sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/adapters/ids";
import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import type { EngineContext } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";

export const COLLECT_HANDOFF = "collect.handoff";

export const collectHandoff = z.object({
  kind: z.literal(COLLECT_HANDOFF),
  merchant_id: z.string(),
  subscription_id: z.string(),
  invoice: z.object({
    id: z.string(),
    amount: z.number().int().positive(),
    billing_start: z.number().int(),
    billing_end: z.number().int(),
    short_url: z.string().nullable(),
    attempts: z.number().int(),
  }),
  buyer: z.object({ customer_id: z.string(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable() }),
  reason: z.string(),
});
export type CollectHandoff = z.infer<typeof collectHandoff>;

export function emitCollectHandoff(ctx: EngineContext, kase: Case, handoff: Omit<CollectHandoff, "kind">) {
  const payload = collectHandoff.parse({ kind: COLLECT_HANDOFF, ...handoff });
  return ctx.repo.caseEvents.insert({ id: newId("cev"), case_id: kase.id, at: ctx.clock.now(), type: "note", payload, evidence_ref: handoff.invoice.id });
}

// Every hand-off for a merchant, oldest first, for Collect to pick up.
export function listCollectHandoffs(db: Db, merchantId?: string): (CollectHandoff & { case_id: string; event_id: string; at: number })[] {
  return db
    .select()
    .from(s.caseEvents)
    .where(sql`json_extract(${s.caseEvents.payload}, '$.kind') = ${COLLECT_HANDOFF}`)
    .orderBy(s.caseEvents.at, s.caseEvents.seq)
    .all()
    .map((e) => ({ ...collectHandoff.parse(e.payload), case_id: e.case_id, event_id: e.id, at: e.at }))
    .filter((h) => !merchantId || h.merchant_id === merchantId);
}

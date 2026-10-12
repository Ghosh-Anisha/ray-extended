// Finds the open case an event belongs to. Rules:
// - Taps and timers name their case.
// - A new query never joins; it opens a new case.
// - Same payment: joins. A case with a different payment never joins.
// - Same email or phone, with case activity within 7 days of the event
//   (by source time): joins. The most recently active case wins.
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { EngineEvent } from "./events";
import { FINAL_STATES, type Case } from "./state-machine";

export const GROUPING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function findCase(db: Db, e: EngineEvent): Case | null {
  const repo = createRepository(db);
  if (e.caseId) {
    const kase = repo.cases.get(e.caseId);
    if (!kase || kase.merchant_id !== e.merchantId) throw new Error(`Case ${e.caseId} not found for ${e.merchantId}`);
    return kase;
  }
  if (e.newQuery) return null;

  const open = db
    .select()
    .from(s.cases)
    .where(and(eq(s.cases.merchant_id, e.merchantId), notInArray(s.cases.state, [...FINAL_STATES])))
    .all();
  const { paymentId, email, phone } = e.keys;
  if (paymentId) {
    const same = open.find((c) => c.payment_id === paymentId);
    if (same) return same;
  }
  const joinable = open.filter((c) => !paymentId || !c.payment_id || c.payment_id === paymentId);
  if (joinable.length === 0 || (!email && !phone)) return null;

  const matchesKey = sql.join(
    [
      email ? sql`json_extract(${s.caseEvents.payload}, '$.keys.email') = ${email}` : null,
      phone ? sql`json_extract(${s.caseEvents.payload}, '$.keys.phone') = ${phone}` : null,
    ].filter((x) => x !== null),
    sql` or `,
  );
  const hit = db
    .select({ caseId: s.caseEvents.case_id, last: sql<number>`max(${s.caseEvents.at})` })
    .from(s.caseEvents)
    .where(
      and(
        inArray(
          s.caseEvents.case_id,
          joinable.map((c) => c.id),
        ),
        sql`(${matchesKey})`,
        sql`${s.caseEvents.at} >= ${e.at - GROUPING_WINDOW_MS}`,
      ),
    )
    .groupBy(s.caseEvents.case_id)
    .orderBy(sql`max(${s.caseEvents.at}) desc`)
    .get();
  return hit ? joinable.find((c) => c.id === hit.caseId)! : null;
}

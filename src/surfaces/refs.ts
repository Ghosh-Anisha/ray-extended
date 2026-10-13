// Case numbers the merchant reads ("#RD-1042"). The id stays the key; the
// number is a note on the case's timeline written when it was opened (the
// demo world fixes the ones the story names), else it comes from the id, so
// the same case always shows the same number.
import { eq, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import * as s from "@/db/schema";

export const CASE_REF_NOTE = "case_ref";

export function derivedRef(caseId: string): string {
  let h = 0;
  for (const ch of caseId) h = (h * 31 + ch.charCodeAt(0)) % 9000;
  return `RD-${1000 + h}`;
}

// Every named ref for a merchant: caseId -> "RD-1042". One query.
export function namedRefs(a: Adapters, merchantId?: string): Map<string, string> {
  const rows = a.db
    .select({ caseId: s.caseEvents.case_id, ref: sql<string>`json_extract(${s.caseEvents.payload}, '$.ref')` })
    .from(s.caseEvents)
    .innerJoin(s.cases, eq(s.cases.id, s.caseEvents.case_id))
    .where(
      merchantId
        ? sql`json_extract(${s.caseEvents.payload}, '$.kind') = ${CASE_REF_NOTE} and ${s.cases.merchant_id} = ${merchantId}`
        : sql`json_extract(${s.caseEvents.payload}, '$.kind') = ${CASE_REF_NOTE}`,
    )
    .all();
  return new Map(rows.map((r) => [r.caseId, r.ref]));
}

export function caseRef(a: Adapters, caseId: string): string {
  const row = a.db
    .select({ ref: sql<string>`json_extract(${s.caseEvents.payload}, '$.ref')` })
    .from(s.caseEvents)
    .where(sql`${s.caseEvents.case_id} = ${caseId} and json_extract(${s.caseEvents.payload}, '$.kind') = ${CASE_REF_NOTE}`)
    .get();
  return row?.ref ?? derivedRef(caseId);
}

// "RD-1042" -> case id, for the cases the story names.
export function heroCases(a: Adapters, merchantId: string): Record<string, string> {
  return Object.fromEntries([...namedRefs(a, merchantId)].map(([id, ref]) => [ref, id]));
}

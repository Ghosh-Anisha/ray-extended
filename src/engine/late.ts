// Late events on a case that closed with no reply (state unconfirmed).
// For 14 days after a case went unconfirmed:
// - a captured payment that matches it (same order, same link, or the same
//   customer paying the same amount) closes it as Resolved, outcome
//   paid_late, counted as saved for its moment;
// - a message from the same customer joins it, even past grouping's 7 days,
//   and the flow reopens it (a new message reopens it).
// Matching is code, against Razorpay's own payment record.
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { normalizeEmail, normalizePhone, type EngineEvent } from "./events";
import type { Case } from "./state-machine";

export const LATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const PAID_LATE = "paid_late";

export const isCapture = (e: EngineEvent) => e.kind === "webhook" && e.payload.event === "payment.captured" && !!e.keys.paymentId;

// When the case last became unconfirmed, from its state_changed note.
export function unconfirmedSince(db: Db, caseId: string): number | null {
  const ev = createRepository(db)
    .caseEvents.listByCase(caseId)
    .findLast((x) => x.payload.kind === "state_changed" && x.payload.to === "unconfirmed");
  return ev?.at ?? null;
}

// Every email and phone the case has seen, plus its payment's.
function customerKeys(db: Db, kase: Case) {
  const repo = createRepository(db);
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const x of repo.caseEvents.listByCase(kase.id)) {
    const keys = x.payload.keys as { email?: string | null; phone?: string | null } | undefined;
    const em = normalizeEmail(keys?.email);
    const ph = normalizePhone(keys?.phone);
    if (em) emails.add(em);
    if (ph) phones.add(ph);
  }
  const p = kase.payment_id ? repo.rzpPayments.get(kase.payment_id) : undefined;
  if (p?.email) emails.add(normalizeEmail(p.email)!);
  if (p?.contact) phones.add(normalizePhone(p.contact)!);
  return { emails, phones };
}

export function paymentMatches(db: Db, kase: Case, paymentId: string): boolean {
  const repo = createRepository(db);
  const q = repo.rzpPayments.get(paymentId);
  if (!q || q.merchant_id !== kase.merchant_id) return false;
  if (q.id === kase.payment_id) return true;
  const p = kase.payment_id ? repo.rzpPayments.get(kase.payment_id) : undefined;
  const cited = new Set(repo.caseEvents.listByCase(kase.id).map((x) => x.evidence_ref).filter((x): x is string => !!x));
  // Same order.
  if (q.order_id && (q.order_id === p?.order_id || cited.has(q.order_id))) return true;
  // Same link: one the case cites, or one RAY made on it.
  const link = repo.rzpLinks.list(eq(s.rzpLinks.payment_id, q.id))[0];
  if (link) {
    const made = repo.actions
      .list(and(eq(s.actions.case_id, kase.id), eq(s.actions.tool, "payment_link"), eq(s.actions.status, "done")))
      .some((x) => x.result?.id === link.id);
    if (made || cited.has(link.id)) return true;
  }
  // Same customer, same amount.
  const { emails, phones } = customerKeys(db, kase);
  const same = (!!q.email && emails.has(normalizeEmail(q.email)!)) || (!!q.contact && phones.has(normalizePhone(q.contact)!));
  const amount = p ? q.amount === p.amount && q.currency === p.currency : kase.amount !== null && q.currency === "INR" && q.amount === kase.amount;
  return same && amount;
}

// The most recent case that went unconfirmed in the last 14 days and this
// event belongs to, if any.
export function findLateCase(db: Db, e: EngineEvent): Case | null {
  if (!isCapture(e) && e.kind !== "message_in") return null;
  const candidates = createRepository(db)
    .cases.list(and(eq(s.cases.merchant_id, e.merchantId), eq(s.cases.state, "unconfirmed")))
    .map((k) => ({ k, since: unconfirmedSince(db, k.id) }))
    .filter((x): x is { k: Case; since: number } => x.since !== null && e.at >= x.since && e.at - x.since <= LATE_WINDOW_MS)
    .sort((x, y) => y.since - x.since);
  for (const { k } of candidates) {
    if (isCapture(e) && paymentMatches(db, k, e.keys.paymentId!)) return k;
    if (e.kind === "message_in") {
      const { emails, phones } = customerKeys(db, k);
      if ((e.keys.email && emails.has(e.keys.email)) || (e.keys.phone && phones.has(e.keys.phone))) return k;
    }
  }
  return null;
}

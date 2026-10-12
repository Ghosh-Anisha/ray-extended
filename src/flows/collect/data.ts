// What a Collect case knows, read from the database every time (rule 11):
// the buyer, the case's invoices, TDS claimed, credit notes, stage history,
// the promise ledger and the merchant's open questions. Everything is a
// table row or a case_events note; nothing lives only in memory.
import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import type { Db } from "@/db/client";
import { createRepository, type Repository } from "@/db/repository";
import * as s from "@/db/schema";
import type { EngineContext, ProposedAction } from "@/engine/specialist";
import { isFinal, type Case } from "@/engine/state-machine";
import { CASE_FACTS } from "@/guards/facts";
import { DAY, istMidnight, outstanding, type Buyer, type Invoice, type Stage } from "./stages";

// Note kinds Collect writes on its cases.
export const N = {
  case: "collect_case", // { buyer_id, credit_id? }
  invoice: "collect_invoice", // evidence_ref: invoice id
  stage: "collect_stage_done", // { stage, invoice_ids, how }
  pending: "collect_pending", // { item_id, ask, proposal|null, meta }
  resolved: "collect_resolved", // { item_id, how }
  ask: "collect_ask", // { text }: the one question the case page shows
  flag: "collect_flag", // { invoice_id, reason }
  pause: "collect_pause", // { invoice_ids, until, why }
  tds: "collect_tds_claimed", // { invoice_id, amount, credit_id }
  creditNote: "collect_credit_note", // { invoice_id, amount }
  link: "collect_link", // { link_id, short_url, invoice_ids }
  utr: "collect_utr_given", // { utr, invoice_ids }
  advice: "collect_advice", // { allocations, text_event }
  promise: "collect_promise", // { promise_id, source }
  broken: "collect_promise_broken", // { promise_id, invoice_id, count }
  kept: "collect_promise_kept", // { promise_id }
  reply: "collect_reply_read", // { type, why, ... }
  call: "collect_call_result", // { outcome, promise_id?, tap_ref, attempt }
  unreachable: "collect_unreachable", // { channels }
  draft: "collect_draft", // { what, text }
} as const;

export const CHECK_TIMER = "collect_check";

export type Ctx = EngineContext;
export type CaseEvent = typeof s.caseEvents.$inferSelect;

export const notes = (ctx: Ctx, caseId: string, kind: string) =>
  ctx.repo.caseEvents.listByCase(caseId).filter((e) => e.type === "note" && e.payload.kind === kind);

export function note(ctx: Ctx, caseId: string, payload: Record<string, unknown>, evidenceRef: string) {
  return ctx.repo.caseEvents.insert({ id: newId("cev"), case_id: caseId, at: ctx.clock.now(), type: "note", payload, evidence_ref: evidenceRef });
}

export function writeFacts(ctx: Ctx, caseId: string, facts: Record<string, string>, evidenceRef: string) {
  if (Object.keys(facts).length) note(ctx, caseId, { kind: CASE_FACTS, facts }, evidenceRef);
}

export function buyerIdOf(ctx: Ctx, caseId: string): string | null {
  const n = notes(ctx, caseId, N.case)[0];
  return (n?.payload.buyer_id as string | null | undefined) ?? null;
}
export const buyerOf = (ctx: Ctx, caseId: string): Buyer | null => {
  const id = buyerIdOf(ctx, caseId);
  return id ? (ctx.repo.buyers.get(id) ?? null) : null;
};
export const creditCaseOf = (ctx: Ctx, caseId: string): string | null =>
  (notes(ctx, caseId, N.case)[0]?.payload.credit_id as string | undefined) ?? null;

export function invoicesOf(ctx: Ctx, caseId: string): Invoice[] {
  const ids = [...new Set(notes(ctx, caseId, N.invoice).map((e) => e.evidence_ref!))];
  return ids.map((id) => ctx.repo.invoices.get(id)!).filter(Boolean);
}

// The open Collect case for a buyer, if there is one.
export function openCaseForBuyer(db: Db, merchantId: string, buyerId: string): Case | undefined {
  const rows = db
    .select({ caseId: s.caseEvents.case_id })
    .from(s.caseEvents)
    .innerJoin(s.cases, eq(s.cases.id, s.caseEvents.case_id))
    .where(
      and(
        eq(s.cases.merchant_id, merchantId),
        eq(s.cases.moment, "collect"),
        sql`json_extract(${s.caseEvents.payload}, '$.kind') = ${N.case}`,
        sql`json_extract(${s.caseEvents.payload}, '$.buyer_id') = ${buyerId}`,
      ),
    )
    .all();
  const repo = createRepository(db);
  return rows.map((r) => repo.cases.get(r.caseId)!).find((c) => !isFinal(c.state));
}

// Sums of notes of one kind for an invoice, across every Collect case.
function noteSum(db: Db, kind: string, invoiceId: string): number {
  const r = db
    .select({ n: sql<number>`coalesce(sum(json_extract(${s.caseEvents.payload}, '$.amount')), 0)` })
    .from(s.caseEvents)
    .where(and(sql`json_extract(${s.caseEvents.payload}, '$.kind') = ${kind}`, sql`json_extract(${s.caseEvents.payload}, '$.invoice_id') = ${invoiceId}`))
    .get();
  return Number(r?.n ?? 0);
}
export const tdsClaimed = (db: Db, invoiceId: string) => noteSum(db, N.tds, invoiceId);
export const creditNoted = (db: Db, invoiceId: string) => noteSum(db, N.creditNote, invoiceId);

// What RAY chases on an invoice now: not paid, not disputed, not TDS.
export const owedOn = (db: Db, inv: Invoice) => outstanding(inv, tdsClaimed(db, inv.id));

// Settled: nothing left, and any disputed part closed with a credit note.
export function settled(db: Db, inv: Invoice): boolean {
  const disputed = inv.disputed_part ?? 0;
  const noted = creditNoted(db, inv.id);
  if (disputed > noted) return false;
  return inv.amount - inv.paid_amount - tdsClaimed(db, inv.id) - noted <= 0;
}

// Invoices RAY chases for this buyer: open, and due within 3 days or overdue.
export function chaseable(db: Db, buyer: Buyer, now: number): Invoice[] {
  return db
    .select()
    .from(s.invoices)
    .where(and(eq(s.invoices.buyer_id, buyer.id), eq(s.invoices.merchant_id, buyer.merchant_id)))
    .all()
    .filter((i) => i.status !== "paid" && !settled(db, i) && i.due_date - 3 * DAY <= now);
}

export const openInvoicesOfBuyer = (db: Db, buyer: Pick<Buyer, "id" | "merchant_id">) =>
  db
    .select()
    .from(s.invoices)
    .where(and(eq(s.invoices.buyer_id, buyer.id), eq(s.invoices.merchant_id, buyer.merchant_id)))
    .all()
    .filter((i) => i.status !== "paid" && !settled(db, i));

// ---- Stage history

export type StageDone = { stage: Stage; invoice_ids: string[]; how: string; at: number };
export const stagesDone = (ctx: Ctx, caseId: string): StageDone[] =>
  notes(ctx, caseId, N.stage).map((e) => ({ ...(e.payload as Omit<StageDone, "at">), at: e.at }));

export function stagesFor(ctx: Ctx, caseId: string, invoiceId: string) {
  return stagesDone(ctx, caseId).filter((x) => x.invoice_ids.includes(invoiceId));
}

// ---- Promise ledger (the promises table)

export type PromiseRow = typeof s.promises.$inferSelect;

export const promisesFor = (repo: Repository, invoiceId: string) => repo.promises.list(eq(s.promises.invoice_id, invoiceId));
export const brokenCount = (repo: Repository, invoiceId: string) => promisesFor(repo, invoiceId).filter((p) => p.status === "broken").length;

// An open promise whose date hasn't passed pauses the chase on that invoice.
export function pausedBy(ctx: Ctx, caseId: string, inv: Invoice, now: number): string | null {
  const today = istMidnight(now);
  const open = promisesFor(ctx.repo, inv.id).find((p) => p.status === "open" && p.promised_date >= today);
  if (open) return "promise";
  const pause = notes(ctx, caseId, N.pause).findLast((e) => (e.payload.invoice_ids as string[]).includes(inv.id));
  if (pause && Number(pause.payload.until) > now) return String(pause.payload.why);
  if ((inv.disputed_part ?? 0) > 0 && owedOn(ctx.db, inv) <= 0) return "dispute";
  return null;
}

export function addPromise(ctx: Ctx, caseId: string, inv: Invoice, date: number, amount: number, source: string, evidenceRef: string) {
  // A new promise replaces an open one on the same invoice.
  for (const p of promisesFor(ctx.repo, inv.id).filter((x) => x.status === "open")) ctx.repo.promises.update(p.id, { status: "replaced" });
  const row = ctx.repo.promises.insert({ id: newId("prm"), invoice_id: inv.id, buyer_id: inv.buyer_id, promised_date: date, amount, made_at: ctx.clock.now(), status: "open" });
  note(ctx, caseId, { kind: N.promise, promise_id: row.id, source, invoice_id: inv.id }, row.id);
  return row;
}

// ---- Merchant questions and proposals waiting on a tap

export type PendingMeta = Record<string, unknown> & { type: string };
export type Pending = { itemId: string; ask: string; proposal: ProposedAction | null; meta: PendingMeta; at: number };

export function pendingItems(ctx: Ctx, caseId: string): Pending[] {
  const timeline = ctx.repo.caseEvents.listByCase(caseId);
  const done = new Set<string>();
  for (const e of timeline) {
    if (e.payload.kind === N.resolved) done.add(String(e.payload.item_id));
    if (e.payload.kind === "proposal_declined") done.add(String(e.payload.proposal_id));
  }
  const byId = new Map<string, Pending>();
  for (const e of timeline) {
    if (e.payload.kind !== N.pending) continue;
    const id = String(e.payload.item_id);
    byId.set(id, { itemId: id, ask: String(e.payload.ask), proposal: (e.payload.proposal as ProposedAction | null) ?? null, meta: e.payload.meta as PendingMeta, at: e.at });
  }
  return [...byId.values()].filter((p) => !done.has(p.itemId));
}

export function declinedIds(ctx: Ctx, caseId: string): Set<string> {
  return new Set(ctx.repo.caseEvents.listByCase(caseId).filter((e) => e.payload.kind === "proposal_declined").map((e) => String(e.payload.proposal_id)));
}

export function addPending(ctx: Ctx, caseId: string, item: Omit<Pending, "at">, evidenceRef: string) {
  if (pendingItems(ctx, caseId).some((p) => p.itemId === item.itemId)) return false;
  const all = ctx.repo.caseEvents.listByCase(caseId);
  if (all.some((e) => (e.payload.kind === N.resolved && e.payload.item_id === item.itemId) || (e.payload.kind === "proposal_declined" && e.payload.proposal_id === item.itemId))) return false;
  note(ctx, caseId, { kind: N.pending, item_id: item.itemId, ask: item.ask, proposal: item.proposal, meta: item.meta }, evidenceRef);
  return true;
}

export const resolve = (ctx: Ctx, caseId: string, itemId: string, how: string, evidenceRef: string) =>
  note(ctx, caseId, { kind: N.resolved, item_id: itemId, how }, evidenceRef);

export const unmatchedCredits = (db: Db, merchantId: string) =>
  db
    .select()
    .from(s.bankCredits)
    .where(eq(s.bankCredits.merchant_id, merchantId))
    .all()
    .filter((c) => c.matched_invoices.length === 0);

export const invoicesByIds = (db: Db, ids: string[]) => (ids.length ? db.select().from(s.invoices).where(inArray(s.invoices.id, ids)).all() : []);

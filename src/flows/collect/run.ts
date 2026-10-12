// How Collect events start. Each goes through handleEvent, the same entry
// point as every other event (the dev panel and the morning list call these).
// - The morning run: one event per buyer with something to chase today
//   (deduped per day by its source id). Opens the buyer's case, or joins it.
// - A bank credit landing (Banking+, Simulated).
// - The merchant's own note on a case ("spoke to them, paying on 20th").
import { eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { newId } from "@/adapters/ids";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Engine, HandleResult } from "@/engine/engine";
import { normalizeEmail, normalizePhone } from "@/engine/events";
import { chaseable } from "./data";
import { BANK_CREDIT_EVENT, BANKING_SOURCE, COLLECT_HANDOFF, COLLECT_SOURCE, MORNING_KIND, type HandoffPayload } from "./resolve";
import { dayKey } from "./stages";

export async function collectMorningRun(engine: Engine, a: Adapters, merchantId: string): Promise<HandleResult[]> {
  const repo = createRepository(a.db);
  const m = repo.merchants.get(merchantId);
  if (!m?.banking_plus) return [];
  const now = a.clock.now();
  const out: HandleResult[] = [];
  for (const b of repo.buyers.list(eq(s.buyers.merchant_id, merchantId))) {
    if (!chaseable(a.db, b, now).length) continue;
    out.push(
      await engine.handleEvent({
        kind: "store",
        merchantId,
        at: now,
        sourceId: `collect_morning_${b.id}_${dayKey(now)}`,
        keys: { email: normalizeEmail(b.email), phone: normalizePhone(b.phone) },
        payload: { source: COLLECT_SOURCE, kind: MORNING_KIND, buyer_id: b.id },
      }),
    );
  }
  return out;
}

export type NewCredit = { amount: number; remark: string; utr: string; date?: number; id?: string };

// A credit lands in the merchant's Banking+ account (Simulated).
export async function bankCreditArrives(engine: Engine, a: Adapters, merchantId: string, c: NewCredit): Promise<HandleResult & { creditId: string }> {
  const repo = createRepository(a.db);
  const id = c.id ?? newId("bc");
  if (!repo.bankCredits.get(id)) {
    repo.bankCredits.insert({ id, merchant_id: merchantId, amount: c.amount, remark: c.remark, utr: c.utr, date: c.date ?? a.clock.now(), matched_invoices: [] });
  }
  const r = await creditEvent(engine, a, merchantId, id);
  return { ...r, creditId: id };
}

// Hands an existing (seeded) credit to the engine.
export function creditEvent(engine: Engine, a: Adapters, merchantId: string, creditId: string) {
  return engine.handleEvent({
    kind: "webhook",
    merchantId,
    at: a.clock.now(),
    sourceId: `credit_${creditId}`,
    payload: { source: BANKING_SOURCE, event: BANK_CREDIT_EVENT, credit_id: creditId, simulated: true },
  });
}

// The merchant's own note on a case. Read like a reply: a date is a promise.
export function logMerchantNote(engine: Engine, a: Adapters, input: { merchantId: string; caseId: string; text: string }) {
  return engine.handleEvent({
    kind: "message_in",
    merchantId: input.merchantId,
    caseId: input.caseId,
    at: a.clock.now(),
    sourceId: newId("mnote"),
    payload: { from_merchant: true, channel: "whatsapp", body: input.text },
  });
}

// Subscriptions (Step 9) hands an unpaid B2B renewal to Collect.
export function collectHandoff(engine: Engine, a: Adapters, merchantId: string, payload: Omit<HandoffPayload, "event">, sourceId = newId("handoff")) {
  return engine.handleEvent({
    kind: "webhook",
    merchantId,
    at: a.clock.now(),
    sourceId,
    payload: { source: "subscriptions", event: COLLECT_HANDOFF, ...payload },
  });
}

// The case data this flow keeps in its own tables, added to caseFacts so the
// grounding guard (rule 6) can check buyer emails against it: the account's
// international limit, the MoneySaver bank details in the case's currency,
// and any transfer the case cites. Rows are display-ready strings.
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { formatMoney, formatTime, formatDate } from "@/guards/format";
import { registerFactSource } from "@/guards/facts";
import { fakeClock } from "@/adapters/clock";
import { createInternationalSim } from "./sim";
import { intlTransfers } from "./schema";

type Kase = typeof s.cases.$inferSelect;

export function caseCurrency(db: Db, kase: Kase): string | null {
  const repo = createRepository(db);
  const p = kase.payment_id ? repo.rzpPayments.get(kase.payment_id) : undefined;
  if (p) return p.currency;
  for (const e of repo.caseEvents.listByCase(kase.id)) {
    const link = e.evidence_ref ? repo.rzpLinks.get(e.evidence_ref) : undefined;
    if (link) return link.currency;
    const order = e.evidence_ref ? repo.rzpOrders.get(e.evidence_ref) : undefined;
    if (order) return order.currency;
  }
  return null;
}

export function internationalFacts(db: Db, kase: Kase): Record<string, unknown>[] {
  if (kase.moment !== "international") return [];
  // Reads only; the clock is never used here.
  const sim = createInternationalSim(db, fakeClock(0));
  const out: Record<string, unknown>[] = [];
  const settings = sim.settings(kase.merchant_id);
  if (settings) out.push({ international_limit: formatMoney(settings.limit_inr) });
  const currency = caseCurrency(db, kase);
  const acc = currency ? sim.account(kase.merchant_id, currency) : null;
  if (acc) {
    out.push({
      bank: acc.bank_name,
      account_name: acc.account_name,
      account_number: acc.account_number,
      [acc.routing_label.toLowerCase().replace(/\s+/g, "_")]: acc.routing,
      swift: acc.swift,
    });
  }
  const refs = new Set(createRepository(db).caseEvents.listByCase(kase.id).map((e) => e.evidence_ref));
  for (const t of db.select().from(intlTransfers).where(eq(intlTransfers.merchant_id, kase.merchant_id)).all()) {
    if (!refs.has(t.id)) continue;
    out.push({
      transfer: `${formatMoney(t.amount, t.currency)} (${formatMoney(t.base_amount)})`,
      remitter: t.remitter_name,
      reference: t.remitter_reference,
      received: `${formatTime(t.received_at)} on ${formatDate(t.received_at)}`,
    });
  }
  return out;
}

registerFactSource("international", internationalFacts);

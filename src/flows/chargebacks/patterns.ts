// Situation F, the weekly pattern insight. Code groups the merchant's
// disputes from the last 30 days by root cause: one product, a reason that
// repeats (not received, cancelled but charged), or fraud claims Vulcan
// didn't flag (customers not recognising the statement name). A pattern
// becomes one insight with ₹ at stake and the fix. The fix is a proposed
// playbook rule: nothing changes until the merchant taps Approve rule.
import { and, eq, gte } from "drizzle-orm";
import { newId } from "@/adapters/ids";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { cbFraudSignals } from "./schema";
import { disputeType, type DisputeType } from "./rules";
import { patternLine } from "./lines";

const DAY = 24 * 60 * 60 * 1000;
export const PATTERN_WINDOW_MS = 30 * DAY;
export const PATTERN_MIN = 2;
export const PATTERN_ALERT = "pattern_insight";

export type Insight = { key: string; count: number; atStake: number; disputeIds: string[]; text: string; fix: string };

const FIX: Partial<Record<DisputeType, { what: string; fix: string }>> = {
  not_received: { what: "say the order never arrived", fix: "Ask your courier for a delivery photo or OTP on every order, so the next reply has proof of delivery." },
  cancelled: { what: "say an order was cancelled but still charged", fix: "Show your refund policy at checkout and refund cancellations the same day." },
  not_as_described: { what: "say the order wasn't as described", fix: "Add clear photos and sizes to the product page." },
  duplicate: { what: "are for duplicate charges", fix: "Turn on Razorpay's duplicate payment check at checkout." },
};

export function findPatterns(db: Db, merchantId: string, now: number): Insight[] {
  const recent = db
    .select()
    .from(s.disputes)
    .where(and(eq(s.disputes.merchant_id, merchantId), gte(s.disputes.created_at, now - PATTERN_WINDOW_MS)))
    .all();
  const out: Insight[] = [];
  const sum = (ds: typeof recent) => ds.reduce((n, d) => n + d.amount, 0);

  // A reason that repeats.
  const byType = new Map<DisputeType, typeof recent>();
  for (const d of recent) byType.set(disputeType(d), [...(byType.get(disputeType(d)) ?? []), d]);
  for (const [type, ds] of byType) {
    const f = FIX[type];
    if (!f || ds.length < PATTERN_MIN) continue;
    out.push({ key: `reason_${type}`, count: ds.length, atStake: sum(ds), disputeIds: ds.map((d) => d.id), fix: f.fix, text: patternLine(ds.length, f.what, sum(ds), f.fix) });
  }

  // Fraud claims Vulcan didn't flag: customers not recognising the charge.
  const unflagged = (byType.get("fraud") ?? []).filter((d) => db.select().from(cbFraudSignals).where(eq(cbFraudSignals.payment_id, d.payment_id)).get()?.vulcan_result !== "flagged");
  if (unflagged.length >= PATTERN_MIN) {
    const fix = "Change your statement name to your shop's name so customers recognise the charge.";
    out.push({ key: "statement_name", count: unflagged.length, atStake: sum(unflagged), disputeIds: unflagged.map((d) => d.id), fix, text: patternLine(unflagged.length, "are from customers who may not recognise the charge", sum(unflagged), fix) });
  }

  // One product.
  const byProduct = new Map<string, typeof recent>();
  for (const d of recent) {
    const order = db.select().from(s.storeOrders).where(and(eq(s.storeOrders.merchant_id, merchantId), eq(s.storeOrders.payment_id, d.payment_id))).get();
    for (const it of order?.items ?? []) byProduct.set(it.name, [...(byProduct.get(it.name) ?? []), d]);
  }
  for (const [name, ds] of byProduct) {
    if (ds.length < PATTERN_MIN) continue;
    const fix = `Check how ${name} is packed, described and delivered.`;
    out.push({ key: `product_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, count: ds.length, atStake: sum(ds), disputeIds: ds.map((d) => d.id), fix, text: patternLine(ds.length, `are about ${name}`, sum(ds), fix) });
  }
  return out;
}

const weekOf = (ms: number) => Math.floor((ms + 3 * DAY) / (7 * DAY)); // weeks starting Monday (UTC)

// Once per merchant per week: an alert per pattern and its fix as a
// proposed rule. Returns what it wrote.
export function weeklyInsight(db: Db, merchantId: string, caseId: string, now: number): Insight[] {
  const repo = createRepository(db);
  const sent = repo.alerts.list(and(eq(s.alerts.merchant_id, merchantId), eq(s.alerts.kind, PATTERN_ALERT))).some((x) => weekOf(x.sent_at) === weekOf(now));
  if (sent) return [];
  const insights = findPatterns(db, merchantId, now);
  for (const i of insights) {
    repo.alerts.insert({ id: newId("alert"), merchant_id: merchantId, case_id: caseId, kind: PATTERN_ALERT, text: i.text, channel: "whatsapp", sent_at: now });
    const id = `rule_cb_fix_${i.key}_${merchantId}`;
    if (!repo.playbookRules.get(id)) {
      repo.playbookRules.insert({
        id, merchant_id: merchantId, moment: "chargeback",
        // A fix the merchant makes; it can never approve an action.
        rule_json: { setting: "pattern_fix", pattern: i.key, tool: "none" },
        text: i.fix, source: "pattern", status: "proposed", approved_at: null,
      });
    }
  }
  return insights;
}

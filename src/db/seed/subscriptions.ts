// Step 9 seed: fills the subscription columns migration 0900 added, on the
// rows Step 1 seeds, and adds each merchant's "call subscribers above ₹X"
// playbook rule (decision 3: the setting counts as the merchant's rule, so a
// call runs under its id; call opt-in and calling hours still apply).
// - Each mandate was approved by the subscriber a minute after sign-up,
//   with a fictional mandate reference.
// - Razorpay sent the pre-debit notice 24 hours before each cycle.
// - FitLoop calls subscribers worth more than ₹500 (Karan's ₹998 so far),
//   pauses for the default month, and has a 20% off offer made in the
//   Razorpay Dashboard. Sharma Tutorials calls above ₹5,000 and a pause
//   skips a month (30 days). Stackly never calls.
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { createRepository } from "../repository";
import * as s from "../schema";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const AUTH_REFS: Record<string, string> = {
  mdt_FL_karan: "UMNFLOOP7302",
  mdt_ST_acme: "UMNSTACK5518",
  mdt_STU_neha: "UMNSHARMA4410",
};

const PLAYBOOK: Record<string, Partial<typeof s.merchants.$inferInsert>> = {
  m_fitloop: { sub_pause_days: null, sub_discount_offer_id: "offer_FL_20off", sub_discount_percent: 20 },
  m_sharma_tutorials: { sub_pause_days: 30 },
  m_stackly: { sub_pause_days: null },
};

// The call rule's text and rule_json, for the seed and the playbook.
export const callRuleText = (rupees: string) => `Call subscribers worth more than ${rupees} with the save offer`;
export const callRuleJson = (minValue: number) => ({ tool: "place_call", kind: "subscription_save", min_value: minValue });

const CALL_RULES: { merchant: string; minValue: number; rupees: string }[] = [
  { merchant: "m_fitloop", minValue: 50_000, rupees: "₹500" },
  { merchant: "m_sharma_tutorials", minValue: 500_000, rupees: "₹5,000" },
];

export function seedSubscriptions(db: Db) {
  const repo = createRepository(db);
  for (const sub of repo.subscriptions.list()) {
    for (const m of db.select().from(s.mandates).where(eq(s.mandates.subscription_id, sub.id)).all()) {
      repo.mandates.update(m.id, { authorised_at: sub.started_at + MIN, auth_ref: AUTH_REFS[m.id] ?? null });
    }
    for (const inv of db.select().from(s.subInvoices).where(eq(s.subInvoices.subscription_id, sub.id)).all()) {
      repo.subInvoices.update(inv.id, { notified_at: inv.billing_start - DAY });
    }
  }
  for (const [id, values] of Object.entries(PLAYBOOK)) repo.merchants.update(id, values);
  const at = Math.min(...repo.subscriptions.list().map((x) => x.started_at));
  for (const r of CALL_RULES) {
    repo.playbookRules.insert({
      id: `rule_sub_call_${r.merchant}`, merchant_id: r.merchant, moment: "subscription", rule_json: callRuleJson(r.minValue),
      text: callRuleText(r.rupees), source: "merchant", status: "approved", approved_at: at,
    });
  }
}

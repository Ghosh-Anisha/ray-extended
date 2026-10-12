// Step 9 seed: fills the subscription columns migration 0900 added, on the
// rows Step 1 seeds. No new rows, so the seed's row counts don't change.
// - Each mandate was approved by the subscriber a minute after sign-up,
//   with a fictional mandate reference.
// - Razorpay sent the pre-debit notice 24 hours before each cycle.
// - FitLoop calls subscribers worth more than ₹500 (Karan's ₹998 so far);
//   Sharma Tutorials calls above ₹5,000 and a pause skips a month (30 days);
//   Stackly never calls.
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { createRepository } from "../repository";
import * as s from "../schema";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const AUTH_REFS: Record<string, string> = {
  mdt_FL_karan: "FLOOPKARAN0815UPI",
  mdt_ST_acme: "STACKLYACME0807CARD",
  mdt_STU_neha: "SHARMANEHA0911UPI",
};

const PLAYBOOK: Record<string, { sub_call_value_limit: number | null; sub_pause_days: number | null }> = {
  m_fitloop: { sub_call_value_limit: 50_000, sub_pause_days: 30 },
  m_sharma_tutorials: { sub_call_value_limit: 500_000, sub_pause_days: 30 },
  m_stackly: { sub_call_value_limit: null, sub_pause_days: null },
};

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
}

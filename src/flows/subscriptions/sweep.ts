// Situation A has no webhook: a sign-up whose mandate was never authorised
// just stays "created" at Razorpay. The sweep reads Razorpay's subscriptions
// and sends each one still created 30 minutes after sign-up to handleEvent,
// the same entry point as every other event. A second sweep is a duplicate.
import { and, eq, lte } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import * as s from "@/db/schema";
import type { Engine, HandleResult } from "@/engine/engine";
import { normalizeEmail, normalizePhone } from "@/engine/events";

export const SETUP_WAIT_MS = 30 * 60_000;
export const SETUP_EVENT = "subscription.setup_incomplete";

export async function setupSweep(engine: Engine, a: Adapters, merchantId: string): Promise<HandleResult[]> {
  const now = a.clock.now();
  const rows = a.db
    .select()
    .from(s.subscriptions)
    .where(and(eq(s.subscriptions.merchant_id, merchantId), eq(s.subscriptions.status, "created"), lte(s.subscriptions.started_at, now - SETUP_WAIT_MS)))
    .all();
  const out: HandleResult[] = [];
  for (const row of rows) {
    const sub = await a.razorpay(merchantId).fetchSubscription(row.id);
    if (sub.status !== "created") continue;
    const customer = a.db.select().from(s.customers).where(eq(s.customers.id, row.customer_id)).get();
    out.push(
      await engine.handleEvent({
        kind: "webhook",
        merchantId,
        at: now,
        sourceId: `sweep_setup_${row.id}`,
        keys: { subscriptionId: row.id, phone: normalizePhone(customer?.phone), email: normalizeEmail(customer?.email) },
        payload: { source: "razorpay", event: SETUP_EVENT, entities: { subscription: { entity: { ...row, entity: "subscription" } } } },
      }),
    );
  }
  return out;
}

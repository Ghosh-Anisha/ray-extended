// Playbook rules RAY proposes when a merchant is set up. Each starts
// "proposed" and does nothing until the merchant approves it.
// The capture rule: with it approved, an authorised payment is captured
// before Razorpay's timeout without asking (paid-no-order situation A).
// Without it, RAY asks the merchant and shows the time left.
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";

export const CAPTURE_RULE_TEXT = "Capture authorised payments before the timeout";

export const SETUP_RULES: ({ key: string } & Pick<typeof s.playbookRules.$inferInsert, "moment" | "rule_json" | "text">)[] = [
  { key: "capture", moment: "paid_no_order", rule_json: { tool: "capture", when: "authorized_before_timeout" }, text: CAPTURE_RULE_TEXT },
];

// Adds any setup rule the merchant doesn't have yet, as proposed.
export function proposeSetupRules(db: Db, merchantId: string) {
  const repo = createRepository(db);
  const have = new Set(repo.playbookRules.list(eq(s.playbookRules.merchant_id, merchantId)).map((r) => r.text));
  for (const { key, ...r } of SETUP_RULES) {
    if (have.has(r.text)) continue;
    repo.playbookRules.insert({ id: `rule_setup_${key}_${merchantId}`, merchant_id: merchantId, ...r, source: "pattern", status: "proposed", approved_at: null });
  }
  return repo.playbookRules.list(and(eq(s.playbookRules.merchant_id, merchantId), eq(s.playbookRules.status, "proposed")));
}

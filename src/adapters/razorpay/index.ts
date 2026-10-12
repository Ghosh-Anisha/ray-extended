// Picks the Razorpay adapter from RAZORPAY_MODE (mock by default).
// Any key that is not rzp_test_ stops startup, in either mode.
import type { Db } from "@/db/client";
import type { Clock } from "../clock";
import { withDraftLog } from "./draft-log";
import { createMockRazorpay } from "./mock";
import { assertTestKey, createTestClient, type RazorpayKeys } from "./test-client";
import type { RazorpayAdapter } from "./types";

export * from "./types";
export { createMockRazorpay, type MockRazorpay } from "./mock";
export { assertTestKey, createTestClient } from "./test-client";
export { DISPUTE_DRAFT_EVENT_KINDS, type DisputeDraftEventKind } from "./draft-log";

// Keys sit behind a function so logging or serialising the config never shows them.
export type RazorpayConfig = { mode: "mock" } | { mode: "test"; keys: () => RazorpayKeys };

export function loadRazorpayConfig(env: Record<string, string | undefined> = process.env): RazorpayConfig {
  const mode = env.RAZORPAY_MODE || "mock";
  if (mode !== "mock" && mode !== "test") {
    throw new Error("RAZORPAY_MODE must be mock or test");
  }
  const keyId = env.RAZORPAY_KEY_ID || undefined;
  if (keyId !== undefined || mode === "test") assertTestKey(keyId);
  if (mode === "mock") return { mode };
  const keySecret = env.RAZORPAY_KEY_SECRET;
  if (!keySecret) throw new Error("Refusing to start: RAZORPAY_MODE=test needs RAZORPAY_KEY_SECRET in .env.local");
  return { mode, keys: () => ({ keyId: keyId!, keySecret }) };
}

// In test mode every merchant shares the one test account. Both modes log
// dispute draft changes to the case timeline.
export function createRazorpay(config: RazorpayConfig, db: Db, clock: Clock, merchantId: string): RazorpayAdapter {
  const rzp = config.mode === "test" ? createTestClient(config.keys()) : createMockRazorpay(db, clock, merchantId);
  return withDraftLog(rzp, db, clock, merchantId);
}

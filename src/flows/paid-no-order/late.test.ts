// Late events on a paid-no-order case that closed with no reply (engine,
// late.ts): a matching payment within 14 days closes it as Resolved, paid
// late; a message within 14 days reopens it, past grouping's 7 days.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as s from "@/db/schema";
import { HOUR, LEAFY, MIN, PRIYA_EMAIL, PRIYA_PAY, PRIYA_PHONE, pnoWorld, type PnoWorld } from "./test-helpers";

vi.setConfig({ testTimeout: 30_000 });
const DAY = 24 * HOUR;

let w: PnoWorld;
beforeEach(async () => {
  w = await pnoWorld();
});
afterEach(() => w.close());

// The Step 7 path to Closed, no reply: fulfilled, no answer to "did it arrive?".
async function closedNoReply() {
  await w.a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: PRIYA_PAY });
  const caseId = w.caseFor(PRIYA_PAY)!.id;
  await w.engine.advanceBy(15 * MIN);
  await w.tapLabel(caseId, "Mark paid & ship");
  await w.engine.advanceBy(72 * HOUR);
  expect(w.state(caseId).state).toBe("unconfirmed");
  return caseId;
}

describe("paid-no-order: late events after Closed, no reply", () => {
  it("Priya paying ₹1,299 again 5 days later closes it as Resolved, paid late, saved, and opens nothing new", async () => {
    const caseId = await closedNoReply();
    await w.engine.advanceBy(5 * DAY);
    w.payment({ id: "pay_LB1234LATE01", amount: 129_900, contact: PRIYA_PHONE, email: PRIYA_EMAIL, minutesAgo: 0, receipt: "wc_1290" });
    await w.a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234LATE01" });
    expect(w.state(caseId)).toMatchObject({ state: "closed", outcome: "paid_late", counts_as_saved: true });
    expect(w.repo.cases.list(eq(s.cases.merchant_id, LEAFY))).toHaveLength(1);
  });

  it("a different amount is not a match", async () => {
    const caseId = await closedNoReply();
    w.payment({ id: "pay_LB1234LATE02", amount: 49_900, contact: PRIYA_PHONE, minutesAgo: 0, receipt: "wc_1291" });
    await w.a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234LATE02" });
    expect(w.state(caseId).state).toBe("unconfirmed");
  });

  it("a message 10 days later reopens it, past grouping's 7 days", async () => {
    const caseId = await closedNoReply();
    await w.engine.advanceBy(10 * DAY);
    await w.says(PRIYA_PHONE, "Hello? My order never came.");
    expect(w.state(caseId).state).toBe("likely");
  });

  it("after 14 days a message is a new case", async () => {
    const caseId = await closedNoReply();
    await w.engine.advanceBy(15 * DAY);
    await w.says(PRIYA_PHONE, "Hello? My order never came.");
    expect(w.state(caseId).state).toBe("unconfirmed");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepository } from "@/db/repository";
import { SEED_NOW } from "@/db/seed";
import { createMockRazorpay } from "./razorpay";
import { createOrderForCasePayment, ORDER_TOTAL_MISMATCH } from "./order-for-payment";
import { seededAdapters } from "./test-helpers";

const LEAFY = "m_leafy_bakes";

describe("creating a store order for a case's payment", () => {
  let a: ReturnType<typeof seededAdapters>;
  let repo: ReturnType<typeof createRepository>;
  beforeEach(() => {
    a = seededAdapters();
    repo = createRepository(a.db);
    a.store.setFailure(LEAFY, "none");
    // Priya paid ₹1,299 but has no order (store order #1234 left aside for this test).
    repo.cases.insert({
      id: "case_priya", merchant_id: LEAFY, moment: "paid_no_order", state: "acting", confidence: "sure",
      payment_id: "pay_LB1234PRIYA", amount: 129_900, opened_at: SEED_NOW,
    });
  });
  afterEach(() => a.db.$client.close());

  it("creates the order with the captured amount as its total", async () => {
    const r = await createOrderForCasePayment(a, { caseId: "case_priya", customerId: "cus_priya", items: [{ name: "Chocolate box", qty: 1 }] });
    expect(r.created).toBe(true);
    if (!r.created) return;
    expect(r.order).toMatchObject({ total: 129_900, payment_id: "pay_LB1234PRIYA", status: "processing", razorpay_order_id: "order_LB1234" });
    expect(a.store.stock(LEAFY, "Chocolate box")).toBe(11);
    expect(repo.caseEvents.listByCase("case_priya")).toEqual([]);
    expect(repo.cases.get("case_priya")?.state).toBe("acting");
  });

  it("does not create the order when line items don't add up to the payment", async () => {
    const r = await createOrderForCasePayment(a, { caseId: "case_priya", items: [{ name: "Chocolate box", qty: 1 }, { name: "Banana bread loaf", qty: 1 }] });
    expect(r).toEqual({ created: false, mismatch: { expected_total: 129_900, line_items_total: 179_800 } });
    expect(await a.store.getOrder(LEAFY, { paymentId: "pay_LB1234PRIYA" })).toBeNull();
    expect(a.store.stock(LEAFY, "Chocolate box")).toBe(12);
    expect(a.store.stock(LEAFY, "Banana bread loaf")).toBe(7);

    const events = repo.caseEvents.listByCase("case_priya");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "note",
      evidence_ref: "pay_LB1234PRIYA",
      payload: { kind: ORDER_TOTAL_MISMATCH, payment_amount: 129_900, line_items_total: 179_800 },
    });
    expect(repo.cases.get("case_priya")?.state).toBe("waiting_merchant");
  });

  it("refuses a payment that is not captured", async () => {
    const auth = createMockRazorpay(a.db, a.clock, LEAFY).simulatePayment({ amount: 129_900, status: "authorized" });
    repo.cases.update("case_priya", { payment_id: auth.id });
    await expect(createOrderForCasePayment(a, { caseId: "case_priya", items: [{ name: "Chocolate box", qty: 1 }] })).rejects.toThrow(/captured/);
    expect(repo.caseEvents.listByCase("case_priya")).toEqual([]);
  });
});

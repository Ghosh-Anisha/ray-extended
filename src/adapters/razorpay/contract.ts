// Contract every RazorpayAdapter must meet. Runs against the mock always and
// against test mode when RAZORPAY_MODE=test. Cases that need records we can't
// create through the API (a captured payment, a dispute, a subscription) take
// them from fixtures and are skipped when a fixture is missing.
import { beforeEach, describe, expect, it } from "vitest";
import { RazorpayError, type RazorpayAdapter } from "./types";

export type RazorpayFixtures = {
  capturedPayment?: () => Promise<{ id: string; amount: number }>;
  authorizedPayment?: () => Promise<{ id: string; amount: number; currency: string }>;
  orderWithTwoPayments?: string;
  openDisputeId?: string;
  activeSubscriptionId?: string;
  pendingInvoiceSubscriptionId?: string;
  advanceClock?: (ms: number) => void;
};

export type RazorpayContext = { rzp: RazorpayAdapter; fx: RazorpayFixtures };

const DAY = 24 * 60 * 60 * 1000;

async function rejects(p: Promise<unknown>, code: RazorpayError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RazorpayError && e.code === code);
}

export function razorpayContract(name: string, setup: () => RazorpayContext | Promise<RazorpayContext>, opts: { skip?: boolean } = {}) {
  describe.skipIf(opts.skip)(`RazorpayAdapter contract: ${name}`, () => {
    let rzp: RazorpayAdapter;
    let fx: RazorpayFixtures;
    beforeEach(async () => {
      ({ rzp, fx } = await setup());
    });
    const withFx = (key: keyof RazorpayFixtures, title: string, fn: () => Promise<void>) =>
      it(title, async (ctx) => {
        if (!fx[key]) ctx.skip();
        await fn();
      });
    const receipt = (tag: string) => `ct_${tag}_${Date.now().toString(36)}`;

    it("creates an order and finds it by id and by receipt", async () => {
      const r = receipt("order");
      const order = await rzp.createOrder({ amount: 129_900, currency: "INR", receipt: r });
      expect(order).toMatchObject({ amount: 129_900, currency: "INR", receipt: r, status: "created" });
      expect((await rzp.fetchOrder(order.id)).id).toBe(order.id);
      expect((await rzp.fetchOrderByReceipt(r))?.id).toBe(order.id);
      expect(await rzp.listOrderPayments(order.id)).toEqual([]);
    });

    it("returns null for an unknown receipt and NOT_FOUND for an unknown payment", async () => {
      expect(await rzp.fetchOrderByReceipt(receipt("none"))).toBeNull();
      await rejects(rzp.fetchPayment("pay_DoesNotExist01"), "NOT_FOUND");
    });

    it("creates payment links in INR and in a foreign currency", async () => {
      const inr = await rzp.createPaymentLink({ amount: 129_900, currency: "INR", description: "Order #1234" });
      expect(inr).toMatchObject({ amount: 129_900, currency: "INR", status: "created" });
      expect(inr.short_url).toMatch(/^https:\/\//);
      const usd = await rzp.createPaymentLink({ amount: 4_900, currency: "USD", description: "Pro annual" });
      expect(usd).toMatchObject({ amount: 4_900, currency: "USD" });
      expect((await rzp.fetchPaymentLink(usd.id)).id).toBe(usd.id);
    });

    withFx("orderWithTwoPayments", "lists every payment on an order, oldest first", async () => {
      const pays = await rzp.listOrderPayments(fx.orderWithTwoPayments!);
      expect(pays).toHaveLength(2);
      expect(pays[0].created_at).toBeLessThanOrEqual(pays[1].created_at);
    });

    withFx("authorizedPayment", "captures an authorized payment for its full amount only", async () => {
      const p = await fx.authorizedPayment!();
      await rejects(rzp.capturePayment(p.id, p.amount - 1, p.currency), "BAD_REQUEST");
      const captured = await rzp.capturePayment(p.id, p.amount, p.currency);
      expect(captured.status).toBe("captured");
      await rejects(rzp.capturePayment(p.id, p.amount, p.currency), "INVALID_STATE");
    });

    withFx("capturedPayment", "refunds with the receipt as idempotency key", async () => {
      const p = await fx.capturedPayment!();
      const r = receipt("rf");
      const first = await rzp.refund(p.id, { amount: p.amount, receipt: r });
      const again = await rzp.refund(p.id, { amount: p.amount, receipt: r });
      expect(again.id).toBe(first.id);
      expect(await rzp.listRefunds(p.id)).toHaveLength(1);
      await rejects(rzp.refund(p.id, { amount: p.amount - 100, receipt: r }), "RECEIPT_REUSED");
    });

    withFx("capturedPayment", "rejects an over-refund", async () => {
      const p = await fx.capturedPayment!();
      await rejects(rzp.refund(p.id, { amount: p.amount + 1, receipt: receipt("over") }), "OVER_REFUND");
      expect(await rzp.listRefunds(p.id)).toEqual([]);
    });

    withFx("capturedPayment", "allows one refund per payment", async () => {
      const p = await fx.capturedPayment!();
      await rzp.refund(p.id, { amount: 100, receipt: receipt("part1") });
      await rejects(rzp.refund(p.id, { amount: 100, receipt: receipt("part2") }), "ALREADY_REFUNDED");
      expect((await rzp.fetchPayment(p.id)).amount_refunded).toBe(100);
    });

    withFx("openDisputeId", "fetches disputes and filters them by payment", async () => {
      const d = await rzp.fetchDispute(fx.openDisputeId!);
      expect(d.status).toBe("open");
      const forPayment = await rzp.listDisputes({ paymentId: d.payment_id });
      expect(forPayment.map((x) => x.id)).toContain(d.id);
    });

    withFx("openDisputeId", "contests with a draft first, then submits", async () => {
      const id = fx.openDisputeId!;
      const d = await rzp.fetchDispute(id);
      await rejects(rzp.contestDispute(id, { action: "submit", summary: "Delivered" }), "BAD_REQUEST");
      const draft = await rzp.contestDispute(id, { action: "draft", amount: d.amount, summary: "Delivered on time" });
      expect(draft.status).toBe("open");
      expect(draft.evidence?.summary).toBe("Delivered on time");
      const sent = await rzp.contestDispute(id, { action: "submit", documents: { shipping_proof: ["doc_ship_1"] } });
      expect(sent.status).toBe("under_review");
      expect(sent.evidence?.documents.shipping_proof).toEqual(["doc_ship_1"]);
      await rejects(rzp.acceptDispute(id), "INVALID_STATE");
    });

    withFx("openDisputeId", "accepts an open dispute", async () => {
      const d = await rzp.acceptDispute(fx.openDisputeId!);
      expect(d.status).toBe("lost");
    });

    withFx("advanceClock", "refuses to contest after the respond-by date", async () => {
      fx.advanceClock!(60 * DAY);
      await rejects(rzp.contestDispute(fx.openDisputeId!, { action: "draft", summary: "Late" }), "DEADLINE_PASSED");
    });

    withFx("activeSubscriptionId", "pauses, resumes and cancels a subscription", async () => {
      const id = fx.activeSubscriptionId!;
      expect((await rzp.fetchSubscription(id)).status).toBe("active");
      await rejects(rzp.resumeSubscription(id), "INVALID_STATE");
      expect((await rzp.pauseSubscription(id)).status).toBe("paused");
      expect((await rzp.resumeSubscription(id)).status).toBe("active");
      expect((await rzp.cancelSubscription(id)).status).toBe("cancelled");
      await rejects(rzp.pauseSubscription(id), "INVALID_STATE");
    });

    withFx("pendingInvoiceSubscriptionId", "returns the subscription's own pending invoice", async () => {
      const inv = await rzp.fetchPendingInvoice(fx.pendingInvoiceSubscriptionId!);
      expect(inv).not.toBeNull();
      expect(inv!.subscription_id).toBe(fx.pendingInvoiceSubscriptionId);
      expect(inv!.status).toBe("issued");
      expect(inv!.short_url).toMatch(/^https:\/\//);
    });
  });
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DROPPED_NOTE } from "../store";
import { seededAdapters } from "../test-helpers";
import { EVENT_REF, WEBHOOK_EVENTS, WebhookError, type Delivery, type EmitInput, type WebhookEventName } from ".";

const LEAFY = "m_leafy_bakes";

describe("Webhook simulator", () => {
  let a: ReturnType<typeof seededAdapters>;
  beforeEach(() => {
    a = seededAdapters();
  });
  afterEach(() => a.db.$client.close());

  async function anyRefund() {
    const rzp = a.razorpay(LEAFY);
    return rzp.refund("pay_LB1235RAHUL2", { amount: 49_900, receipt: "dup_rahul" });
  }

  // One valid input per event, using seeded records.
  async function inputFor(event: WebhookEventName): Promise<EmitInput> {
    switch (EVENT_REF[event]) {
      case "paymentId":
        return { merchantId: LEAFY, event, paymentId: "pay_LB1234PRIYA" };
      case "refundId":
        return { merchantId: LEAFY, event, refundId: (await anyRefund()).id };
      case "disputeId":
        return { merchantId: LEAFY, event, disputeId: "disp_LB_meera" };
      case "downtime": {
        if (event === "payment.downtime.started") return { merchantId: LEAFY, event, downtime: { method: "upi", bank: "HDFC" } };
        const started = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.downtime.started", downtime: { method: "upi", bank: "HDFC" } });
        const id = started.event.payload["payment.downtime"].entity.id as string;
        return { merchantId: LEAFY, event, downtime: { method: "upi", id } };
      }
      case "subscriptionId":
        return { merchantId: "m_fitloop", event, subscriptionId: "sub_FL_karan" };
      case "tokenId":
        return { merchantId: "m_fitloop", event, tokenId: "token_FL_karan" };
      case "linkId": {
        const link = await a.razorpay("m_notenest").createPaymentLink({ amount: 4_900, currency: "USD", description: "Pro annual" });
        return { merchantId: "m_notenest", event, linkId: link.id };
      }
    }
  }

  it.each(WEBHOOK_EVENTS)("emits %s and writes a delivery row", async (event) => {
    const seen: Delivery[] = [];
    a.webhooks.subscribe((d) => void seen.push(d));
    const d = await a.webhooks.emit(await inputFor(event));
    expect(d.event).toMatchObject({ entity: "event", event });
    expect(d.event.contains.length).toBeGreaterThan(0);
    const row = a.db.$client.prepare("select * from webhook_deliveries where event_id = ?").get(d.event.id) as { event: string };
    expect(row.event).toBe(event);
    expect(seen.at(-1)?.event.id).toBe(d.event.id);
  });

  it("records the 200-but-dropped plugin failure on Leafy Bakes", async () => {
    const d = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" });
    expect(d.deliveryRow).toMatchObject({ http_status: 200, processed: false, cron_note: DROPPED_NOTE, plugin: "razorpay-woocommerce", plugin_version: "4.8.2", payment_id: "pay_LB1234PRIYA" });
    expect((await a.store.getOrder(LEAFY, { number: "#1234" }))?.status).toBe("pending");
  });

  it("updates the order when the plugin is healthy", async () => {
    a.store.setFailure(LEAFY, "none");
    const d = await a.webhooks.emit({ merchantId: LEAFY, event: "order.paid", paymentId: "pay_LB1234PRIYA" });
    expect(d.deliveryRow.processed).toBe(true);
    expect(d.event.contains).toEqual(["payment", "order"]);
    expect((await a.store.getOrder(LEAFY, { number: "#1234" }))?.status).toBe("processing");
  });

  it("records site down and webhook disabled", async () => {
    a.store.setFailure(LEAFY, "site_down");
    expect((await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" })).deliveryRow.http_status).toBe(503);
    a.store.setFailure(LEAFY, "webhook_disabled");
    expect((await a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured", paymentId: "pay_LB1234PRIYA" })).deliveryRow.http_status).toBeNull();
  });

  it("applies subscription, token, link and downtime state changes", async () => {
    await a.webhooks.emit({ merchantId: "m_fitloop", event: "subscription.halted", subscriptionId: "sub_FL_karan" });
    expect(await a.razorpay("m_fitloop").fetchSubscription("sub_FL_karan")).toMatchObject({ status: "halted", retries_left: 0 });
    await a.webhooks.emit({ merchantId: "m_fitloop", event: "token.cancelled", tokenId: "token_FL_karan" });
    expect(a.db.$client.prepare("select status from mandates where token_id = 'token_FL_karan'").get()).toEqual({ status: "cancelled" });
    const started = await a.webhooks.emit({ merchantId: LEAFY, event: "payment.downtime.started", downtime: { method: "upi", bank: "HDFC" } });
    const id = started.event.payload["payment.downtime"].entity.id as string;
    a.clock.advance(20 * 60_000);
    await a.webhooks.emit({ merchantId: LEAFY, event: "payment.downtime.resolved", downtime: { method: "upi", id } });
    expect(a.db.$client.prepare("select end - start as mins from downtimes where id = ?").get(id)).toEqual({ mins: 20 * 60_000 });
  });

  it("refuses a record from another merchant or a missing reference", async () => {
    await expect(a.webhooks.emit({ merchantId: "m_notenest", event: "payment.captured", paymentId: "pay_LB1234PRIYA" })).rejects.toBeInstanceOf(WebhookError);
    await expect(a.webhooks.emit({ merchantId: LEAFY, event: "payment.captured" })).rejects.toBeInstanceOf(WebhookError);
    await expect(a.webhooks.emit({ merchantId: LEAFY, event: "payment.nope" as never, paymentId: "x" })).rejects.toThrow();
  });
});

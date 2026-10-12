import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seededAdapters } from "../test-helpers";
import { AUTO_CANCEL_NOTE, DROPPED_NOTE, StoreError, type StoreSim } from ".";

const LEAFY = "m_leafy_bakes";
const env = (event: string, payment_id: string, order_id: string | null = null) => ({ id: "evt_t", event, payment_id, order_id });

describe("StoreConnector contract: simulated WooCommerce", () => {
  let a: ReturnType<typeof seededAdapters>;
  let store: StoreSim;
  beforeEach(() => {
    a = seededAdapters();
    store = a.store;
    store.setFailure(LEAFY, "none");
  });
  afterEach(() => a.db.$client.close());

  it("gets an order by id, number, receipt and payment id", async () => {
    expect((await store.getOrder(LEAFY, { number: "#1234" }))?.id).toBe("so_leafy_1234");
    expect((await store.getOrder(LEAFY, { number: "1234" }))?.status).toBe("pending");
    expect((await store.getOrder(LEAFY, { receipt: "wc_1234" }))?.id).toBe("so_leafy_1234");
    expect((await store.getOrder(LEAFY, { paymentId: "pay_LB1235RAHUL1" }))?.number).toBe("#1235");
    expect(await store.getOrder(LEAFY, { id: "so_missing" })).toBeNull();
    // Another merchant's order is invisible.
    expect(await store.getOrder("m_crumb_co", { number: "#1234" })).toBeNull();
  });

  it("reads settings with plugin and version", async () => {
    const s = await store.getSettings(LEAFY);
    expect(s).toMatchObject({ platform: "woocommerce", plugin: "razorpay-woocommerce", plugin_version: "4.8.2", webhook_enabled: true, webhook_secret_matches: true });
    await expect(store.getSettings("m_notenest")).rejects.toBeInstanceOf(StoreError);
  });

  it("marks a pending order paid, once", async () => {
    const o = await store.markPaid(LEAFY, "so_leafy_1234", "pay_LB1234PRIYA");
    expect(o.status).toBe("processing");
    expect(o.payment_id).toBe("pay_LB1234PRIYA");
    expect(o.status_history.at(-1)?.status).toBe("processing");
    expect((await store.markPaid(LEAFY, "so_leafy_1234", "pay_LB1234PRIYA")).status_history).toHaveLength(o.status_history.length);
    await expect(store.markPaid(LEAFY, "so_leafy_1234", "pay_other")).rejects.toThrow(/already processing/);
  });

  it("restores an auto-cancelled order and takes stock back", async () => {
    await expect(store.restoreCancelled(LEAFY, "so_leafy_1234")).rejects.toThrow(/not auto-cancelled/);
    a.clock.advance(60 * 60_000);
    const cancelled = store.runCron(LEAFY);
    expect(cancelled.map((o) => o.id)).toEqual(["so_leafy_1234"]);
    expect(cancelled[0].status_history.at(-1)?.note).toBe(AUTO_CANCEL_NOTE);
    expect(store.stock(LEAFY, "Chocolate box")).toBe(13);
    await expect(store.markPaid(LEAFY, "so_leafy_1234", "pay_LB1234PRIYA")).rejects.toThrow(/Restore it first/);
    const restored = await store.restoreCancelled(LEAFY, "so_leafy_1234");
    expect(restored.status).toBe("pending");
    expect(store.stock(LEAFY, "Chocolate box")).toBe(12);
    expect((await store.markPaid(LEAFY, restored.id, "pay_LB1234PRIYA")).status).toBe("processing");
  });

  it("creates an order tagged with the payment id, once per payment", async () => {
    const o = await store.createOrderForPayment(LEAFY, { paymentId: "pay_new_1", expectedTotal: 2 * 129_900, customerId: "cus_priya", items: [{ name: "Chocolate box", qty: 2 }] });
    expect(o).toMatchObject({ status: "processing", payment_id: "pay_new_1", total: 2 * 129_900, number: "#1236" });
    expect(store.stock(LEAFY, "Chocolate box")).toBe(10);
    expect((await store.createOrderForPayment(LEAFY, { paymentId: "pay_new_1", expectedTotal: 2 * 129_900, items: [{ name: "Chocolate box", qty: 2 }] })).id).toBe(o.id);
    expect(store.stock(LEAFY, "Chocolate box")).toBe(10);
    await expect(store.createOrderForPayment(LEAFY, { paymentId: "pay_new_2", expectedTotal: 99 * 129_900, items: [{ name: "Chocolate box", qty: 99 }] })).rejects.toThrow(/Not enough stock/);
    await expect(store.createOrderForPayment(LEAFY, { paymentId: "pay_new_3", expectedTotal: 100, items: [{ name: "Caviar", qty: 1 }] })).rejects.toThrow(/Unknown product/);
  });

  it("refuses an order whose line items don't add up to the payment, and keeps stock", async () => {
    const err = await store
      .createOrderForPayment(LEAFY, { paymentId: "pay_new_4", expectedTotal: 129_900, items: [{ name: "Chocolate box", qty: 2 }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).mismatch).toEqual({ expected_total: 129_900, line_items_total: 259_800 });
    expect(await store.getOrder(LEAFY, { paymentId: "pay_new_4" })).toBeNull();
    expect(store.stock(LEAFY, "Chocolate box")).toBe(12);
  });

  it("cancels an unshipped order but never a shipped one", async () => {
    const o = await store.cancelUnshipped(LEAFY, "so_leafy_1235", "Duplicate order");
    expect(o.status).toBe("cancelled");
    expect(store.stock(LEAFY, "Banana bread loaf")).toBe(8);
    await expect(store.cancelUnshipped(LEAFY, "so_leafy_1198", "x")).rejects.toThrow(/shipped/);
  });

  it("processes payment webhooks when healthy", async () => {
    const r = await store.receiveWebhook(LEAFY, env("payment.captured", "pay_LB1234PRIYA", "order_LB1234"));
    expect(r).toEqual({ http_status: 200, response_body: "OK", processed: true, cron_note: null });
    expect((await store.getOrder(LEAFY, { number: "#1234" }))?.status).toBe("processing");
  });

  describe("plugin failures", () => {
    it("200-but-dropped: answers 200, cron marks done, order stays pending", async () => {
      store.setFailure(LEAFY, "dropped_200");
      const r = await store.receiveWebhook(LEAFY, env("payment.captured", "pay_LB1234PRIYA", "order_LB1234"));
      expect(r).toEqual({ http_status: 200, response_body: "OK", processed: false, cron_note: DROPPED_NOTE });
      expect((await store.getOrder(LEAFY, { number: "#1234" }))?.status).toBe("pending");
    });

    it("site down: 5xx on webhooks and every call", async () => {
      store.setFailure(LEAFY, "site_down");
      const r = await store.receiveWebhook(LEAFY, env("payment.captured", "pay_LB1234PRIYA"));
      expect(r.http_status).toBe(503);
      expect(r.processed).toBe(false);
      await expect(store.getOrder(LEAFY, { number: "#1234" })).rejects.toMatchObject({ httpStatus: 503 });
      await expect(store.markPaid(LEAFY, "so_leafy_1234", "pay_LB1234PRIYA")).rejects.toMatchObject({ httpStatus: 503 });
    });

    it("webhook disabled: nothing sent, settings show it off", async () => {
      store.setFailure(LEAFY, "webhook_disabled");
      const r = await store.receiveWebhook(LEAFY, env("payment.captured", "pay_LB1234PRIYA"));
      expect(r.http_status).toBeNull();
      expect(r.processed).toBe(false);
      expect((await store.getSettings(LEAFY)).webhook_enabled).toBe(false);
    });

    it("settings wrong: webhook rejected, settings show the secret mismatch", async () => {
      store.setFailure(LEAFY, "wrong_settings");
      const r = await store.receiveWebhook(LEAFY, env("payment.captured", "pay_LB1234PRIYA"));
      expect(r.http_status).toBe(401);
      expect((await store.getSettings(LEAFY)).webhook_secret_matches).toBe(false);
      expect((await store.getOrder(LEAFY, { number: "#1234" }))?.status).toBe("pending");
    });
  });

  it("starts Leafy Bakes on the 200-but-dropped plugin, like the seeded deliveries", () => {
    const fresh = seededAdapters();
    expect(fresh.store.failure(LEAFY)).toBe("dropped_200");
    fresh.db.$client.close();
  });
});

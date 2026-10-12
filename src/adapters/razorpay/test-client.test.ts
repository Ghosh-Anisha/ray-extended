import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRazorpay, loadRazorpayConfig } from ".";
import { createTestClient, RAZORPAY_API } from "./test-client";
import { RazorpayError } from "./types";

// Obviously fake values; real keys never go in fixtures.
const KEY_ID = "rzp_test_FAKEKEY0000001";
const SECRET = "fake_secret_never_real_001";
const sec = (ms: number) => Math.floor(ms / 1000);

type Call = { url: string; init: RequestInit };

function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.replace(RAZORPAY_API, "")}`;
    const handler = routes[key];
    const [status, json] = handler ? handler(init.body ? JSON.parse(String(init.body)) : undefined) : [404, { error: { description: "no route" } }];
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const payment = { id: "pay_T1", order_id: null, status: "captured", amount: 129_900, currency: "INR", amount_refunded: 0, created_at: sec(Date.UTC(2026, 9, 12)) };

describe("Razorpay test-mode client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses to start with a live key or no key", () => {
    expect(() => createTestClient({ keyId: "rzp_live_ABC", keySecret: SECRET })).toThrow(/test key/);
    expect(() => createTestClient({ keyId: "", keySecret: SECRET })).toThrow(/test key/);
    expect(() => loadRazorpayConfig({ RAZORPAY_MODE: "test", RAZORPAY_KEY_ID: "rzp_live_ABC", RAZORPAY_KEY_SECRET: SECRET })).toThrow(/test key/);
    // A live key in the environment stops startup even in mock mode.
    expect(() => loadRazorpayConfig({ RAZORPAY_MODE: "mock", RAZORPAY_KEY_ID: "rzp_live_ABC" })).toThrow(/test key/);
    expect(() => loadRazorpayConfig({ RAZORPAY_MODE: "test", RAZORPAY_KEY_ID: KEY_ID })).toThrow(/SECRET/);
    expect(loadRazorpayConfig({}).mode).toBe("mock");
  });

  it("never puts the key in errors, logs or the serialised client", async () => {
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const config = loadRazorpayConfig({ RAZORPAY_MODE: "test", RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: SECRET });
    const { impl } = fakeFetch({ "GET /payments/pay_X?expand[]=card": () => [401, { error: { description: "Authentication failed" } }] });
    const client = createTestClient({ keyId: KEY_ID, keySecret: SECRET }, impl);
    const thrown = await client.fetchPayment("pay_X").catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(RazorpayError);
    expect((thrown as RazorpayError).code).toBe("AUTH");
    const seen = [
      String(thrown),
      JSON.stringify(thrown),
      (thrown as Error).stack ?? "",
      JSON.stringify(client),
      inspect(client, { depth: 5 }),
      JSON.stringify(config),
      inspect(config, { depth: 5 }),
      JSON.stringify([...log.mock.calls, ...err.mock.calls]),
    ].join("\n");
    expect(seen).not.toContain(SECRET);
    expect(seen).not.toContain(KEY_ID);
  });

  it("uses basic auth against the public REST API", async () => {
    const { impl, calls } = fakeFetch({
      "POST /orders": (b) => [200, { id: "order_T1", status: "created", created_at: 1, ...(b as object) }],
    });
    const client = createTestClient({ keyId: KEY_ID, keySecret: SECRET }, impl);
    const order = await client.createOrder({ amount: 129_900, receipt: "wc_1234" });
    expect(order).toMatchObject({ id: "order_T1", amount: 129_900, currency: "INR", receipt: "wc_1234", created_at: 1000 });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Basic " + Buffer.from(`${KEY_ID}:${SECRET}`).toString("base64"));
    expect(calls[0].url).toBe(`${RAZORPAY_API}/orders`);
  });

  it("maps Razorpay's unknown id answer to NOT_FOUND", async () => {
    const { impl } = fakeFetch({
      "GET /payments/pay_Nope?expand[]=card": () => [400, { error: { description: "The id provided does not exist" } }],
    });
    const client = createTestClient({ keyId: KEY_ID, keySecret: SECRET }, impl);
    await expect(client.fetchPayment("pay_Nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("checks existing refunds before posting one: same receipt returns it, a second refund is refused", async () => {
    const refunds: unknown[] = [];
    const { impl, calls } = fakeFetch({
      "GET /payments/pay_T1?expand[]=card": () => [200, payment],
      "GET /payments/pay_T1/refunds": () => [200, { items: refunds }],
      "POST /payments/pay_T1/refund": (b) => {
        const body = b as { amount: number; receipt: string };
        const r = { id: "rfnd_T1", payment_id: "pay_T1", status: "processed", currency: "INR", created_at: 2, ...body };
        refunds.push(r);
        return [200, r];
      },
    });
    const client = createTestClient({ keyId: KEY_ID, keySecret: SECRET }, impl);
    await expect(client.refund("pay_T1", { amount: 200_000, receipt: "r_over" })).rejects.toMatchObject({ code: "OVER_REFUND" });
    const first = await client.refund("pay_T1", { amount: 129_900, receipt: "r1" });
    const again = await client.refund("pay_T1", { amount: 129_900, receipt: "r1" });
    expect(again.id).toBe(first.id);
    await expect(client.refund("pay_T1", { amount: 100, receipt: "r2" })).rejects.toMatchObject({ code: "ALREADY_REFUNDED" });
    expect(calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });

  it("sends contest documents as Razorpay evidence fields", async () => {
    const { impl, calls } = fakeFetch({
      "PATCH /disputes/disp_T1/contest": () => [
        200,
        { id: "disp_T1", payment_id: "pay_T1", status: "open", amount: 690_000, currency: "INR", respond_by: 10, created_at: 1, evidence: { amount: 690_000, summary: "Delivered", shipping_proof: ["doc_1"], billing_proof: null } },
      ],
    });
    const client = createTestClient({ keyId: KEY_ID, keySecret: SECRET }, impl);
    const d = await client.contestDispute("disp_T1", { action: "draft", amount: 690_000, summary: "Delivered", documents: { shipping_proof: ["doc_1"] } });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: "draft", amount: 690_000, summary: "Delivered", shipping_proof: ["doc_1"] });
    expect(d.evidence?.documents).toEqual({ shipping_proof: ["doc_1"] });
  });

  it("is picked by createRazorpay in test mode", () => {
    const config = loadRazorpayConfig({ RAZORPAY_MODE: "test", RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: SECRET });
    expect(createRazorpay(config, undefined as never, undefined as never, "m_x").mode).toBe("test");
  });
});

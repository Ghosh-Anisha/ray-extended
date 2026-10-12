import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seededAdapters } from "../test-helpers";
import { MessagingError, WINDOW_MS, type MessagingSim } from ".";

const LEAFY = "m_leafy_bakes";
const PRIYA = "+919800000101";
const PRIYA_EMAIL = "priya.sharma@example.com";
const HOUR = 3_600_000;

const code = (c: MessagingError["code"]) => (e: unknown) => e instanceof MessagingError && e.code === c;

const check = {
  templateId: "payment_received_check",
  params: { name: "Priya", merchant: "Leafy Bakes", amount: "₹1,299", time: "9:22 AM", date: "12 Oct", order: "#1234", utr_last4: "0021" },
};

describe("Messaging contract: simulated WhatsApp and email", () => {
  let a: ReturnType<typeof seededAdapters>;
  let msg: MessagingSim;
  beforeEach(() => {
    a = seededAdapters();
    msg = a.messaging;
  });
  afterEach(() => a.db.$client.close());

  it("sends email in every sender mode", async () => {
    for (const mode of ["merchant_inbox", "verified_domain", "via_razorpay"] as const) {
      const m = await msg.send({ merchantId: LEAFY, channel: "email", to: PRIYA_EMAIL, senderMode: mode, body: "Hello" });
      expect(m).toMatchObject({ direction: "out", sender_mode: mode, to: PRIYA_EMAIL, within_24h: null });
      expect(m.from).toBe(msg.senderAddress(LEAFY, "email", mode));
    }
    expect(msg.senderLabel(msg.senderAddress(LEAFY, "email", "via_razorpay"))).toBe("Leafy Bakes via Razorpay");
    expect(msg.inbox(PRIYA_EMAIL)).toHaveLength(3);
  });

  it("has no verified-domain sender on WhatsApp", async () => {
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "verified_domain", ...check })).rejects.toSatisfy(code("BAD_SENDER_MODE"));
  });

  it("outside the 24-hour window allows only an approved template", async () => {
    expect(msg.window(LEAFY, PRIYA).open).toBe(false);
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", body: "Hi Priya" })).rejects.toSatisfy(code("WINDOW_CLOSED"));
    await expect(
      msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", templateId: "festive_offer", params: { name: "Priya", merchant: "Leafy Bakes" } }),
    ).rejects.toSatisfy(code("TEMPLATE_NOT_APPROVED"));
    await expect(
      msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", templateId: "payment_received_check", params: { name: "Priya" } }),
    ).rejects.toSatisfy(code("TEMPLATE_PARAMS"));
    const m = await msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", ...check });
    expect(m.body).toBe("Hi Priya, this is Leafy Bakes. We got your payment of ₹1,299 at 9:22 AM on 12 Oct for order #1234, UTR ending 0021. You can check this in your UPI app. Reply YES and we will confirm your order.");
    expect(m).toMatchObject({ template_id: "payment_received_check", within_24h: false });
  });

  it("outside the window sends templates only to customers who opted in", async () => {
    expect(msg.consent("cus_priya", "whatsapp")).toBe("opted_in");
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: "+919899999999", senderMode: "merchant_inbox", ...check })).rejects.toSatisfy(code("NOT_OPTED_IN"));
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", ...check })).resolves.toBeTruthy();
  });

  it("blocks a proactive WhatsApp to the seeded opted-out and no-consent customers", async () => {
    const KAVYA = "+919800000107";
    const IMRAN = "+919800000108";
    expect(msg.consent("cus_kavya", "whatsapp")).toBe("opted_out");
    expect(msg.consent("cus_imran", "whatsapp")).toBeNull();
    for (const mode of ["merchant_inbox", "via_razorpay"] as const) {
      await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: KAVYA, senderMode: mode, ...check })).rejects.toSatisfy(code("OPTED_OUT"));
      await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: IMRAN, senderMode: mode, ...check })).rejects.toSatisfy(code("NOT_OPTED_IN"));
    }
    expect(msg.thread(LEAFY, KAVYA)).toEqual([]);
    expect(msg.thread(LEAFY, IMRAN)).toEqual([]);
    // Imran opting in at checkout unblocks him.
    msg.setConsent("cus_imran", "whatsapp", "opted_in", "checkout");
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: IMRAN, senderMode: "merchant_inbox", ...check })).resolves.toBeTruthy();
  });

  it("an opt-out blocks every proactive message on that channel, but not replies", async () => {
    msg.setConsent("cus_priya", "whatsapp", "opted_out", "customer replied STOP");
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "via_razorpay", ...check })).rejects.toSatisfy(code("OPTED_OUT"));
    // Email is a separate channel.
    await expect(msg.send({ merchantId: LEAFY, channel: "email", to: PRIYA_EMAIL, senderMode: "merchant_inbox", body: "Hello" })).resolves.toBeTruthy();
    msg.setConsent("cus_priya", "email", "opted_out", "unsubscribe link");
    await expect(msg.send({ merchantId: LEAFY, channel: "email", to: PRIYA_EMAIL, senderMode: "verified_domain", body: "Hello" })).rejects.toSatisfy(code("OPTED_OUT"));
    // When she writes in, answering her is not proactive.
    await msg.receive({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "Where is my order?" });
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", body: "Checking now" })).resolves.toBeTruthy();
    a.clock.advance(WINDOW_MS);
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", ...check })).rejects.toSatisfy(code("OPTED_OUT"));
  });

  it("a customer message opens the window for 24 hours, then it closes", async () => {
    await msg.receive({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "I paid but no order?" });
    expect(msg.window(LEAFY, PRIYA).open).toBe(true);
    const m = await msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", body: "Checking now" });
    expect(m.within_24h).toBe(true);
    a.clock.advance(WINDOW_MS - HOUR);
    expect(msg.window(LEAFY, PRIYA).open).toBe(true);
    a.clock.advance(HOUR);
    expect(msg.window(LEAFY, PRIYA).open).toBe(false);
    await expect(msg.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", body: "Any update?" })).rejects.toSatisfy(code("WINDOW_CLOSED"));
  });

  it("a message to another merchant does not open this merchant's window", async () => {
    await msg.receive({ merchantId: "m_fitloop", channel: "whatsapp", from: PRIYA, body: "Hi" });
    expect(msg.window(LEAFY, PRIYA).open).toBe(false);
  });

  it("refuses WhatsApp for a merchant who has it turned off", async () => {
    await expect(
      msg.send({ merchantId: "m_stackly", channel: "whatsapp", to: "+919800000202", senderMode: "merchant_inbox", templateId: "order_update", params: { name: "A", order: "1", merchant: "Stackly", status: "paid" } }),
    ).rejects.toSatisfy(code("WHATSAPP_OFF"));
  });

  it("routes replies to a 'via Razorpay' message back to the merchant's case", async () => {
    const out = await msg.send({ merchantId: LEAFY, caseId: null, channel: "whatsapp", to: PRIYA, senderMode: "via_razorpay", ...check });
    const reply = await msg.receive({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, body: "YES" });
    expect(reply.to).toBe(out.from);
    expect(reply.direction).toBe("in");
    expect(msg.thread(LEAFY, PRIYA).map((m) => m.body)).toEqual([out.body, "YES"]);
    expect(msg.inbox(PRIYA)).toHaveLength(2);
    await expect(msg.receive({ merchantId: LEAFY, channel: "whatsapp", from: PRIYA, to: "wa:someone-else", body: "x" })).rejects.toSatisfy(code("UNKNOWN_ADDRESS"));
  });

  it("needs a body or a template, not both", async () => {
    await expect(msg.send({ merchantId: LEAFY, channel: "email", to: PRIYA_EMAIL, senderMode: "merchant_inbox" })).rejects.toThrow();
    await expect(msg.send({ merchantId: LEAFY, channel: "email", to: PRIYA_EMAIL, senderMode: "merchant_inbox", body: "x", templateId: "order_update" })).rejects.toThrow();
  });
});

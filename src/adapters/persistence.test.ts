// Simulated state that must survive a server restart: store failure mode,
// product stock, messaging consents and dispute drafts. Uses a real database
// file, closed and reopened between the two halves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMigratedDb } from "@/db/client";
import { createRepository } from "@/db/repository";
import { SEED_NOW, seed } from "@/db/seed";
import { createAdapters } from ".";
import { fakeClock } from "./clock";
import { MessagingError } from "./messaging";

const LEAFY = "m_leafy_bakes";
const PRIYA = "+919800000101";
const check = {
  templateId: "payment_received_check",
  params: { name: "Priya", merchant: "Leafy Bakes", amount: "₹1,299", date: "12 Oct", order: "#1234" },
};

describe("simulated state survives a restart", () => {
  let dir: string;
  let file: string;
  const boot = () => createAdapters(openMigratedDb(file), fakeClock(SEED_NOW), { RAZORPAY_MODE: "mock" });
  const openChargebackCase = (a: ReturnType<typeof boot>) =>
    createRepository(a.db).cases.insert({
      id: "case_cb_meera", merchant_id: LEAFY, moment: "chargeback", state: "waiting_merchant", confidence: "sure",
      payment_id: "pay_LB1198MEERA", amount: 690_000, opened_at: SEED_NOW,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ray-restart-"));
    file = path.join(dir, "ray.db");
    const db = openMigratedDb(file);
    seed(db);
    db.$client.close();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("starts from the seed: Leafy Bakes on dropped_200 with 12 Chocolate boxes", async () => {
    const a = boot();
    expect(a.store.failure(LEAFY)).toBe("dropped_200");
    expect(a.store.stock(LEAFY, "Chocolate box")).toBe(12);
    expect((await a.store.getOrder(LEAFY, { number: "#1234" }))?.items[0].stock).toBe(12);
    a.db.$client.close();
  });

  it("keeps the store failure mode", async () => {
    const a = boot();
    a.store.setFailure(LEAFY, "wrong_settings");
    a.db.$client.close();

    const b = boot();
    expect(b.store.failure(LEAFY)).toBe("wrong_settings");
    expect((await b.store.getSettings(LEAFY)).webhook_secret_matches).toBe(false);
    b.store.setFailure(LEAFY, "site_down");
    b.db.$client.close();

    const c = boot();
    await expect(c.store.getOrder(LEAFY, { number: "#1234" })).rejects.toMatchObject({ httpStatus: 503 });
    c.db.$client.close();
  });

  it("keeps product stock, and orders read stock from products", async () => {
    const a = boot();
    await a.store.setFailure(LEAFY, "none");
    await a.store.createOrderForPayment(LEAFY, { paymentId: "pay_restart_1", items: [{ name: "Chocolate box", qty: 2 }] });
    a.db.$client.close();

    const b = boot();
    expect(b.store.stock(LEAFY, "Chocolate box")).toBe(10);
    expect((await b.store.getOrder(LEAFY, { number: "#1234" }))?.items[0].stock).toBe(10);
    b.db.$client.close();
  });

  it("keeps WhatsApp consent, and an opt-out still blocks proactive messages", async () => {
    const a = boot();
    await expect(a.messaging.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", ...check })).resolves.toBeTruthy();
    a.messaging.setConsent("cus_priya", "whatsapp", "opted_out", "customer replied STOP");
    a.db.$client.close();

    const b = boot();
    expect(b.messaging.consent("cus_priya", "whatsapp")).toBe("opted_out");
    await expect(b.messaging.send({ merchantId: LEAFY, channel: "whatsapp", to: PRIYA, senderMode: "merchant_inbox", ...check })).rejects.toSatisfy(
      (e: unknown) => e instanceof MessagingError && e.code === "OPTED_OUT",
    );
    b.db.$client.close();
  });

  it("keeps dispute drafts, and logs every draft change to the case", async () => {
    const a = boot();
    openChargebackCase(a);
    await a.razorpay(LEAFY).contestDispute("disp_LB_meera", { action: "draft", amount: 690_000, summary: "Delivered by courier" });
    a.db.$client.close();

    const b = boot();
    const repo = createRepository(b.db);
    expect(repo.disputes.get("disp_LB_meera")).toMatchObject({ draft_status: "draft", status: "open" });
    const d = await b.razorpay(LEAFY).fetchDispute("disp_LB_meera");
    expect(d.evidence).toMatchObject({ amount: 690_000, summary: "Delivered by courier" });

    b.clock.advance(60_000);
    await b.razorpay(LEAFY).contestDispute("disp_LB_meera", { action: "draft", documents: { shipping_proof: ["doc_pod_1"] } });
    b.clock.advance(60_000);
    // Same draft again: nothing changed, nothing logged.
    await b.razorpay(LEAFY).contestDispute("disp_LB_meera", { action: "draft", documents: { shipping_proof: ["doc_pod_1"] } });
    b.clock.advance(60_000);
    await b.razorpay(LEAFY).contestDispute("disp_LB_meera", { action: "submit" });
    expect(repo.disputes.get("disp_LB_meera")).toMatchObject({ draft_status: "submitted", status: "under_review" });

    const events = repo.caseEvents.listByCase("case_cb_meera");
    expect(events.map((e) => e.payload.kind)).toEqual(["dispute_draft_created", "dispute_draft_changed", "dispute_draft_submitted"]);
    expect(events.every((e) => e.evidence_ref === "disp_LB_meera")).toBe(true);
    b.db.$client.close();
  });

  it("refuses a dispute draft when there is no open case to log it to", async () => {
    const a = boot();
    await expect(a.razorpay(LEAFY).contestDispute("disp_LB_deepa", { action: "draft", summary: "x" })).rejects.toThrow(/No open case/);
    expect(createRepository(a.db).disputes.get("disp_LB_deepa")?.draft_json).toBeNull();
    a.db.$client.close();
  });
});

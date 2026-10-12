// The error_reason lookup table and the checkout copy (code, no model), the
// buyer-type rules, and this flow's seed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seededAdapters } from "@/adapters/test-helpers";
import { bannedWordsIn, hasEmDash } from "@/ai/grounding";
import { buyerType } from "./buyer-type";
import { CAUSES, checkoutMessage, KNOWN_ROWS, lookup, type Cause } from "./errors";
import { recoveryEmail, replyEmail } from "./messages";
import { createInternationalSim, toInr } from "./sim";

describe("the error_reason lookup table", () => {
  it.each([
    ["international_transaction_not_allowed", "issuer_bank", "card_not_international", "A"],
    ["card_not_enabled_for_online_payments", "issuer_bank", "card_not_online", "A"],
    ["authentication_failed", "customer", "three_ds_failed", "B"],
    ["authentication_timed_out", "customer", "three_ds_timed_out", "B"],
    ["payment_declined", "issuer_bank", "bank_declined", "C"],
    ["suspected_fraud", "issuer_bank", "bank_declined_fraud", "C"],
    ["amount_exceeds_maximum_amount_allowed", "business", "above_limit", "D"],
    ["currency_not_supported", "business", "currency_off", "D"],
    ["card_network_not_enabled", "business", "network_off", "D"],
    ["billing_address_required", "business", "billing_missing", "D"],
    ["international_transaction_not_allowed", "business", "international_off", "D"],
    ["payment_risk_check_failed", "internal", "risk_hold", "E"],
  ])("%s from %s is %s (%s)", (reason, source, cause, situation) => {
    expect(lookup(reason, source)).toBe(cause);
    expect(CAUSES[cause as Cause].situation).toBe(situation);
  });

  it("knows nothing it wasn't told", () => {
    expect(lookup("something_new", "gateway")).toBeNull();
    expect(lookup(null, "issuer_bank")).toBeNull();
  });

  it("puts each situation on the side the guide says", () => {
    for (const c of Object.values(CAUSES)) {
      const want = { A: "customer_or_bank", B: "customer_or_bank", C: "customer_or_bank", D: "merchant", E: "razorpay", F: "customer_or_bank" }[c.situation];
      expect(c.side).toBe(want);
    }
    expect(KNOWN_ROWS.every((r) => r.cause in CAUSES)).toBe(true);
  });
});

describe("the checkout failure message", () => {
  const all = Object.keys(CAUSES) as Cause[];

  it("follows the design language: no banned words, no em dash", () => {
    for (const c of all) for (const paypal of [true, false]) {
      const m = checkoutMessage(c, { paypal });
      if (!m) continue;
      expect(bannedWordsIn(m), c).toEqual([]);
      expect(hasEmDash(m), c).toBe(false);
    }
  });

  it("says what the table says for each situation", () => {
    expect(checkoutMessage("card_not_international", { paypal: true })).toMatch(/Turn it on in your bank app and try again, or use another card\.$/);
    expect(checkoutMessage("three_ds_failed", { paypal: true })).toMatch(/Try again, or pay with PayPal\.$/);
    expect(checkoutMessage("above_limit", { paypal: true })).toBe("This payment can't go through here. The seller will send you another way to pay.");
    expect(checkoutMessage("risk_hold", { paypal: true })).toBe("We couldn't complete this payment. The seller has been told.");
    expect(checkoutMessage("left_checkout", { paypal: true })).toBeNull();
  });

  it("offers PayPal only when the checkout has it", () => {
    expect(checkoutMessage("three_ds_failed", { paypal: false })).not.toMatch(/PayPal/);
    expect(checkoutMessage("bank_declined", { paypal: false })).toBe("Your bank declined this card. Please use another card.");
  });

  it("a bank decline, fraud or not, never suggests the same card", () => {
    for (const c of ["bank_declined", "bank_declined_fraud"] as const) for (const paypal of [true, false]) {
      expect(checkoutMessage(c, { paypal })).not.toMatch(/try again|retry|same card/i);
    }
    const f = { merchant: "NoteNest", buyer_first_name: "Emma", amount: "$49", for: "order x", card: "card ending 4242", link: "https://pay.sim.example/l/abc", paypal: true, bank_details: null, reference: null, sign_off: "Team NoteNest" };
    for (const c of ["bank_declined", "bank_declined_fraud"] as const) expect(recoveryEmail(c, f)).not.toMatch(/try again|retry|same card|card ending/i);
  });

  it("every fallback email carries the merchant, the amount and what it's for next to the link", () => {
    const f = { merchant: "NoteNest", buyer_first_name: "Emma", amount: "$49", for: "order nn_1", card: "card ending 4242", link: "https://pay.sim.example/l/abc", paypal: false, bank_details: null, reference: null, sign_off: "Team NoteNest" };
    for (const c of all.filter((x) => CAUSES[x].situation !== "E")) {
      const body = recoveryEmail(c, f);
      for (const want of ["NoteNest", "$49", "order nn_1"]) expect(body, c).toContain(want);
      expect(bannedWordsIn(body)).toEqual([]);
      expect(hasEmDash(body)).toBe(false);
    }
    expect(replyEmail(f)).toContain("$49");
  });
});

describe("buyer type", () => {
  it("Emma (checkout, $49, B2C app) buys for herself", () => {
    expect(buyerType({ reference: "nn_pro_annual_881", viaLink: false, amountInr: 410_000, email: "emma.clarke@example.com", merchantBusinessType: "saas_b2c", playbook: null }).type).toBe("b2c");
  });

  it("Oliver (invoice, ₹3.1 lakh, company domain, B2B agency) is a business", () => {
    const r = buyerType({ reference: "pf_inv_2041", viaLink: false, amountInr: 31_000_000, email: "oliver@example.co.uk", merchantBusinessType: "agency_b2b", playbook: null });
    expect(r.type).toBe("b2b");
    expect(r.reasons[0]).toBe("It was an invoice payment.");
  });

  it("a personal email domain and a role mailbox count as they should", () => {
    expect(buyerType({ reference: null, viaLink: false, amountInr: null, email: "sam@gmail.com", merchantBusinessType: "x", playbook: null }).type).toBe("b2c");
    expect(buyerType({ reference: null, viaLink: false, amountInr: null, email: "accounts@acme.example", merchantBusinessType: "x", playbook: null }).reasons).toContain("They wrote from a company accounts mailbox.");
  });

  it("a tie stays open (no model guess), and the playbook breaks it", () => {
    const tie = { reference: "q_1", viaLink: false, amountInr: 50_000 * 100, email: "sam@studio.example", merchantBusinessType: "x", playbook: null };
    expect(buyerType(tie).type).toBeNull();
    expect(buyerType({ ...tie, playbook: "b2b" }).type).toBe("b2b");
  });
});

describe("seed and simulated systems", () => {
  let a: ReturnType<typeof seededAdapters>;
  beforeEach(() => {
    a = seededAdapters();
  });
  afterEach(() => a.db.$client.close());

  it("seeds NoteNest and PixelForge as the guide's table says", () => {
    const sim = createInternationalSim(a.db, a.clock);
    expect(sim.settings("m_pixelforge")).toMatchObject({ limit_inr: 20_000_000, paypal_on: false, moneysaver_on: true });
    expect(sim.settings("m_notenest")).toMatchObject({ paypal_on: true, checkout: "standard" });
    expect(sim.account("m_pixelforge", "GBP")?.routing).toBe("20-45-77");
    expect(sim.account("m_notenest", "USD")).toBeNull();
    expect(sim.signals("pay_PF_oliver_failed")?.vulcan_result).toBe("clean");
    // £2,800 is above ₹2 lakh, as the seed says.
    expect(toInr(280_000, "GBP")).toBe(31_000_000);
    expect(toInr(4_900, "USD")).toBe(410_000);
  });

  it("PayPal only on Standard Checkout, only for non-INR", () => {
    const sim = createInternationalSim(a.db, a.clock);
    expect(sim.paypalAvailable("m_notenest", "USD")).toBe(true);
    expect(sim.paypalAvailable("m_notenest", "INR")).toBe(false);
    sim.updateSettings("m_notenest", { checkout: "custom" });
    expect(sim.paypalAvailable("m_notenest", "USD")).toBe(false);
  });
});

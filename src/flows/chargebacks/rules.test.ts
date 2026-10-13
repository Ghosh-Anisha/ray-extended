import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  breakEvenOdds,
  confidenceOf,
  deadlineOf,
  disputeType,
  nextStageFee,
  oddsOf,
  shouldContest,
  situationOf,
  stopWindowEnd,
  type PackFacts,
} from "./rules";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const rupees = (r: number) => r * 100;
// Monday 12 Oct 2026, 10:00 AM IST.
const MON = Date.parse("2026-10-12T10:00:00+05:30");

describe("the expected-value rule", () => {
  it("a ₹4,000 order at Visa arbitration needs over 92% odds", () => {
    const fee = nextStageFee("arbitration", "Visa");
    expect(fee).toBe(600 * 84 * 100);
    const needed = breakEvenOdds(rupees(4_000), fee);
    expect(needed).toBeGreaterThan(0.92);
    expect(needed).toBeLessThan(0.93);
    expect(shouldContest(0.92, rupees(4_000), fee)).toBe(false);
    expect(shouldContest(0.93, rupees(4_000), fee)).toBe(true);
  });

  it("stage 1 has no fee, so any real chance is worth contesting and none is not", () => {
    expect(nextStageFee("chargeback", "Visa")).toBe(0);
    expect(shouldContest(0.05, rupees(1_299), 0)).toBe(true);
    expect(shouldContest(0, rupees(1_299), 0)).toBe(false);
  });

  it("pre-arbitration uses the arbitration fee; Mastercard's is higher, unknown networks take the higher one", () => {
    expect(nextStageFee("pre_arbitration", "Visa")).toBe(nextStageFee("arbitration", "Visa"));
    expect(nextStageFee("arbitration", "Mastercard")).toBe(675 * 84 * 100);
    expect(nextStageFee("arbitration", "RuPay")).toBe(675 * 84 * 100);
    expect(nextStageFee("arbitration", null)).toBe(675 * 84 * 100);
    expect(breakEvenOdds(rupees(4_000), nextStageFee("arbitration", "Mastercard"))).toBeGreaterThan(breakEvenOdds(rupees(4_000), nextStageFee("arbitration", "Visa")));
  });
});

describe("types and situations", () => {
  it("reads network reason codes, then the reason text", () => {
    expect(disputeType({ reason_code: "13.1", reason: "x" })).toBe("not_received");
    expect(disputeType({ reason_code: "4834", reason: "x" })).toBe("duplicate");
    expect(disputeType({ reason_code: "10.4", reason: "x" })).toBe("fraud");
    expect(disputeType({ reason_code: "4853", reason: "x" })).toBe("not_as_described");
    expect(disputeType({ reason_code: "13.6", reason: "x" })).toBe("already_refunded");
    expect(disputeType({ reason_code: "RP01", reason: "Customer says they didn't make this payment" })).toBe("fraud");
    expect(disputeType({ reason_code: "RP02", reason: "Order cancelled but charged" })).toBe("cancelled");
    expect(disputeType({ reason_code: "RP03", reason: "Something else" })).toBe("other");
  });

  it("maps types to B, C and D, and any later stage to E", () => {
    expect(situationOf("fraud", "chargeback")).toBe("B");
    expect(situationOf("not_received", "chargeback")).toBe("C");
    expect(situationOf("not_as_described", "chargeback")).toBe("C");
    expect(situationOf("duplicate", "chargeback")).toBe("D");
    expect(situationOf("already_refunded", "chargeback")).toBe("D");
    expect(situationOf("duplicate", "pre_arbitration")).toBe("E");
    expect(situationOf("fraud", "arbitration")).toBe("E");
  });
});

describe("deadlines", () => {
  it("counts business days, skipping the weekend (IST)", () => {
    expect(new Date(addBusinessDays(MON, 3)).toISOString()).toBe(new Date(MON + 3 * DAY).toISOString()); // Thursday
    const fri = MON + 4 * DAY;
    expect(addBusinessDays(fri, 1)).toBe(fri + 3 * DAY); // Monday
    expect(addBusinessDays(fri, 3)).toBe(fri + 5 * DAY); // Wednesday
  });

  it("T+3 for a chargeback, T+2 pre-arbitration, T+1 arbitration, never later than Razorpay's respond-by", () => {
    const far = MON + 30 * DAY;
    expect(deadlineOf({ phase: "chargeback", respond_by: far }, MON)).toBe(MON + 3 * DAY);
    expect(deadlineOf({ phase: "pre_arbitration", respond_by: far }, MON)).toBe(MON + 2 * DAY);
    expect(deadlineOf({ phase: "arbitration", respond_by: far }, MON)).toBe(MON + DAY);
    expect(deadlineOf({ phase: "chargeback", respond_by: MON + DAY }, MON)).toBe(MON + DAY);
  });

  it("the Stop window is 2 hours, half the time left when the deadline is closer, none when too close", () => {
    expect(stopWindowEnd(MON, MON + 3 * DAY)).toBe(MON + 2 * HOUR);
    expect(stopWindowEnd(MON, MON + 2 * HOUR)).toBe(MON + HOUR);
    expect(stopWindowEnd(MON, MON + 15 * MIN)).toBeNull();
  });
});

describe("odds and confidence come from the records", () => {
  const base: PackFacts = {
    type: "not_received", shipped: true, deliveryConfirmed: false, neverShipped: false, orderCancelled: false, refunded: false,
    singleCharge: true, chats: 0, buyerProtectionClaim: false, priorOrders: 0, fraud: null,
  };

  it("never shipped is Sure at nil odds (accept); shipped alone is Likely", () => {
    expect(oddsOf({ ...base, shipped: false, neverShipped: true })).toBe(0);
    expect(confidenceOf({ ...base, shipped: false, neverShipped: true })).toBe("sure");
    expect(confidenceOf(base)).toBe("likely");
  });

  it("a delivery the customer confirmed, chats and a Buyer Protection claim make it stronger", () => {
    expect(oddsOf({ ...base, deliveryConfirmed: true })).toBeGreaterThan(oddsOf(base));
    expect(oddsOf({ ...base, buyerProtectionClaim: true })).toBeGreaterThan(oddsOf(base));
    expect(oddsOf({ ...base, chats: 2 })).toBeGreaterThan(oddsOf(base));
    expect(confidenceOf({ ...base, deliveryConfirmed: true })).toBe("sure");
  });

  it("a duplicate with one charge, or a refund on file, is Sure", () => {
    expect(confidenceOf({ ...base, type: "duplicate" })).toBe("sure");
    expect(oddsOf({ ...base, type: "duplicate", singleCharge: false })).toBeLessThan(0.5);
    expect(confidenceOf({ ...base, type: "already_refunded", refunded: true })).toBe("sure");
  });

  it("Vulcan's flag is read, never re-scored", () => {
    const flagged = { ...base, type: "fraud" as const, fraud: { vulcan: "flagged" as const, deviceSeenBefore: true, addressMatches: true, ipCountry: "IN" } };
    expect(oddsOf(flagged)).toBe(0.05);
    expect(confidenceOf(flagged)).toBe("sure");
    expect(oddsOf({ ...flagged, fraud: { ...flagged.fraud, vulcan: "clear" } })).toBeGreaterThan(0.5);
  });
});

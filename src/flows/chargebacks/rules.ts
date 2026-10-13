// The chargeback rules that are code, never a model: what type a dispute
// is, which situation that makes, the expected-value rule, the stage fees,
// the business-day deadlines and the odds an evidence pack gives.
import type { Dispute } from "@/adapters/razorpay";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- Types and situations

export const DISPUTE_TYPES = ["fraud", "not_received", "not_as_described", "cancelled", "duplicate", "already_refunded", "other"] as const;
export type DisputeType = (typeof DISPUTE_TYPES)[number];

// Merchant-facing names (no reason codes on screens).
export const TYPE_LABEL: Record<DisputeType, string> = {
  fraud: "fraud or unauthorised",
  not_received: "not received",
  not_as_described: "not as described",
  cancelled: "cancelled but charged",
  duplicate: "duplicate charge",
  already_refunded: "already refunded",
  other: "other",
};

// Network reason codes: Visa (10.x fraud, 12.6.1 duplicate, 13.x consumer
// disputes) and Mastercard. Anything else is read from the reason text.
const CODES: Record<string, DisputeType> = {
  "10.1": "fraud", "10.2": "fraud", "10.3": "fraud", "10.4": "fraud", "10.5": "fraud",
  "4837": "fraud", "4840": "fraud", "4863": "fraud", "4870": "fraud", "4871": "fraud",
  "13.1": "not_received", "4855": "not_received",
  "13.3": "not_as_described", "4853": "not_as_described",
  "13.2": "cancelled", "13.7": "cancelled", "4841": "cancelled",
  "12.6.1": "duplicate", "4834": "duplicate",
  "13.6": "already_refunded", "4860": "already_refunded",
};

export function disputeType(d: Pick<Dispute, "reason_code" | "reason">): DisputeType {
  const byCode = CODES[d.reason_code.trim()];
  if (byCode) return byCode;
  const r = d.reason.toLowerCase();
  if (/fraud|unauthori[sz]ed|not recogni[sz]ed|didn't make|did not make/.test(r)) return "fraud";
  if (/duplicate|charged twice|paid twice/.test(r)) return "duplicate";
  if (/refund/.test(r)) return "already_refunded";
  if (/not received|never arrived|didn't arrive|not delivered/.test(r)) return "not_received";
  if (/not as described|damaged|defective|quality|wrong item/.test(r)) return "not_as_described";
  if (/cancel/.test(r)) return "cancelled";
  return "other";
}

export type Situation = "A" | "B" | "C" | "D" | "E" | "F";

// Pre-arbitration and arbitration are E whatever the reason.
export function situationOf(type: DisputeType, phase: string): Situation {
  if (phase !== "chargeback") return "E";
  if (type === "fraud") return "B";
  if (type === "duplicate" || type === "already_refunded") return "D";
  return "C";
}

// ---- The expected-value rule

// Simulated rate for the network fees, which are in USD.
export const USD_INR = 84;
// Arbitration fees by network. Unknown networks use the higher one.
export const ARBITRATION_FEE_USD: Record<string, number> = { Visa: 600, Mastercard: 675 };
export const DEFAULT_ARBITRATION_FEE_USD = 675;

// The fee at the next stage, in paise. Stage 1 (chargeback) is nil; from
// pre-arbitration on, losing costs the network's arbitration fee.
export function nextStageFee(phase: string, network: string | null): number {
  if (phase === "chargeback") return 0;
  const usd = (network ? ARBITRATION_FEE_USD[network] : undefined) ?? DEFAULT_ARBITRATION_FEE_USD;
  return usd * USD_INR * 100;
}

// Contest if odds × amount > (1 − odds) × fee at the next stage.
export function shouldContest(odds: number, amount: number, fee: number): boolean {
  return odds * amount > (1 - odds) * fee;
}

// The odds above which contesting is worth it.
export const breakEvenOdds = (amount: number, fee: number) => fee / (amount + fee);

// ---- Deadlines

// Business days to respond, counted from when the dispute reached RAY.
export const RESPONSE_BUSINESS_DAYS: Record<string, number> = { chargeback: 3, pre_arbitration: 2, arbitration: 1 };
const IST_MS = (5 * 60 + 30) * MIN;

const istDay = (ms: number) => new Date(ms + IST_MS).getUTCDay(); // 0 Sunday … 6 Saturday
export const isBusinessDay = (ms: number) => istDay(ms) !== 0 && istDay(ms) !== 6;

// n business days later (Monday to Friday, IST), same time of day.
export function addBusinessDays(from: number, n: number): number {
  let at = from;
  let left = n;
  while (left > 0) {
    at += DAY;
    if (isBusinessDay(at)) left--;
  }
  return at;
}

// RAY's deadline: the earlier of Razorpay's respond-by and the stage's
// business days from onset. Never later than Razorpay's.
export function deadlineOf(d: Pick<Dispute, "phase" | "respond_by">, onset: number): number {
  const days = RESPONSE_BUSINESS_DAYS[d.phase] ?? 1;
  return Math.min(d.respond_by, addBusinessDays(onset, days));
}

export const URGENT_BEFORE_MS = DAY; // one urgent ask the day before
export const FINAL_BEFORE_MS = 4 * HOUR; // a few hours before: submit a strong pack, a weak one lapses
export const STOP_WINDOW_MS = 2 * HOUR;
export const MIN_STOP_WINDOW_MS = 10 * MIN;

// The Stop window: 2 hours, shorter when the deadline is closer (half the
// time left). null when there isn't time for a real window.
export function stopWindowEnd(now: number, deadline: number): number | null {
  const left = deadline - now;
  const window = Math.min(STOP_WINDOW_MS, Math.floor(left / 2));
  return window >= MIN_STOP_WINDOW_MS ? now + window : null;
}

// ---- Odds from the evidence pack (code; a model never sets them)

export type PackFacts = {
  type: DisputeType;
  // Store order state for the payment.
  shipped: boolean;
  deliveryConfirmed: boolean; // the customer confirmed it arrived on an earlier RAY case
  neverShipped: boolean;
  orderCancelled: boolean;
  refunded: boolean; // a refund on this payment at Razorpay
  singleCharge: boolean; // one captured payment for this order and customer
  chats: number; // messages with the customer
  buyerProtectionClaim: boolean; // an open Buyer Protection claim on the payment
  priorOrders: number; // earlier completed orders by the same customer
  fraud: { vulcan: "flagged" | "clear"; deviceSeenBefore: boolean; addressMatches: boolean; ipCountry: string } | null;
};

export const STRONG_PACK_ODDS = 0.65;
const cap = (x: number) => Math.round(Math.max(0, Math.min(0.95, x)) * 100) / 100;

export function oddsOf(f: PackFacts): number {
  const extra = (f.chats > 0 ? 0.05 : 0) + (f.buyerProtectionClaim ? 0.05 : 0);
  switch (f.type) {
    case "duplicate":
      return f.singleCharge || f.refunded ? 0.9 : 0.1;
    case "already_refunded":
      return f.refunded ? 0.9 : 0.1;
    case "not_received":
      if (f.neverShipped) return 0;
      return cap((f.deliveryConfirmed ? 0.85 : f.shipped ? 0.6 : 0.2) + extra);
    case "cancelled":
      if (f.refunded) return 0.9;
      return cap((f.orderCancelled ? 0.1 : 0.45) + extra);
    case "not_as_described":
      return cap(0.4 + extra);
    case "fraud": {
      if (!f.fraud) return cap(0.3 + (f.priorOrders > 0 ? 0.15 : 0));
      if (f.fraud.vulcan === "flagged") return 0.05;
      return cap(
        0.3 +
          (f.fraud.deviceSeenBefore ? 0.15 : 0) +
          (f.fraud.addressMatches ? 0.15 : 0) +
          (f.priorOrders > 0 ? 0.15 : 0) +
          (f.fraud.ipCountry === "IN" ? 0.05 : 0),
      );
    }
    default:
      return cap(0.3 + extra);
  }
}

// Sure only when a record decides it: a refund or a single charge at
// Razorpay, a delivery the customer confirmed, an order never shipped, or
// Vulcan's flag. Otherwise Likely.
export function confidenceOf(f: PackFacts): "sure" | "likely" {
  switch (f.type) {
    case "duplicate":
      return f.singleCharge || f.refunded ? "sure" : "likely";
    case "already_refunded":
      return f.refunded ? "sure" : "likely";
    case "not_received":
      return f.deliveryConfirmed || f.neverShipped ? "sure" : "likely";
    case "cancelled":
      return f.refunded ? "sure" : "likely";
    case "fraud":
      return f.fraud?.vulcan === "flagged" ? "sure" : "likely";
    default:
      return "likely";
  }
}

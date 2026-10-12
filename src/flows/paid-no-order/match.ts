// Matching is code (rule 3), against Razorpay's own payment records:
// exact UTR (or payment id), else contact + amount within ±2 hours. What the
// customer wrote only says what to look for; a screenshot or a UTR that
// matches nothing never counts, and a near-match is never acted on: RAY asks
// one question instead.
import type { Adapters } from "@/adapters";
import { sameContact, type Payment } from "@/adapters/razorpay";
import { MATCH_WINDOW_MS } from "@/guards";

// How far back RAY looks for a payment a customer is talking about.
export const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type Claim = {
  // The phone or email the message came from.
  sender: string;
  // In paise, from the message. null when the customer gave none.
  amount: number | null;
  utr: string | null;
  paymentId: string | null;
  // When they wrote; the ±2 hours is counted from here.
  at: number;
};

export type MatchResult =
  | { status: "matched"; payment: Payment; how: "utr" | "payment_id" | "contact_amount"; duplicates: Payment[] }
  | { status: "ambiguous"; candidates: Payment[] }
  | { status: "near"; candidates: Payment[] }
  | { status: "none" };

const LIVE = ["captured", "authorized", "failed"];

export async function recentPayments(a: Adapters, merchantId: string, now: number): Promise<Payment[]> {
  const all = await a.razorpay(merchantId).listPayments({ from: now - LOOKBACK_MS, to: now });
  return all.filter((p) => LIVE.includes(p.status) && p.currency === "INR");
}

const who = (sender: string) => (sender.includes("@") ? { email: sender } : { contact: sender });

export function matchClaim(payments: Payment[], claim: Claim): MatchResult {
  if (claim.paymentId) {
    const p = payments.find((x) => x.id === claim.paymentId);
    if (p) return { status: "matched", payment: p, how: "payment_id", duplicates: [] };
  }
  if (claim.utr) {
    const byUtr = payments.filter((x) => x.utr === claim.utr);
    if (byUtr.length === 1) return { status: "matched", payment: byUtr[0], how: "utr", duplicates: [] };
  }
  const near = (p: Payment) => Math.abs(p.created_at - claim.at) <= MATCH_WINDOW_MS;
  const contact = (p: Payment) => sameContact(p, who(claim.sender));
  const strong = claim.amount === null ? [] : payments.filter((p) => contact(p) && p.amount === claim.amount && near(p));
  if (strong.length === 1) return { status: "matched", payment: strong[0], how: "contact_amount", duplicates: [] };
  if (strong.length > 1) {
    // Two captured payments for the same amount from the same person: paid
    // twice. Anything else is two candidates and needs one question.
    const captured = strong.filter((p) => p.status === "captured");
    if (captured.length === strong.length) {
      const [first, ...rest] = [...captured].sort((x, y) => x.created_at - y.created_at);
      return { status: "matched", payment: first, how: "contact_amount", duplicates: rest };
    }
    return { status: "ambiguous", candidates: strong };
  }
  // Close but not a match: right person, wrong amount or time; or the right
  // amount at the right time from someone else.
  const close = payments.filter(
    (p) => (contact(p) && (claim.amount === null || p.amount !== claim.amount || !near(p))) || (claim.amount !== null && p.amount === claim.amount && near(p) && !contact(p)),
  );
  if (close.length === 1) return { status: "near", candidates: close };
  if (close.length > 1) return { status: "ambiguous", candidates: close.slice(0, 2) };
  return { status: "none" };
}

// Other captured payments from the same person for the same amount, close
// in time: the same cart paid twice (situation E).
export function duplicatesOf(payments: Payment[], p: Payment): Payment[] {
  return payments.filter(
    (o) =>
      o.id !== p.id &&
      o.status === "captured" &&
      p.status === "captured" &&
      o.amount === p.amount &&
      sameContact(o, p) &&
      Math.abs(o.created_at - p.created_at) <= MATCH_WINDOW_MS,
  );
}

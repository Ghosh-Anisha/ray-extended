// The chase stages (build guide Step 11), per invoice, and the time helpers
// they use. Code decides the stage from the invoice's own dates; nothing
// here sends anything.
//
//   Before due   3 days before due     Email                    Runs alone
//   Gentle       due + 3               Email, WhatsApp          Runs alone
//   Firm         due + 15              Email and WhatsApp       One tap per buyer
//   Call         due + 25              place_call (Simulated)   One tap; key accounts a tap per call
//   MSME rights  accepted + 45, Udyam  Email                    Always approval
//   Samadhaan    only on request       Draft the merchant files Merchant files
import type * as s from "@/db/schema";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
const IST_MS = (5 * 60 + 30) * MIN;

export type Invoice = typeof s.invoices.$inferSelect;
export type Buyer = typeof s.buyers.$inferSelect;

export const STAGES = ["before_due", "gentle", "firm", "call", "msme"] as const;
export type Stage = (typeof STAGES)[number];

// The chase ladder, in order. MSME rights runs beside it.
export const LADDER: readonly Stage[] = ["before_due", "gentle", "firm", "call"];

export const STAGE_AT: Record<Exclude<Stage, "msme">, number> = {
  before_due: -3 * DAY,
  gentle: 3 * DAY,
  firm: 15 * DAY,
  call: 25 * DAY,
};
export const MSME_DAYS = 45;
export const MSME_MS = MSME_DAYS * DAY;

// Merchant-facing stage names (design language: plain words).
export const STAGE_LABEL: Record<Stage, string> = {
  before_due: "Before due",
  gentle: "Gentle reminder",
  firm: "Firm reminder",
  call: "Call",
  msme: "MSME notice",
};

// Which stages need the merchant's tap. Key accounts: a tap for anything firm.
export const NEEDS_TAP: Record<Stage, boolean> = { before_due: false, gentle: false, firm: true, call: true, msme: true };

// Days, rounded down, from the due date to now (negative before due).
export const daysOverdue = (inv: Pick<Invoice, "due_date">, now: number) => Math.floor((now - inv.due_date) / DAY);

// What is still owed: the amount, less what was paid, less a disputed part
// (chased only once it's settled) and TDS the buyer claimed (owed as a
// certificate, not money).
export function outstanding(inv: Invoice, tdsClaimed = 0): number {
  return Math.max(0, inv.amount - inv.paid_amount - (inv.disputed_part ?? 0) - tdsClaimed);
}

// The furthest ladder stage the invoice's dates have reached, or null.
export function ladderStage(inv: Pick<Invoice, "due_date">, now: number): Exclude<Stage, "msme"> | null {
  let at: Exclude<Stage, "msme"> | null = null;
  for (const st of LADDER as Exclude<Stage, "msme">[]) if (now >= inv.due_date + STAGE_AT[st]) at = st;
  return at;
}

// MSME rights: 45 days after acceptance, for Udyam-registered merchants only.
export const msmeDue = (inv: Pick<Invoice, "accepted_at">, udyam: boolean, now: number) =>
  udyam && inv.accepted_at !== null && now >= inv.accepted_at + MSME_MS;

// The next ladder stage after this one (two broken promises move it on).
export const nextStage = (st: Exclude<Stage, "msme">): Exclude<Stage, "msme"> => {
  const i = LADDER.indexOf(st);
  return (LADDER[Math.min(i + 1, LADDER.length - 1)] ?? "call") as Exclude<Stage, "msme">;
};

// IST calendar helpers.
export const istMidnight = (ms: number) => ms - ((ms + IST_MS) % DAY);
export const dayKey = (ms: number) => new Date(istMidnight(ms) + IST_MS).toISOString().slice(0, 10);

// The daily check runs at 10:30 AM IST, inside default calling hours.
export const CHECK_AT_MIN = 10 * 60 + 30;
export function nextCheckAt(now: number): number {
  const today = istMidnight(now) + CHECK_AT_MIN * MIN;
  return now < today ? today : today + DAY;
}

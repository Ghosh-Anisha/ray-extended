// Proactive cards on Home (docs/ui-rebuild.md 11 and 13, Grow lane 1): what
// RAY suggests from the merchant's own data. Turning a lever is simulated:
// it records the choice and the numbers at that moment, nothing else. Two
// weeks later the card shows before and after (the "after" is Simulated).
import { and, eq, gte, lt } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import * as s from "@/db/schema";
import { formatDate } from "@/guards/format";
import { readState, writeState } from "./dashboard";
import { merchantStats, rupees } from "./stats";

const DAY = 24 * 60 * 60_000;
const BIG_CART = 5_000_00; // ₹5,000 in paise
// An assumption, shown on the card: the share of dropped big carts that finish when EMI is offered.
const RECOVERY = 0.15;
const SIMULATED_DROP_CUT = 0.3;

type EmiState = { status: "on" | "not_now"; at: number; before: Cart };
type Cart = { carts: number; dropped: number; droppedValue: number };

function bigCarts(a: Adapters, merchantId: string, from: number, to: number): Cart {
  const orders = a.db
    .select()
    .from(s.rzpOrders)
    .where(and(eq(s.rzpOrders.merchant_id, merchantId), eq(s.rzpOrders.currency, "INR"), gte(s.rzpOrders.created_at, from), lt(s.rzpOrders.created_at, to)))
    .all()
    .filter((o) => o.amount >= BIG_CART);
  const dropped = orders.filter((o) => o.status !== "paid");
  return { carts: orders.length, dropped: dropped.length, droppedValue: dropped.reduce((sum, o) => sum + o.amount, 0) };
}

export type EmiCard =
  | { phase: "offer"; carts: number; dropped: number; estimate: string; droppedValue: string; assumption: string; tradeOff: string }
  | { phase: "on"; since: string; checkOn: string }
  | { phase: "result"; since: string; before: { dropped: number; value: string }; after: { dropped: number; value: string }; line: string };

export function emiCard(a: Adapters, merchantId: string): EmiCard | null {
  const now = a.clock.now();
  const saved = readState<EmiState>(a, merchantId, "grow.emi");
  if (saved?.status === "not_now") return null;
  if (saved?.status === "on") {
    const checkAt = saved.at + 14 * DAY;
    if (now < checkAt) return { phase: "on", since: formatDate(saved.at), checkOn: formatDate(checkAt) };
    const afterDropped = Math.max(0, Math.round(saved.before.dropped * (1 - SIMULATED_DROP_CUT)));
    const afterValue = Math.round(saved.before.droppedValue * (afterDropped / Math.max(1, saved.before.dropped)));
    return {
      phase: "result",
      since: formatDate(saved.at),
      before: { dropped: saved.before.dropped, value: rupees(saved.before.droppedValue) },
      after: { dropped: afterDropped, value: rupees(afterValue) },
      line: `Big carts left unpaid fell from ${saved.before.dropped} to ${afterDropped}, about ${rupees(saved.before.droppedValue - afterValue)} that stayed in your sales.`,
    };
  }
  const c = bigCarts(a, merchantId, now - 30 * DAY, now + 1);
  if (c.dropped === 0) return null;
  return {
    phase: "offer",
    carts: c.carts,
    dropped: c.dropped,
    droppedValue: rupees(c.droppedValue),
    estimate: rupees(Math.round(c.droppedValue * RECOVERY)),
    assumption: `Estimate: ${Math.round(RECOVERY * 100)}% of the carts left unpaid finish with EMI. It is an assumption, not a promise.`,
    tradeOff: "Customers pay in parts, you are paid in full, and Razorpay's EMI fee on those orders comes out of your side. Check your plan's rate in Settings before you decide.",
  };
}

export function setEmi(a: Adapters, merchantId: string, status: "on" | "not_now") {
  const now = a.clock.now();
  writeState(a, merchantId, "grow.emi", { status, at: now, before: bigCarts(a, merchantId, now - 30 * DAY, now + 1) });
}

// "You chase invoices by hand, want RAY to do it?" from the overdue invoices.
export function chaseCard(a: Adapters, merchantId: string): { line: string; href: string } | null {
  if (readState<string>(a, merchantId, "grow.chase") === "dismissed") return null;
  const st = merchantStats(a, merchantId);
  if (st.overdue.invoices === 0) return null;
  return {
    line: `${rupees(st.overdue.amount)} is overdue across ${st.overdue.buyers} buyers. RAY can send the reminders, note each promise and match payments, and bring you only what needs a decision.`,
    href: `/merchant/${merchantId}/collect`,
  };
}

export function dismissChase(a: Adapters, merchantId: string) {
  writeState(a, merchantId, "grow.chase", "dismissed");
}

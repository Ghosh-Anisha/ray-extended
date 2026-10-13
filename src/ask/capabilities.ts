// What RAY can do (docs/ui-rebuild.md section 11), ordered by the merchant's
// own data: moments with money waiting come first, then what is already on,
// then what is coming. Every status here is true of the build: a capability
// is "On" when RAY has handled that kind of case for this merchant, "Try it"
// when it is built but has not had a case yet, and "Coming soon" otherwise.
import { and, eq, gte, sql } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import * as s from "@/db/schema";
import type { Moment } from "@/db/schema";
import { merchantStats } from "@/surfaces/stats";

export type CapabilityStatus = "On" | "Try it" | "Coming soon";
export type Capability = { key: string; title: string; line: string; status: CapabilityStatus; moment: Moment | null; href: string | null; openCases: number; preview?: boolean };

const MOMENT_CAPS: { moment: Moment; title: string; line: string }[] = [
  { moment: "paid_no_order", title: "Fixes paid orders that didn't show up", line: "Finds the payment, the missing order and the cause, then marks it paid or refunds." },
  { moment: "international", title: "Rescues declined cards abroad", line: "Tells the customer how to pay, raises the limit request and follows up." },
  { moment: "subscription", title: "Saves stopping subscriptions", line: "Finds why a subscriber is leaving and offers a pause, a discount or a call." },
  { moment: "chargeback", title: "Fights chargebacks", line: "Collects proof, drafts the reply and sends it before the deadline." },
  { moment: "collect", title: "Chases overdue invoices", line: "Reminds buyers, logs promises and matches the bank credit when it lands." },
];

const LATER: { key: string; title: string; line: string; moment?: Moment }[] = [
  { key: "me_or_razorpay", moment: "whose_side", title: "Tells you if it's you or Razorpay", line: "Preview: splits seeded success-rate examples by method and bank. No live investigation is connected." },
  { key: "tickets", moment: "ticket", title: "Follows up your support tickets", line: "Preview: shows a seeded ticket example. No support-ticket integration is connected." },
  { key: "settlements", moment: "settlement_hold", title: "Explains held settlements", line: "Preview: shows a seeded hold example. No settlement feed is connected." },
  { key: "ai_orders", moment: "ai_chat_order", title: "Checks AI-chat orders", line: "Preview: compares a seeded chat, order and payment example. No AI-chat integration is connected." },
  { key: "dues", title: "Plans your dues", line: "One list of what you owe, when, and what to pay first." },
  { key: "grow", title: "Grows sales with features you already have", line: "Preview: models a lever from seeded demo orders; results are simulated, not measured." },
];

export function capabilities(a: Adapters, merchantId: string): Capability[] {
  const stats = merchantStats(a, merchantId);
  const since = a.clock.now() - 30 * 24 * 60 * 60 * 1000;
  const handled = new Set(
    a.db
      .select({ moment: s.cases.moment })
      .from(s.cases)
      .where(and(eq(s.cases.merchant_id, merchantId), gte(s.cases.opened_at, since)))
      .groupBy(s.cases.moment)
      .all()
      .map((r) => r.moment),
  );
  const base = `/merchant/${merchantId}`;
  const moments: Capability[] = MOMENT_CAPS.map((c) => {
    const stat = stats.byMoment.find((m) => m.moment === c.moment);
    return {
      key: c.moment,
      title: c.title,
      line: c.line,
      status: handled.has(c.moment) ? "On" : "Try it",
      moment: c.moment,
      href: `${base}/cases?moment=${c.moment}`,
      openCases: stat?.open ?? 0,
    };
  });
  // Money waiting first, then the rest in the order of the list.
  moments.sort((x, y) => y.openCases - x.openCases);
  const dashboard: Capability = { key: "dashboard", title: "Builds your dashboard", line: "Your own numbers from three questions, with the meaning of each.", status: "Try it", moment: null, href: `${base}/dashboard`, openCases: 0 };
  const later = LATER.map((l): Capability => ({
    ...l,
    status: "Coming soon",
    moment: l.moment ?? null,
    href: l.moment ? `${base}/cases?moment=${l.moment}` : null,
    openCases: 0,
    preview: !!l.moment,
  }));
  return [...moments, dashboard, ...later];
}

// Used by tests: how many cases of each moment the merchant has.
export const countByMoment = (a: Adapters, merchantId: string) =>
  a.db
    .select({ moment: s.cases.moment, n: sql<number>`count(*)` })
    .from(s.cases)
    .where(eq(s.cases.merchant_id, merchantId))
    .groupBy(s.cases.moment)
    .all();

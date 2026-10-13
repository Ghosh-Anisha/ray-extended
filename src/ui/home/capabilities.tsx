// "What RAY can do for you" (docs/ui-rebuild.md section 11): every capability,
// marked On, Try it or Coming soon. Try it opens a short guided example.
import { ArrowRight, Check } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export type CapabilityStatus = "on" | "try" | "soon";
type Capability = { key: string; title: string; line: string; moment?: string; tour?: string; href?: (base: string) => string; preview?: boolean };

// Designs built elsewhere link to their routes even before they exist here.
const CAPABILITIES: Capability[] = [
  { key: "pno", title: "Fixes paid orders that didn't show up", line: "Finds the payment, proves it, and marks the order paid.", moment: "paid_no_order", tour: "paid_no_order" },
  { key: "intl", title: "Rescues declined cards abroad", line: "Works out the cause and sends the customer a way to pay.", moment: "international", tour: "international" },
  { key: "sub", title: "Saves stopping subscriptions", line: "Offers a pause, a discount or a retry before they leave.", moment: "subscription", tour: "subscription" },
  { key: "cb", title: "Fights chargebacks", line: "Gathers proof and drafts the reply before the deadline.", moment: "chargeback", tour: "chargeback" },
  { key: "col", title: "Chases overdue invoices", line: "Reminds buyers, notes promises and matches the bank credit.", moment: "collect", tour: "collect" },
  { key: "whose", title: "Tells you if it's you or Razorpay", line: "Preview: splits a seeded payment example by method and bank. No live investigation is connected.", href: (b) => `${b}/cases?moment=whose_side`, preview: true },
  { key: "ticket", title: "Follows up your support tickets", line: "Preview: shows a seeded ticket example. No support-ticket integration is connected.", href: (b) => `${b}/cases?moment=ticket`, preview: true },
  { key: "hold", title: "Explains held settlements", line: "Preview: shows a seeded hold example. No settlement feed is connected.", href: (b) => `${b}/cases?moment=settlement_hold`, preview: true },
  { key: "chat", title: "Checks AI-chat orders", line: "Preview: compares a seeded chat, order and payment example. No AI-chat integration is connected.", href: (b) => `${b}/cases?moment=ai_chat_order`, preview: true },
  { key: "dues", title: "Plans your dues", line: "Illustrative date-based arithmetic only. No complete ledger or payment rail is connected.", href: (b) => `${b}/dues` },
  { key: "grow", title: "Grows sales with features you already have", line: "Proposes modeled levers from seeded demo orders; results are simulated, not measured.", tour: "grow" },
  { key: "dash", title: "Builds your dashboard", line: "Your numbers, with definitions, watched for you.", href: (b) => `${b}/dashboard?tour=dashboard` },
];

function href(c: Capability, base: string, status: CapabilityStatus) {
  if (c.href) return c.href(base);
  if (c.tour === "grow") return `${base}?tour=grow`;
  if (c.moment) return status === "on" ? `${base}/cases?moment=${c.moment}` : `${base}/cases?moment=${c.moment}&tour=${c.tour}`;
  return base;
}

export function Capabilities({ merchantId, rayOn, dashboardSet }: { merchantId: string; rayOn: boolean; dashboardSet: boolean }): ReactNode {
  const base = `/merchant/${merchantId}`;
  const status = (c: Capability): CapabilityStatus => (c.moment && rayOn ? "on" : c.key === "dash" && dashboardSet ? "on" : "try");
  return (
    <section className="stack" style={{ gap: 12 }} aria-label="What RAY can do for you">
      <div className="section-head" data-coach="capabilities">
        <h2>What RAY can do for you</h2>
      </div>
      <div className="grid-3">
        {CAPABILITIES.map((c, i) => {
          const st = status(c);
          return (
            <div key={c.key} className="panel cap">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{c.title}</strong>
                <span className={`chip ${st === "on" ? "positive" : st === "try" ? "information" : "neutral"}`}>
                  {st === "on" && <Check size={12} aria-hidden="true" />}
                  {st === "on" ? "On" : st === "try" ? "Try it" : "Coming soon"}
                </span>
                {c.preview && <span className="chip simulated">Preview · simulated</span>}
              </div>
              <span className="muted">{c.line}</span>
              {st !== "soon" && (
                <span className="cap-actions">
                  <Link className={`btn small ${st === "try" ? "primary" : "secondary"}`} href={href(c, base, st)} data-coach={i === 0 ? "try-it" : undefined}>
                    {c.preview ? "Open preview" : st === "try" ? "Try it" : "See cases"}
                    <ArrowRight size={14} aria-hidden="true" />
                  </Link>
                  {st === "on" && c.tour && (
                    <Link className="btn tertiary small" href={`${base}/cases?moment=${c.moment}&tour=${c.tour}`}>
                      Show me
                    </Link>
                  )}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

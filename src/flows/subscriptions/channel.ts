// Channel choice for subscribers (Step 9): email by default; WhatsApp with
// consent, and free text only while the subscriber's 24-hour window is open
// (outside it only an approved template could go, and no template carries
// a link); B2B goes to the billing contact's email. SMS isn't built: there
// is no SMS channel in the messaging adapter (see docs/overnight/step-9.md).
// The guards still check every send: consent, window, links, grounding.
import { and, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { sameChannel, WINDOW_MS } from "@/adapters/messaging";
import * as s from "@/db/schema";
import type { EngineContext } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { readSettings } from "@/surfaces/playbook";

export type Customer = typeof s.customers.$inferSelect;
export type Recipient = { channel: "whatsapp" | "email"; to: string };

export const adaptersOf = (ctx: EngineContext): Adapters => {
  if (!ctx.adapters) throw new Error("The subscriptions flow needs the adapters");
  return ctx.adapters;
};

function whatsappWindowOpen(a: Adapters, merchantId: string, phone: string, now: number) {
  return a.messaging
    .thread(merchantId, phone)
    .some((m) => m.direction === "in" && sameChannel("whatsapp").includes(m.channel) && m.at <= now && m.at > now - WINDOW_MS);
}

export function recipientFor(ctx: EngineContext, kase: Case, customer: Customer, opts: { b2b: boolean }): Recipient | null {
  const a = adaptersOf(ctx);
  const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
  if (opts.b2b) return customer.email ? { channel: "email", to: customer.email } : null;
  const now = ctx.clock.now();
  const waConsent = customer.phone ? a.messaging.consent(customer.id, "whatsapp") : null;
  if (merchant.whatsapp_on && customer.phone && waConsent === "opted_in" && whatsappWindowOpen(a, kase.merchant_id, customer.phone, now)) {
    return { channel: "whatsapp", to: customer.phone };
  }
  if (customer.email && a.messaging.consent(customer.id, "email") !== "opted_out") return { channel: "email", to: customer.email };
  return null;
}

export function senderMode(ctx: EngineContext, kase: Case, channel: "whatsapp" | "email") {
  const mode = readSettings(ctx.db, kase.merchant_id, "subscription").sendFrom;
  return channel === "whatsapp" && mode === "verified_domain" ? "merchant_inbox" : mode;
}

export function settingsOf(ctx: EngineContext, kase: Case) {
  return readSettings(ctx.db, kase.merchant_id, "subscription");
}

export function messageArgs(ctx: EngineContext, kase: Case, r: Recipient, kind: string, body: string) {
  return { channel: r.channel, to: r.to, sender_mode: senderMode(ctx, kase, r.channel), kind, body };
}

// The subscriber behind a phone or email at this merchant, with a subscription.
export function subscriberBy(ctx: EngineContext, merchantId: string, from: { phone?: string; email?: string }) {
  const customers = ctx.db.select().from(s.customers).where(eq(s.customers.merchant_id, merchantId)).all();
  const c = customers.find((x) => (from.phone && x.phone === from.phone) || (from.email && x.email?.toLowerCase() === from.email));
  if (!c) return null;
  const sub = ctx.db
    .select()
    .from(s.subscriptions)
    .where(and(eq(s.subscriptions.merchant_id, merchantId), eq(s.subscriptions.customer_id, c.id)))
    .all()
    .sort((x, y) => y.started_at - x.started_at)[0];
  return sub ? { customer: c, sub } : null;
}

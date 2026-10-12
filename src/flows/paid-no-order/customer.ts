// Who the customer is on a case, where to write to them, and sending. Every
// send goes through guardedCall: the guards decide whether it may go
// (consent, the 24-hour window, the first message, grounding, approval).
import { and, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { WINDOW_MS, sameChannel } from "@/adapters/messaging";
import { sameContact, type Payment } from "@/adapters/razorpay";
import { firstNameOf } from "@/adapters/voice";
import * as s from "@/db/schema";
import { createRepository } from "@/db/repository";
import type { Approval, EngineContext } from "@/engine/specialist";
import type { Case } from "@/engine/state-machine";
import { formatDate, formatMoney, formatTime, guardedCall, type GuardedResult } from "@/guards";
import { readSettings } from "@/surfaces/playbook";
import type { PaymentBits } from "./lines";

export type Customer = typeof s.customers.$inferSelect;
type Message = typeof s.messages.$inferSelect;

export const adaptersOf = (ctx: EngineContext): Adapters => {
  if (!ctx.adapters) throw new Error("The paid-no-order flow needs the adapters");
  return ctx.adapters;
};

// The customer's messages on this case, oldest first.
export function inbound(ctx: EngineContext, caseId: string): Message[] {
  const ids = ctx.repo.caseEvents
    .listByCase(caseId)
    .filter((e) => e.type === "message_in" && e.evidence_ref)
    .map((e) => e.evidence_ref!);
  return ids.map((id) => ctx.repo.messages.get(id)).filter((m): m is Message => !!m);
}

export function outbound(ctx: EngineContext, caseId: string): Message[] {
  return ctx.db
    .select()
    .from(s.messages)
    .where(and(eq(s.messages.case_id, caseId), eq(s.messages.direction, "out")))
    .all()
    .filter((m) => m.channel !== "call");
}

export function customerOf(ctx: EngineContext, kase: Case, payment: Payment | null): Customer | null {
  const repo = createRepository(ctx.db);
  const mine = repo.customers.list(eq(s.customers.merchant_id, kase.merchant_id));
  const last = inbound(ctx, kase.id).at(-1);
  if (last) {
    const c = mine.find((x) => x.phone === last.from || x.email?.toLowerCase() === last.from.toLowerCase());
    if (c) return c;
  }
  if (payment) return mine.find((c) => sameContact(payment, { contact: c.phone, email: c.email })) ?? null;
  return null;
}

export type Recipient = { channel: "whatsapp" | "email"; to: string; windowOpen: boolean };

// Replies go to the channel the customer used last. Otherwise WhatsApp when
// the merchant has it and the customer has a phone, else email.
export function recipientOf(ctx: EngineContext, kase: Case, customer: Customer | null, payment: Payment | null): Recipient | null {
  const a = adaptersOf(ctx);
  const merchant = ctx.repo.merchants.get(kase.merchant_id)!;
  const last = inbound(ctx, kase.id).at(-1);
  const now = ctx.clock.now();
  if (last) {
    const channel = last.channel === "email" ? "email" : "whatsapp";
    const open = a.messaging
      .thread(kase.merchant_id, last.from)
      .some((m) => m.direction === "in" && sameChannel(channel).includes(m.channel) && m.at > now - WINDOW_MS);
    return { channel, to: last.from, windowOpen: open };
  }
  const phone = customer?.phone ?? payment?.contact ?? null;
  const email = customer?.email ?? payment?.email ?? null;
  if (merchant.whatsapp_on && phone) return { channel: "whatsapp", to: phone, windowOpen: a.messaging.window(kase.merchant_id, phone).open };
  if (email) return { channel: "email", to: email, windowOpen: false };
  return null;
}

export function senderMode(ctx: EngineContext, kase: Case, channel: "whatsapp" | "email") {
  const mode = readSettings(ctx.db, kase.merchant_id, "paid_no_order").sendFrom;
  // WhatsApp can't send from an email domain.
  return channel === "whatsapp" && mode === "verified_domain" ? "merchant_inbox" : mode;
}

export function settingsOf(ctx: EngineContext, kase: Case) {
  return readSettings(ctx.db, kase.merchant_id, "paid_no_order");
}

// What the customer can check: amount, time, date, last 4 of the UTR (or the card).
export function paymentBits(payment: Payment, customer: Customer | null, orderNumber: string | null): PaymentBits {
  const ref = payment.utr ? `UTR ending ${payment.utr.slice(-4)}` : payment.card_last4 ? `card ending ${payment.card_last4}` : null;
  return {
    name: firstNameOf(customer?.name ?? "there"),
    amount: formatMoney(payment.amount, payment.currency),
    time: formatTime(payment.created_at),
    date: formatDate(payment.created_at),
    ref,
    order: orderNumber,
  };
}

export type MessageArgs = {
  channel: "whatsapp" | "email";
  to: string;
  sender_mode: (typeof s.SENDER_MODES)[number];
  kind: string;
  body?: string;
  template_id?: string;
  params?: Record<string, string>;
  confirms_action_id?: string;
};

// The send_message args for a message: the written body when the customer
// can get free text (email, or WhatsApp inside the 24-hour window), else the
// approved template.
export function messageArgs(
  ctx: EngineContext,
  kase: Case,
  r: Recipient,
  kind: string,
  body: string,
  template?: { id: string; params: Record<string, string> },
): MessageArgs {
  const base = { channel: r.channel, to: r.to, sender_mode: senderMode(ctx, kase, r.channel), kind };
  if (r.channel === "whatsapp" && !r.windowOpen && template) return { ...base, template_id: template.id, params: template.params };
  return { ...base, body };
}

export function send(ctx: EngineContext, kase: Case, args: MessageArgs, approval?: Approval): Promise<GuardedResult> {
  return guardedCall("send_message", args, { adapters: adaptersOf(ctx), caseId: kase.id, approval });
}

export const went = (r: GuardedResult) => r.status === "done" || r.status === "duplicate";

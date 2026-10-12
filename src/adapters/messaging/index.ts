// Simulated in-app WhatsApp and email over the messages table.
// Sender modes: the merchant's own inbox, the merchant's verified domain
// (email only), or "Merchant via Razorpay" with replies routed back to the
// merchant's case. Rules enforced on every send:
// - A message is proactive unless it answers the customer on the same channel
//   within 24 hours. An opt-out in messaging_consents blocks every proactive
//   message on that channel.
// - WhatsApp outside the 24-hour window: approved templates only, and only to
//   customers with an opted_in consent row.
// - A voice note is a WhatsApp message: it is stored on channel voice_note
//   with its transcript as the body, and opens the window like text.
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Clock } from "../clock";
import { HANDLED_BY_MERCHANT } from "@/engine/outcomes";
import { newId } from "../ids";

export type Message = typeof s.messages.$inferSelect;
export type Channel = (typeof s.CHANNELS)[number];
export type ConsentChannel = (typeof s.CONSENT_CHANNELS)[number];
export type SenderMode = (typeof s.SENDER_MODES)[number];

export const WINDOW_MS = 24 * 60 * 60 * 1000;

// The channels a message on this channel counts as, for the 24-hour window.
export const sameChannel = (channel: string): string[] => (channel === "whatsapp" ? ["whatsapp", "voice_note"] : [channel]);

type Template = { status: "approved" | "pending" | "rejected"; body: string };

// Pre-approved WhatsApp templates. No links: a first message must carry
// checkable details only (amount, time, last 4 of the UTR).
export const WHATSAPP_TEMPLATES: Record<string, Template> = {
  payment_received_check: {
    status: "approved",
    body: "Hi {{name}}, this is {{merchant}}. We got your payment of {{amount}} at {{time}} on {{date}} for order {{order}}, UTR ending {{utr_last4}}. You can check this in your UPI app. Reply YES and we will confirm your order.",
  },
  order_update: {
    status: "approved",
    body: "Hi {{name}}, your order {{order}} from {{merchant}} is now {{status}}.",
  },
  payment_not_completed: {
    status: "approved",
    body: "Hi {{name}}, your payment of {{amount}} to {{merchant}} did not go through. Reply here and we will help you finish it.",
  },
  subscription_payment_due: {
    status: "approved",
    body: "Hi {{name}}, your {{plan}} payment of {{amount}} to {{merchant}} did not go through. Reply here and we will help.",
  },
  invoice_reminder: {
    status: "approved",
    body: "Hello {{name}}, invoice {{invoice}} for {{amount}} from {{merchant}} was due on {{date}}. Reply with the date you plan to pay.",
  },
  // Paid, no order (Step 7). The first text when RAY writes first: checkable
  // details, no link, and the time the customer will hear back by.
  payment_seen_promise: {
    status: "approved",
    body: "Hi {{name}}, this is {{merchant}}. We can see your payment of {{amount}} at {{time}} on {{date}}, UTR ending {{utr_last4}}. You can check this in your UPI app. You'll hear from us with an update by {{update_by}}.",
  },
  // The same, saying a call may follow and from which number.
  payment_seen_promise_call: {
    status: "approved",
    body: "Hi {{name}}, this is {{merchant}}. We can see your payment of {{amount}} at {{time}} on {{date}}, UTR ending {{utr_last4}}. You can check this in your UPI app. You'll hear from us with an update by {{update_by}}. If we don't hear back from you by then, we'll call you from this number.",
  },
  // The order is fixed: the confirmation, with details the customer can check.
  order_confirmed_payment: {
    status: "approved",
    body: "Hi {{name}}, this is {{merchant}}. We got your payment of {{amount}} at {{time}} on {{date}}, UTR ending {{utr_last4}}, and your order {{order}} is confirmed.",
  },
  // The promised time passed and the merchant hasn't decided yet.
  payment_update_holding: {
    status: "approved",
    body: "Hi {{name}}, this is {{merchant}}. We're still on your payment of {{amount}}. You'll hear from us by {{update_by}}.",
  },
  // 48 hours after the order went out.
  delivery_check: {
    status: "approved",
    body: "Hi {{name}}, this is {{merchant}}. Did your order {{order}} arrive? Reply YES or NO.",
  },
  festive_offer: {
    status: "pending",
    body: "Hi {{name}}, {{merchant}} has a festive offer for you.",
  },
};

export const sendInput = z
  .object({
    merchantId: z.string(),
    caseId: z.string().nullish(),
    channel: z.enum(s.CHANNELS),
    to: z.string().min(3),
    senderMode: z.enum(s.SENDER_MODES),
    body: z.string().min(1).optional(),
    templateId: z.string().optional(),
    params: z.record(z.string(), z.string()).optional(),
  })
  .refine((v) => (v.body === undefined) !== (v.templateId === undefined), "Give either a body or a templateId");
export type SendInput = z.input<typeof sendInput>;

export const receiveInput = z.object({
  channel: z.enum(s.CHANNELS),
  from: z.string().min(3),
  merchantId: z.string(),
  // Defaults to the address the customer last heard from, so replies route back.
  to: z.string().optional(),
  body: z.string().min(1),
  // A voice note (WhatsApp only): the body is its transcript.
  voice: z.object({ audioRef: z.string().nullable(), durationS: z.number().int().nonnegative() }).optional(),
}).refine((v) => !v.voice || v.channel === "whatsapp", "Voice notes come in on WhatsApp");
export type ReceiveInput = z.input<typeof receiveInput>;

export type MessagingErrorCode =
  | "WHATSAPP_OFF"
  | "BAD_SENDER_MODE"
  | "WINDOW_CLOSED"
  | "TEMPLATE_NOT_APPROVED"
  | "TEMPLATE_PARAMS"
  | "NOT_OPTED_IN"
  | "OPTED_OUT"
  | "MERCHANT_HANDLING"
  | "UNKNOWN_ADDRESS";

export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}

export interface Messaging {
  send(input: SendInput): Promise<Message>;
  receive(input: ReceiveInput): Promise<Message>;
  window(merchantId: string, customer: string): { open: boolean; closesAt: number | null };
  thread(merchantId: string, customer: string): Message[];
  inbox(customer: string): Message[];
  senderAddress(merchantId: string, channel: Channel, mode: SenderMode): string;
  senderLabel(address: string): string;
}

export type Consent = (typeof s.CONSENT_STATUSES)[number];

export type MessagingSim = Messaging & {
  setConsent(customerId: string, channel: ConsentChannel, status: Consent, source: string): void;
  consent(customerId: string, channel: ConsentChannel): Consent | null;
};

// Ties on the fake clock fall back to insert order.
const insertOrder = sql`rowid`;

const slug = (merchantId: string) => merchantId.replace(/^m_/, "").replace(/_/g, "-");

// Merchants who verified their own email domain send from that address;
// everyone else gets a simulated one.
export const VERIFIED_SENDERS: Record<string, string> = { m_leafy_bakes: "support@leafybakes.in" };

function address(merchantId: string, channel: Channel, mode: SenderMode): string | null {
  const m = slug(merchantId);
  if (channel === "whatsapp") {
    if (mode === "merchant_inbox") return `wa:${m}`;
    if (mode === "via_razorpay") return `wa:razorpay/${m}`;
    return null;
  }
  if (mode === "merchant_inbox") return `${m}.owner@mail.example.com`;
  if (mode === "verified_domain") return VERIFIED_SENDERS[merchantId] ?? `orders@${m}.example.com`;
  return `${m}@via-razorpay.example.com`;
}

export function renderTemplate(templateId: string, params: Record<string, string> = {}): string {
  const t = WHATSAPP_TEMPLATES[templateId];
  if (!t) throw new MessagingError("TEMPLATE_NOT_APPROVED", `No WhatsApp template called ${templateId}`);
  if (t.status !== "approved") throw new MessagingError("TEMPLATE_NOT_APPROVED", `Template ${templateId} is ${t.status}, not approved`);
  const missing = [...t.body.matchAll(/\{\{(\w+)\}\}/g)].map((x) => x[1]).filter((k) => !params[k]);
  if (missing.length) throw new MessagingError("TEMPLATE_PARAMS", `Template ${templateId} is missing ${missing.join(", ")}`);
  return t.body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => params[k]);
}

export function createMessagingSim(db: Db, clock: Clock): MessagingSim {
  const repo = createRepository(db);

  const merchantAddresses = (merchantId: string, channel?: Channel) =>
    (channel ? [channel] : s.CHANNELS)
      .flatMap((c) => s.SENDER_MODES.map((mode) => address(merchantId, c, mode)))
      .filter((a): a is string => a !== null);

  const merchantOf = (addr: string) => repo.merchants.list().find((m) => merchantAddresses(m.id).includes(addr));

  const customerAt = (merchantId: string, channel: Channel, addr: string) =>
    db
      .select()
      .from(s.customers)
      .where(and(eq(s.customers.merchant_id, merchantId), eq(channel === "whatsapp" ? s.customers.phone : s.customers.email, addr)))
      .get();

  const consentRow = (customerId: string, channel: ConsentChannel) =>
    db
      .select()
      .from(s.messagingConsents)
      .where(and(eq(s.messagingConsents.customer_id, customerId), eq(s.messagingConsents.channel, channel)))
      .get();

  const thread = (merchantId: string, customer: string) => {
    const mine = merchantAddresses(merchantId);
    return db
      .select()
      .from(s.messages)
      .where(
        or(
          and(eq(s.messages.from, customer), inArray(s.messages.to, mine)),
          and(eq(s.messages.to, customer), inArray(s.messages.from, mine)),
        ),
      )
      .orderBy(s.messages.at, insertOrder)
      .all();
  };

  // Open for 24 hours after the customer's last message on that channel.
  const windowOn = (merchantId: string, customer: string, channel: Channel) => {
    const lastIn = db
      .select()
      .from(s.messages)
      .where(
        and(
          inArray(s.messages.channel, sameChannel(channel) as Message["channel"][]),
          eq(s.messages.direction, "in"),
          eq(s.messages.from, customer),
          inArray(s.messages.to, merchantAddresses(merchantId, channel)),
        ),
      )
      .orderBy(desc(s.messages.at), desc(insertOrder))
      .get();
    const closesAt = lastIn ? lastIn.at + WINDOW_MS : null;
    return { open: closesAt !== null && clock.now() < closesAt, closesAt };
  };

  return {
    async send(raw) {
      const input = sendInput.parse(raw);
      const merchant = repo.merchants.get(input.merchantId);
      if (!merchant) throw new MessagingError("UNKNOWN_ADDRESS", `Merchant ${input.merchantId} not found`);
      // Once the merchant takes a case over, RAY sends nothing more on it.
      if (input.caseId) {
        const kase = repo.cases.get(input.caseId);
        if (kase?.outcome === HANDLED_BY_MERCHANT) {
          throw new MessagingError("MERCHANT_HANDLING", "The merchant is handling this case, so RAY sends nothing more on it");
        }
      }
      const from = address(input.merchantId, input.channel, input.senderMode);
      if (!from) throw new MessagingError("BAD_SENDER_MODE", `${input.senderMode} cannot send on ${input.channel}`);

      if (input.channel === "whatsapp" && !merchant.whatsapp_on) {
        throw new MessagingError("WHATSAPP_OFF", `${merchant.name} has WhatsApp turned off`);
      }
      if (input.channel === "email" && input.templateId) {
        throw new MessagingError("BAD_SENDER_MODE", "Templates are for WhatsApp; send email with a body");
      }
      const replying = windowOn(input.merchantId, input.to, input.channel).open;
      const customer = customerAt(input.merchantId, input.channel, input.to);
      const consent = customer ? consentRow(customer.id, input.channel)?.status : undefined;
      if (!replying && consent === "opted_out") {
        throw new MessagingError("OPTED_OUT", `This customer opted out of ${input.channel === "whatsapp" ? "WhatsApp" : "email"} messages`);
      }

      let body = input.body;
      let withinWindow: boolean | null = null;
      if (input.channel === "whatsapp") {
        withinWindow = replying;
        if (input.templateId) body = renderTemplate(input.templateId, input.params);
        if (!withinWindow) {
          if (!input.templateId) {
            throw new MessagingError("WINDOW_CLOSED", "Outside the 24-hour window only an approved template can be sent");
          }
          if (consent !== "opted_in") {
            throw new MessagingError("NOT_OPTED_IN", "This customer has not opted in to WhatsApp messages");
          }
        }
      }

      return repo.messages.insert({
        id: newId("msg"),
        case_id: input.caseId ?? null,
        channel: input.channel,
        direction: "out",
        from,
        to: input.to,
        sender_mode: input.senderMode,
        body: body!,
        template_id: input.templateId ?? null,
        within_24h: withinWindow,
        at: clock.now(),
      });
    },

    async receive(raw) {
      const input = receiveInput.parse(raw);
      if (!repo.merchants.get(input.merchantId)) throw new MessagingError("UNKNOWN_ADDRESS", `Merchant ${input.merchantId} not found`);
      const mine = merchantAddresses(input.merchantId, input.channel);
      if (input.to && !mine.includes(input.to)) {
        throw new MessagingError("UNKNOWN_ADDRESS", `${input.to} is not a ${input.channel} address of ${input.merchantId}`);
      }
      const lastOut = thread(input.merchantId, input.from)
        .filter((m) => m.direction === "out")
        .at(-1);
      const to =
        input.to ??
        (lastOut?.channel === input.channel ? lastOut.from : address(input.merchantId, input.channel, "merchant_inbox")!);
      return repo.messages.insert({
        id: newId("msg"),
        case_id: lastOut?.case_id ?? null,
        channel: input.voice ? "voice_note" : input.channel,
        transcript: input.voice ? input.body : null,
        audio_ref: input.voice?.audioRef ?? null,
        duration_s: input.voice?.durationS ?? null,
        direction: "in",
        from: input.from,
        to,
        sender_mode: null,
        body: input.body,
        template_id: null,
        within_24h: null,
        at: clock.now(),
      });
    },

    window: (merchantId, customer) => windowOn(merchantId, customer, "whatsapp"),
    thread,

    inbox(customer) {
      return db
        .select()
        .from(s.messages)
        .where(or(eq(s.messages.to, customer), eq(s.messages.from, customer)))
        .orderBy(s.messages.at, insertOrder)
        .all();
    },

    senderAddress(merchantId, channel, mode) {
      const a = address(merchantId, channel, mode);
      if (!a) throw new MessagingError("BAD_SENDER_MODE", `${mode} cannot send on ${channel}`);
      return a;
    },

    senderLabel(addr) {
      const m = merchantOf(addr);
      if (!m) return addr;
      return addr.includes("razorpay") ? `${m.name} via Razorpay` : m.name;
    },

    setConsent(customerId, channel, status, source) {
      if (!repo.customers.get(customerId)) throw new MessagingError("UNKNOWN_ADDRESS", `Customer ${customerId} not found`);
      const existing = consentRow(customerId, channel);
      const fields = { status, source, updated_at: clock.now() };
      if (existing) repo.messagingConsents.update(existing.id, fields);
      else repo.messagingConsents.insert({ id: newId("cons"), customer_id: customerId, channel, ...fields });
    },
    consent(customerId, channel) {
      return consentRow(customerId, channel)?.status ?? null;
    },
  };
}

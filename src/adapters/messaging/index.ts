// Simulated in-app WhatsApp and email over the messages table.
// Sender modes: the merchant's own inbox, the merchant's verified domain
// (email only), or "Merchant via Razorpay" with replies routed back to the
// merchant's case. WhatsApp rules are enforced here: outside the 24-hour
// customer-service window only approved templates may be sent, and only to
// customers who opted in.
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import type { Clock } from "../clock";
import { newId } from "../ids";

export type Message = typeof s.messages.$inferSelect;
export type Channel = (typeof s.CHANNELS)[number];
export type SenderMode = (typeof s.SENDER_MODES)[number];

export const WINDOW_MS = 24 * 60 * 60 * 1000;

type Template = { status: "approved" | "pending" | "rejected"; body: string };

// Pre-approved WhatsApp templates. No links: a first message must carry
// checkable details only.
export const WHATSAPP_TEMPLATES: Record<string, Template> = {
  payment_received_check: {
    status: "approved",
    body: "Hi {{name}}, this is {{merchant}}. We got your payment of {{amount}} on {{date}} for order {{order}}. Reply YES and we will confirm your order.",
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
});
export type ReceiveInput = z.input<typeof receiveInput>;

export type MessagingErrorCode =
  | "WHATSAPP_OFF"
  | "BAD_SENDER_MODE"
  | "WINDOW_CLOSED"
  | "TEMPLATE_NOT_APPROVED"
  | "TEMPLATE_PARAMS"
  | "NOT_OPTED_IN"
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

export type MessagingSim = Messaging & {
  optIn(merchantId: string, phone: string): void;
  optOut(merchantId: string, phone: string): void;
  isOptedIn(merchantId: string, phone: string): boolean;
};

// Ties on the fake clock fall back to insert order.
const insertOrder = sql`rowid`;

const slug = (merchantId: string) => merchantId.replace(/^m_/, "").replace(/_/g, "-");

function address(merchantId: string, channel: Channel, mode: SenderMode): string | null {
  const m = slug(merchantId);
  if (channel === "whatsapp") {
    if (mode === "merchant_inbox") return `wa:${m}`;
    if (mode === "via_razorpay") return `wa:razorpay/${m}`;
    return null;
  }
  if (mode === "merchant_inbox") return `${m}.owner@mail.example.com`;
  if (mode === "verified_domain") return `orders@${m}.example.com`;
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
  const optedOut = new Set<string>();
  const optKey = (merchantId: string, phone: string) => `${merchantId}|${phone}`;

  const merchantAddresses = (merchantId: string, channel?: Channel) =>
    (channel ? [channel] : s.CHANNELS)
      .flatMap((c) => s.SENDER_MODES.map((mode) => address(merchantId, c, mode)))
      .filter((a): a is string => a !== null);

  const merchantOf = (addr: string) => repo.merchants.list().find((m) => merchantAddresses(m.id).includes(addr));

  const isOptedIn = (merchantId: string, phone: string) => {
    const known = db
      .select()
      .from(s.customers)
      .where(and(eq(s.customers.merchant_id, merchantId), eq(s.customers.phone, phone)))
      .get();
    return Boolean(known) && !optedOut.has(optKey(merchantId, phone));
  };

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

  const window = (merchantId: string, customer: string) => {
    const lastIn = db
      .select()
      .from(s.messages)
      .where(
        and(
          eq(s.messages.channel, "whatsapp"),
          eq(s.messages.direction, "in"),
          eq(s.messages.from, customer),
          inArray(s.messages.to, merchantAddresses(merchantId, "whatsapp")),
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
      const from = address(input.merchantId, input.channel, input.senderMode);
      if (!from) throw new MessagingError("BAD_SENDER_MODE", `${input.senderMode} cannot send on ${input.channel}`);

      let body = input.body;
      let withinWindow: boolean | null = null;
      if (input.channel === "whatsapp") {
        if (!merchant.whatsapp_on) throw new MessagingError("WHATSAPP_OFF", `${merchant.name} has WhatsApp turned off`);
        withinWindow = window(input.merchantId, input.to).open;
        if (input.templateId) body = renderTemplate(input.templateId, input.params);
        if (!withinWindow) {
          if (!input.templateId) {
            throw new MessagingError("WINDOW_CLOSED", "Outside the 24-hour window only an approved template can be sent");
          }
          if (!isOptedIn(input.merchantId, input.to)) {
            throw new MessagingError("NOT_OPTED_IN", "This customer has not opted in to WhatsApp messages");
          }
        }
      } else if (input.templateId) {
        throw new MessagingError("BAD_SENDER_MODE", "Templates are for WhatsApp; send email with a body");
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
        channel: input.channel,
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

    window,
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

    optIn(merchantId, phone) {
      optedOut.delete(optKey(merchantId, phone));
    },
    optOut(merchantId, phone) {
      optedOut.add(optKey(merchantId, phone));
    },
    isOptedIn,
  };
}

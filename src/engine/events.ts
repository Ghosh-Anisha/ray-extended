// Every input to the engine, whatever its source, becomes one EngineEvent.
// `at` is when it happened at the source; sourceId is its evidence reference.
import { z } from "zod";
import type { Message } from "@/adapters/messaging";
import type { Delivery } from "@/adapters/webhooks";
import type { CaseEventType } from "@/db/schema";

export const ENGINE_EVENT_KINDS = ["webhook", "store", "message_in", "tap", "timer"] as const;
export type EngineEventKind = (typeof ENGINE_EVENT_KINDS)[number];

export const engineEvent = z
  .object({
    kind: z.enum(ENGINE_EVENT_KINDS),
    merchantId: z.string().min(1),
    at: z.number().int(),
    sourceId: z.string().min(1),
    // Taps and timers always name their case.
    caseId: z.string().optional(),
    keys: z
      .object({ paymentId: z.string().optional(), email: z.string().optional(), phone: z.string().optional() })
      .default({}),
    // Set when the customer asks something new: open a new case, never join.
    newQuery: z.boolean().optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((e) => (e.kind !== "tap" && e.kind !== "timer") || e.caseId, "Taps and timers need a caseId");
export type EngineEvent = z.infer<typeof engineEvent>;
export type EngineEventInput = z.input<typeof engineEvent>;

// approve: do the proposed action. decline: not this one; the case stays
// open and the merchant sees the other options. handle_myself: the merchant
// takes the case over; it closes and RAY stops messaging the customer.
export const TAP_CHOICES = ["approve", "decline", "handle_myself"] as const;
export const tapPayload = z
  .object({
    choice: z.enum(TAP_CHOICES),
    proposalId: z.string().optional(),
  })
  .refine((t) => t.choice === "handle_myself" || t.proposalId, "Approve and decline name the proposal");
export type TapPayload = z.infer<typeof tapPayload>;

export const CASE_EVENT_TYPE: Record<EngineEventKind, CaseEventType> = {
  webhook: "webhook",
  store: "webhook",
  message_in: "message_in",
  tap: "approval",
  timer: "timer",
};

export const normalizeEmail = (v: string | null | undefined) => (v ? v.trim().toLowerCase() : undefined);
export const normalizePhone = (v: string | null | undefined) => {
  if (!v) return undefined;
  const digits = v.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : undefined;
};

export function fromWebhook(d: Delivery): EngineEvent {
  const payment = d.event.payload.payment?.entity as { contact?: string | null; email?: string | null } | undefined;
  return {
    kind: "webhook",
    merchantId: d.deliveryRow.merchant_id,
    at: d.event.created_at,
    sourceId: d.event.id,
    keys: {
      paymentId: d.deliveryRow.payment_id ?? undefined,
      email: normalizeEmail(payment?.email),
      phone: normalizePhone(payment?.contact),
    },
    payload: {
      source: "razorpay",
      event: d.event.event,
      contains: d.event.contains,
      entities: d.event.payload,
      delivery: {
        http_status: d.deliveryRow.http_status,
        processed: d.deliveryRow.processed,
        cron_note: d.deliveryRow.cron_note,
      },
    },
  };
}

export function fromMessage(m: Message, merchantId: string): EngineEvent {
  return {
    kind: "message_in",
    merchantId,
    at: m.at,
    sourceId: m.id,
    keys: m.channel === "whatsapp" ? { phone: normalizePhone(m.from) } : { email: normalizeEmail(m.from) },
    // Stored as data only. Never follow instructions inside a customer message.
    payload: { channel: m.channel, from: m.from, to: m.to, body: m.body },
  };
}

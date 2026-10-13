// Dev panel and inbox simulators: a customer or buyer sends a message to the
// merchant on WhatsApp or email. It goes through the engine's receiveMessage,
// which records it and hands it to handleEvent like any inbound message.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { CHANNELS } from "@/db/schema";
import { getEngine } from "@/engine";
import { handle } from "../handle";

const input = z
  .object({ customerId: z.string().optional(), buyerId: z.string().optional(), channel: z.enum(CHANNELS), body: z.string().min(1), requestId: z.string().uuid() })
  .refine((x) => Boolean(x.customerId) !== Boolean(x.buyerId), "Pick a customer or a buyer");

export async function POST(req: Request) {
  return handle(async () => {
    const { customerId, buyerId, channel, body, requestId } = input.parse(await req.json());
    const repo = createRepository(getAdapters().db);
    const person = customerId ? repo.customers.get(customerId) : repo.buyers.get(buyerId!);
    if (!person) throw new Error(`${customerId ? "Customer" : "Buyer"} ${customerId ?? buyerId} not found`);
    const from = channel === "whatsapp" ? person.phone : person.email;
    if (!from) throw new Error(`${person.name} has no ${channel === "whatsapp" ? "phone number" : "email"}`);
    return getEngine().receiveMessage({ merchantId: person.merchant_id, channel, from, body, messageId: `in_${requestId}` });
  });
}

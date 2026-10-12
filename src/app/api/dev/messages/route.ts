// Dev panel: a customer sends a message to the merchant on WhatsApp or email.
// It goes through the engine's receiveMessage, which records it and hands it
// to handleEvent like any inbound message.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { CHANNELS } from "@/db/schema";
import { getEngine } from "@/engine";
import { handle } from "../handle";

const input = z.object({ customerId: z.string(), channel: z.enum(CHANNELS), body: z.string().min(1) });

export async function POST(req: Request) {
  return handle(async () => {
    const { customerId, channel, body } = input.parse(await req.json());
    const a = getAdapters();
    const customer = createRepository(a.db).customers.get(customerId);
    if (!customer) throw new Error(`Customer ${customerId} not found`);
    const from = channel === "whatsapp" ? customer.phone : customer.email;
    if (!from) throw new Error(`${customer.name} has no ${channel === "whatsapp" ? "phone number" : "email"}`);
    return getEngine().receiveMessage({ merchantId: customer.merchant_id, channel, from, body });
  });
}

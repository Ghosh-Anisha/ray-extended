// Customer and buyer inboxes: a person sends the merchant a WhatsApp voice
// note (a recorded sample, or audio transcribed live on ElevenLabs). It goes
// through the engine's receiveVoiceNote, which hands it to handleEvent like
// any inbound message.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { getEngine } from "@/engine";
import { readVoiceForm } from "../../voice-form";
import { handle } from "../handle";

const input = z
  .object({ customerId: z.string().optional(), buyerId: z.string().optional(), sampleId: z.string().optional(), requestId: z.string().uuid() })
  .refine((x) => Boolean(x.customerId) !== Boolean(x.buyerId), "Pick a customer or a buyer");

export async function POST(req: Request) {
  return handle(async () => {
    const { fields, audio } = await readVoiceForm(req);
    const { customerId, buyerId, sampleId, requestId } = input.parse(fields);
    const repo = createRepository(getAdapters().db);
    const person = customerId ? repo.customers.get(customerId) : repo.buyers.get(buyerId!);
    if (!person) throw new Error(`${customerId ? "Customer" : "Buyer"} ${customerId ?? buyerId} not found`);
    if (!person.phone) throw new Error(`${person.name} has no phone number for WhatsApp`);
    const r = await getEngine().receiveVoiceNote({ merchantId: person.merchant_id, from: person.phone, audio, sampleId, messageId: `in_${requestId}` });
    return { outcome: r.outcome, caseId: "caseId" in r ? r.caseId : null, messageId: r.messageId, transcript: r.transcript };
  });
}

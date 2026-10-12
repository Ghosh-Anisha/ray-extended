// The merchant replies to RAY on WhatsApp by voice. RAY sends back the
// approval card; the voice note never approves anything (rule 13).
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { merchantVoiceNote } from "@/surfaces/voice";
import { readVoiceForm } from "../../voice-form";
import { handle } from "../../dev/handle";

const input = z.object({ merchantId: z.string().min(1), caseId: z.string().optional(), sampleId: z.string().optional() });

export async function POST(req: Request) {
  return handle(async () => {
    const { fields, audio } = await readVoiceForm(req);
    const r = await merchantVoiceNote(getAdapters(), { ...input.parse(fields), audio });
    return { caseId: r.caseId, transcript: r.transcript, pointsTo: r.pointsTo };
  });
}

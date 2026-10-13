// The morning list's controls: run today's chase (one event per buyer) and
// log the merchant's own note on a case. Both go to handleEvent.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { collectMorningRun, logMerchantNote } from "@/flows/collect/run";
import { handle } from "../../dev/handle";

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("morning"), merchantId: z.string().min(1) }),
  z.object({ action: z.literal("note"), merchantId: z.string().min(1), caseId: z.string().min(1), text: z.string().trim().min(1).max(300) }),
]);

export async function POST(req: Request) {
  return handle(async () => {
    const x = input.parse(await req.json());
    if (x.action === "morning") {
      const results = await collectMorningRun(getEngine(), getAdapters(), x.merchantId);
      return { outcome: results.length ? "handled" : "nothing", buyers: results.length };
    }
    const r = await logMerchantNote(getEngine(), getAdapters(), x);
    return { outcome: r.outcome };
  });
}

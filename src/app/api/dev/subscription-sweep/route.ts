// Dev panel: check Razorpay for sign-ups whose AutoPay was never set up
// (Step 9, situation A). Each one 30 minutes old goes through handleEvent.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { setupSweep } from "@/flows/subscriptions/sweep";
import { handle } from "../handle";

const input = z.object({ merchantId: z.string() });

export async function POST(req: Request) {
  return handle(async () => {
    const { merchantId } = input.parse(await req.json());
    const results = await setupSweep(getEngine(), getAdapters(), merchantId);
    const first = results.find((r) => "caseId" in r);
    return { outcome: results.length ? "handled" : "nothing", found: results.length, caseId: first && "caseId" in first ? first.caseId : null };
  });
}

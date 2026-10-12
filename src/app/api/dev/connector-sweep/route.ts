// Dev panel: run the store connector's sweep for a merchant. Each pending
// order with a captured payment goes through handleEvent.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { connectorSweep } from "@/flows/paid-no-order/sweep";
import { handle } from "../handle";

const input = z.object({ merchantId: z.string() });

export async function POST(req: Request) {
  return handle(async () => {
    const { merchantId } = input.parse(await req.json());
    const results = await connectorSweep(getEngine(), getAdapters(), merchantId);
    const first = results.find((r) => "caseId" in r);
    return { outcome: results.length ? "handled" : "nothing", found: results.length, caseId: first && "caseId" in first ? first.caseId : null };
  });
}

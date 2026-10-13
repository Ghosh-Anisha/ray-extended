// Home's proactive cards: Turn on / Not now, and dismissing the Collect card.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { dismissChase, setEmi } from "@/surfaces/grow";
import { handle } from "../../dev/handle";

const input = z.object({ merchantId: z.string(), card: z.enum(["emi", "chase"]), choice: z.enum(["on", "not_now"]) });

export async function POST(req: Request) {
  return handle(async () => {
    const i = input.parse(await req.json());
    const a = getAdapters();
    if (i.card === "emi") setEmi(a, i.merchantId, i.choice);
    else dismissChase(a, i.merchantId);
    return {};
  });
}

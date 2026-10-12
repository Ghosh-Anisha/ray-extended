// Dev panel: the kill switch, per merchant or global. It blocks every act
// tool; reads still work.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { setKillSwitch } from "@/guards";
import { handle } from "../handle";

const input = z.object({ scope: z.union([z.literal("global"), z.object({ merchantId: z.string() })]), on: z.boolean() });

export async function POST(req: Request) {
  return handle(async () => {
    const { scope, on } = input.parse(await req.json());
    const a = getAdapters();
    setKillSwitch(a.db, a.clock, scope, on);
    return { on };
  });
}

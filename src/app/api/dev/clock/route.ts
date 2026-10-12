// Dev panel: move the fake clock forward, stopping at each due timer or held
// action (the refund hold) so each runs at its own due time, in order.
// Refused when the app runs on the real clock.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { handle } from "../handle";

const input = z.object({ ms: z.number().int().positive().max(30 * 24 * 3_600_000) });

export async function POST(req: Request) {
  return handle(async () => {
    const a = getAdapters();
    if (a.clockMode !== "fake") throw new Error("The clock can only be moved when the fake clock is on");
    const { ms } = input.parse(await req.json());
    const { now, fired, released } = await getEngine().advanceBy(ms);
    return { now, fired, released };
  });
}

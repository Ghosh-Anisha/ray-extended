// Dev panel: move the fake clock forward, then run the tick so due timers
// fire in due-time order. Refused when the app runs on the real clock.
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
    a.clock.advance(ms);
    const { fired } = await getEngine().tick();
    return { now: a.clock.now(), fired };
  });
}

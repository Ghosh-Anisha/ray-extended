// Call screen: how a simulated callee answers RAY's next call.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { CALL_OUTCOMES } from "@/db/schema";
import { handle } from "../handle";

const input = z.object({
  callee: z.string().min(3),
  outcome: z.enum(CALL_OUTCOMES),
  reply: z.string().max(200).optional(),
  promise: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { callee, ...sim } = input.parse(await req.json());
    return getAdapters().voice.setCallSim(callee, sim);
  });
}

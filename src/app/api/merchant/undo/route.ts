// Undo a held refund inside its 10 minutes, or Stop an automatic dispute lane.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { undo } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

const input = z.object({ merchantId: z.string(), actionId: z.string() });

export async function POST(req: Request) {
  return handle(async () => {
    const { merchantId, actionId } = input.parse(await req.json());
    const r = await undo(getAdapters(), merchantId, actionId);
    if (!r.ok) throw new Error(r.reason);
    return { actionId };
  });
}

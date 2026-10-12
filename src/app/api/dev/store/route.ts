// Dev panel: switch a simulated store's plugin failure.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { STORE_FAILURES } from "@/adapters/store";
import { handle } from "../handle";

const input = z.object({ merchantId: z.string(), failure: z.enum(STORE_FAILURES) });

export async function POST(req: Request) {
  return handle(async () => {
    const { merchantId, failure } = input.parse(await req.json());
    getAdapters().store.setFailure(merchantId, failure);
    return { merchantId, failure };
  });
}

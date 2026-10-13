// Ask RAY: one question or rule request in, one grounded reply out.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { ask } from "@/ask/answer";
import { handle } from "../../dev/handle";

const input = z.object({ merchantId: z.string(), text: z.string().max(400), caseId: z.string().nullish() });

export async function POST(req: Request) {
  return handle(async () => {
    const { merchantId, text, caseId } = input.parse(await req.json());
    return ask(getAdapters(), merchantId, text, caseId ?? null);
  });
}

// "Let RAY fix these" on the free alerts.
import { z } from "zod";
import { getAdapters } from "@/adapters";
import { letRayFix } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

const input = z.object({ merchantId: z.string() });

export async function POST(req: Request) {
  return handle(async () => {
    const { merchantId } = input.parse(await req.json());
    letRayFix(getAdapters(), merchantId);
    return { merchantId };
  });
}

// Dev panel: fire any simulated Razorpay webhook.
import { getAdapters } from "@/adapters";
import { handle } from "../handle";

export async function POST(req: Request) {
  return handle(async () => {
    const d = await getAdapters().webhooks.emit(await req.json());
    return d.deliveryRow;
  });
}

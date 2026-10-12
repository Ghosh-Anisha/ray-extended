// Dev panel: fire a simulated Razorpay webhook. The sim writes the
// webhook_deliveries row and pushes the event to the engine's handleEvent,
// the same path every webhook takes.
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { handle } from "../handle";

export async function POST(req: Request) {
  return handle(async () => {
    getEngine(); // subscribes the engine to webhooks before the first emit
    const d = await getAdapters().webhooks.emit(await req.json());
    return d.deliveryRow;
  });
}

// Dev panel: fire a simulated Razorpay webhook. The sim writes the
// webhook_deliveries row and pushes the event to the engine's handleEvent,
// the same path every webhook takes.
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { getEngine } from "@/engine";
import { handle } from "../handle";

export async function POST(req: Request) {
  return handle(async () => {
    getEngine(); // subscribes the engine to webhooks before the first emit
    const a = getAdapters();
    const d = await a.webhooks.emit(await req.json());
    // Re-read: the engine marks the row with its case, or why none took it.
    const delivery = createRepository(a.db).webhookDeliveries.get(d.event.id)!;
    return {
      outcome: delivery.unmatched_reason ? "unmatched" : "handled",
      caseId: delivery.handled_case_id,
      delivery,
    };
  });
}

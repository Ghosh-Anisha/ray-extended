// Checkout abroad simulator (Step 8): every button reaches the engine the way
// a real event does, through the webhook sim or handleEvent.
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { runSimAction } from "@/flows/international/sim-actions";
import { handle } from "../handle";

export async function POST(req: Request) {
  return handle(async () => {
    const engine = getEngine(); // subscribes the engine to webhooks before the first emit
    return runSimAction(engine, getAdapters(), await req.json());
  });
}

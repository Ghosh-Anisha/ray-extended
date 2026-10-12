// Fires every timer that is due on the engine's clock, earliest first.
import { getEngine } from "@/engine";

export async function POST() {
  try {
    return Response.json({ ok: true, result: await getEngine().tick() });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}

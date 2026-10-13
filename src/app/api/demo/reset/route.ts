// Reset demo: a fresh database, seeded again. The Demo controls drawer calls it.
import { resetDemoWorld } from "@/demo/world";

export async function POST() {
  try {
    await resetDemoWorld();
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Reset failed" }, { status: 500 });
  }
}

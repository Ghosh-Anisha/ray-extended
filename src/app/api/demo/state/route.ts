// Demo controls: the clock, the kill switch and the ids of the cases the
// chapters jump to.
import { getAdapters } from "@/adapters";
import { demoState, ensureDemoWorld } from "@/demo/world";
import { heroCases } from "@/surfaces/refs";
import { DEFAULT_ACCOUNT } from "@/ui/shell/nav";
import { dateTime } from "@/surfaces/format";

export async function GET() {
  await ensureDemoWorld();
  const a = getAdapters();
  const st = demoState(a);
  return Response.json({ ...st, nowLabel: dateTime(st.now), merchantId: DEFAULT_ACCOUNT, cases: heroCases(a, DEFAULT_ACCOUNT) });
}

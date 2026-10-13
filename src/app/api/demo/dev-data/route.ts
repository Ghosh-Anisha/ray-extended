import { getAdapters } from "@/adapters";
import { ensureDemoWorld } from "@/demo/world";
import { devData } from "@/surfaces/dev-data";

export async function GET() {
  await ensureDemoWorld();
  return Response.json(devData(getAdapters()));
}

// My dashboard: setup, widgets, reports and schedules.
import { getAdapters } from "@/adapters";
import { dashboardAction } from "@/surfaces/dashboard-actions";
import { handle } from "../../dev/handle";

export async function POST(req: Request) {
  return handle(async () => dashboardAction(getAdapters(), await req.json()));
}

// Pre-call notice: Cancel call.
import { getAdapters } from "@/adapters";
import { cancelCall } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

export async function POST(req: Request) {
  return handle(async () => ({ caseId: cancelCall(getAdapters(), await req.json()).case_id }));
}

// Change: the merchant's free text, recorded on the case.
import { getAdapters } from "@/adapters";
import { requestChange } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

export async function POST(req: Request) {
  return handle(async () => ({ caseId: requestChange(getAdapters(), await req.json()).case_id }));
}

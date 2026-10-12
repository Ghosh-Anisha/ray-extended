// Change: the merchant's free text, sent through the engine so the flow
// redrafts and the same card comes back.
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { requestChange } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

export async function POST(req: Request) {
  return handle(async () => {
    const r = await requestChange(getEngine(), getAdapters(), await req.json());
    return { caseId: "caseId" in r ? r.caseId : null };
  });
}

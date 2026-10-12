// A merchant's tap (Approve, a secondary option, I'll handle this myself),
// from the case page or the WhatsApp card. It goes to handleEvent like every
// other event.
import { getAdapters } from "@/adapters";
import { getEngine } from "@/engine";
import { tap } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

export async function POST(req: Request) {
  return handle(async () => {
    const r = await tap(getEngine(), getAdapters(), await req.json());
    return { outcome: r.outcome, caseId: "caseId" in r ? r.caseId : null };
  });
}

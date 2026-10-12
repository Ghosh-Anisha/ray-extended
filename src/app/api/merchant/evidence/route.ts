// "Show evidence": the raw record behind a finding or timeline event.
import { getAdapters } from "@/adapters";
import { evidence } from "@/surfaces/views";
import { handle } from "../../dev/handle";

export async function GET(req: Request) {
  return handle(async () => {
    const url = new URL(req.url);
    const merchantId = url.searchParams.get("merchantId") ?? "";
    const ref = url.searchParams.get("ref") ?? "";
    const record = evidence(getAdapters(), merchantId, ref);
    if (!record) throw new Error("No record found for this evidence.");
    return record;
  });
}

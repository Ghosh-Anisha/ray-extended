// Playbook: the merchant's approval limit (the amount cap guard reads it).
import { getAdapters } from "@/adapters";
import { setApprovalLimit } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

export async function POST(req: Request) {
  return handle(async () => setApprovalLimit(getAdapters(), await req.json()));
}

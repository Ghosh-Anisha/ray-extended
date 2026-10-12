// Playbook: approve a rule, turn it off, or leave it for now.
import { getAdapters } from "@/adapters";
import { setRuleStatus } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

export async function POST(req: Request) {
  return handle(async () => setRuleStatus(getAdapters(), await req.json()));
}

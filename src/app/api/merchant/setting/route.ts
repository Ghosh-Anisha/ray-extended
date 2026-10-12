// Playbook: tone, sign-off, send-from and automatic customer messages.
import { getAdapters } from "@/adapters";
import { setSetting } from "@/surfaces/actions";
import { handle } from "../../dev/handle";

export async function POST(req: Request) {
  return handle(async () => setSetting(getAdapters(), await req.json()));
}

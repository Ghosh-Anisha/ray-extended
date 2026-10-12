import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { callScreen } from "@/surfaces/sims";
import { CallScreen } from "@/ui/sim/calls";

export default async function CallsPage() {
  await connection();
  return <CallScreen v={callScreen(getAdapters())} />;
}

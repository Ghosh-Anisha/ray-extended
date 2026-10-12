import { connection } from "next/server";
import { callScreen } from "@/surfaces/sims";
import { CallScreen } from "@/ui/sim/calls";

export default async function CallsPage() {
  await connection();
  return <CallScreen calls={callScreen()} />;
}

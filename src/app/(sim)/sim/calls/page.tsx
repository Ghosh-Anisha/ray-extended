import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { callScreen } from "@/surfaces/sims";
import { CallScreen } from "@/ui/sim/calls";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function CallsPage() {
  await connection();
  return (
    <>
      <Breadcrumbs trail={[{ label: "See it from the other side" }, { label: "Calls" }]} />
      <CallScreen v={callScreen(getAdapters())} />
    </>
  );
}

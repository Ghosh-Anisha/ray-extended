import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { customerInbox, voiceSamples } from "@/surfaces/sims";
import { PeopleInbox } from "@/ui/sim/inbox";
import { currentAccount } from "@/ui/shell/account";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function CustomerInboxPage() {
  await connection();
  const a = getAdapters();
  return (
    <>
      <Breadcrumbs trail={[{ label: "See it from the other side" }, { label: "Customer inbox" }]} />
      <PeopleInbox title="Customer inbox" kind="customer" people={customerInbox(a, await currentAccount())} voiceSamples={voiceSamples("customer")} voiceLive={a.voice.live} />
    </>
  );
}

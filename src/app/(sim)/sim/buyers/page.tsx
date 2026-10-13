import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { buyerInbox, voiceSamples } from "@/surfaces/sims";
import { PeopleInbox } from "@/ui/sim/inbox";
import { currentAccount } from "@/ui/shell/account";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";

export default async function BuyerInboxPage() {
  await connection();
  const a = getAdapters();
  return (
    <>
      <Breadcrumbs trail={[{ label: "See it from the other side" }, { label: "Buyer inbox" }]} />
      <PeopleInbox title="Buyer inbox" kind="buyer" people={buyerInbox(a, await currentAccount())} voiceSamples={voiceSamples("buyer")} voiceLive={a.voice.live} />
    </>
  );
}

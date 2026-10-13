import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { buyerInbox, voiceSamples } from "@/surfaces/sims";
import { PeopleInbox } from "@/ui/sim/inbox";
import { currentAccount } from "@/ui/shell/account";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";
import { NudgeBar } from "@/ui/nudge";

export default async function BuyerInboxPage() {
  await connection();
  const a = getAdapters();
  return (
    <>
      <Breadcrumbs trail={[{ label: "See it from the other side" }, { label: "Buyer inbox" }]} />
      <PeopleInbox title="Buyer inbox" kind="buyer" people={buyerInbox(a, await currentAccount())} voiceSamples={voiceSamples("buyer")} voiceLive={a.voice.live} />
      <NudgeBar text="Acme's promise is logged against its invoice." action={{ label: "Open cases", href: `/merchant/${await currentAccount()}/cases` }} />
    </>
  );
}

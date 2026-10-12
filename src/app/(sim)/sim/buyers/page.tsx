import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { buyerInbox, voiceSamples } from "@/surfaces/sims";
import { PeopleInbox } from "@/ui/sim/inbox";

export default async function BuyerInboxPage() {
  await connection();
  return <PeopleInbox title="Buyer inbox" kind="buyer" people={buyerInbox(getAdapters())} voiceSamples={voiceSamples("buyer")} voiceLive={getAdapters().voice.live} />;
}

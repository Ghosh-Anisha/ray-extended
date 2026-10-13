import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { customerInbox, voiceSamples } from "@/surfaces/sims";
import { PeopleInbox } from "@/ui/sim/inbox";
import { currentAccount } from "@/ui/shell/account";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";
import { NudgeBar } from "@/ui/nudge";

export default async function CustomerInboxPage({ searchParams }: { searchParams: Promise<{ person?: string }> }) {
  await connection();
  const { person } = await searchParams;
  const a = getAdapters();
  return (
    <>
      <Breadcrumbs trail={[{ label: "See it from the other side" }, { label: "Customer inbox" }]} />
      <PeopleInbox title="Customer inbox" kind="customer" people={customerInbox(a, await currentAccount())} initialPersonId={person} voiceSamples={voiceSamples("customer")} voiceLive={a.voice.live} />
      <NudgeBar text="See the customer thread, then send a quick reply." action={{ label: "Open Cases", href: `/merchant/${await currentAccount()}/cases` }} />
    </>
  );
}

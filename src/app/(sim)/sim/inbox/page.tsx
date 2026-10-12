import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { customerInbox } from "@/surfaces/sims";
import { PeopleInbox } from "@/ui/sim/inbox";

export default async function CustomerInboxPage() {
  await connection();
  return <PeopleInbox title="Customer inbox" kind="customer" people={customerInbox(getAdapters())} />;
}

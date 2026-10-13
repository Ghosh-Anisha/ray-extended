import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { STORE_FAILURES } from "@/adapters/store";
import { storeAdmin } from "@/surfaces/sims";
import { StoreAdmin } from "@/ui/sim/store";
import { currentAccount } from "@/ui/shell/account";
import { Breadcrumbs } from "@/ui/shell/breadcrumbs";
import { NudgeBar } from "@/ui/nudge";

export default async function StoreAdminPage() {
  await connection();
  const a = getAdapters();
  const stores = storeAdmin(a, await currentAccount());
  return (
    <>
      <Breadcrumbs trail={[{ label: "See it from the other side" }, { label: "Store admin" }]} />
      <StoreAdmin stores={stores.length ? stores : storeAdmin(a)} failures={[...STORE_FAILURES]} />
      <NudgeBar text="Order #1234 is the paid order the store missed." action={{ label: "Open Priya's case", href: `/merchant/${await currentAccount()}/cases` }} />
    </>
  );
}

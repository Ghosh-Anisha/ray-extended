import { connection } from "next/server";
import { getAdapters } from "@/adapters";
import { STORE_FAILURES } from "@/adapters/store";
import { storeAdmin } from "@/surfaces/sims";
import { StoreAdmin } from "@/ui/sim/store";

export default async function StoreAdminPage() {
  await connection();
  return <StoreAdmin stores={storeAdmin(getAdapters())} failures={[...STORE_FAILURES]} />;
}

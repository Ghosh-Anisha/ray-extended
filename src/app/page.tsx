import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ensureDemoWorld } from "@/demo/world";
import { currentAccount } from "@/ui/shell/account";

// No link list: the app opens on Home for the saved account (Leafy Bakes).
export default async function Root() {
  await connection();
  await ensureDemoWorld();
  redirect(`/merchant/${await currentAccount()}`);
}

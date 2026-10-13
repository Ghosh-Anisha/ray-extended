import { redirect } from "next/navigation";
import { currentAccount } from "@/ui/shell/account";

// The old dev panel is now the Demo controls drawer on Home.
export default async function DevRedirect() {
  redirect(`/merchant/${await currentAccount()}?controls=1`);
}

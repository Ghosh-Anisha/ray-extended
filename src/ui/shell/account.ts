// The saved account for pages that are not under /merchant/<id> (the
// simulators): the account switcher keeps it in a cookie.
import { cookies } from "next/headers";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { ACCOUNT_COOKIE, DEFAULT_ACCOUNT } from "./nav";

export async function currentAccount(): Promise<string> {
  const saved = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  return saved && createRepository(getAdapters().db).merchants.get(saved) ? saved : DEFAULT_ACCOUNT;
}

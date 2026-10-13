// The merchant area. The shell around it (top bar, left nav, account
// switcher) comes from the root layout; this only checks the account exists.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";

export default async function MerchantLayout({ children, params }: { children: ReactNode; params: Promise<{ merchantId: string }> }) {
  await connection();
  const { merchantId } = await params;
  if (!createRepository(getAdapters().db).merchants.get(merchantId)) notFound();
  return <>{children}</>;
}

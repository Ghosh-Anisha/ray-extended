// The merchant area: a mock of Razorpay's dashboard with the top bar,
// account picker and View: Phone | Desktop switch.
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { getAdapters } from "@/adapters";
import { merchantList } from "@/surfaces/views";
import { MerchantTopBar } from "@/ui/merchant/top-bar";

export default async function MerchantLayout({ children, params }: { children: ReactNode; params: Promise<{ merchantId: string }> }) {
  await connection();
  const { merchantId } = await params;
  const merchants = merchantList(getAdapters());
  if (!merchants.some((m) => m.id === merchantId)) notFound();
  return (
    <>
      <MerchantTopBar merchantId={merchantId} merchants={merchants} />
      {children}
    </>
  );
}

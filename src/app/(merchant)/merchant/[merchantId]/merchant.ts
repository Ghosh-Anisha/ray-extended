// Pages render alongside the layout, so each checks the merchant itself.
import { notFound } from "next/navigation";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { restoreDemoDashboardIfMissing } from "@/surfaces/dashboard-actions";

export async function merchantParam(params: Promise<{ merchantId: string }>) {
  const { merchantId } = await params;
  const a = getAdapters();
  if (!createRepository(a.db).merchants.get(merchantId)) notFound();
  restoreDemoDashboardIfMissing(a, merchantId);
  return { a, merchantId };
}

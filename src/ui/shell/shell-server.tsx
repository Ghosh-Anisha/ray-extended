// Reads what the shell needs once per request: the accounts, how many cases
// need each, and the saved account. Seeding happens before this, never per
// request (ensureDemoWorld is a no-op after the first call).
import { sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { getAdapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import { ensureDemoWorld } from "@/demo/world";
import * as s from "@/db/schema";
import { ACCOUNT_COOKIE, DEFAULT_ACCOUNT } from "./nav";
import { Shell, type ShellMerchant } from "./shell";

export async function ShellServer({ children }: { children: ReactNode }) {
  await connection();
  await ensureDemoWorld();
  const a = getAdapters();
  const counts = new Map(
    a.db
      .select({ merchantId: s.cases.merchant_id, n: sql<number>`count(*)` })
      .from(s.cases)
      .where(sql`${s.cases.state} = 'waiting_merchant'`)
      .groupBy(s.cases.merchant_id)
      .all()
      .map((r) => [r.merchantId, r.n]),
  );
  const merchants: ShellMerchant[] = createRepository(a.db)
    .merchants.list()
    .map((m) => ({ id: m.id, name: m.name, needsYou: counts.get(m.id) ?? 0 }))
    // The demo account first, then the rest by name.
    .sort((x, y) => (x.id === DEFAULT_ACCOUNT ? -1 : y.id === DEFAULT_ACCOUNT ? 1 : x.name.localeCompare(y.name)));
  const saved = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  const defaultMerchantId = merchants.some((m) => m.id === saved) ? saved! : DEFAULT_ACCOUNT;
  return (
    <Shell merchants={merchants} defaultMerchantId={defaultMerchantId}>
      {children}
    </Shell>
  );
}

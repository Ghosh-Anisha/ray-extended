// What the simulators show: the customer inbox, the buyer inbox, the store
// admin and the call screen. All of them are simulated systems.
import { desc, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { dateTime, money } from "./format";

export type Thread = { id: string; at: string; direction: "in" | "out"; channel: "WhatsApp" | "Email"; with: string; body: string };
export type Person = { id: string; name: string; merchant: string; merchantId: string; phone: string | null; email: string | null; whatsapp: string; messages: Thread[] };

function threadFor(a: Adapters, addresses: (string | null)[]): Thread[] {
  const seen = new Set<string>();
  const out: (Thread & { ms: number })[] = [];
  for (const addr of addresses) {
    if (!addr) continue;
    for (const m of a.messaging.inbox(addr)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      // From the person's side: "in" is what they received.
      const received = m.to === addr;
      out.push({
        id: m.id,
        ms: m.at,
        at: dateTime(m.at),
        direction: received ? "in" : "out",
        channel: m.channel === "whatsapp" ? "WhatsApp" : "Email",
        with: a.messaging.senderLabel(received ? m.from : m.to),
        body: m.body,
      });
    }
  }
  out.sort((x, y) => x.ms - y.ms);
  return out.map((t) => ({ id: t.id, at: t.at, direction: t.direction, channel: t.channel, with: t.with, body: t.body }));
}

export function customerInbox(a: Adapters): Person[] {
  const repo = createRepository(a.db);
  const merchants = new Map(repo.merchants.list().map((m) => [m.id, m.name]));
  return repo.customers.list().map((c) => ({
    id: c.id,
    name: c.name,
    merchant: merchants.get(c.merchant_id) ?? c.merchant_id,
    merchantId: c.merchant_id,
    phone: c.phone,
    email: c.email,
    whatsapp: a.messaging.consent(c.id, "whatsapp") ?? "no consent on file",
    messages: threadFor(a, [c.phone, c.email]),
  }));
}

export function buyerInbox(a: Adapters): Person[] {
  const repo = createRepository(a.db);
  const merchants = new Map(repo.merchants.list().map((m) => [m.id, m.name]));
  return repo.buyers.list().map((b) => ({
    id: b.id,
    name: `${b.contact_name}, ${b.name}`,
    merchant: merchants.get(b.merchant_id) ?? b.merchant_id,
    merchantId: b.merchant_id,
    phone: b.phone,
    email: b.email,
    whatsapp: "",
    messages: threadFor(a, [b.phone, b.email]),
  }));
}

export type StoreView = {
  merchantId: string;
  name: string;
  plugin: string;
  failure: string;
  orders: { id: string; number: string; status: string; total: string; payment: string | null; history: string[] }[];
  products: { sku: string; name: string; price: string; stock: number }[];
};

export function storeAdmin(a: Adapters): StoreView[] {
  const repo = createRepository(a.db);
  return repo.merchants
    .list()
    .filter((m) => a.store.hasStore(m.id))
    .map((m) => {
      const settings = repo.storeSettings.get(m.id);
      return {
        merchantId: m.id,
        name: m.name,
        plugin: settings ? `${settings.plugin} ${settings.plugin_version}` : "",
        failure: a.store.failure(m.id),
        orders: a.db
          .select()
          .from(s.storeOrders)
          .where(eq(s.storeOrders.merchant_id, m.id))
          .orderBy(desc(s.storeOrders.created_at))
          .all()
          .map((o) => ({
            id: o.id,
            number: `#${o.number}`,
            status: o.status,
            total: money(o.total),
            payment: o.payment_id,
            history: o.status_history.map((h) => `${dateTime(h.at)} · ${h.status}${h.note ? ` · ${h.note}` : ""}`),
          })),
        products: repo.products.list(eq(s.products.merchant_id, m.id)).map((p) => ({ sku: p.sku, name: p.name, price: money(p.price), stock: p.stock })),
      };
    });
}

// Calls arrive with Step 5b (voice). Until then there are none to show.
export type CallView = { id: string; title: string; outcome: string; transcript: string[]; summary: string };
export function callScreen(): CallView[] {
  return [];
}

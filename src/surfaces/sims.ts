// What the simulators show: the customer inbox, the buyer inbox, the store
// admin and the call screen. All of them are simulated systems.
import { desc, eq } from "drizzle-orm";
import type { Adapters } from "@/adapters";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { OUTCOME_LABEL, VOICE_SAMPLES, type VoiceSample } from "@/adapters/voice";
import { allCalls, callView, voiceNoteView, type CallView, type VoiceNoteView } from "./calls";
import { dateTime, money, orderLabel } from "./format";
import { CHANNEL_LABEL } from "./views";

export type Thread = {
  id: string;
  at: string;
  direction: "in" | "out";
  channel: string;
  with: string;
  body: string;
  voice: VoiceNoteView | null;
  call: CallView | null;
};
export type Person = { id: string; name: string; merchant: string; merchantId: string; phone: string | null; email: string | null; whatsapp: string; messages: Thread[] };

function threadFor(a: Adapters, addresses: (string | null)[]): Thread[] {
  const seen = new Set<string>();
  const out: { ms: number; t: Thread }[] = [];
  for (const addr of addresses) {
    if (!addr) continue;
    for (const m of a.messaging.inbox(addr)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      // From the person's side: "in" is what they received.
      const received = m.to === addr;
      out.push({ ms: m.at, t: {
        id: m.id,
        at: dateTime(m.at),
        direction: received ? "in" : "out",
        channel: CHANNEL_LABEL[m.channel],
        with: m.channel === "call" ? callView(a, m).merchant : a.messaging.senderLabel(received ? m.from : m.to),
        body: m.body,
        voice: m.channel === "voice_note" ? voiceNoteView(m) : null,
        call: m.channel === "call" ? callView(a, m) : null,
      } });
    }
  }
  out.sort((x, y) => x.ms - y.ms);
  return out.map((x) => x.t);
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
            number: orderLabel(o.number),
            status: o.status,
            total: money(o.total),
            payment: o.payment_id,
            history: o.status_history.map((h) => `${dateTime(h.at)} · ${h.status}${h.note ? ` · ${h.note}` : ""}`),
          })),
        products: repo.products.list(eq(s.products.merchant_id, m.id)).map((p) => ({ sku: p.sku, name: p.name, price: money(p.price), stock: p.stock })),
      };
    });
}

// The call screen: every call RAY placed, and how each simulated callee
// answers the next call (call_sims).
export type { CallView } from "./calls";
export type CalleeSim = { callee: string; name: string; merchant: string; consent: string; outcome: string; reply: string; promise: string };
export type CallScreenView = { calls: CallView[]; callees: CalleeSim[]; outcomes: { value: string; label: string }[]; live: boolean };

export function callScreen(a: Adapters): CallScreenView {
  const repo = createRepository(a.db);
  const merchants = new Map(repo.merchants.list().map((m) => [m.id, m.name]));
  return {
    calls: allCalls(a),
    callees: repo.customers
      .list()
      .filter((c) => c.phone)
      .map((c) => {
        const sim = a.voice.callSim(c.phone!);
        const consent = a.messaging.consent(c.id, "call");
        return {
          callee: c.phone!,
          name: c.name,
          merchant: merchants.get(c.merchant_id) ?? c.merchant_id,
          consent: consent === "opted_in" ? "Opted in to calls" : consent === "opted_out" ? "Asked not to be called" : "No call consent",
          outcome: sim?.outcome ?? "answered",
          reply: sim?.reply ?? "",
          promise: sim?.promise ?? "",
        };
      }),
    outcomes: Object.entries(OUTCOME_LABEL).map(([value, label]) => ({ value, label })),
    live: a.voice.live,
  };
}

export const voiceSamples = (who: VoiceSample["who"]) => Object.values(VOICE_SAMPLES).filter((x) => x.who === who).map((x) => ({ id: x.id, label: x.label }));

// Step 11 seed: PackRight's buyers' consents. Buyers need an opt-in row on
// every channel (email, WhatsApp, call). A mix, so every path is tested:
// Gill Agro (key account) and Mehra Snacks have all three; Bansal email and
// WhatsApp; Sidhu email only, and opted out of WhatsApp; Kohli Exports has
// no consent rows at all, so nothing may reach them.
import type { Db } from "../client";
import { createRepository } from "../repository";

const DAY = 24 * 60 * 60 * 1000;

type Row = { buyer: string; channel: "email" | "whatsapp" | "call"; status: "opted_in" | "opted_out"; source: string };

export const COLLECT_CONSENTS: Row[] = [
  { buyer: "buy_gill_agro", channel: "email", status: "opted_in", source: "onboarding form" },
  { buyer: "buy_gill_agro", channel: "whatsapp", status: "opted_in", source: "onboarding form" },
  { buyer: "buy_gill_agro", channel: "call", status: "opted_in", source: "onboarding form" },
  { buyer: "buy_bansal_traders", channel: "email", status: "opted_in", source: "purchase order terms" },
  { buyer: "buy_bansal_traders", channel: "whatsapp", status: "opted_in", source: "purchase order terms" },
  { buyer: "buy_sidhu_dairy", channel: "email", status: "opted_in", source: "purchase order terms" },
  { buyer: "buy_sidhu_dairy", channel: "whatsapp", status: "opted_out", source: "asked to use email only" },
  { buyer: "buy_mehra_snacks", channel: "email", status: "opted_in", source: "onboarding form" },
  { buyer: "buy_mehra_snacks", channel: "whatsapp", status: "opted_in", source: "onboarding form" },
  { buyer: "buy_mehra_snacks", channel: "call", status: "opted_in", source: "onboarding form" },
];

// The buyer with no consent rows at all.
export const NO_CONSENT_BUYER = "buy_kohli_exports";

export function seedCollect(db: Db, now: number) {
  const repo = createRepository(db);
  repo.messagingConsents.insertMany(
    COLLECT_CONSENTS.map((r) => ({
      id: `cons_${r.buyer}_${r.channel}`,
      buyer_id: r.buyer,
      channel: r.channel,
      status: r.status,
      source: r.source,
      updated_at: now - 60 * DAY,
    })),
  );
}

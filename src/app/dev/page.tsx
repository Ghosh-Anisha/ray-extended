import Link from "next/link";
import { connection } from "next/server";
import { desc, isNotNull } from "drizzle-orm";
import { getAdapters } from "@/adapters";
import { STORE_FAILURES } from "@/adapters/store";
import { EVENT_REF, WEBHOOK_EVENTS } from "@/adapters/webhooks";
import { createRepository } from "@/db/repository";
import * as s from "@/db/schema";
import { DevControls, type DevData } from "./controls";

export default async function DevPanelPage() {
  await connection();
  const a = getAdapters();
  const repo = createRepository(a.db);
  const merchants = repo.merchants.list();

  // Record ids per merchant, so the webhook form can suggest them.
  const ids: DevData["ids"] = {};
  const add = (merchantId: string, kind: string, id: string) => {
    ((ids[merchantId] ??= {})[kind] ??= []).push(id);
  };
  for (const p of repo.rzpPayments.list()) add(p.merchant_id, "paymentId", p.id);
  for (const r of repo.rzpRefunds.list()) add(r.merchant_id, "refundId", r.id);
  for (const d of repo.disputes.list()) add(d.merchant_id, "disputeId", d.id);
  for (const l of repo.rzpLinks.list()) add(l.merchant_id, "linkId", l.id);
  const subs = repo.subscriptions.list();
  for (const sub of subs) add(sub.merchant_id, "subscriptionId", sub.id);
  for (const m of repo.mandates.list()) {
    const sub = subs.find((x) => x.id === m.subscription_id);
    if (sub && m.token_id) add(sub.merchant_id, "tokenId", m.token_id);
  }
  for (const d of repo.downtimes.list()) for (const m of merchants) add(m.id, "downtime", d.id);

  const data: DevData = {
    now: a.clock.now(),
    clockMode: a.clockMode,
    cases: a.db
      .select()
      .from(s.cases)
      .orderBy(desc(s.cases.opened_at))
      .limit(8)
      .all()
      .map((c) => ({
        id: c.id,
        merchant: merchants.find((m) => m.id === c.merchant_id)?.name ?? c.merchant_id,
        moment: c.moment,
        state: c.state,
        openedAt: c.opened_at,
      })),
    unmatched: [
      ...a.db
        .select()
        .from(s.webhookDeliveries)
        .where(isNotNull(s.webhookDeliveries.unmatched_reason))
        .all()
        .map((d) => ({ id: d.event_id, at: d.delivered_at, source: "Webhook" as const, what: d.event, merchant: d.merchant_id })),
      ...a.db
        .select()
        .from(s.messages)
        .where(isNotNull(s.messages.unmatched_reason))
        .all()
        .map((m) => ({
          id: m.id,
          at: m.at,
          source: m.channel === "whatsapp" ? ("WhatsApp" as const) : ("Email" as const),
          what: `From ${m.from}`,
          merchant: a.messaging.senderLabel(m.to),
        })),
    ]
      .map((u) => ({ ...u, merchant: merchants.find((m) => m.id === u.merchant)?.name ?? u.merchant }))
      .sort((x, y) => y.at - x.at)
      .slice(0, 10),
    merchants: merchants.map((m) => ({ id: m.id, name: m.name })),
    customers: repo.customers.list().map((c) => ({
      id: c.id,
      label: `${c.name} (${merchants.find((m) => m.id === c.merchant_id)?.name})`,
      hasPhone: Boolean(c.phone),
      hasEmail: Boolean(c.email),
    })),
    stores: merchants.filter((m) => a.store.hasStore(m.id)).map((m) => ({ id: m.id, name: m.name, failure: a.store.failure(m.id) })),
    events: WEBHOOK_EVENTS.map((e) => ({ name: e, ref: EVENT_REF[e] })),
    failures: [...STORE_FAILURES],
    ids,
    deliveries: a.db.select().from(s.webhookDeliveries).orderBy(desc(s.webhookDeliveries.delivered_at)).limit(8).all(),
    messages: a.db
      .select()
      .from(s.messages)
      .orderBy(desc(s.messages.at))
      .limit(8)
      .all()
      .map((m) => ({ ...m, fromLabel: a.messaging.senderLabel(m.from), toLabel: a.messaging.senderLabel(m.to) })),
  };

  return (
    <main>
      <p>
        <Link href="/">Home</Link>
      </p>
      <h1>Dev panel</h1>
      <DevControls data={data} />
    </main>
  );
}

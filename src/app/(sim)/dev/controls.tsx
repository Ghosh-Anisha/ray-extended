"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { webhookDeliveries, messages } from "@/db/schema";
import { SimulatedTag } from "@/ui/bits";
import { CLOCK_PRESETS } from "./clock-presets";

export type DevData = {
  now: number;
  clockMode: "fake" | "real";
  cases: { id: string; merchant: string; moment: string; state: string; openedAt: number }[];
  unmatched: { id: string; at: number; source: "Webhook" | "WhatsApp" | "Email"; what: string; merchant: string }[];
  merchants: { id: string; name: string; killSwitch: boolean }[];
  globalKillSwitch: boolean;
  customers: { id: string; label: string; hasPhone: boolean; hasEmail: boolean }[];
  stores: { id: string; name: string; failure: string }[];
  events: { name: string; ref: string }[];
  failures: string[];
  ids: Record<string, Record<string, string[]>>;
  deliveries: (typeof webhookDeliveries.$inferSelect)[];
  messages: (typeof messages.$inferSelect & { fromLabel: string; toLabel: string })[];
};

const REF_LABEL: Record<string, string> = {
  paymentId: "Payment ID",
  refundId: "Refund ID",
  disputeId: "Dispute ID",
  subscriptionId: "Subscription ID",
  tokenId: "Token ID",
  linkId: "Payment link ID",
  downtime: "Downtime ID",
};

const FAILURE_LABEL: Record<string, string> = {
  none: "Working",
  dropped_200: "Answers 200 but drops the order update",
  site_down: "Site down (503)",
  webhook_disabled: "Webhook turned off",
  wrong_settings: "Wrong webhook secret",
};

const time = (ms: number) => new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

function Simulated({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: "12px 16px", margin: "16px 0", maxWidth: 720 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>
        {title} <SimulatedTag />
      </h2>
      {children}
    </section>
  );
}

const row = { display: "flex", gap: 8, flexWrap: "wrap" as const, alignItems: "center", margin: "8px 0" };

async function post(url: string, body: unknown): Promise<string> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as { ok: boolean; error?: string; result?: { outcome?: string; caseId?: string | null } };
  if (!json.ok) return `Not done: ${json.error}`;
  if (json.result?.outcome === "unmatched") return "No flow handles this yet";
  return json.result?.caseId ? `Done. Case ${json.result.caseId}` : "Done";
}

export function DevControls({ data }: { data: DevData }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [merchantId, setMerchantId] = useState(data.merchants[0]?.id ?? "");
  const [event, setEvent] = useState(data.events[0]?.name ?? "");
  const ref = data.events.find((e) => e.name === event)?.ref ?? "paymentId";
  const [refId, setRefId] = useState("");
  const [method, setMethod] = useState("upi");
  const [bank, setBank] = useState("");
  const [customerId, setCustomerId] = useState(data.customers[0]?.id ?? "");
  const [channel, setChannel] = useState<"whatsapp" | "email">("whatsapp");
  const [body, setBody] = useState("");

  async function run(e: FormEvent, url: string, payload: unknown) {
    e.preventDefault();
    setStatus("Sending...");
    setStatus(await post(url, payload));
    router.refresh();
  }

  const webhookPayload = () => {
    if (ref === "downtime") return { merchantId, event, downtime: { method, bank: bank || undefined, id: refId || undefined } };
    return { merchantId, event, [ref]: refId };
  };

  return (
    <div>
      <p>Clock: {time(data.now)}</p>
      {status && <p role="status">{status}</p>}

      <Simulated title="Move clock forward">
        {data.clockMode === "fake" ? (
          <p>Moves the clock, stopping at each timer or held action that falls due so it runs at its own time, earliest first.</p>
        ) : (
          <p>The app is on the real clock, so it can&apos;t be moved.</p>
        )}
        <div style={row}>
          {CLOCK_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={data.clockMode !== "fake"}
              onClick={async () => {
                setStatus("Moving...");
                setStatus(await post("/api/dev/clock", { ms: p.ms }));
                router.refresh();
              }}
            >
              Move forward {p.label}
            </button>
          ))}
        </div>
      </Simulated>

      <Simulated title="Kill switch">
        <p>Blocks every action RAY can take; reading still works.</p>
        <div style={row}>
          <label>
            <input
              type="checkbox"
              checked={data.globalKillSwitch}
              onChange={async (e) => {
                setStatus(await post("/api/dev/kill-switch", { scope: "global", on: e.target.checked }));
                router.refresh();
              }}
            />{" "}
            Every account
          </label>
        </div>
        <div style={row}>
          {data.merchants.map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={m.killSwitch}
                onChange={async (e) => {
                  setStatus(await post("/api/dev/kill-switch", { scope: { merchantId: m.id }, on: e.target.checked }));
                  router.refresh();
                }}
              />{" "}
              {m.name}
            </label>
          ))}
        </div>
      </Simulated>

      <Simulated title="Fire a Razorpay webhook">
        <form onSubmit={(e) => run(e, "/api/dev/webhooks", webhookPayload())}>
          <div style={row}>
            <label>
              Merchant{" "}
              <select value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
                {data.merchants.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
            <label>
              Event{" "}
              <select value={event} onChange={(e) => { setEvent(e.target.value); setRefId(""); }}>
                {data.events.map((ev) => (
                  <option key={ev.name} value={ev.name}>{ev.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div style={row}>
            <label>
              {REF_LABEL[ref]}
              {ref === "downtime" && event === "payment.downtime.started" ? " (optional)" : ""}{" "}
              <input list="ref-ids" value={refId} onChange={(e) => setRefId(e.target.value)} />
            </label>
            <datalist id="ref-ids">
              {(data.ids[merchantId]?.[ref] ?? []).map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            {ref === "downtime" && (
              <>
                <label>Method <input value={method} onChange={(e) => setMethod(e.target.value)} /></label>
                <label>Bank <input value={bank} onChange={(e) => setBank(e.target.value)} /></label>
              </>
            )}
          </div>
          <button type="submit">Fire {event}</button>
        </form>
      </Simulated>

      <Simulated title="Customer sends a message">
        <form onSubmit={(e) => run(e, "/api/dev/messages", { customerId, channel, body })}>
          <div style={row}>
            <label>
              Customer{" "}
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                {data.customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            </label>
            <label>
              Channel{" "}
              <select value={channel} onChange={(e) => setChannel(e.target.value as "whatsapp" | "email")}>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
              </select>
            </label>
          </div>
          <div style={row}>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} cols={60} placeholder="I paid but my order still says pending" />
          </div>
          <button type="submit" disabled={!body.trim()}>Send as customer</button>
        </form>
      </Simulated>

      <Simulated title="Store plugin">
        {data.stores.map((st) => (
          <div key={st.id} style={row}>
            <span>{st.name}</span>
            <select
              value={st.failure}
              onChange={async (e) => {
                setStatus(await post("/api/dev/store", { merchantId: st.id, failure: e.target.value }));
                router.refresh();
              }}
            >
              {data.failures.map((f) => (
                <option key={f} value={f}>{FAILURE_LABEL[f] ?? f}</option>
              ))}
            </select>
          </div>
        ))}
      </Simulated>

      <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: "12px 16px", margin: "16px 0", maxWidth: 720 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Latest cases</h2>
        {data.cases.length === 0 ? (
          <p>No cases yet.</p>
        ) : (
          <ul>
            {data.cases.map((c) => (
              <li key={c.id}>
                {time(c.openedAt)} · {c.merchant} · {c.moment} · {c.state} · {c.id}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: "12px 16px", margin: "16px 0", maxWidth: 720 }}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Unmatched</h2>
        <p>Events no flow handles yet. They are kept, not dropped.</p>
        {data.unmatched.length === 0 ? (
          <p>Nothing unmatched.</p>
        ) : (
          <ul>
            {data.unmatched.map((u) => (
              <li key={u.id}>
                {time(u.at)} · {u.merchant} · {u.source} · {u.what} · No flow handles this yet
              </li>
            ))}
          </ul>
        )}
      </section>

      <Simulated title="Latest webhook deliveries">
        <ul>
          {data.deliveries.map((d) => (
            <li key={d.event_id}>
              {time(d.delivered_at)} · {d.event} · {d.http_status ?? "not sent"} · {d.processed ? "processed" : "not processed"}
              {d.cron_note ? ` · ${d.cron_note}` : ""}
            </li>
          ))}
        </ul>
      </Simulated>

      <Simulated title="Latest messages">
        <ul>
          {data.messages.map((m) => (
            <li key={m.id}>
              {time(m.at)} · {m.channel === "whatsapp" ? "WhatsApp" : "Email"} · {m.fromLabel} to {m.toLabel}: {m.body}
            </li>
          ))}
        </ul>
      </Simulated>
    </div>
  );
}

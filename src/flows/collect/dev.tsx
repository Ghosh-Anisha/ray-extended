"use client";

// Dev panel, Collect (Simulated): a Banking+ credit lands, a seeded credit
// is handed in, or Subscriptions hands over an unpaid B2B renewal. Each
// control calls handleEvent through /api/dev/collect.
import { useState, type FormEvent } from "react";
import { SimulatedTag, post } from "@/ui/bits";

export type CollectDevData = { merchants: { id: string; name: string }[]; credits: { id: string; merchantId: string; label: string }[] };

export function CollectDevControls({ data }: { data: CollectDevData }) {
  const [status, setStatus] = useState("");
  const [merchantId, setMerchantId] = useState(data.merchants.find((m) => m.id === "m_packright")?.id ?? data.merchants[0]?.id ?? "");
  const send = async (e: FormEvent, body: Record<string, unknown>) => {
    e.preventDefault();
    const r = await post("/api/dev/collect", { merchantId, ...body });
    setStatus(r.ok ? `Done: ${JSON.stringify(r.result)}` : r.error);
  };
  const form = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
  return (
    <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: "12px 16px", margin: "16px 0", maxWidth: 720 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>
        Invoice overdue <SimulatedTag />
      </h2>
      <label className="row">
        Merchant
        <select value={merchantId} onChange={(e) => setMerchantId(e.target.value)}>
          {data.merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <form className="row" onSubmit={(e) => { const f = form(e); return send(e, { action: "credit", rupees: Number(f.rupees), remark: f.remark, utr: f.utr }); }}>
        <strong>Banking+ credit lands</strong>
        <input name="rupees" type="number" min="1" step="0.01" placeholder="₹ amount" required />
        <input name="remark" placeholder="NEFT MEHRA SNACKS" required />
        <input name="utr" placeholder="UTR" required />
        <button type="submit">Send credit</button>
      </form>
      <form className="row" onSubmit={(e) => send(e, { action: "seeded_credit", creditId: form(e).creditId })}>
        <strong>Seeded credit</strong>
        <select name="creditId">
          {data.credits.filter((c) => c.merchantId === merchantId).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <button type="submit">Hand in credit</button>
      </form>
      <form className="row" onSubmit={(e) => { const f = form(e); return send(e, { action: "handoff", invoiceId: f.invoiceId, subscriptionId: f.subscriptionId, subInvoiceId: f.subInvoiceId }); }}>
        <strong>Subscriptions handoff</strong>
        <input name="invoiceId" placeholder="invoice id, or" />
        <input name="subscriptionId" placeholder="subscription id" />
        <input name="subInvoiceId" placeholder="subscription invoice id" />
        <button type="submit">Send handoff</button>
      </form>
      {status && <p className="muted">{status}</p>}
    </section>
  );
}

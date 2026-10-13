"use client";

// Checkout abroad (Simulated): the buyer's checkout with the cause-specific
// failure message, payment links, MoneySaver transfers, Razorpay's risk desk
// and the account's international settings. Always desktop, always tagged.
import { Button } from "@/ui/kit";
import { useState } from "react";
import { useAction } from "@/ui/bits";
import { SimTitle } from "@/ui/sim/sim-title";
import type { IntlSimView } from "../sim-actions";

const URL = "/api/dev/international";

const BUYERS = [
  { name: "Emma Clarke", email: "emma.clarke@example.com", country: "US" },
  { name: "Oliver Bennett", email: "oliver@example.co.uk", country: "GB" },
  { name: "Léa Martin", email: "lea.martin@example.fr", country: "FR", language: "fr" },
];

export function InternationalSim({ view }: { view: IntlSimView }) {
  const [id, setId] = useState(view.merchants[0]?.id ?? "");
  const [outcome, setOutcome] = useState(view.outcomes[1]?.value ?? "success");
  const [buyer, setBuyer] = useState(0);
  const [amount, setAmount] = useState(49);
  const [currency, setCurrency] = useState("USD");
  const [seen, setSeen] = useState<string | null>(null);
  const [transfer, setTransfer] = useState({ amount: 2800, currency: "GBP", remitterName: "BENNETT O", remitterReference: "PF INV 2041" });
  const { busy, error, run } = useAction();
  const m = view.merchants.find((x) => x.id === id);

  async function pay(body: Record<string, unknown>) {
    setSeen(null);
    const r = await run(String(body.action), URL, body);
    const result = (r as { result?: { message?: string | null; status?: string } }).result;
    if (result?.status) setSeen(result.message ?? "Payment successful.");
  }

  return (
    <div className="stack">
      <SimTitle>Checkout abroad</SimTitle>
      <div className="row">
        <label>
          Seller{" "}
          <select value={id} onChange={(e) => setId(e.target.value)}>
            {view.merchants.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        {m?.settings && (
          <span className="muted">
            Limit {m.settings.limit} · {m.settings.currencies} · {m.settings.checkout} · PayPal {m.settings.paypal ? "on" : "off"} · MoneySaver {m.settings.moneysaver ? "on" : "off"}
            {m.settings.non3ds ? " · No security check (3DS)" : ""}
          </span>
        )}
        {error && <span className="error">{error}</span>}
      </div>

      {seen && (
        <div className="panel" role="status" aria-live="polite">
          <strong>What the buyer sees at checkout:</strong> {seen}
        </div>
      )}

      {m && (
        <div className="cols-2">
          <section className="panel">
            <h2>Checkout</h2>
            <div className="row">
              <select value={buyer} onChange={(e) => setBuyer(Number(e.target.value))} aria-label="Buyer">
                {BUYERS.map((b, i) => (
                  <option key={b.email} value={i}>
                    {b.name} ({b.country})
                  </option>
                ))}
              </select>
              <input type="number" value={amount} min={1} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Amount" style={{ width: 90 }} />
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
                {["USD", "GBP", "EUR"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <Button
                size="small"
                isDisabled={!!busy}
                onClick={() =>
                  run("open", URL, { action: "open_checkout", merchantId: m.id, amount: Math.round(amount * 100), currency, receipt: `sim_${Date.now().toString(36)}`, buyer: BUYERS[buyer] })
                }
              >
                Open checkout
              </Button>
            </div>
            <div className="row">
              <label>
                Card outcome{" "}
                <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                  {view.outcomes.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button size="small" variant="secondary" isDisabled={!!busy} onClick={() => run("sweep", URL, { action: "sweep", merchantId: m.id })}>
                Check for checkouts left without paying
              </Button>
            </div>
            <table className="data">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Buyer</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {m.orders.map((o) => (
                  <tr key={o.id}>
                    <td title={o.at}>{o.receipt}</td>
                    <td>{o.buyer}</td>
                    <td className="num">{o.amount}</td>
                    <td>{o.status}</td>
                    <td>
                      {o.status !== "Paid" && (
                        <span className="row">
                          <Button size="small" isDisabled={!!busy} onClick={() => pay({ action: "pay_card", merchantId: m.id, orderId: o.id, outcome })}>
                            Pay {o.amount} by card
                          </Button>
                          {o.paypal && (
                            <Button size="small" variant="secondary" isDisabled={!!busy} onClick={() => pay({ action: "pay_paypal", merchantId: m.id, orderId: o.id })}>
                              Pay {o.amount} with PayPal
                            </Button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2>Payment links</h2>
            <table className="data">
              <tbody>
                {m.links.map((l) => (
                  <tr key={l.id}>
                    <td title={l.url}>{l.buyer}</td>
                    <td className="num">{l.amount}</td>
                    <td>{l.status}</td>
                    <td>
                      {l.status === "created" && (
                        <span className="row">
                          <Button size="small" isDisabled={!!busy} onClick={() => pay({ action: "pay_link", merchantId: m.id, linkId: l.id, method: "card" })}>
                            Pay by card
                          </Button>
                          <Button size="small" variant="secondary" isDisabled={!!busy} onClick={() => pay({ action: "pay_link", merchantId: m.id, linkId: l.id, method: "paypal" })}>
                            Pay with PayPal
                          </Button>
                          <Button size="small" variant="secondary" isDisabled={!!busy} onClick={() => run("expire", URL, { action: "expire_link", merchantId: m.id, linkId: l.id })}>
                            Let it expire
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2>MoneySaver transfers</h2>
            {m.settings?.moneysaver ? (
              <div className="row">
                <input type="number" value={transfer.amount} onChange={(e) => setTransfer({ ...transfer, amount: Number(e.target.value) })} aria-label="Transfer amount" style={{ width: 90 }} />
                <select value={transfer.currency} onChange={(e) => setTransfer({ ...transfer, currency: e.target.value })} aria-label="Transfer currency">
                  {["GBP", "USD"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <input value={transfer.remitterName} onChange={(e) => setTransfer({ ...transfer, remitterName: e.target.value })} aria-label="From" />
                <input value={transfer.remitterReference} onChange={(e) => setTransfer({ ...transfer, remitterReference: e.target.value })} aria-label="Reference" />
                <Button size="small" isDisabled={!!busy} onClick={() => run("transfer", URL, { action: "land_transfer", merchantId: m.id, ...transfer, amount: Math.round(transfer.amount * 100) })}>
                  Transfer lands
                </Button>
              </div>
            ) : (
              <p className="muted">MoneySaver is off for {m.name}.</p>
            )}
            <table className="data">
              <tbody>
                {m.transfers.map((t) => (
                  <tr key={t.id}>
                    <td>{t.from}</td>
                    <td>{t.reference}</td>
                    <td className="num">{t.amount}</td>
                    <td>{t.settlement === "held" ? "Settlement held: no invoice" : "Settled"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2>Razorpay risk desk</h2>
            {m.held.length === 0 && <p className="muted">No payments on hold. Payments Razorpay&apos;s risk check holds show up here.</p>}
            {m.held.map((h) => (
              <div className="row" key={h.paymentId}>
                <span>
                  {h.buyer}, {h.amount}
                </span>
                <Button size="small" isDisabled={!!busy} onClick={() => run("clear", URL, { action: "risk_review", merchantId: m.id, paymentId: h.paymentId, cleared: true })}>
                  Clear the card
                </Button>
                <Button size="small" variant="secondary" isDisabled={!!busy} onClick={() => run("keep", URL, { action: "risk_review", merchantId: m.id, paymentId: h.paymentId, cleared: false })}>
                  Keep the block
                </Button>
              </div>
            ))}
            {m.tickets.map((t) => (
              <p className="muted" key={t.id} style={{ fontSize: 12 }}>
                Ticket: {t.text}
              </p>
            ))}

            <h2>Account</h2>
            <div className="row">
              <Button size="small" variant="secondary" isDisabled={!!busy} onClick={() => run("limit", URL, { action: "account_change", merchantId: m.id, limitInr: 5 * 100_000 * 100 })}>
                Razorpay raises the limit to ₹5 lakh
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

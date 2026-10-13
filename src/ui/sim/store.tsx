"use client";

// Store admin: what the merchant's store shows (orders, status history,
// stock) and its plugin's failure mode.
import { useState } from "react";
import type { StoreView } from "@/surfaces/sims";
import { useAction } from "../bits";
import { SimTitle } from "./sim-title";

const FAILURE_LABEL: Record<string, string> = {
  none: "Working",
  dropped_200: "Says it got the payment but doesn't update the order",
  site_down: "Site down",
  webhook_disabled: "Payment updates turned off",
  wrong_settings: "Wrong settings for payment updates",
};

export function StoreAdmin({ stores, failures }: { stores: StoreView[]; failures: string[] }) {
  const [id, setId] = useState(stores[0]?.merchantId ?? "");
  const { error, run } = useAction();
  const st = stores.find((x) => x.merchantId === id);
  return (
    <div className="stack">
      <SimTitle>Store admin</SimTitle>
      <div className="row">
        <label>
          Store{" "}
          <select value={id} onChange={(e) => setId(e.target.value)}>
            {stores.map((x) => (
              <option key={x.merchantId} value={x.merchantId}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        {st && (
          <label>
            Plugin {st.plugin}:{" "}
            <select value={st.failure} onChange={(e) => run("failure", "/api/dev/store", { merchantId: st.merchantId, failure: e.target.value })}>
              {failures.map((f) => (
                <option key={f} value={f}>
                  {FAILURE_LABEL[f] ?? f}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <span className="error">{error}</span>}
      </div>
      {st && (
        <div className="cols-2">
          <section className="panel">
            <h2>Orders</h2>
            <table className="data">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                  <th>History</th>
                </tr>
              </thead>
              <tbody>
                {st.orders.map((o) => (
                  <tr key={o.id}>
                    <td title={o.payment ?? ""}>{o.number}</td>
                    <td>{o.status}</td>
                    <td className="num">{o.total}</td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {o.history.map((h, i) => (
                        <div key={i}>{h}</div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2>Products</h2>
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Price</th>
                  <th className="num">Stock</th>
                </tr>
              </thead>
              <tbody>
                {st.products.map((p) => (
                  <tr key={p.sku}>
                    <td>{p.name}</td>
                    <td className="num">{p.price}</td>
                    <td className="num">{p.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}

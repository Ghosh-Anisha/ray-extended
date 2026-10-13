"use client";

// Proactive cards from RAY on Home (docs/ui-rebuild.md section 11): the
// Cardless EMI lever with its estimate, trade-off and two-weeks-later result,
// and the offer to take over chasing invoices.
import { Lightbulb } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EmiCard } from "@/surfaces/grow";

function usePost() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function post(key: string, body: unknown) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/merchant/grow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) throw new Error(json.error ?? "That didn't work. Try again.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, post };
}

export function ProactiveCards({ merchantId, emi, chase }: { merchantId: string; emi: EmiCard | null; chase: { line: string; href: string } | null }) {
  const { busy, error, post } = usePost();
  if (!emi && !chase) return null;
  return (
    <section className="stack" style={{ gap: 12 }} aria-label="Suggestions from RAY" data-coach="suggestions">
      <div className="section-head">
        <h2>Suggested by RAY</h2>
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="grid-2">
        {emi && (
          <div className="panel stack suggest" data-coach="grow-card" style={{ gap: 10 }}>
            <span className="tile-icon"><Lightbulb size={18} aria-hidden="true" /></span>
            {emi.phase === "offer" && (
              <>
                <span className="chip simulated" style={{ alignSelf: "flex-start" }}>Proposed · seeded demo orders</span>
                <strong>The seeded demo shows unpaid carts above ₹5,000. Cardless EMI is shown as a proposed lever.</strong>
                <span>
                  {emi.dropped} of {emi.carts} seeded demo orders above ₹5,000 were left unpaid, {emi.droppedValue} in all. Under the displayed assumption, the modeled amount is about <strong>{emi.estimate}</strong>; this is not measured or incremental revenue.
                </span>
                <span className="muted">{emi.assumption}</span>
                <span className="muted"><strong>The trade-off:</strong> {emi.tradeOff}</span>
                <div className="row" data-coach="grow-actions">
                  <button type="button" className="btn primary" disabled={busy !== null} onClick={() => post("on", { merchantId, card: "emi", choice: "on" })}>
                    {busy === "on" ? "Saving choice…" : "Preview Cardless EMI"}
                  </button>
                  <button type="button" className="btn secondary" disabled={busy !== null} onClick={() => post("no", { merchantId, card: "emi", choice: "not_now" })}>
                    Not now
                  </button>
                  <span className="chip simulated">Simulated</span>
                </div>
              </>
            )}
            {emi.phase === "on" && (
              <>
                <strong>Simulated choice saved on {emi.since}.</strong>
                <span className="muted">This demo will show a modeled scenario on {emi.checkOn}; it does not turn on a live payment setting.</span>
                <span className="chip simulated" style={{ alignSelf: "flex-start" }}>Simulated</span>
              </>
            )}
            {emi.phase === "result" && (
              <>
                <strong>Two weeks of Cardless EMI: before and after</strong>
                <div className="before-after">
                  <div>
                    <span className="metric-label">Before ({emi.since})</span>
                    <span className="big-number">{emi.before.dropped}</span>
                    <span className="muted">carts above ₹5,000 left unpaid · {emi.before.value}</span>
                  </div>
                  <div>
                    <span className="metric-label">After</span>
                    <span className="big-number">{emi.after.dropped}</span>
                    <span className="muted">left unpaid · {emi.after.value}</span>
                  </div>
                </div>
                <span>{emi.line}</span>
                <span className="chip simulated" style={{ alignSelf: "flex-start" }}>Simulated</span>
              </>
            )}
          </div>
        )}
        {chase && (
          <div className="panel stack suggest" style={{ gap: 10 }}>
            <span className="tile-icon"><Lightbulb size={18} aria-hidden="true" /></span>
            <span className="chip simulated" style={{ alignSelf: "flex-start" }}>Proposed · simulated workflow</span>
            <strong>Preview a seeded invoice chase</strong>
            <span>{chase.line}</span>
            <div className="row">
              <Link className="btn primary" href={chase.href}>
                See the morning list
              </Link>
              <button type="button" className="btn secondary" disabled={busy !== null} onClick={() => post("chase", { merchantId, card: "chase", choice: "not_now" })}>
                Not now
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

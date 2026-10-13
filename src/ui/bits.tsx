"use client";

// Small pieces every surface shares: chips, the Simulated tag, Covered or
// Your call, banners with live countdowns, and a POST helper.
import { Button } from "@/ui/kit";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { countdown } from "@/surfaces/format";
import type { Chip as ChipT, Hold } from "@/surfaces/views";
import { COVERED, COVERED_HINT, KILL_SWITCH_BANNER, SIMULATED, YOUR_CALL, YOUR_CALL_HINT } from "@/surfaces/words";

export function Chip({ chip }: { chip: ChipT }) {
  return <span className={`chip ${chip.tone}`}>{chip.label}</span>;
}

export function SimulatedTag() {
  return <span className="chip simulated">{SIMULATED}</span>;
}

export function ApprovalLabel({ covered }: { covered: boolean }) {
  return (
    <span className={`approval-label ${covered ? "covered" : "your-call"}`} title={covered ? COVERED_HINT : YOUR_CALL_HINT}>
      {covered ? COVERED : YOUR_CALL}
    </span>
  );
}

export function KillSwitchBanner() {
  return (
    <div className="banner kill" role="status">
      {KILL_SWITCH_BANNER}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export type PostResult = { ok: true; result: unknown } | { ok: false; error: string };

export async function post(url: string, body: unknown): Promise<PostResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as PostResult;
  } catch {
    return { ok: false, error: "Couldn't reach RAY. Check your connection and try again." };
  }
}

// Runs a POST, then refreshes the page's data from the server.
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(key: string, url: string, body: unknown) {
    setBusy(key);
    setError(null);
    const r = await post(url, body);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("ray:merchant-action", { detail: r.ok ? { url, ok: true, result: r.result } : { url, ok: false, error: r.error } }));
    }
    if (!r.ok) setError(r.error);
    router.refresh();
    setBusy(null);
    return r;
  }
  return { busy, error, run };
}

// "Refunding ₹1,299 in 9:42 · Undo", counting down live and in words.
export function HoldBanner({ hold, merchantId, compact }: { hold: Hold; merchantId: string; compact?: boolean }) {
  const { busy, error, run } = useAction();
  const [left, setLeft] = useState(hold.remaining);
  useEffect(() => {
    // The server's clock may be the fake one, so count down from what it sent.
    const started = Date.now();
    const t = setInterval(() => setLeft(countdown(hold.remainingMs - (Date.now() - started))), 1000);
    return () => clearInterval(t);
  }, [hold]);
  return (
    <div className="banner hold" role="status" data-guided={hold.control === "Undo" ? "refund-hold" : undefined}>
      <span>
        {hold.text} in <span aria-hidden="true">{left.clock}</span>
        <span className="sr-only" style={{ position: "absolute", left: -9999 }}>{left.words}</span>
        {!compact && <span className="muted"> ({left.words} left)</span>}
      </span>
      <Button size="small" variant="secondary" isLoading={busy === hold.actionId} onClick={() => run(hold.actionId, "/api/merchant/undo", { merchantId, actionId: hold.actionId })}>
        {hold.control}
      </Button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}


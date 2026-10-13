"use client";

// The Demo controls drawer (docs/ui-rebuild.md 3.10): reset, jump to a
// chapter, move the clock, fire an event, kill switch. The old dev panel's
// controls live in the collapsed "Fire an event" part. Everything here is
// Simulated, so it carries the tag.
import { RotateCcw, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CLOCK_PRESETS } from "@/app/(sim)/dev/clock-presets";
import { DevControls, type DevData } from "@/app/(sim)/dev/controls";
import { SimulatedTag } from "../bits";

type State = {
  nowLabel: string;
  clockMode: "fake" | "real";
  globalKillSwitch: boolean;
  merchantId: string;
  cases: Record<string, string>; // "RD-1042" -> case id
};

type Post = { ok: boolean; error?: string };
async function post(url: string, body?: unknown): Promise<Post> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    return (await res.json()) as Post;
  } catch {
    return { ok: false, error: "Couldn't reach the server." };
  }
}

// /dev redirects to Home with ?controls=1, which opens the drawer.
export function OpenControlsOnParam({ onOpen }: { onOpen: () => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const wanted = params.get("controls") === "1";
  useEffect(() => {
    if (!wanted) return;
    onOpen();
    const rest = new URLSearchParams(params.toString());
    rest.delete("controls");
    router.replace(`${window.location.pathname}${rest.size ? `?${rest}` : ""}`);
  }, [wanted, onOpen, params, router]);
  return null;
}

// The story's chapters (section 6). Each opens the screen the chapter is on.
function chapters(base: string, cases: Record<string, string>) {
  const c = (ref: string) => (cases[ref] ? `${base}/cases/${cases[ref]}` : `${base}/cases`);
  return [
    { title: "Home", href: `${base}?guided=1&step=1` },
    { title: "Cases", href: `${base}/cases?guided=1&step=2` },
    { title: "Case page: paid, no order", href: `${c("RD-1042")}?guided=1&step=3` },
    { title: "Customer inbox", href: "/sim/inbox?guided=1&step=4" },
    { title: "RAY on WhatsApp", href: `${base}/whatsapp?guided=1&step=5` },
    { title: "Ask RAY", href: `${base}/rules?guided=1&step=6` },
    { title: "Chargeback", href: `${c("RD-1051")}?guided=1&step=7` },
    { title: "Subscription stopped", href: `${c("RD-1060")}?guided=1&step=8` },
    { title: "Invoice overdue", href: `${base}/collect?guided=1&step=9` },
    { title: "My dashboard", href: `${base}/dashboard?guided=1&step=10` },
  ];
}

export function DemoControls({ merchantId, onClose }: { merchantId: string; onClose: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [dev, setDev] = useState<DevData | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/demo/state", { cache: "no-store" });
      setState((await res.json()) as State);
    } catch {
      setStatus("Couldn't read the demo state.");
    }
  };
  useEffect(() => {
    // Reads the server's demo state when the drawer opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    if (!advanced || dev) return;
    void fetch("/api/demo/dev-data", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: DevData) => setDev(d));
  }, [advanced, dev]);

  async function run(key: string, fn: () => Promise<Post>, done: string) {
    setBusy(key);
    setStatus("");
    const r = await fn();
    setStatus(r.ok ? done : `Not done: ${r.error}`);
    setBusy(null);
    await load();
    router.refresh();
  }

  const base = `/merchant/${state?.merchantId ?? merchantId}`;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Demo controls">
        <div className="drawer-head">
          <h2>Demo controls</h2>
          <SimulatedTag />
          <span className="grow" />
          <button type="button" className="btn secondary" style={{ width: 36, padding: 0 }} aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">
          <section>
            <h3>Reset</h3>
            <div className="row">
              <button
                type="button"
                className="btn primary"
                disabled={busy !== null}
                onClick={() =>
                  run("reset", async () => {
                    const r = await post("/api/demo/reset");
                    if (r.ok) {
                      setDev(null);
                      router.push(`/merchant/${merchantId}`);
                    }
                    return r;
                  }, "Demo reset to Tue 13 Oct, 10:00 AM.")
                }
              >
                <RotateCcw size={16} aria-hidden="true" />
                {busy === "reset" ? "Resetting…" : "Reset demo"}
              </button>
              <span className="muted">Puts Leafy Bakes back as it was on Tue 13 Oct, 10:00 AM.</span>
            </div>
          </section>

          <section>
            <h3>Move clock forward</h3>
            <p className="muted" style={{ margin: "0 0 8px" }}>
              It is {state?.nowLabel ?? "…"}.{state?.clockMode === "real" ? " The real clock is on, so it can't be moved." : ""}
            </p>
            <div className="row" aria-label="Move clock forward">
              {CLOCK_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="btn secondary"
                  disabled={busy !== null || state?.clockMode === "real"}
                  onClick={() => run(`clock-${p.label}`, () => post("/api/dev/clock", { ms: p.ms }), `Moved the clock forward ${p.label}.`)}
                >
                  + {p.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3>Jump to chapter</h3>
            <div className="stack" style={{ gap: 2 }}>
              {chapters(base, state?.cases ?? {}).map((c, i) => (
                <a
                  key={c.title}
                  className="chapter"
                  href={c.href}
                  onClick={(e) => {
                    e.preventDefault();
                    onClose();
                    router.push(c.href);
                  }}
                >
                  <span className="n">{i + 1}</span>
                  <span>{c.title}</span>
                </a>
              ))}
            </div>
          </section>

          <section>
            <h3>Kill switch</h3>
            <div className="row">
              <button
                type="button"
                className="btn secondary"
                disabled={busy !== null || !state}
                onClick={() =>
                  run("kill", () => post("/api/dev/kill-switch", { scope: "global", on: !state?.globalKillSwitch }), state?.globalKillSwitch ? "RAY's actions are back on." : "RAY's actions are paused.")
                }
              >
                {state?.globalKillSwitch ? "Turn RAY's actions back on" : "Pause all of RAY's actions"}
              </button>
              <span className="muted">{state?.globalKillSwitch ? "Paused for every account." : "On. Reading still works when paused."}</span>
            </div>
          </section>

          <section>
            <details onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
              <summary>Fire an event (advanced)</summary>
              {advanced && (dev ? <DevControls data={dev} /> : <p className="muted">Loading…</p>)}
            </details>
          </section>

          {status && (
            <p role="status" className={status.startsWith("Not done") ? "error" : "muted"} style={{ margin: 0 }}>
              {status}
            </p>
          )}
        </div>
      </aside>
    </>
  );
}

"use client";

// The combined dashboard and WhatsApp story (docs/ui-rebuild.md 3.1): shown until dismissed, per
// browser. The button starts the ten-step story in the shared shell overlay.
import { Play } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";

const KEY = "ray-guided-card-dismissed";
const listeners = new Set<() => void>();
const read = () => {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export function GuidedDemoCard({ merchantId }: { merchantId: string }) {
  // The server can't know; render the card and hide it after hydration if dismissed.
  const dismissed = useSyncExternalStore(subscribe, read, () => false);
  if (dismissed) return null;
  return (
    <section className="panel guided" aria-label="Guided demo">
      <span className="icon">
        <Play size={20} aria-hidden="true" />
      </span>
      <div className="grow">
        <strong>Follow a demo day with Agentic Dashboard and RAY on WhatsApp.</strong>
        <div className="muted">Ten short steps, from a missed order to a custom dashboard. All outcomes are simulated.</div>
      </div>
      <Link className="btn primary" href={`/merchant/${merchantId}?guided=1&step=1`}>
        Start guided demo
      </Link>
      <button
        type="button"
        className="btn secondary"
        onClick={() => {
          try {
            window.localStorage.setItem(KEY, "1");
          } catch {
            /* private mode: it will show again next time */
          }
          listeners.forEach((fn) => fn());
        }}
      >
        Explore on my own
      </button>
    </section>
  );
}

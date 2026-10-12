"use client";

// Call screen: "Call to Priya · 1 min 42 s · Simulated", outcome chip,
// transcript expander and post-call summary. Calls are placed from Step 5b.
import type { CallView } from "@/surfaces/sims";
import { EMPTY } from "@/surfaces/words";
import { Empty, SimulatedTag } from "../bits";
import { SimTitle } from "./sim-bar";

export function CallScreen({ calls }: { calls: CallView[] }) {
  return (
    <div className="stack">
      <SimTitle>Calls</SimTitle>
      {calls.length === 0 ? (
        <Empty>{EMPTY.calls}</Empty>
      ) : (
        calls.map((c) => (
          <section key={c.id} className="panel stack">
            <div className="row">
              <strong>{c.title}</strong>
              <SimulatedTag />
              <span className="chip neutral">{c.outcome}</span>
            </div>
            <details>
              <summary>Transcript</summary>
              {c.transcript.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </details>
            <div>{c.summary}</div>
          </section>
        ))
      )}
    </div>
  );
}

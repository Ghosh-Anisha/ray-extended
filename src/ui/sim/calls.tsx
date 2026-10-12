"use client";

// Call screen (Simulated): every call RAY placed as a Call card ("Call to
// Priya · 1 min 42 s · Simulated", outcome chip, transcript expander, ▶ for
// generated audio lines), and how each callee answers the next call.
// Calls are placed by flows through place_call (Steps 7, 9, 10 and 11).
import { useState } from "react";
import type { CalleeSim, CallScreenView } from "@/surfaces/sims";
import { DOING_IT, EMPTY } from "@/surfaces/words";
import { Empty, useAction } from "../bits";
import { CallCard } from "../voice";
import { SimTitle } from "./sim-bar";

export function CallScreen({ v }: { v: CallScreenView }) {
  return (
    <div className="stack">
      <SimTitle>Calls</SimTitle>
      <p className="muted">{v.live ? "RAY's lines get generated audio on ElevenLabs." : "Transcripts only. Set ELEVENLABS_API_KEY for generated audio lines."}</p>
      {v.calls.length === 0 ? <Empty>{EMPTY.calls}</Empty> : v.calls.map((c) => <CallCard key={c.id} call={c} meta={`${c.merchant} · ${c.at}`} />)}
      <CalleeSims callees={v.callees} outcomes={v.outcomes} />
    </div>
  );
}

function CalleeSims({ callees, outcomes }: { callees: CalleeSim[]; outcomes: CallScreenView["outcomes"] }) {
  const [callee, setCallee] = useState(callees[0]?.callee ?? "");
  const current = callees.find((c) => c.callee === callee);
  return (
    <section className="panel stack" aria-label="How the next call goes">
      <h2 style={{ margin: 0 }}>How the next call goes</h2>
      <label>
        Person{" "}
        <select value={callee} onChange={(e) => setCallee(e.target.value)}>
          {callees.map((c) => (
            <option key={c.callee} value={c.callee}>
              {c.name} ({c.merchant}) · {c.consent}
            </option>
          ))}
        </select>
      </label>
      {current && <CalleeForm key={current.callee} c={current} outcomes={outcomes} />}
    </section>
  );
}

function CalleeForm({ c, outcomes }: { c: CalleeSim; outcomes: CallScreenView["outcomes"] }) {
  const { busy, error, run } = useAction();
  const [outcome, setOutcome] = useState(c.outcome);
  const [reply, setReply] = useState(c.reply);
  const [promise, setPromise] = useState(c.promise);
  return (
    <form
      className="stack"
      style={{ gap: 6 }}
      onSubmit={(e) => {
        e.preventDefault();
        void run("save", "/api/dev/call-sims", { callee: c.callee, outcome, reply, promise });
      }}
    >
      <label>
        Outcome{" "}
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {outcomes.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        What {c.name.split(/[\s,]+/)[0]} says <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Okay, I'll check and reply tonight" />
      </label>
      {outcome === "answered" && (
        <label>
          Promise or choice <input value={promise} onChange={(e) => setPromise(e.target.value)} placeholder="Will reply on WhatsApp by 9 PM" />
        </label>
      )}
      <div className="row">
        <button type="submit" disabled={busy !== null}>
          {busy ? DOING_IT : "Save"}
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </form>
  );
}

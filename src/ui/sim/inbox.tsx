"use client";

// Customer and buyer inboxes: pick a person, read their WhatsApp, email,
// voice notes and calls, and write back or send a voice note as them.
// Sending goes through the engine like any inbound message.
import { Button } from "@razorpay/blade/components";
import { useState } from "react";
import type { Person } from "@/surfaces/sims";
import { useAction } from "../bits";
import { CallCard, VoiceNoteBubble } from "../voice";
import { VoiceCompose } from "../voice-compose";
import { SimTitle } from "./sim-bar";

export function PeopleInbox({
  title,
  people,
  kind,
  voiceSamples = [],
  voiceLive = false,
}: {
  title: string;
  people: Person[];
  kind: "customer" | "buyer";
  voiceSamples?: { id: string; label: string }[];
  voiceLive?: boolean;
}) {
  const [id, setId] = useState(people.find((p) => p.messages.length > 0)?.id ?? people[0]?.id ?? "");
  const [channel, setChannel] = useState<"whatsapp" | "email">("whatsapp");
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction();
  const [status, setStatus] = useState("");
  const p = people.find((x) => x.id === id);
  return (
    <div className="stack">
      <SimTitle>{title}</SimTitle>
      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16, alignItems: "start" }}>
        <ul className="panel" style={{ listStyle: "none", margin: 0, padding: 8 }}>
          {people.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => setId(x.id)}
                aria-pressed={x.id === id}
                className="pick"
              >
                <strong>{x.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {x.merchant} · {x.messages.length} messages
                </div>
              </button>
            </li>
          ))}
        </ul>
        {p && (
          <section className="panel stack">
            <div className="muted">
              {p.phone ?? "No phone"} · {p.email ?? "No email"}
              {kind === "customer" && ` · WhatsApp: ${p.whatsapp}`}
            </div>
            <div className="wa" style={{ minHeight: 160 }}>
              {p.messages.length === 0 && <div className="muted">No messages yet.</div>}
              {p.messages.map((m) => {
                const meta = `${m.direction === "in" ? `From ${m.with}` : `To ${m.with}`} · ${m.channel} · ${m.at}`;
                if (m.call) return <CallCard key={m.id} call={m.call} meta={meta} />;
                if (m.voice) return <VoiceNoteBubble key={m.id} note={m.voice} mine={m.direction === "out"} meta={meta} />;
                return (
                  <div key={m.id} className={`bubble ${m.direction === "out" ? "mine" : ""}`}>
                    {m.body}
                    <div className="meta">{meta}</div>
                  </div>
                );
              })}
            </div>
            {p.phone && voiceSamples.length > 0 && (
              <VoiceCompose
                url="/api/dev/voice-notes"
                fields={{ [kind === "customer" ? "customerId" : "buyerId"]: p.id }}
                samples={voiceSamples}
                live={voiceLive}
                sendLabel={`Send as ${p.name.split(",")[0]}`}
                onSent={(res) => {
                  const r = res as { outcome?: string; caseId?: string };
                  setStatus(r.outcome === "unmatched" ? "No flow handles this yet" : r.caseId ? `Went to case ${r.caseId}` : "Sent");
                }}
              />
            )}
            <form
              className="stack"
              style={{ gap: 6 }}
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await run("send", "/api/dev/messages", { [kind === "customer" ? "customerId" : "buyerId"]: p.id, channel, body });
                if (r.ok) {
                  setBody("");
                  const res = r.result as { outcome?: string; caseId?: string };
                  setStatus(res.outcome === "unmatched" ? "No flow handles this yet" : res.caseId ? `Went to case ${res.caseId}` : "Sent");
                }
              }}
            >
              <div className="row">
                <label>
                  Send on{" "}
                  <select value={channel} onChange={(e) => setChannel(e.target.value as "whatsapp" | "email")}>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                  </select>
                </label>
              </div>
              <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder={`Write as ${p.name}`} aria-label={`Message from ${p.name}`} />
              <div className="row">
                <Button type="submit" isDisabled={!body.trim() || busy !== null}>
                  {`Send as ${p.name.split(",")[0]}`}
                </Button>
                {status && <span role="status">{status}</span>}
                {error && <span className="error">{error}</span>}
              </div>
            </form>
          </section>
        )}
      </div>
    </div>
  );
}

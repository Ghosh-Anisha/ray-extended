"use client";

// Customer and buyer inboxes: pick a person, read their WhatsApp, email,
// voice notes and calls, and write back or send a voice note as them.
// Sending goes through the engine like any inbound message.
import { Button } from "@/ui/kit";
import { useState } from "react";
import type { Person } from "@/surfaces/sims";
import { SimulatedTag, useAction } from "../bits";
import { CoachMarks } from "../coach-mark";
import { CallCard, VoiceNoteBubble } from "../voice";
import { VoiceCompose } from "../voice-compose";
import { SimTitle } from "./sim-title";

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
  const quickReplies = kind === "customer" ? ["mil gaya, thanks", "I didn't authorise this"] : ["will clear by Friday", "Please resend the invoice"];
  return (
    <div className="stack">
      <SimTitle>{title}</SimTitle>
      <div className="sim-banner"><SimulatedTag /> <span>You&apos;re seeing what {kind === "customer" ? "the customer" : "the buyer"} sees.</span></div>
      <div className="mail-layout">
        <nav className="mail-folders panel" aria-label="Mailbox folders">
          <strong>Mailbox</strong>
          <button type="button" className="mail-folder active">Inbox <span>{people.length}</span></button>
          <button type="button" className="mail-folder">WhatsApp</button>
          <button type="button" className="mail-folder">Sent</button>
        </nav>
        <ul className="mail-list panel" style={{ listStyle: "none", margin: 0, padding: 8 }} data-tour="thread-list">
          {people.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => setId(x.id)}
                aria-pressed={x.id === id}
                className="pick"
              >
                <div className="mail-row-top"><strong>{x.name}</strong><span className="muted">{x.messages.at(-1)?.at ?? "New"}</span></div>
                <div className="mail-subject">{x.messages.length ? `${x.messages.at(-1)?.channel} thread` : "No messages yet"}</div>
                <div className="muted mail-snippet">{x.messages.at(-1)?.body ?? `${x.merchant} · waiting for a message`}</div>
              </button>
            </li>
          ))}
        </ul>
        {p && (
          <section className="panel stack mail-reading" data-tour="reading-pane">
            <div className="mail-reading-head"><div><h2>{p.name}</h2><div className="muted">{p.email ?? p.phone ?? "No address"}</div></div><span className="chip simulated">Simulated</span></div>
            <div className="muted mail-addresses">
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
              <div className="quick-replies" aria-label="Quick replies">{quickReplies.map((reply) => <button type="button" key={reply} onClick={() => setBody(reply)}>{reply}</button>)}</div>
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
      <CoachMarks id={`${kind}-inbox`} steps={[{ target: "[data-tour='thread-list']", text: "Every seeded case has a thread here, so the inbox is ready from the first screen." }, { target: "[data-tour='reading-pane']", text: "Read the full conversation, then use a quick reply or write your own." }]} />
    </div>
  );
}

"use client";

// Customer and buyer inboxes: pick a person, read their WhatsApp, email,
// voice notes and calls, and write back or send a voice note as them.
// Sending goes through the engine like any inbound message.
import { Button } from "@/ui/kit";
import { useMemo, useState } from "react";
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
  initialPersonId,
  voiceSamples = [],
  voiceLive = false,
}: {
  title: string;
  people: Person[];
  kind: "customer" | "buyer";
  initialPersonId?: string;
  voiceSamples?: { id: string; label: string }[];
  voiceLive?: boolean;
}) {
  const [id, setId] = useState(initialPersonId && people.some((p) => p.id === initialPersonId) ? initialPersonId : people.find((p) => p.messages.length > 0)?.id ?? people[0]?.id ?? "");
  const [folder, setFolder] = useState<"inbox" | "whatsapp" | "sent">("inbox");
  const [mobileDetail, setMobileDetail] = useState(Boolean(initialPersonId));
  const [channel, setChannel] = useState<"whatsapp" | "email">("whatsapp");
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction();
  const [status, setStatus] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const threads = useMemo(() => people
    .filter((person) => person.messages.length > 0)
    .map((person) => ({ ...person, messages: person.messages.filter((message) => {
      if (folder === "whatsapp") return message.channel.toLowerCase().includes("whatsapp") || message.channel.toLowerCase().includes("voice");
      if (folder === "sent") return message.direction === "in";
      return true;
    }) }))
    .filter((person) => person.messages.length > 0)
    .sort((a, b) => (b.messages.at(-1)?.sortAt ?? 0) - (a.messages.at(-1)?.sortAt ?? 0)), [people, folder]);
  const p = threads.find((x) => x.id === id) ?? (folder === "inbox" ? people.find((x) => x.id === id) : undefined) ?? threads[0];
  const noMessagePeople = people.filter((person) => person.messages.length === 0);
  const personLabel = (person: Person) => person.name.split(",")[0]!.trim();
  const name = p ? personLabel(p).toLowerCase() : "";
  const quickReplies = kind === "buyer"
    ? ["will clear by Friday", "Please resend the invoice"]
    : name.includes("karan")
      ? ["YES, pause it for a month", "NO, cancel it"]
      : name.includes("rahul")
        ? ["I see the refund, thank you", "I was charged twice"]
        : name.includes("priya")
          ? ["mil gaya, thanks", "I still need help with my order"]
          : ["I received the update, thanks", "I still need help"];
  const scopedSamples = p ? voiceSamples.filter((sample) => {
    const owner = sample.id.split("_")[0]!.toLowerCase();
    const personFirstName = personLabel(p).split(/\s+/)[0]!.toLowerCase();
    return kind === "buyer" ? owner === "buyer" : owner === personFirstName;
  }) : [];
  return (
    <div className="stack">
      <SimTitle>{title}</SimTitle>
      <div className="sim-banner"><SimulatedTag /> <span>You&apos;re seeing what {kind === "customer" ? "the customer" : "the buyer"} sees.</span></div>
      <div className="mail-layout" data-mobile-detail={mobileDetail}>
        <nav className="mail-folders panel" aria-label="Mailbox folders">
          <strong>Mailbox</strong>
          {(["inbox", "whatsapp", "sent"] as const).map((key) => (
            <button key={key} type="button" className={`mail-folder${folder === key ? " active" : ""}`} aria-pressed={folder === key} onClick={() => { setFolder(key); setMobileDetail(false); }}>
              {key === "inbox" ? "Inbox" : key === "whatsapp" ? "WhatsApp" : "Sent by merchant"}
              {key === "inbox" && <span>{people.filter((person) => person.messages.length > 0).length} threads</span>}
            </button>
          ))}
        </nav>
        <div>
          <ul className="mail-list panel thread-list" style={{ listStyle: "none", margin: 0, padding: 8 }} data-tour="thread-list">
          {threads.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                onClick={() => { setId(x.id); setRequestId(crypto.randomUUID()); setMobileDetail(true); }}
                aria-pressed={x.id === id}
                className="pick"
              >
                <div className="mail-row-top"><strong>{personLabel(x)}</strong><span className="muted">{x.messages.at(-1)?.at}</span></div>
                <div className="mail-subject">{x.messages.length ? `${x.messages.at(-1)?.channel} thread` : "No messages yet"}</div>
                <div className="muted mail-snippet">{x.messages.at(-1)?.body ?? `${x.merchant} · waiting for a message`}</div>
              </button>
            </li>
          ))}
          {threads.length === 0 && <li className="empty">No messages in this folder.</li>}
          </ul>
          {noMessagePeople.length > 0 && folder === "inbox" && <label className="muted" style={{ display: "block", marginTop: 10 }}>Other contacts
            <select className="field" value={noMessagePeople.some((x) => x.id === id) ? id : ""} onChange={(e) => { setId(e.target.value); setMobileDetail(true); }}>
              <option value="">Choose a contact</option>{noMessagePeople.map((person) => <option key={person.id} value={person.id}>{personLabel(person)}</option>)}
            </select>
          </label>}
        </div>
        {p && (
          <section className="panel stack mail-reading" data-tour="reading-pane">
            <div className="mail-reading-head"><div><button type="button" className="btn secondary small mail-back" onClick={() => setMobileDetail(false)}>Back to inbox</button><h2>{personLabel(p)}</h2><div className="muted">{p.email ?? p.phone ?? "No address"}</div></div><span className="chip simulated">Simulated</span></div>
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
            {p.phone && scopedSamples.length > 0 && (
              <VoiceCompose
                key={`${kind}-${p.id}`}
                url="/api/dev/voice-notes"
                fields={{ [kind === "customer" ? "customerId" : "buyerId"]: p.id }}
                samples={scopedSamples}
                live={voiceLive}
                sendLabel={`Send as ${p.name.split(",")[0]}`}
                onSent={(res) => {
                  const r = res as { outcome?: string; caseId?: string };
                  setStatus(r.outcome === "unmatched" ? "No flow handles this yet" : r.caseId ? `Went to case ${r.caseId}` : "Sent");
                }}
              />
            )}
            {folder !== "sent" && <form
              className="stack"
              style={{ gap: 6 }}
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await run("send", "/api/dev/messages", { [kind === "customer" ? "customerId" : "buyerId"]: p.id, channel, body, requestId });
                if (r.ok) {
                  setBody("");
                  setRequestId(crypto.randomUUID());
                  const res = r.result as { outcome?: string; caseId?: string };
                  setStatus(res.outcome === "unmatched" ? "No flow handles this yet" : res.caseId ? `Went to case ${res.caseId}` : "Sent");
                }
              }}
            >
              <div className="quick-replies" aria-label="Quick replies">{quickReplies.map((reply) => <button type="button" key={reply} data-guided-customer={kind === "customer" && p.id === "cus_priya" && reply === "mil gaya, thanks" ? "priya" : undefined} onClick={() => setBody(reply)}>{reply}</button>)}</div>
              <div className="row">
                <label>
                  Send on{" "}
                    <select value={channel} onChange={(e) => { setChannel(e.target.value as "whatsapp" | "email"); setRequestId(crypto.randomUUID()); }}>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                  </select>
                </label>
              </div>
              <textarea className="field" rows={3} value={body} onChange={(e) => { setBody(e.target.value); setRequestId(crypto.randomUUID()); }} placeholder={`Write as ${personLabel(p)}`} aria-label={`Message from ${personLabel(p)}`} />
              <div className="row">
                <Button type="submit" isDisabled={!body.trim() || busy !== null}>
                  {`Send as ${p.name.split(",")[0]}`}
                </Button>
                {status && <span role="status">{status}</span>}
                {error && <span className="error">{error}</span>}
              </div>
            </form>}
          </section>
        )}
      </div>
      <CoachMarks id={`${kind}-inbox`} steps={[{ target: "[data-tour='thread-list']", text: "Every seeded case has a thread here, so the inbox is ready from the first screen." }, { target: "[data-tour='reading-pane']", text: "Read the full conversation, then use a quick reply or write your own." }]} />
    </div>
  );
}

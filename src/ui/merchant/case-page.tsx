"use client";

// The case page. Desktop: three panes (conversation, what RAY found, your
// call) with the WhatsApp card in a side panel. Phone: one column, findings
// first, then the conversation, with the action bar fixed to the bottom.
import { Button, Heading, Text } from "@/ui/kit";
import Link from "next/link";
import { useState } from "react";
import type { CaseView, Finding, Proposal } from "@/surfaces/views";
import { DOING_IT, EMPTY, HANDLE_MYSELF, SOMETHING_ELSE } from "@/surfaces/words";
import { ApprovalLabel, Chip, HoldBanner, SimulatedTag, useAction, type PostResult } from "../bits";
import { useView } from "../view";
import { CallCard, PreCallNotice, VoiceNoteBubble } from "../voice";
import { ApprovalCard } from "./approval-card";

export function CasePage({ v }: { v: CaseView }) {
  const { view } = useView();
  const phone = view === "phone";
  return (
    <div className="stack">
      <p>
        <Link href={`/merchant/${v.merchant.id}/cases`}>Back to cases</Link>
      </p>
      <Header v={v} />
      {v.holds.map((h) => (
        <HoldBanner key={h.actionId} hold={h} merchantId={v.merchant.id} />
      ))}
      {v.promiseLine && <div className="banner promise">{v.promiseLine}</div>}
      {v.preCall && <PreCallNotice notice={v.preCall} caseId={v.id} />}
      {v.underRule.map((r) => (
        <div key={r.ruleId} className="banner rule">
          <span>{r.text}</span>
          <Link href={`/merchant/${v.merchant.id}/rules#${r.ruleId}`}>Turn off this rule</Link>
        </div>
      ))}
      {v.results.map((r, i) => (
        <div key={i} className="banner promise" role="status">
          {r}
        </div>
      ))}
      {phone ? (
        <>
          <FindingsPane v={v} />
          <ConversationPane v={v} />
          <EventsPane v={v} />
          {v.open && !v.merchant.killSwitch && (
            <div className="action-bar">
              <div className="inner">
                <YourCall v={v} compact />
              </div>
            </div>
          )}
        </>
      ) : (
        <div className={v.card ? "with-side" : ""}>
          <div className="stack">
            <div className="panes-3">
              <ConversationPane v={v} />
              <FindingsPane v={v} />
              <section className="panel" aria-label="Your call">
                <h2>Your call</h2>
                {v.open && !v.merchant.killSwitch ? <YourCall v={v} /> : <Text color="surface.text.gray.muted">{v.open ? "Actions are paused." : "This case is finished."}</Text>}
              </section>
            </div>
            <EventsPane v={v} />
          </div>
          {v.card && (
            <aside className="panel" aria-label="WhatsApp card">
              <div className="sim-head">
                <h2 style={{ margin: 0 }}>WhatsApp</h2>
                <SimulatedTag />
              </div>
              <div className="wa" style={{ marginTop: 8 }}>
                <ApprovalCard card={v.card} merchantId={v.merchant.id} showOpen={false} />
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function Header({ v }: { v: CaseView }) {
  return (
    <section className="panel stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Heading size="large">{`${v.name} · ${v.amount}`}</Heading>
        <Chip chip={v.state} />
      </div>
      <div className="row muted">
        <span>{v.moment}</span>
        {v.orderNumber && <span>· Order {v.orderNumber}</span>}
        {v.paymentId && (
          <span title={v.paymentId} tabIndex={0}>
            · {v.paymentShort}
          </span>
        )}
      </div>
      <div className="row">
        <Chip chip={v.confidence} />
        <span>{v.confidence.reason}</span>
      </div>
      {v.side && (
        <div className="row">
          <strong>{v.side.label}</strong>
          <span className="muted">{v.side.note}</span>
        </div>
      )}
      {v.timeline.length > 0 && (
        <div className="timeline-line" aria-label="What happened">
          {v.timeline.map((st, i) => (
            <span key={i} className="row" style={{ gap: 6 }}>
              {i > 0 && <span aria-hidden="true">→</span>}
              <span className={st.failed ? "failed" : ""}>{st.failed ? `✗ ${st.label}` : st.label}</span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function Evidence({ merchantId, refId }: { merchantId: string; refId: string }) {
  const [record, setRecord] = useState<string | null>(null);
  return (
    <details
      onToggle={async (e) => {
        if (!(e.target as HTMLDetailsElement).open || record) return;
        const res = await fetch(`/api/merchant/evidence?merchantId=${encodeURIComponent(merchantId)}&ref=${encodeURIComponent(refId)}`);
        const json = (await res.json()) as PostResult;
        setRecord(json.ok ? JSON.stringify(json.result, null, 2) : json.error);
      }}
    >
      <summary>Show evidence</summary>
      <div className="muted" style={{ fontSize: 12 }}>Details for your developer</div>
      <pre className="raw">{record ?? "Loading…"}</pre>
    </details>
  );
}

function FindingRow({ f, merchantId }: { f: Finding; merchantId: string }) {
  return (
    <div className="finding">
      <span className={`mark ${f.ok ? "ok" : "bad"}`} aria-label={f.ok ? "Checks out" : "Doesn't check out"}>
        {f.ok ? "✓" : "✗"}
      </span>
      <div>
        <div>{f.text}</div>
        <div className="row">
          <span className="chip neutral">{f.source}</span>
          {f.evidenceRef && <Evidence merchantId={merchantId} refId={f.evidenceRef} />}
        </div>
      </div>
    </div>
  );
}

function FindingsPane({ v }: { v: CaseView }) {
  return (
    <section className="panel" aria-label="What RAY found">
      <h2>What RAY found</h2>
      {v.checking && (
        <ul className="muted" style={{ margin: "0 0 8px", paddingLeft: 18 }}>
          {v.findings.map((f) => (
            <li key={`c-${f.id}`}>{`Checked: ${f.text} ✓`}</li>
          ))}
          <li>Checking…</li>
        </ul>
      )}
      {v.findings.length === 0 ? <p className="muted">{EMPTY.findings}</p> : v.findings.map((f) => <FindingRow key={f.id} f={f} merchantId={v.merchant.id} />)}
      {v.developerBrief && (
        <details>
          <summary>Details for your developer</summary>
          <pre className="raw">{v.developerBrief}</pre>
        </details>
      )}
    </section>
  );
}

function ConversationPane({ v }: { v: CaseView }) {
  return (
    <section className="panel" aria-label="Conversation">
      <h2>Conversation</h2>
      {v.conversation.length === 0 ? (
        <p className="muted">{EMPTY.conversation}</p>
      ) : (
        <div className="wa">
          {v.conversation.map((m) => {
            const meta = `${m.from} · ${m.channel} · ${m.at}`;
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
      )}
    </section>
  );
}

function EventsPane({ v }: { v: CaseView }) {
  return (
    <section className="panel" aria-label="Everything that happened">
      <h2>Everything that happened</h2>
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {v.events.map((e) => (
          <li key={e.id}>
            <details>
              <summary>
                <span className="muted">{e.at}</span> · {e.what}
              </summary>
              <div className="stack" style={{ gap: 4, padding: "6px 0" }}>
                <div>
                  <strong>Who:</strong> {e.who}
                </div>
                {e.evidenceRef && <Evidence merchantId={v.merchant.id} refId={e.evidenceRef} />}
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TapButton({ p, variant, caseId, busy, onTap }: { p: Proposal; variant: "primary" | "secondary"; caseId: string; busy: string | null; onTap: (key: string, body: unknown) => void }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <Button variant={variant} isFullWidth isDisabled={busy !== null} onClick={() => onTap(p.id, { caseId, choice: "approve", proposalId: p.id })}>
        {busy === p.id ? DOING_IT : p.label}
      </Button>
      <ApprovalLabel covered={p.covered} />
      {(p.then ?? []).map((x) => (
        <span key={x} className="muted" style={{ fontSize: 12 }}>
          {x}
        </span>
      ))}
    </div>
  );
}

function YourCall({ v, compact }: { v: CaseView; compact?: boolean }) {
  const { busy, error, run } = useAction();
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState("");
  const yc = v.yourCall;
  const tap = (key: string, body: unknown) => run(key, "/api/merchant/tap", body);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Text weight="semibold">{yc.question}</Text>
      {yc.unsure ? (
        <Text color="surface.text.gray.muted">RAY isn&apos;t sure yet, so it will only ask. Nothing moves until it is.</Text>
      ) : yc.canTap && yc.primary ? (
        <>
          <TapButton p={yc.primary} variant="primary" caseId={v.id} busy={busy} onTap={tap} />
          {!compact && yc.secondary.map((p) => <TapButton key={p.id} p={p} variant="secondary" caseId={v.id} busy={busy} onTap={tap} />)}
          <button type="button" className="linkbtn" onClick={() => setChanging((c) => !c)} aria-expanded={changing}>
            {SOMETHING_ELSE}
          </button>
          {changing && (
            <form
              className="stack"
              style={{ gap: 6 }}
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await run("change", "/api/merchant/change", { caseId: v.id, text });
                if (r.ok) {
                  setText("");
                  setChanging(false);
                }
              }}
            >
              <label htmlFor={`yc-change-${v.id}`} className="muted">What should RAY do instead?</label>
              <textarea id={`yc-change-${v.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Refund instead, or add a note" />
              <Button type="submit" variant="secondary" isDisabled={!text.trim() || busy !== null}>
                {busy === "change" ? DOING_IT : "Send to RAY"}
              </Button>
            </form>
          )}
        </>
      ) : (
        <Text color="surface.text.gray.muted">{v.state.label}. Nothing needs your tap right now.</Text>
      )}
      {!compact && yc.draft && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="muted">Draft</span>
          <div className="bubble mine">{yc.draft}</div>
        </div>
      )}
      {!compact && <span className="muted">{yc.sendFrom}</span>}
      {!compact &&
        yc.changes.map((c, i) => (
          <span key={i} className="muted">
            You asked at {c.at}: {c.text}
          </span>
        ))}
      {v.open && (
        <Button variant="tertiary" isDisabled={busy !== null} onClick={() => tap("myself", { caseId: v.id, choice: "handle_myself" })}>
          {busy === "myself" ? DOING_IT : HANDLE_MYSELF}
        </Button>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

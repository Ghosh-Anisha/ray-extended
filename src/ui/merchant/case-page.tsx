"use client";

// The case page (docs/ui-rebuild.md 3.3). Desktop: three panes (conversation,
// what RAY found, your call), the case timeline below, the WhatsApp card in a
// side panel. Phone: one column, findings first, then the conversation, with
// the action bar fixed to the bottom.
import { ArrowLeft, Check, Clock3, Copy, Mail, MessageCircle, Mic, Phone, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CaseView, Finding, Proposal } from "@/surfaces/views";
import { DOING_IT, EMPTY, HANDLE_MYSELF, SOMETHING_ELSE } from "@/surfaces/words";
import { Button, Text } from "@/ui/kit";
import { ApprovalLabel, Chip, HoldBanner, post, useAction, type PostResult } from "../bits";
import { NudgeBar } from "../nudge";
import { useToast } from "../toast";
import { useView } from "../view";
import { CallCard, PreCallNotice, VoiceNoteBubble } from "../voice";
import { ApprovalCard } from "./approval-card";
import { CoachMark } from "../coach-mark";

// Set after a tap until the refreshed case arrives (or a few seconds pass).
type Pending = { state: string; results: number } | null;

export function CasePage({ v, returnTo }: { v: CaseView; returnTo?: string }) {
  const { view } = useView();
  const phone = view === "phone";
  const [pending, setPending] = useState<Pending>(null);
  const router = useRouter();
  const toast = useToast();

  // The tap landed: the case has moved. Say where, and offer Undo when a hold exists.
  useEffect(() => {
    if (!pending) return;
    const changed = v.state.label !== pending.state || v.results.length !== pending.results;
    if (!changed) {
      const t = setTimeout(() => setPending(null), 5000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(null);
    const hold = v.holds[0];
    const where = v.open ? "RAY is handling" : "Closed";
    toast(
      `Moved to ${where}`,
      hold
        ? {
            label: hold.control,
            run: async () => {
              await post("/api/merchant/undo", { merchantId: v.merchant.id, actionId: hold.actionId });
              router.refresh();
            },
          }
        : undefined,
    );
  }, [pending, v, toast, router]);

  const banners = (
    <>
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
        <div key={i} className={`banner ${r.includes("outcome checked in demo data:") || r.startsWith("Test-mode outcome checked:") ? "success" : "promise"}`} role="status">
          {r.includes("outcome checked in demo data:") || r.startsWith("Test-mode outcome checked:") ? <Check size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}
          <span className="grow">{r}</span>
        </div>
      ))}
    </>
  );
  const onTapped = () => setPending({ state: v.state.label, results: v.results.length });
  const next = v.open && v.yourCall.canTap && v.yourCall.primary ? v.yourCall.primary.label : null;

  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <BackLink href={returnTo ?? `/merchant/${v.merchant.id}/cases`} />
      </p>
      <Header v={v} />
      {phone && banners}
      {phone ? (
        <>
          <FindingsPane v={v} />
          <ConversationPane v={v} />
          <EventsPane v={v} />
          {v.open && !v.merchant.killSwitch && (
            <div className="action-bar">
              <div className="inner">
                <YourCall v={v} compact pending={pending !== null} onTapped={onTapped} />
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="stack">
          <div className="panes-3">
            <ConversationPane v={v} />
            <FindingsPane v={v} />
            <section className="panel stack" style={{ gap: 12 }} aria-label="Your call">
              <h2 style={{ margin: 0 }}>Your call</h2>
              {banners}
              {v.open && !v.merchant.killSwitch ? <YourCall v={v} pending={pending !== null} onTapped={onTapped} /> : <Text color="surface.text.gray.muted">{v.open ? "Actions are paused." : "This case is finished."}</Text>}
            </section>
          </div>
          <EventsPane v={v} />
          {v.card && <details className="panel">
            <summary>WhatsApp approval card <span className="chip simulated">Simulated</span></summary>
            <div className="wa" style={{ marginTop: 8, maxWidth: 440 }}>
              <ApprovalCard card={v.card} merchantId={v.merchant.id} showOpen={false} />
            </div>
          </details>}
        </div>
      )}
      {(next || !v.open) && <NudgeBar
        text={next ? `RAY suggests: ${next}. This suggestion uses the evidence shown here; cost and alternatives may not be fully modeled. ${v.yourCall.primary?.covered ? "Prototype cover is proposed, not an approved guarantee." : "It is your call."}` : v.open ? "Nothing needs your tap on this case right now." : "This case is finished. Back to the rest of your list."}
        action={{ label: "All cases", href: `/merchant/${v.merchant.id}/cases` }}
      />}
      {v.simulated && <CoachMark id={`case-${v.id}`} steps={["This is a replayed U7 case using the same findings, timeline and Your call layout as a live case.", "Every external system on this case is labelled Simulated. RAY's checks are visible in the middle pane."]} />}
    </div>
  );
}

// Back goes to the same tab and scroll position when there is a history to go back to.
function BackLink({ href }: { href: string }) {
  return (
    <Link href={href} className="back">
      <ArrowLeft size={16} aria-hidden="true" />
      Back to cases
    </Link>
  );
}

function Header({ v }: { v: CaseView }) {
  return (
    <section className="panel stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 className="page-title">{`${v.name} · ${v.amount}`}</h1>
        <span className="row"><Chip chip={v.state} />{v.simulated && <span className="chip simulated">Preview · Simulated</span>}</span>
      </div>
      <div className="row muted">
        <span>{v.moment}</span>
        {v.orderNumber && <span>· Order {v.orderNumber}</span>}
        {v.paymentId && <PaymentReference v={v} />}
      </div>
      <div className="row">
        <Chip chip={v.confidence} />
        <span>{v.confidence.reason}</span>
      </div>
    </section>
  );
}

function PaymentReference({ v }: { v: CaseView }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(v.paymentId!);
      setStatus("Payment ID copied");
    } catch {
      setOpen(true);
      setStatus("Select and copy the full ID");
    }
  }
  return <span className="stack" style={{ display: "inline-flex", gap: 4 }}>
    <button type="button" className="linkbtn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>· {v.paymentShort} · Payment reference</button>
    {open && <span className="panel stack" style={{ padding: 10, gap: 6 }}>
      <strong>Payment reference</strong>
      <code tabIndex={0} style={{ userSelect: "all", overflowWrap: "anywhere" }}>{v.paymentId}</code>
      <span className="muted">{v.amount} · {v.openedAtLabel}</span>
      {v.orderNumber && <Link href="/sim/store">Related store order #{v.orderNumber}</Link>}
      <Button size="small" variant="secondary" onClick={() => void copy()}><Copy size={14} aria-hidden="true" /> Copy payment ID</Button>
      {status && <span role="status" className="muted">{status}</span>}
    </span>}
  </span>;
}

function Evidence({ merchantId, refId, simulated = false }: { merchantId: string; refId: string; simulated?: boolean }) {
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
      <div className="muted" style={{ fontSize: 12 }}>{simulated ? "Seeded demo finding; not an external source record" : "Details for your developer"}</div>
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
          {f.evidenceRef && <Evidence merchantId={merchantId} refId={f.evidenceRef} simulated={f.source === "Simulated"} />}
        </div>
      </div>
    </div>
  );
}

// "Checked payment pay_Q8x… ✓ → Checked store order ✓ → Found the cause": one
// line per place RAY looked, shown step by step the first time this browser
// opens the case.
function investigationSteps(v: CaseView): string[] {
  const sources = [...new Set(v.findings.map((f) => f.source))];
  const lines = sources.map((s) =>
    s === "Razorpay" ? (v.paymentShort ? `Checked payment ${v.paymentShort}` : "Checked Razorpay's records") : s === "Store" ? `Checked store order${v.orderNumber ? ` ${v.orderNumber}` : ""}` : s === "Customer" ? "Read what the customer wrote" : s === "Bank" ? "Checked the bank record" : "Read a seeded simulated finding",
  );
  return [...lines, v.side ? "Found the cause" : "Put the findings together"];
}

function Investigation({ v }: { v: CaseView }) {
  const steps = investigationSteps(v);
  const seenKey = `ray-investigated-${v.id}`;
  const [shown, setShown] = useState(steps.length);
  const ran = useRef(false);
  // First open in this browser: start from zero and reveal a step at a time.
  useLayoutEffect(() => {
    if (ran.current || v.findings.length === 0) return;
    ran.current = true;
    try {
      if (window.localStorage.getItem(seenKey)) return;
      window.localStorage.setItem(seenKey, "1");
    } catch {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown(0);
  }, [v.findings.length, seenKey]);
  useEffect(() => {
    if (shown >= steps.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), 550);
    return () => clearTimeout(t);
  }, [shown, steps.length]);
  if (v.findings.length === 0) return null;
  return (
    <ol className="investigation" aria-label="How RAY checked" data-running={shown < steps.length}>
      {steps.map((s, i) => (
        <li key={s} className={i < shown ? "done" : i === shown ? "active" : "waiting"}>
          <span className="tick" aria-hidden="true">{i < shown ? <Check size={14} /> : i === shown ? <span className="spinner" /> : null}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}

function FindingsPane({ v }: { v: CaseView }) {
  return (
    <section className="panel stack" style={{ gap: 12 }} aria-label="What RAY found">
      <h2 style={{ margin: 0 }}>What RAY found</h2>
      {v.side && (
        <div className="side-chip" data-side={v.side.label}>
          <ShieldCheck size={16} aria-hidden="true" />
          <strong>{v.side.label}</strong>
          <span>· {v.side.note}</span>
        </div>
      )}
      <Investigation v={v} />
      {v.checking && (
        <ul className="muted" style={{ margin: "0 0 8px", paddingLeft: 18 }}>
          {v.findings.map((f) => (
            <li key={`c-${f.id}`}>{`Checked: ${f.text} ✓`}</li>
          ))}
          <li>Checking…</li>
        </ul>
      )}
      <div>{v.findings.length === 0 ? <p className="muted">{EMPTY.findings}</p> : v.findings.map((f) => <FindingRow key={f.id} f={f} merchantId={v.merchant.id} />)}</div>
      {v.timeline.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="muted">What happened</span>
          <div className="timeline-line" aria-label="What happened">
            {v.timeline.map((st, i) => (
              <span key={i} className="row" style={{ gap: 6 }}>
                {i > 0 && <span aria-hidden="true">→</span>}
                <span className={st.failed ? "failed" : ""}>
                  {st.failed && <X size={12} aria-hidden="true" />}
                  {st.failed ? ` ${st.label}` : st.label}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
      {v.developerBrief && (
        <details>
          <summary>Details for your developer</summary>
          <pre className="raw">{v.developerBrief}</pre>
        </details>
      )}
    </section>
  );
}

const CHANNEL_ICON = (channel: string) => (channel === "Email" ? Mail : channel.includes("voice") ? Mic : channel === "Call" ? Phone : MessageCircle);

function ConversationPane({ v }: { v: CaseView }) {
  const from = v.yourCall.sendFrom.replace(/^RAY will send this from /, "");
  return (
    <section className="panel stack" style={{ gap: 12 }} aria-label="Conversation">
      <h2 style={{ margin: 0 }}>Conversation</h2>
      {v.conversation.length === 0 ? (
        <p className="muted">{EMPTY.conversation}</p>
      ) : (
        <div className="wa">
          {v.conversation.map((m) => {
            const Icon = CHANNEL_ICON(m.channel);
            const meta = (
              <>
                <Icon size={11} aria-hidden="true" /> {m.from} · {m.channel} · {m.at}
              </>
            );
            const plain = `${m.from} · ${m.channel} · ${m.at}`;
            if (m.call) return <CallCard key={m.id} call={m.call} meta={plain} />;
            if (m.voice) return <VoiceNoteBubble key={m.id} note={m.voice} mine={m.direction === "out"} meta={plain} />;
            return (
              <div key={m.id} className={`bubble ${m.direction === "out" ? "mine" : ""}`}>
                {m.body}
                <div className="meta chan">{meta}</div>
              </div>
            );
          })}
        </div>
      )}
      <div className="composer" aria-label="Reply">
        <span className="muted">{`RAY will reply from ${from}`}</span>
      </div>
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
      <Button variant={variant} isFullWidth isDisabled={busy !== null} data-guided={variant === "primary" ? "primary-action" : undefined} onClick={() => onTap(p.id, { caseId, choice: "approve", proposalId: p.id })}>
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

function YourCall({ v, compact, pending, onTapped }: { v: CaseView; compact?: boolean; pending: boolean; onTapped: () => void }) {
  const { busy: posting, error, run } = useAction();
  const [last, setLast] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState("");
  // "Doing it…" holds from the tap until the refreshed case arrives.
  const busy = posting ?? (pending ? last : null);
  const yc = v.yourCall;
  const tap = async (key: string, body: unknown) => {
    setLast(key);
    const r = await run(key, "/api/merchant/tap", body);
    if (r.ok) onTapped();
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Text weight="semibold">{yc.question}</Text>
      {yc.unsure ? (
        <Text color="surface.text.gray.muted">RAY isn&apos;t sure yet, so it will only ask. Nothing moves until it is.</Text>
      ) : yc.canTap && yc.primary ? (
        <>
          <Text color="surface.text.gray.muted">Suggestion based on the evidence shown above. Costs and alternatives may not be fully modeled.</Text>
          <TapButton p={yc.primary} variant="primary" caseId={v.id} busy={busy} onTap={tap} />
          {yc.secondary.length > 0 && (compact ? (
            <details className="other-options">
              <summary>Other options</summary>
              <div className="stack" style={{ marginTop: 8, gap: 8 }}>
                {yc.secondary.map((p) => <TapButton key={p.id} p={p} variant="secondary" caseId={v.id} busy={busy} onTap={tap} />)}
              </div>
            </details>
          ) : yc.secondary.map((p) => <TapButton key={p.id} p={p} variant="secondary" caseId={v.id} busy={busy} onTap={tap} />))}
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

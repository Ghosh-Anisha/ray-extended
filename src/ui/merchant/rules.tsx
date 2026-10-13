"use client";

// Rules (docs/ui-rebuild.md 3.5): chat first, then the rules that are on,
// then what RAY suggests. The tone, sign-off, send-from, refund speed and
// calling hours settings sit in a collapsed Settings section.
import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { AskReply } from "@/ask/answer";
import type { RuleCardRow, RulesView } from "@/ask/rules-view";
import { REFUND_SPEED_LABEL, TONES } from "@/surfaces/words";
import { Button } from "@/ui/kit";
import { post, useAction } from "../bits";
import { ReplyView } from "../ask/reply";
import { CoachMarks } from "../coach/coach";
import { NudgeBar } from "../nudge";

const EXAMPLES = ["Refund duplicate charges under ₹500 automatically", "Always bring me cases above ₹2,000", "Call subscribers worth more than ₹3,000", "Write to customers in a formal tone"];

function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

function RuleChat({ merchantId }: { merchantId: string }) {
  const [text, setText] = useState("");
  const [reply, setReply] = useState<AskReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(0);
  async function submit(t: string) {
    if (!t.trim()) return;
    setBusy(true);
    const r = await post("/api/merchant/ask", { merchantId, text: t });
    setBusy(false);
    if (r.ok) {
      setReply(r.result as AskReply);
      setAsked((n) => n + 1);
      setText("");
    }
  }
  return (
    <section className="panel stack" style={{ gap: 12 }} data-coach="rules-chat">
      <div>
        <h2 style={{ fontSize: 16 }}>Tell RAY how to handle things</h2>
        <p className="muted" style={{ margin: 0 }}>Example: “Always ask me before refunding over ₹2,000.”</p>
      </div>
      <form
        className="ask-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a rule…" aria-label="Tell RAY a rule" maxLength={400} />
        <button type="submit" className="btn primary small" disabled={busy || !text.trim()}>
          <Sparkles size={14} aria-hidden="true" />
          Ask RAY
        </button>
      </form>
      <div className="chips-scroll" style={{ flexWrap: "wrap" }}>
        {EXAMPLES.map((e) => (
          <button key={e} type="button" className="seg" onClick={() => submit(e)}>
            {e}
          </button>
        ))}
      </div>
      {reply && (
        <div className="ask-msg ray" key={asked}>
          <ReplyView merchantId={merchantId} reply={reply} onChip={submit} />
        </div>
      )}
    </section>
  );
}

function ActiveCard({ r, merchantId }: { r: RuleCardRow; merchantId: string }) {
  const { busy, error, run } = useAction();
  function change(on: boolean) {
    if (r.kind === "rule") run(r.key, "/api/merchant/rule", { merchantId, ruleId: r.id, status: on ? "approved" : "off" });
    if (r.kind === "auto") run(r.key, "/api/merchant/setting", { merchantId, moment: r.moment, key: "auto_customer_messages", value: on });
  }
  return (
    <div className="rule-row" data-on={r.on} id={r.id ?? undefined}>
      <div className="grow stack" style={{ gap: 4 }}>
        <strong>{r.sentence}</strong>
        {r.detail && <span className="muted">{r.detail}</span>}
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <span className="chip neutral">{r.momentLabel}</span>
          {r.limit && <span className="chip information">{r.limit}</span>}
          <span className="muted">
            {r.kind === "limit" ? "Change the amount under Settings" : r.used > 0 ? `Used ${r.used} time${r.used === 1 ? "" : "s"}${r.lastUsed ? ` · last ${r.lastUsed}` : ""}` : "Not used yet"}
          </span>
        </div>
        {error && <span className="error">{error}</span>}
      </div>
      {r.kind !== "limit" && <Toggle on={r.on} label={`${r.sentence}: ${r.on ? "on" : "off"}`} onChange={change} disabled={busy !== null} />}
    </div>
  );
}

function Suggested({ r, merchantId }: { r: RuleCardRow; merchantId: string }) {
  const { busy, error, run } = useAction();
  return (
    <div className="rule-card">
      <div className="rule-card-head">
        <span className="chip notice">Suggested by RAY</span>
        <span className="chip neutral">{r.momentLabel}</span>
      </div>
      <strong className="rule-sentence">{r.sentence}</strong>
      {r.detail && <div className="muted">{r.detail}</div>}
      {r.limit && <div className="muted">{r.limit}</div>}
      {r.why && <p className="rule-does">{r.why}</p>}
      {error && <span className="error">{error}</span>}
      <div className="row">
        <Button size="small" isDisabled={busy !== null} onClick={() => run(r.key, "/api/merchant/rule", { merchantId, ruleId: r.id, status: "approved" })}>
          Approve rule
        </Button>
        <Button size="small" variant="tertiary" isDisabled={busy !== null} onClick={() => run(`${r.key}-off`, "/api/merchant/rule", { merchantId, ruleId: r.id, status: "off" })}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function Settings({ v }: { v: RulesView["settings"] }) {
  const { busy, error, run } = useAction();
  const [limit, setLimit] = useState(String(v.approvalLimitRupees));
  const mid = v.merchant.id;
  const setting = (moment: string, key: string, value: string | boolean) => run(`${moment}-${key}`, "/api/merchant/setting", { merchantId: mid, moment, key, value });
  return (
    <details className="panel settings">
      <summary>
        <strong>Settings</strong>
        <span className="muted"> · Approval limit, tone, sign-off, send-from, refund speed</span>
      </summary>
      <div className="stack" style={{ marginTop: 16 }}>
        {error && <span className="error">{error}</span>}
        <form
          className="row"
          style={{ justifyContent: "space-between" }}
          onSubmit={(e) => {
            e.preventDefault();
            run("limit", "/api/merchant/limit", { merchantId: mid, rupees: Number(limit) });
          }}
        >
          <div>
            <strong>Approval limit</strong>
            <div className="muted">Anything above {v.approvalLimit} always comes to you.</div>
          </div>
          <label className="row">
            ₹ <input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))} style={{ width: 100 }} aria-label="Approval limit in rupees" />
            <Button type="submit" size="small" variant="secondary" isDisabled={busy !== null}>
              Save limit
            </Button>
          </label>
        </form>
        <div className="cols-2">
          {v.moments.map((m) => (
            <div key={m.moment} className="stack" style={{ gap: 10, border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
              <strong>{m.label}</strong>
              <label className="row" style={{ justifyContent: "space-between" }}>
                <span>Tone</span>
                <select value={m.settings.tone} onChange={(e) => setting(m.moment, "tone", e.target.value)}>
                  {TONES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <SignOff initial={m.settings.signOff} onSave={(val) => setting(m.moment, "sign_off", val)} />
              <label className="row" style={{ justifyContent: "space-between" }}>
                <span>Send from</span>
                <select value={m.settings.sendFrom} onChange={(e) => setting(m.moment, "send_from", e.target.value)}>
                  {m.sendFromOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="row" style={{ justifyContent: "space-between" }}>
                <span>Refund speed</span>
                <select value={m.settings.refundSpeed} onChange={(e) => setting(m.moment, "refund_speed", e.target.value)}>
                  {Object.entries(REFUND_SPEED_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function SignOff({ initial, onSave }: { initial: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <form
      className="row"
      style={{ justifyContent: "space-between" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSave(v.trim());
      }}
    >
      <label className="row">
        <span>Sign-off</span>
        <input value={v} onChange={(e) => setV(e.target.value)} style={{ width: 150 }} />
      </label>
      <Button type="submit" size="small" variant="tertiary" isDisabled={v.trim() === initial}>
        Save sign-off
      </Button>
    </form>
  );
}

export function Rules({ view }: { view: RulesView }) {
  const mid = view.settings.merchant.id;
  const first = view.suggested.find((r) => !r.detail) ?? view.suggested[0];
  return (
    <section className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">Rules</h1>
        <p className="page-sub">What RAY may do without asking you. Everything else comes to you for a tap.</p>
      </div>
      <RuleChat merchantId={mid} />
      <div className="stack" data-coach="rules-active">
        <h2 className="section-title">Active rules</h2>
        <div className="panel rules-list">
          {view.active.map((r) => (
            <ActiveCard key={r.key} r={r} merchantId={mid} />
          ))}
        </div>
      </div>
      {view.suggested.length > 0 && (
        <div className="stack" id="suggested" data-coach="rules-suggested">
          <h2 className="section-title">Suggested by RAY</h2>
          {view.suggested.map((r) => (
            <Suggested key={r.key} r={r} merchantId={mid} />
          ))}
        </div>
      )}
      <Settings v={view.settings} />
      <NudgeBar
        text={first ? `RAY suggests a rule: ${first.sentence} (${first.momentLabel}).` : "Tell RAY a rule above, or ask it what to set up first."}
        action={first ? { label: "Review rule", href: "#suggested" } : { label: "Ask RAY", href: `/merchant/${mid}/ask?q=${encodeURIComponent("What should I set up first?")}` }}
      />
      <CoachMarks
        id="rules"
        steps={[
          { target: "[data-coach='rules-chat']", title: "Tell RAY in your own words", text: "Type how you want things handled. RAY shows the rule and saves it only when you tap Approve rule." },
          { target: "[data-coach='rules-active']", title: "Switch a rule off any time", text: "Each rule shows how often RAY used it. Turn it off and RAY asks you again." },
          ...(first ? [{ target: "[data-coach='rules-suggested']", title: "RAY learns from your choices", text: "When you make the same choice a few times, RAY suggests a rule. It stays off until you approve it." }] : []),
        ]}
      />
    </section>
  );
}

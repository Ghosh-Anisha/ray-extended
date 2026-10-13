"use client";

// My dashboard (docs/ui-rebuild.md 3.6 and 12): three questions, a starter
// dashboard from computed numbers, asking for widgets, a watch with Why?,
// reports in words and the month-end CA pack.
import { Bell, ChevronDown, ChevronUp, FileText, MessageCircle, Pin, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AUDIENCE_OPTIONS, BUSINESS_OPTIONS, DAILY_OPTIONS, REPORT_EXAMPLES, ASK_EXAMPLES, type DashboardView, type Report, type WatchAlert } from "@/surfaces/dashboard";
import type { DashboardResult } from "@/surfaces/dashboard-actions";
import { NudgeBar } from "../nudge";

type Result = { ok: boolean; error?: string; result?: DashboardResult };

function useDash(merchantId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function call(key: string, body: Record<string, unknown>): Promise<DashboardResult | null> {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch("/api/merchant/dashboard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ merchantId, ...body }) });
      const json = (await res.json()) as Result;
      if (!json.ok) throw new Error(json.error ?? "That didn't work. Try again.");
      router.refresh();
      return json.result ?? {};
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
      return null;
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, call };
}

function Choice({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className="seg" aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

function Setup({ view, merchantId }: { view: DashboardView; merchantId: string }) {
  const { call, error } = useDash(merchantId);
  const [business, setBusiness] = useState(view.suggested.business);
  const [daily, setDaily] = useState(view.suggested.daily);
  const [audience, setAudience] = useState(view.suggested.audience);
  const [building, setBuilding] = useState(false);
  async function build() {
    setBuilding(true);
    await new Promise((r) => setTimeout(r, 1000));
    if (!(await call("setup", { action: "setup", business, daily, audience }))) setBuilding(false);
  }
  return (
    <section className="panel stack" data-coach="dash-setup" aria-label="Set up your dashboard">
      <div>
        <h2 style={{ fontSize: 18, margin: 0 }}>Three questions, then your dashboard</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>We picked these from your data. Change any of them.</p>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <strong>What kind of business is it?</strong>
        <div className="row">{BUSINESS_OPTIONS.map((o) => <Choice key={o} label={o} on={business === o} onClick={() => setBusiness(o)} />)}</div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <strong>What do you check every day?</strong>
        <div className="row">
          {DAILY_OPTIONS.map((o) => (
            <Choice key={o} label={o} on={daily.includes(o)} onClick={() => setDaily(daily.includes(o) ? daily.filter((d) => d !== o) : [...daily, o])} />
          ))}
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <strong>Who else looks at the numbers?</strong>
        <div className="row">{AUDIENCE_OPTIONS.map((o) => <Choice key={o} label={o} on={audience === o} onClick={() => setAudience(o)} />)}</div>
      </div>
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="row">
        <button type="button" className="btn primary" disabled={building} onClick={build}>
          {building ? "Building your dashboard…" : "Build my dashboard"}
        </button>
      </div>
    </section>
  );
}

function ReportView({ report, merchantId, text }: { report: Report; merchantId: string; text: string }) {
  const { call, busy } = useDash(merchantId);
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="stack report" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{report.title}</strong>
        <span className="chip neutral"><FileText size={12} aria-hidden="true" /> Preview</span>
      </div>
      <ul className="summary-lines" aria-label="Summary">
        {report.summary.map((l) => <li key={l}>{l}</li>)}
      </ul>
      <div className="table-wrap">
        <table className="data">
          <thead><tr>{report.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {report.rows.length === 0 && <tr><td colSpan={report.columns.length} className="muted">Nothing in this period.</td></tr>}
            {report.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
            <tr className="total">{report.total.map((c, j) => <td key={j}><strong>{c}</strong></td>)}</tr>
          </tbody>
        </table>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={busy !== null || done !== null}
          onClick={async () => {
            const r = await call("sch", { action: "schedule", what: "report", text });
            if (r?.message) setDone(r.message);
          }}
        >
          <MessageCircle size={16} aria-hidden="true" />
          Schedule to CA on WhatsApp
        </button>
        <span className="chip simulated">Simulated</span>
        {done && <span className="chip positive">{done}</span>}
      </div>
    </div>
  );
}

function Alert({ alert }: { alert: WatchAlert }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="watch-alert">
      <div className="row">
        <span className="chip notice"><Bell size={12} aria-hidden="true" /> Unusual</span>
        <span className="grow"><strong>{alert.headline}</strong></span>
        <button type="button" className="btn secondary small" aria-expanded={open} onClick={() => setOpen(!open)}>
          Why? {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        </button>
      </div>
      {open && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <strong>{alert.why.title}</strong>
          {alert.why.rows.map((r) => (
            <div key={r.label} className="row" style={{ justifyContent: "space-between" }}>
              <span>{r.label}</span>
              <span><strong>{r.value}</strong> <span className="muted">{r.sub}</span></span>
            </div>
          ))}
          <ul className="summary-lines">{alert.why.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          {alert.action && <Link className="btn primary small" href={alert.action.href} style={{ alignSelf: "flex-start" }}>{alert.action.label}</Link>}
        </div>
      )}
    </div>
  );
}

export function Dashboard({ view, merchantId }: { view: DashboardView; merchantId: string }) {
  const { call, busy, error } = useDash(merchantId);
  const [ask, setAsk] = useState("");
  const [reply, setReply] = useState<DashboardResult | null>(null);
  const [reportText, setReportText] = useState("");
  const [report, setReport] = useState<{ text: string; report: Report } | null>(null);
  const [reportMsg, setReportMsg] = useState<DashboardResult | null>(null);
  const [packOpen, setPackOpen] = useState(false);
  const [packDone, setPackDone] = useState<string | null>(null);
  const base = `/merchant/${merchantId}`;

  if (!view.setup) return <Setup view={view} merchantId={merchantId} />;

  const watched = view.widgets.filter((w) => w.watch);
  const alertOf = (id: string) => view.alerts.find((a) => a.widgetId === id);

  async function submitAsk(text: string) {
    if (!text.trim()) return;
    const r = await call("ask", { action: "ask", text });
    if (r) {
      setReply(r);
      setAsk("");
    }
  }
  async function submitReport(text: string) {
    if (!text.trim()) return;
    const r = await call("report", { action: "report", text });
    if (!r) return;
    setReportText(text);
    if (r.report) {
      setReport({ text, report: r.report });
      setReportMsg(null);
    } else {
      setReport(null);
      setReportMsg(r);
    }
  }

  return (
    <div className="stack">
      <section className="row" style={{ justifyContent: "space-between" }} aria-label="Layout">
        <span className="muted">Built for a {view.setup.business.toLowerCase()} · numbers as of {view.nowLabel}</span>
        <span className="row">
          {view.kept ? <span className="chip positive">Layout saved</span> : (
            <button type="button" className="btn primary small" disabled={busy !== null} onClick={() => call("keep", { action: "keep" })}>
              Keep this layout
            </button>
          )}
          <button type="button" className="btn tertiary small" disabled={busy !== null} onClick={() => call("redo", { action: "redo" })}>
            Start over
          </button>
        </span>
      </section>

      <section className="panel stack" data-coach="dash-watch" aria-label="Watch it for me" style={{ gap: 10 }}>
        <div className="row">
          <Pin size={16} aria-hidden="true" />
          <strong>Watching {watched.length} {watched.length === 1 ? "number" : "numbers"} for you</strong>
          <span className="muted">RAY compares each with your normal for this time of day.</span>
        </div>
        {view.alerts.length === 0 ? <span className="muted">Nothing unusual right now.</span> : view.alerts.map((a) => <Alert key={a.widgetId} alert={a} />)}
        {view.suggestion && (
          <div className="suggest-card">
            <Sparkles size={16} aria-hidden="true" />
            <span className="grow">{view.suggestion.text}</span>
            <button type="button" className="btn primary small" disabled={busy !== null} onClick={() => call("pin", { action: "pin", kind: view.suggestion!.kind })}>Pin</button>
            <button type="button" className="btn secondary small" disabled={busy !== null} onClick={() => call("not_now", { action: "not_now" })}>Not now</button>
          </div>
        )}
      </section>

      <section className="panel stack" data-coach="dash-ask" aria-label="Ask to add a widget" style={{ gap: 10 }}>
        <strong>Ask to add a widget</strong>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void submitAsk(ask); }}>
          <input className="input grow" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Try “show refunds by product”" aria-label="Ask to add a widget" />
          <button type="submit" className="btn primary" disabled={busy !== null || !ask.trim()}>Add</button>
        </form>
        <div className="row">
          {ASK_EXAMPLES.map((c) => <button key={c} type="button" className="seg" onClick={() => void submitAsk(c)}>{c}</button>)}
        </div>
        {reply?.message && <div className="reply" role="status">{reply.message}</div>}
        {reply?.chips && <div className="row">{reply.chips.map((c) => <button key={c} type="button" className="seg" onClick={() => void submitAsk(c)}>{c}</button>)}</div>}
      </section>
      {error && <div className="inline-error" role="alert">{error}</div>}

      <section className="grid-4 dash-widgets" data-coach="dash-widgets" aria-label="Widgets">
        {view.widgets.map((w) => {
          const alert = alertOf(w.id);
          const q = encodeURIComponent(`Tell me about ${w.title.toLowerCase()}: ${w.data.value}`);
          return (
            <article key={w.id} className="panel stack widget" style={{ gap: 6 }} data-unusual={alert ? "1" : undefined}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="metric-label">{w.title}</span>
                <span className="row" style={{ gap: 4 }}>
                  {alert && <span className="chip notice">Unusual</span>}
                  {w.watch && !alert && <span className="chip neutral" title="RAY is watching this"><Pin size={11} aria-hidden="true" /> Watched</span>}
                  <button type="button" className="icon-btn" aria-label={`Remove ${w.title}`} disabled={busy !== null} onClick={() => call("rm", { action: "remove", id: w.id })}>
                    <X size={14} aria-hidden="true" />
                  </button>
                </span>
              </div>
              <span className="big-number">{w.data.value}</span>
              {w.data.trend && <span className={w.data.trend.good ? "trend" : "trend down"} style={{ alignSelf: "flex-start" }}>{w.data.trend.text}</span>}
              {w.data.note && <span className="muted">{w.data.note}</span>}
              {w.data.rows && w.data.rows.length > 0 && (
                <ul className="bars">
                  {w.data.rows.map((r) => (
                    <li key={r.label}><span>{r.label}</span><span><strong>{r.value}</strong> <span className="muted">{r.sub}</span></span></li>
                  ))}
                </ul>
              )}
              <span className="definition">{w.definition}</span>
              <span className="row" style={{ marginTop: "auto" }}>
                <Link className="btn tertiary small" href={`${base}/ask?q=${q}`} aria-label={`Ask about ${w.title}`}>
                  <Sparkles size={14} aria-hidden="true" /> Ask about this widget
                </Link>
                {w.data.href && <Link className="btn tertiary small" href={w.data.href}>Open</Link>}
              </span>
            </article>
          );
        })}
      </section>

      <section className="panel stack" data-coach="dash-reports" aria-label="Reports in words" style={{ gap: 12 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <strong>Reports in words</strong>
          <span className="muted">Say what you need. RAY gives a short summary and the table.</span>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void submitReport(reportText); }}>
          <input className="input grow" value={reportText} onChange={(e) => setReportText(e.target.value)} placeholder="Try “Settlements for September with fees and GST”" aria-label="Ask for a report" />
          <button type="submit" className="btn primary" disabled={busy !== null || !reportText.trim()}>Build report</button>
        </form>
        <div className="row">{REPORT_EXAMPLES.map((c) => <button key={c} type="button" className="seg" onClick={() => void submitReport(c)}>{c}</button>)}</div>
        {reportMsg?.message && <div className="reply">{reportMsg.message}</div>}
        {reportMsg?.chips && <div className="row">{reportMsg.chips.map((c) => <button key={c} type="button" className="seg" onClick={() => void submitReport(c)}>{c}</button>)}</div>}
        {report && <ReportView key={report.report.id} report={report.report} merchantId={merchantId} text={report.text} />}

        <div className="pack stack" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span><strong>Month-end CA pack, {view.pack.month}</strong><br /><span className="muted">Settlements with fees and GST, refunds and disputes in one go.</span></span>
            <span className="row">
              <button type="button" className="btn secondary" onClick={() => setPackOpen(!packOpen)} aria-expanded={packOpen}>{packOpen ? "Hide preview" : "Preview"}</button>
              <button type="button" className="btn primary" disabled={busy !== null} onClick={async () => { const r = await call("pack", { action: "schedule", what: "pack" }); if (r?.message) setPackDone(r.message); }}>
                <MessageCircle size={16} aria-hidden="true" />
                Schedule to CA on WhatsApp
              </button>
              <span className="chip simulated">Simulated</span>
            </span>
          </div>
          {packDone && <span className="chip positive" style={{ alignSelf: "flex-start" }}>{packDone}</span>}
          {packOpen && view.pack.reports.map((r) => (
            <div key={r.id} className="stack" style={{ gap: 4 }}>
              <strong>{r.title}</strong>
              <ul className="summary-lines">{r.summary.map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
          ))}
        </div>
        {view.schedules.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <strong>Scheduled</strong>
            {view.schedules.map((s) => <span key={s.id} className="muted">{s.title} to {s.to} · {s.when}</span>)}
          </div>
        )}
      </section>

      <NudgeBar
        text={view.alerts[0] ? `${view.alerts[0].headline} Tap Why? to see the cause.` : "Ask for a widget in plain words, or build a report for your CA."}
        action={view.alerts[0]?.action ? view.alerts[0].action : { label: "Open cases", href: `${base}/cases` }}
      />
    </div>
  );
}

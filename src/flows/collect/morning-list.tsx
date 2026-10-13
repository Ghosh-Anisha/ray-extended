"use client";

// The morning list (Invoice overdue): one row per buyer, highest priority
// first. Banking+ merchants see what RAY will do today and can log a note
// ("spoke to them, paying on 20th"); everyone else gets the read-only
// overdue view with the Banking+ offer. Phone shows cards, desktop a table.
import { Button, Heading } from "@/ui/kit";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Empty, useAction } from "@/ui/bits";
import { useView } from "@/ui/view";
import type { MorningList, MorningRow } from "./morning";

export function MorningListView({ list, focusBuyerId }: { list: MorningList; focusBuyerId?: string }) {
  const { view } = useView();
  const { busy, error, run } = useAction();
  const caseHref = (r: MorningRow) => r.caseId ? `/merchant/${list.merchantId}/cases/${r.caseId}` : `/merchant/${list.merchantId}/cases?moment=collect`;
  return (
    <section className="stack" aria-label="Invoice overdue" data-guided="collect">
      <Heading size="large">
        Invoice overdue · {list.date}
      </Heading>
      <p className="muted">
        {list.rows.length} {list.rows.length === 1 ? "buyer owes" : "buyers owe"} {list.total} overdue, highest priority first (amount overdue × days overdue, adjusted by pay history and relationship).
      </p>
      {list.offer ? (
        <div className="banner" role="note">
          <strong>{list.offer.title}</strong> {list.offer.text}
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="small" onClick={async () => { const r = await run("enable-banking-plus", "/api/merchant/collect", { action: "enable_banking_plus", merchantId: list.merchantId }); if (r.ok) window.location.reload(); }}>Enable Banking+ demo workflow</Button>
            <span className="muted">This only unlocks simulated Collect screens; it does not connect a bank account.</span>
          </div>
        </div>
      ) : (
        <div className="banner" role="note">Review each buyer’s amount and message before running Collect. The engine rechecks invoice timing, consent and approval requirements. All messaging is simulated.</div>
      )}
      {list.bankingPlus && <CollectWorkflow list={list} />}
      {list.posted.map((p) => (
        <div key={p.actionId} className="banner hold" role="status">
          <span>
            <Link href={`/merchant/${list.merchantId}/cases/${p.caseId}`}>{p.text}</Link> · Sure, above your approval limit
          </span>
          <Button size="small" variant="secondary" isLoading={busy === p.actionId} onClick={() => run(p.actionId, "/api/merchant/undo", { merchantId: list.merchantId, actionId: p.actionId })}>
            Undo
          </Button>
        </div>
      ))}
      {error && <span className="error" role="alert">{error}</span>}
      {list.rows.length === 0 ? (
        <Empty>{list.empty}</Empty>
      ) : view === "phone" ? (
        <div className="stack">
          {list.rows.map((r) => (
            <div key={r.buyerId} className="case-card">
              <div className="top">
                <strong>{r.buyer}</strong>
                <span className="num">{r.overdue}</span>
              </div>
              <div className="row">
                <span className="muted">
                  {r.invoices} {r.invoices === 1 ? "invoice" : "invoices"} · oldest {r.oldestDays} days · {r.stage}
                </span>
              </div>
              <Next row={r} href={caseHref(r)} />
              {list.bankingPlus && <ReminderReview row={r} merchantId={list.merchantId} focus={r.buyerId === focusBuyerId} />}
              {r.caseId && <Note merchantId={list.merchantId} caseId={r.caseId} buyer={r.buyer} />}
            </div>
          ))}
        </div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Buyer</th>
              <th className="num">Overdue</th>
              <th className="num">Invoices</th>
              <th className="num">Oldest</th>
              <th>Stage</th>
              <th className="num">Priority</th>
              <th>Next</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.map((r) => (
              <tr key={r.buyerId}>
                <td>
                  {r.buyer}
                  {r.keyAccount && <span className="chip neutral" style={{ marginLeft: 6 }}>Key account</span>}
                  <div className="muted">{r.contact}</div>
                </td>
                <td className="num">{r.overdue}</td>
                <td className="num">{r.invoices}</td>
                <td className="num">{r.oldestDays} days</td>
                <td>{r.stage}</td>
                <td className="num">{r.priority.toLocaleString("en-IN")}</td>
                <td>
                  <Next row={r} href={caseHref(r)} />
                  {list.bankingPlus && <ReminderReview row={r} merchantId={list.merchantId} focus={r.buyerId === focusBuyerId} />}
                  {r.caseId && <Note merchantId={list.merchantId} caseId={r.caseId} buyer={r.buyer} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CollectWorkflow({ list }: { list: MorningList }) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [buyerId, setBuyerId] = useState(list.workflow?.buyerId ?? list.rows[0]?.buyerId ?? "");
  const [channel, setChannel] = useState<"engine" | "email" | "whatsapp">(list.workflow?.channel ?? "engine");
  const [tone, setTone] = useState<"gentle" | "firm">(list.workflow?.tone ?? "gentle");
  const [timing, setTiming] = useState<"after_review" | "next_morning">(list.workflow?.timing ?? "after_review");
  const [result, setResult] = useState<string | null>(null);
  const selectedBuyer = list.rows.find((row) => row.buyerId === buyerId);
  return <section className="panel stack" aria-label="Create collect workflow">
    <div className="row"><h2 style={{ margin: 0 }}>Create collect workflow</h2><span className="chip simulated">Simulated</span></div>
    <p className="muted">Preferences are saved in this demo. Collect still rechecks the buyer’s consent, invoice stage, timing and approval rules before any simulated message.</p>
    {list.rows.length === 0 ? <p className="muted">No overdue seeded buyers are available to configure.</p> : <form className="stack" onSubmit={async (e) => {
      e.preventDefault();
      const r = await run("save-workflow", "/api/merchant/collect", { action: "save_workflow", merchantId: list.merchantId, buyerId, channel, tone, timing, requireApproval: true });
      if (r.ok) { setResult("Workflow saved. No reminder has been sent."); router.refresh(); }
    }}>
      <label>Recipient <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)}>{list.rows.map((row) => <option key={row.buyerId} value={row.buyerId}>{row.buyer} · {row.overdue}</option>)}</select></label>
      <label>Reminder channel preference <select value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}><option value="engine">Use an eligible channel selected by Collect</option><option value="email">Email preference (consent checked again)</option><option value="whatsapp">WhatsApp preference (consent checked again)</option></select></label>
      <label>Tone preference (the engine determines the eligible stage) <select value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}><option value="gentle">Gentle</option><option value="firm">Firm (merchant approval remains required)</option></select></label>
      <label>Timing <select value={timing} onChange={(e) => setTiming(e.target.value as typeof timing)}><option value="after_review">After I review and start it</option><option value="next_morning">Next morning scheduled run (not available)</option></select></label>
      <div className="banner hold">Approval required for consequential actions. A preference cannot bypass the engine’s guardrails; this prototype has no background scheduler.</div>
      {selectedBuyer && <article className="panel stack" aria-label="Collect generated reminder preview">
        <strong>Current Collect-generated preview · {selectedBuyer.previewChannel} · {selectedBuyer.stage}</strong>
        <pre className="collect-message-preview">{selectedBuyer.previewText}</pre>
        <span className="muted">This preview reflects the engine’s current stage and eligible channel. Saved tone/channel are preferences only; execution rechecks consent, stage, timing and approval.</span>
      </article>}
      <Button type="submit" isDisabled={!buyerId || timing !== "after_review"} isLoading={busy === "save-workflow"}>Save collect workflow</Button>
      {error && <span className="error" role="alert">{error}</span>}
    </form>}
    {list.workflow && <div className="stack" role="status">
      <div className="banner success"><strong>Workflow saved · demo only.</strong> Recipient and preferences are stored; no message was sent.</div>
      <p>{list.rows.find((row) => row.buyerId === list.workflow?.buyerId)?.buyer ?? list.workflow.buyerId} · {list.workflow.channel} · {list.workflow.tone} · after review · approval required</p>
      <Button size="small" isLoading={busy === "run-workflow"} onClick={async () => {
        const r = await run("run-workflow", "/api/merchant/collect", { action: "buyer", merchantId: list.merchantId, buyerId: list.workflow!.buyerId });
        if (r.ok) { const data = r.result as { activity?: string; next?: string; outcome?: string }; setResult(data.activity ? `Simulated activity recorded: ${data.activity}` : `Collect checked the case. No reminder is reported sent. ${data.next ?? data.outcome ?? "Review case activity."}`); router.refresh(); }
      }}>Start simulated Collect for this buyer</Button>
      {list.workflow.tone === "firm" && <p className="muted">Firm preference is stored, but the engine sends a firm reminder only at its eligible stage and after the merchant’s approval.</p>}
      {result && <div className="banner" role="status">{result}</div>}
    </div>}
  </section>;
}

function ReminderReview({ row, merchantId, focus }: { row: MorningRow; merchantId: string; focus: boolean }) {
  const { busy, error, run } = useAction();
  const [outcome, setOutcome] = useState<string | null>(null);
  const caseHref = row.caseId ? `/merchant/${merchantId}/cases/${row.caseId}` : `/merchant/${merchantId}/cases?moment=collect`;
  return (
    <details open={focus} className="collect-reminder-review">
      <summary className="btn secondary small">Review reminder for {row.buyer}</summary>
      <div className="panel stack" style={{ padding: 12, gap: 8 }}>
        <div className="row"><strong>{row.buyer}</strong><span>{row.overdue}</span><span className="chip simulated">Simulated</span></div>
        <span className="muted">{row.invoices} {row.invoices === 1 ? "invoice" : "invoices"} · oldest {row.oldestDays} days overdue · {row.promise ?? "No promise recorded"}</span>
        {row.flagged && <span className="chip notice">{row.flagged}</span>}
        <span className="chip information">{row.previewTone}</span>
        <span className="muted">Preview channel: {row.previewChannel}</span>
        <pre className="collect-message-preview">{row.previewText}</pre>
        <span className="muted">{row.previewNote}</span>
        {row.lastActivity && <div className="banner" role="status">Latest recorded activity: {row.lastActivity}</div>}
        <div className="row">
          <Button size="small" isLoading={busy === `buyer-${row.buyerId}`} onClick={async () => {
            const result = await run(`buyer-${row.buyerId}`, "/api/merchant/collect", { action: "buyer", merchantId, buyerId: row.buyerId });
            if (!result.ok) return;
            const data = result.result as { outcome?: string; state?: string | null; next?: string; activity?: string | null; caseId?: string };
            if (data.outcome === "duplicate") setOutcome("This buyer’s Collect check already ran today. No duplicate reminder was sent.");
            else if (data.activity) setOutcome(`Simulated reminder activity recorded: ${data.activity}. Current case status: ${data.state ?? "not available"}.`);
            else setOutcome(`Collect checked this buyer. No reminder is reported as sent. ${data.next ?? data.state ?? "Review the case for the next step."}`);
          }}>Run Collect for this buyer</Button>
          <Link className="btn tertiary small" href={caseHref}>Open case activity and approvals</Link>
        </div>
        {outcome && <div className="banner" role="status">{outcome}</div>}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </details>
  );
}

function Next({ row, href }: { row: MorningRow; href: string }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <span>
        {row.needsYou && <span className="chip notice" style={{ marginRight: 6 }}>Needs you</span>}
        {row.caseId ? <Link href={href}>{row.next}</Link> : <span className="muted">{row.next}</span>}
      </span>
      {row.promise && <span className="muted">{row.promise}</span>}
      {row.flagged && <span className="chip negative">{row.flagged}</span>}
    </div>
  );
}

// The merchant's own note on WhatsApp, typed here: a date in it is a promise.
function Note({ merchantId, caseId, buyer }: { merchantId: string; caseId: string; buyer: string }) {
  const [text, setText] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        const r = await run(caseId, "/api/merchant/collect", { action: "note", merchantId, caseId, text });
        if (r.ok) setText("");
      }}
    >
      <label className="sr-only" style={{ position: "absolute", left: -9999 }} htmlFor={`note-${caseId}`}>
        Note about {buyer}
      </label>
      <input id={`note-${caseId}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Spoke to them, paying on 20th" maxLength={300} />
      <Button size="small" variant="secondary" type="submit" isLoading={busy === caseId}>
        Log note
      </Button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

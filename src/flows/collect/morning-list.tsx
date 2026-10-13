"use client";

// The morning list (Invoice overdue): one row per buyer, highest priority
// first. Banking+ merchants see what RAY will do today and can log a note
// ("spoke to them, paying on 20th"); everyone else gets the read-only
// overdue view with the Banking+ offer. Phone shows cards, desktop a table.
import { Button, Heading } from "@razorpay/blade/components";
import Link from "next/link";
import { useState } from "react";
import { Empty, SimulatedTag, useAction } from "@/ui/bits";
import { useView } from "@/ui/view";
import type { MorningList, MorningRow } from "./morning";

export function MorningListView({ list }: { list: MorningList }) {
  const { view } = useView();
  const { busy, error, run } = useAction();
  const caseHref = (r: MorningRow) => `/merchant/${list.merchantId}/cases/${r.caseId}`;
  return (
    <section className="stack" aria-label="Invoice overdue">
      <Heading size="large">
        Invoice overdue · {list.date}
      </Heading>
      <p className="muted">
        {list.rows.length} {list.rows.length === 1 ? "buyer owes" : "buyers owe"} {list.total} overdue, highest priority first (amount overdue × days overdue, adjusted by pay history and relationship).
      </p>
      {list.offer ? (
        <div className="banner" role="note">
          <strong>{list.offer.title}</strong> {list.offer.text}
        </div>
      ) : (
        <div className="row">
          <Button size="small" isLoading={busy === "morning"} onClick={() => run("morning", "/api/merchant/collect", { action: "morning", merchantId: list.merchantId })}>
            {"Run today's chase"}
          </Button>
          <span className="muted">Payments come from Banking+ credits</span> <SimulatedTag />
        </div>
      )}
      {error && <span className="error">{error}</span>}
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

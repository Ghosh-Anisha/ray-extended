"use client";

// Cases as a Gmail-like inbox (docs/ui-rebuild.md 3.2): tabs on the left, a
// filter per moment, one row per case sorted by money at stake. The tab and
// moment live in the URL, so Back from a case lands on the same list.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Moment } from "@/db/schema";
import type { CaseRow, InboxView } from "@/surfaces/views";
import { inboxCountForTab, inboxRowsForTab } from "./inbox-count";
import { DOING_IT, EMPTY, MOMENT_LABEL, type InboxTab } from "@/surfaces/words";
import { ApprovalLabel, Chip, Empty, HoldBanner, useAction } from "../bits";
import { NudgeBar } from "../nudge";
import { useToast } from "../toast";
import { useView } from "../view";
import { initials } from "../shell/nav";

const MOMENTS = Object.keys(MOMENT_LABEL) as Moment[];

function QuickAction({ row }: { row: CaseRow }) {
  const { busy, error, run } = useAction();
  const toast = useToast();
  const q = row.quick!;
  return (
    <span className="quick" onClick={(e) => e.stopPropagation()}>
      <span className="stack" style={{ gap: 0, alignItems: "flex-end" }}>
        <button
          type="button"
          className="btn primary small"
          disabled={busy !== null}
          onClick={async () => {
            const r = await run(row.id, "/api/merchant/tap", { caseId: row.id, choice: "approve", proposalId: q.proposalId });
            if (r.ok) toast(`${q.label} ✓ for ${row.name}`);
          }}
        >
          {busy ? DOING_IT : q.label}
        </button>
        <ApprovalLabel covered={q.covered} />
      </span>
      {error && <span className="error">{error}</span>}
    </span>
  );
}

function RowItem({ r, merchantId, unread, href }: { r: CaseRow; merchantId: string; unread: boolean; href: string }) {
  const router = useRouter();
  return (
    <tr className={`mail-row ${unread ? "unread" : ""}`} data-guided={r.momentKey === "paid_no_order" && r.name.startsWith("Priya") ? "case-priya" : undefined} onClick={() => router.push(href)}>
      <td className="mail-who">
        <div className="who-inner">
          <span className="avatar sm" aria-hidden="true">{initials(r.name)}</span>
          <Link href={href} onClick={(e) => e.stopPropagation()}>{r.name}</Link>
        </div>
      </td>
      <td className="mail-what">
        <span className="chip information">{r.moment}</span>
        <span className="mail-summary">{r.summary}</span>
        {r.holds.map((h) => (
          <div key={h.actionId} style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
            <HoldBanner hold={h} merchantId={merchantId} compact />
          </div>
        ))}
      </td>
      <td>
        <Chip chip={r.confidence} />
      </td>
      <td className="num">{r.amount}</td>
      <td className="mail-time">
        <span className="when muted">{r.age}</span>
        <span className="hover-actions">
          {r.quick && <QuickAction row={r} />}
          <Link className="btn secondary small" href={href} onClick={(e) => e.stopPropagation()}>
            Open
          </Link>
        </span>
      </td>
    </tr>
  );
}

export function Inbox({
  merchantId,
  inbox,
  initialTab = "all",
  initialMoment = null,
}: {
  merchantId: string;
  inbox: InboxView;
  initialTab?: InboxTab;
  initialMoment?: Moment | null;
}) {
  const { view } = useView();
  const [tab, setTab] = useState<InboxTab>(initialTab);
  const [moment, setMoment] = useState<Moment | null>(initialMoment);
  const uniqueRows = <T extends { id: string }>(rows: T[]) => [...new Map(rows.map((row) => [row.id, row])).values()];
  const tabs = inbox.tabs.map((t) => ({ ...t, rows: uniqueRows(t.rows) }));
  const allRows = uniqueRows(tabs.flatMap((t) => t.rows));
  const currentRows = uniqueRows(inboxRowsForTab(tabs, tab));
  const rows = moment ? currentRows.filter((r) => r.momentKey === moment) : currentRows;
  const listParams = new URLSearchParams();
  if (tab !== "all") listParams.set("tab", tab);
  if (moment) listParams.set("moment", moment);
  const listHref = `/merchant/${merchantId}/cases${listParams.size ? `?${listParams}` : ""}`;
  const href = (r: CaseRow) => `/merchant/${merchantId}/cases/${r.id}?returnTo=${encodeURIComponent(listHref)}`;

  function remember(nextTab: InboxTab, nextMoment: Moment | null) {
    setTab(nextTab);
    setMoment(nextMoment);
    const q = new URLSearchParams();
    if (nextTab !== "all") q.set("tab", nextTab);
    if (nextMoment) q.set("moment", nextMoment);
    window.history.replaceState(null, "", q.size ? `?${q}` : window.location.pathname);
  }

  // Both sets of badges describe their global set. Selecting either filter
  // changes only the visible rows, never the other filter's counts.
  const momentCount = (m: Moment) => inboxCountForTab(allRows, m);
  const top = inbox.tabs[0].rows[0];
  const needs = inbox.tabs[0].rows.length;
  const nav = (
    <div className="inbox-nav" role="tablist" aria-label="Cases">
      <button role="tab" type="button" aria-selected={tab === "all"} onClick={() => remember("all", moment)}>
        <span className="grow">All cases</span><span className="count">{allRows.length}</span>
      </button>
      {tabs.map((t) => (
        <button key={t.key} role="tab" type="button" aria-selected={t.key === tab} onClick={() => remember(t.key, moment)}>
          <span className="grow">{t.label}</span>
          <span className="count">{t.rows.length}</span>
        </button>
      ))}
    </div>
  );
  const filters = (
    <div className="inbox-nav" aria-label="Filter by moment">
      <div className="nav-label">Moments</div>
      <button type="button" aria-pressed={moment === null} onClick={() => remember(tab, null)}>
        <span className="grow">All moments</span><span className="count">{allRows.length}</span>
      </button>
      {MOMENTS.map((m) => (
        <button key={m} type="button" aria-pressed={moment === m} onClick={() => remember(tab, m)}>
          <span className="grow">{MOMENT_LABEL[m]}</span>
          <span className="count">{momentCount(m)}</span>
        </button>
      ))}
    </div>
  );

  return (
    <section className="stack" aria-label="Cases">
      <h1 className="page-title">Cases</h1>
      <div className={view === "phone" ? "stack" : "inbox-layout"}>
        {view === "phone" ? (
          <>
            <div className="tabs" role="tablist">
              <button role="tab" type="button" aria-selected={tab === "all"} onClick={() => remember("all", moment)}>All ({allRows.length})</button>
              {tabs.map((t) => (
                <button key={t.key} role="tab" type="button" aria-selected={t.key === tab} onClick={() => remember(t.key, moment)}>
                  {t.label} ({t.rows.length})
                </button>
              ))}
            </div>
            <div className="chips-scroll">
              <button type="button" className="seg" aria-pressed={moment === null} onClick={() => remember(tab, null)}>All ({allRows.length})</button>
              {MOMENTS.map((m) => (
                <button key={m} type="button" className="seg" aria-pressed={moment === m} onClick={() => remember(tab, m)}>
                  {MOMENT_LABEL[m]} ({momentCount(m)})
                </button>
              ))}
            </div>
          </>
        ) : (
          <aside className="inbox-side panel">
            {nav}
            {filters}
          </aside>
        )}
        <div className="stack">
          <div className="inbox-top">
            <strong>{inbox.waitingOnYou}</strong>
            <span className="muted">· Sorted by money at stake</span>
            {moment && <span className="chip information">Showing: {MOMENT_LABEL[moment]}</span>}
          </div>
          {rows.length === 0 ? (
          <Empty>{moment ? `Nothing here for ${MOMENT_LABEL[moment]}${tab === "all" ? ". Choose another moment to see other seeded cases." : " in this status. Choose All cases to include other statuses."}` : tab === "all" ? "No seeded cases are available for this account." : EMPTY[tab]}</Empty>
          ) : view === "phone" ? (
            <div className="stack">
              {rows.map((r) => (
                <div key={r.id} className="stack" style={{ gap: 4 }}>
                  <Link href={href(r)} className="case-card" data-guided={r.momentKey === "paid_no_order" && r.name.startsWith("Priya") ? "case-priya" : undefined}>
                    <div className="top">
                      <strong>{r.name}</strong>
                      <span className="num">{r.amount}</span>
                    </div>
                    <span className="muted">{r.summary}</span>
                    <div className="row">
                      <Chip chip={r.state} />
                      <span className="chip information">{r.moment}</span>
                      <span className="muted">· {r.age}</span>
                    </div>
                  </Link>
                  {r.holds.map((h) => (
                    <HoldBanner key={h.actionId} hold={h} merchantId={merchantId} compact />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <table className="data mail">
              <thead className="sr-only">
                <tr>
                  <th>Customer</th>
                  <th>Case</th>
                  <th>Confidence</th>
                  <th className="num">Amount</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <RowItem key={r.id} r={r} merchantId={merchantId} unread={r.state.label === "Needs you"} href={href(r)} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <NudgeBar
        text={needs > 0 && top ? `${needs} ${needs === 1 ? "case needs" : "cases need"} you. Start with the biggest: ${top.name}, ${top.amount}.` : "Nothing needs you. RAY is handling the rest."}
        action={needs > 0 && top ? { label: "Open", href: href(top) } : { label: "Ask RAY", href: `/merchant/${merchantId}/ask` }}
      />
    </section>
  );
}

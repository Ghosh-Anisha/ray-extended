"use client";

import { Heading } from "@razorpay/blade/components";
import Link from "next/link";
import { useState } from "react";
import type { CaseRow, InboxView } from "@/surfaces/views";
import { EMPTY, type InboxTab } from "@/surfaces/words";
import { Chip, Empty, HoldBanner } from "../bits";
import { useView } from "../view";

export function Inbox({ merchantId, inbox, initialTab = "needs_you" }: { merchantId: string; inbox: InboxView; initialTab?: InboxTab }) {
  const { view } = useView();
  const [tab, setTab] = useState<InboxTab>(initialTab);
  const current = inbox.tabs.find((t) => t.key === tab)!;
  const href = (r: CaseRow) => `/merchant/${merchantId}/cases/${r.id}`;
  return (
    <section className="stack" aria-label="Cases">
      <Heading size="large">{inbox.waitingOnYou}</Heading>
      <div className="tabs" role="tablist">
        {inbox.tabs.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={t.key === tab} onClick={() => setTab(t.key)}>
            {t.label} ({t.rows.length})
          </button>
        ))}
      </div>
      {current.rows.length === 0 ? (
        <Empty>{EMPTY[tab]}</Empty>
      ) : view === "phone" ? (
        <div className="stack">
          {current.rows.map((r) => (
            <div key={r.id} className="stack" style={{ gap: 4 }}>
              <Link href={href(r)} className="case-card">
                <div className="top">
                  <strong>{r.name}</strong>
                  <span className="num">{r.amount}</span>
                </div>
                <div className="row">
                  <Chip chip={r.state} />
                  <span className="muted">{r.moment}</span>
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
        <table className="data">
          <thead>
            <tr>
              <th>Moment</th>
              <th>Name</th>
              <th className="num">Amount</th>
              <th>State</th>
              <th>Confidence</th>
              <th>Age</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {current.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.moment}</td>
                <td>
                  {r.name}
                  {r.holds.map((h) => (
                    <div key={h.actionId} style={{ marginTop: 6 }}>
                      <HoldBanner hold={h} merchantId={merchantId} compact />
                    </div>
                  ))}
                </td>
                <td className="num">{r.amount}</td>
                <td>
                  <Chip chip={r.state} />
                </td>
                <td>
                  <Chip chip={r.confidence} />
                </td>
                <td className="muted">{r.age}</td>
                <td>
                  <Link href={href(r)}>{r.action}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

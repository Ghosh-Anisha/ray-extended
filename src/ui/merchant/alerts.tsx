"use client";

import { Alert, Button, Heading, Text } from "@/ui/kit";
import Link from "next/link";
import type { AlertRow, Merchant } from "@/surfaces/views";
import { EMPTY, LET_RAY_FIX } from "@/surfaces/words";
import { Chip, Empty, useAction } from "../bits";
import { useView } from "../view";

export function Alerts({ merchant, alerts }: { merchant: Merchant; alerts: AlertRow[] }) {
  const { view } = useView();
  const { busy, error, run } = useAction();
  const caseLink = (a: AlertRow) => (a.caseId && merchant.rayOn ? <Link href={`/merchant/${merchant.id}/cases/${a.caseId}`}>Open case</Link> : null);
  return (
    <section className="stack" aria-label="Alerts">
      <Heading size="large">Alerts</Heading>
      <Text color="surface.text.gray.muted">Free for every account. Each alert says what went wrong and the likely cause.</Text>
      {!merchant.rayOn && (
        <div className="panel row" style={{ justifyContent: "space-between" }}>
          <Text>RAY can fix these for you: it works out whose side it is, proposes the fix, and acts once you tap.</Text>
          <Button isLoading={busy === "on"} onClick={() => run("on", "/api/merchant/ray-on", { merchantId: merchant.id })}>
            {LET_RAY_FIX}
          </Button>
        </div>
      )}
      {error && <Alert color="negative" description={error} isDismissible={false} />}
      {alerts.length === 0 ? (
        <Empty>{EMPTY.alerts}</Empty>
      ) : view === "phone" ? (
        <div className="stack">
          {alerts.map((a) => (
            <div key={a.id} className="case-card">
              <div className="top">
                <strong>{a.name || a.moment}</strong>
                <span className="num">{a.amount}</span>
              </div>
              <div>{a.cause}</div>
              <div className="row">
                {a.state && <Chip chip={a.state} />}
                <span className="muted">{a.moment} · {a.age}</span>
              </div>
              {caseLink(a)}
            </div>
          ))}
        </div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Moment</th>
              <th>Name</th>
              <th className="num">Amount</th>
              <th>Likely cause</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td className="muted" title={a.at}>{a.age}</td>
                <td>{a.moment}</td>
                <td>{a.name}</td>
                <td className="num">{a.amount}</td>
                <td>{a.cause}</td>
                <td>{a.state && <Chip chip={a.state} />}</td>
                <td>{caseLink(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

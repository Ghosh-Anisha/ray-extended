"use client";

// Twice-daily digest: count and ₹ at stake; "details" lists numbered cases.
// Phone: a WhatsApp message. Desktop: the same message in a panel.
import { Heading } from "@/ui/kit";
import Link from "next/link";
import { useState } from "react";
import type { DigestView } from "@/surfaces/views";
import { SimulatedTag } from "../bits";
import { useView } from "../view";

export function DigestMessage({ d, merchantId }: { d: DigestView; merchantId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bubble" data-testid="digest">
      <div>{d.text}</div>
      {d.count > 0 && (
        <>
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="wa-link">
            details
          </button>
          {open && (
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {d.details.map((x) => (
                <li key={x.caseId}>
                  <Link href={`/merchant/${merchantId}/cases/${x.caseId}`}>{x.line}</Link>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      <div className="meta">Next digest at {d.nextAt}</div>
    </div>
  );
}

export function Digest({ d, merchantId }: { d: DigestView; merchantId: string }) {
  const { view } = useView();
  if (view === "phone") {
    return (
      <div className="phone-frame">
        <div className="wa-head">
          <span>RAY</span>
          <SimulatedTag />
        </div>
        <div className="wa">
          <DigestMessage d={d} merchantId={merchantId} />
        </div>
      </div>
    );
  }
  return (
    <section className="panel stack" style={{ maxWidth: 640 }}>
      <div className="sim-head">
        <Heading size="medium">Digest</Heading>
        <SimulatedTag />
      </div>
      <p className="muted">Sent on WhatsApp at 10 AM and 6 PM.</p>
      <div className="wa">
        <DigestMessage d={d} merchantId={merchantId} />
      </div>
    </section>
  );
}

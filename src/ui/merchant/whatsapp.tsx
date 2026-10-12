"use client";

// RAY's WhatsApp thread with the merchant (simulated): one approval card per
// case that needs a tap, then the digest. Phone: in a phone frame. Desktop:
// a side panel.
import type { ApprovalCard as Card, DigestView } from "@/surfaces/views";
import { EMPTY } from "@/surfaces/words";
import { SimulatedTag } from "../bits";
import { useView } from "../view";
import { ApprovalCard } from "./approval-card";
import { DigestMessage } from "./digest";

export function WhatsAppThread({ cards, digest, merchantId, killSwitch }: { cards: Card[]; digest: DigestView; merchantId: string; killSwitch: boolean }) {
  const { view } = useView();
  const body = (
    <div className="wa">
      {killSwitch ? null : cards.length === 0 ? <div className="bubble">{EMPTY.cards}</div> : cards.map((c) => <ApprovalCard key={c.caseId} card={c} merchantId={merchantId} />)}
      <DigestMessage d={digest} merchantId={merchantId} />
    </div>
  );
  return view === "phone" ? (
    <div className="phone-frame">
      <div className="wa-head">
        <span>RAY</span>
        <SimulatedTag />
      </div>
      {body}
    </div>
  ) : (
    <section className="panel stack" style={{ maxWidth: 420 }}>
      <div className="sim-head">
        <h2 style={{ margin: 0 }}>WhatsApp from RAY</h2>
        <SimulatedTag />
      </div>
      {body}
    </section>
  );
}

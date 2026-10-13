"use client";

// RAY's WhatsApp thread with the merchant (simulated): one approval card per
// case that needs a tap, then the digest. Phone: in a phone frame. Desktop:
// a side panel.
import type { ApprovalCard as Card, DigestView } from "@/surfaces/views";
import { EMPTY } from "@/surfaces/words";
import { SimulatedTag } from "../bits";
import { CoachMarks } from "../coach-mark";
import { useView } from "../view";
import { VoiceCompose } from "../voice-compose";
import { CallCard } from "../voice";
import type { CallView } from "@/surfaces/calls";
import { ApprovalCard } from "./approval-card";
import { DigestMessage } from "./digest";

export function WhatsAppThread({
  cards,
  digest,
  merchantId,
  killSwitch,
  voiceSamples = [],
  voiceLive = false,
  calls = [],
}: {
  cards: Card[];
  digest: DigestView;
  merchantId: string;
  killSwitch: boolean;
  voiceSamples?: { id: string; label: string }[];
  voiceLive?: boolean;
  calls?: CallView[];
}) {
  const { view } = useView();
  const body = (
    <div className="wa">
      {killSwitch ? null : cards.length === 0 ? <div className="bubble">{EMPTY.cards}</div> : cards.map((c) => <ApprovalCard key={c.caseId} card={c} merchantId={merchantId} />)}
      <DigestMessage d={digest} merchantId={merchantId} />
      {calls[0] && <CallCard call={calls[0]} meta="Leafy Bakes · simulated call" />}
      {/* Reply to RAY by voice: RAY sends back the card. You still tap. */}
      {!killSwitch && cards.length > 0 && voiceSamples.length > 0 && (
        <VoiceCompose url="/api/merchant/voice-note" fields={{ merchantId }} samples={voiceSamples} live={voiceLive} sendLabel="Send voice note" />
      )}
    </div>
  );
  const content = view === "phone" ? (
    <div className="phone-frame" data-tour="phone">
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
  return <>
    {view === "phone" ? <div className="wa-story">{content}<aside className="panel wa-explainer" data-tour="explainer"><h2>What&apos;s happening</h2><p>RAY checks the payment, store and customer context before asking for your tap.</p><p className="muted">Your voice note can choose a card. It never approves money by itself.</p></aside></div> : content}
    <CoachMarks id="whatsapp" steps={[{ target: "[data-tour='phone']", text: "RAY brings the next decision to the place you already check: WhatsApp." }, { target: "[data-testid='approval-card']", text: "Approval cards use the same action as the case page. Tap only when the recommendation is right." }, { target: "[data-tour='explainer']", text: "This short explanation keeps the evidence and the next step visible." }]} />
  </>;
}

"use client";

// The WhatsApp approval card: bubble · Approve · Change · Open case.
// Approve is the same tap as on the case page; Change takes free text.
import Link from "next/link";
import { useState } from "react";
import type { ApprovalCard as Card } from "@/surfaces/views";
import { APPROVE, CHANGE, DOING_IT, OPEN_CASE } from "@/surfaces/words";
import { ApprovalLabel, useAction } from "../bits";

export function ApprovalCard({ card, merchantId, showOpen = true }: { card: Card; merchantId: string; showOpen?: boolean }) {
  const { busy, error, run } = useAction();
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState("");
  return (
    <div className="bubble" style={{ maxWidth: "100%" }} data-testid="approval-card">
      {card.lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      <div style={{ marginTop: 6 }}>
        <strong>{card.primary.label}</strong> · <ApprovalLabel covered={card.primary.covered} />
      </div>
      {card.changeAsked && <div className="meta">You asked: {card.changeAsked}</div>}
      <div className="card-actions">
        <button type="button" disabled={busy !== null} onClick={() => run("approve", "/api/merchant/tap", { caseId: card.caseId, choice: "approve", proposalId: card.primary.id })}>
          {busy === "approve" ? DOING_IT : APPROVE}
        </button>
        <button type="button" aria-expanded={changing} onClick={() => setChanging((c) => !c)}>
          {CHANGE}
        </button>
        {showOpen && (
          <Link href={`/merchant/${merchantId}/cases/${card.caseId}`} style={{ textAlign: "center", padding: 10, fontWeight: 600, color: "#027eb5", textDecoration: "none" }}>
            {OPEN_CASE}
          </Link>
        )}
      </div>
      {changing && (
        <form
          className="stack"
          style={{ gap: 6, marginTop: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run("change", "/api/merchant/change", { caseId: card.caseId, text });
            if (r.ok) {
              setText("");
              setChanging(false);
            }
          }}
        >
          <label htmlFor={`change-${card.caseId}`} className="muted">What should RAY do instead?</label>
          <textarea id={`change-${card.caseId}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Refund instead, or add a note" />
          <button type="submit" disabled={!text.trim() || busy !== null}>
            {busy === "change" ? DOING_IT : "Send to RAY"}
          </button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

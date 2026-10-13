"use client";

// The right-side Ask RAY panel, opened from the top bar on any page.
import { Sparkles, X } from "lucide-react";
import Link from "next/link";
import { CoachMarks } from "../coach/coach";
import { useAccessibleDialog } from "../use-accessible-dialog";
import { useAsk } from "./ask-context";
import { AskChat } from "./chat";
import { useRef } from "react";

export function AskPanel() {
  const { open, setOpen, merchantId, caseId } = useAsk();
  const panelRef = useRef<HTMLElement>(null);
  useAccessibleDialog(panelRef, () => setOpen(false), open);
  if (!open) return null;
  return (
    <>
      <div className="drawer-scrim ask-scrim" onClick={() => setOpen(false)} />
        <aside ref={panelRef} className="ask-panel" role="dialog" aria-modal="true" aria-label="Ask Agentic Dashboard" tabIndex={-1}>
        <div className="drawer-head">
          <Sparkles size={16} aria-hidden="true" />
          <strong className="grow">Ask Agentic Dashboard{caseId ? " · this case" : ""}</strong>
          {!caseId && (
            <Link href={`/merchant/${merchantId}/ask`} className="linkbtn" onClick={() => setOpen(false)}>
              Open full page
            </Link>
          )}
          <button type="button" className="icon-btn" aria-label="Close Agentic Dashboard" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <AskChat compact />
        <CoachMarks
          id="ask-panel"
          steps={[
            { target: ".ask-panel [data-coach='ask-chips']", title: "Ask Agentic Dashboard", text: "Tap a supported question or type your own. Answers use available demo records and show their basis or link to a case. RAY is the separate WhatsApp bot." },
            { target: ".ask-panel [data-coach='ask-input']", title: "Propose a rule", text: "Try: Refund duplicate charges under ₹500 automatically. The dashboard shows the rule first; nothing is saved until you approve it." },
          ]}
        />
      </aside>
    </>
  );
}

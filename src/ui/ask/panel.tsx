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
      <aside ref={panelRef} className="ask-panel" role="dialog" aria-modal="true" aria-label="Ask RAY" tabIndex={-1}>
        <div className="drawer-head">
          <Sparkles size={16} aria-hidden="true" />
          <strong className="grow">Ask RAY{caseId ? " · this case" : ""}</strong>
          {!caseId && (
            <Link href={`/merchant/${merchantId}/ask`} className="linkbtn" onClick={() => setOpen(false)}>
              Open full page
            </Link>
          )}
          <button type="button" className="icon-btn" aria-label="Close Ask RAY" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <AskChat compact />
        <CoachMarks
          id="ask-panel"
          steps={[
            { target: ".ask-panel [data-coach='ask-chips']", title: "Start with a question", text: "Tap one, or type your own. RAY answers from your cases and shows where each number came from." },
            { target: ".ask-panel [data-coach='ask-input']", title: "Or tell RAY a rule", text: "Try: Refund duplicate charges under ₹500 automatically. RAY shows the rule first and does nothing until you approve." },
          ]}
        />
      </aside>
    </>
  );
}

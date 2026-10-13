"use client";

// The full Ask RAY page. The conversation is the same one the side panel shows.
import { useEffect } from "react";
import { NudgeBar } from "../nudge";
import { CoachMarks } from "../coach/coach";
import { useAsk } from "./ask-context";
import { AskChat } from "./chat";

export function AskPage({ merchantId, initialQuery, suggestion }: { merchantId: string; initialQuery: string; suggestion: string | null }) {
  const { setOpen } = useAsk();
  // The page is the conversation, so the side panel stays shut here.
  useEffect(() => setOpen(false), [setOpen]);
  return (
    <div className="ask-page">
      <div className="stack" style={{ gap: 4 }}>
        <h1 className="page-title">Ask RAY</h1>
        <p className="page-sub">Ask about any payment or case, or tell RAY how to handle things. RAY answers from your own cases and shows where each number came from.</p>
      </div>
      <div className="ask-full">
        <AskChat initialQuery={initialQuery} />
      </div>
      <NudgeBar
        text={suggestion ? `RAY suggests a rule: ${suggestion}.` : "Tell RAY how to handle things, and it will do it the same way every time."}
        action={{ label: suggestion ? "Review rule" : "Open Rules", href: `/merchant/${merchantId}/rules` }}
      />
      <CoachMarks
        id="ask-page"
        steps={[
          { target: ".ask-page [data-coach='ask-chips']", title: "Start with a question", text: "Tap a question, or type your own. Every number links back to the cases it came from." },
          { target: ".ask-page [data-coach='ask-input']", title: "Tell RAY a rule", text: "Type how you want things handled. RAY shows the rule first and only saves it when you tap Approve rule." },
        ]}
      />
    </div>
  );
}

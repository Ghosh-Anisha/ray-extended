"use client";

// The in-dashboard assistant. The conversation is shared with the shell panel.
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
        <h1 className="page-title">Ask Agentic Dashboard</h1>
        <p className="page-sub">Ask a supported case or payment question, or ask for a rule. This demo uses scripted intent routing and seeded records, not a general-purpose agent; unsupported questions get a limitation instead of a guessed answer.</p>
      </div>
      <div className="ask-full">
        <AskChat initialQuery={initialQuery} />
      </div>
      <NudgeBar
        text={suggestion ? `The demo suggests a rule: ${suggestion}.` : "Ask a supported question or propose a rule. Answers use seeded records; rule requests need your approval."}
        action={{ label: suggestion ? "Review rule" : "Open Rules", href: `/merchant/${merchantId}/rules` }}
      />
      <CoachMarks
        id="ask-page"
        steps={[
          { target: ".ask-page [data-coach='ask-chips']", title: "Start with a question", text: "Ask a supported question or rule request. Answers use seeded demo records and show their basis or link to the case; unsupported questions get a limitation, not a guessed investigation." },
          { target: ".ask-page [data-coach='ask-input']", title: "Propose a rule", text: "Type how you want things handled. Agentic Dashboard shows the rule first and only saves it when you tap Approve rule." },
        ]}
      />
    </div>
  );
}

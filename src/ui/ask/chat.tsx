"use client";

// The Ask RAY conversation: thread, starter chips, and the input. Used by the
// side panel (compact) and by the /ask page.
import { Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CASE_CHIPS, STARTER_CHIPS } from "@/ask/answer";
import { useAsk } from "./ask-context";
import { ReplyView } from "./reply";

export function AskChat({ initialQuery = "", compact }: { initialQuery?: string; compact?: boolean }) {
  const { merchantId, caseId, thread, busy, send } = useAsk();
  const [text, setText] = useState(initialQuery);
  const end = useRef<HTMLDivElement>(null);
  const chips = caseId ? CASE_CHIPS : STARTER_CHIPS;

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [thread.length, busy]);

  function submit(t: string) {
    if (!t.trim() || busy) return;
    setText("");
    send(t);
  }

  return (
    <div className={`ask-chat ${compact ? "compact" : ""}`}>
      <div className="ask-thread" aria-live="polite">
        {thread.length === 0 && (
          <div className="ask-hello">
            <span className="tile-icon" aria-hidden="true">
              <Sparkles size={18} />
            </span>
            <strong>{caseId ? "Ask RAY about this case" : "Ask RAY anything about your payments"}</strong>
            <span className="muted">{caseId ? "RAY answers from what it found on this case." : "Questions, or tell RAY how to handle things. Every number comes from your own cases."}</span>
          </div>
        )}
        {thread.map((m) =>
          m.from === "you" ? (
            <div key={m.id} className="ask-msg you">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="ask-msg ray">
              {m.reply ? <ReplyView merchantId={merchantId} reply={m.reply} onChip={submit} /> : m.text}
            </div>
          ),
        )}
        {busy && <div className="ask-msg ray muted">RAY is checking your cases…</div>}
        <div ref={end} />
      </div>
      <div className="ask-bottom">
        {thread.length === 0 && (
          <div className="ask-chips" data-coach="ask-chips">
            {chips.map((c) => (
              <button key={c} type="button" className="seg" onClick={() => submit(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        <form
          className="ask-input"
          data-coach="ask-input"
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={caseId ? "Ask RAY about this case…" : "Ask a question, or tell RAY a rule…"} aria-label="Ask RAY" maxLength={400} />
          <button type="submit" className="btn primary small" disabled={busy || !text.trim()} aria-label="Send">
            <Send size={14} aria-hidden="true" />
            Ask
          </button>
        </form>
      </div>
    </div>
  );
}

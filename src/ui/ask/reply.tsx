"use client";

// How one RAY reply is drawn: the sentence, the numbers it used, links to the
// cases they came from, the rule card when it is a rule, and chips to try next.
import { Check, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AskReply } from "@/ask/answer";
import type { RuleCardData } from "@/ask/rules";
import { Button } from "@/ui/kit";
import { post } from "../bits";

const STATUS_TONE = { On: "positive", "Try it": "information", "Coming soon": "neutral" } as const;

export function RuleCard({ merchantId, card: first, onDone }: { merchantId: string; card: RuleCardData; onDone?: (text: string) => void }) {
  const router = useRouter();
  const [card, setCard] = useState(first);
  const [state, setState] = useState<"ask" | "editing" | "saving" | "saved" | "later">("ask");
  const [amount, setAmount] = useState(String(first.edit?.rupees ?? ""));
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setState("saving");
    setError(null);
    const r = await post("/api/merchant/ask/rule", { merchantId, plan: card.plan, action: "approve" });
    if (!r.ok) {
      setError(r.error);
      setState("ask");
      return;
    }
    const text = (r.result as { text: string }).text;
    setMsg(text);
    setState("saved");
    onDone?.(text);
    router.refresh();
  }
  async function applyEdit() {
    const rupees = Number(amount.replace(/[^\d]/g, ""));
    if (!rupees) {
      setError("Enter an amount in rupees");
      return;
    }
    const plan = { ...card.plan, rupees };
    const r = await post("/api/merchant/ask/rule", { merchantId, plan, action: "edit" });
    if (!r.ok) return setError(r.error);
    setCard((r.result as { card: RuleCardData }).card);
    setError(null);
    setState("ask");
  }

  return (
    <div className="rule-card" data-state={state}>
      <div className="rule-card-head">
        <span className="chip information">Rule</span>
        {card.alreadyOn && <span className="chip positive">Already on</span>}
      </div>
      <strong className="rule-sentence">{card.sentence}</strong>
      <div className="muted">{card.scope}</div>
      <p className="rule-does">{card.does}</p>
      {state === "editing" && card.edit && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            applyEdit();
          }}
        >
          <label className="row">
            <span>{card.edit.label} ₹</span>
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} style={{ width: 110 }} aria-label={card.edit.label} autoFocus />
          </label>
          <Button type="submit" size="small" variant="secondary">
            Update rule
          </Button>
        </form>
      )}
      {error && <span className="error">{error}</span>}
      {state === "saved" && (
        <div className="rule-saved">
          <Check size={14} aria-hidden="true" /> {msg}{" "}
          <Link href={`/merchant/${merchantId}/rules`}>See it in Rules</Link>
        </div>
      )}
      {state === "later" && <div className="muted">Not now. Nothing changed.</div>}
      {(state === "ask" || state === "editing" || state === "saving") && !card.alreadyOn && (
        <div className="row">
          <Button size="small" onClick={approve} isLoading={state === "saving"}>
            Approve rule
          </Button>
          {card.edit && (
            <Button size="small" variant="secondary" onClick={() => setState(state === "editing" ? "ask" : "editing")}>
              Edit
            </Button>
          )}
          <Button size="small" variant="tertiary" onClick={() => setState("later")}>
            Not now
          </Button>
        </div>
      )}
    </div>
  );
}

export function ReplyView({ merchantId, reply, onChip }: { merchantId: string; reply: AskReply; onChip: (t: string) => void }) {
  return (
    <div className="reply stack" style={{ gap: 8 }}>
      <span>{reply.text}</span>
      {reply.bullets.length > 0 && (
        <ul className="reply-list">
          {reply.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      {reply.rule && <RuleCard merchantId={merchantId} card={reply.rule} />}
      {reply.capabilities.length > 0 && (
        <ul className="cap-list">
          {reply.capabilities.map((c) => (
            <li key={c.key}>
              <div className="grow">
                <strong>{c.title}</strong>
                <div className="muted">{c.openCases > 0 ? `${c.line} ${c.openCases} open ${c.openCases === 1 ? "case" : "cases"} in this demo.` : c.line}</div>
              </div>
              {c.preview && <span className="chip simulated">Preview · simulated</span>}
              {c.href && c.preview ? (
                <Link className="chip neutral" href={c.href}>Open preview</Link>
              ) : c.href && c.status !== "Coming soon" ? (
                <Link className={`chip ${STATUS_TONE[c.status]}`} href={c.href}>
                  {c.status}
                </Link>
              ) : (
                <span className={`chip ${STATUS_TONE[c.status]}`}>{c.status}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {reply.cites.length > 0 && (
        <div className="cites" aria-label="Where this came from">
          {reply.cites.map((c) => (
            <Link key={c.href + c.label} className="cite" href={c.href}>
              <ExternalLink size={12} aria-hidden="true" />
              {c.label}
            </Link>
          ))}
        </div>
      )}
      {reply.chips.length > 0 && (
        <div className="chips-scroll" style={{ flexWrap: "wrap" }}>
          {reply.chips.map((c) => (
            <button key={c} type="button" className="seg" onClick={() => onChip(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

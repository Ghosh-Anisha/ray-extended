"use client";

// Coach-mark pop-ups (docs/ui-rebuild.md section 10): a card with an arrow
// anchored to a real element, one sentence, Next / Got it and step dots. A
// screen's sequence shows once per browser; "Show me around" replays it; a
// tour (?tour=name) always plays. The guided demo can reuse CoachPopup.
import { X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { activeKey } from "../shell/nav";
import { REPLAY_EVENT, SCREEN_STEPS, SEEN_PREFIX, TOURS, type CoachStep } from "./tours";

const seen = (key: string) => {
  try {
    return window.localStorage.getItem(SEEN_PREFIX + key) === "1";
  } catch {
    return false;
  }
};
const markSeen = (key: string) => {
  try {
    window.localStorage.setItem(SEEN_PREFIX + key, "1");
  } catch {
    /* private mode: it will show again next time */
  }
};

// "Show me around": forget what was dismissed and replay this screen.
export function replayCoachMarks() {
  try {
    for (const k of Object.keys(window.localStorage)) if (k.startsWith(SEEN_PREFIX)) window.localStorage.removeItem(k);
  } catch {
    /* nothing stored */
  }
  window.dispatchEvent(new Event(REPLAY_EVENT));
}

type Placed = { top: number; left: number; arrowLeft: number; above: boolean; sheet: boolean };

export function CoachPopup({ steps, index, onNext, onBack, onClose }: { steps: CoachStep[]; index: number; onNext: () => void; onBack: () => void; onClose: () => void }) {
  const step = steps[index];
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placed | null>(null);
  const last = index === steps.length - 1;

  const place = useCallback(() => {
    const el = document.querySelector<HTMLElement>(step.target);
    const card = ref.current;
    if (!el || !card) return;
    const r = el.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    const h = card.offsetHeight;
    const sheet = window.innerWidth < 640;
    const below = r.bottom + 14 + h <= window.innerHeight;
    const top = below ? r.bottom + 14 : Math.max(12, r.top - 14 - h);
    const left = Math.min(Math.max(12, r.left + 24), window.innerWidth - w - 12);
    setPos({ top, left, arrowLeft: Math.min(Math.max(16, r.left + Math.min(r.width / 2, 60) - left), w - 28), above: !below, sheet });
  }, [step.target]);

  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el) return;
    el.classList.add("coach-ring");
    const r = el.getBoundingClientRect();
    if (r.top < 80 || r.bottom > window.innerHeight - 200) el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    place();
    const again = () => place();
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    return () => {
      el.classList.remove("coach-ring");
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", again, true);
    };
  }, [step.target, place]);

  return (
    <div
      ref={ref}
      className={`coach ${pos?.sheet ? "sheet" : ""}`}
      role="dialog"
      aria-label="Tip"
      style={pos && !pos.sheet ? { top: pos.top, left: pos.left } : undefined}
      data-above={pos?.above ? "1" : undefined}
    >
      {pos && !pos.sheet && <span className="coach-arrow" style={{ left: pos.arrowLeft, [pos.above ? "bottom" : "top"]: -6 }} />}
      <button type="button" className="coach-x" aria-label="Close tips" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </button>
      <p>{step.text}</p>
      <div className="coach-foot">
        <span className="coach-dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
          {steps.map((_, i) => (
            <i key={i} data-on={i === index ? "1" : undefined} />
          ))}
        </span>
        <span className="grow" />
        {index > 0 && (
          <button type="button" className="btn secondary small" onClick={onBack}>
            Back
          </button>
        )}
        <button type="button" className="btn primary small" onClick={last ? onClose : onNext}>
          {last ? "Got it" : "Next"}
        </button>
      </div>
    </div>
  );
}

type Plan = { id: string; steps: CoachStep[]; key: string | null };

// One run of a sequence: waits for the page to draw, keeps the steps whose
// element exists, then shows them. Remounted (keyed) for each plan.
function CoachRun({ plan }: { plan: Plan }) {
  const [steps, setSteps] = useState<CoachStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const found = plan.steps.filter((s) => document.querySelector(s.target));
      if (found.length > 0 && (found.length === plan.steps.length || tries >= 6)) {
        window.clearInterval(timer);
        setSteps(found);
      } else if (tries >= 12) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [plan]);

  if (!steps || closed) return null;
  const close = () => {
    if (plan.key) markSeen(plan.key);
    setClosed(true);
  };
  return <CoachPopup steps={steps} index={index} onNext={() => setIndex(index + 1)} onBack={() => setIndex(Math.max(0, index - 1))} onClose={close} />;
}

export function CoachHost() {
  const path = usePathname();
  const params = useSearchParams();
  const tour = params.get("tour");
  const screen = activeKey(path);
  const [replays, setReplays] = useState(0);

  useEffect(() => {
    const on = () => setReplays((n) => n + 1);
    window.addEventListener(REPLAY_EVENT, on);
    return () => window.removeEventListener(REPLAY_EVENT, on);
  }, []);

  // `replays` is read so a replay remounts the run even when nothing else changed.
  const plan: Plan | null =
    tour && TOURS[tour]
      ? { id: `tour:${tour}:${path}:${replays}`, steps: TOURS[tour], key: null }
      : screen && SCREEN_STEPS[screen] && (replays > 0 || !seen(screen))
        ? { id: `screen:${screen}:${replays}`, steps: SCREEN_STEPS[screen], key: screen }
        : null;
  return plan ? <CoachRun key={plan.id} plan={plan} /> : null;
}

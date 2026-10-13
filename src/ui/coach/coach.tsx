"use client";

// Coach-mark pop-ups (docs/ui-rebuild.md section 10): a short sequence of
// pop-ups anchored to real elements, each with one sentence, Next or Got it,
// and step dots. Dismissed ones never repeat in this browser. Only one shows
// at a time, in the order screens registered. "Show me around" replays them.
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

const PREFIX = "ray-coach-";
const REPLAY_EVENT = "ray:coach-replay";

export type CoachStep = { target: string; title?: string; text: string };

const read = (id: string) => {
  try {
    return window.localStorage.getItem(PREFIX + id) === "1";
  } catch {
    return false;
  }
};
const write = (id: string) => {
  try {
    window.localStorage.setItem(PREFIX + id, "1");
  } catch {
    // Private windows can block storage; the pop-up just shows again.
  }
};

// The queue: the first id is the one on screen.
let queue: string[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const activeId = () => queue[0] ?? null;

export function replayCoachMarks() {
  try {
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // Nothing stored to clear.
  }
  window.dispatchEvent(new Event(REPLAY_EVENT));
}

type Rect = { top: number; left: number; width: number; height: number };

// The floating card with an arrow. Also used by the guided demo (section 6),
// which passes its own labels and step text.
export function CoachPopover({
  anchor,
  title,
  text,
  step,
  total,
  nextLabel,
  onNext,
  onBack,
  onExit,
  exitLabel = "Skip",
}: {
  anchor: Rect | null;
  title?: string;
  text: string;
  step: number;
  total: number;
  nextLabel: string;
  onNext: () => void;
  onBack?: () => void;
  onExit: () => void;
  exitLabel?: string;
}) {
  const W = 300;
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const width = Math.min(W, vw - 24);
  let top = vh - 200;
  let left = vw - width - 16;
  let below = true;
  let arrowLeft = 24;
  if (anchor) {
    below = anchor.top + anchor.height + 190 < vh || anchor.top < 200;
    top = below ? anchor.top + anchor.height + 14 : Math.max(12, anchor.top - 14 - 168);
    left = Math.min(Math.max(12, anchor.left + anchor.width / 2 - width / 2), vw - width - 12);
    arrowLeft = Math.min(Math.max(16, anchor.left + anchor.width / 2 - left - 6), width - 28);
  }
  top = Math.min(Math.max(12, top), Math.max(12, vh - 210));
  return (
    <>
      {anchor && <div className="coach-ring" style={{ top: anchor.top - 4, left: anchor.left - 4, width: anchor.width + 8, height: anchor.height + 8 }} aria-hidden="true" />}
      <div className="coach" role="dialog" aria-label={title ?? "Tip"} style={{ top, left, width, bottom: "auto", right: "auto" }}>
        {anchor && <span className={`coach-arrow ${below ? "up" : "down"}`} style={{ left: arrowLeft }} aria-hidden="true" />}
        {title && <strong className="coach-title">{title}</strong>}
        <p className="coach-text">{text}</p>
        <div className="coach-foot">
          <span className="coach-dots" aria-label={`Step ${step + 1} of ${total}`}>
            {Array.from({ length: total }, (_, i) => (
              <i key={i} data-on={i === step} />
            ))}
          </span>
          <span className="grow" />
          {onBack && step > 0 && (
            <button type="button" className="btn tertiary small" onClick={onBack}>
              Back
            </button>
          )}
          {step < total - 1 && (
            <button type="button" className="btn tertiary small" onClick={onExit}>
              {exitLabel}
            </button>
          )}
          <button type="button" className="btn primary small" onClick={onNext}>
            {nextLabel}
          </button>
        </div>
      </div>
    </>
  );
}

export function CoachMarks({ id, steps, enabled = true }: { id: string; steps: CoachStep[]; enabled?: boolean }) {
  const [done, setDone] = useState(true);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const active = useSyncExternalStore(subscribe, activeId, () => null);

  // Join the queue after the first paint, unless this was dismissed before.
  const join = useCallback(() => {
    if (!enabled || read(id)) return;
    setDone(false);
    setI(0);
    if (!queue.includes(id)) queue = [...queue, id];
    emit();
  }, [id, enabled]);

  useEffect(() => {
    const t = window.setTimeout(join, 600);
    window.addEventListener(REPLAY_EVENT, join);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener(REPLAY_EVENT, join);
      queue = queue.filter((x) => x !== id);
      emit();
    };
  }, [join, id]);

  const finish = useCallback(() => {
    write(id);
    setDone(true);
    queue = queue.filter((x) => x !== id);
    emit();
  }, [id]);

  const shown = !done && active === id;
  const step = steps[i];

  // Find the element; a step whose element isn't on the page is skipped.
  useLayoutEffect(() => {
    if (!shown || !step) return;
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el || el.getBoundingClientRect().width === 0) {
      const t = window.setTimeout(() => (i < steps.length - 1 ? setI(i + 1) : finish()), 0);
      return () => window.clearTimeout(t);
    }
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const measure = () => {
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [shown, step, i, steps.length, finish]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, finish]);

  if (!shown || !step || !rect) return null;
  const last = i === steps.length - 1;
  return (
    <CoachPopover
      anchor={rect}
      title={step.title}
      text={step.text}
      step={i}
      total={steps.length}
      nextLabel={last ? "Got it" : "Next"}
      onNext={() => (last ? finish() : setI(i + 1))}
      onBack={() => setI(Math.max(0, i - 1))}
      onExit={finish}
    />
  );
}

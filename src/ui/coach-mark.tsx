"use client";

import { useEffect, useState } from "react";

type Step = { target: string; text: string };

export function CoachMarks({ id, steps }: { id: string; steps: Step[] }) {
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (window.localStorage.getItem(`ray-coach-${id}`) !== "done") setOpen(true);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    const update = () => setRect(document.querySelector(steps[step]?.target)?.getBoundingClientRect() ?? null);
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, step, steps]);
  if (!open || steps.length === 0) return null;
  const finish = () => { window.localStorage.setItem(`ray-coach-${id}`, "done"); setOpen(false); };
  const last = step === steps.length - 1;
  return <>
    {rect && <div className="coach-ring" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />}
    <aside className="coach-card" role="dialog" aria-label="Quick tour">
      <div className="row" style={{ justifyContent: "space-between" }}><span className="muted" style={{ fontSize: 12 }}>A quick look around</span><button type="button" className="link" onClick={finish}>Exit</button></div>
      <p>{steps[step].text}</p>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="coach-dots" aria-label={`Step ${step + 1} of ${steps.length}`}>{steps.map((_, i) => <span key={i} className={i === step ? "active" : ""} />)}</span>
        <span className="row">{step > 0 && <button type="button" className="btn secondary small" onClick={() => setStep((n) => n - 1)}>Back</button>}<button type="button" className="btn primary small" onClick={() => last ? finish() : setStep((n) => n + 1)}>{last ? "Got it" : "Next"}</button></span>
      </div>
    </aside>
  </>;
}

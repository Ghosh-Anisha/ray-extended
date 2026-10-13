"use client";

import { useEffect, useState } from "react";

export function CoachMark({ id, steps }: { id: string; steps: string[] }) {
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(`ray-coach-${id}`) !== "1") setStep(0);
      } catch {
        setStep(0);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [id]);
  if (step === null) return null;
  const done = () => {
    try { window.localStorage.setItem(`ray-coach-${id}`, "1"); } catch { /* best effort */ }
    setStep(null);
  };
  return (
    <aside className="coach" role="dialog" aria-label="RAY guide">
      <div className="coach-kicker">RAY guide · {step + 1} of {steps.length}</div>
      <p>{steps[step]}</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {step > 0 && <button className="btn secondary small" type="button" onClick={() => setStep(step - 1)}>Back</button>}
        <button className="btn primary small" type="button" onClick={() => step + 1 < steps.length ? setStep(step + 1) : done()}>{step + 1 < steps.length ? "Next" : "Got it"}</button>
        <button className="linkbtn" type="button" onClick={done}>Exit</button>
      </div>
    </aside>
  );
}

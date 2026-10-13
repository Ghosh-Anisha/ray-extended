"use client";

// Compatibility wrappers for older screens. All first-run guidance now joins
// the same queue/popover so it cannot compete with the guided demo or another
// screen's coach mark.
import { CoachMarks as CoordinatedCoachMarks, type CoachStep } from "./coach/coach";

export function CoachMarks({ id, steps }: { id: string; steps: CoachStep[] }) {
  return <CoordinatedCoachMarks id={id} steps={steps} />;
}

export function CoachMark({ id, steps }: { id: string; steps: string[] }) {
  return <CoordinatedCoachMarks id={id} steps={steps.map((text) => ({ text }))} />;
}

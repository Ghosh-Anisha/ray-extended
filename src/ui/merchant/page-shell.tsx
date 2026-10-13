"use client";

// The page frame for merchant surfaces inside the shell: phone view narrows
// to one column.
import type { ReactNode } from "react";
import { KillSwitchBanner } from "../bits";
import { useView } from "../view";

export function PageShell({ killSwitch, wide, children }: { killSwitch: boolean; wide?: boolean; children: ReactNode }) {
  const { view } = useView();
  return (
    <div className={`page ${view === "phone" && !wide ? "phone" : ""}`} data-view={view}>
      <div className="stack">
        {killSwitch && <KillSwitchBanner />}
        {children}
      </div>
    </div>
  );
}

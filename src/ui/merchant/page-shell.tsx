"use client";

// The page frame for merchant surfaces: phone view narrows to one column.
import type { ReactNode } from "react";
import { KillSwitchBanner } from "../bits";
import { useView } from "../view";

export function PageShell({ killSwitch, children }: { killSwitch: boolean; children: ReactNode }) {
  const { view } = useView();
  return (
    <main className={`page ${view === "phone" ? "phone" : ""}`} data-view={view}>
      <div className="stack">
        {killSwitch && <KillSwitchBanner />}
        {children}
      </div>
    </main>
  );
}

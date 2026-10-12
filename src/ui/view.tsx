"use client";

// View: Phone | Desktop. Defaults by screen width, remembers the choice for
// this browser, and switches without a reload.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type View = "phone" | "desktop";
export const VIEW_KEY = "ray-view";
export const PHONE_MAX_WIDTH = 768;

const Ctx = createContext<{ view: View; setView: (v: View) => void }>({ view: "desktop", setView: () => {} });

function stored(): View | null {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === "phone" || v === "desktop" ? v : null;
  } catch {
    return null;
  }
}

export function ViewProvider({ children, initial }: { children: ReactNode; initial?: View }) {
  const [view, set] = useState<View>(initial ?? "desktop");
  useEffect(() => {
    if (initial) return;
    // Runs once after hydration: the server can't know the width.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    set(stored() ?? (window.innerWidth <= PHONE_MAX_WIDTH ? "phone" : "desktop"));
  }, [initial]);
  const setView = (v: View) => {
    set(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Private windows can refuse storage; the switch still works.
    }
  };
  return <Ctx.Provider value={{ view, setView }}>{children}</Ctx.Provider>;
}

export const useView = () => useContext(Ctx);

export function ViewSwitch() {
  const { view, setView } = useView();
  return (
    <div className="row" role="group" aria-label="View">
      <span className="muted">View:</span>
      {(["phone", "desktop"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          className="seg"
          onClick={() => setView(v)}
        >
          {v === "phone" ? "Phone" : "Desktop"}
        </button>
      ))}
    </div>
  );
}

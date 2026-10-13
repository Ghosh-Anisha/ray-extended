"use client";

// A small toast with an optional action ("Moved to RAY is handling · Undo").
// One at a time, gone after 8 seconds.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ToastAction = { label: string; run: () => void | Promise<void> };
type Toast = { id: number; text: string; action?: ToastAction };

const Ctx = createContext<(text: string, action?: ToastAction) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const next = useRef(0);
  const show = useCallback((text: string, action?: ToastAction) => {
    clearTimeout(timer.current);
    setToast({ id: ++next.current, text, action });
    timer.current = setTimeout(() => setToast(null), 8000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Ctx.Provider value={show}>
      {children}
      {toast && (
        <div className="toast" role="status" key={toast.id}>
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={async () => {
                setToast(null);
                await toast.action!.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

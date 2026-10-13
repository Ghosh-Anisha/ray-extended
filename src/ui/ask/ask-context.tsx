"use client";

// The Ask RAY conversation, shared by the side panel and the /ask page so a
// thread survives moving between pages. One thread for the whole account and
// one per case ("Ask RAY about this case...").
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AskReply } from "@/ask/answer";
import { post } from "../bits";

export type Msg = { id: number; from: "you" | "ray"; text: string; reply?: AskReply };
type Ctx = {
  merchantId: string;
  open: boolean;
  setOpen: (v: boolean) => void;
  caseId: string | null;
  thread: Msg[];
  busy: boolean;
  send: (text: string) => Promise<void>;
};

const AskCtx = createContext<Ctx | null>(null);
export const useAsk = () => {
  const c = useContext(AskCtx);
  if (!c) throw new Error("useAsk needs AskProvider");
  return c;
};

let nextId = 1;

export function AskProvider({ merchantId, caseId, children }: { merchantId: string; caseId: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<Record<string, Msg[]>>({});
  const [busy, setBusy] = useState(false);
  const key = `${merchantId}:${caseId ?? "all"}`;
  const thread = useMemo(() => threads[key] ?? [], [threads, key]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      const add = (m: Omit<Msg, "id">) => setThreads((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), { ...m, id: nextId++ }] }));
      add({ from: "you", text: t });
      setBusy(true);
      const r = await post("/api/merchant/ask", { merchantId, text: t, caseId });
      setBusy(false);
      if (r.ok) {
        const reply = r.result as AskReply;
        add({ from: "ray", text: reply.text, reply });
      } else {
        add({ from: "ray", text: r.error });
      }
    },
    [key, merchantId, caseId],
  );

  const value = useMemo(() => ({ merchantId, open, setOpen, caseId, thread, busy, send }), [merchantId, open, caseId, thread, busy, send]);
  return <AskCtx.Provider value={value}>{children}</AskCtx.Provider>;
}

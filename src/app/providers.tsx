"use client";

import type { ReactNode } from "react";
import { ToastProvider } from "@/ui/toast";
import { ViewProvider } from "@/ui/view";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ViewProvider>
      <ToastProvider>{children}</ToastProvider>
    </ViewProvider>
  );
}

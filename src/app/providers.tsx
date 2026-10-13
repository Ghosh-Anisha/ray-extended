"use client";

import type { ReactNode } from "react";
import { ViewProvider } from "@/ui/view";

export function Providers({ children }: { children: ReactNode }) {
  return <ViewProvider>{children}</ViewProvider>;
}

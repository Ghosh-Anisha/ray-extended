"use client";

import { BladeProvider } from "@razorpay/blade/components";
import { bladeTheme } from "@razorpay/blade/tokens";
import type { ReactNode } from "react";
import { ViewProvider } from "@/ui/view";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <BladeProvider themeTokens={bladeTheme} colorScheme="light">
      <ViewProvider>{children}</ViewProvider>
    </BladeProvider>
  );
}

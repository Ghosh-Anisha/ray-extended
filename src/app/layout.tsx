import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { ShellServer } from "@/ui/shell/shell-server";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "RAY",
  description: "An account manager that acts, for every small Razorpay merchant.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Browser extensions add attributes to body before React loads. */}
      <body suppressHydrationWarning>
        <Providers>
          <ShellServer>{children}</ShellServer>
        </Providers>
      </body>
    </html>
  );
}

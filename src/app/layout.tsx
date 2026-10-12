import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@razorpay/blade/fonts.css";
import "./globals.css";
import { Providers } from "./providers";
import { StyledRegistry } from "./registry";

export const metadata: Metadata = {
  title: "RAY",
  description: "An account manager that acts, for every small Razorpay merchant.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/* Browser extensions add attributes to body before React loads. */}
      <body suppressHydrationWarning>
        <StyledRegistry>
          <Providers>{children}</Providers>
        </StyledRegistry>
      </body>
    </html>
  );
}

import type { ReactNode } from "react";
import { SimBar } from "@/ui/sim/sim-bar";

export default function SimLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SimBar />
      <main className="page">{children}</main>
    </>
  );
}

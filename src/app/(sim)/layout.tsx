import type { ReactNode } from "react";

// The simulators are pages in the shell like any other; each shows its own
// Simulated tag. The old "Simulators" header is gone.
export default function SimLayout({ children }: { children: ReactNode }) {
  return <div className="page stack">{children}</div>;
}

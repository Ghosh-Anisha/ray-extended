"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SimulatedTag } from "../bits";

// No link to the dev panel: the customer and buyer inboxes are screens a
// customer or buyer would see, and the dev panel uses technical words.
// It is reached from the home page.
export const SIM_NAV = [
  { href: "/sim/inbox", label: "Customer inbox" },
  { href: "/sim/buyers", label: "Buyer inbox" },
  { href: "/sim/store", label: "Store admin" },
  { href: "/sim/calls", label: "Calls" },
  { href: "/sim/international", label: "Checkout abroad" },
];

// Simulators are always the desktop view and always carry the Simulated tag.
export function SimBar() {
  const path = usePathname();
  return (
    <header className="topbar">
      <span className="brand">Simulators</span>
      <SimulatedTag />
      <nav className="nav" aria-label="Simulators">
        {SIM_NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? "page" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <span className="spacer" />
      <Link href="/merchant">Merchant view</Link>
    </header>
  );
}

export function SimTitle({ children }: { children: string }) {
  return (
    <div className="sim-head">
      <h1 style={{ margin: 0, fontSize: 20 }}>{children}</h1>
      <SimulatedTag />
    </div>
  );
}

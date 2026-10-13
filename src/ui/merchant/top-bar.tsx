"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ViewSwitch } from "../view";

export const MERCHANT_NAV = [
  { href: "", label: "Cases" },
  { href: "/collect", label: "Invoice overdue" },
  { href: "/alerts", label: "Alerts" },
  { href: "/digest", label: "Digest" },
  { href: "/playbook", label: "Playbook" },
  { href: "/whatsapp", label: "WhatsApp" },
] as const;

export function MerchantTopBar({ merchantId, merchants }: { merchantId: string; merchants: { id: string; name: string }[] }) {
  const path = usePathname();
  const router = useRouter();
  const base = `/merchant/${merchantId}`;
  const current = (href: string) => (href === "" ? path === base || path.startsWith(`${base}/cases`) : path.startsWith(base + href));
  return (
    <header className="topbar">
      <span className="brand">Razorpay</span>
      <span className="chip prototype">Prototype</span>
      <nav className="nav" aria-label="RAY">
        {MERCHANT_NAV.map((n) => (
          <Link key={n.label} href={base + n.href} aria-current={current(n.href) ? "page" : undefined}>
            {n.label}
          </Link>
        ))}
      </nav>
      <span className="spacer" />
      <label className="row">
        <span className="muted">Account</span>
        <select value={merchantId} onChange={(e) => router.push(path.replace(base, `/merchant/${e.target.value}`).replace(/\/cases\/.*$/, ""))}>
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <ViewSwitch />
    </header>
  );
}

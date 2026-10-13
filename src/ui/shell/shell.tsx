"use client";

// One shell for every page: black top bar, white left nav, content on the
// canvas (docs/ui-rebuild.md sections 1 and 2). Phone width turns the nav into
// a slide-in drawer.
import { ChevronDown, Menu, Monitor, Search, Settings2, Smartphone, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useView } from "../view";
import { DemoControls, OpenControlsOnParam } from "./demo-controls";
import { ACCOUNT_COOKIE, NAV, activeKey, initials, merchantIdFromPath } from "./nav";

export type ShellMerchant = { id: string; name: string; needsYou: number };

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13.2 3 5 21h4.1l1.6-3.7 4.4 3.7 2.6-3.2-4.6-3.9L16.4 3z" fill="#3395ff" />
    </svg>
  );
}

// The saved account, for pages outside /merchant/<id> (read on the server).
function saveAccount(id: string) {
  document.cookie = `${ACCOUNT_COOKIE}=${id}; path=/; max-age=31536000; samesite=lax`;
}

function AccountSwitcher({ merchants, currentId }: { merchants: ShellMerchant[]; currentId: string }) {
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = merchants.find((m) => m.id === currentId) ?? merchants[0];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function pick(id: string) {
    saveAccount(id);
    setOpen(false);
    const inMerchant = merchantIdFromPath(path);
    if (inMerchant) {
      // Stay on the same page for the other account, except a single case.
      router.push(path.replace(`/merchant/${inMerchant}`, `/merchant/${id}`).replace(/\/cases\/.*$/, "/cases"));
    } else {
      router.refresh();
    }
  }

  return (
    <div className="shell-account" ref={ref}>
      <button type="button" className="shell-account-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden="true">{initials(current?.name ?? "?")}</span>
        <span className="shell-name">{current?.name}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-label">Switch account</div>
          {merchants.map((m) => (
            <button key={m.id} type="button" role="menuitem" aria-current={m.id === currentId} onClick={() => pick(m.id)}>
              <span className="avatar" aria-hidden="true" style={{ width: 24, height: 24, fontSize: 11 }}>{initials(m.name)}</span>
              <span className="grow">{m.name}</span>
              {m.id === "m_leafy_bakes" && <span className="chip neutral">Demo</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell({ merchants, defaultMerchantId, children }: { merchants: ShellMerchant[]; defaultMerchantId: string; children: ReactNode }) {
  const path = usePathname();
  const { view, setView } = useView();
  const [navOpen, setNavOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  // The URL decides on merchant pages; elsewhere the saved account does.
  const merchantId = merchantIdFromPath(path) ?? defaultMerchantId;
  const active = activeKey(path);
  const needsYou = merchants.find((m) => m.id === merchantId)?.needsYou ?? 0;
  const home = `/merchant/${merchantId}`;

  // Close the phone nav after moving to another page.
  const [lastPath, setLastPath] = useState(path);
  if (lastPath !== path) {
    setLastPath(path);
    setNavOpen(false);
  }

  return (
    <div className="shell">
      <header className="shell-top">
        <button type="button" className="shell-burger" aria-label={navOpen ? "Close menu" : "Open menu"} aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>
          {navOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <Link href={home} className="shell-brand" aria-label="Razorpay Home">
          <Logo />
          <span>Razorpay</span>
        </Link>
        <nav className="shell-tabs" aria-label="Razorpay">
          <Link href={home} className="shell-tab link">Razorpay Home</Link>
          <span className="shell-tab" title="Not part of this prototype">Payments</span>
          <Link href={`${home}/cases`} className="shell-tab link" aria-current="page">Agentic Dashboard</Link>
          <span className="shell-tab" title="Not part of this prototype">Banking+</span>
        </nav>
        <span className="shell-spacer" />
        <Link href={`${home}/ask`} className="shell-search" aria-label="Search or ask RAY">
          <Search size={16} aria-hidden="true" />
          <span>Search payments, cases</span>
        </Link>
        <Link href={`${home}/ask`} className="shell-ray" aria-label="Ask RAY">
          <Sparkles size={16} aria-hidden="true" />
          <span className="label">RAY</span>
        </Link>
        <div className="view-switch" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "phone"} onClick={() => setView("phone")} aria-label="Phone view">
            <Smartphone size={14} aria-hidden="true" />
            <span className="label">Phone</span>
          </button>
          <button type="button" aria-pressed={view === "desktop"} onClick={() => setView("desktop")} aria-label="Desktop view">
            <Monitor size={14} aria-hidden="true" />
            <span className="label">Desktop</span>
          </button>
        </div>
        <span className="chip prototype">Prototype</span>
        <AccountSwitcher merchants={merchants} currentId={merchantId} />
      </header>

      <div className="shell-body">
        <nav className="shell-nav" aria-label="Agentic Dashboard" data-open={navOpen}>
          {NAV.map((section, i) => (
            <div key={section.label ?? i} style={{ display: "contents" }}>
              {section.label && <div className="nav-label">{section.label}</div>}
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.key} href={item.href(merchantId)} className="nav-item" aria-current={active === item.key ? "page" : undefined}>
                    <Icon size={16} aria-hidden="true" />
                    <span className="grow">{item.label}</span>
                    {item.badge === "needs_you" && needsYou > 0 && <span className="nav-badge" title="Cases that need you">{needsYou}</span>}
                    {item.simulated && <span className="nav-sim">Simulated</span>}
                  </Link>
                );
              })}
            </div>
          ))}
          <div className="nav-foot">
            <div className="nav-sep" />
            <button type="button" className="nav-item" onClick={() => setControlsOpen(true)} aria-haspopup="dialog">
              <Settings2 size={16} aria-hidden="true" />
              <span className="grow">Demo controls</span>
              <span className="nav-sim">Simulated</span>
            </button>
          </div>
        </nav>
        <div className="shell-scrim" data-open={navOpen} onClick={() => setNavOpen(false)} />
        <main className="shell-main" id="main">
          {children}
        </main>
      </div>

      <Suspense fallback={null}>
        <OpenControlsOnParam onOpen={() => setControlsOpen(true)} />
      </Suspense>
      {controlsOpen && <DemoControls merchantId={merchantId} onClose={() => setControlsOpen(false)} />}
    </div>
  );
}

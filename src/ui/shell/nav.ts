// The information architecture from docs/ui-rebuild.md section 1: one place
// for the left nav, the top bar tabs and the breadcrumb labels.
import { Building2, CalendarClock, Home, Inbox, LayoutDashboard, ListChecks, Mail, MessageCircle, Sparkles, Store, type LucideIcon } from "lucide-react";

export type NavItem = { key: string; label: string; icon: LucideIcon; href: (merchantId: string) => string; simulated?: boolean; badge?: "needs_you" };
export type NavSection = { label: string | null; items: NavItem[] };

const merchantPage = (path: string) => (merchantId: string) => `/merchant/${merchantId}${path}`;

export const NAV: NavSection[] = [
  { label: null, items: [{ key: "home", label: "Home", icon: Home, href: merchantPage("") }] },
  {
    label: "Agentic Dashboard",
    items: [
      { key: "cases", label: "Cases", icon: Inbox, href: merchantPage("/cases"), badge: "needs_you" },
      { key: "ask", label: "Ask Agentic Dashboard", icon: Sparkles, href: merchantPage("/ask") },
      { key: "dashboard", label: "My dashboard", icon: LayoutDashboard, href: merchantPage("/dashboard") },
      { key: "rules", label: "Rules", icon: ListChecks, href: merchantPage("/rules") },
      { key: "dues", label: "Dues & Liquidity", icon: CalendarClock, href: merchantPage("/dues") },
    ],
  },
  { label: "Channels", items: [{ key: "whatsapp", label: "RAY on WhatsApp", icon: MessageCircle, href: merchantPage("/whatsapp") }] },
  {
    label: "See it from the other side",
    items: [
      { key: "customer", label: "Customer inbox", icon: Mail, href: () => "/sim/inbox", simulated: true },
      { key: "buyer", label: "Buyer inbox", icon: Building2, href: () => "/sim/buyers", simulated: true },
      { key: "store", label: "Store admin", icon: Store, href: () => "/sim/store", simulated: true },
    ],
  },
];

// Pages that exist but are not in the nav (they are reached from Home and the
// cases): they keep the nav item of the section they belong to.
const SECTION_OF: [prefix: string, key: string][] = [
  ["/cases", "cases"],
  ["/collect", "cases"],
  ["/alerts", "cases"],
  ["/digest", "whatsapp"],
  ["/ask", "ask"],
  ["/dashboard", "dashboard"],
  ["/rules", "rules"],
  ["/dues", "dues"],
  ["/playbook", "rules"],
  ["/whatsapp", "whatsapp"],
];
const SIM_KEY: [prefix: string, key: string][] = [
  ["/sim/inbox", "customer"],
  ["/sim/calls", "customer"],
  ["/sim/international", "customer"],
  ["/sim/buyers", "buyer"],
  ["/sim/store", "store"],
];

// Which nav item is selected for this path.
export function activeKey(path: string): string | null {
  const sim = SIM_KEY.find(([p]) => path.startsWith(p));
  if (sim) return sim[1];
  const m = path.match(/^\/merchant\/[^/]+(\/.*)?$/);
  if (!m) return null;
  const rest = m[1] ?? "";
  if (rest === "" || rest === "/") return "home";
  return SECTION_OF.find(([p]) => rest.startsWith(p))?.[1] ?? null;
}

export const merchantIdFromPath = (path: string) => path.match(/^\/merchant\/([^/]+)/)?.[1] ?? null;

export const ACCOUNT_COOKIE = "ray_account";
export const DEFAULT_ACCOUNT = "m_leafy_bakes";
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

// The shell (docs/ui-rebuild.md section 1): the black top bar, the white left
// nav in the order the spec gives, the account switcher defaulting to Leafy
// Bakes, the Prototype tag, and Demo controls as a button, not a page.
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ViewProvider } from "../view";
import { activeKey, merchantIdFromPath } from "./nav";
import { Shell } from "./shell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/merchant/m_leafy_bakes/cases",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const merchants = [
  { id: "m_leafy_bakes", name: "Leafy Bakes", needsYou: 4 },
  { id: "m_notenest", name: "NoteNest", needsYou: 0 },
];
const html = renderToStaticMarkup(
  <ViewProvider initial="desktop">
    <Shell merchants={merchants} defaultMerchantId="m_leafy_bakes">
      <p>page</p>
    </Shell>
  </ViewProvider>,
);
const text = html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("the shell", () => {
  it("has the top bar tabs, search, RAY button, Prototype tag and the account", () => {
    for (const label of ["Razorpay Home", "Payments", "Agentic Dashboard", "Banking+", "Prototype", "Leafy Bakes", "Phone", "Desktop"]) expect(text).toContain(label);
    expect(html).toContain('aria-label="Ask Agentic Dashboard"');
    expect(html).toContain('href="/merchant/m_leafy_bakes/payments"');
    expect(html).toContain('href="/merchant/m_leafy_bakes/banking"');
    expect(html).toMatch(/aria-current="page"[^>]*>Agentic Dashboard/);
  });

  it("lists the nav exactly as the spec does, with the count on Cases and Simulated on the other side", () => {
    expect(html).toContain("Dues &amp; Liquidity");
    const order = ["Home", "Agentic Dashboard", "Cases", "Ask Agentic Dashboard", "My dashboard", "Rules", "Dues", "Channels", "RAY on WhatsApp", "See it from the other side", "Customer inbox", "Buyer inbox", "Store admin", "Demo controls"];
    let at = text.indexOf("Home");
    for (const label of order.slice(1)) {
      const next = text.indexOf(label, at + 1);
      expect(next, label).toBeGreaterThan(at);
      at = next;
    }
    expect(html).toMatch(/Cases<\/span><span class="nav-badge"[^>]*>4</);
    expect(html.match(/class="nav-sim">Simulated/g)?.length).toBe(4); // three inboxes and Demo controls
    expect(html).toContain('aria-current="page"'); // Cases is selected
  });

  it("opens Demo controls from a button, and never links to /dev", () => {
    expect(html).toMatch(/<button[^>]*class="nav-item"[^>]*>.*Demo controls/);
    expect(html).not.toMatch(/href="\/dev(["/?#])/);
  });

  it("points the nav at the saved account", () => {
    expect(html).toContain('href="/merchant/m_leafy_bakes/cases"');
    expect(html).toContain('href="/sim/inbox"');
  });
});

describe("which nav item is selected", () => {
  it("follows the page", () => {
    expect(activeKey("/merchant/m_leafy_bakes")).toBe("home");
    expect(activeKey("/merchant/m_leafy_bakes/cases/case_x")).toBe("cases");
    expect(activeKey("/merchant/m_leafy_bakes/collect")).toBe("cases");
    expect(activeKey("/merchant/m_leafy_bakes/playbook")).toBe("rules");
    expect(activeKey("/merchant/m_leafy_bakes/whatsapp")).toBe("whatsapp");
    expect(activeKey("/sim/buyers")).toBe("buyer");
    expect(activeKey("/sim/calls")).toBe("customer");
    expect(merchantIdFromPath("/merchant/m_notenest/cases")).toBe("m_notenest");
    expect(merchantIdFromPath("/sim/store")).toBeNull();
  });
});

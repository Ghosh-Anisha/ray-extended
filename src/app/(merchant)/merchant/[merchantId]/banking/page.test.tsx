import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../merchant", () => ({ merchantParam: async () => ({ a: {}, merchantId: "m_leafy_bakes" }) }));
vi.mock("@/flows/collect/morning", () => ({ morningList: () => ({ rows: [{ buyerId: "buyer_demo" }] }) }));
vi.mock("@/db/repository", () => ({ createRepository: () => ({ merchants: { get: () => ({ name: "Leafy Bakes", banking_plus: true }) } }) }));
vi.mock("@/surfaces/views", () => ({ merchantView: () => ({ killSwitch: null }) }));
vi.mock("@/ui/merchant/page-shell", () => ({ PageShell: ({ children }: { children: ReactNode }) => createElement("main", null, children) }));
vi.mock("@/ui/shell/breadcrumbs", () => ({ Breadcrumbs: () => null }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: ReactNode }) => createElement("a", { href, ...props }, children) }));

import BankingPage from "./page";

describe("Banking+ Collect entry point", () => {
  it("opens the same merchant Collect workflow from the Banking+ action", async () => {
    const page = await BankingPage({ params: Promise.resolve({ merchantId: "m_leafy_bakes" }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain("Start Collect workflow");
    expect(html).toContain('href="/merchant/m_leafy_bakes/collect"');
    expect(html).toContain("No bank, payout, lending or bill-pay integration is connected");
  });
});

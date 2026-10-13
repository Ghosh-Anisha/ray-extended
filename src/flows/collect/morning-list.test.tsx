// Done when: PackRight's morning list renders with priorities, in both
// views; a non-Banking+ merchant sees the read-only view only. No screen
// shows a banned word or an em dash.
import { BladeProvider } from "@razorpay/blade/components";
import { bladeTheme } from "@razorpay/blade/tokens";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bannedWordsIn, hasEmDash } from "@/ai/grounding";
import { caseView } from "@/surfaces/views";
import { ApprovalCard } from "@/ui/merchant/approval-card";
import { CasePage } from "@/ui/merchant/case-page";
import { ViewProvider, type View } from "@/ui/view";
import { morningList } from "./morning";
import { MorningListView } from "./morning-list";
import { BUYERS, collectWorld, PR, type CollectWorld } from "./test-helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {} }),
  usePathname: () => "/merchant/m_packright/collect",
  useServerInsertedHTML: () => {},
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const render = (view: View, node: ReactNode) =>
  renderToStaticMarkup(
    <BladeProvider themeTokens={bladeTheme} colorScheme="light">
      <ViewProvider initial={view}>{node}</ViewProvider>
    </BladeProvider>,
  );
const textOf = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

let w: CollectWorld;
beforeEach(() => {
  w = collectWorld();
});
afterEach(() => w.close());

describe("the morning list", () => {
  it("renders PackRight's buyers with priorities, highest first, in both views", async () => {
    await w.morning();
    const list = morningList(w.a, PR);
    for (const view of ["desktop", "phone"] as const) {
      const text = textOf(render(view, <MorningListView list={list} />));
      expect(text).toContain("Invoice overdue · 12 Oct");
      expect(text).toContain("highest priority first");
      expect(text).toContain("Review each buyer’s amount and message before running Collect");
      expect(text).toContain("Run Collect for this buyer");
      expect(text).toContain("Preview channel: Email");
      expect(text).toContain("Open case activity and approvals");
      expect(text).toContain("Simulated");
      expect(text).toContain("Needs you");
      // Rows in priority order.
      const at = list.rows.map((r) => text.indexOf(r.buyer));
      expect(at.every((x) => x >= 0)).toBe(true);
      expect([...at].sort((x, y) => x - y)).toEqual(at);
      expect(bannedWordsIn(text)).toEqual([]);
      expect(hasEmDash(text)).toBe(false);
    }
    const desktop = textOf(render("desktop", <MorningListView list={list} />));
    expect(desktop).toContain("Priority");
    expect(desktop).toContain(list.rows[0].priority.toLocaleString("en-IN"));
    expect(desktop).toContain("Key account");
    expect(desktop).toContain("Log note");
  });

  it("a non-Banking+ merchant sees the read-only view only, with the Banking+ offer", () => {
    w.repo.merchants.update(PR, { banking_plus: false });
    const text = textOf(render("desktop", <MorningListView list={morningList(w.a, PR)} />));
    expect(text).toContain("Let RAY chase these for you");
    expect(text).toContain("Read only");
    expect(text).not.toContain("Run Collect for this buyer");
    expect(text).not.toContain("Log note");
    expect(text).not.toContain("Needs you");
  });

  it("a Collect case shows on the case page: the buyer, Invoice overdue, one question and the tap", async () => {
    await w.morning();
    const kase = w.caseOf(BUYERS.mehra)!;
    const v = caseView(w.a, kase.id);
    expect(v).toMatchObject({ name: "Mehra Snacks Pvt Ltd", moment: "Invoice overdue", amount: "₹1.1 lakh", state: { label: "Needs you" } });
    expect(v.yourCall.question).toBe(w.ask(kase.id));
    expect(v.yourCall.primary).toMatchObject({ label: "Send firm reminder", covered: false });
    const text = textOf(render("desktop", <CasePage v={v} />));
    expect(text).toContain("Send firm reminder");
    expect(text).toContain("Your call");
    const caseHtml = render("desktop", <CasePage v={v} />);
    expect(caseHtml).toContain(`href="/merchant/${PR}/collect?buyerId=${BUYERS.mehra}"`);
    expect(caseHtml).toContain(`href="/merchant/${PR}/banking"`);
    expect(bannedWordsIn(text)).toEqual([]);
  });

  it("the WhatsApp approval card lists what the same tap also covers", async () => {
    await w.morning();
    const v = caseView(w.a, w.caseOf(BUYERS.mehra)!.id);
    const text = textOf(render("phone", <ApprovalCard card={v.card!} merchantId={PR} />));
    expect(text).toContain("Also on this tap: WhatsApp the firm reminder for PR/26-27/2404 to +919800000304");
    expect(textOf(render("desktop", <CasePage v={v} />))).toContain("Also on this tap: WhatsApp the firm reminder for PR/26-27/2414 to +919800000304");
  });
});

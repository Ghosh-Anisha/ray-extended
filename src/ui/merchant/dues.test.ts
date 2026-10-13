import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { duesExampleSummary, InvoiceInbox, liquidityScenario } from "./dues";

describe("simulated dues arithmetic", () => {
  it("keeps November rent out of October and reconciles the remaining cash", () => {
    const october = duesExampleSummary(Date.parse("2026-10-13T10:00:00+05:30"));
    expect(october).toEqual({ openingCash: 4_200_000, dueThisMonth: 2_820_000, afterThisMonth: 1_380_000, dueLater: 2_800_000, afterAllListed: -1_420_000 });
  });

  it("uses a different due total for November", () => {
    const november = duesExampleSummary(Date.parse("2026-11-13T10:00:00+05:30"));
    expect(november).toEqual({ openingCash: 4_200_000, dueThisMonth: 2_800_000, afterThisMonth: 1_400_000, dueLater: 0, afterAllListed: 1_400_000 });
  });

  it("combines only listed incoming requests and outgoing obligations in a visibly signed scenario", async () => {
    const scenario = liquidityScenario(Date.parse("2026-10-13T10:00:00+05:30"), 3_500_000);
    expect(scenario).toMatchObject({ openingCash: 4_200_000, collectIncomingMinor: 3_500_000, dueThisMonth: 2_820_000, dueLater: 2_800_000, scenario: 2_080_000 });
    const { Dues } = await import("./dues");
    const html = renderToStaticMarkup(createElement(Dues, { merchantId: "m_leafy_bakes", now: Date.parse("2026-10-13T10:00:00+05:30"), collectRequests: [{ buyer: "Buyer A", overdue: "₹35,000", overdueMinor: 3_500_000, stage: "Gentle reminder", state: "Needs you", promise: "20 Oct", caseId: "case_demo" }] }));
    expect(html).toContain("Simulated liquidity scenario");
    expect(html).toContain("+₹35,000");
    expect(html).toContain("₹20,800");
    expect(html).toContain("Collection and payment statuses are unverified");
    expect(html).toContain("Open Collect workflow");
    expect(html).toContain("Open case &amp; message preview");
    expect(html).toContain("href=\"/merchant/m_leafy_bakes/cases/case_demo\"");
  });

  it("makes invoice review controls disclose only the seeded evidence and its limits", async () => {
    const html = renderToStaticMarkup(createElement(InvoiceInbox));
    expect(html).toContain("<details");
    expect(html).toContain("Review duplicate flag");
    expect(html).toContain("INV-881 and the source email are not loaded");
    expect(html).toContain("Review bank-change hold");
    expect(html).toContain("No previously verified contact or independent bank record is connected");
    expect(html).toContain("Review invoice limits");
    expect(html).toContain("No BBPS or supplier-payment action is configured");
    expect(html).toContain("disabled=\"\" aria-disabled=\"true\"");
    expect(html).not.toContain("2.4×");
    const { Dues } = await import("./dues");
    const dues = renderToStaticMarkup(createElement(Dues, { merchantId: "m_leafy_bakes", now: Date.parse("2026-10-13T10:00:00+05:30") }));
    expect(dues).toContain("₹28,200");
    expect(dues).toContain("₹13,800");
    expect(dues).toContain("−₹14,200");
    expect(dues).not.toContain("₹14,200 short");
    expect(dues).toContain("DEMO-BBPS-117");
    expect(dues).toContain("INV-884");
    expect(dues).toContain("Excluded from October running balance");
    expect(dues).toContain("Collect requests");
    expect(dues).toContain("Dues &amp; Liquidity");
  });
});

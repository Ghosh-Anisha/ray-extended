import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { duesExampleSummary, InvoiceInbox } from "./dues";

describe("simulated dues arithmetic", () => {
  it("keeps November rent out of October and reconciles the remaining cash", () => {
    const october = duesExampleSummary(Date.parse("2026-10-13T10:00:00+05:30"));
    expect(october).toEqual({ openingCash: 4_200_000, dueThisMonth: 2_820_000, afterThisMonth: 1_380_000 });
  });

  it("uses a different due total for November", () => {
    const november = duesExampleSummary(Date.parse("2026-11-13T10:00:00+05:30"));
    expect(november).toEqual({ openingCash: 4_200_000, dueThisMonth: 2_800_000, afterThisMonth: 1_400_000 });
  });

  it("makes invoice review controls disclose only the seeded evidence and its limits", () => {
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
  });
});

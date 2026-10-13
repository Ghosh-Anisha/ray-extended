// My dashboard and the Grow cards (docs/ui-rebuild.md 3.6, 11, 12): numbers
// come from rows, choices persist, the watch finds the card dip and links to
// a real case.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createAdapters } from "@/adapters";
import { fakeClock } from "@/adapters/clock";
import { bannedWordsIn, hasEmDash } from "@/ai/grounding";
import { openMigratedDb } from "@/db/client";
import { DEMO_NOW } from "@/db/seed";
import { seedDemo } from "@/db/seed/demo";
import { merchantStats } from "./stats";
import { dashboardAction } from "./dashboard-actions";
import { buildReport, dashboardView, parseReportRequest, parseWidgetAsk, setupWidgets, watchedWidgetPreviews } from "./dashboard";
import { chaseCard, emiCard, setEmi } from "./grow";
import { Home } from "@/ui/home/home";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const M = "m_leafy_bakes";
const DAY = 86_400_000;

let db: ReturnType<typeof openMigratedDb>;
let clock: ReturnType<typeof fakeClock>;
let a: ReturnType<typeof createAdapters>;
beforeAll(async () => {
  db = openMigratedDb(":memory:");
  await seedDemo(db);
  clock = fakeClock(DEMO_NOW);
  a = createAdapters(db, clock, { RAZORPAY_MODE: "mock" });
});
afterAll(() => db.$client.close());

describe("My dashboard", () => {
  it("starts with the three questions, pre-selected from the data", () => {
    const v = dashboardView(a, M);
    expect(v.setup).toBeNull();
    expect(v.suggested.daily).toEqual(["Sales today", "Refunds and disputes", "Overdue invoices"]);
  });

  it("builds a starter dashboard whose numbers match Home", () => {
    dashboardAction(a, { action: "setup", merchantId: M, ...dashboardView(a, M).suggested, request: "Show today's sales and refunds by product" });
    const v = dashboardView(a, M);
    expect(v.setup?.request).toBe("Show today's sales and refunds by product");
    const by = Object.fromEntries(v.widgets.map((w) => [w.kind, w.data]));
    expect(v.widgets).toHaveLength(9);
    expect(v.widgets.map((w) => w.kind)).toContain("refunds_by_product");
    expect(by.saved.value).toBe("₹1,84,300");
    expect(by.success_rate.value).toBe("94.2%");
    expect(by.needs_you.value).toBe("4");
    expect(by.overdue.value).toBe("₹6,10,000");
    expect(v.widgets.every((w) => w.definition.length > 0)).toBe(true);
  });

  it("adds supported widgets requested in natural language to the saved setup", () => {
    const setup = { ...dashboardView(a, M).suggested, request: "Show today's sales, refunds by product, and cases that need my attention" };
    const widgets = setupWidgets(setup);
    expect(widgets.map((w) => w.kind)).toEqual(expect.arrayContaining(["sales_today", "refunds_by_product", "needs_you"]));
    dashboardAction(a, { action: "setup", merchantId: M, ...setup });
    expect(dashboardView(a, M).widgets.map((w) => w.kind)).toEqual(expect.arrayContaining(["refunds_by_product", "needs_you"]));
  });

  it("adds the supported widgets by phrase, says no to the rest, and removes", () => {
    expect(parseWidgetAsk("show refunds by product")).toBe("refunds_by_product");
    expect(parseWidgetAsk("show success rate by bank")).toBe("success_by_bank");
    expect(parseWidgetAsk("show sales today")).toBe("sales_today");
    expect(parseWidgetAsk("Add overdue invoices")).toBe("overdue");
    expect(parseWidgetAsk("show revenue by channel")).toBeNull();
    expect(parseWidgetAsk("show sales for the last 90 days")).toBeNull();
    const unsupported = dashboardAction(a, { action: "ask", merchantId: M, text: "show sales by payment channel" });
    expect(unsupported.message).toContain("show sales by payment channel");
    expect(unsupported.message).toContain("without changing its meaning");
    expect(unsupported.chips).toEqual(["Show refunds by product", "Show success rate by bank", "Add overdue invoices"]);
    dashboardAction(a, { action: "ask", merchantId: M, text: "show refunds by product" });
    expect(dashboardView(a, M).widgets.some((w) => w.kind === "refunds_by_product")).toBe(true);
    dashboardAction(a, { action: "remove", merchantId: M, id: "w_refunds_by_product" });
    expect(dashboardView(a, M).widgets.some((w) => w.kind === "refunds_by_product")).toBe(false);
  });

  it("suggests pinning success rate, and then watches it and finds the card dip", () => {
    const before = dashboardView(a, M);
    expect(before.suggestion?.text).toBe("You asked about success rate 4 times this week. Pin it?");
    expect(before.alerts).toHaveLength(0);
    dashboardAction(a, { action: "pin", merchantId: M, kind: "success_rate" });
    const after = dashboardView(a, M);
    expect(after.suggestion).toBeNull();
    expect(after.alerts).toHaveLength(1);
    expect(after.alerts[0].action?.href).toBe(`/merchant/${M}/cases/case_demo_oliver`);
    expect(after.alerts[0].why.rows.length).toBeGreaterThan(0);
  });

  it("keeps the layout across reads", () => {
    dashboardAction(a, { action: "keep", merchantId: M });
    expect(dashboardView(a, M).kept).toBe(true);
  });

  it("builds, persists, and synchronizes requested watched metrics to Home across fresh reads", () => {
    const request = "Show today's sales, refunds by product, cases that need my attention, lifetime value by channel";
    const result = dashboardAction(a, { action: "setup", merchantId: M, business: "Online store", daily: ["Sales today"], audience: "Me", request });
    expect(result.message).toMatch(/Dashboard saved with .*available on My dashboard and Home/);
    expect(result.chips).toContain("Show refunds by product");

    // A separate read models navigation or refresh from the database.
    const refreshed = dashboardView(a, M);
    expect(refreshed.setup?.request).toBe(request);
    expect(refreshed.kept).toBe(true);
    expect(refreshed.unsupportedRequests).toEqual(["lifetime value by channel"]);
    expect(refreshed.widgets.filter((w) => w.watch).map((w) => w.kind)).toEqual(expect.arrayContaining(["sales_today", "refunds_by_product", "needs_you"]));
    expect(watchedWidgetPreviews(refreshed.widgets).map((w) => w.title)).toEqual(expect.arrayContaining(["Today's sales", "Refunds by product", "Cases needing you"]));
    const renderHome = (dashboard: ReturnType<typeof dashboardView>) => renderToStaticMarkup(createElement(Home, {
      merchantId: M,
      merchantName: "Leafy Bakes",
      stats: merchantStats(a, M),
      card: null,
      topCase: null,
      extras: { emi: null, chase: null, rayOn: true, dashboardSet: true, dashboardWidgets: watchedWidgetPreviews(dashboard.widgets) },
    }));
    const homeBeforeChange = renderHome(refreshed);
    expect(homeBeforeChange).toContain("Your watched metrics");
    expect(homeBeforeChange).toContain("Refunds by product");
    expect(homeBeforeChange).toContain("Demo case outcomes this month");

    dashboardAction(a, { action: "watch", merchantId: M, id: "w_refunds_by_product", watch: false });
    dashboardAction(a, { action: "watch", merchantId: M, id: "w_saved", watch: true });
    const updated = dashboardView(a, M);
    expect(updated.widgets.find((w) => w.id === "w_refunds_by_product")?.watch).toBe(false);
    expect(updated.widgets.find((w) => w.id === "w_saved")?.watch).toBe(true);
    expect(watchedWidgetPreviews(updated.widgets).map((w) => w.title)).not.toContain("Refunds by product");
    expect(watchedWidgetPreviews(updated.widgets).map((w) => w.title)).toContain("Demo amount marked saved");
    const homeAfterChange = renderHome(updated);
    expect(homeAfterChange).not.toContain("Refunds by product");
    expect(homeAfterChange).toContain("Demo amount marked saved");

    dashboardAction(a, { action: "remove", merchantId: M, id: "w_needs_you" });
    const removed = dashboardView(a, M);
    expect(removed.widgets.some((w) => w.id === "w_needs_you")).toBe(false);
    expect(watchedWidgetPreviews(removed.widgets).map((w) => w.title)).not.toContain("Cases needing you");
  });
});

describe("Reports in words", () => {
  it("accepts only the supported report shapes without silently changing the measure", () => {
    expect(parseReportRequest("Settlements for September with fees and GST")).toEqual({ kind: "collections", monthIndex: 8 });
    expect(parseReportRequest("Refunds for September")).toEqual({ kind: "refunds", monthIndex: 8 });
    expect(parseReportRequest("Disputes this month")).toEqual({ kind: "disputes", monthIndex: null });
    expect(parseReportRequest("Fees for last 90 days")).toBeNull();
    expect(parseReportRequest("Refunds by product for September")).toBeNull();
    expect(parseReportRequest("GST rates in India")).toBeNull();
    const unsupported = dashboardAction(a, { action: "report", merchantId: M, text: "Fees for last 90 days" });
    expect(unsupported.message).toContain("Fees for last 90 days");
    expect(unsupported.chips).toContain("Estimated net collections for September with fees and GST");
  });

  it("labels the September report as an estimate and reconciles displayed rounded rows", () => {
    const r = buildReport(a, M, "Estimated net collections for September with fees and GST")!;
    expect(r.summary).toHaveLength(3);
    expect(r.total[1]).toBe(String(r.rows.reduce((n, row) => n + Number(row[1]), 0)));
    expect(r.summary[0]).toContain("16 captured payments");
    expect(r.title).toContain("Estimated net collections");
    expect(r.summary.join(" ")).toContain("not a settlement or bank-credit report");
    for (const row of [...r.rows, r.total]) {
      const [gross, fee, gst, net] = row.slice(2).map((v) => Number(v.replace(/[^\d-]/g, "")));
      expect(gross - fee - gst).toBe(net);
    }
  });

  it("saves report and CA-pack previews without implying a recipient or recurring delivery", () => {
    const one = dashboardAction(a, { action: "save_preview", merchantId: M, what: "report", text: "Refunds for September" });
    const pack = dashboardAction(a, { action: "save_preview", merchantId: M, what: "pack" });
    expect(one.savedPreview).toMatchObject({ title: "Refunds for September 2026", status: "preview_only" });
    expect(one.savedPreview).not.toHaveProperty("to");
    expect(one.message).toContain("No recipient, recurring schedule or delivery is configured");
    expect(pack.savedPreview?.title).toContain("September 2026");
    expect(dashboardView(a, M).savedPreviews).toHaveLength(2);
  });

  it("uses no banned words and no em dashes in what it writes", () => {
    const v = dashboardView(a, M);
    const text = JSON.stringify([v.pack, v.alerts, v.widgets.map((w) => [w.title, w.definition, w.data])]);
    expect(bannedWordsIn(text)).toEqual([]);
    expect(hasEmDash(text)).toBe(false);
  });
});

describe("Grow lane 1 and the invoice card", () => {
  it("offers Cardless EMI with an estimate from the unpaid big carts", () => {
    const c = emiCard(a, M);
    expect(c?.phase).toBe("offer");
    if (c?.phase === "offer") {
      expect(c.dropped).toBe(6);
      expect(c.carts).toBe(8);
      expect(c.estimate).toMatch(/^₹/);
      expect(c.tradeOff).toContain("eligibility and pricing are not connected");
      expect(c.assumption).toContain("not a promise");
    }
  });

  it("offers to take over invoice chasing, from the overdue invoices", () => {
    expect(chaseCard(a, M)?.line).toContain("₹6,10,000");
    expect(chaseCard(a, M)?.line).toContain("seeded demo");
    expect(chaseCard(a, M)?.line).toContain("no live bank feed");
  });

  it("shows the result card two weeks after Turn on", () => {
    setEmi(a, M, "on");
    expect(emiCard(a, M)?.phase).toBe("on");
    clock.advance(14 * DAY);
    const r = emiCard(a, M);
    expect(r?.phase).toBe("result");
    if (r?.phase === "result") expect(r.after.dropped).toBeLessThan(r.before.dropped);
    if (r?.phase === "result") expect(r.line).toContain("not measured growth");
  });

});

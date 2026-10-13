// My dashboard and the Grow cards (docs/ui-rebuild.md 3.6, 11, 12): numbers
// come from rows, choices persist, the watch finds the card dip and links to
// a real case.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdapters } from "@/adapters";
import { fakeClock } from "@/adapters/clock";
import { bannedWordsIn, hasEmDash } from "@/ai/grounding";
import { openMigratedDb } from "@/db/client";
import { DEMO_NOW } from "@/db/seed";
import { seedDemo } from "@/db/seed/demo";
import { dashboardAction } from "./dashboard-actions";
import { buildReport, dashboardView, parseWidgetAsk } from "./dashboard";
import { chaseCard, emiCard, setEmi } from "./grow";

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
    dashboardAction(a, { action: "setup", merchantId: M, ...dashboardView(a, M).suggested });
    const v = dashboardView(a, M);
    const by = Object.fromEntries(v.widgets.map((w) => [w.kind, w.data]));
    expect(v.widgets).toHaveLength(8);
    expect(by.saved.value).toBe("₹1,84,300");
    expect(by.success_rate.value).toBe("94.2%");
    expect(by.needs_you.value).toBe("4");
    expect(by.overdue.value).toBe("₹6,10,000");
    expect(v.widgets.every((w) => w.definition.length > 0)).toBe(true);
  });

  it("adds the supported widgets by phrase, says no to the rest, and removes", () => {
    expect(parseWidgetAsk("show refunds by product")).toBe("refunds_by_product");
    expect(parseWidgetAsk("show success rate by bank")).toBe("success_by_bank");
    expect(dashboardAction(a, { action: "ask", merchantId: M, text: "predict my lottery numbers" }).chips).toHaveLength(3);
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
});

describe("Reports in words", () => {
  it("builds the September settlements with a 3-line summary that matches the table", () => {
    const r = buildReport(a, M, "Settlements for September with fees and GST")!;
    expect(r.summary).toHaveLength(3);
    expect(r.total[1]).toBe(String(r.rows.reduce((n, row) => n + Number(row[1]), 0)));
    expect(r.summary[0]).toContain("16 payments");
  });

  it("schedules the report and the month-end pack as Simulated records", () => {
    const one = dashboardAction(a, { action: "schedule", merchantId: M, what: "report", text: "Refunds for September" });
    const pack = dashboardAction(a, { action: "schedule", merchantId: M, what: "pack" });
    expect(one.scheduled?.to).toBe("your CA on WhatsApp");
    expect(pack.scheduled?.title).toContain("September 2026");
    expect(dashboardView(a, M).schedules).toHaveLength(2);
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
      expect(c.tradeOff.length).toBeGreaterThan(0);
    }
  });

  it("offers to take over invoice chasing, from the overdue invoices", () => {
    expect(chaseCard(a, M)?.line).toContain("₹6,10,000");
  });

  it("shows the result card two weeks after Turn on", () => {
    setEmi(a, M, "on");
    expect(emiCard(a, M)?.phase).toBe("on");
    clock.advance(14 * DAY);
    const r = emiCard(a, M);
    expect(r?.phase).toBe("result");
    if (r?.phase === "result") expect(r.after.dropped).toBeLessThan(r.before.dropped);
  });
});

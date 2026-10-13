// Screenshots of every screen at 1440x900 and 390x844, and how long each takes
// to load (docs/ui-rebuild.md section 9). Start the app first with
// `npm run demo`, then: npx tsx scripts/screenshots.ts u1
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const phase = process.argv[2] ?? "u1";
const base = process.env.BASE_URL ?? "http://localhost:3000";
const out = path.join(process.cwd(), "docs", "screenshots", phase);
const LEAFY = "/merchant/m_leafy_bakes";
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const state = (await (await fetch(`${base}/api/demo/state`)).json()) as { cases: Record<string, string> };
  const pages: { name: string; url: string; after?: (p: import("playwright").Page) => Promise<void> }[] = [
    { name: "home", url: LEAFY },
    { name: "cases", url: `${LEAFY}/cases` },
    { name: "case-priya", url: `${LEAFY}/cases/${state.cases["RD-1042"]}` },
    { name: "case-neha-chargeback", url: `${LEAFY}/cases/${state.cases["RD-1051"]}` },
    { name: "case-karan-subscription", url: `${LEAFY}/cases/${state.cases["RD-1060"]}` },
    { name: "case-acme-invoice", url: `${LEAFY}/cases/${state.cases["RD-1052"]}` },
    { name: "ask-ray", url: `${LEAFY}/ask` },
    { name: "my-dashboard", url: `${LEAFY}/dashboard` },
    { name: "rules", url: `${LEAFY}/rules` },
    { name: "whatsapp", url: `${LEAFY}/whatsapp` },
    { name: "alerts", url: `${LEAFY}/alerts` },
    { name: "digest", url: `${LEAFY}/digest` },
    { name: "invoices-overdue", url: `${LEAFY}/collect` },
    { name: "customer-inbox", url: "/sim/inbox" },
    { name: "buyer-inbox", url: "/sim/buyers" },
    { name: "store-admin", url: "/sim/store" },
    { name: "calls", url: "/sim/calls" },
    { name: "checkout-abroad", url: "/sim/international" },
    { name: "demo-controls", url: `${LEAFY}?controls=1` },
  ];
  const browser = await chromium.launch();
  const timings: Record<string, Record<string, { ttfb: number; domReady: number; loaded: number; ms: number }>> = {};
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    for (const p of pages) {
      const started = Date.now();
      await page.goto(base + p.url, { waitUntil: "load" });
      // Interactive: the shell has hydrated when the account menu opens.
      await page.waitForSelector(".shell-top");
      const ms = Date.now() - started;
      const nav = await page.evaluate(() => {
        const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        return { ttfb: Math.round(e.responseStart), domReady: Math.round(e.domContentLoadedEventEnd), loaded: Math.round(e.loadEventEnd) };
      });
      (timings[p.name] ??= {})[vp.name] = { ...nav, ms };
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out, `${vp.name}-${p.name}.png`), fullPage: false });
    }
    if (vp.name === "phone") {
      // The nav slides in from the left on a phone.
      await page.goto(base + LEAFY, { waitUntil: "load" });
      await page.click(".shell-burger");
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(out, "phone-nav-open.png") });
    }
    if (errors.length) console.log(`${vp.name}: console errors\n  ${[...new Set(errors)].join("\n  ")}`);
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(out, "timings.json"), JSON.stringify(timings, null, 2));
  console.log("page".padEnd(26) + "desktop (ttfb / loaded)".padEnd(26) + "phone (ttfb / loaded)");
  for (const [name, t] of Object.entries(timings)) console.log(name.padEnd(26) + `${t.desktop.ttfb} / ${t.desktop.loaded} ms`.padEnd(26) + `${t.phone.ttfb} / ${t.phone.loaded} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

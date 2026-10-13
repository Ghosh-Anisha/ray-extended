// U6 screenshots: Home's new sections, the coach marks, My dashboard from the
// three questions to the CA pack. Start the app first (port 3002), then:
// BASE_URL=http://localhost:3002 npx tsx scripts/screenshots-u6.ts
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3002";
const out = path.join(process.cwd(), "docs", "screenshots", "u6");
const L = "/merchant/m_leafy_bakes";
fs.mkdirSync(out, { recursive: true });

async function run(vp: { name: string; width: number; height: number }) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  const shot = async (name: string, full = false) => page.screenshot({ path: path.join(out, `${vp.name}-${name}.png`), fullPage: full });
  const go = async (url: string) => {
    await page.goto(base + url, { waitUntil: "load" });
    await page.waitForTimeout(1800);
  };
  const dismiss = async (p: Page) => {
    for (let i = 0; i < 6; i++) {
      const b = p.locator(".coach .btn.primary");
      if (!(await b.count())) break;
      await b.first().click();
      await p.waitForTimeout(150);
    }
  };

  await go(L);
  await shot("home-coach-1");
  await dismiss(page);
  await shot("home-full", true);
  await page.locator(".suggest").first().scrollIntoViewIfNeeded();
  await shot("home-suggestions");
  await page.getByRole("button", { name: "Turn on Cardless EMI" }).click();
  await page.waitForTimeout(1200);
  await shot("home-emi-on");

  await go(`${L}/cases?moment=paid_no_order&tour=paid_no_order`);
  await shot("tour-cases");
  await go(`${L}?tour=grow`);
  await shot("tour-grow");

  await go(`${L}/dashboard`);
  await shot("dashboard-setup-coach");
  await dismiss(page);
  await shot("dashboard-setup");
  await page.getByRole("button", { name: "Build my dashboard" }).click();
  await page.waitForTimeout(400);
  await shot("dashboard-building");
  await page.waitForTimeout(2500);
  await dismiss(page);
  await shot("dashboard-starter", true);
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /Why\?/ }).first().click();
  await shot("dashboard-watch-why");
  await page.getByPlaceholder("Try “show refunds by product”").fill("show refunds by product");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForTimeout(1200);
  await shot("dashboard-widget-added", true);
  await page.getByRole("button", { name: "Settlements for September with fees and GST" }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Schedule to CA on WhatsApp" }).first().click();
  await page.waitForTimeout(1200);
  await shot("dashboard-report", true);
  console.log(vp.name, "errors:", [...new Set(errors)].slice(0, 5));
  await browser.close();
}

(async () => {
  await run({ name: "desktop", width: 1440, height: 900 });
  await fetch(`${base}/api/demo/reset`, { method: "POST" });
  await run({ name: "phone", width: 390, height: 844 });
})();

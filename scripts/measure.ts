// How long a page takes to become interactive (React hydrated: the Demo
// controls button opens its drawer) and how much JavaScript it ships.
// Start the app first (npm run demo), then: npx tsx scripts/measure.ts
import { chromium } from "playwright";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const pages = ["/merchant/m_leafy_bakes", "/merchant/m_leafy_bakes/cases", "/merchant/m_leafy_bakes/rules", "/merchant/m_leafy_bakes/whatsapp", "/sim/inbox", "/sim/store"];

async function main() {
  const browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    for (const p of pages) {
      const page = await ctx.newPage();
      let js = 0;
      page.on("response", async (r) => {
        if (r.url().endsWith(".js") || r.headers()["content-type"]?.includes("javascript")) js += (await r.body().catch(() => Buffer.alloc(0))).length;
      });
      const t = Date.now();
      await page.goto(base + p, { waitUntil: "commit" });
      // Interactive: clicking works. Retry until the drawer opens.
      await page.waitForFunction(() => document.querySelector(".shell-top") !== null);
      let ms = 0;
      for (;;) {
        await page.evaluate(() => (document.querySelector(".nav-foot button") as HTMLButtonElement | null)?.click());
        if ((await page.locator(".drawer").count()) > 0) {
          ms = Date.now() - t;
          break;
        }
        await page.waitForTimeout(20);
        if (Date.now() - t > 10_000) throw new Error(`${p} never became interactive`);
      }
      console.log(`${String(width).padEnd(5)} ${p.padEnd(34)} interactive ${String(ms).padStart(5)} ms   JS ${(js / 1024).toFixed(0)} KB`);
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
}
main();

import { test } from "@playwright/test";

test("captures the ten guided-demo screens in desktop and phone views", async ({ page, request }) => {
  await request.post("/api/demo/reset");
  const state = await (await request.get("/api/demo/state")).json() as { merchantId: string; cases: Record<string, string> };
  const base = `/merchant/${state.merchantId}`;
  const urls = [
    `${base}?guided=1&step=1`,
    `${base}/cases?guided=1&step=2`,
    `${base}/cases/${state.cases["RD-1042"]}?guided=1&step=3`,
    `/sim/inbox?guided=1&step=4`,
    `${base}/whatsapp?guided=1&step=5`,
    `${base}/rules?guided=1&step=6`,
    `${base}/cases/${state.cases["RD-1051"]}?guided=1&step=7`,
    `${base}/cases/${state.cases["RD-1060"]}?guided=1&step=8`,
    `${base}/collect?guided=1&step=9`,
    `${base}/dashboard?guided=1&step=10`,
  ];
  for (let i = 0; i < urls.length; i += 1) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(urls[i]!);
    await page.locator("[role='dialog'][aria-label^='Step']").waitFor({ state: "visible" });
    await page.screenshot({ path: `docs/screenshots/u5/desktop-step-${i + 1}.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(urls[i]!);
    await page.locator("[role='dialog'][aria-label^='Step']").waitFor({ state: "visible" });
    await page.screenshot({ path: `docs/screenshots/u5/phone-step-${i + 1}.png`, fullPage: true });
  }
});

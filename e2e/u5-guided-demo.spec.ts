import { test, expect } from "@playwright/test";

test("walks the ten-step guided demo from Reset demo", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Demo controls" }).click();
  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.getByRole("status")).toContainText("Demo reset");
  await page.goto("/");

  await page.getByRole("link", { name: "Start guided demo" }).click();
  await expect(page).toHaveURL(/guided=1&step=1/);
  for (let step = 1; step <= 10; step += 1) {
    await expect(page.locator("[role='dialog'][aria-label^='Step']")).toContainText(`Step ${step} of 10`);
    if (step < 10) {
      const label = step === 4 ? "Skip to next morning" : step === 1 ? "Review cases" : step === 2 ? "Open Priya's case" : step === 3 ? "See what Priya received" : step === 5 ? "Open Ask RAY" : step === 6 ? "See chargebacks" : step === 7 ? "See subscriptions" : step === 8 ? "See the morning list" : "Open My dashboard";
      await page.getByRole("button", { name: label }).click();
    } else {
      await page.locator("[role='dialog'][aria-label^='Step 10']").getByRole("button", { name: "Finish" }).evaluate((el) => (el as HTMLButtonElement).click());
      await expect(page.getByRole("dialog", { name: "Guided demo complete" })).toContainText("That's RAY");
    }
  }
});

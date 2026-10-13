import { test, expect } from "@playwright/test";

test("walks the ten-step guided demo from Reset demo", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Demo controls" }).click();
  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.getByRole("status")).toContainText("Demo reset");
  await page.goto("/");

  await page.getByRole("link", { name: "Start guided demo" }).click();
  await expect(page).toHaveURL(/guided=1&step=1/);
  const targets = [
    "[data-guided='review-cases']",
    "[data-guided='case-priya']",
    "[data-guided='primary-action']",
    "[data-guided-customer='priya']",
    "[data-guided='approve-rahul']",
    "[data-coach='rules-chat']",
    "[data-guided='primary-action']",
    "[data-guided='primary-action']",
    "[data-guided='collect']",
    "[data-coach='dash-setup']",
  ];
  for (let step = 1; step <= 10; step += 1) {
    await expect(page.locator("[role='dialog'][aria-label^='Step']")).toContainText(`Step ${step} of 10`);
    await expect(page.locator(targets[step - 1]!)).toHaveCount(1);
    if (step < 10) {
      const label = step === 4 ? "Skip to next morning" : step === 1 ? "Review cases" : step === 2 ? "Open Priya's case" : step === 3 ? "Approve Mark paid & ship" : step === 5 ? "Approve Rahul's duplicate refund" : step === 6 ? "See chargebacks" : step === 7 ? "See subscriptions" : step === 8 ? "See the morning list" : "Open My dashboard";
      if (step === 2) await expect(page.getByRole("dialog", { name: /Step 2 of 10/ })).toContainText("Before Priya contacted Leafy");
      if (step === 3) await expect(page.getByRole("dialog", { name: /Step 3 of 10/ })).toContainText("two HTTP 200 webhook deliveries marked unprocessed");
      await page.getByRole("button", { name: label }).click();
      if (step === 3) {
        await expect(page.getByRole("dialog", { name: /Step 3 of 10/ })).toContainText("Merchant approval recorded");
        await page.getByRole("button", { name: "Continue" }).click();
      }
      if (step === 4) {
        await expect(page.getByRole("dialog", { name: /Step 4 of 10/ })).toContainText("mil gaya, thanks");
        await expect(page.getByRole("dialog", { name: /Step 4 of 10/ })).toContainText("Resolved");
        await expect(page.getByRole("dialog", { name: /Step 4 of 10/ })).toContainText("₹1,299");
        await expect(page.getByRole("dialog", { name: /Step 4 of 10/ })).toContainText("Simulated demo outcome verified");
        await page.getByRole("button", { name: "Continue" }).click();
      }
      if (step === 5) {
        await expect(page.locator("[data-guided='refund-hold']")).toBeVisible();
        await expect(page.getByRole("dialog", { name: /Step 5 of 10/ })).toContainText("10-minute Undo window");
        await page.getByRole("button", { name: "Continue" }).click();
      }
    } else {
      await page.locator("[role='dialog'][aria-label^='Step 10']").getByRole("button", { name: "Finish" }).evaluate((el) => (el as HTMLButtonElement).click());
      await expect(page.getByRole("dialog", { name: "Guided demo complete" })).toContainText("That's RAY");
    }
  }
});

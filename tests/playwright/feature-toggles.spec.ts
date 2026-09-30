import { expect, test } from "@playwright/test";
import { createBoard, expandToolPermissions } from "./helpers";

test("feature toggles changed in quick succession all save", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Settings toggles run in Chromium.");

  await createBoard(page, "Quick toggles");
  // Slow each save so later toggles are made while earlier ones are still in flight.
  await page.route("**/settings", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (response.request().method() === "PATCH" && response.url().endsWith("/settings")) {
      statuses.push(response.status());
    }
  });

  await expandToolPermissions(page);
  const settings = page.getByTestId("settings-drawer");
  const features = ["stamps", "text", "tables", "templates"];
  for (const feature of features) {
    await settings.locator(`input[data-feature='${feature}']`).uncheck();
  }

  await expect.poll(() => statuses.length, { timeout: 10_000 }).toBe(features.length);
  expect(statuses).toEqual(features.map(() => 200));
  for (const feature of features) {
    await expect(settings.locator(`input[data-feature='${feature}']`)).not.toBeChecked();
  }
});

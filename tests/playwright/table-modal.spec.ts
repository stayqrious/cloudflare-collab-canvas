import { expect, test } from "@playwright/test";
import { chooseMoreTool, createBoard } from "./helpers";

test("the table chooser is modal, cancellable, and returns to Select after placement", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused table interaction runs in Chromium.");

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await createBoard(page, "Modal table chooser");
  const tableTool = page.getByTestId("tool-table");
  const selectTool = page.getByTestId("tool-select");
  const picker = page.getByRole("dialog", { name: "Choose a table size" });

  await chooseMoreTool(page, "tool-table");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute("open", "");
  expect(await picker.evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
  await expect(picker.getByLabel("Table columns")).toBeFocused();
  await picker.getByRole("button", { name: "Cancel" }).click();
  await expect(picker).toBeHidden();
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");

  await chooseMoreTool(page, "tool-table");
  const choosePlacement = picker.getByRole("button", { name: "Choose placement" });
  await choosePlacement.focus();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");
  await expect(selectTool).toBeFocused();

  await chooseMoreTool(page, "tool-table");
  await picker.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  await expect(selectTool).toBeFocused();

  await chooseMoreTool(page, "tool-table");
  await picker.getByLabel("Table columns").selectOption("4");
  await picker.getByLabel("Table rows").selectOption("2");
  await choosePlacement.click();
  await expect(picker).toBeHidden();
  await expect(tableTool).toHaveAttribute("aria-pressed", "true");

  const canvas = page.locator("#board-canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Canvas has no layout bounds.");
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);

  const table = page.locator("#drawing-area .board-item-table");
  await expect(table).toHaveCount(1);
  await expect(table).toHaveAttribute("data-table-columns", "4");
  await expect(table).toHaveAttribute("data-table-rows", "2");
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tool-image").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("tool-eraser").locator("svg")).toHaveCount(1);
  expect(consoleErrors).toEqual([]);
});

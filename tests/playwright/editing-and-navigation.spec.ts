import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard } from "./helpers";

test("Escape saves text and sticky notes and leaves them selected", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Keyboard acceptance runs in Chromium.");

  await createBoard(page, "Escape to finish");
  const selectTool = page.getByTestId("tool-select");
  const selectionActions = page.getByTestId("selection-actions");
  const editor = page.getByTestId("canvas-text-editor");

  await page.getByRole("button", { name: /^Text/u }).click();
  const textPoint = await canvasPoint(page, 0.3, 0.3);
  await page.mouse.click(textPoint.x, textPoint.y);
  await editor.fill("Kept by Escape");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const text = page.locator("#drawing-area .board-item-text");
  await expect(text).toContainText("Kept by Escape");
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");
  await expect(selectionActions).toBeVisible();

  // A second Escape deselects and stays in Select mode.
  await page.keyboard.press("Escape");
  await expect(selectionActions).toBeHidden();
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("tool-sticky").click();
  const stickyPoint = await canvasPoint(page, 0.55, 0.45);
  await page.mouse.click(stickyPoint.x, stickyPoint.y);
  await editor.fill("Sticky");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  const sticky = page.locator("#drawing-area .board-item-sticky");
  await expect(sticky).toContainText("Sticky");
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");
  await expect(selectionActions).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  // Clicking empty space deselects and stays in Select mode.
  const empty = await canvasPoint(page, 0.85, 0.85);
  await page.mouse.click(empty.x, empty.y);
  await expect(selectionActions).toBeHidden();
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");
  await expect(sticky).toHaveCount(1);
  await expect(text).toHaveCount(1);
});

test("the wheel and two-finger scrolling pan, while zoom stays on the buttons", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Wheel acceptance runs in Chromium.");

  await createBoard(page, "Wheel scrolling");
  const canvas = page.locator("#board-canvas");
  const zoomLabel = page.locator("[data-zoom-label]");
  await expect(zoomLabel).toHaveText("100%");
  const center = await canvasPoint(page, 0.5, 0.5);
  await page.mouse.move(center.x, center.y);

  const before = await canvas.getAttribute("viewBox");
  await page.mouse.wheel(40, 120);
  await expect.poll(() => canvas.getAttribute("viewBox")).not.toBe(before);
  const [beforeX, beforeY] = (before ?? "").split(" ").map(Number);
  const [afterX, afterY] = ((await canvas.getAttribute("viewBox")) ?? "").split(" ").map(Number);
  expect((afterX ?? 0) - (beforeX ?? 0)).toBeCloseTo(40, 0);
  expect((afterY ?? 0) - (beforeY ?? 0)).toBeCloseTo(120, 0);
  await expect(zoomLabel).toHaveText("100%");

  // Ctrl + wheel (also sent by a trackpad pinch) still zooms.
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -200);
  await page.keyboard.up("Control");
  await expect(zoomLabel).not.toHaveText("100%");

  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(zoomLabel).toHaveText("100%");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomLabel).not.toHaveText("100%");
});

import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, drag, drawShape } from "./helpers";

test("Escape returns to Select, and Select pans from empty space", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Pointer acceptance runs in Chromium.");

  await createBoard(page, "Select panning");
  const selectTool = page.getByTestId("tool-select");

  await page.getByRole("button", { name: /^Pencil/u }).click();
  await expect(selectTool).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");

  const start = await canvasPoint(page, 0.3, 0.3);
  const shape = await drawShape(page, "Rectangle", start, { x: start.x + 80, y: start.y + 50 });
  await page.keyboard.press("Escape");
  await expect(selectTool).toHaveAttribute("aria-pressed", "true");

  // Select the shape, then drag empty space: the view pans and the selection is kept.
  const selectionActions = page.getByTestId("selection-actions");
  const before = await shape.boundingBox();
  if (!before) throw new Error("The shape has no layout bounds.");
  await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
  await expect(selectionActions).toBeVisible();
  const transform = await shape.getAttribute("transform");
  const empty = await canvasPoint(page, 0.7, 0.7);
  await drag(page, empty, { x: empty.x - 90, y: empty.y - 60 });
  await expect
    .poll(async () => {
      const after = await shape.boundingBox();
      return after ? [Math.round(after.x - before.x), Math.round(after.y - before.y)] : null;
    })
    .toEqual([-90, -60]);
  await expect(shape).toHaveAttribute("transform", transform ?? "");
  await expect(selectionActions).toBeVisible();

  // A tap on empty space still clears the selection.
  await page.mouse.click(empty.x, empty.y);
  await expect(selectionActions).toBeHidden();

  // Shift-drag on empty space draws a selection box.
  const moved = await shape.boundingBox();
  if (!moved) throw new Error("The shape has no layout bounds.");
  await drag(
    page,
    { x: moved.x - 20, y: moved.y - 20 },
    { x: moved.x + moved.width + 20, y: moved.y + moved.height + 20 },
    { shift: true },
  );
  await expect(selectionActions).toBeVisible();
  const afterMarquee = await shape.boundingBox();
  expect(afterMarquee && Math.round(afterMarquee.x - moved.x)).toBe(0);
});

import { expect, type Locator, type Page, test } from "@playwright/test";
import { chooseMoreTool, createBoard, waitForBoard } from "./helpers";

async function dragHandle(
  page: Page,
  handle: Locator,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await expect(handle).toBeAttached();
  const { x, y } = await handle.evaluate((group) => {
    const target = group.querySelector<SVGLineElement | SVGCircleElement>(
      ".selection-axis-resize-hit-target, .selection-resize-hit-target",
    );
    if (!target) throw new Error("Resize target is missing.");
    const point = target.ownerSVGElement?.createSVGPoint();
    const matrix = target.getScreenCTM();
    if (!point || !matrix) throw new Error("Resize target is not rendered.");
    if (target instanceof SVGLineElement) {
      point.x = (target.x1.baseVal.value + target.x2.baseVal.value) / 2;
      point.y = (target.y1.baseVal.value + target.y2.baseVal.value) / 2;
    } else {
      point.x = target.cx.baseVal.value;
      point.y = target.cy.baseVal.value;
    }
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
}

async function numericAttribute(locator: Locator, name: string): Promise<number> {
  const value = await locator.getAttribute(name);
  if (value === null || !Number.isFinite(Number(value))) {
    throw new Error(`${name} is not a numeric SVG attribute.`);
  }
  return Number(value);
}

test("tables and zones resize overall, with table row and column controls", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused structured resize QA runs in Chromium.");

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await createBoard(page, "Structured resize lab");
  await chooseMoreTool(page, "tool-table");
  const picker = page.getByRole("dialog", { name: "Choose a table size" });
  await picker.getByRole("button", { name: "Choose placement" }).click();

  const canvas = page.locator("#board-canvas");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas has no layout bounds.");
  await page.mouse.click(
    canvasBounds.x + canvasBounds.width * 0.4,
    canvasBounds.y + canvasBounds.height * 0.42,
  );

  const table = page.locator("#drawing-area .board-item-table");
  await expect(table).toHaveCount(1);
  await table.locator('[data-table-cell][data-table-row="0"][data-table-column="0"]').click();

  const firstCell = table
    .locator('[data-table-cell][data-table-row="0"][data-table-column="0"]')
    .locator(".table-cell-background");
  const secondRowCell = table
    .locator('[data-table-cell][data-table-row="1"][data-table-column="0"]')
    .locator(".table-cell-background");
  const initialColumnWidth = await numericAttribute(firstCell, "width");
  const initialRowHeight = await numericAttribute(firstCell, "height");

  await dragHandle(
    page,
    page.locator('#selection-layer [data-resize-handle="table-column"][data-resize-index="0"]'),
    64,
    0,
  );
  await expect.poll(() => numericAttribute(firstCell, "width")).toBeGreaterThan(initialColumnWidth);
  const columnWidthAfterIndividualResize = await numericAttribute(firstCell, "width");

  await dragHandle(
    page,
    page.locator('#selection-layer [data-resize-handle="table-row"][data-resize-index="0"]'),
    0,
    36,
  );
  await expect.poll(() => numericAttribute(firstCell, "height")).toBeGreaterThan(initialRowHeight);
  const rowHeightAfterIndividualResize = await numericAttribute(firstCell, "height");
  expect(await numericAttribute(secondRowCell, "height")).toBe(initialRowHeight);

  await dragHandle(page, page.locator('#selection-layer [data-resize-handle="southeast"]'), 96, 72);
  await expect
    .poll(() => numericAttribute(firstCell, "width"))
    .toBeGreaterThan(columnWidthAfterIndividualResize);
  await expect
    .poll(() => numericAttribute(firstCell, "height"))
    .toBeGreaterThan(rowHeightAfterIndividualResize);
  const persistedTableWidth = await numericAttribute(firstCell, "width");
  const persistedTableHeight = await numericAttribute(firstCell, "height");

  await page.getByTestId("tool-zone").click();
  await page.mouse.click(
    canvasBounds.x + canvasBounds.width * 0.54,
    canvasBounds.y + canvasBounds.height * 0.55,
  );
  const zoneTitleEditor = page.getByTestId("zone-title-editor");
  await expect(zoneTitleEditor).toBeVisible();
  await zoneTitleEditor.fill("Evidence zone");
  await zoneTitleEditor.press("Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const zone = page.locator("#drawing-area .board-item-zone");
  await expect(zone).toHaveCount(1);
  const zoneFill = zone.locator(".zone-fill");
  const initialZoneWidth = await numericAttribute(zoneFill, "width");
  const initialZoneHeight = await numericAttribute(zoneFill, "height");
  await dragHandle(
    page,
    page.locator('#selection-layer [data-resize-handle="southeast"]'),
    120,
    90,
  );
  await expect.poll(() => numericAttribute(zoneFill, "width")).toBeGreaterThan(initialZoneWidth);
  await expect.poll(() => numericAttribute(zoneFill, "height")).toBeGreaterThan(initialZoneHeight);
  const persistedZoneWidth = await numericAttribute(zoneFill, "width");
  const persistedZoneHeight = await numericAttribute(zoneFill, "height");

  await testInfo.attach("table-and-zone-resize.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  await page.reload();
  await waitForBoard(page);
  const reloadedFirstCell = page
    .locator("#drawing-area .board-item-table")
    .locator('[data-table-cell][data-table-row="0"][data-table-column="0"]')
    .locator(".table-cell-background");
  const reloadedZoneFill = page.locator("#drawing-area .board-item-zone .zone-fill");
  expect(await numericAttribute(reloadedFirstCell, "width")).toBe(persistedTableWidth);
  expect(await numericAttribute(reloadedFirstCell, "height")).toBe(persistedTableHeight);
  expect(await numericAttribute(reloadedZoneFill, "width")).toBe(persistedZoneWidth);
  expect(await numericAttribute(reloadedZoneFill, "height")).toBe(persistedZoneHeight);
  expect(consoleErrors).toEqual([]);
});

import { expect, type Page, test } from "@playwright/test";
import { canvasPoint, createBoard } from "./helpers";

/**
 * Where the typeset formula sits relative to the box the board drew for it, in screen pixels. A
 * formula that reads correctly has its whole SVG inside that box; anything negative here is a glyph
 * the foreignObject is cutting off.
 */
async function insetsAroundFormula(page: Page): Promise<{
  top: number;
  bottom: number;
  left: number;
  right: number;
}> {
  const content = page.locator(".board-math-content").last();
  await expect(content).toHaveAttribute("data-math-state", "ready", { timeout: 20_000 });
  const insets = await content.evaluate((node) => {
    const box = node.closest("foreignObject")?.getBoundingClientRect();
    const formula = node.querySelector("mjx-container > svg")?.getBoundingClientRect();
    if (!box || !formula) return null;
    return {
      top: formula.top - box.top,
      bottom: box.bottom - formula.bottom,
      left: formula.left - box.left,
      right: box.right - formula.right,
    };
  });
  if (!insets) throw new Error("The formula has no rendered box to measure.");
  return insets;
}

async function drawFormula(page: Page, at: { x: number; y: number }, tex: string): Promise<void> {
  await page.getByTestId("tool-text").click();
  await page.mouse.click(at.x, at.y);
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeFocused();
  await editor.fill(tex);
  await editor.press("Enter");
}

test("a drawn formula is never clipped by the box the board sizes for it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Typeset measurement runs in Chromium.");
  // The first formula on a board pays for loading MathJax before it can be measured.
  test.setTimeout(90_000);

  await createBoard(page, "Formula clipping");

  // Display maths is the case that broke: MathJax's own prose margin pushed the formula down out of
  // a box sized from the content's height alone, and the glyphs came out sliced through the middle.
  await drawFormula(page, await canvasPoint(page, 0.35, 0.3), "$$x^2 + 5x + 3 = 0$$");
  const display = await insetsAroundFormula(page);
  expect(display.top).toBeGreaterThanOrEqual(0);
  expect(display.bottom).toBeGreaterThanOrEqual(0);
  expect(display.left).toBeGreaterThanOrEqual(0);
  expect(display.right).toBeGreaterThanOrEqual(0);

  // Descenders and a fraction reach further than a single line of digits, so they are the ones a
  // box measured from the wrong height loses first.
  await drawFormula(page, await canvasPoint(page, 0.35, 0.55), "$$\\frac{p}{q} = \\sqrt{y_j}$$");
  const tall = await insetsAroundFormula(page);
  expect(tall.top).toBeGreaterThanOrEqual(0);
  expect(tall.bottom).toBeGreaterThanOrEqual(0);

  // Everything above is measured in screen pixels, so a zoom that is not 1 would expose a fit that
  // only happens to work at 100%.
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByRole("button", { name: "Reset zoom" })).toContainText("156%");
  await drawFormula(page, await canvasPoint(page, 0.5, 0.2), "$$a^2 + b^2 = c^2$$");
  const zoomed = await insetsAroundFormula(page);
  expect(zoomed.top).toBeGreaterThanOrEqual(0);
  expect(zoomed.bottom).toBeGreaterThanOrEqual(0);
  expect(zoomed.left).toBeGreaterThanOrEqual(0);
  expect(zoomed.right).toBeGreaterThanOrEqual(0);
});

test("a double click with the select tool opens a text object for editing", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Pointer double click runs in Chromium.");

  await createBoard(page, "Text editing");
  const at = await canvasPoint(page, 0.4, 0.4);
  await page.getByTestId("tool-text").click();
  await page.mouse.click(at.x, at.y);
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeFocused();
  await editor.fill("First draft");
  await editor.press("Enter");
  await expect(page.locator("#drawing-area .board-item-text")).toContainText("First draft");

  // With the select tool, one click selects and a second within the beat opens the text.
  await page.getByRole("button", { name: /^Select/u }).click();
  const text = page.locator("#drawing-area .board-item-text").first();
  const box = await text.boundingBox();
  if (!box) throw new Error("The text object has no layout bounds.");
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(centre.x, centre.y);
  await page.mouse.click(centre.x, centre.y);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("First draft");

  await editor.fill("Second draft");
  await editor.press("Enter");
  await expect(page.locator("#drawing-area .board-item-text")).toContainText("Second draft");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
});

import { expect, type Page, test } from "@playwright/test";
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

test("the wheel and two-finger trackpad scrolling pan, while Ctrl + wheel zooms", async ({
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

type TwoFingerStep = { first: { x: number; y: number }; second: { x: number; y: number } };

/** Dispatches a synthetic two-finger touch gesture: down at the first step, up at the last. */
async function twoFingerGesture(page: Page, steps: TwoFingerStep[]): Promise<void> {
  await page.locator("#board-canvas").evaluate((node, input) => {
    const canvas = node as SVGSVGElement;
    const captured = new Set<number>();
    Object.defineProperties(canvas, {
      setPointerCapture: { configurable: true, value: (id: number) => captured.add(id) },
      hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
      releasePointerCapture: { configurable: true, value: (id: number) => captured.delete(id) },
    });
    const send = (type: string, pointerId: number, point: { x: number; y: number }) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId,
          pointerType: "touch",
          isPrimary: pointerId === 41,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    input.forEach((step, index) => {
      const type =
        index === 0 ? "pointerdown" : index === input.length - 1 ? "pointerup" : "pointermove";
      send(type, 41, step.first);
      send(type, 42, step.second);
    });
  }, steps);
}

/** Interpolates two-finger positions in small steps, as a touchscreen reports them. */
function twoFingerPath(from: TwoFingerStep, to: TwoFingerStep, count = 20): TwoFingerStep[] {
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const steps: TwoFingerStep[] = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    steps.push({
      first: { x: lerp(from.first.x, to.first.x, t), y: lerp(from.first.y, to.first.y, t) },
      second: { x: lerp(from.second.x, to.second.x, t), y: lerp(from.second.y, to.second.y, t) },
    });
  }
  steps.push(to);
  return steps;
}

test("two fingers pan the board and a pinch zooms it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Synthetic touch acceptance runs in Chromium.");

  await createBoard(page, "Touch navigation");
  const canvas = page.locator("#board-canvas");
  const zoomLabel = page.locator("[data-zoom-label]");
  const c = await canvasPoint(page, 0.5, 0.5);

  // Moving both fingers together pans without changing the zoom.
  const before = await canvas.getAttribute("viewBox");
  await twoFingerGesture(
    page,
    twoFingerPath(
      { first: { x: c.x - 40, y: c.y }, second: { x: c.x + 40, y: c.y } },
      { first: { x: c.x + 20, y: c.y + 80 }, second: { x: c.x + 100, y: c.y + 80 } },
    ),
  );
  await expect.poll(() => canvas.getAttribute("viewBox")).not.toBe(before);
  await expect(zoomLabel).toHaveText("100%");

  // Spreading the fingers zooms in.
  await twoFingerGesture(
    page,
    twoFingerPath(
      { first: { x: c.x - 40, y: c.y }, second: { x: c.x + 40, y: c.y } },
      { first: { x: c.x - 110, y: c.y }, second: { x: c.x + 110, y: c.y } },
    ),
  );
  await expect
    .poll(async () => Number.parseInt((await zoomLabel.textContent()) ?? "0", 10))
    .toBeGreaterThan(100);
});

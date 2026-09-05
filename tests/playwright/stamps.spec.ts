import { expect, test } from "@playwright/test";
import {
  canvasPoint,
  chooseMoreTool,
  closeAccessDrawer,
  createBoard,
  createInvite,
  isolatedContextOptions,
  moveItem,
  openInvite,
  waitForBoard,
} from "./helpers";

type TouchPointerStep = {
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
  pointerId: number;
  x: number;
  y: number;
  primary?: boolean;
};

async function dispatchTouchSteps(
  page: Parameters<typeof canvasPoint>[0],
  steps: TouchPointerStep[],
): Promise<void> {
  await page.locator("#board-canvas").evaluate((node, touchSteps) => {
    const canvas = node as SVGSVGElement;
    const capturedPointers = new Set<number>();
    Object.defineProperties(canvas, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.add(pointerId),
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.has(pointerId),
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.delete(pointerId),
      },
    });
    for (const step of touchSteps) {
      const finished = step.type === "pointerup" || step.type === "pointercancel";
      canvas.dispatchEvent(
        new PointerEvent(step.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: step.pointerId,
          pointerType: "touch",
          isPrimary: step.primary ?? false,
          clientX: step.x,
          clientY: step.y,
          button: 0,
          buttons: finished ? 0 : 1,
          pressure: finished ? 0 : 0.5,
        }),
      );
    }
  }, steps);
}

test("stamps converge, move, copy, delete, persist, and export", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "mobile-chromium" || testInfo.project.name === "ipad-webkit",
    "This collaboration scenario uses mouse selection; touch placement has its own scenario.",
  );

  const boardUrl = await createBoard(page, "Stamp feedback");
  const editorInvite = await createInvite(page);
  await closeAccessDrawer(page);
  const viewerInvite = await createInvite(page, "viewer");
  await closeAccessDrawer(page);

  const editorContext = await browser.newContext(isolatedContextOptions(testInfo, 51));
  const viewerContext = await browser.newContext(isolatedContextOptions(testInfo, 52));
  const editor = await editorContext.newPage();
  const viewer = await viewerContext.newPage();

  try {
    await openInvite(editor, editorInvite);
    await viewer.goto(viewerInvite);
    await expect(viewer).toHaveURL(/\/b\/b_[A-Za-z\d_-]{22}$/u);
    await expect(viewer.getByTestId("board-shell")).toBeVisible();
    await expect(viewer.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    await expect(viewer.getByTestId("save-status")).toHaveAttribute("data-state", "readonly");
    await expect(viewer.getByTestId("tool-stamp")).toBeDisabled();

    await chooseMoreTool(page, "tool-stamp");
    await expect(page.getByTestId("tool-stamp")).toHaveAttribute("aria-pressed", "true");
    const styleTrigger = page.getByTestId("style-button");
    const stylePopover = page.getByTestId("style-popover");
    await expect(styleTrigger).toHaveAttribute("aria-controls", "style-popover");
    await expect(styleTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(stylePopover).toBeVisible();
    await expect(page.locator("[data-stamp-kind]")).toHaveCount(6);
    const heartChoice = page.getByTestId("stamp-choice-heart");
    await expect(heartChoice).toHaveAttribute("aria-label", "Use heart stamp");
    await heartChoice.click();
    await expect(heartChoice).toHaveAttribute("aria-pressed", "true");
    await page.locator('[data-color="#874fff"]').click();

    const heartPoint = await canvasPoint(page, 0.72, 0.36);
    const dismissal = page.evaluate(
      () =>
        new Promise<{ expanded: string | null; hidden: boolean; target: string }>((resolve) => {
          document.addEventListener(
            "pointerdown",
            (event) => {
              queueMicrotask(() => {
                const popover = document.querySelector<HTMLElement>(
                  "[data-testid='style-popover']",
                );
                const trigger = document.querySelector<HTMLElement>("[data-testid='style-button']");
                resolve({
                  expanded: trigger?.getAttribute("aria-expanded") ?? null,
                  hidden: popover?.hasAttribute("hidden") ?? false,
                  target: (event.target as Element | null)?.id ?? "",
                });
              });
            },
            { once: true },
          );
        }),
    );
    await page.mouse.click(heartPoint.x, heartPoint.y);
    await expect(dismissal).resolves.toEqual({
      expanded: "false",
      hidden: true,
      target: "board-canvas",
    });
    await expect(stylePopover).toBeHidden();
    await expect(styleTrigger).toHaveAttribute("aria-expanded", "false");
    await page.locator("#board-canvas").focus();
    await page.keyboard.press("k");
    await expect(stylePopover).toBeVisible();
    await expect(styleTrigger).toHaveAttribute("aria-expanded", "true");
    await styleTrigger.click();
    await expect(stylePopover).toBeHidden();
    await expect(styleTrigger).toHaveAttribute("aria-expanded", "false");
    await chooseMoreTool(page, "tool-stamp");
    await expect(stylePopover).toBeVisible();
    await expect(styleTrigger).toHaveAttribute("aria-expanded", "true");
    await styleTrigger.click();
    await expect(stylePopover).toBeHidden();
    await expect(styleTrigger).toHaveAttribute("aria-expanded", "false");

    const ownerStamps = page.locator("#drawing-area .board-item-stamp");
    const editorStamps = editor.locator("#drawing-area .board-item-stamp");
    const viewerStamps = viewer.locator("#drawing-area .board-item-stamp");
    await expect(ownerStamps).toHaveCount(1);
    await expect(editorStamps).toHaveCount(1);
    await expect(viewerStamps).toHaveCount(1);
    const ownerHeart = ownerStamps.first();
    await expect(ownerHeart).toHaveAttribute("aria-label", "Heart stamp");
    await expect(ownerHeart.locator("path")).toHaveAttribute("fill", "#874fff");
    const heartId = await ownerHeart.getAttribute("data-item-id");
    expect(heartId).toBeTruthy();

    await chooseMoreTool(editor, "tool-stamp");
    await editor.getByTestId("stamp-choice-sparkle").click();
    const sparklePoint = await canvasPoint(editor, 0.62, 0.48);
    await editor.mouse.click(sparklePoint.x, sparklePoint.y);

    await expect(ownerStamps).toHaveCount(2);
    await expect(editorStamps).toHaveCount(2);
    await expect(viewerStamps).toHaveCount(2);
    const ownerSparkle = ownerStamps.last();
    await expect(ownerSparkle).toHaveAttribute("aria-label", "Sparkle stamp");
    const sparkleId = await ownerSparkle.getAttribute("data-item-id");
    expect(sparkleId).toBeTruthy();

    const movedTransform = await moveItem(page, ownerHeart, 48, 26);
    await expect(editor.locator(`#drawing-area [data-item-id="${heartId}"]`)).toHaveAttribute(
      "transform",
      movedTransform,
    );

    await page.keyboard.press("Control+d");
    await expect(page.locator("#drawing-area .board-item-stamp")).toHaveCount(3);
    await expect(editor.locator("#drawing-area .board-item-stamp")).toHaveCount(3);
    const copy = page.locator("#drawing-area .board-item-stamp").last();
    const copyId = await copy.getAttribute("data-item-id");
    expect(copyId).toBeTruthy();
    await page.keyboard.press("Delete");
    await expect(page.locator("#drawing-area .board-item-stamp")).toHaveCount(2);
    await expect(editor.locator(`#drawing-area [data-item-id="${copyId}"]`)).toHaveCount(0);

    await page.reload();
    await waitForBoard(page);
    await expect(page.locator(`#drawing-area [data-item-id="${heartId}"]`)).toHaveCount(1);
    await expect(page.locator(`#drawing-area [data-item-id="${sparkleId}"]`)).toHaveCount(1);

    const boardId = new URL(boardUrl).pathname.split("/").at(-1);
    expect(boardId).toBeTruthy();
    const svgExport = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/boards/${id}/export.svg`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      return { status: response.status, body: await response.text() };
    }, boardId);
    expect(svgExport.status).toBe(200);
    expect(svgExport.body).toContain(`data-item-id="${heartId}"`);
    expect(svgExport.body).toContain(`data-item-id="${sparkleId}"`);
    expect(svgExport.body).toContain("M12 21S3 15.5");
    expect(svgExport.body).toContain("M12 2 14.2 8.2");
    expect(svgExport.body).not.toContain("<text");
  } finally {
    await editorContext.close();
    await viewerContext.close();
  }
});

test("a touch tap places the selected stamp", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "This scenario requires a touch-capable project.");

  await createBoard(page, "Touch stamps");
  await chooseMoreTool(page, "tool-stamp");
  await expect(page.getByTestId("style-popover")).toBeVisible();
  await page.getByTestId("stamp-choice-check").tap();
  const point = await canvasPoint(page, 0.58, 0.42);

  await dispatchTouchSteps(page, [
    { type: "pointerdown", pointerId: 61, x: point.x - 30, y: point.y, primary: true },
    { type: "pointerdown", pointerId: 62, x: point.x + 30, y: point.y },
    { type: "pointermove", pointerId: 61, x: point.x - 48, y: point.y + 8, primary: true },
    { type: "pointermove", pointerId: 62, x: point.x + 48, y: point.y + 8 },
    { type: "pointerup", pointerId: 61, x: point.x - 48, y: point.y + 8, primary: true },
    { type: "pointerup", pointerId: 62, x: point.x + 48, y: point.y + 8 },
  ]);
  await expect(page.locator("#drawing-area .board-item-stamp")).toHaveCount(0);

  await dispatchTouchSteps(page, [
    { type: "pointerdown", pointerId: 63, x: point.x, y: point.y, primary: true },
    { type: "pointercancel", pointerId: 63, x: point.x, y: point.y, primary: true },
  ]);
  await expect(page.locator("#drawing-area .board-item-stamp")).toHaveCount(0);

  await dispatchTouchSteps(page, [
    { type: "pointerdown", pointerId: 64, x: point.x, y: point.y, primary: true },
    { type: "pointermove", pointerId: 64, x: point.x + 40, y: point.y + 20, primary: true },
    { type: "pointerup", pointerId: 64, x: point.x + 40, y: point.y + 20, primary: true },
  ]);
  await expect(page.locator("#drawing-area .board-item-stamp")).toHaveCount(0);

  await page.touchscreen.tap(point.x, point.y);

  const stamp = page.locator("#drawing-area .board-item-stamp");
  await expect(stamp).toHaveCount(1);
  await expect(stamp).toHaveAttribute("aria-label", "Check stamp");
  await expect(stamp.locator("path")).toHaveAttribute("stroke-width", "2.8");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
});

test("the stamp palette remains usable in a short landscape classroom frame", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Responsive geometry runs in Chromium.");

  await page.setViewportSize({ width: 700, height: 240 });
  await createBoard(page, "Landscape stamps");
  await chooseMoreTool(page, "tool-stamp");

  const trigger = page.getByTestId("style-button");
  const popover = page.getByTestId("style-popover");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(popover).toBeVisible();
  const layout = await popover.evaluate((node) => {
    const element = node as HTMLElement;
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      viewportHeight: innerHeight,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    };
  });
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.overflowY).toBe("auto");
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);

  const opacity = page.locator("[data-style-opacity]");
  await opacity.scrollIntoViewIfNeeded();
  const popoverBounds = await popover.boundingBox();
  const opacityBounds = await opacity.boundingBox();
  expect(popoverBounds).not.toBeNull();
  expect(opacityBounds).not.toBeNull();
  expect(opacityBounds?.y).toBeGreaterThanOrEqual(popoverBounds?.y ?? 0);
  expect((opacityBounds?.y ?? 0) + (opacityBounds?.height ?? 0)).toBeLessThanOrEqual(
    (popoverBounds?.y ?? 0) + (popoverBounds?.height ?? 0),
  );

  const question = page.getByTestId("stamp-choice-question");
  await question.focus();
  await expect(question).toBeFocused();
  await expect(question).toHaveAttribute("aria-label", "Use question mark stamp");
});

import { expect, type Page, test } from "@playwright/test";
import {
  canvasPoint,
  createBoard,
  dispatchSyntheticPointerGesture,
  drawShape,
  expandToolPermissions,
  openMoreTools,
  openSettingsDrawer,
} from "./helpers";

async function setRange(page: Page, selector: string, value: number): Promise<void> {
  await page.locator(selector).evaluate((node, nextValue) => {
    const input = node as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

test("line, text, styles, constrained shapes, eraser, and pen input commit canonically", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Pointer-tool acceptance runs in Chromium.");

  await createBoard(page, "Tool acceptance");
  // A fresh board lands on the pencil, ready to draw, with the empty-canvas hint showing.
  await expect(page.getByTestId("tool-pencil")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-canvas-hint]")).toHaveText(
    "Draw or add an element to get started",
  );
  await page.getByTestId("style-button").click();
  const style = page.getByTestId("style-popover");
  await expect(style).toBeVisible();
  await style.getByRole("button", { name: "Use #f24822" }).click();
  await setRange(page, "[data-style-stroke]", 7);
  await setRange(page, "[data-style-opacity]", 55);
  await setRange(page, "[data-style-font]", 40);
  await expect(style.locator("[data-width-output]")).toHaveText("7");
  await expect(style.locator("[data-opacity-output]")).toHaveText("55%");
  await expect(style.locator("[data-font-output]")).toHaveText("40");
  await page.getByTestId("style-button").click();
  await expect(style).toBeHidden();

  const lineStart = await canvasPoint(page, 0.14, 0.18);
  const line = await drawShape(page, "Straight line", lineStart, {
    x: lineStart.x + 105,
    y: lineStart.y + 35,
  });
  await expect(line).toHaveClass(/board-item-line/u);
  await expect(line).toHaveAttribute("stroke", "#f24822");
  await expect(line).toHaveAttribute("stroke-width", "7");
  await expect(line).toHaveAttribute("stroke-opacity", "0.55");

  const textPoint = await canvasPoint(page, 0.52, 0.2);
  await page.getByRole("button", { name: /^Text/u }).click();
  await page.mouse.click(textPoint.x, textPoint.y);
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("Shared words");
  await editor.press("Enter");
  const text = page.locator("#drawing-area .board-item-text");
  await expect(text).toHaveCount(1);
  await expect(text).toContainText("Shared words");
  await expect(text).toHaveAttribute("fill", "#f24822");
  await expect(text).toHaveAttribute("font-size", "40");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const rectangleStart = await canvasPoint(page, 0.16, 0.48);
  const square = await drawShape(page, "Square", rectangleStart, {
    x: rectangleStart.x + 72,
    y: rectangleStart.y + 39,
  });
  await expect(square).toHaveClass(/board-item-rectangle/u);
  const squareSize = await square.evaluate((node) => ({
    width: Number(node.getAttribute("width")),
    height: Number(node.getAttribute("height")),
  }));
  expect(squareSize.width).toBeGreaterThan(0);
  expect(squareSize.width).toBe(squareSize.height);

  const ellipseStart = await canvasPoint(page, 0.48, 0.48);
  const circle = await drawShape(page, "Circle", ellipseStart, {
    x: ellipseStart.x + 44,
    y: ellipseStart.y + 76,
  });
  await expect(circle).toHaveClass(/board-item-ellipse/u);
  const radii = await circle.evaluate((node) => ({
    x: Number(node.getAttribute("rx")),
    y: Number(node.getAttribute("ry")),
  }));
  expect(radii.x).toBeGreaterThan(0);
  expect(radii.x).toBe(radii.y);

  const penStart = await canvasPoint(page, 0.72, 0.55);
  const beforePen = await page.locator("#drawing-area [data-item-id]").count();
  await page.getByRole("button", { name: /^Pencil/u }).click();
  await dispatchSyntheticPointerGesture(page, "pen", [
    { x: penStart.x, y: penStart.y, pressure: 0.2 },
    { x: penStart.x + 22, y: penStart.y + 20, pressure: 0.5 },
    { x: penStart.x + 48, y: penStart.y - 8, pressure: 0.8 },
    { x: penStart.x + 75, y: penStart.y + 28, pressure: 0.4 },
  ]);
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(beforePen + 1);
  await expect(page.locator("#drawing-area .board-item-pencil")).toHaveCount(1);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const erasedId = await square.getAttribute("data-item-id");
  expect(erasedId).toBeTruthy();
  const squareBounds = await square.boundingBox();
  expect(squareBounds).not.toBeNull();
  if (!squareBounds) throw new Error("The square has no layout bounds.");
  await page.getByRole("button", { name: /^Eraser/u }).click();
  await page.mouse.click(squareBounds.x + squareBounds.width / 2, squareBounds.y + 1);
  const partiallyErased = page.locator(`#drawing-area [data-item-id="${erasedId}"]`);
  await expect(partiallyErased).toHaveCount(1);
  await expect(partiallyErased).toHaveClass(/board-item-rectangle/u);
  await expect(partiallyErased).toHaveAttribute("d", /M/u);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
});

test("pencil survives consecutive mouse and pen strokes with delayed capture loss", async ({
  page,
}) => {
  await createBoard(page, "Continuous pencil input");
  const pencil = page.getByTestId("tool-pencil");
  await pencil.click();
  const start = await canvasPoint(page, 0.3, 0.35);

  await page.locator("#board-canvas").evaluate((node, point) => {
    node.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 73,
        pointerType: "pen",
        isPrimary: true,
        clientX: point.x,
        clientY: point.y - 40,
        buttons: 0,
        pressure: 0,
      }),
    );
  }, start);

  for (const offset of [0, 80]) {
    await page.mouse.move(start.x + offset, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + offset + 24, start.y + 18, { steps: 3 });
    await page.mouse.move(start.x + offset + 48, start.y - 4, { steps: 3 });
    await page.mouse.up();
    await expect(pencil).toHaveAttribute("aria-pressed", "true");
  }
  const pencilStrokes = page.locator("#drawing-area .board-item-pencil");
  await expect(pencilStrokes).toHaveCount(2);
  await expect(pencilStrokes.first()).toHaveAttribute("stroke-width", "2");

  await page.locator("#board-canvas").evaluate((node, point) => {
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
    const send = (type: string, x: number, y: number, buttons: number): void => {
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 42,
          pointerType: "pen",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
          pressure: buttons === 0 ? 0 : 0.5,
        }),
      );
    };

    send("pointerdown", point.x, point.y + 100, 1);
    send("pointermove", point.x + 28, point.y + 120, 1);
    send("pointerup", point.x + 52, point.y + 98, 0);
    send("pointerdown", point.x + 80, point.y + 100, 1);
    send("lostpointercapture", point.x + 80, point.y + 100, 0);
    send("pointermove", point.x + 108, point.y + 120, 1);
    send("pointerup", point.x + 132, point.y + 98, 0);
  }, start);

  await expect(page.locator("#drawing-area .board-item-pencil")).toHaveCount(4);
  await expect(pencil).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
});

test("board shortcuts stay disabled while text and sticky editors are active", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Keyboard isolation runs in Chromium.");

  await createBoard(page, "Keyboard isolation");
  const shortcutText = "vplrotnkigzeuh 0+-";

  const textPoint = await canvasPoint(page, 0.35, 0.3);
  const textTool = page.getByTestId("tool-text");
  await textTool.click();
  await page.mouse.click(textPoint.x, textPoint.y);
  const textEditor = page.getByTestId("canvas-text-editor");
  await expect(textEditor).toBeFocused();
  await textEditor.fill("Text ");
  await page.keyboard.type(shortcutText);
  await page.waitForTimeout(700);
  await expect(textEditor).toBeVisible();
  await expect(textEditor).toBeFocused();
  await expect(textEditor).toHaveValue(`Text ${shortcutText}`);
  await expect(textTool).toHaveAttribute("aria-pressed", "true");
  await expect(textEditor).toHaveAttribute("rows", "1");
  expect(
    await textEditor.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        width: style.width,
        minHeight: style.minHeight,
        padding: style.padding,
        fontSize: style.fontSize,
      };
    }),
  ).toEqual({
    width: "240px",
    minHeight: "32px",
    padding: "3px 5px",
    fontSize: "20px",
  });
  await textEditor.press("Control+Enter");
  await expect(textEditor).toBeVisible();
  await expect(textEditor).toBeFocused();
  await expect(textEditor).toHaveValue(`Text ${shortcutText}\n`);
  await textEditor.type("Continued");
  await textEditor.press("Enter");
  await expect(textEditor).toHaveCount(0);
  await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#drawing-area .board-item-text")).toContainText(
    `Text ${shortcutText}`,
  );
  await expect(page.locator("#drawing-area .board-item-text")).toContainText("Continued");

  const stickyPoint = await canvasPoint(page, 0.68, 0.3);
  const stickyTool = page.getByTestId("tool-sticky");
  await stickyTool.click();
  await page.mouse.click(stickyPoint.x, stickyPoint.y);
  const stickyEditor = page.getByTestId("canvas-text-editor");
  await expect(stickyEditor).toBeFocused();
  await stickyEditor.fill("Sticky ");
  await page.keyboard.type(shortcutText);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("-");
  await page.waitForTimeout(700);
  await expect(stickyEditor).toBeVisible();
  await expect(stickyEditor).toBeFocused();
  await expect(stickyEditor).toHaveValue(`Sticky ${shortcutText}`);
  await expect(stickyTool).toHaveAttribute("aria-pressed", "true");
  await stickyEditor.press("Control+Enter");
  await expect(page.locator("#drawing-area .board-item-sticky")).toContainText(
    /Sticky.*vplrotnkigzeuh 0\+-/u,
  );
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
});

test("Settings feature toggles hide and restore a tool live", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Live Settings acceptance runs in Chromium.");

  await createBoard(page, "Feature settings");
  const pencil = page.getByTestId("tool-pencil");
  await expect(pencil).toBeVisible();
  await expect(pencil).toBeEnabled();

  await page.getByTestId("settings-button").click();
  const settingsDrawer = page.getByTestId("settings-drawer");
  await expect(settingsDrawer).toBeVisible();
  await expandToolPermissions(page);
  const pencilToggle = settingsDrawer.getByRole("checkbox", { name: "Enable Pencil" });
  await expect(pencilToggle).toBeChecked();

  await pencilToggle.uncheck();
  await expect(pencil).toBeHidden();
  await expect(page.getByTestId("toast-region")).toContainText("Pencil disabled.");

  await pencilToggle.check();
  await expect(pencil).toBeVisible();
  await expect(pencil).toBeEnabled();
  await expect(page.getByTestId("toast-region")).toContainText("Pencil enabled.");
});

test("the complete board remains usable at a 320px viewport", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-chromium",
    "The narrow-layout scenario runs in mobile Chromium.",
  );

  await page.setViewportSize({ width: 320, height: 640 });
  await createBoard(page, "Pocket canvas");

  const layout = await page.evaluate(() => {
    const canvas = document.querySelector("#board-canvas")?.getBoundingClientRect();
    const shell = document.querySelector("[data-testid='board-shell']")?.getBoundingClientRect();
    return {
      innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      canvas: canvas ? { left: canvas.left, right: canvas.right, width: canvas.width } : null,
      shell: shell ? { left: shell.left, right: shell.right, width: shell.width } : null,
    };
  });
  expect(layout.innerWidth).toBe(320);
  expect(layout.documentWidth).toBeLessThanOrEqual(320);
  expect(layout.bodyWidth).toBeLessThanOrEqual(320);
  expect(layout.shell).not.toBeNull();
  expect(layout.shell?.left).toBeGreaterThanOrEqual(0);
  expect(layout.shell?.right).toBeLessThanOrEqual(320);
  expect(layout.canvas?.width).toBeGreaterThan(240);
  expect(layout.canvas?.right).toBeLessThanOrEqual(320);
  const title = page.getByTestId("board-title");
  const mcpStatus = page.getByTestId("webmcp-status");
  const [titleBounds, mcpBounds] = await Promise.all([
    title.boundingBox(),
    mcpStatus.boundingBox(),
  ]);
  expect(titleBounds).not.toBeNull();
  expect(mcpBounds).not.toBeNull();
  if (!titleBounds || !mcpBounds) throw new Error("The compact header controls are not rendered.");
  expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(mcpBounds.x - 4);
  await title.click({
    position: { x: Math.max(1, titleBounds.width - 2), y: titleBounds.height / 2 },
  });
  await expect(title).toBeFocused();
  const floatingControls = await page.evaluate(() => {
    const zoom = document.querySelector(".zoom-controls")?.getBoundingClientRect();
    return {
      zoom: zoom ? { top: zoom.top, bottom: zoom.bottom } : null,
    };
  });
  expect(floatingControls.zoom).not.toBeNull();
  await expect(page.locator(".history-controls")).toHaveCount(0);
  const mobileSettings = await openSettingsDrawer(page);
  await expect(mobileSettings.locator(".settings-history-controls")).toBeVisible();
  await mobileSettings.getByRole("button", { name: "Close settings" }).click();
  const rail = page.getByTestId("tool-rail");
  const scrollBack = page.getByRole("button", { name: "Scroll tools left" });
  const scrollForward = page.getByRole("button", { name: "Scroll tools right" });
  await expect(scrollBack).toBeVisible();
  await expect(scrollForward).toBeVisible();
  await expect(scrollBack).toBeDisabled();
  await expect(scrollForward).toBeEnabled();
  const initialScrollLeft = await rail.evaluate((node) => node.scrollLeft);
  await scrollForward.click();
  await expect
    .poll(async () => rail.evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(initialScrollLeft);
  await expect(scrollBack).toBeEnabled();
  await scrollBack.click();
  await expect.poll(async () => rail.evaluate((node) => node.scrollLeft)).toBe(0);

  const tools = page.getByTestId("tool-rail").locator("button[data-tool]");
  await expect(tools).toHaveCount(7);
  await expect(page.getByTestId("tool-image")).toHaveAttribute("aria-label", "Add image (I)");
  await expect(page.getByTestId("tool-image").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("tool-rectangle").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("tool-sticky").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("tool-zone").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("tool-rail").getByTestId("tool-eraser")).toHaveCount(0);
  await page.getByTestId("tool-pencil").click();
  const brushBar = page.getByTestId("quick-style-bar");
  await expect(brushBar).toBeVisible();
  await expect(brushBar.getByRole("button", { name: "Pen" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(brushBar.getByRole("button", { name: "Marker" }).locator("svg")).toHaveCount(1);
  await expect(brushBar.getByRole("button", { name: "Highlighter" }).locator("svg")).toHaveCount(1);
  await expect(brushBar.getByTestId("tool-eraser").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("tool-image")).toBeEnabled();
  await openMoreTools(page);
  const moreMenu = page.getByTestId("tools-menu");
  for (const testId of [
    "tool-stamp",
    "tool-image",
    "tool-video",
    "activities-button",
    "tool-table",
  ]) {
    const nestedTool = moreMenu.getByTestId(testId);
    await expect(nestedTool).toHaveCount(1);
    expect(
      await nestedTool.evaluate((node) => node.closest("[data-testid='tools-menu']") !== null),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");

  for (const tool of await tools.all()) {
    if (!(await tool.isVisible())) continue;
    await tool.scrollIntoViewIfNeeded();
    const bounds = await tool.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.width).toBeGreaterThanOrEqual(42);
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
  }
  await page.getByTestId("tool-rectangle").click();
  const shapeMenu = page.getByTestId("shape-menu");
  await expect(shapeMenu).toBeVisible();
  await expect(shapeMenu.getByTestId("tool-line")).toBeVisible();
  // The menu must open directly above the tool rail, not float mid-canvas.
  const railBounds = await page.getByTestId("tool-rail").boundingBox();
  const menuBounds = await shapeMenu.boundingBox();
  expect(railBounds).not.toBeNull();
  expect(menuBounds).not.toBeNull();
  if (railBounds && menuBounds) {
    const gap = railBounds.y - (menuBounds.y + menuBounds.height);
    expect(gap).toBeGreaterThanOrEqual(-12);
    expect(gap).toBeLessThanOrEqual(24);
    const railCenter = railBounds.x + railBounds.width / 2;
    const menuCenter = menuBounds.x + menuBounds.width / 2;
    expect(Math.abs(railCenter - menuCenter)).toBeLessThanOrEqual(12);
  }
  const shapeChoices = shapeMenu.locator("[data-shape-variant]:visible");
  await expect(shapeChoices).toHaveCount(7);
  for (const choice of await shapeChoices.all()) {
    const bounds = await choice.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
  }
  await page.keyboard.press("Escape");
  await expect(shapeMenu).toBeHidden();
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute("aria-expanded", "false");
  const textPoint = await canvasPoint(page, 0.5, 0.34);
  await page.getByRole("button", { name: /^Text/u }).click();
  await page.mouse.click(textPoint.x, textPoint.y);
  await page.getByTestId("canvas-text-editor").fill("Mobile note");
  await page.getByTestId("canvas-text-editor").press("Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await page.getByTestId("tool-select").click();
  await page.locator("#drawing-area .board-item-text").click();
  await page.getByRole("button", { name: "Change selected element colour" }).click();
  const colourMenu = page.getByTestId("selection-colour-menu");
  await expect(colourMenu).toBeVisible();
  const colourMenuBounds = await colourMenu.boundingBox();
  expect(colourMenuBounds).not.toBeNull();
  expect(colourMenuBounds?.x).toBeGreaterThanOrEqual(0);
  expect((colourMenuBounds?.x ?? 0) + (colourMenuBounds?.width ?? 0)).toBeLessThanOrEqual(320);
  expect(colourMenuBounds?.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Escape");
  await page.locator("#board-canvas").click({ position: { x: 16, y: 16 } });
  await page.getByRole("button", { name: /^Pan canvas/u }).click();
  await expect(page.getByRole("button", { name: /^Pan canvas/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByTestId("access-button").click();
  const drawer = page.getByTestId("access-drawer");
  await expect(drawer).toBeVisible();
  await drawer.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished));
  });
  const drawerBounds = await drawer.boundingBox();
  expect(drawerBounds).not.toBeNull();
  expect(drawerBounds?.x).toBeGreaterThanOrEqual(0);
  expect((drawerBounds?.x ?? 0) + (drawerBounds?.width ?? 0)).toBeLessThanOrEqual(320);
  await drawer.getByRole("button", { name: "Close access panel" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator("#board-canvas")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("pocket-canvas.png") });
});

test("the saved chip is icon-only while compact layouts preserve topbar space", async ({
  page,
}) => {
  await createBoard(page, "Save chip");
  const chip = page.getByTestId("save-status");
  await expect(chip).toHaveAttribute("data-state", "saved");

  const saved = await page.evaluate(() => {
    const label = document.querySelector("[data-save-status-text]") as HTMLElement;
    const status = document.querySelector("[data-testid='save-status']") as HTMLElement;
    return {
      text: label.textContent,
      labelWidth: label.getBoundingClientRect().width,
      chipWidth: status.getBoundingClientRect().width,
      live: status.getAttribute("aria-live"),
    };
  });
  // The green check carries the meaning; the word is clipped to nothing on screen but stays in
  // the DOM so the live region still announces that the board saved.
  expect(saved.text).toBe("Saved");
  expect(saved.labelWidth).toBeLessThan(2);
  expect(saved.live).toBe("polite");

  // A state the icon cannot express keeps its visible label, and the chip grows to fit it.
  await page.evaluate(() => {
    const status = document.querySelector("[data-testid='save-status']") as HTMLElement;
    const label = document.querySelector("[data-save-status-text]") as HTMLElement;
    status.dataset.state = "saving";
    label.textContent = "Saving…";
  });
  const saving = await page.evaluate(() => {
    const label = document.querySelector("[data-save-status-text]") as HTMLElement;
    const status = document.querySelector("[data-testid='save-status']") as HTMLElement;
    return {
      labelWidth: label.getBoundingClientRect().width,
      chipWidth: status.getBoundingClientRect().width,
    };
  });
  if ((page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) <= 650) {
    // The compact topbar deliberately hides every status label; the live region still announces
    // its text to assistive technology.
    expect(saving.labelWidth).toBe(0);
    expect(saving.chipWidth).toBe(saved.chipWidth);
  } else {
    expect(saving.labelWidth).toBeGreaterThan(20);
    expect(saving.chipWidth).toBeGreaterThan(saved.chipWidth);
  }
});

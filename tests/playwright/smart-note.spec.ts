import { expect, type Page, test } from "@playwright/test";
import {
  closeAccessDrawer,
  createBoard,
  createInvite,
  drag,
  isolatedContextOptions,
  openInvite,
  waitForBoard,
} from "./helpers";

type Area = { x: number; y: number; width: number; height: number };
async function enableSmartNote(page: Page) {
  await page.getByTestId("settings-button").click();
  await page.getByRole("checkbox", { name: "Enable Smart Note", exact: true }).check();
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
}
async function startCalibration(page: Page) {
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
  await expect(page.locator(".smart-note-status")).toContainText("Step 1 of 4");
}
function fraction(area: Area, x: number, y: number) {
  return { x: area.x + area.width * x, y: area.y + area.height * y };
}
async function calibrateNote(page: Page, area: Area) {
  await startCalibration(page);
  for (const [index, point] of [
    fraction(area, 0, 0),
    fraction(area, 1, 0),
    fraction(area, 1, 1),
    fraction(area, 0, 1),
  ].entries()) {
    await expect(page.locator(`[data-guide-corner="${index}"]`)).toHaveAttribute(
      "data-current",
      "true",
    );
    await page.mouse.click(point.x, point.y);
  }
  await verifyNote(page, [
    fraction(area, 0, 0),
    fraction(area, 1, 0),
    fraction(area, 1, 1),
    fraction(area, 0, 1),
  ]);
  await expect(page.getByTestId("board-shell")).toHaveAttribute("data-smart-note", "active");
  await expect(page.locator(".smart-note-dialog")).not.toBeVisible();
  await expect(page.locator("[data-canvas-host] > #board-canvas")).toHaveCount(1);
  await expect(page.locator("#board-canvas")).toHaveAttribute("viewBox", "0 0 740 1050");
  await expect(page.locator("[data-page-corner]")).toHaveCount(4);
  const bounds = await page.locator("#board-canvas").boundingBox();
  if (!bounds) throw new Error("Missing page");
  expect(bounds.x).toBeCloseTo(area.x, 1);
  expect(bounds.y).toBeCloseTo(area.y, 1);
  expect(bounds.width).toBeCloseTo(area.width, 1);
  expect(bounds.height).toBeCloseTo(area.height, 1);
}

async function verifyNote(page: Page, corners: readonly { x: number; y: number }[]) {
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "verifying");
  for (const point of corners) await page.mouse.click(point.x, point.y);
}

async function penInput(page: Page) {
  const session = await page.context().newCDPSession(page);
  return async (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) => {
    await session.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      pointerType: "pen",
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
      force: type === "mouseReleased" ? 0 : 0.5,
    });
  };
}

test("shared A5 retains the regular UI and disables tools except Pencil on different displays", async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await createBoard(page, "Regular UI shared A5");
  const invite = await createInvite(page);
  await closeAccessDrawer(page);
  const context = await browser.newContext({
    ...isolatedContextOptions(testInfo),
    viewport: { width: 1000, height: 800 },
    deviceScaleFactor: 2,
  });
  try {
    const student = await context.newPage();
    await openInvite(student, invite);
    await enableSmartNote(page);
    await expect(student.locator(".smart-note-dialog")).toHaveAttribute(
      "data-state",
      "calibrating",
    );
    await expect(student.getByRole("button", { name: "Turn off for everyone" })).toBeHidden();
    const first = { x: 20, y: 2, width: 600, height: 840 };
    const second = { x: 40, y: 5, width: 500, height: 700 };
    await calibrateNote(page, first);
    await calibrateNote(student, second);
    await expect(page.locator(".topbar")).toBeVisible();
    await expect(page.getByTestId("tool-rail")).toBeVisible();
    await expect(page.getByTestId("tool-pencil")).toBeEnabled();
    await expect(page.getByTestId("tool-select")).toBeDisabled();
    await expect(page.getByTestId("tool-eraser")).toBeDisabled();
    await expect(page.getByTestId("tool-rectangle")).toBeDisabled();
    await expect(page.getByTestId("activities-button")).toBeDisabled();
    await expect(page.locator(".smart-note-controls")).toHaveCount(0);
    await expect(page.getByTestId("settings-drawer")).not.toBeVisible();
    await drag(page, fraction(first, 0.25, 0.2), fraction(first, 0.75, 0.4), { steps: 4 });
    await expect(student.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await drag(student, fraction(second, 0.25, 0.2), fraction(second, 0.75, 0.4), { steps: 4 });
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    const paths = await page
      .locator("#drawing-area path")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")));
    expect(paths[0]).toEqual(paths[1]);
    await page.keyboard.press("e");
    await expect(page.locator("#board-canvas")).toHaveAttribute("data-tool", "pencil");
    await page.mouse.wheel(0, -400);
    await expect(page.locator("#board-canvas")).toHaveAttribute("viewBox", "0 0 740 1050");
    await page.screenshot({ path: "/tmp/smart-note-regular-ui.png" });
    // Mouse-emulating drivers can also start handwriting over the normal title field.
    await drag(page, { x: 300, y: 20 }, { x: 450, y: 40 }, { steps: 4 });
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(3);
    await page.getByTestId("undo-button").click();
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    // Existing controls remain usable, including undo and disabling the board setting.
    await page.getByTestId("undo-button").click();
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await expect(page.locator("[data-page-corner]")).toHaveCount(4);
    await page.getByTestId("settings-button").click();
    await page.getByRole("checkbox", { name: "Enable Smart Note", exact: true }).uncheck();
    await expect(student.locator("#board-canvas")).not.toHaveAttribute("data-smart-note", "true");
    await expect(page.getByTestId("tool-eraser")).toBeEnabled();
    await expect(page.locator(".smart-note-dialog")).not.toBeVisible();
  } finally {
    await context.close();
  }
});

test("calibration rejects repeated marks immediately and preserves exact initial points", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1100, height: 800 });
  await createBoard(page, "Full screen calibration");
  await enableSmartNote(page);
  await page.getByRole("button", { name: "Use full screen" }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await startCalibration(page);
  await page.mouse.move(20, 2);
  await page.mouse.down();
  await page.mouse.move(25, 18);
  await page.mouse.up();
  const dot = await page.locator('[data-measured-corner="0"]').boundingBox();
  expect(dot?.x).toBeCloseTo(16, 1);
  expect(dot?.y).toBeCloseTo(-2, 1);
  for (const [x, y] of [
    [22, 4],
    [20, 700],
    [40, 30],
  ] as const) {
    await page.mouse.click(x, y);
    await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-invalid", "true");
    await expect(page.locator('[data-guide-corner="1"]')).toHaveAttribute("data-current", "true");
    await expect(page.locator("[data-measured-corner]")).toHaveCount(1);
  }
  await expect(page.locator('[data-guide-corner="1"] circle')).toHaveCSS(
    "fill",
    "rgb(229, 57, 53)",
  );
  await expect(page.locator('[data-guide-corner="1"] circle')).toHaveCSS(
    "animation-name",
    "smart-note-blink",
  );
  await page.mouse.click(620, 2);
  await page.mouse.click(620, 250);
  await expect(page.locator(".smart-note-status")).toContainText("tall A5 page");
  await expect(page.locator("[data-measured-corner]")).toHaveCount(2);
  await page.getByRole("button", { name: "Restart calibration" }).click();
  await calibrateNote(page, { x: 20, y: 2, width: 600, height: 740 });
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
  await page.setViewportSize({ width: 390, height: 844 });
  const guide = await page.locator(".smart-note-guide").boundingBox();
  if (!guide) throw new Error("Missing guide");
  expect(guide.x + guide.width / 2).toBeCloseTo(195, 0);
  expect(guide.y + guide.height / 2).toBeCloseTo(422, 0);
  await page.screenshot({ path: "/tmp/smart-note-regular-ui-mobile-guide.png" });
  await page.reload();
  await waitForBoard(page);
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
  expect(errors).toEqual([]);
});

test("trusted pen writes at the top and bottom, through the regular header, after pen calibration", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "CDP pen input requires Chromium");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await createBoard(page, "Pen across full calibrated page");
  await enableSmartNote(page);
  await startCalibration(page);
  const pen = await penInput(page);
  for (const [x, y] of [
    [20, 2],
    [620, 2],
    [620, 842],
    [20, 842],
  ] as const) {
    await pen("mousePressed", x, y);
    await pen("mouseReleased", x, y);
  }
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "verifying");
  for (const [x, y] of [
    [20, 2],
    [620, 2],
    [620, 842],
    [20, 842],
  ]) {
    await pen("mousePressed", x as number, y as number);
    await pen("mouseReleased", x as number, y as number);
  }
  await expect(page.locator(".smart-note-dialog")).not.toBeVisible();
  await expect(page.locator("#board-canvas")).toHaveAttribute("data-tool", "pencil");
  await expect(page.getByTestId("tool-pencil")).toHaveAttribute("aria-pressed", "true");
  for (const y of [3, 40, 90, 420, 840]) {
    await pen("mousePressed", 170, y);
    await pen("mouseMoved", 270, y);
    await pen("mouseReleased", 370, y);
  }
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(5);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const positions = await page.locator("#drawing-area path").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width };
    }),
  );
  [3, 40, 90, 420, 840].forEach((y, i) => {
    expect(positions[i]?.x).toBeCloseTo(170, 0);
    expect(positions[i]?.y).toBeCloseTo(y, 0);
    expect(positions[i]?.width).toBeCloseTo(200, 0);
  });
  // The ink layer must be above the normal header, not hidden by its 56px strip.
  expect(
    await page.locator("#board-canvas").evaluate((el) => Number(getComputedStyle(el).zIndex)),
  ).toBeGreaterThan(
    await page.locator(".topbar").evaluate((el) => Number(getComputedStyle(el).zIndex)),
  );
  await page.screenshot({ path: "/tmp/smart-note-regular-ui-pen-top-bottom.png" });
  // Leaving the calibrated page ends the stroke; re-entry must not connect outside ink.
  await pen("mousePressed", 200, 200);
  await pen("mouseMoved", 300, 300);
  await pen("mouseMoved", 700, 400);
  await pen("mouseMoved", 400, 500);
  await pen("mouseReleased", 450, 550);
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(6);
  // Mouse still operates the regular UI after using the stylus.
  await page.getByTestId("undo-button").click();
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(5);
  await page.locator("[data-smart-note-open]").click();
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(5);
  for (const [x, y] of [
    [20, 2],
    [620, 2],
    [620, 842],
    [20, 842],
  ] as const) {
    await pen("mousePressed", x, y);
    await pen("mouseReleased", x, y);
  }
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "verifying");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("four skewed screen marks stay pinned without reparenting the regular canvas", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await createBoard(page, "Skewed paper mapping");
  await enableSmartNote(page);
  await startCalibration(page);
  const corners = [
    [80, 3],
    [650, 45],
    [590, 720],
    [30, 680],
  ] as const;
  for (const point of corners) await page.mouse.click(point[0], point[1]);
  await verifyNote(
    page,
    corners.map(([x, y]) => ({ x, y })),
  );
  await expect(page.locator(".smart-note-dialog")).not.toBeVisible();
  for (const [index, point] of corners.entries()) {
    const dot = await page.locator(`[data-page-corner="${index}"]`).boundingBox();
    if (!dot) throw new Error("Missing corner dot");
    expect(dot.x + dot.width / 2).toBeCloseTo(point[0], 0);
    expect(dot.y + dot.height / 2).toBeCloseTo(point[1], 0);
  }
});

test("shifted top and left calibration is corrected before seven upper rows are painted", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "CDP pen input requires Chromium");
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.addInitScript(() => {
    window.addEventListener(
      "pointerdown",
      (event) => {
        document.documentElement.dataset.lastTestPointer = String(event.pointerId);
      },
      true,
    );
  });
  await createBoard(page, "Skewed upper handwriting");
  await enableSmartNote(page);
  const corners = [
    [35, 82],
    [475, 60],
    [435, 730],
    [20, 780],
  ] as const;
  const { calibrate, toClient } = await import("../../apps/web/src/smart-note/calibration");
  const mapping = calibrate(corners, { left: 0, top: 0, width: 1100, height: 900 });
  if (!mapping) throw new Error("Invalid fixture");
  const pen = await penInput(page);
  // Simulate the user's symptom: the initial top/left positions are inset,
  // whereas subsequent writing coordinates extend above and left of the page.
  // Keep the bottom-right fixed, so a constant translation cannot solve it.
  const initialCorners = corners.map(
    ([x, y]) => [435 + (x - 435) * 0.8, 730 + (y - 730) * 0.8] as const,
  );
  for (const [x, y] of initialCorners) {
    await pen("mousePressed", x, y);
    expect(
      await page.evaluate(() =>
        document.documentElement.hasPointerCapture(
          Number(document.documentElement.dataset.lastTestPointer),
        ),
      ),
    ).toBe(true);
    await pen("mouseReleased", x, y);
  }
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "verifying");
  await expect(page.locator("#board-canvas")).toBeFocused();
  // The repeated physical marks land outside the old top/left. They must be
  // accepted as calibration input, without being clipped by drawing bounds.
  for (const [x, y] of corners) {
    await pen("mousePressed", x, y);
    await pen("mouseReleased", x, y);
  }
  await expect(page.locator(".smart-note-status")).toContainText("page has been remapped");
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "verifying");
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(0);
  for (const [index, [x, y]] of corners.entries()) {
    const dot = await page.locator(`[data-page-corner="${index}"]`).boundingBox();
    if (!dot) throw new Error("Missing corrected corner");
    expect(dot.x + dot.width / 2).toBeCloseTo(x, 0);
    expect(dot.y + dot.height / 2).toBeCloseTo(y, 0);
  }
  for (const [x, y] of corners) {
    await pen("mousePressed", x, y);
    await pen("mouseReleased", x, y);
  }
  await expect(page.locator(".smart-note-dialog")).not.toBeVisible();
  await expect(page.locator("#board-canvas")).toBeFocused();
  const samples: { x: number; y: number }[] = [];
  for (let row = 0; row < 7; row++) {
    const left = toClient(mapping, [280, 12 + row * 24]);
    const middle = toClient(mapping, [310, 12 + row * 24]);
    const right = toClient(mapping, [340, 12 + row * 24]);
    await pen("mousePressed", ...left);
    expect(
      await page.evaluate(() =>
        document.documentElement.hasPointerCapture(
          Number(document.documentElement.dataset.lastTestPointer),
        ),
      ),
    ).toBe(true);
    await pen("mouseMoved", ...middle);
    await pen("mouseReleased", ...right);
    samples.push({ x: middle[0], y: middle[1] });
  }
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(7);
  const screenshot = await page.screenshot({ path: "/tmp/smart-note-seven-skewed-rows.png" });
  const painted = await page.evaluate(
    async ({ png, samples }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Missing context");
      ctx.drawImage(image, 0, 0);
      return samples.map(({ x, y }) => {
        const pixels = ctx.getImageData(Math.round(x) - 2, Math.round(y) - 2, 5, 5).data;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            (pixels[i] ?? 255) < 100 &&
            (pixels[i + 1] ?? 255) < 100 &&
            (pixels[i + 2] ?? 255) < 100
          )
            return true;
        return false;
      });
    },
    { png: screenshot.toString("base64"), samples },
  );
  expect(painted).toEqual([true, true, true, true, true, true, true]);
  await pen("mousePressed", 250, 20);
  await pen("mouseReleased", 250, 20);
  await expect(page.getByTestId("toast-region")).toContainText("outside the calibrated A5 page");
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(7);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator("[data-smart-note-open]").click();
  await page.getByRole("button", { name: "Copy calibration details" }).click();
  const details = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(details.measurements).toHaveLength(3);
  expect(details.measurements[1].maximumShift).toBeGreaterThan(100);
  expect(details.measurements[2].maximumShift).toBeLessThan(1);
  expect(details.contacts).toHaveLength(12);
  expect(details.renderedCorners).toHaveLength(4);
});

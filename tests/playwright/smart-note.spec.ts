import { expect, type Page, test } from "@playwright/test";
import {
  closeAccessDrawer,
  createBoard,
  createInvite,
  dispatchSyntheticPointerGesture,
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
function fraction(area: Area, x: number, y: number) {
  return { x: area.x + area.width * x, y: area.y + area.height * y };
}
async function calibrateNote(page: Page, area: Area) {
  const points = [
    fraction(area, 0, 0),
    fraction(area, 1, 0),
    fraction(area, 1, 1),
    fraction(area, 0, 1),
  ];
  for (const [index, point] of points.entries()) {
    await expect(
      page.locator(`.smart-note-illustration [data-guide-corner="${index}"]`),
    ).toHaveAttribute("data-current", "true");
    await page.mouse.click(point.x, point.y);
    if (index < 3) await expect(page.locator(".smart-note-stage #board-canvas")).toHaveCount(0);
  }
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "active");
  await expect(page.locator("#board-canvas")).toHaveAttribute("viewBox", "0 0 740 1050");
  await expect(page.locator("[data-page-corner]")).toHaveCount(4);
  const bounds = await page.locator("#board-canvas").boundingBox();
  if (!bounds) throw new Error("Missing page");
  expect(bounds.x).toBeCloseTo(area.x, 1);
  expect(bounds.y).toBeCloseTo(area.y, 1);
  expect(bounds.width).toBeCloseTo(area.width, 1);
  expect(bounds.height).toBeCloseTo(area.height, 1);
}

test("everyone must calibrate the same A5 page; top-edge ink and four corner marks align across displays", async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await createBoard(page, "Four-corner shared A5");
  const invite = await createInvite(page);
  await closeAccessDrawer(page);
  const context = await browser.newContext({
    ...isolatedContextOptions(testInfo),
    viewport: { width: 1000, height: 760 },
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
    await student.keyboard.press("Escape");
    await expect(student.locator(".smart-note-dialog")).toBeVisible();
    await expect(page.getByRole("img", { name: /A5 paper with four corners/ })).toBeVisible();
    await page.screenshot({ path: "/tmp/smart-note-four-corner-guide.png" });
    const first = { x: 20, y: 2, width: 600, height: 840 };
    const second = { x: 40, y: 5, width: 540, height: 660 };
    await calibrateNote(page, first);
    await calibrateNote(student, second);
    // Writing very close to the physical top edge used to be excluded by the header.
    await drag(page, fraction(first, 0.25, 0.01), fraction(first, 0.75, 0.25), { steps: 4 });
    await expect(student.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await drag(student, fraction(second, 0.25, 0.01), fraction(second, 0.75, 0.25), { steps: 4 });
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    const paths = await page
      .locator("#drawing-area path")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")));
    expect(paths[0]).toEqual(paths[1]);
    expect(paths[0]).toContain("10.5");
    await page.mouse.move(300, 300);
    await page.mouse.wheel(0, -400);
    await expect(page.locator("#board-canvas")).toHaveAttribute("viewBox", "0 0 740 1050");
    await page.screenshot({ path: "/tmp/smart-note-four-corner-page.png" });
    // No previously stored two-corner calibration or Escape may bypass the new flow.
    await page.reload();
    await waitForBoard(page);
    await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
    await expect(page.getByRole("button", { name: "Use saved calibration" })).toHaveCount(0);
    await calibrateNote(page, first);
    await expect(page.locator("[data-page-corner]")).toHaveCount(4);
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
    await page.getByRole("button", { name: "Turn off for everyone" }).click();
    await expect(student.locator(".smart-note-dialog")).not.toBeVisible();
    await expect(page.locator(".smart-note-dialog")).not.toBeVisible();
    await page.reload();
    await waitForBoard(page);
    await expect(page.locator(".smart-note-dialog")).not.toBeVisible();
  } finally {
    await context.close();
  }
});

test("calibration uses initial pen-down positions and retains corner dots through undo", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(message.text());
  });
  await page.setViewportSize({ width: 1100, height: 800 });
  await createBoard(page, "Smart Note four corners");
  await enableSmartNote(page);
  await expect(page).toHaveTitle(/Smart Note four corners/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.mouse.move(15, 1);
  await page.mouse.down();
  await page.mouse.move(25, 18);
  await page.mouse.up();
  const dot = await page.locator('[data-measured-corner="0"]').boundingBox();
  expect(dot?.x).toBeCloseTo(11, 1);
  expect(dot?.y).toBeCloseTo(-3, 1);
  await page.getByRole("button", { name: "Use full screen" }).click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expect(page.locator(".smart-note-status")).toContainText("Step 1 of 4");
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator(".smart-note-status")).toContainText("Step 1 of 4");
  await page.getByRole("button", { name: "Restart calibration" }).click();
  await page.mouse.click(20, 2);
  // Nearby and out-of-order marks are rejected immediately; the first mark remains.
  for (const [x, y] of [
    [22, 4],
    [20, 700],
    [40, 30],
  ]) {
    await page.mouse.click(x as number, y as number);
    await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-invalid", "true");
    await expect(page.locator('[data-guide-corner="1"]')).toHaveAttribute("data-current", "true");
    await expect(page.locator("[data-measured-corner]")).toHaveCount(1);
  }
  const currentDot = page.locator('[data-guide-corner="1"] circle');
  await expect(currentDot).toHaveCSS("fill", "rgb(229, 57, 53)");
  await expect(currentDot).toHaveCSS("animation-name", "smart-note-blink");
  await page.mouse.click(620, 2);
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-invalid", "false");
  await page.mouse.click(620, 250); // A flat rectangle is not an A5 page.
  await expect(page.locator(".smart-note-status")).toContainText("tall A5 page");
  await expect(page.locator('[data-guide-corner="2"]')).toHaveAttribute("data-current", "true");
  await expect(page.locator("[data-measured-corner]")).toHaveCount(2);
  await page.getByRole("button", { name: "Restart calibration" }).click();
  const area = { x: 20, y: 2, width: 600, height: 720 };
  await calibrateNote(page, area);
  await dispatchSyntheticPointerGesture(page, "touch", [
    fraction(area, 0.1, 0.1),
    fraction(area, 0.3, 0.3),
  ]);
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(0);
  await dispatchSyntheticPointerGesture(page, "pen", [
    fraction(area, 0.2, 0.2),
    fraction(area, 0.5, 0.5),
    fraction(area, 1.1, 0.6),
    fraction(area, 0.8, 0.8),
  ]);
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(1);
  const path = await page.locator("#drawing-area path").getAttribute("d");
  expect(path).toContain("370");
  expect(path).not.toContain("814");
  expect(path).not.toContain("592");
  await page.mouse.move(800, 400); // Switch from synthetic pen hover back to the mouse toolbar.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(0);
  await expect(page.locator("[data-page-corner]")).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
  const guide = await page.locator(".smart-note-guide").boundingBox();
  if (!guide) throw new Error("Missing calibration guide");
  expect(guide.x + guide.width / 2).toBeCloseTo(195, 0);
  expect(guide.y + guide.height / 2).toBeCloseTo(422, 0);
  await page.screenshot({ path: "/tmp/smart-note-four-corner-mobile.png" });
  expect(errors).toEqual([]);
});

test("all four skewed screen marks match their rendered page dots", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await createBoard(page, "Skewed paper mapping");
  await enableSmartNote(page);
  const corners = [
    [80, 3],
    [650, 45],
    [590, 720],
    [30, 680],
  ];
  for (const point of corners) await page.mouse.click(point[0] as number, point[1] as number);
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "active");
  for (const [index, point] of corners.entries()) {
    const dot = await page.locator(`[data-page-corner="${index}"]`).boundingBox();
    if (!dot) throw new Error("Missing corner dot");
    expect(dot.x + dot.width / 2).toBeCloseTo(point[0] as number, 0);
    expect(dot.y + dot.height / 2).toBeCloseTo(point[1] as number, 0);
  }
});

test("browser pen input draws immediately after pen calibration", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP pen input requires Chromium");
  await page.setViewportSize({ width: 1100, height: 800 });
  await createBoard(page, "Pen calibration regression");
  await enableSmartNote(page);
  const session = await page.context().newCDPSession(page);
  async function pen(type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) {
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
  }
  for (const [x, y] of [
    [480, 2],
    [1080, 2],
    [1080, 742],
    [480, 742],
  ]) {
    await pen("mousePressed", x as number, y as number);
    await pen("mouseReleased", x as number, y as number);
  }
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "active");
  await expect(page.locator("#board-canvas")).toHaveAttribute("data-tool", "pencil");
  await expect(
    page.locator(".smart-note-dialog").getByRole("button", { name: "Eraser", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("e");
  await page.keyboard.press("Space");
  await expect(page.locator("#board-canvas")).toHaveAttribute("data-tool", "pencil");
  for (const offset of [0, 50]) {
    await pen("mousePressed", 600, 10 + offset);
    await pen("mouseMoved", 700, 100 + offset);
    await pen("mouseReleased", 800, 200 + offset);
  }
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);
  // Drivers may send contact without a preceding hover; floating controls must not steal it.
  await page.mouse.move(100, 400);
  const control = await page.getByRole("button", { name: "Undo", exact: true }).boundingBox();
  if (!control) throw new Error("Missing controls");
  const x = control.x + control.width / 2,
    y = control.y + control.height / 2;
  await pen("mousePressed", x, y);
  await pen("mouseMoved", x - 40, y - 40);
  await pen("mouseReleased", x - 80, y - 80);
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(3);
  const fullscreen = await page.getByRole("button", { name: "Use full screen" }).boundingBox();
  if (!fullscreen) throw new Error("Missing fullscreen control");
  const outsideX = fullscreen.x + fullscreen.width / 2;
  const outsideY = fullscreen.y + fullscreen.height / 2;
  expect(outsideY).toBeGreaterThan(742);
  await pen("mousePressed", outsideX, outsideY);
  await pen("mouseReleased", outsideX, outsideY);
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "active");
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(3);
  await session.detach();
});

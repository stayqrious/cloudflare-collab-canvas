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

async function calibrateNote(page: Page, horizontal: number, vertical: number) {
  await page.getByRole("button", { name: "Smart Note", exact: true }).click();
  const stage = await page.getByTestId("smart-note-stage").boundingBox();
  if (!stage) throw new Error("Missing calibration surface");
  const area = {
    x: stage.x + 30,
    y: stage.y + 30,
    width: Math.floor((stage.width - 60) * horizontal),
    height: Math.floor((stage.height - 60) * vertical),
  };
  await page.mouse.click(area.x, area.y);
  await expect(page.getByRole("status").filter({ hasText: "Step 2" })).toBeVisible();
  await page.mouse.click(area.x + area.width, area.y + area.height);
  await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "active");
  await expect(page.locator("#board-canvas")).toHaveAttribute("viewBox", "0 0 740 1050");
  await expect(page.locator("#board-canvas")).toHaveCSS("width", `${area.width}px`);
  return area;
}

function fraction(
  area: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
) {
  return { x: area.x + area.width * x, y: area.y + area.height * y };
}

test("Smart Note maps two students' different screens to identical shared strokes", async ({
  page,
  browser,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await createBoard(page, "Smart Note shared A5");
  const invitation = await createInvite(page);
  await closeAccessDrawer(page);
  const context = await browser.newContext({
    ...isolatedContextOptions(testInfo),
    viewport: { width: 1000, height: 760 },
  });
  try {
    const student = await context.newPage();
    await openInvite(student, invitation);
    const first = await calibrateNote(page, 0.6, 0.85);
    const second = await calibrateNote(student, 0.85, 0.7);
    await drag(page, fraction(first, 0.25, 0.25), fraction(first, 0.75, 0.75), { steps: 4 });
    await expect(student.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await drag(student, fraction(second, 0.25, 0.25), fraction(second, 0.75, 0.75), { steps: 4 });
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    const paths = await page
      .locator("#drawing-area path")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("d")));
    expect(paths).toHaveLength(2);
    expect(paths[0]).toEqual(paths[1]);
    expect(paths[0]).toContain("185");
    await page.mouse.move(first.x + 100, first.y + 100);
    await page.mouse.wheel(0, -500);
    await expect(page.locator("#board-canvas")).toHaveAttribute("viewBox", "0 0 740 1050");
    await page.screenshot({ path: "/tmp/smart-note-desktop.png" });
    await page.getByRole("button", { name: "Exit Smart Note" }).click();
    await expect(page.locator(".smart-note-dialog")).not.toBeVisible();
    await page.reload();
    await waitForBoard(page);
    await page.getByRole("button", { name: "Smart Note", exact: true }).click();
    await expect(page.getByRole("button", { name: "Use saved calibration" })).toBeEnabled();
    await page.getByRole("button", { name: "Use saved calibration" }).click();
    await expect(page.locator("#board-canvas")).toHaveAttribute("viewBox", "0 0 740 1050");
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator(".smart-note-dialog")).toHaveAttribute("data-state", "calibrating");
    await expect(page.getByRole("button", { name: "Use saved calibration" })).toBeDisabled();
  } finally {
    await context.close();
  }
});

test("Smart Note rejects invalid corners, ignores palms and ends strokes at the page edge", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  await page.setViewportSize({ width: 1100, height: 800 });
  await createBoard(page, "Smart Note boundaries");
  await expect(page).toHaveTitle(/Smart Note boundaries/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await page.getByRole("button", { name: "Smart Note", exact: true }).click();
  const stage = await page.getByTestId("smart-note-stage").boundingBox();
  if (!stage) throw new Error("Missing calibration surface");
  await page.mouse.click(stage.x + 200, stage.y + 200);
  await page.mouse.click(stage.x + 100, stage.y + 100);
  await expect(page.locator(".smart-note-status")).toContainText("Try the top-left again");
  await page.getByRole("button", { name: "Exit Smart Note" }).click();
  const area = await calibrateNote(page, 0.65, 0.8);
  // A hovering mouse and a pen have distinct pointer IDs on real tablets.
  await page.mouse.move(area.x + 10, area.y + 10);
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
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(0);
  await page.getByRole("button", { name: "Exit Smart Note" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Smart Note", exact: true }).click();
  await expect(page.getByTestId("smart-note-stage")).toBeVisible();
  await page.screenshot({ path: "/tmp/smart-note-mobile.png" });
  await page.getByRole("button", { name: "Exit Smart Note" }).click();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator("#board-canvas")).not.toHaveAttribute("viewBox", "0 0 740 1050");
  expect(errors).toEqual([]);
});

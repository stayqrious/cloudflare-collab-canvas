import { expect, test } from "@playwright/test";
import { createBoard, createInvite, isolatedContextOptions } from "./helpers";

test("viewer eye badges and pen cursors follow live role and tool changes", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "Mouse cursor interaction");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createBoard(page, "Cursor classroom");
  const invite = await createInvite(page, "viewer");
  await page.getByTestId("access-drawer").getByRole("button", { name: /Close/u }).click();
  const context = await browser.newContext(isolatedContextOptions(testInfo, 85));
  const student = await context.newPage();
  student.on("pageerror", (error) => errors.push(error.message));
  try {
    await student.goto(invite);
    const canvas = student.locator("#board-canvas");
    await expect(canvas).toHaveAttribute("data-ready", "true");
    await expect(canvas).toHaveAttribute("data-role", "viewer");
    await expect(student.getByTestId("tool-pencil")).toBeDisabled();
    await student.mouse.move(350, 270);
    const remote = page.locator(".participant-cursor");
    await expect(remote).toHaveAttribute("data-cursor", "viewer");
    await expect(remote.locator(".participant-cursor-viewer-badge")).toBeVisible();
    const viewerCursor = await canvas.evaluate((node) => getComputedStyle(node).cursor);
    expect(viewerCursor).toContain("data:image/svg+xml");
    expect(viewerCursor).toContain("1 3");

    await page.getByTestId("participants-button").click();
    const drawer = page.getByTestId("participant-drawer");
    await drawer.getByRole("combobox").selectOption("editor");
    await expect(canvas).toHaveAttribute("data-role", "editor");
    // The badge must disappear on the role update, even before the student moves again.
    await expect(remote.locator(".participant-cursor-viewer-badge")).toHaveCount(0);
    await student.getByTestId("tool-pencil").click();
    await student.mouse.move(350, 270);
    await expect(remote).toHaveAttribute("data-cursor", "pen");
    const penCursor = await canvas.evaluate((node) => getComputedStyle(node).cursor);
    expect(penCursor).toContain("data:image/svg+xml");
    expect(penCursor).toContain("3 28");
    expect(penCursor).not.toBe(viewerCursor);
    await student.mouse.down();
    await student.mouse.move(430, 310, { steps: 10 });
    await student.mouse.up();
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await expect(student.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    // A demoted student must show the eye, even if their last presence tool was Pencil.
    await drawer.getByRole("combobox").selectOption("viewer");
    await expect(remote).toHaveAttribute("data-cursor", "viewer");
    await expect(remote.locator(".participant-cursor-viewer-badge")).toBeVisible();
    await expect(student.getByTestId("tool-pencil")).toBeDisabled();
    await student.getByTestId("tool-pan").click();
    await expect(canvas).toHaveCSS("cursor", "grab");
    await student.getByTestId("tool-select").click();
    await expect(canvas).toHaveCSS("cursor", viewerCursor);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

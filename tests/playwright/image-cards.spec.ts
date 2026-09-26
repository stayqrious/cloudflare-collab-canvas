import { expect, type Page, test } from "@playwright/test";
import {
  canvasPoint,
  chooseMoreTool,
  closeAccessDrawer,
  createBoard,
  createInvite,
  expandToolPermissions,
  isolatedContextOptions,
  moveItem,
  openInvite,
  openMoreTools,
  waitForBoard,
} from "./helpers";

const PNG_FILE = {
  name: "classroom-image.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
};

async function enableImages(page: Page): Promise<void> {
  await page.getByTestId("settings-button").click();
  const drawer = page.getByTestId("settings-drawer");
  await expect(drawer).toBeVisible();
  await expandToolPermissions(page);
  // Images are on by default; the helper only confirms the setting and the tool are live.
  const toggle = drawer.getByRole("checkbox", { name: "Enable Images" });
  await expect(toggle).toBeChecked();
  await expect(page.getByTestId("tool-image")).toBeEnabled();
  await drawer.getByRole("button", { name: "Close settings" }).click();
  await expect(drawer).toBeHidden();
}

async function uploadWithPicker(page: Page): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await chooseMoreTool(page, "tool-image");
  await (await chooser).setFiles(PNG_FILE);
}

async function dispatchImageTransfer(
  page: Page,
  type: "paste" | "drop",
  point?: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    ({ base64, eventType, targetPoint }) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([bytes], "classroom-image.png", {
          type: "image/png",
          lastModified: 1,
        }),
      );
      if (eventType === "paste") {
        document.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: transfer,
          }),
        );
        return;
      }
      const canvas = document.querySelector("#board-canvas");
      if (!canvas || !targetPoint) throw new Error("Canvas drop target is unavailable.");
      canvas.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: targetPoint.x,
          clientY: targetPoint.y,
          dataTransfer: transfer,
        }),
      );
    },
    {
      base64: PNG_FILE.buffer.toString("base64"),
      eventType: type,
      targetPoint: point,
    },
  );
}

test("image cards converge, remain private, persist, and obey live classroom policy", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused Image Card QA runs in Chromium.");

  const boardUrl = await createBoard(page, "Image card lab");
  await expect(page.getByTestId("tool-image")).toBeEnabled();
  await enableImages(page);

  const editorInvite = await createInvite(page);
  await closeAccessDrawer(page);
  const viewerInvite = await createInvite(page, "viewer");
  await closeAccessDrawer(page);

  const editorContext = await browser.newContext(isolatedContextOptions(testInfo, 71));
  const viewerContext = await browser.newContext(isolatedContextOptions(testInfo, 72));
  const editor = await editorContext.newPage();
  const viewer = await viewerContext.newPage();

  try {
    await openInvite(editor, editorInvite);
    await viewer.goto(viewerInvite);
    await expect(viewer).toHaveURL(/\/b\/b_[A-Za-z\d_-]{22}$/u);
    await expect(viewer.getByTestId("board-shell")).toBeVisible();
    await expect(viewer.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    await expect(viewer.getByTestId("save-status")).toHaveAttribute("data-state", "readonly");
    await expect(editor.getByTestId("tool-image")).toBeEnabled();
    await expect(viewer.getByTestId("tool-image")).toBeDisabled();

    await uploadWithPicker(page);

    const ownerImages = page.locator("#drawing-area .board-item-image");
    const editorImages = editor.locator("#drawing-area .board-item-image");
    const viewerImages = viewer.locator("#drawing-area .board-item-image");
    await expect(ownerImages).toHaveCount(1);
    await expect(editorImages).toHaveCount(1);
    await expect(viewerImages).toHaveCount(1);
    await expect(ownerImages.first()).toHaveAttribute("data-image-state", "ready");
    await expect(editorImages.first()).toHaveAttribute("data-image-state", "ready");
    await expect(viewerImages.first()).toHaveAttribute("data-image-state", "ready");
    await expect(ownerImages.first()).toHaveAttribute("aria-label", "Board image");
    await expect(ownerImages.first().locator("image")).toHaveAttribute("href", /^blob:/u);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    const imageId = await ownerImages.first().getAttribute("data-item-id");
    expect(imageId).toBeTruthy();
    await expect(page.getByRole("button", { name: "Edit image alt text" })).toBeVisible();
    await page.getByRole("button", { name: "Edit image alt text" }).click();
    const altDialog = page.getByTestId("image-alt-dialog");
    await expect(altDialog).toBeVisible();
    await altDialog
      .getByRole("textbox", { name: /Alt text/u })
      .fill("Students compare a leaf under a microscope");
    await altDialog.getByRole("button", { name: "Save alt text" }).click();
    await expect(altDialog).toBeHidden();
    await expect(ownerImages.first()).toHaveAttribute(
      "aria-label",
      "Students compare a leaf under a microscope",
    );
    await expect(editorImages.first()).toHaveAttribute(
      "aria-label",
      "Students compare a leaf under a microscope",
    );

    const moved = await moveItem(page, ownerImages.first(), 44, 24);
    await expect(editor.locator(`[data-item-id="${imageId}"]`)).toHaveAttribute("transform", moved);
    await page.keyboard.press("Control+d");
    await expect(ownerImages).toHaveCount(2);
    await expect(editorImages).toHaveCount(2);
    await page.keyboard.press("Delete");
    await expect(ownerImages).toHaveCount(1);
    await expect(editorImages).toHaveCount(1);

    await page.reload();
    await waitForBoard(page);
    await expect(page.locator(`#drawing-area [data-item-id="${imageId}"]`)).toHaveCount(1);
    await expect(page.locator(`#drawing-area [data-item-id="${imageId}"]`)).toHaveAttribute(
      "data-image-state",
      "ready",
    );

    const fallbackContext = await browser.newContext(isolatedContextOptions(testInfo, 73));
    await fallbackContext.route("**/api/v1/boards/*/assets/*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "TEMPORARILY_UNAVAILABLE", message: "Asset unavailable" },
        }),
      }),
    );
    const fallbackViewer = await fallbackContext.newPage();
    try {
      await fallbackViewer.goto(viewerInvite);
      await expect(fallbackViewer.getByTestId("board-shell")).toBeVisible();
      const fallback = fallbackViewer.locator("#drawing-area .board-item-image");
      await expect(fallback).toHaveCount(1);
      await expect(fallback).toHaveAttribute("data-image-state", "error");
      await expect(fallback.locator("[data-image-fallback]")).toContainText("Image unavailable");
    } finally {
      await fallbackContext.close();
    }

    await page.getByTestId("settings-button").click();
    const drawer = page.getByTestId("settings-drawer");
    await expect(drawer).toBeVisible();
    await expandToolPermissions(page);
    await drawer.locator("button[data-policy='owner_only']").click();
    await expect(editor.getByTestId("tool-image")).toBeDisabled();
    await expect(page.getByTestId("tool-image")).toBeEnabled();

    await drawer.getByRole("checkbox", { name: "Enable Images" }).uncheck();
    await expect(page.getByTestId("tool-image")).toBeDisabled();
    await expect(editor.getByTestId("tool-image")).toBeDisabled();
    await expect(ownerImages).toHaveCount(1);
    await expect(viewerImages).toHaveCount(1);

    const boardId = new URL(boardUrl).pathname.split("/").at(-1);
    expect(boardId).toBeTruthy();
  } finally {
    await editorContext.close();
    await viewerContext.close();
  }
});

test("failed, offline, paste, drop, and responsive image flows stay usable", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused Image Card QA runs in Chromium.");

  await createBoard(page, "Image input paths");
  await enableImages(page);
  const images = page.locator("#drawing-area .board-item-image");

  await page.route("**/api/v1/boards/*/assets", (route) =>
    route.fulfill({
      status: 413,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "IMAGE_TOO_LARGE", message: "This image is too large for the board." },
      }),
    }),
  );
  await uploadWithPicker(page);
  await expect(page.getByTestId("toast-region")).toContainText(
    "This image is too large for the board.",
  );
  await expect(images).toHaveCount(0);
  await page.unroute("**/api/v1/boards/*/assets");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  });
  await dispatchImageTransfer(page, "paste");
  await expect(page.getByTestId("toast-region")).toContainText("Upload when reconnected.");
  await expect(images).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  await dispatchImageTransfer(page, "paste");
  await expect(images).toHaveCount(1);
  await expect(images.first()).toHaveAttribute("data-image-state", "ready");

  const dropPoint = await canvasPoint(page, 0.7, 0.68);
  await dispatchImageTransfer(page, "drop", dropPoint);
  await expect(images).toHaveCount(2);
  await expect(images.last()).toHaveAttribute("data-image-state", "ready");

  await page.setViewportSize({ width: 360, height: 640 });
  await openMoreTools(page);
  const imageTool = page.getByTestId("tool-image");
  await imageTool.scrollIntoViewIfNeeded();
  await expect(imageTool).toHaveAttribute("aria-label", "Add image (I)");

  const firstBounds = await images.first().boundingBox();
  expect(firstBounds).not.toBeNull();
  if (!firstBounds) return;
  await page.getByTestId("tool-select").click();
  await page.mouse.click(
    firstBounds.x + firstBounds.width / 2,
    firstBounds.y + firstBounds.height / 2,
  );
  await page.getByRole("button", { name: "Edit image alt text" }).click();
  const dialog = page.getByTestId("image-alt-dialog");
  await expect(dialog).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds?.x).toBeGreaterThanOrEqual(0);
  expect((dialogBounds?.x ?? 0) + (dialogBounds?.width ?? 0)).toBeLessThanOrEqual(360);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

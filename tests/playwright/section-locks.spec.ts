import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, createInvite, drag, isolatedContextOptions } from "./helpers";

test("an owner lock freezes a Section and every participant's contents", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused Section lock QA runs in Chromium.");

  const browserErrors: string[] = [];
  for (const target of [page]) {
    target.on("pageerror", (error) => browserErrors.push(error.message));
    target.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
  }

  const boardUrl = await createBoard(page, "Locked Section lab");
  const ownerSectionPoint = await canvasPoint(page, 0.52, 0.5);
  await page.getByTestId("tool-zone").click();
  await page.mouse.click(ownerSectionPoint.x, ownerSectionPoint.y);
  const titleEditor = page.getByTestId("zone-title-editor");
  await expect(titleEditor).toBeVisible();
  await titleEditor.fill("Independent review");
  await titleEditor.press("Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const inviteUrl = await createInvite(page, "editor");
  await page.getByRole("button", { name: "Close access panel" }).click();
  const editorContext = await browser.newContext(isolatedContextOptions(testInfo));
  const editor = await editorContext.newPage();
  editor.on("pageerror", (error) => browserErrors.push(error.message));
  editor.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await expect(page).toHaveTitle("Locked Section lab — SpaceScale");
    await expect(page.getByTestId("board-shell")).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await editor.goto(inviteUrl);
    await expect(editor.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    await expect(editor.locator("vite-error-overlay")).toHaveCount(0);
    const editorSectionPoint = await canvasPoint(editor, 0.52, 0.5);
    await editor.getByTestId("tool-sticky").click();
    await editor.mouse.click(editorSectionPoint.x - 90, editorSectionPoint.y - 45);
    const stickyEditor = editor.getByTestId("canvas-text-editor");
    await expect(stickyEditor).toBeVisible();
    await stickyEditor.fill("Student-owned response");
    await stickyEditor.press("Control+Enter");
    await expect(editor.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    const ownerSection = page.locator("#drawing-area .board-item-zone");
    const editorSection = editor.locator("#drawing-area .board-item-zone");
    const ownerSticky = page.locator("#drawing-area .board-item-sticky");
    const editorSticky = editor.locator("#drawing-area .board-item-sticky");
    await expect(ownerSticky).toHaveCount(1);
    await expect(editorSticky).toHaveCount(1);

    await page.getByRole("button", { name: /^Select/u }).click();
    const sectionTitleBounds = await ownerSection.locator(".zone-title").boundingBox();
    if (!sectionTitleBounds) throw new Error("The Section title has no rendered bounds.");
    await page.mouse.click(
      sectionTitleBounds.x + sectionTitleBounds.width / 2,
      sectionTitleBounds.y + sectionTitleBounds.height / 2,
    );
    const lockButton = page.getByRole("button", { name: "Lock Section", exact: true });
    await expect(lockButton).toBeVisible();
    await expect(lockButton.locator("svg")).toHaveCount(1);
    await expect(lockButton).toHaveAttribute("data-section-locked", "false");
    await lockButton.click();
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(ownerSection).toHaveAttribute("data-section-locked", "true");
    await expect(editorSection).toHaveAttribute("data-section-locked", "true");
    await expect(ownerSection.locator(".zone-lock-badge")).toBeVisible();
    await expect(page.locator("#selection-layer [data-resize-handle]")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/spacescale-section-locked.png" });

    const exported = (await page.evaluate(async (url) => {
      const boardId = new URL(url).pathname.split("/").at(-1);
      const response = await fetch(`/api/v1/boards/${boardId}/export.json`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      return response.json();
    }, boardUrl)) as {
      sections?: Array<{
        name: string;
        locked: boolean;
        memberItemIds: string[];
      }>;
    };
    expect(exported.sections).toContainEqual(
      expect.objectContaining({
        name: "Independent review",
        locked: true,
        memberItemIds: expect.arrayContaining([expect.any(String)]),
      }),
    );

    await editor.getByRole("button", { name: /^Select/u }).click();
    const editorStickyBounds = await editorSticky.boundingBox();
    if (!editorStickyBounds) throw new Error("The editor sticky has no rendered bounds.");
    const editorStickyCenter = {
      x: editorStickyBounds.x + editorStickyBounds.width / 2,
      y: editorStickyBounds.y + editorStickyBounds.height / 2,
    };
    await editor.mouse.click(editorStickyCenter.x, editorStickyCenter.y);
    await expect(editor.getByTestId("selection-actions")).toBeVisible();
    await expect(editor.getByRole("button", { name: "Copy selected items" })).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "Delete selected items" })).toHaveCount(0);
    await editor.keyboard.press("Control+d");
    await editor.keyboard.press("Delete");
    await expect(editor.locator("#drawing-area .board-item-sticky")).toHaveCount(1);
    const lockedTransform = await editorSticky.getAttribute("transform");
    await drag(editor, editorStickyCenter, {
      x: editorStickyCenter.x + 55,
      y: editorStickyCenter.y + 35,
    });
    await editor.waitForTimeout(250);
    expect(await editorSticky.getAttribute("transform")).toBe(lockedTransform);

    const ownerStickyBounds = await ownerSticky.boundingBox();
    if (!ownerStickyBounds) throw new Error("The owner view sticky has no rendered bounds.");
    await page.mouse.click(
      ownerStickyBounds.x + ownerStickyBounds.width / 2,
      ownerStickyBounds.y + ownerStickyBounds.height / 2,
    );
    await expect(page.getByRole("button", { name: "Copy selected items" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete selected items" })).toHaveCount(0);

    await page.mouse.click(
      sectionTitleBounds.x + sectionTitleBounds.width / 2,
      sectionTitleBounds.y + sectionTitleBounds.height / 2,
    );
    const unlockButton = page.getByRole("button", { name: "Unlock Section", exact: true });
    await expect(unlockButton).toBeVisible();
    await expect(unlockButton.locator("svg")).toHaveCount(1);
    await expect(unlockButton).toHaveAttribute("data-section-locked", "true");
    await unlockButton.click();
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(ownerSection).not.toHaveAttribute("data-section-locked", "true");
    await expect(editorSection).not.toHaveAttribute("data-section-locked", "true");

    await editor.mouse.click(editorStickyCenter.x, editorStickyCenter.y);
    const unlockedTransform = await editorSticky.getAttribute("transform");
    await drag(editor, editorStickyCenter, {
      x: editorStickyCenter.x + 55,
      y: editorStickyCenter.y + 35,
    });
    await expect.poll(() => editorSticky.getAttribute("transform")).not.toBe(unlockedTransform);
    await expect(editor.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    await page.screenshot({ path: "/tmp/spacescale-section-unlocked.png" });
    expect(browserErrors).toEqual([]);
  } finally {
    await editorContext.close();
  }
});
test("Section creation rejects foreign contained items without partial writes", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Focused Section permission QA runs in Chromium.",
  );

  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const boardUrl = await createBoard(page, "Foreign Section guard lab");
  const inviteUrl = await createInvite(page, "editor");
  await page.getByRole("button", { name: "Close access panel" }).click();
  const creatorContext = await browser.newContext(isolatedContextOptions(testInfo, 91));
  const sectionEditorContext = await browser.newContext(isolatedContextOptions(testInfo, 92));
  const creator = await creatorContext.newPage();
  const sectionEditor = await sectionEditorContext.newPage();
  for (const target of [creator, sectionEditor]) {
    target.on("pageerror", (error) => browserErrors.push(error.message));
    target.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
  }

  try {
    await creator.goto(inviteUrl);
    await sectionEditor.goto(inviteUrl);
    await expect(creator.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    await expect(sectionEditor.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    const point = await canvasPoint(creator, 0.52, 0.5);
    await creator.getByTestId("tool-sticky").click();
    await creator.mouse.click(point.x, point.y);
    const creatorText = creator.getByTestId("canvas-text-editor");
    await expect(creatorText).toBeVisible();
    await creatorText.fill("Foreign response");
    await creatorText.press("Control+Enter");
    await expect(creator.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    const foreignSticky = sectionEditor.locator("#drawing-area .board-item-sticky");
    await expect(foreignSticky).toHaveCount(1);
    const stickyBounds = await foreignSticky.boundingBox();
    if (!stickyBounds) throw new Error("The foreign sticky has no rendered bounds.");
    await sectionEditor.getByTestId("tool-zone").click();
    await sectionEditor.mouse.click(
      stickyBounds.x + stickyBounds.width / 2,
      stickyBounds.y + stickyBounds.height / 2,
    );

    await expect(sectionEditor.getByTestId("toast-region")).toContainText(
      "This Section would contain an item you cannot add to the Section.",
    );
    await expect(page.locator("#drawing-area .board-item-zone")).toHaveCount(0);
    await expect(creator.locator("#drawing-area .board-item-zone")).toHaveCount(0);
    await expect(sectionEditor.locator("#drawing-area .board-item-zone")).toHaveCount(0);
    await expect(sectionEditor.getByTestId("zone-title-editor")).not.toBeVisible();

    const exported = (await page.evaluate(async (url) => {
      const boardId = new URL(url).pathname.split("/").at(-1);
      const response = await fetch(`/api/v1/boards/${boardId}/export.json`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      return response.json();
    }, boardUrl)) as {
      sections?: Array<{ id: string }>;
      items: Array<{ kind: string; sectionId?: string }>;
    };
    expect(exported.sections).toEqual([]);
    expect(exported.items.find((item) => item.kind === "sticky")).not.toHaveProperty("sectionId");

    await sectionEditor.screenshot({
      path: "/tmp/spacescale-foreign-section-create-rejected.png",
    });
    expect(browserErrors).toEqual([]);
  } finally {
    await Promise.all([creatorContext.close(), sectionEditorContext.close()]);
  }
});

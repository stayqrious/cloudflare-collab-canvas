import { expect, type Page, test } from "@playwright/test";
import {
  canvasPoint,
  createBoard,
  createInvite,
  drag,
  drawShape,
  isolatedContextOptions,
} from "./helpers";

type RelationshipExport = {
  sections: Array<{ id: string; memberItemIds: string[] }>;
  items: Array<{
    id: string;
    kind: string;
    sectionId?: string;
    geometry?: { x: number; y: number; width: number; height: number };
  }>;
};

async function exportRelationships(
  page: Page,
  boardUrl: string,
): Promise<{ status: number; body: RelationshipExport }> {
  return page.evaluate(async (url) => {
    const boardId = new URL(url).pathname.split("/").at(-1);
    const response = await fetch(`/api/v1/boards/${boardId}/export.json`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return { status: response.status, body: (await response.json()) as RelationshipExport };
  }, boardUrl);
}

function captureBrowserErrors(page: Page, errors: string[]): void {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
}

test("translated copies and Section deletion keep exported membership current", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Focused Section membership lifecycle QA runs in Chromium.",
  );

  const browserErrors: string[] = [];
  captureBrowserErrors(page, browserErrors);
  const boardUrl = await createBoard(page, "Section membership lifecycle lab");
  await expect(page).toHaveTitle("Section membership lifecycle lab — SpaceScale");
  await expect(page.getByTestId("board-shell")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  const sectionPoint = await canvasPoint(page, 0.52, 0.5);
  await page.getByTestId("tool-zone").click();
  await page.mouse.click(sectionPoint.x, sectionPoint.y);
  const titleEditor = page.getByTestId("zone-title-editor");
  await expect(titleEditor).toBeVisible();
  await titleEditor.fill("Copy boundary");
  await titleEditor.press("Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const section = page.locator("#drawing-area .board-item-zone");
  await expect(section).toHaveCount(1);
  const sectionId = await section.getAttribute("data-item-id");
  const sectionBounds = await section.locator(".zone-fill").boundingBox();
  if (!sectionId || !sectionBounds) throw new Error("The Section was not rendered completely.");

  const original = await drawShape(
    page,
    "Rectangle",
    {
      x: sectionBounds.x + sectionBounds.width - 42,
      y: sectionBounds.y + sectionBounds.height * 0.46,
    },
    {
      x: sectionBounds.x + sectionBounds.width - 10,
      y: sectionBounds.y + sectionBounds.height * 0.56,
    },
  );
  const originalId = await original.getAttribute("data-item-id");
  if (!originalId) throw new Error("The original rectangle has no item ID.");

  const beforeCopy = await exportRelationships(page, boardUrl);
  expect(beforeCopy.status).toBe(200);
  expect(beforeCopy.body.items.find((item) => item.id === originalId)?.sectionId).toBe(sectionId);
  expect(
    beforeCopy.body.sections.find((candidate) => candidate.id === sectionId)?.memberItemIds,
  ).toContain(originalId);

  await page.getByRole("button", { name: /^Select/u }).click();
  const originalBounds = await original.boundingBox();
  if (!originalBounds) throw new Error("The original rectangle has no rendered bounds.");
  await page.mouse.click(
    originalBounds.x + originalBounds.width / 2,
    originalBounds.y + originalBounds.height / 2,
  );
  await expect(page.getByTestId("selection-actions")).toBeVisible();
  await page.keyboard.press("Control+d");
  await expect(page.locator("#drawing-area .board-item-rectangle")).toHaveCount(2);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const afterCopy = await exportRelationships(page, boardUrl);
  expect(afterCopy.status).toBe(200);
  const copiedItem = afterCopy.body.items.find(
    (item) => item.kind === "rectangle" && item.id !== originalId,
  );
  expect(copiedItem).toBeDefined();
  expect(copiedItem).not.toHaveProperty("sectionId");
  expect(
    afterCopy.body.sections.find((candidate) => candidate.id === sectionId)?.memberItemIds,
  ).toEqual([originalId]);
  await page.screenshot({ path: "/tmp/spacescale-copy-clears-section-membership.png" });

  const titleBounds = await section.locator(".zone-title").boundingBox();
  if (!titleBounds) throw new Error("The Section title has no rendered bounds.");
  await page.mouse.click(
    titleBounds.x + titleBounds.width / 2,
    titleBounds.y + titleBounds.height / 2,
  );
  await page.keyboard.press("Delete");
  await expect(page.locator("#drawing-area .board-item-zone")).toHaveCount(0);
  await expect(page.locator("#drawing-area .board-item-rectangle")).toHaveCount(2);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const afterDelete = await exportRelationships(page, boardUrl);
  expect(afterDelete.status).toBe(200);
  expect(afterDelete.body.sections).toEqual([]);
  expect(afterDelete.body.items.filter((item) => item.kind === "rectangle")).toHaveLength(2);
  for (const rectangle of afterDelete.body.items.filter((item) => item.kind === "rectangle")) {
    expect(rectangle).not.toHaveProperty("sectionId");
  }
  await page.screenshot({ path: "/tmp/spacescale-section-delete-clears-membership.png" });
  expect(browserErrors).toEqual([]);
});

test("Section deletion by its creator detaches foreign members without deleting them", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Focused Section deletion permission QA runs in Chromium.",
  );

  const browserErrors: string[] = [];
  captureBrowserErrors(page, browserErrors);
  const boardUrl = await createBoard(page, "Section deletion permission lab");
  const inviteUrl = await createInvite(page, "editor");
  await page.getByRole("button", { name: "Close access panel" }).click();
  const editorContext = await browser.newContext(isolatedContextOptions(testInfo, 93));
  const editor = await editorContext.newPage();
  captureBrowserErrors(editor, browserErrors);

  try {
    await editor.goto(inviteUrl);
    await expect(editor.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    await expect(editor.locator("vite-error-overlay")).toHaveCount(0);
    const sectionPoint = await canvasPoint(editor, 0.52, 0.5);
    await editor.getByTestId("tool-zone").click();
    await editor.mouse.click(sectionPoint.x, sectionPoint.y);
    const titleEditor = editor.getByTestId("zone-title-editor");
    await expect(titleEditor).toBeVisible();
    await titleEditor.fill("Editor Section");
    await titleEditor.press("Enter");
    await expect(editor.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    await expect(page.locator("#drawing-area .board-item-zone")).toHaveCount(1);
    const ownerPoint = await canvasPoint(page, 0.52, 0.5);
    await page.getByTestId("tool-sticky").click();
    await page.mouse.click(ownerPoint.x - 70, ownerPoint.y - 35);
    const stickyEditor = page.getByTestId("canvas-text-editor");
    await expect(stickyEditor).toBeVisible();
    await stickyEditor.fill("Owner response");
    await stickyEditor.press("Control+Enter");
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(editor.locator("#drawing-area .board-item-sticky")).toHaveCount(1);

    const editorSection = editor.locator("#drawing-area .board-item-zone");
    await editor.getByRole("button", { name: /^Select/u }).click();
    const titleBounds = await editorSection.locator(".zone-title").boundingBox();
    if (!titleBounds) throw new Error("The editor Section title has no rendered bounds.");
    await editor.mouse.click(
      titleBounds.x + titleBounds.width / 2,
      titleBounds.y + titleBounds.height / 2,
    );
    await editor.keyboard.press("Delete");
    await expect(editor.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    // The Section's creator may detach members they do not own, so the Section
    // goes away while the owner's sticky survives unparented on both clients.
    await expect(page.locator("#drawing-area .board-item-zone")).toHaveCount(0);
    await expect(editor.locator("#drawing-area .board-item-zone")).toHaveCount(0);
    await expect(page.locator("#drawing-area .board-item-sticky")).toHaveCount(1);
    await expect(editor.locator("#drawing-area .board-item-sticky")).toHaveCount(1);

    const exported = await exportRelationships(page, boardUrl);
    expect(exported.status).toBe(200);
    const sticky = exported.body.items.find((item) => item.kind === "sticky");
    expect(exported.body.sections).toEqual([]);
    expect(sticky).toBeDefined();
    expect(sticky?.sectionId).toBeUndefined();

    await editor.screenshot({
      path: "/tmp/spacescale-section-delete-foreign-member-detached.png",
    });
    expect(browserErrors).toEqual([]);
  } finally {
    await editorContext.close();
  }
});

test("a dragged Section covers the swept area and binds the items inside it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused Section drag QA runs in Chromium.");

  const browserErrors: string[] = [];
  captureBrowserErrors(page, browserErrors);
  const boardUrl = await createBoard(page, "Section drag lab");
  await expect(page.getByTestId("board-shell")).toBeVisible();

  const center = await canvasPoint(page, 0.5, 0.5);
  const enclosed = await drawShape(
    page,
    "Rectangle",
    { x: center.x - 30, y: center.y - 20 },
    { x: center.x + 30, y: center.y + 20 },
  );
  const enclosedId = await enclosed.getAttribute("data-item-id");
  if (!enclosedId) throw new Error("The enclosed rectangle has no item ID.");

  const sweep = { x: center.x - 150, y: center.y - 110, width: 300, height: 220 };
  await page.getByTestId("tool-zone").click();
  await drag(
    page,
    { x: sweep.x, y: sweep.y },
    { x: sweep.x + sweep.width, y: sweep.y + sweep.height },
  );

  const titleEditor = page.getByTestId("zone-title-editor");
  await expect(titleEditor).toBeVisible();
  await titleEditor.fill("Swept area");
  await titleEditor.press("Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const section = page.locator("#drawing-area .board-item-zone");
  await expect(section).toHaveCount(1);
  const sectionId = await section.getAttribute("data-item-id");
  const rendered = await section.locator(".zone-fill").boundingBox();
  if (!sectionId || !rendered) throw new Error("The dragged Section was not rendered completely.");

  // The Section covers what the pointer swept out, not the default-size drop.
  expect(Math.abs(rendered.x - sweep.x)).toBeLessThanOrEqual(4);
  expect(Math.abs(rendered.y - sweep.y)).toBeLessThanOrEqual(4);
  expect(Math.abs(rendered.width - sweep.width)).toBeLessThanOrEqual(4);
  expect(Math.abs(rendered.height - sweep.height)).toBeLessThanOrEqual(4);

  const exported = await exportRelationships(page, boardUrl);
  expect(exported.status).toBe(200);
  const exportedSection = exported.body.items.find((item) => item.id === sectionId);
  expect(exportedSection?.geometry?.width).not.toBe(520);
  expect(exportedSection?.geometry?.height).not.toBe(320);
  expect(exported.body.items.find((item) => item.id === enclosedId)?.sectionId).toBe(sectionId);
  expect(
    exported.body.sections.find((candidate) => candidate.id === sectionId)?.memberItemIds,
  ).toContain(enclosedId);
  expect(browserErrors).toEqual([]);
});

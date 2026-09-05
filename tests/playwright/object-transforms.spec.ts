import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  canvasPoint,
  chooseMoreTool,
  createBoard,
  drag,
  drawShape,
  expandToolPermissions,
  waitForBoard,
} from "./helpers";

const PNG_FILE = {
  name: "transform-test.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
};

async function selectItem(page: Page, item: Locator, expectHandles = true): Promise<void> {
  await page.getByRole("button", { name: /^Select/u }).click();
  const bounds = await item.boundingBox();
  if (!bounds) throw new Error("The transform target has no layout bounds.");
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  if (expectHandles) {
    await expect(page.locator("#selection-layer [data-scale-handle='southeast']")).toBeVisible();
    await expect(page.locator("#selection-layer [data-rotate-handle='object']")).toBeVisible();
  }
}

async function handlePoint(
  handle: Locator,
  targetSelector: string,
): Promise<{ x: number; y: number }> {
  return handle.evaluate((group, selector) => {
    const target = group.querySelector<SVGCircleElement>(selector);
    const point = target?.ownerSVGElement?.createSVGPoint();
    const matrix = target?.getScreenCTM();
    if (!target || !point || !matrix) throw new Error("The transform handle is not rendered.");
    point.x = target.cx.baseVal.value;
    point.y = target.cy.baseVal.value;
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  }, targetSelector);
}

async function scaleSelected(page: Page, item: Locator): Promise<string> {
  const before = (await item.getAttribute("transform")) ?? "";
  const handle = page.locator("#selection-layer [data-scale-handle='southeast']");
  const start = await handlePoint(handle, ".selection-scale-hit-target");
  await drag(page, start, { x: start.x + 72, y: start.y + 48 }, { steps: 10 });
  await expect.poll(() => item.getAttribute("transform")).not.toBe(before);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return (await item.getAttribute("transform")) ?? "";
}

async function rotateSelected(page: Page, item: Locator): Promise<string> {
  const before = (await item.getAttribute("transform")) ?? "";
  const bounds = await item.boundingBox();
  if (!bounds) throw new Error("The rotation target has no layout bounds.");
  const pivot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const handle = page.locator("#selection-layer [data-rotate-handle='object']");
  const start = await handlePoint(handle, ".selection-rotate-hit-target");
  const dx = start.x - pivot.x;
  const dy = start.y - pivot.y;
  await drag(page, start, { x: pivot.x - dy, y: pivot.y + dx }, { shift: true, steps: 10 });
  await expect.poll(() => item.getAttribute("transform")).not.toBe(before);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return (await item.getAttribute("transform")) ?? "";
}

async function exportRelationships(
  page: Page,
  boardId: string,
): Promise<{
  status: number;
  body: {
    sections: Array<{ id: string; memberItemIds: string[] }>;
    items: Array<{ id: string; sectionId?: string }>;
  };
}> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/boards/${id}/export.json`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        sections: Array<{ id: string; memberItemIds: string[] }>;
        items: Array<{ id: string; sectionId?: string }>;
      },
    };
  }, boardId);
}

test("scaling a shape outside a Section removes its exported membership", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused object transform QA runs in Chromium.");

  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const boardUrl = await createBoard(page, "Transform membership lab");
  await expect(page).toHaveTitle("Transform membership lab — SpaceScale");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  const sectionPoint = await canvasPoint(page, 0.52, 0.5);
  await page.getByTestId("tool-zone").click();
  await page.mouse.click(sectionPoint.x, sectionPoint.y);
  const titleEditor = page.getByTestId("zone-title-editor");
  await expect(titleEditor).toBeVisible();
  await titleEditor.fill("Scale boundary");
  await titleEditor.press("Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const section = page.locator("#drawing-area .board-item-zone");
  await expect(section).toHaveCount(1);
  const sectionId = await section.getAttribute("data-item-id");
  const sectionBounds = await section.locator(".zone-fill").boundingBox();
  if (!sectionId || !sectionBounds) throw new Error("The Section was not rendered completely.");

  const shape = await drawShape(
    page,
    "Rectangle",
    {
      x: sectionBounds.x + sectionBounds.width * 0.58,
      y: sectionBounds.y + sectionBounds.height * 0.42,
    },
    {
      x: sectionBounds.x + sectionBounds.width * 0.78,
      y: sectionBounds.y + sectionBounds.height * 0.62,
    },
  );
  const shapeId = await shape.getAttribute("data-item-id");
  const boardId = new URL(boardUrl).pathname.split("/").at(-1);
  if (!shapeId || !boardId) throw new Error("The shape or board identifier is unavailable.");

  const before = await exportRelationships(page, boardId);
  expect(before.status).toBe(200);
  expect(before.body.items.find((item) => item.id === shapeId)?.sectionId).toBe(sectionId);
  expect(
    before.body.sections.find((candidate) => candidate.id === sectionId)?.memberItemIds,
  ).toContain(shapeId);

  await selectItem(page, shape);
  const scaleHandle = page.locator("#selection-layer [data-scale-handle='southeast']");
  const scaleStart = await handlePoint(scaleHandle, ".selection-scale-hit-target");
  const transformBefore = await shape.getAttribute("transform");
  await drag(
    page,
    scaleStart,
    {
      x: sectionBounds.x + sectionBounds.width + 36,
      y: sectionBounds.y + sectionBounds.height * 0.82,
    },
    { steps: 12 },
  );
  await expect.poll(() => shape.getAttribute("transform")).not.toBe(transformBefore);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const after = await exportRelationships(page, boardId);
  expect(after.status).toBe(200);
  const exportedShape = after.body.items.find((item) => item.id === shapeId);
  expect(exportedShape).toBeDefined();
  expect(exportedShape).not.toHaveProperty("sectionId");
  expect(
    after.body.sections.find((candidate) => candidate.id === sectionId)?.memberItemIds,
  ).not.toContain(shapeId);

  await page.screenshot({ path: "/tmp/spacescale-object-transform-section-membership.png" });
  expect(browserErrors).toEqual([]);
});

test("shapes and images scale and rotate through persistent selection handles", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused object transform QA runs in Chromium.");

  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await createBoard(page, "Object transform lab");
  await expect(page).toHaveTitle("Object transform lab — SpaceScale");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  const start = await canvasPoint(page, 0.2, 0.25);
  const shape = await drawShape(page, "Rectangle", start, {
    x: start.x + 130,
    y: start.y + 84,
  });
  const shapeId = await shape.getAttribute("data-item-id");
  expect(shapeId).toBeTruthy();
  await selectItem(page, shape);
  await scaleSelected(page, shape);
  const shapeTransform = await rotateSelected(page, shape);

  await page.getByTestId("settings-button").click();
  const settings = page.getByTestId("settings-drawer");
  await expandToolPermissions(page);
  const imageToggle = settings.locator("input[data-feature='images']");
  await imageToggle.check();
  await settings.getByRole("button", { name: "Close settings" }).click();

  const chooser = page.waitForEvent("filechooser");
  await chooseMoreTool(page, "tool-image");
  await (await chooser).setFiles(PNG_FILE);
  const image = page.locator("#drawing-area .board-item-image");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("data-image-state", "ready");
  const imageId = await image.getAttribute("data-item-id");
  expect(imageId).toBeTruthy();
  await selectItem(page, image);
  await scaleSelected(page, image);
  const imageTransform = await rotateSelected(page, image);
  await page.screenshot({
    path: testInfo.outputPath("scaled-and-rotated-shape-and-image.png"),
  });

  await page.getByTestId("settings-button").click();
  const transformToggle = settings.locator("input[data-feature='objectTransforms']");
  await expandToolPermissions(page);
  await expect(transformToggle).toBeChecked();
  await transformToggle.uncheck();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await selectItem(page, image, false);
  await expect(page.locator("#selection-layer [data-scale-handle]")).toHaveCount(0);
  await expect(page.locator("#selection-layer [data-rotate-handle]")).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath("object-transforms-disabled.png"),
  });

  await page.reload();
  await waitForBoard(page);
  await expect(page.locator(`#drawing-area [data-item-id='${shapeId}']`)).toHaveAttribute(
    "transform",
    shapeTransform,
  );
  await expect(page.locator(`#drawing-area [data-item-id='${imageId}']`)).toHaveAttribute(
    "transform",
    imageTransform,
  );
  expect(browserErrors).toEqual([]);
});

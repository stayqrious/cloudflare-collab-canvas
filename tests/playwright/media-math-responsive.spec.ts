import { expect, test } from "@playwright/test";
import { canvasPoint, chooseMoreTool, createBoard } from "./helpers";

async function setRange(page: import("@playwright/test").Page, selector: string, value: number) {
  await page.locator(selector).evaluate((node, nextValue) => {
    const input = node as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

test("YouTube embeds move from their surrounding frame without blocking the player", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused video interaction QA runs in Chromium.");

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.context().route("https://www.youtube-nocookie.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Video preview</title>",
    }),
  );

  await createBoard(page, "Video drag frame");
  await chooseMoreTool(page, "tool-video");
  const videoDialog = page.getByRole("dialog", { name: "Embed a video" });
  await videoDialog.getByLabel("Video URL").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog).toBeHidden();

  const video = page.locator("#drawing-area .video-embed-item");
  await expect(video).toHaveCount(1);
  const player = video.locator("iframe");
  await expect(player).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  await player.evaluate((node) => {
    node.dataset.dragTestInstance = "original";
  });

  await page.getByTestId("tool-select").click();
  const frame = video.locator("[data-video-drag-frame]");
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveCSS("cursor", "grab");
  const bounds = await video.boundingBox();
  if (!bounds) throw new Error("The embedded video has no rendered bounds.");
  const start = { x: bounds.x + 2, y: bounds.y + bounds.height / 2 };
  const before = await video.getAttribute("transform");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 64, start.y + 36, { steps: 8 });
  await expect(page.locator("#local-preview-layer .move-preview")).toHaveCount(1);
  await page.mouse.up();

  await expect.poll(() => video.getAttribute("transform")).not.toBe(before);
  await expect(player).toHaveAttribute("data-drag-test-instance", "original");
  await expect(player).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await page.screenshot({ path: "/tmp/spacescale-video-drag-frame.png" });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("videos, MathJax text surfaces, and compact canvas controls work together", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Focused media and compact-layout QA runs in Chromium.",
  );

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.context().route("https://www.youtube-nocookie.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Video preview</title>",
    }),
  );

  const boardUrl = await createBoard(page, "Math and media canvas");
  const stickyPoint = await canvasPoint(page, 0.3, 0.32);
  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(stickyPoint.x, stickyPoint.y);
  const stickyEditor = page.getByTestId("canvas-text-editor");
  await expect(stickyEditor).toBeFocused();
  await stickyEditor.fill("Reference \\(\\text{https://example.com }\\)");
  await stickyEditor.press("Control+Enter");
  await expect(page.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".sticky-math-content")).toHaveAttribute("data-math-state", "ready");
  await expect(page.locator(".sticky-math-content mjx-container")).toHaveCount(1);
  await expect(page.locator(".sticky-math-content a")).toHaveCount(0);
  expect(await page.locator(".sticky-math-content").evaluate((node) => node.style.opacity)).toBe(
    "",
  );

  await page.getByRole("button", { name: "Comment on selected object" }).click();
  const comments = page.getByTestId("comments-drawer");
  await comments.getByRole("textbox", { name: "Comment" }).fill("Because \\(c\\) is constant.");
  await comments.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(comments.locator(".comment-body")).toHaveAttribute("data-math-state", "ready");
  await expect(comments.locator(".comment-body mjx-container")).toHaveCount(1);
  await comments.getByRole("button", { name: "Close comments" }).click();

  const textPoint = await canvasPoint(page, 0.68, 0.3);
  await page.getByTestId("tool-text").click();
  await page.mouse.click(textPoint.x, textPoint.y);
  const textEditor = page.getByTestId("canvas-text-editor");
  await textEditor.fill(
    "$$\\begin{pmatrix}\\frac{1}{2}\\\\\\frac{3}{4}\\\\\\frac{5}{6}\\\\\\frac{7}{8}\\end{pmatrix}$$ See https://example.com/math",
  );
  await textEditor.press("Enter");
  const freeMath = page.locator(".board-math-content");
  await expect(freeMath).toHaveAttribute("data-math-state", "ready");
  const mathSize = await freeMath.evaluate((content) => {
    const foreign = content.closest("foreignObject");
    const fontSize = Number.parseFloat((content as HTMLElement).style.fontSize);
    return {
      height: Number(foreign?.getAttribute("height")),
      initialHeight: fontSize * 2.2,
      scrollHeight: (content as HTMLElement).scrollHeight,
    };
  });
  expect(mathSize.height).toBeGreaterThan(mathSize.initialHeight);
  expect(mathSize.height).toBeGreaterThanOrEqual(mathSize.scrollHeight);
  expect(await freeMath.evaluate((node) => node.style.opacity)).toBe("1");
  await expect(freeMath.locator("a.board-text-link")).toHaveAttribute(
    "href",
    "https://example.com/math",
  );

  const renderedMathBox = await freeMath.locator("mjx-container").boundingBox();
  expect(renderedMathBox).not.toBeNull();
  await page.getByTestId("tool-select").click();
  await page.mouse.click(
    (renderedMathBox?.x ?? 0) + (renderedMathBox?.width ?? 0) / 2,
    (renderedMathBox?.y ?? 0) + Math.max(4, (renderedMathBox?.height ?? 0) - 4),
  );
  const selectionHeight = Number(await page.locator(".selection-outline").getAttribute("height"));
  expect(selectionHeight).toBeGreaterThanOrEqual(mathSize.height);

  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByRole("button", { name: "Reset zoom" })).toContainText("156%");
  const compactPoint = await canvasPoint(page, 0.5, 0.18);
  await page.getByTestId("tool-text").click();
  await page.mouse.click(compactPoint.x, compactPoint.y);
  const compactEditor = page.getByTestId("canvas-text-editor");
  await compactEditor.fill("\\(2x\\)");
  await compactEditor.press("Enter");
  const compactMath = page.locator(".board-math-content").last();
  await expect(compactMath).toHaveAttribute("data-math-state", "ready");
  const compactFormula = compactMath.locator("mjx-container");
  await expect(compactFormula).toHaveAttribute("role", "math");
  await expect(compactFormula).toHaveAttribute("aria-label", "Formula: 2x");
  const compactSize = await compactMath.evaluate((content) => {
    const foreign = content.closest("foreignObject");
    return {
      width: Number(foreign?.getAttribute("width")),
      height: Number(foreign?.getAttribute("height")),
      viewportWidth: foreign?.getBoundingClientRect().width ?? 0,
      scrollWidth: (content as HTMLElement).scrollWidth,
      scrollHeight: (content as HTMLElement).scrollHeight,
      initialHeight: Number.parseFloat((content as HTMLElement).style.fontSize) * 2.2,
    };
  });
  // The renderer adds three pixels beyond the measured advance width so italic overhangs and
  // whole-pixel rounding cannot clip the final glyph.
  expect(compactSize.width).toBe(Math.ceil(compactSize.scrollWidth + 3));
  expect(compactSize.width).toBeLessThan(180);
  expect(compactSize.viewportWidth).toBeGreaterThan(compactSize.width * 1.4);
  expect(compactSize.height).toBe(Math.ceil(compactSize.scrollHeight));
  expect(compactSize.height).toBeLessThan(compactSize.initialHeight);
  await page.getByRole("button", { name: "Reset zoom" }).click();
  await expect(page.getByRole("button", { name: "Reset zoom" })).toContainText("100%");

  const sectionPoint = await canvasPoint(page, 0.28, 0.68);
  await page.getByTestId("tool-zone").click();
  await page.mouse.click(sectionPoint.x, sectionPoint.y);
  const sectionTitle = page.getByTestId("zone-title-editor");
  await sectionTitle.fill("Results: \\(y=mx+b\\)");
  await sectionTitle.press("Enter");
  await expect(page.locator(".zone-math-content")).toHaveAttribute("data-math-state", "ready");
  expect(await page.locator(".zone-math-content").evaluate((node) => node.style.opacity)).toBe("");

  const section = page.locator("#drawing-area .board-item-zone");
  await expect(section).toHaveCount(1);
  const sectionBounds = await section.boundingBox();
  if (!sectionBounds) throw new Error("The MathJax Section has no rendered bounds.");
  const sectionItemId = await section.getAttribute("data-item-id");
  if (!sectionItemId) throw new Error("The MathJax Section has no item ID.");
  await page.getByTestId("tool-text").click();
  await page.mouse.click(
    sectionBounds.x + sectionBounds.width - 80,
    sectionBounds.y + sectionBounds.height / 2,
  );
  const compactSectionEditor = page.getByTestId("canvas-text-editor");
  await compactSectionEditor.fill("$$\\displaystyle x$$");
  await compactSectionEditor.press("Enter");
  const compactSectionMath = page.locator(".board-math-content").last();
  await expect(compactSectionMath).toHaveAttribute("data-math-state", "ready");
  const compactSectionItem = compactSectionMath.locator("xpath=ancestor::*[@data-item-id][1]");
  const compactSectionItemId = await compactSectionItem.getAttribute("data-item-id");
  if (!compactSectionItemId) throw new Error("The compact Section formula has no item ID.");
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ url, itemId }) => {
          const boardId = new URL(url).pathname.split("/").at(-1);
          const response = await fetch(`/api/v1/boards/${boardId}/export.json`, {
            credentials: "same-origin",
            cache: "no-store",
          });
          const body = (await response.json()) as {
            items: Array<{ id: string; sectionId?: string }>;
          };
          return body.items.find((candidate) => candidate.id === itemId)?.sectionId ?? null;
        },
        { url: boardUrl, itemId: compactSectionItemId },
      ),
    )
    .toBe(sectionItemId);

  await page.getByTestId("tool-text").click();
  await page.getByTestId("style-button").click();
  await setRange(page, "[data-style-font]", 8);
  await page.getByTestId("style-button").click();
  await page.mouse.click(sectionBounds.x + 20, sectionBounds.y + sectionBounds.height - 5);
  const boundaryEditor = page.getByTestId("canvas-text-editor");
  const boundaryFormula = "$$\\begin{matrix}x\\\\x\\\\x\\\\x\\\\x\\\\x\\end{matrix}$$";
  await boundaryEditor.fill(boundaryFormula);
  await boundaryEditor.press("Enter");
  const boundaryMath = page.locator(".board-math-content").last();
  await expect(boundaryMath).toHaveAttribute("data-math-state", "ready");
  const boundaryItem = boundaryMath.locator("xpath=ancestor::*[@data-item-id][1]");
  const boundaryItemId = await boundaryItem.getAttribute("data-item-id");
  if (!boundaryItemId) throw new Error("The boundary formula has no item ID.");
  const boundaryBox = await boundaryMath.evaluate((node) => {
    const bounds = node.closest("foreignObject")?.getBoundingClientRect();
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
  });
  expect(boundaryBox).not.toBeNull();
  expect((boundaryBox?.y ?? 0) + (boundaryBox?.height ?? 0)).toBeGreaterThan(
    sectionBounds.y + sectionBounds.height,
  );
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ url, itemId }) => {
          const boardId = new URL(url).pathname.split("/").at(-1);
          const response = await fetch(`/api/v1/boards/${boardId}/export.json`, {
            credentials: "same-origin",
            cache: "no-store",
          });
          const body = (await response.json()) as {
            items: Array<{ id: string; sectionId?: string }>;
          };
          const item = body.items.find((candidate) => candidate.id === itemId);
          return item === undefined ? "missing" : (item.sectionId ?? null);
        },
        { url: boardUrl, itemId: boundaryItemId },
      ),
    )
    .toBeNull();

  await chooseMoreTool(page, "tool-table");
  const picker = page.getByTestId("table-picker");
  await picker.getByLabel("Table columns").selectOption("2");
  await picker.getByLabel("Table rows").selectOption("2");
  await picker.getByRole("button", { name: "Choose placement" }).click();
  const tablePoint = await canvasPoint(page, 0.7, 0.68);
  await page.mouse.click(tablePoint.x, tablePoint.y);
  const table = page.locator("#drawing-area .board-item-table");
  await expect(table).toHaveCount(1);
  const firstCell = table.locator('[data-table-cell][data-table-row="0"][data-table-column="0"]');
  await firstCell.dblclick();
  const cellEditor = page.getByTestId("table-cell-editor");
  await cellEditor.fill("\\(x^2\\)");
  await cellEditor.press("Control+Enter");
  await expect(table.locator(".table-math-content")).toHaveAttribute("data-math-state", "ready");
  expect(await table.locator(".table-math-content").evaluate((node) => node.style.opacity)).toBe(
    "",
  );

  const urlTextPoint = await canvasPoint(page, 0.52, 0.5);
  await page.getByTestId("tool-text").click();
  await page.mouse.click(urlTextPoint.x, urlTextPoint.y);
  const urlEditor = page.getByTestId("canvas-text-editor");
  await urlEditor.fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await urlEditor.press("Enter");
  await expect(page.locator("#drawing-area .video-embed-item")).toHaveCount(0);
  await expect(page.locator("#drawing-area .board-text-link")).toHaveCount(2);

  await chooseMoreTool(page, "tool-video");
  const videoDialog = page.getByRole("dialog", { name: "Embed a video" });
  await videoDialog.getByLabel("Video URL").fill("https://example.com/not-supported");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog.getByRole("alert")).toContainText("HTTPS YouTube or Vimeo");
  await videoDialog.getByLabel("Video URL").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await videoDialog.getByRole("button", { name: "Embed video" }).click();
  await expect(videoDialog).toBeHidden();
  const video = page.locator("#drawing-area .video-embed-item");
  await expect(video).toHaveCount(1);
  const videoFrame = video.locator("iframe");
  await expect(videoFrame).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
  await expect(page.getByRole("button", { name: "Change selected element colour" })).toBeHidden();
  const videoHeading = video.locator(".video-embed-heading");
  await expect(videoHeading).toHaveAttribute("data-board-link", "true");
  await videoHeading.evaluate((node) => {
    node.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        node.setAttribute("data-clicked", "true");
      },
      { once: true },
    );
  });
  await videoHeading.click();
  await expect(videoHeading).toHaveAttribute("data-clicked", "true");

  await page.reload();
  await expect(page.locator("#drawing-area [data-math-state='ready']")).toHaveCount(7);
  await expect(page.locator("#drawing-area .video-embed-item")).toHaveCount(1);
  await expect(page.locator("#drawing-area .board-text-link")).toHaveCount(2);
  await page.getByTestId("tool-select").click();
  const videoDragFrame = video.locator("[data-video-drag-frame]");
  await expect(videoDragFrame).toHaveCount(1);
  const frameBox = await videoDragFrame.boundingBox();
  if (!frameBox) throw new Error("The embedded video drag frame has no rendered bounds.");
  const dragStart = { x: frameBox.x + 2, y: frameBox.y + frameBox.height / 2 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 20, dragStart.y + 10);
  const videoMovePreview = page.locator(
    "#local-preview-layer .move-preview.video-embed-preview-item",
  );
  await expect(videoMovePreview).toHaveCount(1);
  await expect(videoMovePreview.locator("iframe")).toHaveCount(0);
  await expect(videoMovePreview.locator(".video-embed-preview")).toHaveText("Video preview");
  await page.mouse.up();

  await page.setViewportSize({ width: 840, height: 640 });
  await expect(page.locator(".comments-button-label")).toBeHidden();
  await expect(page.locator(".access-button-label")).toBeHidden();
  await expect(page.locator(".wide-label")).toBeHidden();
  const placement = await page.evaluate(() => {
    const zoom = document.querySelector(".zoom-controls")?.getBoundingClientRect();
    const rail = document.querySelector(".tool-rail")?.getBoundingClientRect();
    if (!zoom || !rail) return null;
    return { zoomTop: zoom.top, zoomBottom: zoom.bottom, railTop: rail.top };
  });
  expect(placement).not.toBeNull();
  expect(placement?.zoomTop).toBeLessThan(100);
  expect(placement?.zoomBottom).toBeLessThan(placement?.railTop ?? 0);
  await page.screenshot({ path: "/tmp/spacescale-media-math-responsive.png" });
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, drawShape, moveItem, openSettingsDrawer } from "./helpers";

const PNG_FILE = {
  name: "worked-example.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
};

test("object comments follow moves, hide after orphaning, and resolve", async ({
  page,
}, testInfo) => {
  test.skip(
    !["chromium", "mobile-chromium"].includes(testInfo.project.name),
    "Focused comment lifecycle runs in Chromium.",
  );

  const browserProblems: string[] = [];
  page.on("pageerror", (error) => browserProblems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      browserProblems.push(message.text());
    }
  });

  await createBoard(page, "Comment review");
  await expect(page).toHaveTitle("Comment review — SpaceScale");
  await expect(page.getByTestId("board-shell")).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  const start = await canvasPoint(page, 0.32, 0.38);
  const shape = await drawShape(page, "Rectangle", start, {
    x: start.x + 130,
    y: start.y + 88,
  });
  const shapeBounds = await shape.boundingBox();
  if (!shapeBounds) throw new Error("The comment target has no layout bounds.");
  await page.getByRole("button", { name: /^Select/u }).click();
  await page.mouse.click(
    shapeBounds.x + shapeBounds.width / 2,
    shapeBounds.y + shapeBounds.height / 2,
  );
  await page.getByRole("button", { name: "Comment on selected object" }).click();

  const drawer = page.getByTestId("comments-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("textbox", { name: "Comment" }).fill("Align this object with the title.");
  await drawer.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(drawer.locator(".comment-card")).toHaveCount(1);
  await expect(drawer.locator(".comment-card")).toHaveAttribute("data-state", "open");
  await expect(drawer.locator(".comment-body")).toHaveText("Align this object with the title.");

  const marker = page.locator("#comment-layer .comment-marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("aria-label", "1 open comment on this object");
  const originalMarkerPosition = await marker.locator("circle").evaluate((node) => ({
    cx: node.getAttribute("cx"),
    cy: node.getAttribute("cy"),
  }));

  // The marker opens that object's comments alone: no composer, no other threads.
  await drawer.getByRole("button", { name: "Close comments" }).click();
  await expect(drawer).toBeHidden();
  await marker.click();
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute("data-focus", "object");
  await expect(drawer.locator("[data-comment-composer]")).toBeHidden();
  await expect(drawer.getByRole("checkbox", { name: "Show resolved & orphaned" })).toBeHidden();
  await expect(drawer.locator(".comment-card")).toHaveCount(1);
  await expect(drawer.locator("h2")).toHaveText("Rectangle object");
  // Settings widens the same drawer back to every comment.
  await openSettingsDrawer(page);
  await page.getByTestId("comments-button").click();
  await expect(drawer).toHaveAttribute("data-focus", "all");
  await expect(drawer.getByRole("checkbox", { name: "Show resolved & orphaned" })).toBeVisible();

  await drawer.getByRole("button", { name: "Close comments" }).click();
  await moveItem(page, shape, 76, 44);
  await expect
    .poll(() =>
      marker.locator("circle").evaluate((node) => ({
        cx: node.getAttribute("cx"),
        cy: node.getAttribute("cy"),
      })),
    )
    .not.toEqual(originalMarkerPosition);

  await page.keyboard.press("Delete");
  await expect(shape).toHaveCount(0);
  await expect(marker).toHaveCount(0);
  await openSettingsDrawer(page);
  await page.getByTestId("comments-button").click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".comment-card")).toHaveCount(0);
  await expect(page.locator("[data-comments-count]")).toBeHidden();

  await drawer.getByRole("checkbox", { name: "Show resolved & orphaned" }).check();
  const hiddenComment = drawer.locator(".comment-card");
  await expect(hiddenComment).toHaveCount(1);
  await expect(hiddenComment).toHaveAttribute("data-state", "orphaned");
  await expect(hiddenComment).toContainText("Deleted object");
  await page.screenshot({
    path: `/tmp/spacescale-comments-orphaned-${testInfo.project.name}.png`,
    fullPage: false,
  });

  await hiddenComment.getByRole("button", { name: "Resolve" }).click();
  await expect(hiddenComment).toHaveAttribute("data-state", "resolved");
  await drawer.getByRole("checkbox", { name: "Show resolved & orphaned" }).uncheck();
  await expect(drawer.locator(".comment-card")).toHaveCount(0);
  expect(browserProblems).toEqual([]);
});

test("a comment can carry a video and a picture", async ({ page }, testInfo) => {
  test.skip(
    !["chromium", "mobile-chromium"].includes(testInfo.project.name),
    "Comment media runs in Chromium.",
  );

  await createBoard(page, "Comment media");
  const start = await canvasPoint(page, 0.34, 0.4);
  const shape = await drawShape(page, "Rectangle", start, { x: start.x + 140, y: start.y + 92 });
  const bounds = await shape.boundingBox();
  if (!bounds) throw new Error("The comment target has no layout bounds.");
  await page.getByRole("button", { name: /^Select/u }).click();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.getByRole("button", { name: "Comment on selected object" }).click();

  const drawer = page.getByTestId("comments-drawer");
  await expect(drawer).toBeVisible();

  // A video rides along as a link the class can play in the drawer.
  await drawer.getByTestId("comment-add-video").click();
  const videoField = drawer.locator("[data-comment-video-field]");
  await videoField.getByRole("textbox").fill("not a video");
  await videoField.getByRole("button", { name: "Attach video" }).click();
  await expect(videoField.locator("[data-comment-video-error]")).toContainText("YouTube or Vimeo");
  await videoField.getByRole("textbox").fill("https://youtu.be/dQw4w9WgXcQ");
  await videoField.getByRole("button", { name: "Attach video" }).click();
  await expect(drawer.getByTestId("comment-attachment")).toContainText("YouTube video attached");
  await drawer.getByRole("textbox", { name: "Comment" }).fill("Watch this before step three.");
  await drawer.getByRole("button", { name: "Comment", exact: true }).click();

  const videoCard = drawer.locator(".comment-card").filter({ hasText: "step three" });
  await expect(videoCard.locator(".comment-media-video-link")).toHaveAttribute(
    "href",
    "https://youtu.be/dQw4w9WgXcQ",
  );
  await expect(drawer.getByTestId("comment-attachment")).toBeHidden();
  await videoCard.getByRole("button", { name: "Play video here" }).click();
  await expect(videoCard.locator("iframe")).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
  await videoCard.getByRole("button", { name: "Stop video" }).click();
  await expect(videoCard.locator("iframe")).toHaveCount(0);

  // A picture goes through the board's own upload, then hangs under the comment text.
  const chooser = page.waitForEvent("filechooser");
  await drawer.getByTestId("comment-add-image").click();
  await (await chooser).setFiles(PNG_FILE);
  await expect(drawer.getByTestId("comment-attachment")).toContainText("Image attached");
  await drawer.getByRole("textbox", { name: "Describe the image" }).fill("A worked example");
  await drawer.getByRole("textbox", { name: "Comment" }).fill("Here is the same step worked out.");
  await drawer.getByRole("button", { name: "Comment", exact: true }).click();

  const imageCard = drawer.locator(".comment-card").filter({ hasText: "worked out" });
  const picture = imageCard.locator("img");
  await expect(picture).toHaveAttribute("alt", "A worked example");
  await expect
    .poll(() => picture.evaluate((node: HTMLImageElement) => node.currentSrc.length > 0))
    .toBe(true);
  await expect(imageCard.locator("figcaption")).toHaveText("A worked example");
});

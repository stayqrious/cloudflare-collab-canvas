import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, drag } from "./helpers";

test("named Sections, grouped movement, typography, links, and export relationships", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused grouped Section QA runs in Chromium.");

  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const boardUrl = await createBoard(page, "Grouped Section lab");
  await expect(page).toHaveTitle("Grouped Section lab — SpaceScale");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);

  const sectionPoint = await canvasPoint(page, 0.52, 0.5);
  await page.getByTestId("tool-zone").click();
  await page.mouse.click(sectionPoint.x, sectionPoint.y);
  const titleEditor = page.getByTestId("zone-title-editor");
  await expect(titleEditor).toBeVisible();
  await titleEditor.fill("Research questions");
  await titleEditor.press("Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const section = page.locator("#drawing-area .board-item-zone");
  await expect(section).toHaveCount(1);
  await expect(section.locator(".zone-title")).toContainText("Research questions");
  const sectionId = await section.getAttribute("data-item-id");
  expect(sectionId).toBeTruthy();

  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(sectionPoint.x - 90, sectionPoint.y - 45);
  const stickyEditor = page.getByTestId("canvas-text-editor");
  await expect(stickyEditor).toBeVisible();
  await stickyEditor.fill("Read https://example.com/questions, then respond");
  await stickyEditor.press("Control+Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const sticky = page.locator("#drawing-area .board-item-sticky");
  await expect(sticky).toHaveCount(1);
  const stickyId = await sticky.getAttribute("data-item-id");
  expect(stickyId).toBeTruthy();
  const link = sticky.locator("a[data-board-link]");
  await expect(link).toHaveAttribute("href", "https://example.com/questions");
  await expect(link).toHaveAttribute("target", "_blank");
  await page
    .context()
    .route("https://example.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "Linked question" }),
    );
  const [linkedPage] = await Promise.all([page.waitForEvent("popup"), link.click()]);
  await expect(linkedPage).toHaveURL("https://example.com/questions");
  await linkedPage.close();
  await page.context().unroute("https://example.com/**");

  await page.getByRole("button", { name: /^Select/u }).click();
  const stickyBounds = await sticky.boundingBox();
  if (!stickyBounds) throw new Error("The sticky does not have rendered bounds.");
  await page.mouse.click(stickyBounds.x + 12, stickyBounds.y + 12);
  const selectionActions = page.getByTestId("selection-actions");
  await expect(selectionActions).toBeVisible();
  await expect(selectionActions.locator("[data-selection-font-controls]")).toBeHidden();
  await expect(
    selectionActions.getByRole("button", { name: "Change selected element colour" }),
  ).toBeVisible();

  const sectionTitleBounds = await section.locator(".zone-title").boundingBox();
  if (!sectionTitleBounds) throw new Error("The Section title does not have rendered bounds.");
  await page.mouse.click(
    sectionTitleBounds.x + sectionTitleBounds.width / 2,
    sectionTitleBounds.y + sectionTitleBounds.height / 2,
  );
  await expect(page.locator("#selection-layer [data-resize-handle='southeast']")).toBeVisible();
  const sectionTitle = section.locator(".zone-title");
  // Section titles are bold by default, so the first press turns bold off.
  const sectionBold = selectionActions.getByRole("button", { name: "Bold" });
  await expect(sectionBold).toHaveAttribute("aria-pressed", "true");
  await sectionBold.click();
  await expect(sectionBold).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(sectionTitle).toHaveAttribute("font-weight", "normal");
  await sectionBold.click();
  await expect(sectionBold).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(sectionTitle).toHaveAttribute("font-weight", "700");

  const sectionBefore = await section.getAttribute("transform");
  const stickyBefore = await sticky.getAttribute("transform");
  const sectionGrab = {
    x: sectionTitleBounds.x + sectionTitleBounds.width / 2,
    y: sectionTitleBounds.y + sectionTitleBounds.height / 2,
  };
  await drag(page, sectionGrab, { x: sectionGrab.x + 68, y: sectionGrab.y + 42 });
  await expect.poll(() => section.getAttribute("transform")).not.toBe(sectionBefore);
  await expect.poll(() => sticky.getAttribute("transform")).not.toBe(stickyBefore);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  await page.keyboard.press("Control+d");
  await expect(page.locator("#drawing-area .board-item-zone")).toHaveCount(2);
  await expect(page.locator("#drawing-area .board-item-sticky")).toHaveCount(2);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const stickies = page.locator("#drawing-area .board-item-sticky");
  const firstBounds = await stickies.nth(0).boundingBox();
  const secondBounds = await stickies.nth(1).boundingBox();
  if (!firstBounds || !secondBounds) throw new Error("Copied stickies are not rendered.");
  await page.mouse.click(firstBounds.x + 12, firstBounds.y + 12);
  await page.keyboard.down("Shift");
  await page.mouse.click(secondBounds.x + 12, secondBounds.y + 12);
  await page.keyboard.up("Shift");
  const groupButton = page.getByRole("button", { name: "Group selected items" });
  await expect(groupButton).toBeVisible();
  await groupButton.click();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(page.getByRole("button", { name: "Ungroup selected items" })).toBeVisible();

  const firstGroupTransform = await stickies.nth(0).getAttribute("transform");
  const secondGroupTransform = await stickies.nth(1).getAttribute("transform");
  await drag(
    page,
    { x: firstBounds.x + 12, y: firstBounds.y + 12 },
    { x: firstBounds.x + 48, y: firstBounds.y + 36 },
  );
  await expect.poll(() => stickies.nth(0).getAttribute("transform")).not.toBe(firstGroupTransform);
  await expect.poll(() => stickies.nth(1).getAttribute("transform")).not.toBe(secondGroupTransform);
  await page.keyboard.press("Control+d");
  await expect(page.locator("#drawing-area .board-item-sticky")).toHaveCount(4);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const boardId = new URL(boardUrl).pathname.split("/").at(-1);
  expect(boardId).toBeTruthy();
  const exported = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/boards/${id}/export.json`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return { status: response.status, body: await response.json() };
  }, boardId);
  expect(exported.status).toBe(200);
  const body = exported.body as {
    sections: Array<{ id: string; name: string; memberItemIds: string[] }>;
    items: Array<{ id: string; kind: string; groupId?: string; sectionId?: string }>;
  };
  expect(body.sections).toHaveLength(2);
  expect(body.sections).toContainEqual(
    expect.objectContaining({
      id: sectionId,
      name: "Research questions",
    }),
  );
  const exportedSticky = body.items.find((item) => item.id === stickyId);
  expect(exportedSticky?.sectionId).toBeTruthy();
  expect(body.sections).toContainEqual(
    expect.objectContaining({
      id: exportedSticky?.sectionId,
      memberItemIds: expect.arrayContaining([stickyId]),
    }),
  );
  for (const sectionSummary of body.sections) {
    expect([...sectionSummary.memberItemIds].sort()).toEqual(
      body.items
        .filter((item) => item.sectionId === sectionSummary.id)
        .map((item) => item.id)
        .sort(),
    );
  }
  const groupedStickies = body.items.filter((item) => item.kind === "sticky" && item.groupId);
  const groupIds = new Set(groupedStickies.flatMap((item) => (item.groupId ? [item.groupId] : [])));
  expect(groupedStickies).toHaveLength(4);
  expect([...groupIds]).toHaveLength(2);

  await page.screenshot({ path: "/tmp/spacescale-grouped-sections-rich-text.png" });
  expect(browserErrors).toEqual([]);
});

import { expect, type Page, test } from "@playwright/test";
import {
  canvasPoint,
  closeAccessDrawer,
  createBoard,
  createInvite,
  isolatedContextOptions,
  moveItem,
  openInvite,
  waitForBoard,
} from "./helpers";

type TouchPointerStep = {
  type: "pointerdown" | "pointermove" | "pointerup";
  pointerId: number;
  x: number;
  y: number;
  primary?: boolean;
};

async function dispatchTouchSteps(page: Page, steps: TouchPointerStep[]): Promise<void> {
  await page.locator("#board-canvas").evaluate((node, touchSteps) => {
    const canvas = node as SVGSVGElement;
    const capturedPointers = new Set<number>();
    Object.defineProperties(canvas, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.add(pointerId),
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.has(pointerId),
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointers.delete(pointerId),
      },
    });
    for (const step of touchSteps) {
      canvas.dispatchEvent(
        new PointerEvent(step.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: step.pointerId,
          pointerType: "touch",
          isPrimary: step.primary ?? false,
          clientX: step.x,
          clientY: step.y,
          button: 0,
          buttons: step.type === "pointerup" ? 0 : 1,
          pressure: step.type === "pointerup" ? 0 : 0.5,
        }),
      );
    }
  }, steps);
}

test("sticky notes focus, converge, persist, export safely, and remain editable", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "mobile-chromium" || testInfo.project.name === "ipad-webkit",
    "This desktop scenario uses mouse and keyboard interactions; touch has its own scenario below.",
  );

  const boardUrl = await createBoard(page, "Sticky classroom");
  const inviteUrl = await createInvite(page);
  await closeAccessDrawer(page);
  const collaboratorContext = await browser.newContext(isolatedContextOptions(testInfo, 41));
  const collaborator = await collaboratorContext.newPage();

  try {
    await openInvite(collaborator, inviteUrl);
    // Editors may only edit their own work, so the collaborator authors the sticky
    // and the owner (who may edit anything) updates it below.
    const canvas = collaborator.locator("#board-canvas");
    await canvas.focus();
    await collaborator.keyboard.press("n");
    await expect(collaborator.getByTestId("tool-sticky")).toHaveAttribute("aria-pressed", "true");
    const stickyStyle = collaborator.getByTestId("style-popover");
    await expect(stickyStyle).toBeVisible();
    await expect(stickyStyle.locator("[data-style-opacity-row]")).toBeHidden();
    await expect(stickyStyle.locator("[data-style-font-row]")).toBeHidden();
    await collaborator.getByRole("button", { name: "Use coral sticky notes" }).click();
    await expect(
      collaborator.getByRole("button", { name: "Use coral sticky notes" }),
    ).toHaveAttribute("aria-pressed", "true");

    const point = await canvasPoint(collaborator, 0.34, 0.38);
    await collaborator.mouse.click(point.x, point.y);
    const createEditor = collaborator.getByTestId("canvas-text-editor");
    await expect(createEditor).toBeVisible();
    await expect(createEditor).toBeFocused();
    await expect(createEditor).toHaveAttribute("data-editor-kind", "sticky");
    await expect(createEditor).toHaveAttribute("aria-label", "Add sticky note");
    const coachText =
      "<script> & coach prompt asks every learner to share one thoughtful classroom idea";
    await createEditor.evaluate((node, value) => {
      const editor = node as HTMLTextAreaElement;
      editor.value = `${value}\u000b`;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }, coachText);
    await createEditor.press("Control+Enter");
    await expect(createEditor).toBeVisible();
    await expect(createEditor).toBeFocused();
    await expect(createEditor).toHaveValue(`${coachText}\u000b`);
    await createEditor.fill(coachText);
    await createEditor.press("Control+Enter");
    await expect(collaborator.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");
    await expect(createEditor).toHaveCount(0);
    await collaborator.mouse.click(point.x + 230, point.y + 160);
    await expect(collaborator.getByTestId("canvas-text-editor")).toHaveCount(0);

    const ownerSticky = page.locator("#drawing-area .board-item-sticky");
    const collaboratorSticky = collaborator.locator("#drawing-area .board-item-sticky");
    await expect(ownerSticky).toHaveCount(1);
    await expect(collaboratorSticky).toHaveCount(1);
    await expect(collaboratorSticky.locator(".sticky-background")).toHaveAttribute(
      "fill",
      "#ffafa3",
    );
    await expect(ownerSticky.locator(".sticky-background")).toHaveAttribute("fill", "#ffafa3");
    await expect(collaborator.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    const stickyId = await collaboratorSticky.getAttribute("data-item-id");
    expect(stickyId).toBeTruthy();
    await expect(ownerSticky).toHaveAttribute("data-item-id", stickyId ?? "");

    const ownerBounds = await ownerSticky.boundingBox();
    expect(ownerBounds).not.toBeNull();
    if (!ownerBounds) throw new Error("The owner sticky has no layout bounds.");
    await page.getByRole("button", { name: /^Select/u }).click();
    await page.mouse.dblclick(
      ownerBounds.x + ownerBounds.width / 2,
      ownerBounds.y + ownerBounds.height / 2,
    );
    const editEditor = page.getByTestId("canvas-text-editor");
    await expect(editEditor).toBeFocused();
    await expect(editEditor).toHaveAttribute("aria-label", "Edit sticky note");
    await expect(editEditor).toHaveValue(coachText);
    const studentText =
      "<script> & student update connects this idea to a deliberately long classroom reflection";
    await editEditor.fill(studentText);
    await editEditor.press("Control+Enter");
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect
      .poll(async () => {
        const [ownerText, collaboratorText] = await Promise.all([
          ownerSticky.locator(".sticky-text").textContent(),
          collaboratorSticky.locator(".sticky-text").textContent(),
        ]);
        return ownerText === collaboratorText && ownerText?.includes("studentupdateconnects");
      })
      .toBe(true);

    await page.reload();
    await waitForBoard(page);
    const persisted = page.locator(`#drawing-area [data-item-id="${stickyId}"]`);
    await expect(persisted).toHaveCount(1);
    const persistedBounds = await persisted.boundingBox();
    expect(persistedBounds).not.toBeNull();
    if (!persistedBounds) throw new Error("The persisted sticky has no layout bounds.");
    await page.getByRole("button", { name: /^Select/u }).click();
    await page.mouse.dblclick(
      persistedBounds.x + persistedBounds.width / 2,
      persistedBounds.y + persistedBounds.height / 2,
    );
    const persistedEditor = page.getByTestId("canvas-text-editor");
    await expect(persistedEditor).toHaveValue(studentText);
    await persistedEditor.press("Escape");

    const boardId = new URL(boardUrl).pathname.split("/").at(-1);
    expect(boardId).toBeTruthy();
    const svgExport = await page.evaluate(async (id) => {
      const response = await fetch(`/api/v1/boards/${id}/export.svg`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      return { status: response.status, body: await response.text() };
    }, boardId);
    expect(svgExport.status).toBe(200);
    expect(svgExport.body).toContain(`sticky-clip-${stickyId}`);
    expect(svgExport.body).toContain("&lt;script&gt; &amp;");
    expect(svgExport.body).not.toContain("<script>");
    expect(svgExport.body.match(/<tspan /gu)?.length ?? 0).toBeGreaterThan(1);

    await page.getByRole("button", { name: /^Select/u }).click();
    await page.mouse.click(
      persistedBounds.x + persistedBounds.width / 2,
      persistedBounds.y + persistedBounds.height / 2,
    );
    const selectionActions = page.getByTestId("selection-actions");
    await expect(selectionActions).toBeVisible();
    await expect(selectionActions.locator("[data-selection-font-controls]")).toBeHidden();
    await expect(selectionActions.locator("[data-selection-current-colour]")).toHaveCSS(
      "background-color",
      "rgb(255, 175, 163)",
    );
    await expect(selectionActions.getByRole("button", { name: "Copy selected items" })).toHaveCount(
      0,
    );
    await expect(
      selectionActions.getByRole("button", { name: "Delete selected items" }),
    ).toHaveCount(0);
    await expect(
      selectionActions.getByRole("button", { name: "Comment on selected object" }).locator("svg"),
    ).toHaveCount(1);
    await page.keyboard.press("F2");
    const keyboardEditor = page.getByTestId("canvas-text-editor");
    await expect(keyboardEditor).toBeFocused();
    await expect(keyboardEditor).toHaveAttribute("aria-label", "Edit sticky note");
    await expect(keyboardEditor).toHaveValue(studentText);
    await keyboardEditor.press("Escape");

    await page.mouse.click(
      persistedBounds.x + persistedBounds.width / 2,
      persistedBounds.y + persistedBounds.height / 2,
    );
    await page.keyboard.press("Control+d");
    await expect(page.locator("#drawing-area .board-item-sticky")).toHaveCount(2);
    await expect(collaborator.locator("#drawing-area .board-item-sticky")).toHaveCount(2);

    const copy = page.locator("#drawing-area .board-item-sticky").last();
    const copiedId = await copy.getAttribute("data-item-id");
    expect(copiedId).toBeTruthy();
    const movedTransform = await moveItem(page, copy, 42, 28);
    await expect(
      collaborator.locator(`#drawing-area [data-item-id="${copiedId}"]`),
    ).toHaveAttribute("transform", movedTransform);
    await page.keyboard.press("Delete");
    await expect(page.locator("#drawing-area .board-item-sticky")).toHaveCount(1);
    await expect(collaborator.locator("#drawing-area .board-item-sticky")).toHaveCount(1);
  } finally {
    await collaboratorContext.close();
  }
});

test("sticky notes support touch creation and double-tap editing", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, "This scenario requires a touch-capable project.");

  await createBoard(page, "Touch stickies");
  await page.getByTestId("tool-sticky").tap();
  const point = await canvasPoint(page, 0.48, 0.42);
  await dispatchTouchSteps(page, [
    { type: "pointerdown", pointerId: 31, x: point.x - 35, y: point.y, primary: true },
    { type: "pointerdown", pointerId: 32, x: point.x + 35, y: point.y },
    { type: "pointermove", pointerId: 31, x: point.x - 55, y: point.y + 10, primary: true },
    { type: "pointermove", pointerId: 32, x: point.x + 55, y: point.y + 10 },
    { type: "pointerup", pointerId: 31, x: point.x - 55, y: point.y + 10, primary: true },
    { type: "pointerup", pointerId: 32, x: point.x + 55, y: point.y + 10 },
  ]);
  await expect(page.getByTestId("canvas-text-editor")).toHaveCount(0);
  await expect(page.locator("#drawing-area .board-item-sticky")).toHaveCount(0);

  await page.touchscreen.tap(point.x, point.y);

  const createEditor = page.getByTestId("canvas-text-editor");
  await expect(createEditor).toBeVisible();
  await expect(createEditor).toBeFocused();
  await expect(createEditor).toHaveAttribute("data-editor-kind", "sticky");
  await createEditor.fill("Touch idea");
  await createEditor.press("Control+Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  await page.getByRole("button", { name: /^Select/u }).tap();
  const sticky = page.locator("#drawing-area .board-item-sticky");
  await expect(sticky).toHaveCount(1);
  const bounds = await sticky.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("The touch sticky has no layout bounds.");
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };

  await page.touchscreen.tap(center.x, center.y);
  await page.touchscreen.tap(center.x, center.y);

  const editEditor = page.getByTestId("canvas-text-editor");
  await expect(editEditor).toBeVisible();
  await expect(editEditor).toBeFocused();
  await expect(editEditor).toHaveAttribute("aria-label", "Edit sticky note");
  await expect(editEditor).toHaveValue("Touch idea");
  await editEditor.fill("Touch idea updated");
  await editEditor.press("Control+Enter");

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect
    .poll(async () => (await sticky.locator(".sticky-text tspan").allTextContents()).join(" "))
    .toBe("Touch idea updated");
});

test("a delayed stale sticky rejection reopens the exact draft", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "One browser exercises the server rejection path.",
  );

  await createBoard(page, "Sticky conflict recovery");
  const inviteUrl = await createInvite(page);
  await closeAccessDrawer(page);
  const collaboratorContext = await browser.newContext(isolatedContextOptions(testInfo, 42));
  const collaborator = await collaboratorContext.newPage();

  try {
    await openInvite(collaborator, inviteUrl);
    // The collaborator authors the sticky: editors may only edit their own work,
    // while the owner may edit anything, so both can open it afterwards.
    await collaborator.getByTestId("tool-sticky").click();
    const point = await canvasPoint(collaborator, 0.38, 0.4);
    await collaborator.mouse.click(point.x, point.y);
    await collaborator.getByTestId("canvas-text-editor").fill("Shared starting idea");
    await collaborator.getByTestId("canvas-text-editor").press("Control+Enter");
    await expect(collaborator.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    const ownerSticky = page.locator("#drawing-area .board-item-sticky");
    const collaboratorSticky = collaborator.locator("#drawing-area .board-item-sticky");
    await expect(ownerSticky).toHaveCount(1);
    await expect(collaboratorSticky).toHaveCount(1);
    const ownerBounds = await ownerSticky.boundingBox();
    const collaboratorBounds = await collaboratorSticky.boundingBox();
    if (!ownerBounds || !collaboratorBounds) throw new Error("Sticky bounds are unavailable.");

    await page.getByRole("button", { name: /^Select/u }).click();
    await page.mouse.dblclick(
      ownerBounds.x + ownerBounds.width / 2,
      ownerBounds.y + ownerBounds.height / 2,
    );
    await collaborator.getByRole("button", { name: /^Select/u }).click();
    await collaborator.mouse.dblclick(
      collaboratorBounds.x + collaboratorBounds.width / 2,
      collaboratorBounds.y + collaboratorBounds.height / 2,
    );

    const ownerEditor = page.getByTestId("canvas-text-editor");
    const collaboratorEditor = collaborator.getByTestId("canvas-text-editor");
    await expect(ownerEditor).toHaveValue("Shared starting idea");
    await expect(collaboratorEditor).toHaveValue("Shared starting idea");
    await ownerEditor.fill("Coach update wins first");
    const rejectedDraft = "Student draft must survive exactly <&>";
    await collaboratorEditor.fill(rejectedDraft);

    await ownerEditor.press("Control+Enter");
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect
      .poll(async () => (await collaboratorSticky.locator("tspan").allTextContents()).join(" "))
      .toBe("Coach update wins first");

    await collaboratorEditor.press("Control+Enter");
    await expect(collaboratorEditor).toBeVisible();
    await expect(collaboratorEditor).toBeFocused();
    await expect(collaboratorEditor).toHaveValue(rejectedDraft);
    await expect(collaborator.getByTestId("toast-region")).toContainText(
      "Your sticky draft was retained and reopened",
    );

    await collaboratorEditor.fill("Student resolved update");
    await collaboratorEditor.press("Control+Enter");
    await expect(collaborator.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect
      .poll(async () => (await ownerSticky.locator("tspan").allTextContents()).join(" "))
      .toBe("Student resolved update");
  } finally {
    await collaboratorContext.close();
  }
});

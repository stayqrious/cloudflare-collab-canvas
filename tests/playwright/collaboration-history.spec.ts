import { expect, test } from "@playwright/test";
import {
  canvasPoint,
  closeAccessDrawer,
  createBoard,
  createInvite,
  drawShape,
  isolatedContextOptions,
  moveItem,
  openInvite,
  openSettingsDrawer,
  waitForBoard,
} from "./helpers";

test("a collaborator edit produces an undo conflict without changing authoritative state", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Collaboration acceptance runs in Chromium.");

  await createBoard(page, "Undo conflict");
  const inviteUrl = await createInvite(page);
  await closeAccessDrawer(page);
  const collaboratorContext = await browser.newContext(isolatedContextOptions(testInfo, 21));
  const collaborator = await collaboratorContext.newPage();
  try {
    await openInvite(collaborator, inviteUrl);
    // Editors may only move their own work, so the collaborator draws the item and
    // the owner (who may move anything) changes it before the collaborator undoes.
    const start = await canvasPoint(collaborator, 0.34, 0.36);
    const collaboratorItem = await drawShape(collaborator, "Rectangle", start, {
      x: start.x + 110,
      y: start.y + 70,
    });
    const itemId = await collaboratorItem.getAttribute("data-item-id");
    expect(itemId).toBeTruthy();
    const ownerItem = page.locator(`#drawing-area [data-item-id="${itemId}"]`);
    await expect(ownerItem).toHaveCount(1);
    const movedTransform = await moveItem(page, ownerItem, 48, 26);
    await expect(collaboratorItem).toHaveAttribute("transform", movedTransform);

    await openSettingsDrawer(collaborator);
    const undo = collaborator.getByTestId("undo-button");
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(collaborator.getByTestId("toast-region")).toContainText(
      "Undo stopped because a collaborator changed that item.",
    );
    await expect(collaborator.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(collaborator.getByTestId("save-status")).toContainText("Saved");
    await expect(ownerItem).toHaveAttribute("transform", movedTransform);
    await expect(collaboratorItem).toHaveAttribute("transform", movedTransform);
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await expect(collaborator.locator("#drawing-area [data-item-id]")).toHaveCount(1);
  } finally {
    await collaboratorContext.close();
  }
});

test("two tabs share history state and a new action invalidates redo everywhere", async ({
  context,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "History synchronization runs in Chromium.");

  const boardUrl = await createBoard(page, "Two-tab history");
  const second = await context.newPage();
  try {
    await second.goto(boardUrl);
    await waitForBoard(second);
    await openSettingsDrawer(page);
    await openSettingsDrawer(second);
    await expect(page.getByTestId("undo-button")).toBeDisabled();
    await expect(second.getByTestId("undo-button")).toBeDisabled();

    const rectangleStart = await canvasPoint(page, 0.3, 0.35);
    await drawShape(page, "Rectangle", rectangleStart, {
      x: rectangleStart.x + 105,
      y: rectangleStart.y + 70,
    });
    await expect(second.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await expect(page.getByTestId("undo-button")).toBeEnabled();
    await expect(second.getByTestId("undo-button")).toBeEnabled();

    await second.getByTestId("undo-button").click();
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(0);
    await expect(second.locator("#drawing-area [data-item-id]")).toHaveCount(0);
    await expect(page.getByTestId("redo-button")).toBeEnabled();
    await expect(second.getByTestId("redo-button")).toBeEnabled();
    await expect(page.getByTestId("save-status")).toContainText("Saved");
    await expect(second.getByTestId("save-status")).toContainText("Saved");

    const ellipseStart = await canvasPoint(page, 0.55, 0.42);
    await drawShape(page, "Ellipse", ellipseStart, {
      x: ellipseStart.x + 80,
      y: ellipseStart.y + 55,
    });
    await expect(second.locator("#drawing-area .board-item-ellipse")).toHaveCount(1);
    await expect(page.getByTestId("redo-button")).toBeDisabled();
    await expect(second.getByTestId("redo-button")).toBeDisabled();
    await expect(page.getByTestId("undo-button")).toBeEnabled();
    await expect(second.getByTestId("undo-button")).toBeEnabled();
  } finally {
    await second.close();
  }
});

test("an owner switches a connected participant role from the Participants drawer", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Live role switching runs in Chromium.");

  await createBoard(page, "Participant roles");
  await expect(page.getByTestId("participants-button")).toHaveAccessibleName("1 person here");
  const inviteUrl = await createInvite(page);
  const collaboratorContext = await browser.newContext(isolatedContextOptions(testInfo, 25));
  const collaborator = await collaboratorContext.newPage();
  try {
    await openInvite(collaborator, inviteUrl);
    await closeAccessDrawer(page);
    await expect(page.getByTestId("participants-button")).toContainText("2");
    await expect(page.getByTestId("participants-button")).toHaveAccessibleName("2 people here");

    await page.getByTestId("participants-button").click();
    const ownerDrawer = page.getByTestId("participant-drawer");
    await expect(ownerDrawer).toBeVisible();
    const roleSelect = ownerDrawer.getByRole("combobox", { name: /^Role for /u });
    await expect(roleSelect).toHaveCount(1);
    await expect(roleSelect).toHaveValue("editor");

    await roleSelect.selectOption("viewer");
    await expect(roleSelect).toHaveValue("viewer");
    await expect(collaborator.getByTestId("save-status")).toContainText("Read only");
    await expect(collaborator.getByRole("button", { name: /^Pencil/u })).toBeDisabled();

    await collaborator.getByTestId("participants-button").click();
    const collaboratorDrawer = collaborator.getByTestId("participant-drawer");
    await expect(collaboratorDrawer).toBeVisible();
    await expect(collaboratorDrawer.getByRole("combobox", { name: /^Role for /u })).toHaveCount(0);
    await expect(collaboratorDrawer).toContainText(/viewer · you/iu);

    await roleSelect.selectOption("editor");
    await expect(roleSelect).toHaveValue("editor");
    await expect(collaborator.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(collaborator.getByRole("button", { name: /^Pencil/u })).toBeEnabled();
  } finally {
    await collaboratorContext.close();
  }
});

test("live policy changes and private-board revocation update an active editor", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Live access acceptance runs in Chromium.");

  await createBoard(page, "Live access controls");
  const inviteUrl = await createInvite(page);
  const collaboratorContext = await browser.newContext(isolatedContextOptions(testInfo, 22));
  const collaborator = await collaboratorContext.newPage();
  try {
    await openInvite(collaborator, inviteUrl);
    await closeAccessDrawer(page);
    await expect(page.getByTestId("participants-button")).toContainText("2");
    await page.getByTestId("access-button").click();
    const accessDrawer = page.getByTestId("access-drawer");
    await expect(accessDrawer).toBeVisible();
    await expect(accessDrawer.getByRole("button", { name: /^Remove /u })).toHaveCount(1);

    const ownerPencil = page.getByRole("button", { name: /^Pencil/u });
    const collaboratorPencil = collaborator.getByRole("button", { name: /^Pencil/u });
    await expect(ownerPencil).toBeEnabled();
    await expect(collaboratorPencil).toBeEnabled();

    await page.getByTestId("settings-button").click();
    const settingsDrawer = page.getByTestId("settings-drawer");
    await expect(settingsDrawer).toBeVisible();
    await settingsDrawer.locator("button[data-policy='owner_only']").click();
    await expect(settingsDrawer.locator("button[data-policy='owner_only']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(ownerPencil).toBeEnabled();
    await expect(collaboratorPencil).toBeDisabled();
    await expect(collaborator.getByTestId("save-status")).toContainText("Read only");

    await settingsDrawer.locator("button[data-policy='locked']").click();
    await expect(settingsDrawer.locator("button[data-policy='locked']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(ownerPencil).toBeDisabled();
    await expect(collaboratorPencil).toBeDisabled();
    await expect(page.getByTestId("save-status")).toContainText("Read only");
    await expect(collaborator.getByTestId("save-status")).toContainText("Read only");

    await settingsDrawer.locator("button[data-policy='editors_enabled']").click();
    await expect(settingsDrawer.locator("button[data-policy='editors_enabled']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(ownerPencil).toBeEnabled();
    await expect(collaboratorPencil).toBeEnabled();
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(collaborator.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

    await settingsDrawer
      .getByRole("combobox", { name: "Space link access" })
      .selectOption("private");
    await expect(page.getByTestId("toast-region")).toContainText(
      "Only members can open this board now.",
    );
    await page.getByTestId("access-button").click();
    await expect(accessDrawer).toBeVisible();
    const removeMember = accessDrawer.getByRole("button", { name: /^Remove /u });
    await expect(removeMember).toHaveCount(1);
    page.once("dialog", (dialog) => dialog.accept());
    await removeMember.click();
    await expect(accessDrawer.getByRole("button", { name: /^Remove /u })).toHaveCount(0);

    await expect(collaborator.getByTestId("toast-region")).toContainText(
      "Your access to this board was removed.",
    );
    await expect(collaboratorPencil).toBeDisabled();
    await expect(collaborator.getByTestId("save-status")).toHaveAttribute("data-state", "readonly");
    await expect(collaborator.getByTestId("save-status")).toContainText("Read only");

    await collaborator.reload();
    await expect(collaborator.getByTestId("fatal-screen")).toBeVisible();
    await expect(collaborator.getByRole("heading", { name: "Board unavailable" })).toBeVisible();
  } finally {
    await collaboratorContext.close();
  }
});

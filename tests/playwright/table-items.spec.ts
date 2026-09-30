import { expect, test } from "@playwright/test";
import {
  chooseMoreTool,
  closeAccessDrawer,
  createBoard,
  createInvite,
  isolatedContextOptions,
  openInvite,
  waitForBoard,
} from "./helpers";

test("tables insert, edit collaboratively, copy, delete, and reload", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Focused table collaboration runs in Chromium.");

  await createBoard(page, "Learning grid");
  const editorInvite = await createInvite(page);
  await closeAccessDrawer(page);
  const editorContext = await browser.newContext(isolatedContextOptions(testInfo, 81));
  const editor = await editorContext.newPage();

  try {
    await openInvite(editor, editorInvite);
    await expect(editor.getByTestId("tool-table")).toBeEnabled();

    // Editors may only edit their own work, so the editor inserts the table and
    // the owner (who may edit anything) fills in the header cell.
    await chooseMoreTool(editor, "tool-table");
    const picker = editor.getByTestId("table-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByLabel("Table columns")).toHaveValue("3");
    await expect(picker.getByLabel("Table rows")).toHaveValue("3");
    await picker.getByRole("checkbox", { name: "Header row" }).check();
    await picker.getByRole("button", { name: "Choose placement" }).click();
    await expect(picker).toBeHidden();

    const canvas = editor.locator("#board-canvas");
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error("Canvas has no layout bounds.");
    await editor.mouse.click(
      canvasBounds.x + canvasBounds.width * 0.62,
      canvasBounds.y + canvasBounds.height * 0.54,
    );

    const ownerTables = page.locator("#drawing-area .board-item-table");
    const editorTables = editor.locator("#drawing-area .board-item-table");
    await expect(ownerTables).toHaveCount(1);
    await expect(editorTables).toHaveCount(1);
    await expect(ownerTables.first()).toHaveAttribute("data-table-rows", "3");
    await expect(ownerTables.first()).toHaveAttribute("data-table-columns", "3");
    await expect(ownerTables.first()).toHaveAttribute("aria-label", "Table, 3 rows by 3 columns");
    await expect(editor.getByTestId("tool-select")).toHaveAttribute("aria-pressed", "true");

    await page.getByTestId("tool-select").click();
    const ownerFirstCell = ownerTables
      .first()
      .locator('[data-table-cell][data-table-row="0"][data-table-column="0"]');
    await ownerFirstCell.dblclick();
    const ownerEditor = page.getByTestId("table-cell-editor");
    await expect(ownerEditor).toBeVisible();
    await expect(ownerEditor).toHaveAttribute("aria-label", "Edit table cell, row 1, column 1");
    await ownerEditor.fill("Topic");
    await ownerEditor.press("Control+Enter");
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(
      editorTables.first().locator('[data-table-cell][data-table-row="0"][data-table-column="0"]'),
    ).toHaveAttribute("aria-label", /Topic/u);

    await editor.getByTestId("tool-select").click();
    const studentCell = editorTables
      .first()
      .locator('[data-table-cell][data-table-row="1"][data-table-column="1"]');
    await studentCell.dblclick();
    const studentEditor = editor.getByTestId("table-cell-editor");
    await studentEditor.fill("Student evidence");
    await studentEditor.press("Control+Enter");
    await expect(editor.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(
      ownerTables.first().locator('[data-table-cell][data-table-row="1"][data-table-column="1"]'),
    ).toHaveAttribute("aria-label", /Student evidence/u);

    await page.keyboard.press("Control+d");
    await expect(ownerTables).toHaveCount(2);
    await expect(editorTables).toHaveCount(2);
    const copyId = await ownerTables.last().getAttribute("data-item-id");
    expect(copyId).toBeTruthy();
    await page.keyboard.press("Delete");
    await expect(ownerTables).toHaveCount(1);
    await expect(editor.locator(`[data-item-id="${copyId}"]`)).toHaveCount(0);

    await page.reload();
    await waitForBoard(page);
    const reloaded = page.locator("#drawing-area .board-item-table");
    await expect(reloaded).toHaveCount(1);
    await expect(
      reloaded.locator('[data-table-cell][data-table-row="0"][data-table-column="0"]'),
    ).toHaveAttribute("aria-label", /Topic/u);
    await expect(
      reloaded.locator('[data-table-cell][data-table-row="1"][data-table-column="1"]'),
    ).toHaveAttribute("aria-label", /Student evidence/u);
  } finally {
    await editorContext.close();
  }
});

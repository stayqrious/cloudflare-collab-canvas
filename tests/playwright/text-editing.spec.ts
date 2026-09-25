import { expect, test } from "@playwright/test";
import {
  canvasPoint,
  closeAccessDrawer,
  createBoard,
  createInvite,
  isolatedContextOptions,
  moveItem,
  openInvite,
} from "./helpers";

test("text keeps focus and its draft when a collaborator changes it mid-edit", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "One browser exercises the background text save and rejection path.",
  );

  await createBoard(page, "Text autosave");
  const inviteUrl = await createInvite(page);
  await closeAccessDrawer(page);
  const studentContext = await browser.newContext(isolatedContextOptions(testInfo, 43));
  const student = await studentContext.newPage();

  try {
    await openInvite(student, inviteUrl);
    await student.getByRole("button", { name: /^Text/u }).click();
    const point = await canvasPoint(student, 0.4, 0.4);
    await student.mouse.click(point.x, point.y);
    const editor = student.getByTestId("canvas-text-editor");
    await editor.pressSequentially("First thought");

    const ownerText = page.locator("#drawing-area .board-item-text");
    await expect(ownerText).toContainText("First thought");
    await expect(student.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await expect(editor).toBeFocused();

    // The owner moves the text while the student is still typing, so the student's
    // next background save carries a stale item version and is rejected.
    const movedTransform = await moveItem(page, ownerText, 60, 40);
    const studentText = student.locator("#drawing-area .board-item-text");
    await expect(studentText).toHaveAttribute("transform", movedTransform);

    await editor.pressSequentially(" and more");
    await expect(student.getByTestId("toast-region")).toContainText(
      "Your text is still open, so you can keep typing.",
    );
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("First thought and more");

    await editor.pressSequentially("!");
    await expect(ownerText).toContainText("First thought and more!");
    await expect(ownerText).toHaveAttribute("transform", movedTransform);
    await expect(editor).toBeFocused();
    await editor.press("Control+Enter");
    await expect(editor).toHaveCount(0);
    await expect(ownerText).toHaveCount(1);

    // Clearing text that was created in the same editing session removes it.
    await student.getByRole("button", { name: /^Text/u }).click();
    const secondPoint = await canvasPoint(student, 0.6, 0.7);
    await student.mouse.click(secondPoint.x, secondPoint.y);
    await editor.pressSequentially("Scratch");
    await expect(ownerText).toHaveCount(2);
    await expect(student.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    await editor.fill("");
    await editor.press("Control+Enter");
    await expect(ownerText).toHaveCount(1);
    await expect(ownerText).toContainText("First thought and more!");
  } finally {
    await studentContext.close();
  }
});

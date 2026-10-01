import { expect, type Page, test } from "@playwright/test";
import type { Bootstrap } from "../../apps/web/src/types";
import { PARTICIPANT_COLORS } from "../../packages/protocol/src/participant-colors";
import {
  closeAccessDrawer,
  createBoard,
  createInvite,
  drawShape,
  isolatedContextOptions,
  openInvite,
} from "./helpers";

test("join colours apply to drawing, text, notes and cursors and survive reload", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "mobile-chromium",
    "Desktop colour picker and mouse workflow",
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const boardUrl = await createBoard(page, "Participant colours");
  const boardId = new URL(boardUrl).pathname.split("/").pop();
  const invite = await createInvite(page, "editor");
  await closeAccessDrawer(page);
  const context = await browser.newContext(isolatedContextOptions(testInfo, 92));
  const student = await context.newPage();
  student.on("pageerror", (error) => errors.push(error.message));
  try {
    await openInvite(student, invite);
    const bootstrap = (target: Page) =>
      target.evaluate(async (id) => {
        const response = await fetch(`/api/v1/boards/${id}/bootstrap`);
        return response.json() as Promise<Bootstrap>;
      }, boardId);
    const owner = (await bootstrap(page)).actor;
    const editor = (await bootstrap(student)).actor;
    expect(owner.color).toBe(PARTICIPANT_COLORS[0].color);
    expect(editor.color).toBe(PARTICIPANT_COLORS[1].color);
    for (const [index, target] of [page, student].entries()) {
      const x = 280 + index * 330;
      await drawShape(target, "Pencil", { x, y: 210 }, { x: x + 70, y: 235 });
      await target.getByTestId("tool-text").click();
      await target.locator("#board-canvas").click({ position: { x, y: 300 } });
      const text = target.getByTestId("canvas-text-editor");
      await expect(text).toBeVisible();
      await text.fill(`Participant ${index + 1}`);
      await target.keyboard.press("Escape");
      await target.getByTestId("tool-sticky").click();
      await target.locator("#board-canvas").click({ position: { x, y: 420 } });
      const note = target.getByTestId("canvas-text-editor");
      await expect(note).toBeVisible();
      await note.fill(`Note ${index + 1}`);
      await target.keyboard.press("Escape");
      await expect(note).toHaveCount(0);
      // Wait for the committed note and both clients to converge before the
      // next participant draws; the save chip may still show the previous ACK.
      for (const participant of [page, student]) {
        await expect(participant.locator("#drawing-area [data-item-id]")).toHaveCount(
          (index + 1) * 3,
        );
      }
      await expect(target.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    }
    const saved = await bootstrap(page);
    if (!("items" in saved.snapshot)) throw new Error("Expected an inline board snapshot");
    for (const actor of [owner, editor]) {
      const items = saved.snapshot.items.filter(
        (item: { createdBy: string }) => item.createdBy === actor.id,
      );
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item).toMatchObject({
          style: item.kind === "sticky" ? { fill: actor.stickyColor } : { color: actor.color },
        });
      }
    }
    await student.mouse.move(580, 350);
    await expect(page.locator(".participant-cursor")).toHaveCSS(
      "--cursor-color",
      PARTICIPANT_COLORS[1].color,
    );
    await student.reload();
    await expect(student.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    expect((await bootstrap(student)).actor.color).toBe(editor.color);
    await student.getByTestId("tool-pencil").click();
    await student.getByTestId("style-button").click();
    await expect(student.locator("[data-color]")).toHaveCount(10);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, waitForBoard } from "./helpers";

for (const pointerType of ["mouse", "pen"] as const) {
  for (const ending of ["pointercancel", "lostpointercapture", "hover", "pointerup"] as const) {
    test(`${pointerType} pencil persists after ${ending} without duplicate or hover ink`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await createBoard(page, `${pointerType} ${ending} release`);
      const start = await canvasPoint(page, 0.3, 0.35);

      await page.locator("#board-canvas").evaluate(
        (node, input) => {
          // Synthetic pointer IDs cannot use native capture. Emit the normal capture-loss
          // event on explicit release, and model unexpected loss independently below.
          const captured = new Set<number>();
          const send = (type: string, dx: number, buttons: number): void => {
            node.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 42,
                pointerType: input.pointerType,
                isPrimary: true,
                clientX: input.start.x + dx,
                clientY: input.start.y,
                button: type === "pointermove" ? -1 : 0,
                buttons,
                pressure: buttons ? 0.5 : 0,
              }),
            );
          };
          Object.defineProperties(node, {
            setPointerCapture: { configurable: true, value: (id: number) => captured.add(id) },
            hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
            releasePointerCapture: {
              configurable: true,
              value: (id: number) => {
                captured.delete(id);
                send("lostpointercapture", 0, 0);
              },
            },
          });
          send("pointerdown", 0, 1);
          send("pointermove", 40, 1);
          send("pointermove", 80, 1);
          if (input.ending === "lostpointercapture") captured.delete(42);
          send(input.ending === "hover" ? "pointermove" : input.ending, 160, 0);
          // A later release/capture loss must neither duplicate the stroke nor add hover ink.
          send("pointermove", 240, 0);
          send("pointerup", 240, 0);
          send("lostpointercapture", 240, 0);
        },
        { pointerType, ending, start },
      );

      const strokes = page.locator("#drawing-area .board-item-pencil");
      await expect(strokes).toHaveCount(1);
      await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
      await expect(page.locator("#board-canvas")).not.toHaveAttribute("data-pointer-active");
      const width = await strokes
        .first()
        .evaluate((node) => (node as SVGGraphicsElement).getBBox().width);
      // Only a normal pointerup contributes a final coordinate. Interruption and hover
      // coordinates may be unrelated to the ink and must never extend it.
      expect(width).toBeCloseTo(ending === "pointerup" ? 160 : 80, 0);
      const path = await strokes.first().getAttribute("d");
      await page.reload();
      await waitForBoard(page);
      await expect(strokes).toHaveCount(1);
      await expect(strokes.first()).toHaveAttribute("d", path as string);
      expect(errors).toEqual([]);
    });
  }
}

test("touch cancellation and Escape discard unfinished pencil ink", async ({ page }) => {
  await createBoard(page, "Intentional pencil cancellation");
  const start = await canvasPoint(page, 0.3, 0.35);
  await page.locator("#board-canvas").evaluate((node, point) => {
    Object.defineProperties(node, {
      setPointerCapture: { configurable: true, value: () => {} },
      hasPointerCapture: { configurable: true, value: () => false },
    });
    for (const [index, type] of ["pointerdown", "pointermove", "pointercancel"].entries()) {
      node.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 73,
          pointerType: "touch",
          clientX: point.x + index * 40,
          clientY: point.y,
          button: 0,
          buttons: type === "pointercancel" ? 0 : 1,
        }),
      );
    }
  }, start);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 80, start.y, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator("#drawing-area .board-item-pencil")).toHaveCount(0);
  await page.reload();
  await waitForBoard(page);
  await expect(page.locator("#drawing-area .board-item-pencil")).toHaveCount(0);
});

import { expect, test } from "@playwright/test";

import { createBoard } from "./helpers";

test("a delimiter opens the maths field, and its TeX lands back in the text", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const store = window as unknown as { __cspViolations: string[] };
    store.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      store.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  await createBoard(page, "Maths keyboard");
  await page.getByTestId("tool-text").click();
  await page.locator("#board-canvas").click({ position: { x: 400, y: 300 } });
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();

  // Typing the opening half completes the pair and brings up the field.
  await editor.type("Solve $$");
  await expect(editor).toHaveValue("Solve $$$$");
  const panel = page.getByTestId("math-field-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("math-field")).toHaveCount(1);

  // What the field is given is written back between the delimiters, not over the prose.
  await page.locator("math-field").click();
  await page.keyboard.type("x^2+1");
  // MathLive on WebKit may retain an empty superscript placeholder before the exponent. Both
  // serializations represent the same formula and are accepted by MathJax.
  await expect(editor).toHaveValue(/^Solve \$\$x\^(?:\{\})?2\+1\$\$$/u);

  // MathLive's on-screen keyboard is the point of the field, so it has to open.
  await page.evaluate(() => {
    const field = document.querySelector("math-field") as HTMLElement & {
      executeCommand?: (command: string) => void;
    };
    field?.executeCommand?.("toggleVirtualKeyboard");
  });
  const keyboard = await page.evaluate(() => {
    const virtual = (window as unknown as { mathVirtualKeyboard?: { visible?: boolean } })
      .mathVirtualKeyboard;
    return { present: Boolean(virtual), visible: virtual?.visible === true };
  });
  expect(keyboard).toEqual({ present: true, visible: true });

  // The board's content security policy has to accommodate the library, not be broken by it.
  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
  );
  expect(violations).toEqual([]);
  expect(consoleErrors).toEqual([]);

  // A lone dollar is a dollar: a price must not open a formula. Escape ends the edit outright
  // rather than only dismissing the field, so the price is typed into a fresh text object.
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.getByTestId("tool-text").click();
  await page.locator("#board-canvas").click({ position: { x: 400, y: 420 } });
  const priceEditor = page.getByTestId("canvas-text-editor");
  await expect(priceEditor).toBeVisible();
  await priceEditor.fill("Kits cost $12 each");
  await expect(priceEditor).toHaveValue("Kits cost $12 each");
  await expect(panel).toBeHidden();
});

test("the maths field goes away with the editor it belongs to", async ({ page }) => {
  await createBoard(page, "Maths keyboard dismissal");
  await page.getByTestId("tool-text").click();
  await page.locator("#board-canvas").click({ position: { x: 400, y: 300 } });
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();

  await editor.type("Area $$r^2");
  const panel = page.getByTestId("math-field-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // Focus never entered the panel, so moving to another real control closes the editor. Using the
  // title is viewport-safe on phones and tablets, unlike a fixed desktop canvas coordinate.
  await page.getByTestId("board-title").click();
  await expect(editor).toBeHidden();
  await expect(panel).toBeHidden();
});

test("clicking away from the maths field saves the text instead of losing it", async ({ page }) => {
  await createBoard(page, "Maths keyboard focus");
  await page.getByTestId("tool-text").click();
  await page.locator("#board-canvas").click({ position: { x: 400, y: 300 } });
  const editor = page.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();

  await editor.type("Answer $$");
  await expect(page.getByTestId("math-field-panel")).toBeVisible({ timeout: 20_000 });
  await page.locator("math-field").click();
  await page.keyboard.type("2x");
  await expect(editor).toHaveValue("Answer $$2x$$");

  // Focus is in the maths field, and the participant moves to another real control rather than
  // pressing Done. The panel has to finish the edit or this draft is discarded.
  await page.getByTestId("board-title").click();
  await expect(page.getByTestId("math-field-panel")).toBeHidden();
  await expect(page.locator("#board-canvas")).toContainText("Answer", { timeout: 10_000 });
});

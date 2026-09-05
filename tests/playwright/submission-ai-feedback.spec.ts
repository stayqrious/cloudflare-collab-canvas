import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard, drawShape } from "./helpers";

type RegisteredTool = {
  name: string;
  execute: (input: unknown, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
};

declare global {
  interface Window {
    __submissionWebMcpTools: Record<string, RegisteredTool>;
  }
}

test("captures AI feedback on a mistaken hand-drawn quadratic", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The submission capture runs in Chromium.");

  await page.addInitScript(() => {
    const tools: Record<string, RegisteredTool> = {};
    Object.defineProperty(window, "__submissionWebMcpTools", { value: tools });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }) {
          tools[tool.name] = tool;
          options?.signal?.addEventListener("abort", () => delete tools[tool.name], { once: true });
        },
      },
    });
  });

  const boardUrl = await createBoard(page, "AI feedback on a quadratic");
  const addText = async (text: string, horizontal: number, vertical: number) => {
    const point = await canvasPoint(page, horizontal, vertical);
    await page.getByTestId("tool-text").click();
    await page.mouse.click(point.x, point.y);
    const editor = page.getByTestId("canvas-text-editor");
    await editor.fill(text);
    await editor.press("Enter");
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  };

  await addText("x² + 7x + 10 = 0", 0.28, 0.18);
  const notePoint = await canvasPoint(page, 0.2, 0.3);
  await page.getByTestId("tool-sticky").click();
  await page.mouse.click(notePoint.x, notePoint.y);
  const noteEditor = page.getByTestId("canvas-text-editor");
  await noteEditor.fill("Student note: I think the roots are x = -3 and x = -1.");
  await noteEditor.press("Control+Enter");
  const sourceNote = page.locator("#drawing-area .board-item-sticky").last();

  const origin = await canvasPoint(page, 0.25, 0.62);
  await drawShape(
    page,
    "Pencil",
    { x: origin.x - 120, y: origin.y },
    { x: origin.x + 160, y: origin.y },
  );
  await drawShape(
    page,
    "Pencil",
    { x: origin.x, y: origin.y - 125 },
    { x: origin.x, y: origin.y + 105 },
  );
  const wrongCurve = [
    { x: origin.x - 105, y: origin.y - 80 },
    { x: origin.x - 75, y: origin.y - 25 },
    { x: origin.x - 45, y: origin.y + 15 },
    { x: origin.x - 15, y: origin.y + 30 },
    { x: origin.x + 15, y: origin.y + 15 },
    { x: origin.x + 45, y: origin.y - 25 },
    { x: origin.x + 75, y: origin.y - 80 },
  ];
  for (const [index, point] of wrongCurve.slice(0, -1).entries()) {
    await drawShape(page, "Pencil", point, wrongCurve[index + 1] as { x: number; y: number });
  }
  await addText("-3", 0.205, 0.64);
  await addText("-1", 0.285, 0.64);

  await page.getByRole("button", { name: /^Select/u }).click();
  const sourceBounds = await sourceNote.boundingBox();
  if (!sourceBounds) throw new Error("The student note has no rendered bounds.");
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2,
  );

  // The assistant answers on the student's own note, then leaves the counterexample beside it.
  const commentResult = await page.evaluate(() => {
    const tool = window.__submissionWebMcpTools.insert_comment;
    if (!tool) throw new Error("The comment write was not registered.");
    return tool.execute(
      {
        body: "Do the intercepts at -3 and -1 make the original equation equal zero? Try x = -4.",
      },
      { signal: new AbortController().signal },
    );
  });
  expect(commentResult).toMatchObject({ status: "commented", writtenBy: "ai" });

  const feedbackResult = await page.evaluate(() => {
    const tool = window.__submissionWebMcpTools.insert_sticky;
    if (!tool) throw new Error("The sticky write was not registered.");
    return tool.execute(
      {
        // No location: the note lands at the centre of this participant's view, beside the work.
        text: "AI feedback · Check x = -4\nAt x = -4, y = 16 - 28 + 10 = -2, so the plotted point should be below the x-axis. Can you plot (-4, -2) and use it to correct the curve?",
        fill: "coral",
      },
      { signal: new AbortController().signal },
    );
  });
  expect(feedbackResult).toMatchObject({
    status: "inserted",
    objectKind: "sticky",
    changedCanvas: true,
    aiAttributed: true,
  });
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(page.locator('#drawing-area [data-assisted-by="ai"]')).toHaveCount(1);

  // Sticky text wraps into separate tspans, so read what was saved rather than what was drawn.
  const saved = await page.evaluate(async (url) => {
    const boardId = new URL(url).pathname.split("/").at(-1);
    const response = await fetch(`/api/v1/boards/${boardId}/export.json`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = (await response.json()) as {
      items: Array<{ kind: string; assistedBy?: string; geometry: { text?: string } }>;
    };
    const aiItems = body.items.filter((item) => item.assistedBy === "ai");
    return {
      aiItemCount: aiItems.length,
      feedbackText: aiItems.find((item) => item.kind === "sticky")?.geometry.text ?? "",
    };
  }, boardUrl);
  expect(saved.aiItemCount).toBeGreaterThan(0);
  expect(saved.feedbackText).toContain("AI feedback · Check x = -4");
  expect(saved.feedbackText).toContain("Can you plot (-4, -2)");

  await page.getByRole("button", { name: "Fit drawing to view" }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: "/tmp/spacescale-ai-feedback-correction.png", fullPage: true });
});

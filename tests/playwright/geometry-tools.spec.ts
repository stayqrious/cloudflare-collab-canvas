import { expect, test } from "@playwright/test";
import {
  canvasPoint,
  chooseMoreTool,
  createBoard,
  drag,
  drawShape,
  expandToolPermissions,
} from "./helpers";

test("shape palette, rotatable protractor, snapping, partial erase, and feature gates work together", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Geometry acceptance runs in Chromium.");

  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await createBoard(page, "Geometry lab");
  await expect(page).toHaveTitle("Geometry lab — SpaceScale");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const presets = [
    ["Square", 0.12, 0.2],
    ["Rectangle", 0.28, 0.2],
    ["Triangle", 0.44, 0.2],
    ["Rhombus", 0.6, 0.2],
    ["Pentagon", 0.2, 0.42],
    ["Hexagon", 0.4, 0.42],
    ["Circle", 0.6, 0.42],
  ] as const;
  for (const [name, horizontal, vertical] of presets) {
    const start = await canvasPoint(page, horizontal, vertical);
    await drawShape(page, name, start, { x: start.x + 72, y: start.y + 58 });
  }
  await expect(page.locator("#drawing-area .board-item-rectangle")).toHaveCount(2);
  await expect(page.locator("#drawing-area .board-item-polygon")).toHaveCount(4);
  await expect(page.locator("#drawing-area .board-item-ellipse")).toHaveCount(1);

  const placement = await canvasPoint(page, 0.76, 0.62);
  await chooseMoreTool(page, "tools-protractor");
  await page.mouse.click(placement.x, placement.y);
  const protractor = page.locator("#drawing-area .board-item-protractor");
  await expect(protractor).toHaveCount(1);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const rotateHandle = page.locator("[data-rotate-handle='protractor']");
  await expect(rotateHandle).toBeVisible();

  const rotation = await protractor.evaluate((node) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM();
    if (!matrix) throw new Error("The protractor has no screen transform.");
    const localHandle = new DOMPoint(0, -190).matrixTransform(matrix);
    const pivot = new DOMPoint(0, 0).matrixTransform(matrix);
    const dx = localHandle.x - pivot.x;
    const dy = localHandle.y - pivot.y;
    return {
      start: { x: localHandle.x, y: localHandle.y },
      end: { x: pivot.x - dy, y: pivot.y + dx },
    };
  });
  const beforeRotation = await protractor.getAttribute("transform");
  await drag(page, rotation.start, rotation.end, { steps: 8 });
  await expect.poll(() => protractor.getAttribute("transform")).not.toBe(beforeRotation);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const squareEdge = await page
    .locator("#drawing-area .board-item-rectangle")
    .first()
    .evaluate((node) => {
      const matrix = (node as SVGGraphicsElement).getScreenCTM();
      if (!matrix) throw new Error("The square has no screen transform.");
      const x = Number(node.getAttribute("x"));
      const y = Number(node.getAttribute("y"));
      const width = Number(node.getAttribute("width"));
      const height = Number(node.getAttribute("height"));
      const target = new DOMPoint(x + width, y + height / 2).matrixTransform(matrix);
      return { x: target.x, y: target.y };
    });
  const moveStart = await protractor.evaluate((node) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM();
    if (!matrix) throw new Error("The protractor has no screen transform.");
    const grab = new DOMPoint(0, -80).matrixTransform(matrix);
    const center = new DOMPoint(0, 0).matrixTransform(matrix);
    return {
      grab: { x: grab.x, y: grab.y },
      center: { x: center.x, y: center.y },
    };
  });
  const beforeMove = await protractor.getAttribute("transform");
  await drag(
    page,
    moveStart.grab,
    {
      x: moveStart.grab.x + squareEdge.x - moveStart.center.x + 5,
      y: moveStart.grab.y + squareEdge.y - moveStart.center.y + 4,
    },
    { steps: 12 },
  );
  await expect.poll(() => protractor.getAttribute("transform")).not.toBe(beforeMove);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const snappedCenter = await protractor.evaluate((node) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM();
    if (!matrix) throw new Error("The moved protractor has no screen transform.");
    const center = new DOMPoint(0, 0).matrixTransform(matrix);
    return { x: center.x, y: center.y };
  });
  expect(Math.abs(snappedCenter.x - squareEdge.x)).toBeLessThan(1);
  expect(Math.abs(snappedCenter.y - squareEdge.y)).toBeLessThan(10);

  const snapTarget = await protractor.evaluate((node) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM();
    if (!matrix) throw new Error("The protractor has no screen transform.");
    const center = new DOMPoint(0, 0).matrixTransform(matrix);
    const radians = Math.PI / 3;
    const tick = new DOMPoint(Math.cos(radians) * 160, -Math.sin(radians) * 160).matrixTransform(
      matrix,
    );
    return {
      center: { x: center.x, y: center.y },
      tick: { x: tick.x, y: tick.y },
      nearTick: { x: tick.x + 5, y: tick.y + 4 },
    };
  });
  await page.getByTestId("tool-rectangle").click();
  await page.getByTestId("tool-line").click();
  await page.mouse.click(snapTarget.center.x, snapTarget.center.y);
  await expect(page.locator("#local-preview-layer .connector-snap-halo")).toHaveCount(1);
  await page.mouse.move(snapTarget.nearTick.x, snapTarget.nearTick.y, { steps: 5 });
  await expect(page.locator("#local-preview-layer .connector-snap-halo")).toHaveCount(2);
  await page.mouse.click(snapTarget.nearTick.x, snapTarget.nearTick.y);
  await expect(page.locator("#drawing-area .board-item-line")).toHaveCount(1);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const lineEndpoints = await page
    .locator("#drawing-area .board-item-line .connector-shaft")
    .evaluate((node) => {
      const line = node as SVGLineElement;
      const matrix = line.getScreenCTM();
      if (!matrix) throw new Error("The snapped line has no screen transform.");
      const start = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value).matrixTransform(
        matrix,
      );
      const end = new DOMPoint(line.x2.baseVal.value, line.y2.baseVal.value).matrixTransform(
        matrix,
      );
      return {
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
      };
    });
  expect(
    Math.hypot(
      lineEndpoints.start.x - snapTarget.center.x,
      lineEndpoints.start.y - snapTarget.center.y,
    ),
  ).toBeLessThan(1);
  expect(
    Math.hypot(lineEndpoints.end.x - snapTarget.tick.x, lineEndpoints.end.y - snapTarget.tick.y),
  ).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath("line-and-protractor-snapping.png") });

  await page.getByTestId("settings-button").click();
  const settings = page.getByTestId("settings-drawer");
  await expect(settings).toBeVisible();
  await expandToolPermissions(page);
  const protractorGate = settings.locator("input[data-feature='protractor']");
  await expect(protractorGate).toBeChecked();
  await protractorGate.uncheck();
  await expect
    .poll(async () =>
      page.getByTestId("tools-protractor").evaluate((node) => (node as HTMLElement).hidden),
    )
    .toBe(true);
  await protractorGate.check();
  await expect
    .poll(async () =>
      page.getByTestId("tools-protractor").evaluate((node) => (node as HTMLElement).hidden),
    )
    .toBe(false);

  // Protractor must be able to restore the More trigger when it is the only nested tool enabled.
  for (const feature of [
    "stamps",
    "images",
    "text",
    "tables",
    "templates",
    "organisationTemplates",
  ]) {
    const toggle = settings.locator(`input[data-feature='${feature}']`);
    if (await toggle.isChecked()) await toggle.uncheck();
  }
  const moreTools = page.getByTestId("tool-more");
  // Feature updates are acknowledged asynchronously. Wait until Protractor is genuinely the only
  // enabled nested tool before testing whether it controls the More trigger.
  await expect
    .poll(() => page.locator("[data-more-tools-grid] > button:not([hidden])").count())
    .toBe(1);
  await expect(moreTools).toBeVisible();
  await protractorGate.uncheck();
  await expect(moreTools).toBeHidden();
  await protractorGate.check();
  await expect(moreTools).toBeVisible();
  expect(browserErrors).toEqual([]);
});

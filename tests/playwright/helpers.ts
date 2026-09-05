import {
  type BrowserContextOptions,
  expect,
  type Frame,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

export function isolatedContextOptions(
  testInfo: TestInfo,
  claimAddressLastOctet?: number,
): BrowserContextOptions {
  const configuredHeaders = testInfo.project.use.extraHTTPHeaders;
  if (configuredHeaders === undefined) return { ignoreHTTPSErrors: true };
  return {
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      ...configuredHeaders,
      ...(claimAddressLastOctet === undefined
        ? {}
        : { "CF-Connecting-IP": `198.18.10.${claimAddressLastOctet}` }),
    },
  };
}

export async function createBoard(page: Page, title: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();
  await page.getByRole("textbox", { name: "Board title" }).fill(title);
  await page.getByRole("button", { name: /Open a fresh canvas/u }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Your canvas is ready" })).toBeVisible();
  const link = dialog.getByRole("link", { name: "Continue to board" });
  const href = await link.getAttribute("href");
  expect(href).toMatch(/\/b\/b_[A-Za-z\d_-]{22}$/u);
  await link.click();
  await waitForBoard(page);
  return new URL(href as string, page.url()).href;
}

export async function waitForBoard(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/b\/b_[A-Za-z\d_-]{22}$/u);
  await expect(page.getByTestId("board-shell")).toBeVisible();
  await expect(page.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
}

export async function createInvite(
  page: Page,
  role: "editor" | "viewer" = "editor",
): Promise<string> {
  await page.getByTestId("access-button").click();
  const drawer = page.getByTestId("access-drawer");
  await expect(drawer).toBeVisible();
  const form = drawer.locator("[data-invite-form]");
  await form.locator("select[name='role']").selectOption(role);
  await form.locator("select[name='maxUses']").selectOption("20");
  await form.getByRole("button", { name: "Create invite link" }).click();
  const result = drawer.locator("[data-invite-result] span");
  await expect(result).toContainText("#invite=");
  const inviteUrl = (await result.textContent())?.trim();
  expect(inviteUrl).toMatch(/#invite=./u);
  return inviteUrl as string;
}

export async function openInvite(page: Page, inviteUrl: string): Promise<void> {
  await page.goto(inviteUrl);
  await waitForBoard(page);
}

type BoardSurface = Page | Frame;

export async function openMoreTools(surface: BoardSurface): Promise<void> {
  const menu = surface.getByTestId("tools-menu");
  if (!(await menu.isVisible())) {
    await surface.getByTestId("tool-more").click();
  }
  await expect(menu).toBeVisible();
}

export async function chooseMoreTool(surface: BoardSurface, testId: string): Promise<void> {
  await openMoreTools(surface);
  await surface.getByTestId(testId).click();
}

export async function openSettingsDrawer(surface: BoardSurface): Promise<Locator> {
  const drawer = surface.getByTestId("settings-drawer");
  if (!(await drawer.isVisible())) {
    await surface.getByTestId("settings-button").click();
  }
  await expect(drawer).toBeVisible();
  return drawer;
}

export async function expandToolPermissions(surface: BoardSurface): Promise<void> {
  const drawer = await openSettingsDrawer(surface);
  const details = drawer.locator("details.settings-collapsible");
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await details.locator("summary").click();
  }
  await expect(details).toHaveAttribute("open", "");
}

export async function canvasPoint(
  page: Page,
  horizontal: number,
  vertical: number,
): Promise<{ x: number; y: number }> {
  const bounds = await page.locator("#board-canvas").boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("Canvas has no layout bounds.");
  return {
    x: bounds.x + bounds.width * horizontal,
    y: bounds.y + bounds.height * vertical,
  };
}

export async function drag(
  page: Page,
  start: { x: number; y: number },
  end: { x: number; y: number },
  options: { shift?: boolean; steps?: number } = {},
): Promise<void> {
  if (options.shift) await page.keyboard.down("Shift");
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: options.steps ?? 8 });
    await page.mouse.up();
  } finally {
    if (options.shift) await page.keyboard.up("Shift");
  }
}

export async function drawShape(
  page: Page,
  toolName:
    | "Straight line"
    | "Square"
    | "Rectangle"
    | "Triangle"
    | "Rhombus"
    | "Pentagon"
    | "Hexagon"
    | "Ellipse"
    | "Circle"
    | "Pencil",
  start: { x: number; y: number },
  end: { x: number; y: number },
  options: { shift?: boolean; waitForSaved?: boolean } = {},
): Promise<Locator> {
  const items = page.locator("#drawing-area [data-item-id]");
  const before = await items.count();
  const shapeVariant =
    toolName === "Ellipse" ? "circle" : toolName.toLocaleLowerCase().replaceAll(" ", "-");
  if (shapeVariant === "straight-line") {
    await page.getByTestId("tool-rectangle").click();
    await page.getByTestId("tool-line").click();
  } else if (
    ["square", "rectangle", "triangle", "rhombus", "pentagon", "hexagon", "circle"].includes(
      shapeVariant,
    )
  ) {
    await page.getByTestId("tool-rectangle").click();
    await page.getByTestId(`shape-${shapeVariant}`).click();
  } else {
    await page.getByRole("button", { name: new RegExp(`^${toolName}`, "u") }).click();
  }
  await drag(page, start, end, { shift: options.shift });
  await expect(items).toHaveCount(before + 1);
  if (options.waitForSaved !== false) {
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  }
  return items.nth(before);
}

export async function moveItem(page: Page, item: Locator, dx: number, dy: number): Promise<string> {
  await page.getByRole("button", { name: /^Select/u }).click();
  const bounds = await item.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("The item has no layout bounds.");
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.click(center.x, center.y);
  await expect(page.getByTestId("selection-actions")).toBeVisible();
  const before = (await item.getAttribute("transform")) ?? "";
  await drag(page, center, { x: center.x + dx, y: center.y + dy }, { steps: 6 });
  await expect.poll(() => item.getAttribute("transform")).not.toBe(before);
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return (await item.getAttribute("transform")) ?? "";
}

export async function dispatchSyntheticPointerGesture(
  page: Page,
  pointerType: "pen" | "touch",
  points: Array<{ x: number; y: number; pressure?: number }>,
): Promise<void> {
  if (points.length < 2) throw new Error("A pointer gesture needs at least two points.");
  await page.locator("#board-canvas").evaluate(
    (node, input) => {
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

      input.points.forEach((point, index) => {
        const first = index === 0;
        const last = index === input.points.length - 1;
        canvas.dispatchEvent(
          new PointerEvent(first ? "pointerdown" : last ? "pointerup" : "pointermove", {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 91,
            pointerType: input.pointerType,
            isPrimary: true,
            clientX: point.x,
            clientY: point.y,
            button: 0,
            buttons: last ? 0 : 1,
            pressure: last ? 0 : (point.pressure ?? 0.5),
          }),
        );
      });
    },
    { pointerType, points },
  );
}

export async function closeAccessDrawer(page: Page): Promise<void> {
  const drawer = page.getByTestId("access-drawer");
  if (await drawer.isVisible()) {
    await drawer.getByRole("button", { name: "Close access panel" }).click();
    await expect(drawer).toBeHidden();
  }
}

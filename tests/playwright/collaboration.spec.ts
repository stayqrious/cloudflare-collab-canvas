import {
  type BrowserContextOptions,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

function isolatedContextOptions(testInfo: TestInfo): BrowserContextOptions {
  return {
    ignoreHTTPSErrors: true,
    ...(testInfo.project.use.extraHTTPHeaders === undefined
      ? {}
      : { extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders }),
  };
}

async function createBoard(page: Page, title: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();
  await page.getByRole("textbox", { name: "Board title" }).fill(title);
  await page.getByRole("button", { name: /Open a fresh canvas/u }).click();

  const ready = page.getByRole("dialog");
  await expect(ready.getByRole("heading", { name: "Your canvas is ready" })).toBeVisible();
  const link = ready.getByRole("link", { name: "Continue to board" });
  const boardUrl = await link.getAttribute("href");
  expect(boardUrl).toMatch(/\/b\/b_[A-Za-z\d_-]{22}$/u);
  await link.click();
  await expect(page).toHaveURL(/\/b\/b_[A-Za-z\d_-]{22}$/u);
  await expect(page.getByTestId("board-shell")).toBeVisible();
  await expect(page.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
  return boardUrl as string;
}

async function drawGesture(page: Page, toolName: string, offset = 0): Promise<number> {
  const canvas = page.locator("#board-canvas");
  const before = await canvas.locator("#drawing-area [data-item-id]").count();
  if (toolName === "Rectangle" || toolName === "Ellipse") {
    await page.getByTestId("tool-rectangle").click();
    await page.getByTestId(toolName === "Rectangle" ? "shape-rectangle" : "shape-circle").click();
  } else {
    await page.getByRole("button", { name: new RegExp(`^${toolName}`, "u") }).click();
  }
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("Canvas has no layout bounds.");
  const start = { x: bounds.x + bounds.width * 0.35 + offset, y: bounds.y + bounds.height * 0.4 };
  const end = { x: start.x + 90, y: start.y + 55 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => canvas.locator("#drawing-area [data-item-id]").count()).toBe(before + 1);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  return before + 1;
}

async function createInvite(
  page: Page,
  role: "editor" | "viewer",
  label?: string,
): Promise<string> {
  await page.getByTestId("access-button").click();
  const drawer = page.getByTestId("access-drawer");
  await expect(drawer).toBeVisible();
  const form = drawer.locator("[data-invite-form]");
  await form.locator("select[name='role']").selectOption(role);
  await form.locator("select[name='maxUses']").selectOption("20");
  if (label) await form.locator("input[name='label']").fill(label);
  await form.getByRole("button", { name: "Create invite link" }).click();
  const result = drawer.locator("[data-invite-result] span");
  await expect(result).toContainText("#invite=");
  const inviteUrl = (await result.textContent())?.trim();
  expect(inviteUrl).toMatch(/#invite=./u);
  return inviteUrl as string;
}

test("creates, saves, undoes, redoes, and exports authoritative content", async ({ page }) => {
  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (message.text().toLowerCase().includes("content security policy")) {
      cspErrors.push(message.text());
    }
  });
  const boardUrl = await createBoard(page, "Geometry studio");
  const itemCount = await drawGesture(page, "Rectangle");

  await page.keyboard.press("Control+z");
  await expect.poll(() => page.locator("#drawing-area [data-item-id]").count()).toBe(itemCount - 1);
  await expect(page.getByTestId("save-status")).toContainText("Saved");

  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => page.locator("#drawing-area [data-item-id]").count()).toBe(itemCount);

  const boardId = boardUrl.split("/").pop();
  expect(boardId).toBeTruthy();
  const svgResponse = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/boards/${id}/export.svg`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  }, boardId);
  expect(svgResponse.status).toBe(200);
  expect(svgResponse.contentType).toContain("image/svg+xml");
  expect(svgResponse.body).toContain("<rect");
  expect(cspErrors).toEqual([]);
});

test("two editors converge and owner policy changes an existing socket to read-only", async ({
  browser,
  page,
}, testInfo) => {
  await createBoard(page, "Team room");
  const inviteUrl = await createInvite(page, "editor");

  const collaboratorContext = await browser.newContext(isolatedContextOptions(testInfo));
  const collaborator = await collaboratorContext.newPage();
  try {
    await collaborator.goto(inviteUrl);
    await expect(collaborator.getByTestId("board-shell")).toBeVisible();
    await expect(collaborator.locator("#board-canvas")).toHaveAttribute("data-ready", "true");

    const collaboratorCanvas = collaborator.locator("#board-canvas");
    const collaboratorBounds = await collaboratorCanvas.boundingBox();
    expect(collaboratorBounds).not.toBeNull();
    if (!collaboratorBounds) throw new Error("Collaborator canvas has no layout bounds.");
    await collaborator.getByRole("button", { name: /^Pencil/u }).click();
    const start = {
      x: collaboratorBounds.x + collaboratorBounds.width * 0.35,
      y: collaboratorBounds.y + collaboratorBounds.height * 0.4,
    };
    await collaborator.mouse.move(start.x, start.y);
    await collaborator.mouse.down();
    await collaborator.mouse.move(start.x + 60, start.y + 35, { steps: 6 });
    await expect(page.locator("#remote-preview-layer .remote-preview")).toHaveCount(1);
    await collaborator.mouse.up();
    await expect
      .poll(() => collaboratorCanvas.locator("#drawing-area [data-item-id]").count())
      .toBe(1);
    const expected = 1;
    await expect.poll(() => page.locator("#drawing-area [data-item-id]").count()).toBe(expected);
    await expect(page.locator("#remote-preview-layer .remote-preview")).toHaveCount(0);

    await page.getByTestId("settings-button").click();
    const settingsDrawer = page.getByTestId("settings-drawer");
    await expect(settingsDrawer).toBeVisible();
    await settingsDrawer.locator("button[data-policy='owner_only']").click();
    await expect(settingsDrawer.locator("button[data-policy='owner_only']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(collaborator.getByTestId("save-status")).toContainText("Read only");
    await expect(collaborator.getByRole("button", { name: /^Pencil/u })).toBeDisabled();
  } finally {
    await collaboratorContext.close();
  }
});

test("move, copy, and delete converge through authoritative batch actions", async ({
  browser,
  page,
}, testInfo) => {
  await createBoard(page, "Editing room");
  const inviteUrl = await createInvite(page, "editor");
  await page.getByRole("button", { name: "Close access panel" }).click();
  const collaboratorContext = await browser.newContext(isolatedContextOptions(testInfo));
  const collaborator = await collaboratorContext.newPage();
  try {
    await collaborator.goto(inviteUrl);
    await expect(collaborator.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
    await drawGesture(page, "Rectangle");
    await expect(collaborator.locator("#drawing-area [data-item-id]")).toHaveCount(1);

    await page.getByRole("button", { name: /^Select/u }).click();
    const original = page.locator("#drawing-area [data-item-id]").first();
    const originalBounds = await original.boundingBox();
    expect(originalBounds).not.toBeNull();
    if (!originalBounds) throw new Error("The rectangle has no layout bounds.");
    await page.mouse.click(
      originalBounds.x + originalBounds.width / 2,
      originalBounds.y + originalBounds.height / 2,
    );
    await expect(page.getByTestId("selection-actions")).toBeVisible();
    await page.keyboard.press("Control+d");
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    await expect(collaborator.locator("#drawing-area [data-item-id]")).toHaveCount(2);

    const copy = page.locator("#drawing-area [data-item-id]").last();
    const copiedId = await copy.getAttribute("data-item-id");
    expect(copiedId).toBeTruthy();
    const beforeTransform = await copy.getAttribute("transform");
    const copyBounds = await copy.boundingBox();
    expect(copyBounds).not.toBeNull();
    if (!copyBounds) throw new Error("The copied rectangle has no layout bounds.");
    const copyCenter = {
      x: copyBounds.x + copyBounds.width / 2,
      y: copyBounds.y + copyBounds.height / 2,
    };
    await page.mouse.move(copyCenter.x, copyCenter.y);
    await page.mouse.down();
    await page.mouse.move(copyCenter.x + 45, copyCenter.y + 30, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => copy.getAttribute("transform")).not.toBe(beforeTransform);
    const authoritativeTransform = await copy.getAttribute("transform");
    await expect(
      collaborator.locator(`#drawing-area [data-item-id="${copiedId}"]`),
    ).toHaveAttribute("transform", authoritativeTransform ?? "");

    await page.keyboard.press("Delete");
    await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await expect(collaborator.locator("#drawing-area [data-item-id]")).toHaveCount(1);
  } finally {
    await collaboratorContext.close();
  }
});

test("a claimed viewer invitation never enables drawing controls", async ({
  browser,
  page,
}, testInfo) => {
  await createBoard(page, "Review room");
  const inviteUrl = await createInvite(page, "viewer");
  const viewerContext = await browser.newContext(isolatedContextOptions(testInfo));
  const viewer = await viewerContext.newPage();
  try {
    await viewer.goto(inviteUrl);
    await expect(viewer.getByTestId("board-shell")).toBeVisible();
    await expect(viewer.getByTestId("save-status")).toContainText("Read only");
    await expect(viewer.getByRole("button", { name: /^Shapes/u })).toBeDisabled();
    const rejection = await viewer.evaluate(async () => {
      const boardId = location.pathname.split("/").pop();
      const socketUrl = new URL(`/api/v1/boards/${boardId}/socket`, location.href);
      socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("since", "0");
      socketUrl.searchParams.set("client", crypto.randomUUID());
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = new WebSocket(socketUrl);
        const timer = window.setTimeout(
          () => reject(new Error("No viewer rejection received.")),
          5_000,
        );
        socket.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (frame.t === "server.ready") {
            socket.send(
              JSON.stringify({
                v: 1,
                t: "client.commit",
                commandId: crypto.randomUUID(),
                actionId: crypto.randomUUID(),
                baseSeq: frame.latestSeq,
                op: {
                  kind: "item.create",
                  item: {
                    id: crypto.randomUUID(),
                    kind: "rectangle",
                    style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
                    transform: [1, 0, 0, 1, 0, 0],
                    geometry: { x: 1, y: 2, width: 3, height: 4 },
                  },
                },
              }),
            );
          }
          if (frame.t === "server.rejected") {
            window.clearTimeout(timer);
            socket.close();
            resolve(frame);
          }
        });
        socket.addEventListener("error", () => {
          window.clearTimeout(timer);
          reject(new Error("Viewer test socket failed."));
        });
      });
    });
    expect(rejection).toMatchObject({ t: "server.rejected", code: "FORBIDDEN" });
  } finally {
    await viewerContext.close();
  }
});

test("an owner names and restores a recovery point, then revokes an invitation", async ({
  browser,
  page,
}, testInfo) => {
  await createBoard(page, "Recovery room");
  await drawGesture(page, "Rectangle");

  await page.getByTestId("settings-button").click();
  const settingsDrawer = page.getByTestId("settings-drawer");
  await expect(settingsDrawer).toBeVisible();
  const snapshotForm = settingsDrawer.locator("[data-snapshot-form]");
  await snapshotForm.locator("input[name='label']").fill("Baseline");
  await snapshotForm.getByRole("button", { name: "Save recovery point" }).click();
  await expect(
    settingsDrawer.locator("[data-snapshot-seq]").filter({ hasText: "Baseline" }),
  ).toBeVisible();

  await settingsDrawer.getByRole("button", { name: "Close settings" }).click();
  await drawGesture(page, "Ellipse", 35);
  await expect(page.locator("#drawing-area [data-item-id]")).toHaveCount(2);

  await page.getByTestId("settings-button").click();
  page.once("dialog", (dialog) => dialog.accept());
  await settingsDrawer.getByRole("button", { name: "Restore Baseline" }).click();
  await expect.poll(() => page.locator("#drawing-area [data-item-id]").count()).toBe(1);
  await expect(page.getByTestId("save-status")).toContainText("Saved");
  await expect(settingsDrawer).toBeHidden();

  const inviteUrl = await createInvite(page, "viewer", "Review link");
  const accessDrawer = page.getByTestId("access-drawer");
  page.once("dialog", (dialog) => dialog.accept());
  await accessDrawer.getByRole("button", { name: "Revoke Review link" }).click();
  await expect(accessDrawer.locator("[data-managed-invitations]")).toBeHidden();

  const revokedContext = await browser.newContext(isolatedContextOptions(testInfo));
  const revokedPage = await revokedContext.newPage();
  try {
    await revokedPage.goto(inviteUrl);
    await expect(revokedPage.getByTestId("fatal-screen")).toBeVisible();
    await expect(revokedPage.getByRole("heading", { name: "Board unavailable" })).toBeVisible();
  } finally {
    await revokedContext.close();
  }
});

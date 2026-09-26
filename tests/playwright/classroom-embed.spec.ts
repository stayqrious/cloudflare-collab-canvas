import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Frame, type Page, test } from "@playwright/test";
import {
  chooseMoreTool,
  createBoard,
  expandToolPermissions,
  isolatedContextOptions,
} from "./helpers";

const LOCAL_PARENT_URL = "http://localhost:4173/";
const LOCAL_WORKER_ORIGIN = "https://127.0.0.1:8787";
const EMBED_BEARER_HISTORY_KEY = "cf-collab-canvas.embed-bearer";
const VIEWER_PNG_FILE = {
  name: "viewer-image.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
};

type Participant = {
  name: string;
  role: "owner" | "editor" | "viewer";
  displayName: string;
  participantId: string;
};

type OrganisationSigningRegistry = Record<
  string,
  {
    derivation_key: string;
    current: { key_id: string; key: string };
    previous: Array<{ key_id: string; key: string }>;
  }
>;

test("Organisation participants join one Space with live owner controls and attribution", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The Organisation Space flow runs once.");
  test.skip(
    Boolean(process.env.PLAYWRIGHT_BASE_URL),
    "Remote Organisation testing requires a configured parent origin and signing registry.",
  );

  const demo = readOrganisationSigningEntry("demo");
  const spaceId = `playwright-space-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1_000);
  const participants = {
    coach: {
      name: "coach",
      role: "owner",
      displayName: "Coach Mira",
      participantId: `coach-${randomUUID()}`,
    },
    student: {
      name: "student",
      role: "editor",
      displayName: "Student Asha",
      participantId: `student-${randomUUID()}`,
    },
    coOwner: {
      name: "co-owner",
      role: "owner",
      displayName: "Coach Dev",
      participantId: `coach-${randomUUID()}`,
    },
  } satisfies Record<string, Participant>;

  const cspErrors: string[] = [];
  captureCspErrors(page, cspErrors);
  const studentContext = await browser.newContext(isolatedContextOptions(testInfo, 31));
  const coOwnerContext = await browser.newContext(isolatedContextOptions(testInfo, 32));
  const studentPage = await studentContext.newPage();
  const coOwnerPage = await coOwnerContext.newPage();
  captureCspErrors(studentPage, cspErrors);
  captureCspErrors(coOwnerPage, cspErrors);

  try {
    const coach = await mountParticipant(
      page,
      LOCAL_PARENT_URL,
      participants.coach,
      launchUrl(LOCAL_WORKER_ORIGIN, "demo", spaceId, demo, participants.coach, now),
    );
    const student = await mountParticipant(
      studentPage,
      LOCAL_PARENT_URL,
      participants.student,
      launchUrl(LOCAL_WORKER_ORIGIN, "demo", spaceId, demo, participants.student, now),
    );
    const coOwner = await mountParticipant(
      coOwnerPage,
      LOCAL_PARENT_URL,
      participants.coOwner,
      launchUrl(LOCAL_WORKER_ORIGIN, "demo", spaceId, demo, participants.coOwner, now),
    );

    const boardPaths = [coach, student, coOwner].map((frame) => new URL(frame.url()).pathname);
    expect(new Set(boardPaths).size).toBe(1);
    expect(boardPaths[0]).toMatch(/^\/embed\/b\/b_[A-Za-z\d_-]{22}$/u);
    for (const frame of [coach, student, coOwner]) {
      const location = new URL(frame.url());
      expect(location.search).toBe("");
      expect(location.hash).toBe("");
    }
    const studentItemId = await drawRectangle(student);
    for (const frame of [coach, student, coOwner]) {
      await expect(frame.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    }

    await coach.getByTestId("access-button").click();
    const coachAccess = coach.getByTestId("access-drawer");
    await expect(coachAccess).toBeVisible();
    await expect(coachAccess.getByRole("combobox", { name: "Role for Coach Dev" })).toHaveValue(
      "owner",
    );

    await coachAccess
      .getByRole("combobox", { name: "Role for Student Asha" })
      .selectOption("viewer");
    await expect(student.getByTestId("save-status")).toContainText("Read only");
    await expect(student.getByRole("button", { name: /^Shapes/u })).toBeDisabled();

    await coachAccess
      .getByRole("combobox", { name: "Role for Student Asha" })
      .selectOption("editor");
    await expect(student.getByRole("button", { name: /^Shapes/u })).toBeEnabled();

    await coach.getByTestId("settings-button").click();
    const coachSettings = coach.getByTestId("settings-drawer");
    await expect(coachSettings).toBeVisible();
    await coachSettings.locator("button[data-policy='owner_only']").click();
    await expect(coachSettings.locator("button[data-policy='owner_only']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(student.getByRole("button", { name: /^Shapes/u })).toBeDisabled();
    await expect(coach.getByRole("button", { name: /^Shapes/u })).toBeEnabled();
    await expect(coOwner.getByRole("button", { name: /^Shapes/u })).toBeEnabled();

    await drawRectangle(coOwner);
    for (const frame of [coach, student, coOwner]) {
      await expect(frame.locator("#drawing-area [data-item-id]")).toHaveCount(2);
    }

    await coOwner.getByTestId("settings-button").click();
    const coOwnerSettings = coOwner.getByTestId("settings-drawer");
    await expect(coOwnerSettings).toBeVisible();
    await expect(coOwnerSettings.locator("button[data-policy='owner_only']")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await coOwnerSettings.locator("button[data-policy='editors_enabled']").click();
    await expect(student.getByRole("button", { name: /^Shapes/u })).toBeEnabled();

    const activity = await coach.evaluate(
      async ({ historyKey }) => {
        const state: unknown = history.state;
        const bearer =
          state !== null && typeof state === "object" && !Array.isArray(state)
            ? (state as Record<string, unknown>)[historyKey]
            : null;
        const boardId = location.pathname.split("/").at(-1);
        const response = await fetch(`/api/v1/boards/${boardId}/activity?afterSeq=0&limit=100`, {
          headers: typeof bearer === "string" ? { Authorization: `Bearer ${bearer}` } : {},
          cache: "no-store",
        });
        return { status: response.status, body: await response.json() };
      },
      { historyKey: EMBED_BEARER_HISTORY_KEY },
    );
    expect(activity.status).toBe(200);
    expect(activity.body).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          actor: {
            id: expect.stringMatching(/^a_[A-Za-z\d_-]{22}$/u),
            displayName: "Student Asha",
          },
          kind: "item.create",
          itemIds: [studentItemId],
          acceptedAt: expect.any(Number),
        }),
      ]),
    });
    expect(cspErrors).toEqual([]);
  } finally {
    await Promise.all([studentContext.close(), coOwnerContext.close()]);
  }
});

test("canonical export is faithfully reproduced by the signed read-only viewer", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The signed viewer flow runs once.");
  test.skip(
    Boolean(process.env.PLAYWRIGHT_BASE_URL),
    "Remote viewer testing requires a configured Organisation signing registry.",
  );
  test.slow();

  const demo = readOrganisationSigningEntry("demo");
  const spaceId = `playwright-viewer-space-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1_000);
  const owner = {
    name: "viewer-export-owner",
    role: "owner",
    displayName: "Coach Viewer",
    participantId: `coach-${randomUUID()}`,
  } satisfies Participant;
  const ownerSource = launchUrl(LOCAL_WORKER_ORIGIN, "demo", spaceId, demo, owner, now);
  const frame = await mountParticipant(page, LOCAL_PARENT_URL, owner, ownerSource);

  const rectangleId = await drawRectangle(frame);
  const canvasBounds = await frame.locator("#board-canvas").boundingBox();
  expect(canvasBounds).not.toBeNull();
  if (canvasBounds === null) throw new Error("The board canvas has no layout bounds.");
  await frame.getByRole("button", { name: /^Text/u }).click();
  await frame
    .page()
    .mouse.click(
      canvasBounds.x + canvasBounds.width * 0.58,
      canvasBounds.y + canvasBounds.height * 0.3,
    );
  const editor = frame.getByTestId("canvas-text-editor");
  await expect(editor).toBeVisible();
  await editor.fill("Shared viewer words");
  await editor.press("Control+Enter");
  await expect(frame.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(frame.locator("#drawing-area .board-item-text")).toContainText(
    "Shared viewer words",
  );

  await frame.getByTestId("settings-button").click();
  const viewerFlowSettings = frame.getByTestId("settings-drawer");
  await expect(viewerFlowSettings).toBeVisible();
  await expandToolPermissions(frame);
  await viewerFlowSettings.getByRole("checkbox", { name: "Enable Images" }).check();
  await viewerFlowSettings.getByRole("button", { name: "Close settings" }).click();
  const imageChooser = frame.page().waitForEvent("filechooser");
  await chooseMoreTool(frame, "tool-image");
  await (await imageChooser).setFiles(VIEWER_PNG_FILE);
  const ownerImage = frame.locator("#drawing-area .board-item-image");
  await expect(ownerImage).toHaveCount(1);
  await expect(ownerImage).toHaveAttribute("data-image-state", "ready");
  await expect(frame.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const ownerToken = new URLSearchParams(new URL(ownerSource).hash.slice(1)).get("launch");
  if (ownerToken === null) throw new Error("The owner assertion is missing.");
  const boardId = new URL(frame.url()).pathname.split("/").at(-1);
  if (boardId === undefined) throw new Error("The derived board ID is missing.");
  const exported = await frame.evaluate(
    async ({ organisationKey, board, token }) => {
      const response = await fetch(
        `/api/v1/organisations/${encodeURIComponent(organisationKey)}/boards/${encodeURIComponent(board)}/export.json`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          cache: "no-store",
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { organisationKey: "demo", board: boardId, token: ownerToken },
  );
  expect(exported.status).toBe(200);
  expect(exported.body).toMatchObject({
    format: "cf-whiteboard-json",
    version: 1,
    boardId,
    settings: { title: spaceId },
    items: expect.arrayContaining([
      expect.objectContaining({ id: rectangleId, kind: "rectangle" }),
      expect.objectContaining({
        kind: "text",
        geometry: expect.objectContaining({ text: "Shared viewer words" }),
      }),
      expect.objectContaining({
        kind: "image",
        geometry: expect.objectContaining({
          assetId: expect.stringMatching(/^asset_[A-Za-z0-9_-]{43}$/u),
          mimeType: "image/png",
        }),
      }),
    ]),
  });

  const viewerParticipant = {
    name: "signed-viewer",
    role: "viewer",
    displayName: "Read-only reviewer",
    participantId: `viewer-${randomUUID()}`,
  } satisfies Participant;
  const viewerSource = launchUrl(
    LOCAL_WORKER_ORIGIN,
    "demo",
    spaceId,
    demo,
    viewerParticipant,
    now,
  ).replace("/embed#", "/viewer#");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: LOCAL_WORKER_ORIGIN,
  });
  await page.goto(viewerSource);
  await expect(page.getByTestId("read-only-space-viewer")).toBeVisible();
  await expect(page).toHaveURL(/\/viewer$/u);
  await expect(page.locator("#drawing-area .board-item")).toHaveCount(
    (exported.body as { items: unknown[] }).items.length,
  );
  await expect(page.locator("#drawing-area .board-item-text")).toContainText("Shared viewer words");
  const signedViewerImage = page.locator("#drawing-area .board-item-image");
  await expect(signedViewerImage).toHaveCount(1);
  await expect(signedViewerImage).toHaveAttribute("data-image-state", "ready");
  await expect(signedViewerImage.locator(".image-card-content")).toHaveAttribute("href", /^blob:/u);
  await expect(page.getByRole("button", { name: /^Shapes/u })).toHaveCount(0);
  await expect(page.getByTestId("settings-button")).toHaveCount(0);

  const copyText = page.getByRole("button", { name: "Copy all Space text" });
  await copyText.click();
  await expect(copyText).toHaveText("Copied");
  const copiedText = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedText).toContain("Shared viewer words");

  const zoom = page.locator("[data-viewer-zoom]");
  const zoomBefore = await zoom.textContent();
  await page.locator("[data-viewer-zoom-in]").click();
  await expect(zoom).not.toHaveText(zoomBefore ?? "");

  const viewerCanvas = page.locator("#board-canvas");
  const viewBoxBefore = await viewerCanvas.getAttribute("viewBox");
  const viewerBounds = await viewerCanvas.boundingBox();
  expect(viewerBounds).not.toBeNull();
  if (viewerBounds === null) throw new Error("The viewer canvas has no layout bounds.");
  await page.mouse.move(
    viewerBounds.x + viewerBounds.width - 30,
    viewerBounds.y + viewerBounds.height - 30,
  );
  await page.mouse.down();
  await page.mouse.move(
    viewerBounds.x + viewerBounds.width - 110,
    viewerBounds.y + viewerBounds.height - 80,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect(viewerCanvas).not.toHaveAttribute("viewBox", viewBoxBefore ?? "");

  await page.screenshot({
    path: testInfo.outputPath("signed-read-only-viewer.png"),
    fullPage: false,
  });

  const adminSource = launchUrl(LOCAL_WORKER_ORIGIN, "demo", spaceId, demo, owner, now, {
    organisationAdmin: true,
  }).replace("/embed#", "/organisation/admin#");
  await page.goto(adminSource);
  await expect(page).toHaveURL(/\/organisation\/admin$/u);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();
  const spaceRow = page.getByRole("row").filter({ hasText: spaceId });
  await expect(spaceRow).toBeVisible();
  await expect(spaceRow).toContainText("Coach Viewer");
  await expect(spaceRow.getByRole("link")).toHaveAttribute("href", /\/viewer#launch=/u);
  await page.screenshot({
    path: testInfo.outputPath("organisation-admin.png"),
    fullPage: false,
  });
});

test("Organisation owners share reusable templates across Spaces", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The Organisation template flow runs once.");
  test.skip(
    Boolean(process.env.PLAYWRIGHT_BASE_URL),
    "Remote Organisation testing requires a configured parent origin and signing registry.",
  );
  test.slow();

  const demo = readOrganisationSigningEntry("demo");
  const now = Math.floor(Date.now() / 1_000);
  const participant = {
    name: "template-owner-a",
    role: "owner",
    displayName: "Coach Templates",
    participantId: `coach-${randomUUID()}`,
  } satisfies Participant;
  const templateName = `Reflection ${randomUUID().slice(0, 8)}`;
  const source = await mountParticipant(
    page,
    LOCAL_PARENT_URL,
    participant,
    launchUrl(
      LOCAL_WORKER_ORIGIN,
      "demo",
      `playwright-template-space-a-${randomUUID()}`,
      demo,
      participant,
      now,
    ),
  );

  const sourceItemId = await drawRectangle(source);
  await selectItem(source, sourceItemId);
  await chooseMoreTool(source, "activities-button");
  const sourceMenu = source.getByTestId("activities-menu");
  await expect(sourceMenu).toBeVisible();
  await expect(sourceMenu.getByTestId("activity-exit-ticket")).toBeVisible();
  const saveSelection = sourceMenu.locator("[data-save-organisation-template]");
  await expect(saveSelection).toBeVisible();
  await expect(saveSelection).toBeEnabled();
  await saveSelection.click();

  const dialog = source.getByRole("dialog", { name: "Save selected objects" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("1 selected object", { exact: true })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name" }).fill(templateName);
  await dialog
    .getByRole("textbox", { name: /^Description/u })
    .fill("Reusable across Spaces in the demo Organisation.");
  await dialog.getByRole("button", { name: "Save template" }).click();
  await expect(dialog).toBeHidden();
  await expect(source.getByTestId("toast-region")).toContainText(
    `${templateName} saved for this organisation.`,
  );

  const destinationContext = await browser.newContext(isolatedContextOptions(testInfo, 33));
  const ordinaryContext = await browser.newContext(isolatedContextOptions(testInfo, 34));
  try {
    const destinationPage = await destinationContext.newPage();
    const destinationParticipant = { ...participant, name: "template-owner-b" };
    const destination = await mountParticipant(
      destinationPage,
      LOCAL_PARENT_URL,
      destinationParticipant,
      launchUrl(
        LOCAL_WORKER_ORIGIN,
        "demo",
        `playwright-template-space-b-${randomUUID()}`,
        demo,
        destinationParticipant,
        now,
      ),
    );
    await chooseMoreTool(destination, "activities-button");
    const destinationMenu = destination.getByTestId("activities-menu");
    const addTemplate = destinationMenu.getByRole("menuitem", {
      name: `Add ${templateName} organisation template`,
    });
    await expect(addTemplate).toBeVisible();
    await expect(addTemplate).toContainText("Reusable across Spaces in the demo Organisation.");
    await addTemplate.click();
    await expect(destination.locator("#drawing-area [data-item-id]")).toHaveCount(1);
    await expect(destination.getByTestId("selection-actions")).toBeVisible();
    await expect(destination.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
    const destinationItemId = await destination
      .locator("#drawing-area [data-item-id]")
      .getAttribute("data-item-id");
    expect(destinationItemId).not.toBe(sourceItemId);

    const ordinaryPage = await ordinaryContext.newPage();
    let ordinaryTemplateResponseSeen = false;
    ordinaryPage.on("response", (response) => {
      if (response.url().includes("/organisation/templates") && response.status() === 200) {
        ordinaryTemplateResponseSeen = true;
      }
    });
    await createBoard(ordinaryPage, `Ordinary Space ${randomUUID().slice(0, 8)}`);
    await expect.poll(() => ordinaryTemplateResponseSeen).toBe(true);
    await chooseMoreTool(ordinaryPage, "activities-button");
    const ordinaryMenu = ordinaryPage.getByTestId("activities-menu");
    await expect(ordinaryMenu.getByTestId("activity-exit-ticket")).toBeVisible();
    await expect(ordinaryMenu.locator("[data-organisation-templates-section]")).toBeHidden();
  } finally {
    await Promise.all([destinationContext.close(), ordinaryContext.close()]);
  }
});

test("an Organisation assertion cannot borrow another Organisation's signing key", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The cross-Organisation check runs once.");
  test.skip(
    Boolean(process.env.PLAYWRIGHT_BASE_URL),
    "Remote Organisation testing requires a configured parent origin and signing registry.",
  );

  const demo = readOrganisationSigningEntry("demo");
  const participant = {
    name: "wrong-organisation",
    role: "owner",
    displayName: "Coach Outside Demo",
    participantId: `coach-${randomUUID()}`,
  } satisfies Participant;
  const source = launchUrl(
    LOCAL_WORKER_ORIGIN,
    "another-organisation",
    `playwright-space-${randomUUID()}`,
    demo,
    participant,
    Math.floor(Date.now() / 1_000),
  );
  const frame = await mountParticipantFrame(page, LOCAL_PARENT_URL, participant, source);

  await expect(frame.getByTestId("fatal-screen")).toBeVisible();
  await expect(frame.getByTestId("board-shell")).toHaveCount(0);
  const location = new URL(frame.url());
  expect(location.pathname).toBe("/embed");
  expect(location.search).toBe("");
  expect(location.hash).toBe("");
});

test("Organisation owner configures and sends the Space webhook from Settings", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The Organisation webhook flow runs once.");
  test.skip(
    Boolean(process.env.PLAYWRIGHT_BASE_URL),
    "Remote Organisation testing must not mock a production webhook endpoint.",
  );

  const organisationId = `o_${"O".repeat(22)}`;
  const actorId = `a_${"A".repeat(22)}`;
  const destination = "https://hooks.partner.example/spacescale";
  let webhookUrl: string | null = null;
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.route(
    /\/api\/v1\/boards\/b_[A-Za-z\d_-]{22}\/organisation\/settings$/u,
    async (route) => {
      const request = route.request();
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as { webhookUrl: string | null };
        webhookUrl = body.webhookUrl;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          organisationId,
          webhookUrl,
          updatedBy: webhookUrl === null ? null : actorId,
          updatedAt: webhookUrl === null ? null : 1_786_156_200_000,
        }),
      });
    },
  );
  await page.route(
    /\/api\/v1\/boards\/b_[A-Za-z\d_-]{22}\/organisation\/webhook$/u,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          delivery: {
            id: `whd_${"D".repeat(22)}`,
            event: "board.exported",
            createdAt: 1_786_156_200_100,
            responseStatus: 204,
          },
          idempotentReplay: false,
        }),
      });
    },
  );

  const demo = readOrganisationSigningEntry("demo");
  const participant = {
    name: "webhook-owner",
    role: "owner",
    displayName: "Coach Integrations",
    participantId: `coach-${randomUUID()}`,
  } satisfies Participant;
  const frame = await mountParticipant(
    page,
    LOCAL_PARENT_URL,
    participant,
    launchUrl(
      LOCAL_WORKER_ORIGIN,
      "demo",
      `playwright-webhook-space-${randomUUID()}`,
      demo,
      participant,
      Math.floor(Date.now() / 1_000),
    ),
  );
  expect(new URL(frame.url()).pathname).toMatch(/^\/embed\/b\/b_[A-Za-z\d_-]{22}$/u);

  await frame.getByTestId("settings-button").click();
  const settings = frame.getByTestId("settings-drawer");
  await expect(settings).toBeVisible();
  const webhook = settings.getByTestId("organisation-webhook-settings");
  await expect(webhook).toBeVisible();
  const input = webhook.getByRole("textbox", { name: "Webhook URL" });
  const send = webhook.getByRole("button", { name: "Send this Space now" });
  await expect(input).toHaveValue("");
  await expect(send).toBeDisabled();

  await input.fill(destination);
  await webhook.getByRole("button", { name: "Save URL" }).click();
  await expect(input).toHaveValue(destination);
  await expect(webhook.getByText(/^Configured/u)).toBeVisible();
  await expect(send).toBeEnabled();

  page.once("dialog", (dialog) => void dialog.accept());
  await send.click();
  await expect(frame.getByTestId("toast-region")).toContainText(
    "Space sent to the organisation webhook (HTTP 204).",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(webhook).toBeVisible();
  await expect(input).toHaveValue(destination);
  await webhook.scrollIntoViewIfNeeded();
  await expect(send).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("organisation-webhook-settings-mobile.png"),
    fullPage: false,
  });
  expect(consoleErrors).toEqual([]);
});

function readDevVar(name: string): string {
  const localVariablesFile = process.env.LOCAL_DEV_VARS_FILE ?? ".generated/.dev.vars";
  const contents = readFileSync(localVariablesFile, "utf8");
  const line = contents
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith(`${name}=`));
  if (line === undefined) throw new Error(`${name} is missing from ${localVariablesFile}.`);
  const raw = line.slice(line.indexOf("=") + 1).trim();
  const quoted =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"));
  const value = quoted ? raw.slice(1, -1) : raw;
  if (value.length === 0) throw new Error(`${name} is empty in ${localVariablesFile}.`);
  return value;
}

function readOrganisationSigningEntry(organisationId: string): {
  current: { key_id: string; key: string };
} {
  const registry = JSON.parse(
    readDevVar("ORGANISATION_SIGNING_KEYS"),
  ) as OrganisationSigningRegistry;
  const entry = registry[organisationId];
  if (
    entry === undefined ||
    typeof entry.current?.key_id !== "string" ||
    typeof entry.current.key !== "string"
  ) {
    throw new Error(`Organisation ${organisationId} is missing a current signing key.`);
  }
  return entry;
}

function launchUrl(
  workerOrigin: string,
  organisationId: string,
  spaceId: string,
  signing: { current: { key_id: string; key: string } },
  participant: Participant,
  issuedAt: number,
  options: { organisationAdmin?: boolean } = {},
): string {
  const payload = {
    v: 1,
    aud: "localhost",
    organisation_id: organisationId,
    space_id: spaceId,
    key_id: signing.current.key_id,
    role: participant.role,
    display_name: participant.displayName,
    participant_id: participant.participantId,
    iat: issuedAt,
    exp: issuedAt + 60 * 60,
    ...(options.organisationAdmin ? { organisation_admin: true } : {}),
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signed = `el1.${payloadPart}`;
  const signature = createHmac("sha256", signing.current.key)
    .update(signed, "utf8")
    .digest("base64url");
  return `${workerOrigin}/embed#launch=${encodeURIComponent(`${signed}.${signature}`)}`;
}

async function mountParticipant(
  page: Page,
  parentUrl: string,
  participant: Participant,
  source: string,
): Promise<Frame> {
  const frame = await mountParticipantFrame(page, parentUrl, participant, source);
  await expect
    .poll(() => sanitizedFrameLocation(frame), { timeout: 15_000 })
    .toMatch(/^\/embed\/b\/b_[A-Za-z\d_-]{22}$/u);
  await expect(frame.getByTestId("board-shell")).toBeVisible();
  await expect(frame.locator("#board-canvas")).toHaveAttribute("data-ready", "true");
  await expect(frame.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return frame;
}

async function mountParticipantFrame(
  page: Page,
  parentUrl: string,
  participant: Participant,
  source: string,
): Promise<Frame> {
  await page.goto(parentUrl);
  await expect(page.getByRole("heading", { name: "Classroom test host" })).toBeVisible();
  await page.evaluate(
    ({ frameName, frameSource, title }) => {
      document.documentElement.style.height = "100%";
      document.body.style.height = "100%";
      document.body.style.margin = "0";
      const iframe = document.createElement("iframe");
      iframe.name = frameName;
      iframe.title = `${title} whiteboard`;
      iframe.src = frameSource;
      iframe.referrerPolicy = "no-referrer";
      iframe.sandbox.add(
        "allow-scripts",
        "allow-same-origin",
        "allow-downloads",
        "allow-modals",
        "allow-forms",
      );
      iframe.allow = "clipboard-write";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      document.body.replaceChildren(iframe);
    },
    {
      frameName: participant.name,
      frameSource: source,
      title: participant.displayName,
    },
  );

  await expect
    .poll(
      () => {
        const frame = page.frame({ name: participant.name });
        return frame !== null && frame.url() !== "about:blank";
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const frame = page.frame({ name: participant.name });
  if (frame === null) throw new Error(`The ${participant.name} iframe did not load.`);
  return frame;
}

function sanitizedFrameLocation(frame: Frame | null): string {
  if (frame === null || frame.url() === "about:blank") return "";
  const url = new URL(frame.url());
  return `${url.pathname}${url.hash === "" ? "" : "#redacted"}`;
}

async function drawRectangle(frame: Frame): Promise<string> {
  const items = frame.locator("#drawing-area [data-item-id]");
  const before = await items.count();
  await frame.getByTestId("tool-rectangle").click();
  await frame.getByTestId("shape-rectangle").click();
  await frame.locator("#board-canvas").evaluate((node) => {
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
    const bounds = canvas.getBoundingClientRect();
    const points = [
      {
        x: bounds.left + bounds.width * 0.3,
        y: bounds.top + bounds.height * 0.35,
      },
      {
        x: bounds.left + bounds.width * 0.42,
        y: bounds.top + bounds.height * 0.47,
      },
      {
        x: bounds.left + bounds.width * 0.5,
        y: bounds.top + bounds.height * 0.55,
      },
    ];
    points.forEach((point, index) => {
      const last = index === points.length - 1;
      canvas.dispatchEvent(
        new PointerEvent(index === 0 ? "pointerdown" : last ? "pointerup" : "pointermove", {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 701,
          pointerType: "mouse",
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: last ? 0 : 1,
          pressure: last ? 0 : 0.5,
        }),
      );
    });
  });
  await expect(items).toHaveCount(before + 1);
  await expect(frame.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const itemId = await items.nth(before).getAttribute("data-item-id");
  if (itemId === null) throw new Error("The authoritative item ID is missing.");
  return itemId;
}

async function selectItem(frame: Frame, itemId: string): Promise<void> {
  await frame.getByRole("button", { name: /^Select and move/u }).click();
  const item = frame.locator(`#drawing-area [data-item-id="${itemId}"]`);
  const bounds = await item.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) throw new Error("The item has no layout bounds.");
  await frame.page().mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(frame.getByTestId("selection-actions")).toBeVisible();
}

function captureCspErrors(page: Page, errors: string[]): void {
  page.on("console", (message) => {
    const text = message.text();
    if (/content security policy|refused to frame/iu.test(text)) errors.push(text);
  });
}

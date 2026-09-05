import { expect, test } from "@playwright/test";
import {
  canvasPoint,
  chooseMoreTool,
  createBoard,
  expandToolPermissions,
  openSettingsDrawer,
} from "./helpers";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (input: unknown, options: { signal: AbortSignal }) => Promise<Record<string, unknown>>;
};

declare global {
  interface Window {
    __spaceScaleWebMcpTools: Record<string, RegisteredTool>;
  }
}

/** A 1×1 opaque PNG: the smallest picture the board's upload path will accept. */
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Definitions the build keeps but withholds from every host; none may reach a linked page. */
const WITHHELD_TOOLS = [
  "add_collective_reasoning",
  "add_content_visuals",
  "add_group_decision_scaffold",
  "add_idea_sensemaking",
  "add_learning_action_plan",
  "add_thinking_expansion",
  "comment_on_watched_step",
  "explain_selected_ideas",
  "inspect_selected_board_visual",
  "inspire_from_selected_ideas",
  "list_class_collaboration_modes",
  "read_selected_class_ideas",
  "stage_class_decision",
  "stage_collective_inquiry",
];

test("a board participant can use headless WebMCP tools with neutral board attribution", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The WebMCP demo-path smoke runs in Chromium.");
  test.setTimeout(60_000);

  await page.addInitScript(() => {
    const tools: Record<string, RegisteredTool> = {};
    Object.defineProperty(window, "__spaceScaleWebMcpTools", { value: tools });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: RegisteredTool, options?: { signal?: AbortSignal }) {
          tools[tool.name] = tool;
          options?.signal?.addEventListener(
            "abort",
            () => {
              delete tools[tool.name];
            },
            { once: true },
          );
        },
      },
    });
  });

  await createBoard(page, "Collective inquiry demo");
  await page.getByTestId("settings-button").click();
  const settingsDrawer = page.getByTestId("settings-drawer");
  await expandToolPermissions(page);
  await expect(settingsDrawer.getByRole("checkbox", { name: "Enable Images" })).toBeChecked();
  await page.getByTestId("settings-button").click();

  // The shipped surface: the reads, the generic inserts, the template fill, the move, and
  // nothing else.
  await expect
    .poll(() => page.evaluate(() => Object.keys(window.__spaceScaleWebMcpTools).sort()))
    .toEqual([
      "insert_comment",
      "insert_filled_template",
      "insert_image",
      "insert_sticky",
      "insert_video",
      "list_users",
      "move_stickies",
      "read_board",
      "read_live_class_vote",
      "read_selection",
      "read_templates",
      "read_user",
      "watch_board",
      "watch_users",
    ]);
  expect(
    await page.evaluate(
      (withheld) => withheld.filter((name) => name in window.__spaceScaleWebMcpTools),
      WITHHELD_TOOLS,
    ),
  ).toEqual([]);

  // The compact header control reports readiness and opens a page-session call history.
  const webMcpStatus = page.getByTestId("webmcp-status");
  const webMcpStatusTime = page.getByTestId("webmcp-status-time");
  const mcpActivity = page.getByTestId("mcp-activity-menu");
  await expect(webMcpStatus).toHaveAttribute("data-state", "ready");
  await expect(webMcpStatus).toHaveAttribute("data-host", "linked");
  await expect(webMcpStatus).toContainText("MCP");
  await expect(webMcpStatusTime).toHaveText("Ready");
  const [topbarBounds, mcpBounds] = await Promise.all([
    page.locator(".topbar").boundingBox(),
    webMcpStatus.boundingBox(),
  ]);
  expect(topbarBounds).not.toBeNull();
  expect(mcpBounds).not.toBeNull();
  if (!topbarBounds || !mcpBounds) throw new Error("The MCP header control has no layout bounds.");
  expect(
    Math.abs(topbarBounds.x + topbarBounds.width / 2 - (mcpBounds.x + mcpBounds.width / 2)),
  ).toBeLessThan(1);
  await expect(page.getByTestId("save-status")).not.toContainText("·");
  await webMcpStatus.click();
  await expect(mcpActivity).toBeVisible();
  await expect(mcpActivity).toContainText(/\d+ site tools ready/u);
  await expect(mcpActivity).toContainText("No MCP calls in this tab yet.");
  await webMcpStatus.click();
  await expect(mcpActivity).toBeHidden();
  // The AI button exists only while a problem-step watch is live in this browser.
  await expect(page.locator("[data-selection-ai-wrap]")).toBeHidden();
  await expect(page.getByTestId("ai-watch-indicator")).toHaveCount(0);
  await expect(page.getByTestId("tool-ai")).toBeHidden();
  expect(
    await page.evaluate(() => window.__spaceScaleWebMcpTools.watch_board?.annotations),
  ).toEqual({ readOnlyHint: true, untrustedContentHint: true });
  expect(
    await page.evaluate(() => window.__spaceScaleWebMcpTools.insert_comment?.annotations),
  ).toEqual({ readOnlyHint: false, untrustedContentHint: true });

  // A description is the contract a host reads at discovery; naming a withheld tool sends it to
  // a call that cannot succeed.
  const advertised = await page.evaluate(() =>
    Object.fromEntries(
      Object.entries(window.__spaceScaleWebMcpTools).map(([name, tool]) => [
        name,
        tool.description,
      ]),
    ),
  );
  for (const description of Object.values(advertised)) {
    for (const withheld of WITHHELD_TOOLS) {
      expect(description).not.toContain(withheld);
    }
  }

  const templates = await page.evaluate(() => {
    const tool = window.__spaceScaleWebMcpTools.read_templates;
    if (!tool) throw new Error("The template reader was not registered.");
    return tool.execute({}, { signal: new AbortController().signal });
  });
  expect(templates).toMatchObject({
    scope: "board_activity_templates",
    writeTool: "insert_filled_template",
  });
  expect(Number(templates.templateCount)).toBeGreaterThan(0);
  expect(JSON.stringify(templates)).not.toContain("itemId");

  await chooseMoreTool(page, "activities-button");
  await page.getByTestId("activity-collective-inquiry-demo").click();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  const canvasItems = page.locator("#drawing-area [data-item-id]");
  await expect(canvasItems).toHaveCount(13);

  // One reading of each scope, and the participant ids the user tools take.
  const reads = await page.evaluate(async () => {
    const signal = new AbortController().signal;
    const tools = window.__spaceScaleWebMcpTools;
    const call = async (name: string, input: unknown) => {
      const tool = tools[name];
      if (!tool) throw new Error(`${name} was not registered.`);
      return tool.execute(input, { signal });
    };
    const board = await call("read_board", {});
    const users = await call("list_users", {});
    const first = (users.participants as Array<{ participantId: string }>)[0];
    if (!first) throw new Error("list_users found nobody with saved work.");
    const user = await call("read_user", { participantIds: [first.participantId] });
    // Inserting the activity leaves everything it created selected.
    const selection = await call("read_selection", {});
    return { board, users, user, selection, participantId: first.participantId };
  });
  expect(reads.board).toMatchObject({ status: "read", scope: "entire_board", itemCount: 13 });
  expect(reads.board.followUp).toMatchObject({ watchTool: "watch_board" });
  expect(reads.users).toMatchObject({ scope: "participants_with_saved_work" });
  // The activity was inserted by this participant, so their work is the whole board.
  expect(reads.user).toMatchObject({ scope: "participants", itemCount: 13 });
  expect(JSON.stringify(reads.board)).not.toContain("itemId");
  expect(reads.selection).toMatchObject({ scope: "browser_selection", itemCount: 13 });

  // A selection-scoped watch follows exactly what the browser has selected.
  const scopedWatch = await page.evaluate(async () => {
    const tool = window.__spaceScaleWebMcpTools.watch_board;
    if (!tool) throw new Error("watch_board was not registered.");
    const started = await tool.execute(
      { action: "start", scope: "selection" },
      { signal: new AbortController().signal },
    );
    await tool.execute(
      { action: "stop", watchToken: started.watchToken },
      { signal: new AbortController().signal },
    );
    return started;
  });
  expect(scopedWatch).toMatchObject({ status: "started", scope: "browser_selection" });
  expect((scopedWatch.steps as unknown[]).length).toBe(13);

  // Both selection scopes read the live selection rather than falling back to the board: with
  // nothing selected they refuse, and say which scope would have worked.
  await page.getByRole("button", { name: /^Select/u }).click();
  const empty = await canvasPoint(page, 0.06, 0.92);
  await page.mouse.click(empty.x, empty.y);
  await expect(page.getByTestId("selection-actions")).toBeHidden();
  const emptySelection = await page.evaluate(async () => {
    const signal = new AbortController().signal;
    const attempt = async (name: string, input: unknown) => {
      const tool = window.__spaceScaleWebMcpTools[name];
      if (!tool) throw new Error(`${name} was not registered.`);
      try {
        await tool.execute(input, { signal });
        return "unexpected success";
      } catch (error) {
        return (error as Error).message;
      }
    };
    return {
      read: await attempt("read_selection", {}),
      watch: await attempt("watch_board", { action: "start", scope: "selection" }),
    };
  });
  expect(emptySelection.read).toContain("Nothing is selected in this browser");
  expect(emptySelection.watch).toContain("Nothing is selected in this browser");

  const userWatch = await page.evaluate(async (participantId) => {
    const tool = window.__spaceScaleWebMcpTools.watch_users;
    if (!tool) throw new Error("watch_users was not registered.");
    const started = await tool.execute(
      { action: "start", participantIds: [participantId] },
      { signal: new AbortController().signal },
    );
    await tool.execute(
      { action: "stop", watchToken: started.watchToken },
      { signal: new AbortController().signal },
    );
    return started;
  }, reads.participantId);
  expect(userWatch).toMatchObject({ status: "started", scope: "participants" });
  expect(userWatch.nextCall).toMatchObject({ tool: "watch_users" });

  const watchStart = await page.evaluate(() => {
    const tool = window.__spaceScaleWebMcpTools.watch_board;
    if (!tool) throw new Error("The problem-step watch was not registered.");
    return tool.execute({ action: "start" }, { signal: new AbortController().signal });
  });
  expect(watchStart).toMatchObject({
    status: "started",
    durationSeconds: 900,
    nextSeq: expect.any(Number),
    canComment: true,
    steps: expect.arrayContaining([expect.objectContaining({ kind: "sticky" })]),
  });
  await expect(page.getByTestId("ai-watch-indicator")).toHaveCount(0);
  await expect(webMcpStatusTime).toHaveText(/^\d+ min left$/u);
  await expect(webMcpStatus).toHaveAttribute("data-state", "watch");

  // Ask AI acts on the selection, which the scope checks above deliberately emptied.
  const askBounds = await page.locator("#drawing-area .board-item-sticky").first().boundingBox();
  if (!askBounds) throw new Error("The sticky has no layout bounds.");
  await page.mouse.click(askBounds.x + askBounds.width / 2, askBounds.y + askBounds.height / 2);
  await expect(page.getByTestId("selection-actions")).toBeVisible();
  const askAi = page.getByTestId("selection-ai");
  await expect(askAi).toBeVisible();
  await expect(askAi).toBeEnabled();
  await expect(askAi.locator(".ai-sparkle")).toHaveCSS("color", "rgb(201, 167, 255)");

  // A request from the board resolves the host's pending wait with a reply plan that names
  // the generic comment write.
  const requestedResult = page.evaluate(
    ({ watchToken, afterSeq }) => {
      const tool = window.__spaceScaleWebMcpTools.watch_board;
      if (!tool) throw new Error("The problem-step watch was not registered.");
      return tool.execute(
        { action: "wait", watchToken, afterSeq, waitMs: 20_000 },
        { signal: new AbortController().signal },
      );
    },
    { watchToken: String(watchStart.watchToken), afterSeq: Number(watchStart.nextSeq) },
  );
  await expect(webMcpStatus).toHaveAttribute("data-state", "active");
  await askAi.click();
  const aiMenu = page.getByTestId("ai-assist-menu");
  await expect(aiMenu).toBeVisible();
  // The menu is the actions and one instruction field: no scope label, no explainer.
  await expect(aiMenu.locator("[data-ai-assist-scope]")).toHaveCount(0);
  await expect(aiMenu.locator(".ai-assist-menu-note")).toHaveCount(0);
  await expect(aiMenu.locator(".ai-assist-note span")).toHaveText("Other instruction");
  await expect(aiMenu).toBeVisible();
  await expect(aiMenu.getByRole("menuitem")).toHaveCount(6);
  await expect(aiMenu.getByRole("menuitem", { name: "Grade" })).toHaveCount(0);
  await aiMenu.locator("[data-ai-assist-note]").fill("Not sure about the second step");
  await aiMenu.getByRole("menuitem", { name: "Critique" }).click();
  await expect(aiMenu).toBeHidden();
  await expect(page.getByTestId("toast-region")).toContainText(
    "Sent to the AI assistant: Critique",
  );
  const requested = await requestedResult;
  expect(requested).toMatchObject({
    status: "requested",
    continueWatching: true,
    canComment: true,
    requests: [
      {
        action: "critique",
        note: "Not sure about the second step",
        reply: {
          via: "comment",
          call: {
            tool: "insert_comment",
            input: {
              watchToken: watchStart.watchToken,
              stepAlias: expect.any(String),
              action: "critique",
            },
          },
        },
      },
    ],
  });

  // The request covered every watched step and left no single selection behind, so the reply
  // plan's watchToken and stepAlias are the only handle on what is being answered.
  const stepAlias = String(
    (requested.requests as Array<{ reply: { call: { input: { stepAlias: string } } } }>)[0]?.reply
      .call.input.stepAlias,
  );
  const answered = await page.evaluate(
    ({ watchToken, alias }) => {
      const tool = window.__spaceScaleWebMcpTools.insert_comment;
      if (!tool) throw new Error("The comment write was not registered.");
      return tool.execute(
        {
          watchToken,
          stepAlias: alias,
          action: "critique",
          body: "Check the division step: $6/2=3$, so $x=3$.",
        },
        { signal: new AbortController().signal },
      );
    },
    { watchToken: String(watchStart.watchToken), alias: stepAlias },
  );
  expect(answered).toMatchObject({ status: "commented", stepAlias, writtenBy: "ai" });
  await expect(page.locator("[data-comments-count]")).toHaveText("1");
  await expect(webMcpStatus).toHaveAttribute("data-state", "watch");
  await expect(webMcpStatusTime).not.toHaveText(/^\d+ min left$/u);
  await expect(webMcpStatusTime).not.toHaveText("Ready");
  await webMcpStatus.click();
  await expect(mcpActivity).toContainText("insert_comment");
  await expect(mcpActivity).toContainText("Completed");
  await expect(mcpActivity).not.toContainText("watch_board");
  await webMcpStatus.click();
  await expect(mcpActivity).toBeHidden();
  await openSettingsDrawer(page);
  await page.getByTestId("comments-button").click();
  const answeredDrawer = page.getByTestId("comments-drawer");
  await expect(answeredDrawer.locator(".comment-card")).toHaveCount(1);
  await expect(answeredDrawer.locator(".comment-card .assistance-tag")).toHaveText("AI · Critique");
  await expect(answeredDrawer.locator(".comment-card strong").first()).not.toHaveText("AI");
  await answeredDrawer.getByRole("button", { name: "Close comments" }).click();

  const watchResult = page.evaluate(
    ({ watchToken, afterSeq }) => {
      const tool = window.__spaceScaleWebMcpTools.watch_board;
      if (!tool) throw new Error("The problem-step watch was not registered.");
      return tool.execute(
        { action: "wait", watchToken, afterSeq, waitMs: 20_000 },
        { signal: new AbortController().signal },
      );
    },
    { watchToken: String(watchStart.watchToken), afterSeq: Number(watchStart.nextSeq) },
  );
  const firstSticky = page.locator("#drawing-area .board-item-sticky").first();
  const firstStickyBounds = await firstSticky.boundingBox();
  if (!firstStickyBounds) throw new Error("The watched sticky has no layout bounds.");
  await page.getByRole("button", { name: /^Select/u }).click();
  await page.mouse.dblclick(
    firstStickyBounds.x + firstStickyBounds.width / 2,
    firstStickyBounds.y + firstStickyBounds.height / 2,
  );
  const stickyEditor = page.getByTestId("canvas-text-editor");
  await expect(stickyEditor).toHaveAttribute("aria-label", "Edit sticky note");
  await stickyEditor.fill(`${await stickyEditor.inputValue()}\nA newly saved problem step.`);
  await stickyEditor.press("Control+Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  expect(await watchResult).toMatchObject({
    status: "changed",
    changes: [
      {
        steps: [
          {
            alias: expect.any(String),
            kind: "sticky",
            change: "updated",
            text: expect.stringContaining("A newly saved problem step."),
          },
        ],
      },
    ],
  });
  await page.evaluate((watchToken) => {
    const tool = window.__spaceScaleWebMcpTools.watch_board;
    if (!tool) throw new Error("The problem-step watch was not registered.");
    return tool.execute({ action: "stop", watchToken }, { signal: new AbortController().signal });
  }, String(watchStart.watchToken));
  await expect(page.locator("[data-selection-ai-wrap]")).toBeHidden();
  await expect(page.getByTestId("ai-watch-indicator")).toHaveCount(0);
  await expect(page.getByTestId("tool-ai")).toBeHidden();

  // Each generic write lands one object where the call asks, tagged as written by AI.
  const written = await page.evaluate(
    async ({ png }) => {
      const signal = new AbortController().signal;
      const tools = window.__spaceScaleWebMcpTools;
      for (const name of ["insert_sticky", "insert_image", "insert_video"]) {
        if (!tools[name]) throw new Error(`${name} was not registered.`);
      }
      const sticky = await tools.insert_sticky?.execute(
        {
          location: { x: 640, y: 60 },
          text: "What would change your mind about $x=3$?",
          fill: "mint",
        },
        { signal },
      );
      const video = await tools.insert_video?.execute(
        { location: { x: 640, y: 320 }, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { signal },
      );
      const image = await tools.insert_image?.execute(
        { location: { x: 640, y: 620 }, imageDataUrl: png, alt: "A single grey pixel" },
        { signal },
      );
      return { sticky, video, image };
    },
    { png: TINY_PNG },
  );
  expect(written.sticky).toMatchObject({
    status: "inserted",
    objectKind: "sticky",
    location: { x: 640, y: 60 },
    aiAttributed: true,
    undoable: true,
  });
  expect(written.video).toMatchObject({ status: "inserted", objectKind: "video" });
  expect(written.image).toMatchObject({ status: "inserted", objectKind: "image" });
  expect(JSON.stringify(written)).not.toContain("itemId");

  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(canvasItems).toHaveCount(16);
  await expect(page.locator('#drawing-area [data-assisted-by="ai"]')).toHaveCount(3);
  await expect(page.locator("#drawing-area .creator-badge-ai").first()).toBeVisible();
  await expect(page.locator("#drawing-area")).not.toContainText("AI-assisted");

  // A comment attaches to whatever saved object covers the location it names, so the note the
  // assistant just wrote is a target like any other.
  const commented = await page.evaluate(() => {
    const tool = window.__spaceScaleWebMcpTools.insert_comment;
    if (!tool) throw new Error("The comment write was not registered.");
    return tool.execute(
      // The centre of the 180x140 note written at 640, 60.
      { location: { x: 730, y: 130 }, body: "Check the division step: $6/2=3$, so $x=3$." },
      { signal: new AbortController().signal },
    );
  });
  expect(commented).toMatchObject({ status: "commented", objectKind: "sticky", writtenBy: "ai" });
  await expect(page.locator("[data-comments-count]")).toHaveText("2");
  await openSettingsDrawer(page);
  await page.getByTestId("comments-button").click();
  const commentsDrawer = page.getByTestId("comments-drawer");
  await expect(commentsDrawer.locator(".comment-card")).toHaveCount(2);
  // The watch reply carries the action it answered; the coordinate-targeted one has none.
  await expect(commentsDrawer.locator(".comment-card .assistance-tag")).toHaveText([
    "AI",
    "AI · Critique",
  ]);
  await expect(commentsDrawer.locator(".comment-card strong").first()).not.toHaveText("AI");
  await commentsDrawer.getByRole("button", { name: "Close comments" }).click();
  await openSettingsDrawer(page);

  // Every write is one ordinary command, so each undoes on its own.
  for (const remaining of [15, 14, 13]) {
    await page.waitForTimeout(300);
    await page.getByTestId("undo-button").click();
    await expect(canvasItems).toHaveCount(remaining);
    await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  }

  // A write the board cannot place refuses rather than guessing.
  const refusals = await page.evaluate(async () => {
    const signal = new AbortController().signal;
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["insert_sticky", { text: "a", fill: "neon" }],
      ["insert_video", { url: "https://example.com/clip.mp4" }],
      ["insert_image", { imageDataUrl: "https://example.com/cat.png", alt: "A cat" }],
    ];
    const messages: string[] = [];
    for (const [name, input] of attempts) {
      const tool = window.__spaceScaleWebMcpTools[name];
      if (!tool) throw new Error(`${name} was not registered.`);
      try {
        await tool.execute(input, { signal });
        messages.push("unexpected success");
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    return messages;
  });
  expect(refusals[0]).toContain("fill must be");
  expect(refusals[1]).toContain("YouTube or Vimeo");
  expect(refusals[2]).toContain("never fetches an external image");
  await expect(canvasItems).toHaveCount(13);

  // Grouping work: the move rearranges notes already on the board rather than adding any.
  const grouped = await page.evaluate(async () => {
    const signal = new AbortController().signal;
    const insert = window.__spaceScaleWebMcpTools.insert_sticky;
    const move = window.__spaceScaleWebMcpTools.move_stickies;
    if (!insert || !move) throw new Error("The move write was not registered.");
    await insert.execute({ location: { x: 200, y: 700 }, text: "Group me" }, { signal });
    return move.execute(
      // The centre of the 180x140 note just written at 200, 700.
      { moves: [{ at: { x: 290, y: 770 }, to: { x: 900, y: 900 } }] },
      { signal },
    );
  });
  expect(grouped).toMatchObject({
    status: "moved",
    movedCount: 1,
    notes: [{ from: { x: 290, y: 770 }, to: { x: 900, y: 900 }, by: { x: 610, y: 130 } }],
    undoable: true,
  });
  expect(JSON.stringify(grouped)).not.toContain("itemId");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  // One note was added and then moved, so the board grew by one rather than by two.
  await expect(canvasItems).toHaveCount(14);
  const movedNote = page.locator('#drawing-area [data-assisted-by="ai"]');
  await expect(movedNote).toHaveCount(1);
  await expect(movedNote).toHaveAttribute("transform", "matrix(1 0 0 1 610 130)");

  // The rearrangement is one step, so a single undo puts the note back where it started.
  await page.getByTestId("undo-button").click();
  await expect(movedNote).toHaveAttribute("transform", "matrix(1 0 0 1 0 0)");
  await expect(canvasItems).toHaveCount(14);

  // The template fill is a two-call flow: the read names the slots, the write fills them.
  const filled = await page.evaluate(async () => {
    const signal = new AbortController().signal;
    const read = window.__spaceScaleWebMcpTools.read_templates;
    const insert = window.__spaceScaleWebMcpTools.insert_filled_template;
    if (!read || !insert) throw new Error("The template fill flow was not registered.");
    const catalogue = (await read.execute({ templateId: "kwl" }, { signal })) as {
      writeTool?: string;
      templates: Array<{ templateId: string; slots: Array<{ slot: string }> }>;
    };
    const template = catalogue.templates[0];
    const first = template?.slots[0];
    if (!template || !first) throw new Error("The K-W-L template reported no slots.");
    const written = await insert.execute(
      { templateId: template.templateId, fills: [{ slot: first.slot, text: "Volcanoes" }] },
      { signal },
    );
    return { writeTool: catalogue.writeTool, slot: first.slot, written };
  });
  // The read hands the host straight on to the writer it just used.
  expect(filled.writeTool).toBe("insert_filled_template");
  expect(filled.written).toMatchObject({
    status: "inserted",
    templateId: "kwl",
    filledSlotCount: 1,
    filledSlots: [filled.slot],
    aiAttributed: true,
    undoable: true,
  });
  expect(JSON.stringify(filled.written)).not.toContain("itemId");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(page.locator("#drawing-area")).toContainText("Volcanoes");

  // The whole template is one batch, so one undo takes all of it back off the board.
  await page.getByTestId("undo-button").click();
  await expect(canvasItems).toHaveCount(14);
  await expect(page.locator("#drawing-area")).not.toContainText("Volcanoes");
});

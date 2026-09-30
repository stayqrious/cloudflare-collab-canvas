import { afterEach, describe, expect, it, vi } from "vitest";

import type { BoardItem, DurableOperation, NewBoardItem } from "../types";
import { BoardWriteWebMcp, type StickyMove, type WatchedStepTarget } from "./board-writes";
import { webMcpToolDefinitions } from "./shared";
import type { RegisteredWebMcpTool, WebMcpRegisterToolOptions } from "./types";

const ACTOR_ID = "018f0000-0000-7000-8000-0000000000a1";
const STICKY_ID = "018f0000-0000-7000-8000-0000000000b1";

const PNG = `data:image/png;base64,${"r".repeat(24)}`;

function sticky(): BoardItem {
  return {
    id: STICKY_ID,
    kind: "sticky",
    z: 1,
    version: 4,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: { kind: "sticky", fill: "#ffe299", textColor: "#1e1e1e", fontSize: 20, opacity: 1 },
    geometry: { x: 0, y: 0, width: 180, height: 140, text: "Let $2x=6$" },
  };
}

function harness(
  options: {
    canWrite?: boolean;
    canComment?: boolean;
    imagesEnabled?: boolean;
    featureIssue?: (kind: "sticky" | "image" | "video") => string | null;
    itemAt?: BoardItem | undefined;
    selected?: BoardItem | null;
    resolveWatchedStep?: (watchToken: string, stepAlias: string) => WatchedStepTarget;
    resolveWatchedStickies?: (
      watchToken: string,
      stepAliases: readonly string[],
    ) => Map<string, BoardItem>;
    moveItems?: (moves: readonly StickyMove[]) => Promise<void>;
    commit?: (operation: DurableOperation) => Promise<boolean>;
  } = {},
) {
  const exposed = new Map<string, RegisteredWebMcpTool>();
  const tools = webMcpToolDefinitions();
  vi.stubGlobal("document", {
    modelContext: {
      registerTool(tool: RegisteredWebMcpTool, registration?: WebMcpRegisterToolOptions) {
        exposed.set(tool.name, tool);
        registration?.signal?.addEventListener("abort", () => exposed.delete(tool.name), {
          once: true,
        });
      },
    },
  });
  const committed: DurableOperation[] = [];
  const comments: Array<{
    itemId: string;
    body: string;
    assistance: unknown;
    media?: unknown;
  }> = [];
  const revealed: string[][] = [];
  const movedBatches: StickyMove[][] = [];
  const notices: string[] = [];
  const stored: string[] = [];
  const writes = new BoardWriteWebMcp({
    canWrite: () => options.canWrite ?? true,
    canComment: () => options.canComment ?? true,
    imagesEnabled: () => options.imagesEnabled ?? true,
    featureIssue: options.featureIssue ?? (() => null),
    getStyle: () => ({
      stickyFill: "#ffe299",
      stickyTextColor: "#1e1e1e",
      stickyFontSize: 20,
      stickyOpacity: 1,
      textColor: "#1e1e1e",
      textFontSize: 28,
      textFontFamily: "sans",
      textOpacity: 1,
    }),
    getPlacementCenter: () => [120, 80],
    itemAt: () => options.itemAt,
    getSelectedItem: () => options.selected ?? null,
    ...(options.resolveWatchedStep ? { resolveWatchedStep: options.resolveWatchedStep } : {}),
    ...(options.resolveWatchedStickies
      ? { resolveWatchedStickies: options.resolveWatchedStickies }
      : {}),
    moveItems:
      options.moveItems ??
      (async (moves) => {
        movedBatches.push([...moves]);
      }),
    commit:
      options.commit ??
      (async (operation) => {
        committed.push(operation);
        return true;
      }),
    createComment: async (itemId, body, assistance, media) => {
      comments.push({ itemId, body, assistance, media });
    },
    storeImage: async (imageDataUrl) => {
      stored.push(imageDataUrl);
      return {
        assetId: `asset_${"A".repeat(43)}`,
        mimeType: "image/png",
        intrinsicWidth: 1_200,
        intrinsicHeight: 600,
      };
    },
    revealItems: (itemIds) => revealed.push([...itemIds]),
    notify: (message) => notices.push(message),
  });
  const call = async (name: string, input: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not defined.`);
    return (await tool.execute(input, { signal: new AbortController().signal })) as Record<
      string,
      unknown
    >;
  };
  const styleFor = () => () => ({
    stickyFill: "#ffe299",
    stickyTextColor: "#1e1e1e",
    stickyFontSize: 20,
    stickyOpacity: 1,
    textColor: "#1e1e1e",
    textFontSize: 28,
    textFontFamily: "sans" as const,
    textOpacity: 1,
  });
  return {
    writes,
    tools,
    exposed,
    committed,
    comments,
    revealed,
    movedBatches,
    notices,
    stored,
    call,
    styleFor,
  };
}

function createdItem(
  operation: DurableOperation | undefined,
): NewBoardItem & { assistedBy?: "ai" } {
  if (operation?.kind !== "item.create") throw new Error("Expected a single item create.");
  return operation.item as NewBoardItem & { assistedBy?: "ai" };
}

async function ready(...args: Parameters<typeof harness>) {
  const context = harness(...args);
  await vi.waitFor(() => expect(context.exposed.has("insert_sticky")).toBe(true));
  return context;
}

describe("generic board writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes exactly the generic writes to a host", async () => {
    const { writes, exposed } = await ready();
    expect([...exposed.keys()].sort()).toEqual([
      "insert_comment",
      "insert_image",
      "insert_sticky",
      "insert_video",
      "move_stickies",
    ]);
    writes.destroy();
  });

  it("writes a sticky at the given location, tagged as AI written", async () => {
    const { writes, committed, revealed, call } = await ready();
    const result = await call("insert_sticky", {
      location: { x: 40.005, y: -12 },
      text: "  What would change your mind?  ",
      fill: "mint",
    });

    const item = createdItem(committed[0]);
    expect(item.kind).toBe("sticky");
    expect(item.assistedBy).toBe("ai");
    if (item.kind !== "sticky") throw new Error("Expected a sticky note.");
    expect(item.geometry).toMatchObject({ x: 40.01, y: -12, text: "What would change your mind?" });
    expect(item.style).toMatchObject({ fill: "#b3efbd" });
    expect(result).toMatchObject({
      status: "inserted",
      objectKind: "sticky",
      location: { x: 40.01, y: -12 },
      aiAttributed: true,
      undoable: true,
    });
    expect(revealed).toEqual([[item.id]]);
    writes.destroy();
  });

  it("lands at the centre of this participant's view when no location is given", async () => {
    const { writes, committed, call } = await ready();
    await call("insert_sticky", { text: "" });
    const item = createdItem(committed[0]);
    if (item.kind !== "sticky") throw new Error("Expected a sticky note.");
    // An empty note is allowed: it leaves the card for a participant to complete.
    expect(item.geometry).toMatchObject({ x: 120, y: 80, text: "" });
    writes.destroy();
  });

  it("refuses a fill outside the board palette and a location off the board", async () => {
    const { writes, call } = await ready();
    await expect(call("insert_sticky", { text: "a", fill: "neon" })).rejects.toThrow(
      "fill must be",
    );
    await expect(
      call("insert_sticky", { text: "a", location: { x: 2_000_000, y: 0 } }),
    ).rejects.toThrow("location.x must be between");
    await expect(call("insert_sticky", { text: "a", location: { x: 1 } })).rejects.toThrow(
      "location.y must be a finite number",
    );
    writes.destroy();
  });

  it("refuses to write without edit access or when the Space disables the object", async () => {
    const readOnly = await ready({ canWrite: false });
    await expect(readOnly.call("insert_sticky", { text: "a" })).rejects.toThrow("edit access");
    readOnly.writes.destroy();

    const gated = await ready({ featureIssue: () => "Enable sticky notes to add one." });
    await expect(gated.call("insert_sticky", { text: "a" })).rejects.toThrow(
      "Enable sticky notes to add one.",
    );
    expect(gated.committed).toHaveLength(0);
    gated.writes.destroy();
  });

  it("stores an inline image and refuses an external URL", async () => {
    const { writes, committed, stored, call } = await ready();
    await expect(
      call("insert_image", { imageDataUrl: "https://example.com/cat.png", alt: "A cat" }),
    ).rejects.toThrow("never fetches an external image");
    expect(stored).toHaveLength(0);

    await call("insert_image", { location: { x: 0, y: 0 }, imageDataUrl: PNG, alt: "  A cat  " });
    const item = createdItem(committed[0]);
    if (item.kind !== "image") throw new Error("Expected an image card.");
    expect(stored).toEqual([PNG]);
    expect(item.assistedBy).toBe("ai");
    expect(item.geometry).toMatchObject({ alt: "A cat", intrinsicWidth: 1_200 });
    writes.destroy();
  });

  it("refuses an image card when the Space has images switched off", async () => {
    const { writes, call, stored } = await ready({ imagesEnabled: false });
    await expect(call("insert_image", { imageDataUrl: PNG, alt: "A cat" })).rejects.toThrow(
      "disabled for this Space",
    );
    expect(stored).toHaveLength(0);
    writes.destroy();
  });

  it("embeds a supported video link and refuses anything else", async () => {
    const { writes, committed, call } = await ready();
    await expect(call("insert_video", { url: "https://example.com/clip.mp4" })).rejects.toThrow(
      "YouTube or Vimeo",
    );

    const result = await call("insert_video", {
      location: { x: 0, y: 0 },
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const item = createdItem(committed[0]);
    if (item.kind !== "text") throw new Error("Expected a canvas text object.");
    expect(item.geometry).toMatchObject({ embed: "video" });
    expect(item.assistedBy).toBe("ai");
    expect(result).toMatchObject({ objectKind: "video", provider: "youtube" });
    writes.destroy();
  });

  it("comments on the object under the given location", async () => {
    const { writes, comments, call } = await ready({ itemAt: sticky() });
    const result = await call("insert_comment", {
      location: { x: 20, y: 20 },
      body: "  Which step does $x=3$ follow from?  ",
    });
    expect(comments).toEqual([
      {
        itemId: STICKY_ID,
        body: "Which step does $x=3$ follow from?",
        assistance: { tool: "insert_comment" },
      },
    ]);
    expect(result).toMatchObject({ status: "commented", objectKind: "sticky", writtenBy: "ai" });
    writes.destroy();
  });

  it("carries a picture on a comment through the board's own asset path", async () => {
    const { writes, comments, stored, call } = await ready({ itemAt: sticky() });
    const result = await call("insert_comment", {
      location: { x: 20, y: 20 },
      body: "Compare your sketch with this one.",
      imageDataUrl: PNG,
      alt: "  A parabola opening upward  ",
    });

    expect(stored).toEqual([PNG]);
    expect(comments[0]?.media).toEqual({
      kind: "image",
      assetId: `asset_${"A".repeat(43)}`,
      mimeType: "image/png",
      intrinsicWidth: 1_200,
      intrinsicHeight: 600,
      alt: "A parabola opening upward",
    });
    expect(result).toMatchObject({ status: "commented", media: "image" });
    writes.destroy();
  });

  it("carries a public video on a comment without storing anything", async () => {
    const { writes, comments, stored, call } = await ready({ itemAt: sticky() });
    const result = await call("insert_comment", {
      body: "This clip walks through the same step.",
      location: { x: 20, y: 20 },
      videoUrl: "https://youtu.be/dQw4w9WgXcQ",
    });

    expect(stored).toEqual([]);
    expect(comments[0]?.media).toEqual({
      kind: "video",
      provider: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(result).toMatchObject({ status: "commented", media: "video" });
    writes.destroy();
  });

  it("refuses comment media it cannot take, before claiming a comment target", async () => {
    const { writes, comments, call } = await ready({ itemAt: sticky() });
    await expect(
      call("insert_comment", { body: "Both?", imageDataUrl: PNG, alt: "A sketch", videoUrl: "x" }),
    ).rejects.toThrow("one picture or one video");
    await expect(call("insert_comment", { body: "No picture", alt: "A sketch" })).rejects.toThrow(
      "alt describes imageDataUrl",
    );
    await expect(
      call("insert_comment", { body: "Watch", videoUrl: "https://example.com/clip" }),
    ).rejects.toThrow("YouTube or Vimeo");
    await expect(
      call("insert_comment", { body: "Look", imageDataUrl: "https://example.com/a.png", alt: "A" }),
    ).rejects.toThrow("never fetches an external image");
    await expect(call("insert_comment", { body: "Look", imageDataUrl: PNG })).rejects.toThrow(
      "alt must be text",
    );
    await expect(
      call("insert_comment", { body: "Look", imageDataUrl: PNG, alt: "   " }),
    ).rejects.toThrow("alt must contain 1-");
    expect(comments).toHaveLength(0);
    writes.destroy();

    const off = await ready({ itemAt: sticky(), imagesEnabled: false });
    await expect(
      off.call("insert_comment", { body: "Look", imageDataUrl: PNG, alt: "A sketch" }),
    ).rejects.toThrow("Images are disabled");
    expect(off.comments).toHaveLength(0);
    off.writes.destroy();

    const readOnly = await ready({ itemAt: sticky(), canWrite: false });
    await expect(
      readOnly.call("insert_comment", { body: "Look", imageDataUrl: PNG, alt: "A sketch" }),
    ).rejects.toThrow("board edit access");
    expect(readOnly.comments).toHaveLength(0);
    readOnly.writes.destroy();
  });

  it("falls back to the lone selection, and says so when it cannot find a target", async () => {
    const selected = await ready({ selected: sticky() });
    await selected.call("insert_comment", { body: "Say more?" });
    expect(selected.comments[0]?.itemId).toBe(STICKY_ID);
    selected.writes.destroy();

    const empty = await ready();
    await expect(empty.call("insert_comment", { body: "Say more?" })).rejects.toThrow(
      "Name the object to comment on",
    );
    empty.writes.destroy();

    const missed = await ready({ itemAt: undefined });
    await expect(
      missed.call("insert_comment", { location: { x: 5, y: 5 }, body: "Say more?" }),
    ).rejects.toThrow("No saved object covers 5, 5");
    missed.writes.destroy();
  });

  it("refuses an empty or oversized comment, and a browser that cannot comment", async () => {
    const { writes, call } = await ready({ itemAt: sticky() });
    await expect(call("insert_comment", { body: "   " })).rejects.toThrow("1-2000 characters");
    await expect(call("insert_comment", { body: "x".repeat(2_001) })).rejects.toThrow(
      "1-2000 characters",
    );
    writes.destroy();

    const muted = await ready({ canComment: false, itemAt: sticky() });
    await expect(muted.call("insert_comment", { body: "Say more?" })).rejects.toThrow(
      "cannot comment on this Space",
    );
    expect(muted.comments).toHaveLength(0);
    muted.writes.destroy();
  });

  it("reports a write the board would not queue", async () => {
    const { writes, call } = await ready({ commit: async () => false });
    await expect(call("insert_sticky", { text: "a" })).rejects.toThrow("could not be queued");
    writes.destroy();
  });

  it("comments on a watched step whatever the participant has selected now", async () => {
    const released: boolean[] = [];
    const resolveWatchedStep = vi.fn(
      (watchToken: string, stepAlias: string, action?: "critique" | "explain") => {
        if (watchToken !== "watch-1") throw new Error("This problem-step watch is missing.");
        if (stepAlias !== "step_2") throw new Error("stepAlias is not part of this watch.");
        return {
          // The watch resolves the tag from the action the caller answered, not from its own
          // per-alias memory, which a later request on the same step would have overwritten.
          ...(action === undefined ? {} : { action }),
          itemId: STICKY_ID,
          release: (posted: boolean) => released.push(posted),
        };
      },
    );
    // No location and nothing selected: the alias is the only handle, which is the case a
    // request over several steps, or none, leaves behind.
    const { writes, comments, notices, call } = await ready({ resolveWatchedStep });
    const result = await call("insert_comment", {
      watchToken: "watch-1",
      stepAlias: "step_2",
      action: "critique",
      body: "Check the division step.",
    });
    expect(resolveWatchedStep).toHaveBeenCalledWith("watch-1", "step_2", "critique");
    expect(comments).toEqual([
      {
        itemId: STICKY_ID,
        body: "Check the division step.",
        // The action the watch was answering rides along, so the board tags it "AI · Critique".
        assistance: { tool: "insert_comment", action: "critique" },
      },
    ]);
    expect(released).toEqual([true]);
    expect(result).toMatchObject({ status: "commented", stepAlias: "step_2", writtenBy: "ai" });
    expect(notices.some((notice) => notice.includes("step_2"))).toBe(true);
    writes.destroy();
  });

  it("releases the watch's comment slot when the post fails, and reports a bad alias", async () => {
    const released: boolean[] = [];
    const resolveWatchedStep = (): WatchedStepTarget => ({
      itemId: STICKY_ID,
      release: (posted: boolean) => released.push(posted),
    });
    const context = harness({ resolveWatchedStep });
    await vi.waitFor(() => expect(context.exposed.has("insert_comment")).toBe(true));
    // A failed post must not spend the watch's comment budget.
    const failing = new BoardWriteWebMcp({
      canWrite: () => true,
      canComment: () => true,
      imagesEnabled: () => true,
      featureIssue: () => null,
      getStyle: context.styleFor(),
      getPlacementCenter: () => [0, 0],
      itemAt: () => undefined,
      getSelectedItem: () => null,
      resolveWatchedStep,
      commit: async () => true,
      createComment: async () => {
        throw new Error("The board refused the comment.");
      },
      storeImage: async () => {
        throw new Error("unused");
      },
      revealItems: () => undefined,
      notify: () => undefined,
    });
    const tool = webMcpToolDefinitions().get("insert_comment");
    if (!tool) throw new Error("insert_comment is not defined.");
    await expect(
      tool.execute(
        { watchToken: "watch-1", stepAlias: "step_1", body: "hi" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("The board refused the comment.");
    expect(released).toEqual([false]);
    failing.destroy();
    context.writes.destroy();

    const plain = await ready();
    await expect(
      plain.call("insert_comment", { watchToken: "watch-1", stepAlias: "nope", body: "hi" }),
    ).rejects.toThrow("stepAlias must look like step_1");
    await expect(
      plain.call("insert_comment", {
        watchToken: "watch-1",
        stepAlias: "step_1",
        action: "grade",
        body: "hi",
      }),
    ).rejects.toThrow("action must be one of");
    await expect(
      plain.call("insert_comment", { watchToken: "watch-1", stepAlias: "step_1", body: "hi" }),
    ).rejects.toThrow("cannot comment on a watched step");
    plain.writes.destroy();
  });

  it("works on a host that hands execute no AbortSignal at all", async () => {
    // Codex's WebMCP shim passes an options object carrying only requestUserInteraction. Reaching
    // for signal.throwIfAborted() on that threw a TypeError before any tool did its work.
    const { writes, exposed, committed } = await ready();
    const sticky = exposed.get("insert_sticky");
    if (!sticky) throw new Error("insert_sticky was not offered to the host.");

    await sticky.execute({ text: "No signal here", location: { x: 10, y: 20 } }, {
      requestUserInteraction: () => undefined,
    } as never);
    // Some hosts omit the second argument entirely.
    await sticky.execute({ text: "None at all", location: { x: 30, y: 40 } });

    expect(committed).toHaveLength(2);
    const first = createdItem(committed[0]);
    if (first.kind !== "sticky") throw new Error("Expected a sticky note.");
    expect(first.geometry).toMatchObject({ x: 10, y: 20, text: "No signal here" });
    writes.destroy();
  });

  it("bounds comments written outside a watch, and reports what is left", async () => {
    // Before this surface existed the only comment path was the watch's, capped at 20. The
    // location and selection forms have no such anchor, and the board itself stops only at
    // 10,000, so a looping host could bury a class's work.
    const { writes, comments, call } = await ready({ itemAt: sticky() });
    const at = (body: string) => call("insert_comment", { location: { x: 1, y: 1 }, body });
    expect(await at("one")).toMatchObject({ remainingUnwatchedComments: 49 });

    for (let index = 1; index < 50; index += 1) await at(`filler ${index}`);
    expect(comments).toHaveLength(50);
    await expect(at("one too many")).rejects.toThrow(
      "limit of 50 AI comments outside a board watch",
    );
    expect(comments).toHaveLength(50);
    writes.destroy();
  });

  it("does not spend the unwatched budget on a comment the board refused", async () => {
    const context = harness({ itemAt: sticky() });
    await vi.waitFor(() => expect(context.exposed.has("insert_comment")).toBe(true));
    let refuse = true;
    const posted: string[] = [];
    const writes = new BoardWriteWebMcp({
      canWrite: () => true,
      canComment: () => true,
      imagesEnabled: () => true,
      featureIssue: () => null,
      getStyle: context.styleFor(),
      getPlacementCenter: () => [0, 0],
      itemAt: () => sticky(),
      getSelectedItem: () => null,
      commit: async () => true,
      createComment: async (_itemId, body) => {
        if (refuse) throw new Error("The board refused the comment.");
        posted.push(body);
      },
      storeImage: async () => {
        throw new Error("unused");
      },
      revealItems: () => undefined,
      notify: () => undefined,
    });
    const tool = webMcpToolDefinitions().get("insert_comment");
    if (!tool) throw new Error("insert_comment is not defined.");
    const signal = new AbortController().signal;
    const run = (body: string) => tool.execute({ location: { x: 1, y: 1 }, body }, { signal });

    await expect(run("refused")).rejects.toThrow("The board refused the comment.");
    refuse = false;
    // The refusal cost nothing, so the first accepted comment still reports a full budget.
    expect(await run("accepted")).toMatchObject({ remainingUnwatchedComments: 49 });
    expect(posted).toEqual(["accepted"]);
    writes.destroy();
    context.writes.destroy();
  });

  it("moves a watched note to an absolute destination, from the centre it holds now", async () => {
    const note = sticky();
    const { writes, movedBatches, revealed, call } = await ready({
      resolveWatchedStickies: () => new Map([["step_2", note]]),
    });
    // The note spans 0,0 to 180,140, so its centre sits at 90,70 and the delta is what closes
    // the gap between that centre and the destination.
    const result = await call("move_stickies", {
      watchToken: "watch-1",
      moves: [{ stepAlias: "step_2", to: { x: 400, y: 300 } }],
    });

    expect(movedBatches).toEqual([[{ item: note, delta: { x: 310, y: 230 } }]]);
    expect(result).toMatchObject({
      status: "moved",
      movedCount: 1,
      notes: [
        {
          stepAlias: "step_2",
          from: { x: 90, y: 70 },
          to: { x: 400, y: 300 },
          by: { x: 310, y: 230 },
        },
      ],
      undoable: true,
    });
    expect(revealed).toEqual([[STICKY_ID]]);
    writes.destroy();
  });

  it("shifts a note by a relative amount and reports where it landed", async () => {
    const note = sticky();
    const { writes, movedBatches, call } = await ready({
      resolveWatchedStickies: () => new Map([["step_1", note]]),
    });
    const result = await call("move_stickies", {
      watchToken: "watch-1",
      moves: [{ stepAlias: "step_1", by: { x: -25.5, y: 12 } }],
    });

    expect(movedBatches).toEqual([[{ item: note, delta: { x: -25.5, y: 12 } }]]);
    expect(result).toMatchObject({
      notes: [{ from: { x: 90, y: 70 }, to: { x: 64.5, y: 82 }, by: { x: -25.5, y: 12 } }],
    });
    writes.destroy();
  });

  it("moves a note named by a point it covers, with no watch involved", async () => {
    const note = sticky();
    const { writes, movedBatches, call } = await ready({ itemAt: note });
    const result = await call("move_stickies", {
      moves: [{ at: { x: 10, y: 10 }, by: { x: 40, y: 0 } }],
    });

    expect(movedBatches).toEqual([[{ item: note, delta: { x: 40, y: 0 } }]]);
    // Nothing named an alias, so nothing reports one.
    expect(result.notes).toEqual([
      { from: { x: 90, y: 70 }, to: { x: 130, y: 70 }, by: { x: 40, y: 0 } },
    ]);
    writes.destroy();
  });

  it("writes nothing when every note is already where it was asked to go", async () => {
    const note = sticky();
    const { writes, movedBatches, notices, call } = await ready({ itemAt: note });
    // The destination is the centre the note already holds, so the delta comes out zero.
    const result = await call("move_stickies", {
      moves: [{ at: { x: 10, y: 10 }, to: { x: 90, y: 70 } }],
    });

    expect(result).toMatchObject({ status: "unchanged", movedCount: 0, changedCanvas: false });
    expect(movedBatches).toEqual([]);
    expect(notices).toEqual([]);
    writes.destroy();
  });

  it("hands the board every note named, including one asked to stay where it is", async () => {
    const still = sticky();
    const travelling: BoardItem = { ...sticky(), id: `${STICKY_ID.slice(0, -1)}2` };
    const { writes, movedBatches, call } = await ready({
      resolveWatchedStickies: () =>
        new Map([
          ["step_1", still],
          ["step_2", travelling],
        ]),
    });
    const result = await call("move_stickies", {
      watchToken: "watch-1",
      moves: [
        { stepAlias: "step_1", by: { x: 0, y: 0 } },
        { stepAlias: "step_2", by: { x: 60, y: 0 } },
      ],
    });

    // The board carries grouped objects and a Section's members along with a move, so a note
    // dropped here for having nowhere to go is one the board could pick up and move anyway.
    expect(movedBatches).toEqual([
      [
        { item: still, delta: { x: 0, y: 0 } },
        { item: travelling, delta: { x: 60, y: 0 } },
      ],
    ]);
    // Only the note that travelled is counted as moved.
    expect(result).toMatchObject({ status: "moved", movedCount: 1 });
    writes.destroy();
  });

  it("refuses a list that names one note twice, before anything is written", async () => {
    const note = sticky();
    const { writes, movedBatches, call } = await ready({ itemAt: note });
    await expect(
      call("move_stickies", {
        moves: [
          { at: { x: 10, y: 10 }, to: { x: 400, y: 300 } },
          { at: { x: 20, y: 20 }, to: { x: 500, y: 300 } },
        ],
      }),
    ).rejects.toThrow("moves[1] names the same note as moves[0]");
    expect(movedBatches).toEqual([]);
    writes.destroy();
  });

  it("moves sticky notes only", async () => {
    const text: BoardItem = {
      ...sticky(),
      kind: "text",
      geometry: { x: 0, y: 0, text: "A heading" },
    } as BoardItem;
    const { writes, movedBatches, call } = await ready({ itemAt: text });
    await expect(
      call("move_stickies", { moves: [{ at: { x: 1, y: 1 }, by: { x: 10, y: 10 } }] }),
    ).rejects.toThrow("moves[0] names a text, and this tool moves sticky notes only.");
    expect(movedBatches).toEqual([]);
    writes.destroy();
  });

  it("insists on exactly one way to name a note and one way to place it", async () => {
    const { writes, call } = await ready({ itemAt: sticky() });
    await expect(
      call("move_stickies", {
        moves: [{ stepAlias: "step_1", at: { x: 1, y: 1 }, by: { x: 1, y: 1 } }],
      }),
    ).rejects.toThrow("moves[0] must name its note either by stepAlias or by at");
    await expect(call("move_stickies", { moves: [{ by: { x: 1, y: 1 } }] })).rejects.toThrow(
      "moves[0] must name its note either by stepAlias or by at",
    );
    await expect(
      call("move_stickies", {
        moves: [{ at: { x: 1, y: 1 }, to: { x: 2, y: 2 }, by: { x: 1, y: 1 } }],
      }),
    ).rejects.toThrow("moves[0] must give either to, a destination, or by, a shift");
    await expect(call("move_stickies", { moves: [{ at: { x: 1, y: 1 } }] })).rejects.toThrow(
      "moves[0] must give either to, a destination, or by, a shift",
    );
    writes.destroy();
  });

  it("keeps watchToken and stepAlias together", async () => {
    const { writes, call } = await ready({ itemAt: sticky() });
    await expect(
      call("move_stickies", {
        watchToken: "watch-1",
        moves: [{ at: { x: 1, y: 1 }, by: { x: 1, y: 1 } }],
      }),
    ).rejects.toThrow("watchToken names the watch a stepAlias came from");
    await expect(
      call("move_stickies", { moves: [{ stepAlias: "step_1", by: { x: 1, y: 1 } }] }),
    ).rejects.toThrow("watchToken must be text.");
    writes.destroy();
  });

  it("refuses to move anything without board edit access", async () => {
    const { writes, movedBatches, call } = await ready({ canWrite: false, itemAt: sticky() });
    await expect(
      call("move_stickies", { moves: [{ at: { x: 1, y: 1 }, by: { x: 10, y: 0 } }] }),
    ).rejects.toThrow("board edit access");
    expect(movedBatches).toEqual([]);
    writes.destroy();
  });

  it("reports the move the board accepted even when the host aborts mid-commit", async () => {
    const note = sticky();
    const controller = new AbortController();
    const applied: StickyMove[][] = [];
    const { writes, tools } = harness({
      itemAt: note,
      moveItems: async (moves) => {
        // The board takes the batch, then the host walks away before the answer arrives.
        applied.push([...moves]);
        controller.abort();
      },
    });
    await vi.waitFor(() => expect(tools.has("move_stickies")).toBe(true));
    const tool = tools.get("move_stickies");
    if (!tool) throw new Error("move_stickies is not defined.");

    // Telling the caller it failed would have it retry the shift and move the note twice.
    const result = await tool.execute(
      { moves: [{ at: { x: 1, y: 1 }, by: { x: 30, y: 0 } }] },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ status: "moved", movedCount: 1 });
    expect(applied).toHaveLength(1);
    writes.destroy();
  });

  it("passes the board's refusal back to the caller", async () => {
    const note = sticky();
    const { writes, revealed, notices, call } = await ready({
      itemAt: note,
      moveItems: async () => {
        throw new Error("This arrangement includes a note this browser cannot modify.");
      },
    });
    await expect(
      call("move_stickies", { moves: [{ at: { x: 1, y: 1 }, by: { x: 10, y: 0 } }] }),
    ).rejects.toThrow("This arrangement includes a note this browser cannot modify.");
    expect(revealed).toEqual([]);
    expect(notices).toEqual([]);
    writes.destroy();
  });

  it("withdraws its tools when the page tears down", async () => {
    const { writes, tools, exposed } = await ready();
    writes.destroy();
    expect(exposed.size).toBe(0);
    expect(tools.has("insert_sticky")).toBe(false);
  });
});

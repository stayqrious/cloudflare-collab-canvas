import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardItem } from "../types";
import { CollectiveInquiryWebMcp } from "./collective-inquiry";
import { MAX_WATCHED_ITEMS } from "./problem-step-watch";
import { webMcpRegistryState, webMcpToolDefinitions } from "./shared";
import type { RegisteredWebMcpTool, WebMcpRegisterToolOptions } from "./types";

const ACTOR_ID = "018f0000-0000-7000-8000-0000000000a1";
const STICKY_ID = "018f0000-0000-7000-8000-0000000000b1";

function sticky(): Extract<BoardItem, { kind: "sticky" }> {
  return {
    id: STICKY_ID,
    kind: "sticky",
    z: 1,
    version: 4,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: { kind: "sticky", fill: "#fff2a8", textColor: "#27231b", fontSize: 20, opacity: 1 },
    geometry: { x: 10, y: 10, width: 180, height: 140, text: "Let $2x=6$" },
  };
}

/** The dialog the inquiry module builds at construction; nothing here is exercised. */
function fakeDialog(): HTMLDialogElement {
  const noop = () => undefined;
  return {
    className: "",
    dataset: {},
    open: false,
    returnValue: "",
    innerHTML: "",
    setAttribute: noop,
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    close: noop,
    remove: noop,
    showModal: noop,
  } as unknown as HTMLDialogElement;
}

function harness(options: { canComment?: boolean; canWrite?: boolean; board?: BoardItem[] } = {}) {
  /** What a linked host is actually offered. */
  const exposed = new Map<string, RegisteredWebMcpTool>();
  /** Every definition the module builds, including the ones this build withholds. */
  const tools = webMcpToolDefinitions();
  const board = options.board ?? [sticky()];
  vi.stubGlobal("document", {
    createElement: () => fakeDialog(),
    modelContext: {
      registerTool(tool: RegisteredWebMcpTool, registration?: WebMcpRegisterToolOptions) {
        exposed.set(tool.name, tool);
        registration?.signal?.addEventListener("abort", () => exposed.delete(tool.name), {
          once: true,
        });
      },
    },
  });
  const created: Array<{ itemId: string; body: string; assistance: unknown }> = [];
  const notices: string[] = [];
  const inquiry = new CollectiveInquiryWebMcp({
    root: { append: () => undefined } as unknown as HTMLElement,
    getSelectedItems: () => board,
    getBoardItems: () => board,
    getAuthoritativeItem: (itemId) => board.find((item) => item.id === itemId),
    getSequence: () => 3,
    getParticipantDisplayName: () => "Sam",
    notify: (message) => notices.push(message),
    canComment: () => options.canComment ?? true,
    canWrite: () => options.canWrite ?? true,
    createComment: async (itemId, body, assistance) => {
      created.push({ itemId, body, assistance });
    },
  });
  const call = async (name: string, input: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not registered.`);
    return (await tool.execute(input, { signal: new AbortController().signal })) as Record<
      string,
      unknown
    >;
  };
  return { inquiry, tools, exposed, created, notices, call };
}

describe("watch reply tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("registers the comment tool and documents the requested status", async () => {
    const { inquiry, tools } = harness();
    await vi.waitFor(() => expect(tools.has("comment_on_watched_step")).toBe(true));
    const watchDescription = tools.get("watch_board")?.description ?? "";
    expect(watchDescription).toContain("requested");
    expect(watchDescription).toContain("boardShares");
    expect(watchDescription).not.toMatch(/\bboardShare\b/u);
    expect(tools.get("comment_on_watched_step")?.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    inquiry.destroy();
    expect(tools.has("comment_on_watched_step")).toBe(false);
  });

  it("accepts the highest generated watch alias in the schema and runtime", async () => {
    const board: BoardItem[] = Array.from({ length: MAX_WATCHED_ITEMS }, (_, index) => ({
      ...sticky(),
      id: `018f0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const finalItem = board.at(-1);
    if (!finalItem) throw new Error("Expected the watch-limit fixture to contain an item.");
    const { inquiry, tools, created, call } = harness({ board });
    await vi.waitFor(() => expect(tools.has("comment_on_watched_step")).toBe(true));
    expect(tools.get("comment_on_watched_step")?.inputSchema).toMatchObject({
      properties: {
        stepAlias: { pattern: "^step_(?:[1-9][0-9]{0,3}|10000)$" },
      },
    });

    const started = await call("watch_board", { action: "start" });
    const commented = await call("comment_on_watched_step", {
      watchToken: started.watchToken,
      stepAlias: "step_10000",
      body: "Check this final object.",
    });

    expect(commented).toMatchObject({ status: "commented", stepAlias: "step_10000" });
    expect(created.at(-1)?.itemId).toBe(finalItem.id);
    inquiry.destroy();
  });

  it("mints a selection token the add_* tools can resolve and posts a tagged comment", async () => {
    const { inquiry, tools, created, notices, call } = harness();
    await vi.waitFor(() => expect(tools.has("comment_on_watched_step")).toBe(true));
    const started = await call("watch_board", { action: "start" });
    const token = String(started.selectionToken);
    expect(started).toMatchObject({
      selectionSources: [{ stepAlias: "step_1", sourceAlias: "idea_1" }],
      canWrite: true,
    });
    expect(inquiry.getSnapshot(token)).toMatchObject({
      sources: [{ alias: "idea_1", itemId: STICKY_ID, version: 4, kind: "sticky" }],
    });
    expect(inquiry.getWatchState().phase).toBe("watching");

    inquiry.requestAssistance({ itemIds: [STICKY_ID], action: "explain" });
    inquiry.requestAssistance({ itemIds: [STICKY_ID], action: "critique" });
    const commented = await call("comment_on_watched_step", {
      watchToken: started.watchToken,
      stepAlias: "step_1",
      action: "critique",
      body: "  Check the division: $6/2=3$.  ",
    });
    expect(commented).toMatchObject({ status: "commented", stepAlias: "step_1", writtenBy: "ai" });
    expect(created).toEqual([
      {
        itemId: STICKY_ID,
        body: "Check the division: $6/2=3$.",
        assistance: { tool: "comment_on_watched_step", action: "critique" },
      },
    ]);
    expect(JSON.stringify(commented)).not.toContain(STICKY_ID);
    expect(notices.at(-1)).toBe("The AI assistant commented on step_1.");
    inquiry.destroy();
  });

  it("rejects bad aliases, oversized bodies, and browsers that cannot comment", async () => {
    const { inquiry, tools, call } = harness({ canComment: false });
    await vi.waitFor(() => expect(tools.has("comment_on_watched_step")).toBe(true));
    const started = await call("watch_board", { action: "start" });
    expect(started).toMatchObject({ canComment: false });
    const base = { watchToken: started.watchToken, stepAlias: "step_1", body: "Hello" };
    await expect(call("comment_on_watched_step", { ...base, stepAlias: "idea_1" })).rejects.toThrow(
      "stepAlias must look like step_1",
    );
    await expect(call("comment_on_watched_step", { ...base, action: "grade" })).rejects.toThrow(
      "action must be one of",
    );
    await expect(
      call("comment_on_watched_step", { ...base, body: "x".repeat(2_001) }),
    ).rejects.toThrow("1-2000 characters");
    await expect(call("comment_on_watched_step", base)).rejects.toThrow("cannot comment");
    inquiry.destroy();
  });
});

describe("list_users", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists who has saved work, with the ids the user and read tools take", async () => {
    const other: BoardItem = {
      ...sticky(),
      id: "018f0000-0000-7000-8000-0000000000c2",
      createdBy: "018f0000-0000-7000-8000-0000000000c1",
    };
    const { inquiry, exposed, call } = harness({ board: [sticky(), sticky(), other] });
    await vi.waitFor(() => expect(exposed.has("list_users")).toBe(true));
    const result = await call("list_users", {});

    expect(result).toMatchObject({
      scope: "participants_with_saved_work",
      participantCount: 2,
      watchTool: "watch_users",
      readTool: "read_user",
    });
    const participants = result.participants as Array<Record<string, unknown>>;
    // Ordered by how much work each has, so the ids a caller needs are easy to pick out.
    expect(participants[0]).toMatchObject({
      participantId: ACTOR_ID,
      displayName: "Sam",
      objectCount: 2,
      objectKinds: { sticky: 2 },
    });
    expect(participants[1]).toMatchObject({ objectCount: 1 });
    // Pinned so the shape a caller depends on cannot drift without a decision.
    expect(Object.keys(participants[0] ?? {}).sort()).toEqual([
      "displayName",
      "objectCount",
      "objectKinds",
      "participantId",
    ]);
    expect(result.note).toContain("no saved work does not appear");
    inquiry.destroy();
  });
});

describe("registered tool surface", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts a watch for a host that hands execute no AbortSignal", async () => {
    // Codex's WebMCP shim passes an options object carrying only requestUserInteraction, so
    // reaching for signal.throwIfAborted() threw a TypeError before the watch ever started.
    const { inquiry, exposed } = harness();
    await vi.waitFor(() => expect(exposed.has("watch_board")).toBe(true));
    const watch = exposed.get("watch_board");
    if (!watch) throw new Error("watch_board was not offered to the host.");

    const started = (await watch.execute({ action: "start" }, {
      requestUserInteraction: () => undefined,
    } as never)) as Record<string, unknown>;
    expect(started).toMatchObject({ status: "started", watchToken: expect.any(String) });

    // And for a host that omits the options argument altogether.
    const stopped = (await watch.execute({
      action: "stop",
      watchToken: started.watchToken,
    })) as Record<string, unknown>;
    expect(stopped).toMatchObject({ status: "stopped" });
    inquiry.destroy();
  });

  it("never names a withheld tool in the contract it advertises to a host", async () => {
    // A description is the contract a host reads at discovery. Naming a tool the allowlist
    // withholds sends it to a call that cannot succeed, which is what the reply plan already
    // avoids at runtime.
    const { inquiry, exposed } = harness();
    await vi.waitFor(() => expect(exposed.has("watch_board")).toBe(true));
    const watch = exposed.get("watch_board");
    if (!watch) throw new Error("watch_board was not offered to the host.");
    for (const withheld of [
      "comment_on_watched_step",
      "add_thinking_expansion",
      "read_selected_class_ideas",
      "inspect_selected_board_visual",
    ]) {
      expect(watch.description).not.toContain(withheld);
    }
    expect(watch.description).toContain("insert_comment");
    // Every action is answered in a comment now, so the description must not offer a card.
    expect(watch.description).not.toContain("insert_sticky");
    inquiry.destroy();
  });

  it("offers a host only the watch and drops it when the page tears down", async () => {
    const before = webMcpRegistryState().toolCount;
    const { inquiry, tools, exposed } = harness();
    await vi.waitFor(() => expect(exposed.has("watch_board")).toBe(true));

    // The selection reads and the watch's own comment channel keep their definitions but are
    // withheld from every host by ENABLED_WEBMCP_TOOLS.
    expect([...exposed.keys()].sort()).toEqual([
      "list_users",
      "read_board",
      "read_selection",
      "read_user",
      "watch_board",
      "watch_users",
    ]);
    for (const withheld of [
      "read_selected_class_ideas",
      "inspire_from_selected_ideas",
      "explain_selected_ideas",
      "inspect_selected_board_visual",
      "comment_on_watched_step",
    ]) {
      expect(tools.has(withheld)).toBe(true);
      expect(exposed.has(withheld)).toBe(false);
    }

    const linked = webMcpRegistryState();
    expect(linked.hostPresent).toBe(true);
    expect(linked.toolCount).toBe(before + exposed.size);

    inquiry.destroy();
    await vi.waitFor(() => expect(webMcpRegistryState().toolCount).toBe(before));
  });
});

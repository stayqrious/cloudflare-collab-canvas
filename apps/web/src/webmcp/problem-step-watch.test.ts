import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardItem, ServerAction } from "../types";
import {
  MAX_ASSIST_COMMENTS_PER_WATCH,
  MAX_WATCHED_ITEMS,
  PROBLEM_STEP_WATCH_DURATION_MS,
  PROBLEM_STEP_WATCH_MISSED_PINGS,
  PROBLEM_STEP_WATCH_PING_INTERVAL_MS,
  PROBLEM_STEP_WATCH_PING_TIMEOUT_MS,
  ProblemStepWatchFeed,
} from "./problem-step-watch";

const ACTOR_ID = "018f0000-0000-7000-8000-0000000000a1";
const STICKY_ID = "018f0000-0000-7000-8000-0000000000b1";
const TEXT_ID = "018f0000-0000-7000-8000-0000000000b2";
const TABLE_ID = "018f0000-0000-7000-8000-0000000000b3";
const SECTION_ID = "018f0000-0000-7000-8000-0000000000b4";
const VIDEO_ID = "018f0000-0000-7000-8000-0000000000b5";
const UNSELECTED_ID = "018f0000-0000-7000-8000-0000000000b6";
const IMAGE_ID = "018f0000-0000-7000-8000-0000000000b7";

function sticky(text = "Let $2x=6$", version = 1): Extract<BoardItem, { kind: "sticky" }> {
  return {
    id: STICKY_ID,
    kind: "sticky",
    z: 1,
    version,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "sticky",
      fill: "#fff2a8",
      textColor: "#27231b",
      fontSize: 20,
      opacity: 1,
    },
    geometry: { x: 10, y: 10, width: 180, height: 140, text },
  };
}

function canvasText(): Extract<BoardItem, { kind: "text" }> {
  return {
    id: TEXT_ID,
    kind: "text",
    z: 2,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "text",
      color: "#111827",
      fontSize: 20,
      fontFamily: "sans",
      opacity: 1,
    },
    geometry: { x: 10, y: 180, text: "Divide both sides by $2$" },
  };
}

function table(): Extract<BoardItem, { kind: "table" }> {
  return {
    id: TABLE_ID,
    kind: "table",
    z: 3,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "table",
      borderColor: "#111827",
      fill: "#ffffff",
      headerFill: "#f3f4f6",
      textColor: "#111827",
      fontSize: 16,
      opacity: 1,
    },
    geometry: {
      x: 220,
      y: 10,
      columnWidths: [100, 100],
      rowHeights: [40, 40],
      cells: [
        ["Step", "Result"],
        ["$2x/2$", "$6/2$"],
      ],
      headerRow: true,
    },
  };
}

function section(): Extract<BoardItem, { kind: "zone" }> {
  return {
    id: SECTION_ID,
    kind: "zone",
    z: 4,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "zone",
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    },
    geometry: { x: 0, y: 0, width: 520, height: 320, title: "Solve for $x$" },
  };
}

function video(): Extract<BoardItem, { kind: "text" }> {
  return {
    ...canvasText(),
    id: VIDEO_ID,
    geometry: { x: 10, y: 360, text: "https://youtu.be/example", embed: "video" },
  };
}

function imageItem(alt = "A worked diagram", version = 1): Extract<BoardItem, { kind: "image" }> {
  return {
    id: IMAGE_ID,
    kind: "image",
    z: 5,
    version,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: { kind: "image", opacity: 1, radius: 12 },
    geometry: {
      x: 260,
      y: 10,
      width: 120,
      height: 80,
      assetId: "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      alt,
      mimeType: "image/png",
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
    },
  };
}

function unselectedSticky(
  text = "Unselected private work",
  version = 1,
): Extract<BoardItem, { kind: "sticky" }> {
  return { ...sticky(text, version), id: UNSELECTED_ID, sectionId: SECTION_ID };
}

function serverAction(seq: number, item: BoardItem): ServerAction {
  return {
    v: 1,
    t: "server.action",
    seq,
    acceptedAt: Date.UTC(2026, 8, 3, 12, 0, seq),
    actor: { id: ACTOR_ID, displayName: "Sam" },
    commandId: `018f0000-0000-7000-8000-${seq.toString().padStart(12, "0")}`,
    actionId: `018f0000-0000-7000-9000-${seq.toString().padStart(12, "0")}`,
    op: {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: Math.max(0, item.version - 1),
      patch: { geometry: item.geometry },
      item,
    },
  };
}

function setup(board: BoardItem[] = [sticky()]) {
  let sequence = 7;
  const items = new Map<string, BoardItem>(
    [sticky(), canvasText(), table(), section(), video(), unselectedSticky()].map((item) => [
      item.id,
      item,
    ]),
  );
  const feed = new ProblemStepWatchFeed({
    // The board holds whatever the authoritative map currently says, as it does in the app.
    getBoardItems: () => board.map((item) => items.get(item.id) ?? item),
    getAuthoritativeItem: (itemId) => items.get(itemId),
    getSequence: () => sequence,
    getParticipantDisplayName: (participantId) =>
      participantId === ACTOR_ID ? "Sam" : "Unselected participant",
  });
  return {
    feed,
    items,
    setSequence(value: number) {
      sequence = value;
    },
  };
}

const OTHER_ACTOR_ID = "018f0000-0000-7000-8000-0000000000c1";
const OTHER_ID = "018f0000-0000-7000-8000-0000000000c2";

/** A note by someone other than Sam, for the participant and selection scopes. */
function otherPersonSticky(
  text = "Rae's working",
  version = 1,
): Extract<BoardItem, { kind: "sticky" }> {
  return { ...sticky(text, version), id: OTHER_ID, createdBy: OTHER_ACTOR_ID };
}

/** A feed whose board holds work by two people, and whose selection the test controls. */
function scopedFeed(selection: BoardItem[] | null = null) {
  const items = new Map<string, BoardItem>(
    [sticky(), canvasText(), otherPersonSticky()].map((item) => [item.id, item]),
  );
  let selected = selection;
  const feed = new ProblemStepWatchFeed({
    getBoardItems: () => [...items.values()],
    getSelectedItems: () => selected,
    getAuthoritativeItem: (itemId) => items.get(itemId),
    getSequence: () => 7,
    getParticipantDisplayName: (participantId) => (participantId === ACTOR_ID ? "Sam" : "Rae"),
  });
  const signal = new AbortController().signal;
  return {
    feed,
    items,
    signal,
    select(next: BoardItem[] | null) {
      selected = next;
    },
    aliasesOf(result: Record<string, unknown>) {
      return (result.steps as Array<{ text?: string }>).map((step) => step.text);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("problem-step WebMCP watch", () => {
  it("starts a 15-minute watch over every saved object, written or drawn", async () => {
    const unselected = unselectedSticky();
    const { feed } = setup([sticky(), canvasText(), table(), section(), video()]);

    const result = await feed.execute({ action: "start" }, new AbortController().signal);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "started",
      durationSeconds: 900,
      nextSeq: 7,
      continueWatching: true,
      steps: [
        { alias: "step_1", kind: "sticky", text: "Let $2x=6$" },
        { alias: "step_2", kind: "text", text: "Divide both sides by $2$" },
        { alias: "step_3", kind: "table", text: "Step\tResult\n$2x/2$\t$6/2$" },
        { alias: "step_4", kind: "zone", text: "Solve for $x$" },
        // A video carries no text, so it is described rather than transcribed.
        { alias: "step_5", kind: "text", visual: { description: "embedded video" } },
      ],
    });
    expect(serialized).not.toContain(STICKY_ID);
    expect(serialized).not.toContain(VIDEO_ID);
    expect(serialized).not.toContain(unselected.geometry.text);
    expect(result.privacy).toContain("follows the saved objects in its scope");
  });

  it("watches handwriting and other drawn work, and reports when it is redrawn", async () => {
    const strokes: Extract<BoardItem, { kind: "pencil" }> = {
      id: "018f0000-0000-7000-8000-0000000000c1",
      kind: "pencil",
      z: 9,
      version: 1,
      createdBy: ACTOR_ID,
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "stroke", color: "#123456", width: 4, opacity: 1 },
      geometry: {
        points: [
          [0, 0],
          [10, 12],
          [20, 4],
        ],
      },
    };
    const { feed, items } = setup([strokes]);
    items.set(strokes.id, strokes);

    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(started.steps).toMatchObject([
      {
        alias: "step_1",
        kind: "pencil",
        visual: { description: "handwriting or sketch of 3 points", revision: 1 },
      },
    ]);
    expect(started.steps).not.toMatchObject([{ text: expect.anything() }]);

    const redrawn = {
      ...strokes,
      version: 2,
      geometry: { points: [...strokes.geometry.points, [30, 18] as [number, number]] },
    };
    items.set(strokes.id, redrawn);
    feed.recordAuthoritativeAction(serverAction(8, redrawn), new Set([strokes.id]));

    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "changed",
      changes: [
        {
          steps: [
            {
              alias: "step_1",
              kind: "pencil",
              change: "updated",
              visual: { description: "handwriting or sketch of 4 points", revision: 2 },
            },
          ],
        },
      ],
    });
  });

  it("takes in an object saved after the watch started, including a Section child", async () => {
    const { feed, items, setSequence } = setup([section()]);
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(started.steps).toHaveLength(1);

    const child = unselectedSticky("A later step inside the Section", 2);
    items.set(UNSELECTED_ID, child);
    setSequence(8);
    feed.recordAuthoritativeAction(serverAction(8, child), new Set([UNSELECTED_ID]));

    const result = await feed.execute(
      { action: "wait", watchToken: String(started.watchToken), afterSeq: 7 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "changed",
      nextSeq: 8,
      changes: [
        {
          steps: [
            {
              alias: "step_2",
              kind: "sticky",
              change: "created",
              text: "A later step inside the Section",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(UNSELECTED_ID);
    feed.destroy();
  });

  it("resolves a pending wait with an authoritative selected-step update", async () => {
    const { feed, items, setSequence } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const pending = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 20_000 },
      new AbortController().signal,
    );
    const updated = sticky("Therefore $x=3$", 2);
    items.set(STICKY_ID, updated);
    setSequence(8);

    feed.recordAuthoritativeAction(serverAction(8, updated), new Set([STICKY_ID]));

    await expect(pending).resolves.toMatchObject({
      status: "changed",
      nextSeq: 8,
      changes: [
        {
          seq: 8,
          actor: { displayName: "Sam" },
          steps: [{ alias: "step_1", kind: "sticky", change: "updated", text: "Therefore $x=3$" }],
        },
      ],
      nextCall: { input: { action: "wait", afterSeq: 8, waitMs: 15_000 } },
    });
    feed.destroy();
  });

  it("times out cleanly, releases an aborted wait, and expires after 15 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
    const { feed } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const timeout = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timeout).resolves.toMatchObject({
      status: "timeout",
      nextSeq: 7,
      remainingSeconds: 899,
      continueWatching: true,
    });

    const controller = new AbortController();
    const aborted = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      controller.signal,
    );
    controller.abort(new Error("stop waiting"));
    await expect(aborted).rejects.toThrow("stop waiting");

    const retry = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retry).resolves.toMatchObject({ status: "timeout" });

    vi.setSystemTime(new Date(Date.now() + PROBLEM_STEP_WATCH_DURATION_MS));
    await expect(
      feed.execute(
        { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ status: "expired", continueWatching: false });
    feed.destroy();
  });

  it("reports a resync with fresh text when the board is reloaded wholesale", async () => {
    vi.useFakeTimers();
    const { feed, items, setSequence } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const pending = feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 5_000 },
      new AbortController().signal,
    );

    // Sequence-gap recovery and snapshot restore replace authoritative state outright, so no
    // individual action ever reaches the feed for the changes the replacement carried.
    items.set(STICKY_ID, sticky("Let $2x=6$ so $x=3$", 4));
    setSequence(42);
    feed.recordAuthoritativeReload(42);

    const result = await pending;
    expect(result).toMatchObject({ status: "resync", nextSeq: 42 });
    expect(result.steps).toEqual([
      {
        alias: "step_1",
        kind: "sticky",
        text: "Let $2x=6$ so $x=3$",
        createdBy: { displayName: "Sam" },
      },
    ]);

    // Following the returned nextCall resumes the long poll. Repeating the snapshot here would
    // make the agent process one reload twice.
    const followUp = feed.execute(
      { action: "wait", watchToken, afterSeq: 42, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await followUp).toMatchObject({ status: "timeout", nextSeq: 42 });

    // A caller still holding a pre-reload sequence resolves to a resync on its own merit.
    const stale = await feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    expect(stale).toMatchObject({ status: "resync", nextSeq: 42 });
    feed.destroy();
  });

  it("resyncs once on the next wait when a board reload finds no wait in flight", async () => {
    vi.useFakeTimers();
    const { feed, items, setSequence } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);

    items.set(STICKY_ID, sticky("Reloaded step", 4));
    setSequence(42);
    feed.recordAuthoritativeReload(42);

    const first = await feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    expect(first).toMatchObject({ status: "resync", nextSeq: 42 });
    const second = feed.execute(
      { action: "wait", watchToken, afterSeq: 42, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await second).toMatchObject({ status: "timeout", nextSeq: 42 });
    feed.destroy();
  });

  it("keeps a change recordable when a step snapshot would have been updated first", async () => {
    const { feed, items } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const update = sticky("Let $2x=6$ so $x=3$", 2);
    items.set(STICKY_ID, update);

    // acceptedAt passes frame validation as a safe integer but cannot be formatted as a date.
    const hostile = { ...serverAction(8, update), acceptedAt: Number.MAX_SAFE_INTEGER };
    expect(() => feed.recordAuthoritativeAction(hostile, new Set([STICKY_ID]))).not.toThrow();

    const result = await feed.execute(
      { action: "wait", watchToken, afterSeq: 7, waitMs: 1_000 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "changed", nextSeq: 8 });
    expect(result.changes).toMatchObject([
      { seq: 8, steps: [{ alias: "step_1", change: "updated" }] },
    ]);
    feed.destroy();
  });

  it("ends a watch on stop and on replacement with guidance not to wait again", async () => {
    const { feed } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    const stopped = await feed.execute(
      { action: "stop", watchToken },
      new AbortController().signal,
    );
    expect(stopped).toMatchObject({ status: "stopped", continueWatching: false });
    expect(stopped.nextAction).toContain("Do not call wait again");
    expect(() =>
      feed.execute({ action: "wait", watchToken, afterSeq: 7 }, new AbortController().signal),
    ).toThrow(/missing or expired/);

    // A sixth concurrent watch evicts the oldest, which must say why rather than going quiet.
    const tokens: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const session = await feed.execute({ action: "start" }, new AbortController().signal);
      tokens.push(String(session.watchToken));
    }
    expect(() =>
      feed.execute(
        { action: "wait", watchToken: String(tokens[0]), afterSeq: 7 },
        new AbortController().signal,
      ),
    ).toThrow(/missing or expired/);
    feed.destroy();
  });

  it("reports deletion without exposing the stable item identifier", async () => {
    const { feed, items, setSequence } = setup();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const watchToken = String(started.watchToken);
    items.delete(STICKY_ID);
    setSequence(8);
    const deletion = serverAction(8, sticky());
    deletion.op = { kind: "item.delete", itemId: STICKY_ID, expectedVersion: 1 };
    feed.recordAuthoritativeAction(deletion, new Set([STICKY_ID]));

    const result = await feed.execute(
      { action: "wait", watchToken, afterSeq: 7 },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "changed",
      changes: [{ steps: [{ alias: "step_1", kind: "sticky", change: "deleted" }] }],
    });
    expect(JSON.stringify(result)).not.toContain(STICKY_ID);
    feed.destroy();
  });
});

describe("board-side assist requests", () => {
  function watching(board: BoardItem[] = [sticky(), canvasText()]) {
    const states: Array<ReturnType<ProblemStepWatchFeed["getState"]>> = [];
    const minted: unknown[] = [];
    let canComment = true;
    let canWrite = true;
    const context = setup(board);
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board.map((item) => context.items.get(item.id) ?? item),
      getAuthoritativeItem: (itemId) => context.items.get(itemId),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
      onStateChanged: (state) => states.push(state),
      canComment: () => canComment,
      canWrite: () => canWrite,
      mintSelectionToken: (sources) => {
        minted.push(sources);
        return `token_${minted.length}`;
      },
    });
    return {
      feed,
      states,
      minted,
      items: context.items,
      setCanComment(value: boolean) {
        canComment = value;
      },
      setCanWrite(value: boolean) {
        canWrite = value;
      },
    };
  }

  it("reports idle, watching and listening as the host starts and waits", async () => {
    vi.useFakeTimers();
    const { feed, states } = watching();
    expect(feed.getState()).toEqual({ phase: "idle", expiresAt: null, watchedItemIds: new Set() });

    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(states.at(-1)).toMatchObject({ phase: "watching" });
    expect(states.at(-1)?.watchedItemIds).toEqual(new Set([STICKY_ID, TEXT_ID]));
    expect(started).toMatchObject({
      selectionToken: "token_1",
      selectionSources: [{ stepAlias: "step_1", sourceAlias: "idea_1" }],
      canComment: true,
      canWrite: true,
      participantRequests: { actions: expect.arrayContaining(["explain", "check_work"]) },
      keepAlive: {
        pingIntervalMs: PROBLEM_STEP_WATCH_PING_INTERVAL_MS,
        missedPingsBeforeStop: PROBLEM_STEP_WATCH_MISSED_PINGS,
      },
    });

    const wait = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq, waitMs: 1_000 },
      new AbortController().signal,
    );
    expect(feed.getState().phase).toBe("listening");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toMatchObject({ status: "timeout" });
    expect(feed.getState().phase).toBe("watching");

    await feed.execute(
      { action: "stop", watchToken: started.watchToken },
      new AbortController().signal,
    );
    expect(feed.getState().phase).toBe("idle");
  });

  it("stops showing a watch after three agent keep-alive pings are missed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
    const { feed } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(feed.getState().phase).toBe("watching");

    await vi.advanceTimersByTimeAsync(PROBLEM_STEP_WATCH_PING_TIMEOUT_MS - 1);
    expect(feed.getState().phase).toBe("watching");
    await vi.advanceTimersByTimeAsync(1);
    expect(feed.getState().phase).toBe("idle");
    expect(() =>
      feed.execute(
        { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
        new AbortController().signal,
      ),
    ).toThrow(/missing or expired/);
  });

  it("keeps watching when the agent pings again before three windows are missed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
    const { feed } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(PROBLEM_STEP_WATCH_PING_INTERVAL_MS * 2);
    const wait = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq, waitMs: 1_000 },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(wait).resolves.toMatchObject({ status: "timeout", continueWatching: true });

    await vi.advanceTimersByTimeAsync(PROBLEM_STEP_WATCH_PING_TIMEOUT_MS - 1_001);
    expect(feed.getState().phase).toBe("watching");
    await vi.advanceTimersByTimeAsync(1);
    expect(feed.getState().phase).toBe("idle");
  });

  it("goes idle on expiry without any host call and on destroy", async () => {
    vi.useFakeTimers();
    const { feed } = watching();
    await feed.execute({ action: "start" }, new AbortController().signal);
    expect(feed.getState().phase).toBe("watching");
    await vi.advanceTimersByTimeAsync(PROBLEM_STEP_WATCH_DURATION_MS);
    expect(feed.getState().phase).toBe("idle");

    await feed.execute({ action: "start" }, new AbortController().signal);
    expect(feed.getState().phase).toBe("watching");
    feed.destroy();
    expect(feed.getState().phase).toBe("idle");
  });

  it("resolves a pending wait with the request, its reply plan and a fresh selection token", async () => {
    const { feed, minted } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const wait = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    const receipt = feed.requestAssistance({
      itemIds: [STICKY_ID],
      action: "critique",
      note: "  not sure about the division  ",
    });
    expect(receipt).toEqual({ requestId: "req_1", delivered: true, stepAliases: ["step_1"] });
    const result = await wait;
    expect(result).toMatchObject({
      status: "requested",
      continueWatching: true,
      nextSeq: started.nextSeq,
      selectionToken: "token_2",
      canComment: true,
      requests: [
        {
          requestId: "req_1",
          action: "critique",
          note: "not sure about the division",
          steps: [{ alias: "step_1", kind: "sticky", text: "Let $2x=6$" }],
          reply: {
            via: "comment",
            call: {
              tool: "insert_comment",
              // The alias, not the live selection, is what the reply is aimed at.
              input: {
                watchToken: started.watchToken,
                stepAlias: "step_1",
                // Carried back so a second request queued on the step cannot retag this reply.
                action: "critique",
                body: expect.any(String),
              },
            },
          },
        },
      ],
    });
    expect(minted).toHaveLength(2);
    // The writers' schemas only accept idea_N aliases, so the snapshot never uses step_N.
    expect(minted[1]).toMatchObject([{ alias: "idea_1", itemId: STICKY_ID, version: 1 }]);
    expect(JSON.stringify(result)).not.toContain(STICKY_ID);
    expect(JSON.stringify(result)).not.toContain(ACTOR_ID);
  });

  it("queues requests ahead of changes when no wait is pending and caps the queue", async () => {
    const { feed, items } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    for (let index = 0; index < 12; index += 1) {
      expect(feed.requestAssistance({ itemIds: [], action: "explain" }).delivered).toBe(false);
    }
    const updated = sticky("Let $2x=6$ so $x=3$", 2);
    items.set(STICKY_ID, updated);
    feed.recordAuthoritativeAction(serverAction(8, updated), new Set([STICKY_ID]));

    const first = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(first).toMatchObject({
      status: "requested",
      droppedRequests: 2,
      nextSeq: started.nextSeq,
    });
    expect(first.requests).toHaveLength(10);
    expect((first.requests as Array<{ steps: unknown[] }>)[0]?.steps).toHaveLength(2);

    const second = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(second).toMatchObject({
      status: "changed",
      changes: [{ seq: 8 }],
      selectionToken: expect.stringMatching(/^token_/u),
    });
    expect(second).not.toHaveProperty("droppedRequests");
  });

  it("delivers queued requests with the step text current at delivery, flagging deleted steps", async () => {
    const { feed, items, minted } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    feed.requestAssistance({ itemIds: [STICKY_ID, TEXT_ID], action: "ideate" });

    const edited = sticky("Let $2x=6$, so $x=3$", 2);
    items.set(STICKY_ID, edited);
    feed.recordAuthoritativeAction(serverAction(8, edited), new Set([STICKY_ID]));
    items.delete(TEXT_ID);
    feed.recordAuthoritativeAction(serverAction(9, canvasText()), new Set([TEXT_ID]));

    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "requested",
      requests: [
        {
          action: "ideate",
          steps: [
            { alias: "step_1", text: "Let $2x=6$, so $x=3$" },
            { alias: "step_2", kind: "text", deleted: true },
          ],
          reply: { via: "comment", call: { tool: "insert_comment" } },
        },
      ],
    });
    // The token minted at delivery and the delivered text describe the same version.
    expect(minted.at(-1)).toMatchObject([{ alias: "idea_1", itemId: STICKY_ID, version: 2 }]);
  });

  it("keeps queued requests when a wait is aborted, and answers every action in a comment", async () => {
    const { feed } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const controller = new AbortController();
    const wait = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      controller.signal,
    );
    controller.abort();
    await expect(wait).rejects.toThrow();
    feed.requestAssistance({ itemIds: [STICKY_ID], action: "ideate" });
    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "requested",
      requests: [
        {
          action: "ideate",
          // Generative actions answer on the step too, so the reply sits with the work.
          reply: {
            via: "comment",
            call: { tool: "insert_comment", input: { action: "ideate", stepAlias: "step_1" } },
          },
        },
      ],
    });
  });

  it("aims a reply at a step that still exists, and gives up only when none do", async () => {
    const { feed, items } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    feed.requestAssistance({ itemIds: [STICKY_ID, TEXT_ID], action: "ideate" });
    // The sticky is step_1; deleting it leaves the request aimed at a step that is gone.
    items.delete(STICKY_ID);
    feed.recordAuthoritativeAction(serverAction(8, sticky()), new Set([STICKY_ID]));
    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    // The plan aims past it at the canvas text that survived, rather than at a dead alias.
    expect(result.requests).toMatchObject([
      {
        steps: [{ alias: "step_1", deleted: true }, { alias: "step_2" }],
        reply: { via: "comment", call: { input: { stepAlias: "step_2" } } },
      },
    ]);

    // With every requested step gone there is nothing to comment on.
    feed.requestAssistance({ itemIds: [TEXT_ID], action: "ideate" });
    items.delete(TEXT_ID);
    feed.recordAuthoritativeAction(serverAction(9, canvasText()), new Set([TEXT_ID]));
    const allGone = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(allGone.requests).toMatchObject([
      { reply: { via: "conversation", note: expect.stringContaining("has been deleted") } },
    ]);
    expect((allGone.requests as Array<{ reply: object }>)[0]?.reply).not.toHaveProperty("call");
  });

  it("falls back to the conversation once the watch has spent its comment budget", async () => {
    // The budget is refused at the comment target, so a plan naming a comment after it is spent
    // is one the host cannot carry out.
    const { feed } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    for (let index = 0; index < MAX_ASSIST_COMMENTS_PER_WATCH; index += 1) {
      feed.commentTarget(String(started.watchToken), "step_1").release(true);
    }

    feed.requestAssistance({ itemIds: [STICKY_ID], action: "ideate" });
    const spent = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(spent.requests).toMatchObject([
      {
        reply: {
          via: "conversation",
          note: expect.stringContaining(`spent its ${MAX_ASSIST_COMMENTS_PER_WATCH} AI comments`),
        },
      },
    ]);
    expect((spent.requests as Array<{ reply: object }>)[0]?.reply).not.toHaveProperty("call");
  });

  it("answers every action in a comment, and falls back to the conversation when commenting is off", async () => {
    const { feed, setCanComment, setCanWrite } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    // Every action answers in a comment on the step, whatever the step is.
    feed.requestAssistance({ itemIds: [TEXT_ID], action: "examples" });
    const textStep = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(textStep.requests).toMatchObject([
      { reply: { via: "comment", call: { tool: "insert_comment" } } },
    ]);

    // A board this browser cannot write to changes nothing: the reply was a comment anyway.
    setCanWrite(false);
    feed.requestAssistance({ itemIds: [STICKY_ID], action: "ideate" });
    const readOnlyFallback = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(readOnlyFallback).toMatchObject({ canWrite: false });
    expect(readOnlyFallback.requests).toMatchObject([
      { reply: { via: "comment", call: { tool: "insert_comment" } } },
    ]);
    setCanWrite(true);

    // "Explain with a video" is answered in a comment that can carry the clip itself.
    feed.requestAssistance({ itemIds: [STICKY_ID], action: "explain_with_video" });
    const videoReply = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(videoReply.requests).toMatchObject([
      {
        reply: {
          via: "comment",
          call: { tool: "insert_comment", input: { videoUrl: expect.any(String) } },
        },
      },
    ]);

    setCanComment(false);
    feed.requestAssistance({ itemIds: [TEXT_ID], action: "explain" });
    const chatFallback = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(chatFallback).toMatchObject({ canComment: false });
    expect(chatFallback.requests).toMatchObject([{ reply: { via: "conversation" } }]);
    expect((chatFallback.requests as Array<{ reply: object }>)[0]?.reply).not.toHaveProperty(
      "call",
    );
  });

  it("rejects requests outside a live watch, for unwatched items, and with bad input", async () => {
    vi.useFakeTimers();
    const { feed } = watching();
    expect(() => feed.requestAssistance({ itemIds: [], action: "explain" })).toThrow(
      "start a problem-step watch first",
    );
    await feed.execute({ action: "start" }, new AbortController().signal);
    expect(() => feed.requestAssistance({ itemIds: [UNSELECTED_ID], action: "explain" })).toThrow(
      "Only steps in the current AI watch",
    );
    expect(() => feed.requestAssistance({ itemIds: [], action: "grade" as never })).toThrow(
      "action must be one of",
    );
    expect(() =>
      feed.requestAssistance({ itemIds: [], action: "explain", note: "x".repeat(281) }),
    ).toThrow("note must contain 1-280 characters");
    await vi.advanceTimersByTimeAsync(PROBLEM_STEP_WATCH_DURATION_MS);
    expect(() => feed.requestAssistance({ itemIds: [], action: "explain" })).toThrow(
      "start a problem-step watch first",
    );
  });

  it("resolves comment targets by alias, remembers the requested action, and caps comments", async () => {
    const { feed, items } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const token = String(started.watchToken);
    expect(() => feed.commentTarget("missing", "step_1")).toThrow("missing or expired");
    expect(() => feed.commentTarget(token, "step_9")).toThrow("not part of this watch");

    feed.requestAssistance({ itemIds: [STICKY_ID], action: "explain" });
    feed.requestAssistance({ itemIds: [STICKY_ID], action: "check_work" });
    // Two requests queued on one step: the host names the action it answers, so the earlier
    // Explain reply is not stamped with the later Check-my-work action.
    const explicit = feed.commentTarget(token, "step_1", "explain");
    expect(explicit).toMatchObject({ itemId: STICKY_ID, action: "explain" });
    explicit.release(true);
    const target = feed.commentTarget(token, "step_1");
    expect(target).toMatchObject({ itemId: STICKY_ID, action: "check_work" });
    expect(() => feed.commentTarget(token, "step_1")).toThrow("previous comment");
    target.release(false);
    expect(feed.commentTarget(token, "step_2")).toMatchObject({ itemId: TEXT_ID });

    items.delete(TEXT_ID);
    feed.recordAuthoritativeAction(serverAction(9, canvasText()), new Set([TEXT_ID]));
    expect(() => feed.commentTarget(token, "step_2")).toThrow("no longer on the board");
  });

  it("resolves aliases to items for a move without spending the comment slot", async () => {
    const { feed, items } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const token = String(started.watchToken);

    const resolved = feed.watchedItems(token, ["step_1", "step_2"]);
    expect([...resolved.keys()]).toEqual(["step_1", "step_2"]);
    expect(resolved.get("step_1")).toMatchObject({ id: STICKY_ID });
    expect(resolved.get("step_2")).toMatchObject({ id: TEXT_ID });
    // Resolving reserves nothing, so a comment on the same step is still free to be written.
    feed.commentTarget(token, "step_1").release(false);

    expect(() => feed.watchedItems("missing", ["step_1"])).toThrow("missing or expired");
    expect(() => feed.watchedItems(token, ["step_9"])).toThrow("step_9 is not part of this watch");

    items.delete(TEXT_ID);
    feed.recordAuthoritativeAction(serverAction(9, canvasText()), new Set([TEXT_ID]));
    expect(() => feed.watchedItems(token, ["step_2"])).toThrow("step_2 is no longer on the board");
  });

  it("enforces the per-watch comment cap through release", async () => {
    const { feed } = watching();
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const token = String(started.watchToken);
    for (let index = 0; index < 20; index += 1) feed.commentTarget(token, "step_1").release(true);
    expect(() => feed.commentTarget(token, "step_1")).toThrow("limit of 20 AI comments");
  });
});

describe("whole-board watching", () => {
  function feedOver(items: BoardItem[]) {
    return new ProblemStepWatchFeed({
      getBoardItems: () => items,
      getAuthoritativeItem: (itemId) => items.find((item) => item.id === itemId),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
      canComment: () => true,
      canWrite: () => true,
    });
  }

  it("follows every board item when the participant selected nothing", async () => {
    const feed = feedOver([sticky(), canvasText()]);
    const started = await feed.execute({ action: "start" }, new AbortController().signal);

    expect(started).toMatchObject({ status: "started", scope: "entire_board" });
    expect(started.steps).toHaveLength(2);
    feed.destroy();
  });

  it("says so when the board holds nothing watchable", () => {
    const feed = feedOver([]);
    expect(() => feed.execute({ action: "start" }, new AbortController().signal)).toThrow(
      "nothing saved to read",
    );
    feed.destroy();
  });

  it("refuses a scope past the item budget", () => {
    const many = Array.from({ length: MAX_WATCHED_ITEMS + 1 }, (_, index) => ({
      ...sticky(),
      id: `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    }));
    const feed = feedOver(many);
    expect(() => feed.execute({ action: "start" }, new AbortController().signal)).toThrow(
      `reports up to ${MAX_WATCHED_ITEMS} objects; this scope holds ${MAX_WATCHED_ITEMS + 1}`,
    );
    feed.destroy();
  });

  it("refuses a scope past the character budget even when the item count fits", () => {
    const feed = feedOver([sticky("x".repeat(130_000))]);
    expect(() => feed.execute({ action: "start" }, new AbortController().signal)).toThrow(
      /character budget/u,
    );
    feed.destroy();
  });

  it("hands a pending wait the whole board and the task prompt", async () => {
    const feed = feedOver([sticky(), canvasText()]);
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const wait = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );

    const receipt = feed.shareEntireBoard({ action: "check_work", itemCount: 2 });
    expect(receipt.delivered).toBe(true);

    const result = await wait;
    expect(result).toMatchObject({
      status: "requested",
      continueWatching: true,
      boardShares: [
        {
          action: "check_work",
          scope: "entire_board",
          itemCount: 2,
          reply: { via: "act_on_board" },
        },
      ],
    });
    // The prompt is what tells the host what to do with the board it was just handed.
    const share = (result.boardShares as Array<{ prompt: string }>)[0];
    expect(share?.prompt).toContain("reply as comments");
    expect(share?.prompt).toContain("debug");
    expect(result.responseGuidance).toMatchObject({
      action: expect.stringContaining("boardShares"),
    });
    feed.destroy();
  });

  it("queues a board share for the next wait and drops the narrower queued requests", async () => {
    const feed = feedOver([sticky(), canvasText()]);
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    feed.requestAssistance({ itemIds: [STICKY_ID], action: "explain" });

    expect(
      feed.shareEntireBoard({ action: "critique", note: "whole thing", itemCount: 2 }),
    ).toMatchObject({ delivered: false });
    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );

    expect(result.requests).toHaveLength(0);
    expect(result).toMatchObject({
      boardShares: [{ action: "critique", note: "whole thing" }],
    });
    feed.destroy();
  });

  it("refuses a board share with no live watch", () => {
    const feed = feedOver([sticky()]);
    expect(() => feed.shareEntireBoard({ action: "explain", itemCount: 1 })).toThrow(
      "start a problem-step watch first",
    );
    feed.destroy();
  });
});

describe("character budget over the life of a watch", () => {
  it("trims a step that grows past the budget after the watch started", async () => {
    const small = sticky("short");
    const board = [small];
    const items = new Map<string, BoardItem>([[small.id, small]]);
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => items.get(itemId),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(started.steps).toMatchObject([{ text: "short" }]);

    // The board grew after the budget was checked at start.
    const grown = sticky("y".repeat(200_000), 2);
    items.set(small.id, grown);
    board[0] = grown;
    feed.recordAuthoritativeAction(serverAction(8, grown), new Set([small.id]));

    const changed = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    const changedStep = (changed.changes as Array<{ steps: Array<Record<string, unknown>> }>)[0]
      ?.steps[0];
    expect(changedStep).toMatchObject({ textTruncated: true });
    expect(String(changedStep?.text ?? "")).toHaveLength(120_000);

    // The snapshot a resync hands back is bounded the same way.
    feed.recordAuthoritativeReload(9);
    const resync = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(resync).toMatchObject({ status: "resync" });
    const resyncStep = (resync.steps as Array<Record<string, unknown>>)[0];
    expect(resyncStep).toMatchObject({ textTruncated: true });
    expect(String(resyncStep?.text ?? "")).toHaveLength(120_000);
    feed.destroy();
  });

  it("applies the text budget when a queued request refreshes grown steps", async () => {
    const small = sticky("short");
    const board = [small];
    const items = new Map<string, BoardItem>([[small.id, small]]);
    let sequence = 7;
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => items.get(itemId),
      getSequence: () => sequence,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    feed.requestAssistance({ itemIds: [small.id], action: "check_work" });

    const grown = sticky("y".repeat(200_000), 2);
    items.set(small.id, grown);
    board[0] = grown;
    sequence = 8;
    feed.recordAuthoritativeAction(serverAction(sequence, grown), new Set([small.id]));

    const requested = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(requested).toMatchObject({ status: "requested", nextSeq: started.nextSeq });
    const requestedStep = (
      requested.requests as Array<{ steps: Array<Record<string, unknown>> }>
    )[0]?.steps[0];
    expect(requestedStep).toMatchObject({ textTruncated: true });
    expect(String(requestedStep?.text ?? "")).toHaveLength(120_000);

    const changed = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: requested.nextSeq },
      new AbortController().signal,
    );
    expect(changed).toMatchObject({ status: "changed", changes: [{ seq: 8 }] });
    feed.destroy();
  });

  it("counts visual descriptions when bounding retained change history", async () => {
    let current = imageItem("short");
    const board: BoardItem[] = [current];
    let sequence = 7;
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => (itemId === current.id ? current : undefined),
      getSequence: () => sequence,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);

    for (let index = 0; index < 30; index += 1) {
      current = imageItem(`${index}:${"v".repeat(5_000)}`, index + 2);
      board[0] = current;
      sequence = index + 8;
      feed.recordAuthoritativeAction(serverAction(sequence, current), new Set([current.id]));
    }

    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "resync",
      nextSeq: sequence,
      steps: [{ kind: "image" }],
    });
    feed.destroy();
  });

  it("charges fallback visual labels to the result text budget", async () => {
    const writing = sticky("short");
    const stamp: Extract<BoardItem, { kind: "stamp" }> = {
      id: "018f0000-0000-7000-8000-0000000000b8",
      kind: "stamp",
      z: 2,
      version: 1,
      createdBy: ACTOR_ID,
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "stamp", color: "#e5484d", opacity: 1 },
      geometry: { x: 100, y: 80, size: 72, stamp: "star" },
    };
    const board: BoardItem[] = [writing, stamp];
    const items = new Map(board.map((item) => [item.id, item]));
    let sequence = 7;
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => items.get(itemId),
      getSequence: () => sequence,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);

    const grown = sticky("y".repeat(200_000), 2);
    board[0] = grown;
    items.set(grown.id, grown);
    sequence = 8;
    feed.recordAuthoritativeAction(serverAction(sequence, grown), new Set([grown.id]));
    sequence = 9;
    feed.recordAuthoritativeReload(sequence);

    const resync = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    const steps = resync.steps as Array<{
      text?: string;
      visual?: { description: string };
    }>;
    const deliveredCodePoints = steps.reduce(
      (total, step) => total + [...(step.text ?? step.visual?.description ?? "")].length,
      0,
    );
    expect(deliveredCodePoints).toBe(120_000);
    expect(steps[1]?.visual?.description).toBe("");
    feed.destroy();
  });
});

describe("whole-board reconciliation and queued shares", () => {
  it("takes in objects a reload introduced and drops ones it removed", async () => {
    const first = sticky("first");
    const later = { ...canvasText(), version: 3 };
    const board: BoardItem[] = [first];
    const items = new Map<string, BoardItem>([[first.id, first]]);
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => items.get(itemId),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(started.steps).toHaveLength(1);

    // A snapshot restore swaps the board wholesale.
    board.length = 0;
    board.push(later);
    items.clear();
    items.set(later.id, later);
    feed.recordAuthoritativeReload(9);

    const resync = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(resync).toMatchObject({ status: "resync" });
    expect(resync.steps).toMatchObject([{ kind: "text", text: "Divide both sides by $2$" }]);
    feed.destroy();
  });

  it("keeps both whole-board asks when two are made before the host polls", async () => {
    const only = sticky();
    const board = [only];
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => (itemId === only.id ? only : undefined),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    feed.shareEntireBoard({ action: "explain", itemCount: 1 });
    feed.shareEntireBoard({ action: "critique", itemCount: 1 });

    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(result.boardShares).toMatchObject([{ action: "explain" }, { action: "critique" }]);
    feed.destroy();
  });

  it("ends a pending watch when a reload crosses the object cap", async () => {
    let board: BoardItem[] = [sticky("first")];
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => board.find((item) => item.id === itemId),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const pending = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );

    board = Array.from({ length: MAX_WATCHED_ITEMS + 1 }, (_, index) => ({
      ...sticky("x"),
      id: `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    }));
    feed.recordAuthoritativeReload(8);

    await expect(pending).resolves.toMatchObject({
      status: "outgrown",
      continueWatching: false,
    });
    feed.destroy();
  });

  it("removes deleted objects from the live cap before tracking replacements", async () => {
    const board: BoardItem[] = Array.from({ length: MAX_WATCHED_ITEMS }, (_, index) => ({
      ...sticky(),
      id: `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    }));
    const items = new Map(board.map((item) => [item.id, item]));
    let sequence = 7;
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => items.get(itemId),
      getSequence: () => sequence,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);

    const removed = board.shift();
    if (!removed) throw new Error("Expected a board item to remove.");
    items.delete(removed.id);
    sequence = 8;
    const deletion = serverAction(sequence, removed);
    deletion.op = { kind: "item.delete", itemId: removed.id, expectedVersion: removed.version };
    feed.recordAuthoritativeAction(deletion, new Set([removed.id]));

    const replacement = {
      ...sticky("replacement"),
      id: "018f0000-0000-7000-8000-999999999999",
    };
    board.push(replacement);
    items.set(replacement.id, replacement);
    sequence = 9;
    feed.recordAuthoritativeAction(serverAction(sequence, replacement), new Set([replacement.id]));

    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "changed",
      nextSeq: 9,
      changes: [
        { seq: 8, steps: [{ change: "deleted" }] },
        { seq: 9, steps: [{ change: "created", text: "replacement" }] },
      ],
    });
    feed.destroy();
  });

  it("reports whole-board requests discarded at the queue cap", async () => {
    const only = sticky();
    const board = [only];
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => (itemId === only.id ? only : undefined),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    for (let index = 0; index < 12; index += 1) {
      feed.shareEntireBoard({ action: "explain", itemCount: 1 });
    }

    const result = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: "requested", droppedBoardShares: 2 });
    expect(result.boardShares).toHaveLength(10);
    feed.destroy();
  });

  it("preserves pending changes across a whole-board request", async () => {
    let current = sticky("first");
    const board: BoardItem[] = [current];
    let sequence = 7;
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => (itemId === current.id ? current : undefined),
      getSequence: () => sequence,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);

    current = sticky("changed before the request", 2);
    board[0] = current;
    sequence = 8;
    feed.recordAuthoritativeAction(serverAction(sequence, current), new Set([current.id]));
    feed.shareEntireBoard({ action: "check_work", itemCount: 1 });

    const requested = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(requested).toMatchObject({
      status: "requested",
      nextSeq: started.nextSeq,
      nextCall: { input: { afterSeq: started.nextSeq } },
    });

    const changed = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: requested.nextSeq },
      new AbortController().signal,
    );
    expect(changed).toMatchObject({
      status: "changed",
      nextSeq: 8,
      changes: [{ seq: 8, steps: [{ text: "changed before the request" }] }],
    });
    feed.destroy();
  });
});

describe("pictures of drawn work", () => {
  const strokes: Extract<BoardItem, { kind: "pencil" }> = {
    id: "018f0000-0000-7000-8000-0000000000d1",
    kind: "pencil",
    z: 4,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: { kind: "stroke", color: "#123456", width: 4, opacity: 1 },
    geometry: {
      points: [
        [0, 0],
        [8, 9],
      ],
    },
  };

  function feedWithCamera(board: BoardItem[]) {
    const captured: BoardItem[][] = [];
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => board.find((item) => item.id === itemId),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
      captureBoardImage: async (items) => {
        captured.push([...items]);
        return {
          pngDataUrl: "data:image/png;base64,AAAA",
          width: 320,
          height: 240,
          itemCount: items.length,
        };
      },
    });
    return { feed, captured };
  }

  it("sends a picture with every result once the board holds strokes", async () => {
    const { feed, captured } = feedWithCamera([strokes, sticky()]);

    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(started).toMatchObject({
      status: "started",
      boardImage: { pngDataUrl: "data:image/png;base64,AAAA", scope: "entire_board", itemCount: 2 },
    });
    // The picture is taken of the whole board, not only of the drawn objects.
    expect(captured.at(-1)).toHaveLength(2);

    feed.recordAuthoritativeReload(9);
    const resync = await feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );
    expect(resync).toMatchObject({ status: "resync", boardImage: { width: 320, height: 240 } });
    feed.destroy();
  });

  it("answers a pending wait with the picture alongside the change", async () => {
    const board: BoardItem[] = [strokes];
    const { feed } = feedWithCamera(board);
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    const pending = feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
      new AbortController().signal,
    );

    const redrawn = {
      ...strokes,
      version: 2,
      geometry: { points: [...strokes.geometry.points, [20, 3] as [number, number]] },
    };
    board[0] = redrawn;
    feed.recordAuthoritativeAction(serverAction(8, redrawn), new Set([strokes.id]));

    const result = await pending;
    expect(result).toMatchObject({
      status: "changed",
      changes: [{ steps: [{ change: "updated", visual: { revision: 2 } }] }],
      boardImage: { pngDataUrl: "data:image/png;base64,AAAA" },
    });
    feed.destroy();
  });

  it("sends no picture when the board is only writing", async () => {
    const { feed, captured } = feedWithCamera([sticky()]);
    const started = await feed.execute({ action: "start" }, new AbortController().signal);

    expect(started).not.toHaveProperty("boardImage");
    expect(captured).toHaveLength(0);
    feed.destroy();
  });
});

describe("a board that outgrows its watch", () => {
  it("ends the watch rather than following only part of the board", async () => {
    const board: BoardItem[] = Array.from({ length: MAX_WATCHED_ITEMS }, (_, index) => ({
      ...sticky(),
      id: `018f0000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    }));
    const feed = new ProblemStepWatchFeed({
      getBoardItems: () => board,
      getAuthoritativeItem: (itemId) => board.find((item) => item.id === itemId),
      getSequence: () => 7,
      getParticipantDisplayName: () => "Sam",
    });
    const started = await feed.execute({ action: "start" }, new AbortController().signal);
    expect(started.steps).toHaveLength(MAX_WATCHED_ITEMS);

    const extra = { ...sticky("one too many"), id: "018f0000-0000-7000-8000-0000000ffff1" };
    board.push(extra);
    feed.recordAuthoritativeAction(serverAction(8, extra), new Set([extra.id]));

    expect(() =>
      feed.execute(
        { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq },
        new AbortController().signal,
      ),
    ).toThrow("missing or expired");
    feed.destroy();
  });
});

describe("watch scopes", () => {
  it("follows only the browser selection, and lets nothing new join it", async () => {
    const context = scopedFeed([sticky()]);
    const started = await context.feed.execute(
      { action: "start", scope: "selection" },
      context.signal,
      "board",
    );
    expect(started).toMatchObject({ status: "started", scope: "browser_selection" });
    expect(context.aliasesOf(started)).toEqual(["Let $2x=6$"]);

    // Someone else saves while the watch runs: a selection is a fixed question, so it is silent.
    const wait = context.feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq, waitMs: 1_000 },
      context.signal,
      "board",
    );
    const other = otherPersonSticky("Rae added this", 2);
    context.items.set(other.id, other);
    context.feed.recordAuthoritativeAction(serverAction(8, other), new Set([other.id]));
    expect(await wait).toMatchObject({ status: "timeout" });
    context.feed.destroy();
  });

  it("refuses a selection watch when nothing is selected or the selection is still saving", () => {
    // Scope is resolved before any promise, so a bad scope throws rather than rejecting.
    const empty = scopedFeed([]);
    expect(() =>
      empty.feed.execute({ action: "start", scope: "selection" }, empty.signal, "board"),
    ).toThrow("Nothing is selected in this browser");
    empty.feed.destroy();

    const saving = scopedFeed(null);
    expect(() =>
      saving.feed.execute({ action: "start", scope: "selection" }, saving.signal, "board"),
    ).toThrow("finish saving");
    saving.feed.destroy();
  });

  it("follows one participant's work wherever it sits, including what they save later", async () => {
    const context = scopedFeed();
    const started = await context.feed.execute(
      { action: "start", participantIds: [OTHER_ACTOR_ID] },
      context.signal,
      "participants",
    );
    expect(started).toMatchObject({
      status: "started",
      scope: "participants",
      watchedParticipantIds: [OTHER_ACTOR_ID],
    });
    // Sam's two objects are on the board but belong to someone else.
    expect(context.aliasesOf(started)).toEqual(["Rae's working"]);
    // The watch names the tool that continues it, not the board watch.
    expect(started.nextCall).toMatchObject({ tool: "watch_users" });

    const wait = context.feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq, waitMs: 1_000 },
      context.signal,
      "participants",
    );
    // Sam edits: not this watch's person, so it stays silent.
    const samEdit = sticky("Sam edited", 2);
    context.items.set(samEdit.id, samEdit);
    context.feed.recordAuthoritativeAction(serverAction(8, samEdit), new Set([samEdit.id]));
    // Rae edits: reported.
    const raeEdit = otherPersonSticky("Rae edited", 2);
    context.items.set(raeEdit.id, raeEdit);
    context.feed.recordAuthoritativeAction(serverAction(9, raeEdit), new Set([raeEdit.id]));

    const changed = await wait;
    expect(changed).toMatchObject({
      status: "changed",
      changes: [{ steps: [{ change: "updated", text: "Rae edited" }] }],
    });
    expect(JSON.stringify(changed)).not.toContain("Sam edited");
    context.feed.destroy();
  });

  it("names whoever made the change, including an editor outside the watched set", async () => {
    // A watched person's object can be changed by somebody else. The change is in scope
    // because the work is, and the board-visible name of whoever made it goes with it.
    const context = scopedFeed();
    const started = await context.feed.execute(
      { action: "start", participantIds: [OTHER_ACTOR_ID] },
      context.signal,
      "participants",
    );
    const wait = context.feed.execute(
      { action: "wait", watchToken: started.watchToken, afterSeq: started.nextSeq, waitMs: 1_000 },
      context.signal,
      "participants",
    );
    const edited = otherPersonSticky("Rae's note, tidied", 2);
    context.items.set(edited.id, edited);
    const action = serverAction(8, edited);
    context.feed.recordAuthoritativeAction(
      { ...action, actor: { id: ACTOR_ID, displayName: "Sam" } },
      new Set([edited.id]),
    );

    expect(await wait).toMatchObject({
      status: "changed",
      changes: [
        {
          actor: { displayName: "Sam" },
          steps: [{ change: "updated", text: "Rae's note, tidied" }],
        },
      ],
    });
    context.feed.destroy();
  });

  it("refuses a participant watch for someone with no saved work", () => {
    const context = scopedFeed();
    expect(() =>
      context.feed.execute(
        { action: "start", participantIds: ["018f0000-0000-7000-8000-00000000dead"] },
        context.signal,
        "participants",
      ),
    ).toThrow("No saved work on this board belongs to");
    expect(() => context.feed.execute({ action: "start" }, context.signal, "participants")).toThrow(
      "participantIds must contain 1-",
    );
    context.feed.destroy();
  });
});

describe("scope snapshots", () => {
  it("reads a scope once, in the shape the watch reports, without starting one", async () => {
    const context = scopedFeed([sticky()]);
    const board = await context.feed.snapshot({ scope: "board" }, "board");
    expect(board).toMatchObject({ status: "read", scope: "entire_board", itemCount: 3 });
    // Aliases label this result only; they are not a watch's step aliases.
    expect((board.steps as Array<{ alias: string }>).map((step) => step.alias)).toEqual([
      "item_1",
      "item_2",
      "item_3",
    ]);
    expect(board.followUp).toMatchObject({ watchTool: "watch_board" });
    // Reading does not create a session, so the board shows no watch.
    expect(context.feed.getState().phase).toBe("idle");

    const selection = await context.feed.snapshot({ scope: "selection" }, "board");
    expect(selection).toMatchObject({ scope: "browser_selection", itemCount: 1 });
    expect(context.aliasesOf(selection)).toEqual(["Let $2x=6$"]);

    const user = await context.feed.snapshot({ participantIds: [OTHER_ACTOR_ID] }, "participants");
    expect(user).toMatchObject({ scope: "participants", itemCount: 1 });
    expect(user.followUp).toMatchObject({ watchTool: "watch_users" });
    expect(context.aliasesOf(user)).toEqual(["Rae's working"]);
    context.feed.destroy();
  });

  it("refuses an empty scope the same way a watch does", async () => {
    const context = scopedFeed([]);
    await expect(context.feed.snapshot({ scope: "selection" }, "board")).rejects.toThrow(
      "Nothing is selected in this browser",
    );
    context.feed.destroy();
  });
});

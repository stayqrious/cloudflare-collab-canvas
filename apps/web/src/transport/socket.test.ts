import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardSocket, PROTOCOL_RELOAD_NOTICE, type SocketHooks } from "./socket";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;

  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    fakeSockets.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code });
  }

  emitMessage(frame: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const fakeSockets: FakeWebSocket[] = [];

function hooks(): SocketHooks {
  return {
    getSequence: () => 0,
    onPhase: vi.fn(),
    onWelcome: vi.fn(),
    onAction: vi.fn(),
    onReady: vi.fn(),
    onRejected: vi.fn(),
    onCommentsChanged: vi.fn(),
    onHistory: vi.fn(),
    onAccessChanged: vi.fn(),
    onOwnerRecovery: vi.fn(),
    onPreview: vi.fn(),
    onPresence: vi.fn(),
    onSpotlight: vi.fn(),
    onResync: vi.fn(async () => undefined),
    onNotice: vi.fn(),
    refreshSession: vi.fn(async () => undefined),
  };
}

describe("protocol rollout handling", () => {
  beforeEach(() => {
    fakeSockets.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("document", {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      location: { href: "http://localhost/b/test", protocol: "http:" },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("treats protocol close 1002 as terminal and never starts a reconnect", () => {
    const socketHooks = hooks();
    const boardSocket = new BoardSocket("b_test", socketHooks);
    boardSocket.connect();

    expect(fakeSockets).toHaveLength(1);
    fakeSockets[0]?.emitClose(1002);

    expect(boardSocket.phase).toBe("reload_required");
    expect(socketHooks.onNotice).toHaveBeenCalledWith(PROTOCOL_RELOAD_NOTICE, "error");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(fakeSockets).toHaveLength(1);
  });

  it("treats archive close 4011 as terminal and never starts a reconnect", () => {
    const socketHooks = hooks();
    const boardSocket = new BoardSocket("b_test", socketHooks);
    boardSocket.connect();

    expect(fakeSockets).toHaveLength(1);
    fakeSockets[0]?.emitClose(4011);

    expect(boardSocket.phase).toBe("archived");
    expect(socketHooks.onPhase).toHaveBeenLastCalledWith("archived");
    expect(socketHooks.onNotice).toHaveBeenCalledWith("This board has been archived.", "error");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(fakeSockets).toHaveLength(1);
    boardSocket.connect();
    expect(fakeSockets).toHaveLength(1);
  });

  it("stops immediately on a reload-required rejection without forwarding it", () => {
    const socketHooks = hooks();
    const boardSocket = new BoardSocket("b_test", socketHooks);
    boardSocket.connect();
    const socket = fakeSockets[0];
    expect(socket).toBeDefined();
    if (socket === undefined) return;
    socket.readyState = FakeWebSocket.OPEN;

    socket.emitMessage({
      v: 1,
      t: "server.rejected",
      code: "UNSUPPORTED_VERSION",
      message: "Unsupported protocol version.",
      reloadRequired: true,
    });

    expect(boardSocket.phase).toBe("reload_required");
    expect(socketHooks.onRejected).not.toHaveBeenCalled();
    expect(socketHooks.onNotice).toHaveBeenCalledWith(PROTOCOL_RELOAD_NOTICE, "error");
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: "client stopped" }]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(fakeSockets).toHaveLength(1);
  });

  it("uses subprotocols for embed authorization without putting the bearer in the URL", () => {
    const boardSocket = new BoardSocket("b_test", hooks(), "es1.classroom-session.signature");
    boardSocket.connect();

    expect(fakeSockets).toHaveLength(1);
    expect(fakeSockets[0]?.protocols).toEqual([
      "whiteboard.v1",
      "auth.es1.classroom-session.signature",
    ]);
    expect(String(fakeSockets[0]?.url)).not.toContain("classroom-session");
    expect(String(fakeSockets[0]?.url)).toContain("since=0");
  });

  it("leaves the legacy cookie WebSocket constructor unchanged", () => {
    const boardSocket = new BoardSocket("b_test", hooks());
    boardSocket.connect();

    expect(fakeSockets[0]?.protocols).toBeUndefined();
  });

  it("forwards a strictly parsed creator directory on authoritative actions", () => {
    const socketHooks = hooks();
    const boardSocket = new BoardSocket("b_test", socketHooks);
    boardSocket.connect();
    const socket = fakeSockets[0];
    expect(socket).toBeDefined();
    if (socket === undefined) return;
    socket.readyState = FakeWebSocket.OPEN;

    const action = {
      v: 1,
      t: "server.action",
      seq: 1,
      acceptedAt: 1_700_000_000_000,
      actor: { id: "a_1234567890123456789012", displayName: "Coach" },
      creators: [{ id: "a_abcdefghijklmnopqrstuv", displayName: "Student" }],
      commandId: "018f0000-0000-7000-8000-000000000010",
      actionId: "018f0000-0000-7000-8000-000000000011",
      op: { kind: "board.clear", removed: [] },
    };
    socket.emitMessage(action);

    expect(socketHooks.onAction).toHaveBeenCalledWith(action, false);
    expect(socketHooks.onResync).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-array directory", { id: "a_abcdefghijklmnopqrstuv", displayName: "Student" }],
    [
      "an extended actor record",
      [
        {
          id: "a_abcdefghijklmnopqrstuv",
          displayName: "Student",
          user_identifier: "student@example.edu",
        },
      ],
    ],
    ["a non-opaque actor id", [{ id: "student@example.edu", displayName: "Student" }]],
    [
      "duplicate actors",
      [
        { id: "a_abcdefghijklmnopqrstuv", displayName: "Student" },
        { id: "a_abcdefghijklmnopqrstuv", displayName: "Student renamed" },
      ],
    ],
  ])("resynchronizes instead of forwarding creator metadata with %s", (_label, creators) => {
    const socketHooks = hooks();
    const boardSocket = new BoardSocket("b_test", socketHooks);
    boardSocket.connect();
    const socket = fakeSockets[0];
    expect(socket).toBeDefined();
    if (socket === undefined) return;
    socket.readyState = FakeWebSocket.OPEN;

    socket.emitMessage({
      v: 1,
      t: "server.action",
      seq: 1,
      acceptedAt: 1_700_000_000_000,
      actor: { id: "a_1234567890123456789012", displayName: "Coach" },
      creators,
      commandId: "018f0000-0000-7000-8000-000000000012",
      actionId: "018f0000-0000-7000-8000-000000000013",
      op: { kind: "board.clear", removed: [] },
    });

    expect(socketHooks.onAction).not.toHaveBeenCalled();
    expect(socketHooks.onResync).toHaveBeenCalledWith("The server sent an invalid action.");
  });

  it("preserves classroom object tools in peer presence", () => {
    const socketHooks = hooks();
    const boardSocket = new BoardSocket("b_test", socketHooks);
    boardSocket.connect();
    const socket = fakeSockets[0];
    expect(socket).toBeDefined();
    if (socket === undefined) return;
    socket.readyState = FakeWebSocket.OPEN;

    socket.emitMessage({
      v: 1,
      t: "server.presence",
      actor: { id: "a_1234567890123456789012", displayName: "Student" },
      cursor: { x: 12, y: 34 },
      activeTool: "sticky",
    });

    expect(socketHooks.onPresence).toHaveBeenCalledWith(
      [expect.objectContaining({ activeTool: "sticky", cursor: { x: 12, y: 34 } })],
      false,
    );

    socket.emitMessage({
      v: 1,
      t: "server.presence",
      actor: { id: "a_1234567890123456789012", displayName: "Student" },
      cursor: { x: 44, y: 55 },
      activeTool: "stamp",
    });

    expect(socketHooks.onPresence).toHaveBeenLastCalledWith(
      [expect.objectContaining({ activeTool: "stamp", cursor: { x: 44, y: 55 } })],
      false,
    );

    socket.emitMessage({
      v: 1,
      t: "server.presence",
      actor: { id: "a_1234567890123456789012", displayName: "Student" },
      cursor: { x: 90, y: 120 },
      activeTool: "zone",
    });

    expect(socketHooks.onPresence).toHaveBeenLastCalledWith(
      [expect.objectContaining({ activeTool: "zone", cursor: { x: 90, y: 120 } })],
      false,
    );
  });

  it("sends active and stopped spotlight frames only after the socket is ready", () => {
    const boardSocket = new BoardSocket("b_test", hooks());
    boardSocket.connect();
    const socket = fakeSockets[0];
    expect(socket).toBeDefined();
    if (socket === undefined) return;
    const spotlightId = "10000000-0000-4000-8000-000000000001";
    const viewport = { center: { x: 120.25, y: -80.5 }, zoom: 1.75 };

    expect(boardSocket.sendSpotlight(spotlightId, true, viewport)).toBe(false);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emitMessage({ v: 1, t: "server.ready", latestSeq: 0 });

    expect(boardSocket.sendSpotlight(spotlightId, true, viewport)).toBe(true);
    expect(boardSocket.sendSpotlight(spotlightId, false)).toBe(true);
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      {
        v: 1,
        t: "client.facilitation.spotlight",
        spotlightId,
        active: true,
        viewport,
      },
      { v: 1, t: "client.facilitation.spotlight", spotlightId, active: false },
    ]);
  });

  it("forwards strictly parsed active and stopped spotlight frames", () => {
    const socketHooks = hooks();
    const boardSocket = new BoardSocket("b_test", socketHooks);
    boardSocket.connect();
    const socket = fakeSockets[0];
    expect(socket).toBeDefined();
    if (socket === undefined) return;
    socket.readyState = FakeWebSocket.OPEN;
    const base = {
      v: 1,
      t: "server.facilitation.spotlight",
      spotlightId: "10000000-0000-4000-8000-000000000002",
      actor: { id: "a_1234567890123456789012", displayName: "Ms. Rivera" },
      connectionId: "20000000-0000-4000-8000-000000000003",
    };

    socket.emitMessage({
      ...base,
      active: true,
      viewport: { center: { x: 400, y: 250 }, zoom: 2 },
    });
    socket.emitMessage({ ...base, active: false });

    expect(socketHooks.onSpotlight).toHaveBeenNthCalledWith(1, {
      ...base,
      active: true,
      viewport: { center: { x: 400, y: 250 }, zoom: 2 },
    });
    expect(socketHooks.onSpotlight).toHaveBeenNthCalledWith(2, {
      ...base,
      active: false,
    });
  });

  it("closes on malformed or extended spotlight server frames", () => {
    const socketHooks = hooks();
    const boardSocket = new BoardSocket("b_test", socketHooks);
    boardSocket.connect();
    const socket = fakeSockets[0];
    expect(socket).toBeDefined();
    if (socket === undefined) return;
    socket.readyState = FakeWebSocket.OPEN;

    socket.emitMessage({
      v: 1,
      t: "server.facilitation.spotlight",
      spotlightId: "10000000-0000-4000-8000-000000000004",
      active: true,
      viewport: { center: { x: 0, y: 0 }, zoom: 9 },
      actor: { id: "a_1234567890123456789012", displayName: "Teacher" },
      connectionId: "20000000-0000-4000-8000-000000000005",
      unexpected: true,
    });

    expect(socketHooks.onSpotlight).not.toHaveBeenCalled();
    expect(socket.closeCalls).toEqual([{ code: 1002, reason: "invalid spotlight" }]);
  });
});

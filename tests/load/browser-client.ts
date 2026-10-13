import type { Page } from "@playwright/test";

export type CanonicalSnapshot = {
  format: "cf-whiteboard-json";
  version: 1;
  boardId?: string;
  seq: number;
  createdAt?: number;
  settings?: { title?: string };
  items: Array<Record<string, unknown>>;
};

export type RuntimeInstallOptions = {
  boardId: string;
  title: string;
  clientIndex: number;
  clientInstanceId: string;
  role: "editor" | "viewer";
  drawingPolicy: "editors_enabled" | "owner_only" | "locked";
  snapshot: CanonicalSnapshot;
  connectionTimeoutMs: number;
};

export type CommitFrame = {
  v: 1;
  t: "client.commit";
  commandId: string;
  actionId: string;
  baseSeq: number;
  op: Record<string, unknown>;
};

export type CommandOutcome =
  | { kind: "ack"; commandId: string; seq: number; rttMs: number }
  | { kind: "rejected"; commandId: string; code: string; latestSeq: number | null };

export type ClientSummary = {
  clientIndex: number;
  role: string;
  drawingPolicy: string;
  ready: boolean;
  baselineSeq: number;
  lastSeq: number;
  lastAcceptedAt: number;
  itemCount: number;
  receivedSeqs: number[];
  duplicateSeqs: number[];
  sequenceGaps: Array<{ expected: number; received: number }>;
  protocolErrors: string[];
  rejectionFrames: Array<{ commandId: string | null; code: string }>;
  acknowledgedCommandIds: string[];
  counters: {
    connectionsReady: number;
    reconnects: number;
    previewsSent: number;
    previewsReceived: number;
    presenceSent: number;
    presenceReceived: number;
    syncChecksSent: number;
    syncResponses: number;
    resyncRecoveries: number;
  };
  closeEvents: Array<{ code: number; reason: string; manual: boolean; seq: number }>;
};

export type SnapshotDigest = {
  sha256: string;
  seq: number;
  itemCount: number;
  byteCount: number;
};

export type ExportDigest = SnapshotDigest & {
  status: number;
  responseSeq: number | null;
  etag: string | null;
};

type BrowserRuntime = {
  connect: () => Promise<void>;
  disconnect: (reason: string) => Promise<void>;
  ensureConnected: () => Promise<void>;
  startTraffic: (previewHz: number, presenceHz: number, syncIntervalMs: number) => void;
  stopTraffic: () => void;
  prepareGesture: (actionId: string, itemId: string) => void;
  sendCommit: (frame: CommitFrame) => void;
  waitForCommand: (commandId: string, timeoutMs: number) => Promise<CommandOutcome>;
  requestSync: (timeoutMs: number) => Promise<void>;
  probeRecovery: (timeoutMs: number) => Promise<void>;
  canonicalSnapshotDigest: () => Promise<SnapshotDigest>;
  summary: () => ClientSummary;
};

type RuntimeWindow = Window & { __collabLoadHarness?: BrowserRuntime };

export async function installBrowserClient(
  page: Page,
  options: RuntimeInstallOptions,
): Promise<void> {
  // tsx/esbuild preserves local function names with a tiny `__name` helper.
  // Playwright serializes the callback without module-scope helpers, so make
  // the harmless helper available in the isolated browser realm first.
  await page.evaluate("globalThis.__name = (target) => target");
  await page.evaluate((input) => {
    const scope = window as RuntimeWindow;
    scope.__collabLoadHarness?.stopTraffic();

    type JsonRecord = Record<string, unknown>;
    type Gesture = {
      actionId: string;
      itemId: string;
      previewSeq: number;
      pointIndex: number;
    };

    const isRecord = (value: unknown): value is JsonRecord =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const number = (value: unknown): number | null =>
      typeof value === "number" && Number.isSafeInteger(value) ? value : null;
    const string = (value: unknown): string | null => (typeof value === "string" ? value : null);
    const errorMessage = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    const timeout = (milliseconds: number, callback: () => void): number =>
      window.setTimeout(callback, milliseconds);
    const waitFor = async (
      predicate: () => boolean,
      timeoutMs: number,
      label: string,
    ): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const startedAt = performance.now();
        const check = (): void => {
          if (predicate()) {
            resolve();
            return;
          }
          if (performance.now() - startedAt >= timeoutMs) {
            reject(new Error(`Timed out waiting for ${label}.`));
            return;
          }
          timeout(10, check);
        };
        check();
      });
    const digest = async (text: string): Promise<string> => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      );
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    };

    const items = new Map<string, JsonRecord>();
    for (const item of input.snapshot.items) {
      if (typeof item.id === "string") items.set(item.id, structuredClone(item));
    }

    const baselineSeq = input.snapshot.seq;
    let lastSeq = baselineSeq;
    let lastAcceptedAt = input.snapshot.createdAt ?? 0;
    let role: string = input.role;
    let drawingPolicy: string = input.drawingPolicy;
    let socket: WebSocket | null = null;
    let ready = false;
    let generation = 0;
    let intendedClose = false;
    let autoReconnectAttempt = 0;
    let autoReconnectTimer: number | null = null;
    let gesture: Gesture | null = null;
    let trafficTimers: number[] = [];
    let syncIssued = 0;
    let syncCompleted = 0;

    const receivedSeqs: number[] = [];
    const duplicateSeqs: number[] = [];
    const sequenceGaps: Array<{ expected: number; received: number }> = [];
    const protocolErrors: string[] = [];
    const rejectionFrames: Array<{ commandId: string | null; code: string }> = [];
    const acknowledgedCommandIds = new Set<string>();
    const commandResults = new Map<string, CommandOutcome>();
    const commandSentAt = new Map<string, number>();
    const commandWaiters = new Map<string, Set<(outcome: CommandOutcome) => void>>();
    const closeEvents: Array<{ code: number; reason: string; manual: boolean; seq: number }> = [];
    const counters = {
      connectionsReady: 0,
      reconnects: 0,
      previewsSent: 0,
      previewsReceived: 0,
      presenceSent: 0,
      presenceReceived: 0,
      syncChecksSent: 0,
      syncResponses: 0,
      resyncRecoveries: 0,
    };

    const completeCommand = (outcome: CommandOutcome): void => {
      commandResults.set(outcome.commandId, outcome);
      const waiters = commandWaiters.get(outcome.commandId);
      if (waiters === undefined) return;
      commandWaiters.delete(outcome.commandId);
      for (const resolve of waiters) resolve(outcome);
    };

    const applyItemOperation = (operation: JsonRecord): void => {
      switch (operation.kind) {
        case "item.create":
        case "item.update":
        case "item.copy": {
          if (!isRecord(operation.item) || typeof operation.item.id !== "string") {
            throw new Error(`Invalid authoritative ${String(operation.kind)} item.`);
          }
          items.set(operation.item.id, structuredClone(operation.item));
          return;
        }
        case "item.delete": {
          const itemId = string(operation.itemId);
          if (itemId === null) throw new Error("Invalid authoritative delete item ID.");
          items.delete(itemId);
          return;
        }
        default:
          throw new Error(`Unsupported authoritative item operation ${String(operation.kind)}.`);
      }
    };

    const applyOperation = (operation: unknown): void => {
      if (!isRecord(operation) || typeof operation.kind !== "string") {
        throw new Error("The authoritative operation is invalid.");
      }
      if (
        operation.kind === "item.create" ||
        operation.kind === "item.update" ||
        operation.kind === "item.copy" ||
        operation.kind === "item.delete"
      ) {
        applyItemOperation(operation);
        return;
      }
      if (operation.kind === "items.batch") {
        if (!Array.isArray(operation.operations)) throw new Error("Invalid authoritative batch.");
        for (const child of operation.operations) {
          if (!isRecord(child)) throw new Error("Invalid authoritative batch child.");
          applyItemOperation(child);
        }
        return;
      }
      if (operation.kind === "history.undo" || operation.kind === "history.redo") {
        if (!Array.isArray(operation.changes)) throw new Error("Invalid history delta.");
        for (const change of operation.changes) {
          if (!isRecord(change)) throw new Error("Invalid history change.");
          if (change.kind === "item.replace" && isRecord(change.item)) {
            const itemId = string(change.item.id);
            if (itemId === null) throw new Error("Invalid history replacement.");
            items.set(itemId, structuredClone(change.item));
          } else if (change.kind === "item.remove") {
            const itemId = string(change.itemId);
            if (itemId === null) throw new Error("Invalid history removal.");
            items.delete(itemId);
          } else {
            throw new Error("Unsupported history change.");
          }
        }
        return;
      }
      if (operation.kind === "board.clear") {
        const removed = Array.isArray(operation.removed)
          ? operation.removed
          : Array.isArray(operation.removedItemIds)
            ? operation.removedItemIds
            : [...items.keys()];
        for (const value of removed) {
          const itemId =
            typeof value === "string" ? value : isRecord(value) ? string(value.itemId) : null;
          if (itemId !== null) items.delete(itemId);
        }
        return;
      }
      if (operation.kind === "board.restore") {
        if (Array.isArray(operation.removedItemIds)) {
          for (const itemId of operation.removedItemIds)
            if (typeof itemId === "string") items.delete(itemId);
        }
        if (Array.isArray(operation.replacements)) {
          for (const item of operation.replacements) {
            if (isRecord(item) && typeof item.id === "string")
              items.set(item.id, structuredClone(item));
          }
        }
        return;
      }
      throw new Error(`Unsupported authoritative operation ${operation.kind}.`);
    };

    const applyAction = (frame: JsonRecord): void => {
      const seq = number(frame.seq);
      if (seq === null || seq < 1) throw new Error("The server action sequence is invalid.");
      if (seq <= lastSeq) {
        duplicateSeqs.push(seq);
        throw new Error(`Duplicate sequence ${seq} after ${lastSeq}.`);
      }
      if (seq !== lastSeq + 1) {
        sequenceGaps.push({ expected: lastSeq + 1, received: seq });
        throw new Error(`Sequence gap: expected ${lastSeq + 1}, received ${seq}.`);
      }
      applyOperation(frame.op);
      lastSeq = seq;
      lastAcceptedAt = number(frame.acceptedAt) ?? lastAcceptedAt;
      receivedSeqs.push(seq);

      const commandId = string(frame.commandId);
      if (commandId !== null && commandSentAt.has(commandId)) {
        acknowledgedCommandIds.add(commandId);
        const sentAt = commandSentAt.get(commandId) ?? performance.now();
        completeCommand({ kind: "ack", commandId, seq, rttMs: performance.now() - sentAt });
      }
      if (gesture !== null && string(frame.actionId) === gesture.actionId) gesture = null;
    };

    const receive = (data: unknown): void => {
      if (typeof data !== "string") throw new Error("The server sent a binary frame.");
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.t !== "string") {
        throw new Error("The server frame envelope is invalid.");
      }
      switch (parsed.t) {
        case "server.welcome": {
          const actor = isRecord(parsed.actor) ? parsed.actor : null;
          if (actor !== null && typeof actor.role === "string") role = actor.role;
          if (typeof parsed.drawingPolicy === "string") drawingPolicy = parsed.drawingPolicy;
          return;
        }
        case "server.replay": {
          const fromExclusive = number(parsed.fromExclusive);
          if (fromExclusive !== lastSeq || !Array.isArray(parsed.actions)) {
            throw new Error(
              `The replay range starts at ${String(parsed.fromExclusive)} while local sequence is ${lastSeq} (sync ${syncCompleted}/${syncIssued}).`,
            );
          }
          for (const action of parsed.actions) {
            if (!isRecord(action)) throw new Error("The replay contains an invalid action.");
            applyAction(action);
          }
          if (number(parsed.toInclusive) !== lastSeq) {
            throw new Error("The replay range does not end at the applied sequence.");
          }
          if (syncCompleted < syncIssued) {
            syncCompleted += 1;
            counters.syncResponses += 1;
          }
          return;
        }
        case "server.action":
          applyAction(parsed);
          return;
        case "server.ready": {
          if (number(parsed.latestSeq) !== lastSeq) {
            throw new Error("The ready high-water sequence does not match local state.");
          }
          ready = true;
          autoReconnectAttempt = 0;
          counters.connectionsReady += 1;
          if (counters.connectionsReady > 1) counters.reconnects += 1;
          return;
        }
        case "server.rejected": {
          const commandId = string(parsed.commandId);
          const code = string(parsed.code) ?? "UNKNOWN";
          rejectionFrames.push({ commandId, code });
          if (commandId !== null) {
            completeCommand({
              kind: "rejected",
              commandId,
              code,
              latestSeq: number(parsed.latestSeq),
            });
          }
          return;
        }
        case "access.changed":
        case "server.access_changed":
          if (typeof parsed.role === "string") role = parsed.role;
          if (typeof parsed.drawingPolicy === "string") drawingPolicy = parsed.drawingPolicy;
          if (!canDraw()) gesture = null;
          return;
        case "server.preview":
        case "server.gesture_preview":
          counters.previewsReceived += 1;
          return;
        case "server.presence":
        case "server.presence.joined":
        case "server.presence.left":
        case "server.presence_state":
          counters.presenceReceived += 1;
          return;
        case "server.in_sync":
          if (syncCompleted < syncIssued) syncCompleted += 1;
          counters.syncResponses += 1;
          return;
        case "server.resync_required":
          // A sync check can become stale while its request is queued behind a
          // live broadcast. The server deliberately closes 4009 instead of
          // replaying older actions onto that socket. Count the response as a
          // completed check, mark this generation unready immediately, and
          // let the close handler reconnect from our authoritative cursor.
          counters.resyncRecoveries += 1;
          if (syncCompleted < syncIssued) {
            syncCompleted += 1;
            counters.syncResponses += 1;
          }
          ready = false;
          return;
        default:
          return;
      }
    };

    const canDraw = (): boolean =>
      (role === "editor" || role === "owner") &&
      drawingPolicy !== "locked" &&
      (drawingPolicy !== "owner_only" || role === "owner");
    const send = (frame: JsonRecord): void => {
      if (!ready || socket?.readyState !== WebSocket.OPEN) {
        throw new Error("The WebSocket is not ready.");
      }
      socket.send(JSON.stringify(frame));
    };
    const sendPresence = (): void => {
      if (!ready || socket?.readyState !== WebSocket.OPEN) return;
      const step = counters.presenceSent + input.clientIndex * 37;
      socket.send(
        JSON.stringify({
          v: 1,
          t: "client.presence",
          cursor: { x: (step * 13) % 900, y: (step * 29) % 700 },
          activeTool: canDraw() ? "pencil" : "pan",
        }),
      );
      counters.presenceSent += 1;
    };
    const sendPreview = (): void => {
      if (!ready || socket?.readyState !== WebSocket.OPEN || gesture === null || !canDraw()) return;
      gesture.previewSeq += 1;
      gesture.pointIndex += 1;
      const x = input.clientIndex * 200 + gesture.pointIndex * 1.25;
      const y = input.clientIndex * 100 + (gesture.pointIndex % 41) * 1.5;
      socket.send(
        JSON.stringify({
          v: 1,
          t: "client.preview",
          gestureId: gesture.actionId,
          previewSeq: gesture.previewSeq,
          kind: "pencil.segment",
          payload: {
            itemId: gesture.itemId,
            points: [
              [x, y],
              [x + 0.75, y + 0.5],
            ],
          },
        }),
      );
      counters.previewsSent += 1;
    };
    const issueSync = (): void => {
      if (!ready || socket?.readyState !== WebSocket.OPEN) return;
      syncIssued += 1;
      counters.syncChecksSent += 1;
      socket.send(JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: lastSeq }));
    };

    const runtime: BrowserRuntime = {
      async connect(): Promise<void> {
        if (ready && socket?.readyState === WebSocket.OPEN) return;
        if (
          socket?.readyState === WebSocket.CONNECTING ||
          (socket?.readyState === WebSocket.OPEN && !ready)
        ) {
          await waitFor(
            () => ready,
            input.connectionTimeoutMs,
            "an existing socket to become ready",
          );
          return;
        }
        if (autoReconnectTimer !== null) window.clearTimeout(autoReconnectTimer);
        autoReconnectTimer = null;
        intendedClose = false;
        const currentGeneration = ++generation;
        const socketUrl = new URL(
          `/api/v1/boards/${encodeURIComponent(input.boardId)}/socket`,
          window.location.href,
        );
        socketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socketUrl.searchParams.set("since", String(lastSeq));
        socketUrl.searchParams.set("client", input.clientInstanceId);
        const nextSocket = new WebSocket(socketUrl);
        socket = nextSocket;
        ready = false;

        nextSocket.addEventListener("message", (event) => {
          if (currentGeneration !== generation) return;
          try {
            receive(event.data);
          } catch (error) {
            protocolErrors.push(errorMessage(error));
            nextSocket.close(1002, "load harness protocol assertion failed");
          }
        });
        nextSocket.addEventListener("close", (event) => {
          if (currentGeneration !== generation) return;
          const manual = intendedClose;
          intendedClose = false;
          ready = false;
          closeEvents.push({ code: event.code, reason: event.reason, manual, seq: lastSeq });
          if (manual) return;
          const backoff = [0, 250, 500, 1_000, 2_000, 5_000][Math.min(autoReconnectAttempt, 5)];
          autoReconnectAttempt += 1;
          autoReconnectTimer = timeout(backoff ?? 5_000, () => {
            void runtime.connect().catch((error) => protocolErrors.push(errorMessage(error)));
          });
        });

        await waitFor(
          () => ready || protocolErrors.length > 0,
          input.connectionTimeoutMs,
          "server.ready",
        );
        if (!ready) throw new Error(protocolErrors.at(-1) ?? "The socket did not become ready.");
      },

      async disconnect(reason: string): Promise<void> {
        if (socket === null || socket.readyState === WebSocket.CLOSED) {
          ready = false;
          return;
        }
        const closingSocket = socket;
        // Invalidate this transport immediately. Some WebSocket implementations
        // can leave a graceful close in CLOSING while buffered ephemeral frames
        // drain; replay correctness depends on the new generation and its
        // sequence cursor, not on timing that close handshake.
        generation += 1;
        ready = false;
        socket = null;
        intendedClose = false;
        closeEvents.push({ code: 1000, reason, manual: true, seq: lastSeq });
        closingSocket.close(1000, reason.slice(0, 100));
      },

      async ensureConnected(): Promise<void> {
        if (ready && socket?.readyState === WebSocket.OPEN) return;
        await runtime.connect();
      },

      startTraffic(previewHz: number, presenceHz: number, syncIntervalMs: number): void {
        runtime.stopTraffic();
        if (previewHz > 0) {
          trafficTimers.push(window.setInterval(sendPreview, 1_000 / previewHz));
        }
        if (presenceHz > 0) {
          trafficTimers.push(window.setInterval(sendPresence, 1_000 / presenceHz));
        }
        if (syncIntervalMs > 0) {
          trafficTimers.push(window.setInterval(issueSync, syncIntervalMs));
        }
      },

      stopTraffic(): void {
        for (const timer of trafficTimers) window.clearInterval(timer);
        trafficTimers = [];
      },

      prepareGesture(actionId: string, itemId: string): void {
        gesture = { actionId, itemId, previewSeq: 0, pointIndex: 0 };
        if (!canDraw() || !ready || socket?.readyState !== WebSocket.OPEN) return;
        socket.send(
          JSON.stringify({
            v: 1,
            t: "client.preview",
            gestureId: actionId,
            previewSeq: 0,
            kind: "pencil.start",
            payload: {
              itemId,
              point: [input.clientIndex * 200, input.clientIndex * 100],
              style: { kind: "stroke", color: "#3366cc", width: 3, opacity: 0.8 },
            },
          }),
        );
        counters.previewsSent += 1;
      },

      sendCommit(frame: CommitFrame): void {
        commandSentAt.set(frame.commandId, performance.now());
        send(frame as unknown as JsonRecord);
      },

      async waitForCommand(commandId: string, timeoutMs: number): Promise<CommandOutcome> {
        const existing = commandResults.get(commandId);
        if (existing !== undefined) return existing;
        return new Promise<CommandOutcome>((resolve, reject) => {
          const timer = timeout(timeoutMs, () => {
            commandWaiters.get(commandId)?.delete(complete);
            reject(new Error(`Timed out waiting for command ${commandId}.`));
          });
          const complete = (outcome: CommandOutcome): void => {
            window.clearTimeout(timer);
            resolve(outcome);
          };
          const waiters = commandWaiters.get(commandId) ?? new Set();
          waiters.add(complete);
          commandWaiters.set(commandId, waiters);
        });
      },

      async requestSync(timeoutMs: number): Promise<void> {
        const target = syncIssued + 1;
        const readyCount = counters.connectionsReady;
        const recoveryCount = counters.resyncRecoveries;
        issueSync();
        await waitFor(
          () =>
            syncCompleted >= target &&
            (counters.resyncRecoveries === recoveryCount ||
              (ready && counters.connectionsReady > readyCount)),
          timeoutMs,
          "a sync response and any required recovery reconnect",
        );
      },

      async probeRecovery(timeoutMs: number): Promise<void> {
        if (!ready || socket?.readyState !== WebSocket.OPEN) {
          throw new Error("The WebSocket is not ready for a recovery probe.");
        }
        if (lastSeq < 1) throw new Error("A recovery probe requires an authoritative action.");
        const recoveryTarget = counters.resyncRecoveries + 1;
        const readyTarget = counters.connectionsReady + 1;
        syncIssued += 1;
        counters.syncChecksSent += 1;
        socket.send(JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: lastSeq - 1 }));
        await waitFor(
          () =>
            counters.resyncRecoveries >= recoveryTarget &&
            ready &&
            counters.connectionsReady >= readyTarget,
          timeoutMs,
          "an authoritative 4009 resync and recovery reconnect",
        );
      },

      async canonicalSnapshotDigest(): Promise<SnapshotDigest> {
        const canonicalItems = [...items.values()]
          .sort((left, right) => {
            const leftZ = typeof left.z === "number" ? left.z : 0;
            const rightZ = typeof right.z === "number" ? right.z : 0;
            if (leftZ !== rightZ) return leftZ - rightZ;
            return String(left.id).localeCompare(String(right.id));
          })
          .map((item) => ({
            // Match the canonical exporter rather than preserving the key
            // insertion order of a WebSocket public-result object.
            id: item.id,
            kind: item.kind,
            z: item.z,
            version: item.version,
            createdBy: item.createdBy,
            style: item.style,
            transform: item.transform,
            geometry: item.geometry,
          }));
        const text = JSON.stringify({
          format: "cf-whiteboard-json",
          version: 1,
          boardId: input.boardId,
          seq: lastSeq,
          createdAt: lastAcceptedAt,
          settings: { title: input.title },
          items: canonicalItems,
        });
        return {
          sha256: await digest(text),
          seq: lastSeq,
          itemCount: canonicalItems.length,
          byteCount: new TextEncoder().encode(text).byteLength,
        };
      },

      summary(): ClientSummary {
        return {
          clientIndex: input.clientIndex,
          role,
          drawingPolicy,
          ready,
          baselineSeq,
          lastSeq,
          lastAcceptedAt,
          itemCount: items.size,
          receivedSeqs: [...receivedSeqs],
          duplicateSeqs: [...duplicateSeqs],
          sequenceGaps: [...sequenceGaps],
          protocolErrors: [...protocolErrors],
          rejectionFrames: [...rejectionFrames],
          acknowledgedCommandIds: [...acknowledgedCommandIds],
          counters: { ...counters },
          closeEvents: [...closeEvents],
        };
      },
    };

    scope.__collabLoadHarness = runtime;
  }, options);
}

export async function connectClient(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = (window as RuntimeWindow).__collabLoadHarness;
    if (runtime === undefined) throw new Error("The load runtime is not installed.");
    return runtime.connect();
  });
}

export async function disconnectClient(page: Page, reason: string): Promise<void> {
  await page.evaluate((value) => {
    const runtime = (window as RuntimeWindow).__collabLoadHarness;
    if (runtime === undefined) throw new Error("The load runtime is not installed.");
    return runtime.disconnect(value);
  }, reason);
}

export async function ensureClientConnected(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = (window as RuntimeWindow).__collabLoadHarness;
    if (runtime === undefined) throw new Error("The load runtime is not installed.");
    return runtime.ensureConnected();
  });
}

export async function startClientTraffic(
  page: Page,
  previewHz: number,
  presenceHz: number,
  syncIntervalMs: number,
): Promise<void> {
  await page.evaluate(
    ({ preview, presence, sync }) => {
      const runtime = (window as RuntimeWindow).__collabLoadHarness;
      if (runtime === undefined) throw new Error("The load runtime is not installed.");
      runtime.startTraffic(preview, presence, sync);
    },
    { preview: previewHz, presence: presenceHz, sync: syncIntervalMs },
  );
}

export async function stopClientTraffic(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as RuntimeWindow).__collabLoadHarness?.stopTraffic();
  });
}

export async function prepareClientGesture(
  page: Page,
  actionId: string,
  itemId: string,
): Promise<void> {
  await page.evaluate(
    ({ action, item }) => {
      const runtime = (window as RuntimeWindow).__collabLoadHarness;
      if (runtime === undefined) throw new Error("The load runtime is not installed.");
      runtime.prepareGesture(action, item);
    },
    { action: actionId, item: itemId },
  );
}

export async function commitAndWait(
  page: Page,
  frame: CommitFrame,
  timeoutMs: number,
): Promise<CommandOutcome> {
  return page.evaluate(
    async ({ command, timeoutMs: commandTimeout }) => {
      const runtime = (window as RuntimeWindow).__collabLoadHarness;
      if (runtime === undefined) throw new Error("The load runtime is not installed.");
      runtime.sendCommit(command);
      return runtime.waitForCommand(command.commandId, commandTimeout);
    },
    { command: frame, timeoutMs },
  );
}

export async function requestClientSync(page: Page, timeoutMs: number): Promise<void> {
  await page.evaluate((syncTimeout) => {
    const runtime = (window as RuntimeWindow).__collabLoadHarness;
    if (runtime === undefined) throw new Error("The load runtime is not installed.");
    return runtime.requestSync(syncTimeout);
  }, timeoutMs);
}

export async function probeClientResyncRecovery(page: Page, timeoutMs: number): Promise<void> {
  await page.evaluate((recoveryTimeout) => {
    const runtime = (window as RuntimeWindow).__collabLoadHarness;
    if (runtime === undefined) throw new Error("The load runtime is not installed.");
    return runtime.probeRecovery(recoveryTimeout);
  }, timeoutMs);
}

export async function waitForClientRole(
  page: Page,
  expectedRole: "editor" | "viewer",
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (role) => (window as RuntimeWindow).__collabLoadHarness?.summary().role === role,
    expectedRole,
    { timeout: timeoutMs },
  );
}

export async function waitForClientSequence(
  page: Page,
  expectedSeq: number,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (seq) => {
      const summary = (window as RuntimeWindow).__collabLoadHarness?.summary();
      return (
        summary !== undefined && (summary.lastSeq === seq || summary.protocolErrors.length > 0)
      );
    },
    expectedSeq,
    { timeout: timeoutMs },
  );
}

export async function clientSummary(page: Page): Promise<ClientSummary> {
  return page.evaluate(() => {
    const runtime = (window as RuntimeWindow).__collabLoadHarness;
    if (runtime === undefined) throw new Error("The load runtime is not installed.");
    return runtime.summary();
  });
}

export async function clientSnapshotDigest(page: Page): Promise<SnapshotDigest> {
  return page.evaluate(() => {
    const runtime = (window as RuntimeWindow).__collabLoadHarness;
    if (runtime === undefined) throw new Error("The load runtime is not installed.");
    return runtime.canonicalSnapshotDigest();
  });
}

export async function fetchExportDigest(page: Page, boardId: string): Promise<ExportDigest> {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/boards/${encodeURIComponent(id)}/export.json`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const text = await response.text();
    const bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const sha256 = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const object =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    return {
      status: response.status,
      responseSeq: Number(response.headers.get("x-whiteboard-seq")) || null,
      etag: response.headers.get("etag"),
      sha256,
      seq: typeof object?.seq === "number" ? object.seq : -1,
      itemCount: Array.isArray(object?.items) ? object.items.length : -1,
      byteCount: new TextEncoder().encode(text).byteLength,
    };
  }, boardId);
}

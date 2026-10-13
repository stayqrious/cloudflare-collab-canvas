import { type BoardFeatures, normalizeBoardFeatures } from "@collab/protocol";

import type {
  ClientSpotlightFrame,
  CommitFrame,
  ConnectionPhase,
  DrawingPolicy,
  HistoryState,
  Presence,
  RemotePreview,
  Role,
  ServerAction,
  ServerFrame,
  SpotlightFrame,
  SpotlightViewState,
  ToolName,
} from "../types";
import { PROTOCOL_VERSION } from "../types";

type WelcomeState = {
  role: Role;
  drawingPolicy: DrawingPolicy;
  imagesEnabled: boolean;
  features: BoardFeatures;
  aclVersion: number;
  historyVersion: number;
  sessionExpiresAt: number;
  canUndo: boolean;
  canRedo: boolean;
};

export type SocketHooks = {
  getSequence: () => number;
  onPhase: (phase: ConnectionPhase) => void;
  onWelcome: (state: WelcomeState) => void;
  onAction: (action: ServerAction, replay: boolean) => void;
  onReady: () => void;
  onRejected: (frame: ServerFrame) => void;
  onHistory: (state: HistoryState) => void;
  onCommentsChanged: () => void;
  onAccessChanged: (frame: ServerFrame) => void;
  onOwnerRecovery: (token: string, aclVersion: number) => void;
  onPreview: (preview: RemotePreview | null, cancelKey?: string) => void;
  onPresence: (presences: Presence[], replace: boolean) => void;
  onSpotlight: (frame: SpotlightFrame) => void;
  onResync: (reason: string) => Promise<void>;
  onNotice: (message: string, kind?: "info" | "warning" | "error") => void;
  refreshSession: () => Promise<void>;
};

const BACKOFF_MS = [0, 250, 500, 1_000, 2_000, 5_000];
const ACTOR_ID_PATTERN = /^a_[A-Za-z0-9_-]{22}$/u;
const MAX_ACTION_CREATORS = 10_000;
/** Largest millisecond value the Date type can represent, so acceptedAt always formats. */
const MAX_ACCEPTED_AT_MS = 8.64e15;
export const PROTOCOL_RELOAD_NOTICE =
  "This board was updated and this tab is no longer compatible. Reload the page to continue.";

export class BoardSocket {
  readonly clientInstanceId = crypto.randomUUID();

  private socket: WebSocket | null = null;
  private phaseValue: ConnectionPhase = "idle";
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private syncTimer: number | null = null;
  private expiryTimer: number | null = null;
  private stableConnectionTimer: number | null = null;
  private stopped = false;
  private resyncing = false;
  private generation = 0;
  private lastPresenceCursor: { x: number; y: number } | null = null;

  constructor(
    private readonly boardId: string,
    private readonly hooks: SocketHooks,
    private readonly authorizationToken: string | null = null,
  ) {
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  get phase(): ConnectionPhase {
    return this.phaseValue;
  }

  get ready(): boolean {
    return this.phaseValue === "ready" && this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.stopped || this.resyncing) return;
    this.clearReconnect();
    const generation = ++this.generation;
    this.setPhase("connecting");
    const url = new URL(
      `/api/v1/boards/${encodeURIComponent(this.boardId)}/socket`,
      window.location.href,
    );
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("since", String(this.hooks.getSequence()));
    url.searchParams.set("client", this.clientInstanceId);

    const socket = this.authorizationToken
      ? new WebSocket(url, ["whiteboard.v1", `auth.${this.authorizationToken}`])
      : new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (generation !== this.generation) return;
      this.setPhase("syncing");
    });
    socket.addEventListener("message", (event) => {
      if (generation !== this.generation) return;
      this.receive(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.stopSyncChecks();
      this.clearStableConnectionTimer();
      if (this.stopped || this.resyncing) return;
      if (event.code === 1002) {
        this.stop(PROTOCOL_RELOAD_NOTICE, "reload_required");
        return;
      }
      if (event.code === 4009) {
        void this.resync("The server requested an authoritative reload.");
        return;
      }
      if (event.code === 4011) {
        this.stop("This board has been archived.", "archived");
        return;
      }
      if (event.code === 4003 || event.code === 4010) {
        this.stop("Your access to this board was removed.");
        return;
      }
      if (event.code === 4001) {
        void this.refreshAndReconnect();
        return;
      }
      this.setPhase("offline");
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // Browsers intentionally expose no useful WebSocket error detail. The
      // close event drives the reconnect path.
    });
  }

  stop(
    message?: string,
    terminalPhase: "stopped" | "archived" | "reload_required" = "stopped",
  ): void {
    this.stopped = true;
    this.generation += 1;
    this.clearReconnect();
    this.stopSyncChecks();
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.clearStableConnectionTimer();
    this.socket?.close(1000, "client stopped");
    this.socket = null;
    this.setPhase(terminalPhase);
    if (message) this.hooks.onNotice(message, "error");
  }

  destroy(): void {
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  sendCommit(command: CommitFrame): boolean {
    return this.send(command, true);
  }

  sendPreview(
    gestureId: string,
    previewSeq: number,
    kind:
      | "pencil.start"
      | "pencil.segment"
      | "shape.geometry"
      | "selection.transform"
      | "gesture.cancel",
    payload: Record<string, unknown> = {},
  ): boolean {
    return this.send(
      { v: PROTOCOL_VERSION, t: "client.preview", gestureId, previewSeq, kind, payload },
      true,
    );
  }

  sendPresence(cursor: { x: number; y: number } | null, activeTool: ToolName): boolean {
    if (document.hidden) return false;
    if (cursor) this.lastPresenceCursor = cursor;
    if (!this.lastPresenceCursor) return false;
    return this.send(
      { v: PROTOCOL_VERSION, t: "client.presence", cursor: this.lastPresenceCursor, activeTool },
      true,
    );
  }

  sendSpotlight(spotlightId: string, active: boolean, viewport?: SpotlightViewState): boolean {
    let frame: ClientSpotlightFrame;
    if (active) {
      if (!viewport) return false;
      frame = {
        v: PROTOCOL_VERSION,
        t: "client.facilitation.spotlight",
        spotlightId,
        active: true,
        viewport,
      };
    } else {
      frame = {
        v: PROTOCOL_VERSION,
        t: "client.facilitation.spotlight",
        spotlightId,
        active: false,
      };
    }
    return this.send(frame, true);
  }

  resynchronize(reason = "Reloading authoritative board state."): void {
    void this.resync(reason);
  }

  private send(frame: object, requireReady: boolean): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (requireReady && this.phaseValue !== "ready") return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") {
      this.socket?.close(1003, "binary frames are unsupported");
      return;
    }
    let frame: ServerFrame;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed) || typeof parsed.t !== "string" || parsed.v !== PROTOCOL_VERSION) {
        throw new Error("Invalid frame envelope.");
      }
      frame = parsed as ServerFrame;
    } catch {
      this.socket?.close(1002, "invalid server frame");
      return;
    }

    switch (frame.t) {
      case "server.welcome": {
        const state = welcomeState(frame);
        if (!state) {
          this.socket?.close(1002, "invalid welcome");
          return;
        }
        this.hooks.onWelcome(state);
        this.scheduleSessionRefresh(state.sessionExpiresAt);
        break;
      }
      case "server.replay": {
        const fromExclusive = number(frame.fromExclusive);
        const toInclusive = number(frame.toInclusive);
        const actions = Array.isArray(frame.actions) ? frame.actions : null;
        if (
          fromExclusive === null ||
          toInclusive === null ||
          !actions ||
          fromExclusive !== this.hooks.getSequence()
        ) {
          void this.resync("The replay stream was not contiguous.");
          return;
        }
        for (const value of actions) {
          const action = asServerAction(value);
          if (!action || action.seq !== this.hooks.getSequence() + 1) {
            void this.resync("The replay stream contained a sequence gap.");
            return;
          }
          this.hooks.onAction(action, true);
        }
        if (this.hooks.getSequence() !== toInclusive) {
          void this.resync("The replay high-water mark did not match its actions.");
        }
        break;
      }
      case "server.action": {
        const action = asServerAction(frame);
        if (!action) {
          void this.resync("The server sent an invalid action.");
          return;
        }
        this.hooks.onAction(action, false);
        break;
      }
      case "server.ready": {
        const latestSeq = number(frame.latestSeq);
        if (latestSeq === null || latestSeq !== this.hooks.getSequence()) {
          void this.resync("The ready high-water mark did not match local board state.");
          return;
        }
        this.setPhase("ready");
        this.startSyncChecks();
        this.clearStableConnectionTimer();
        this.stableConnectionTimer = window.setTimeout(() => {
          this.reconnectAttempt = 0;
          this.stableConnectionTimer = null;
        }, 10_000);
        this.hooks.onReady();
        break;
      }
      case "server.rejected":
        if (frame.reloadRequired === true) {
          this.stop(PROTOCOL_RELOAD_NOTICE, "reload_required");
          return;
        }
        this.hooks.onRejected(frame);
        break;
      case "server.comments.refresh":
        this.hooks.onCommentsChanged();
        break;
      case "server.history_state": {
        const historyVersion = number(frame.historyVersion);
        if (historyVersion !== null) {
          this.hooks.onHistory({
            historyVersion,
            canUndo: frame.canUndo === true,
            canRedo: frame.canRedo === true,
          });
        }
        break;
      }
      case "access.changed":
      case "server.access_changed": {
        const features = boardFeatures(frame.features);
        if (features === null || frame.imagesEnabled !== features.images) {
          void this.resync("Board feature settings changed; refreshing policy.");
          return;
        }
        this.hooks.onAccessChanged({ ...frame, features });
        break;
      }
      case "server.owner_recovery": {
        const token = string(frame.ownerRecoveryToken);
        const aclVersion = number(frame.aclVersion);
        if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token) || aclVersion === null) {
          this.hooks.onNotice("The server sent an invalid owner recovery link.", "error");
          break;
        }
        this.hooks.onOwnerRecovery(token, aclVersion);
        break;
      }
      case "server.preview":
      case "server.gesture_preview":
        this.receivePreview(frame);
        break;
      case "server.presence":
      case "server.presence.joined":
      case "server.presence.left":
      case "server.presence_state":
        this.receivePresence(frame);
        break;
      case "server.facilitation.spotlight": {
        const spotlight = asSpotlightFrame(frame);
        if (!spotlight) {
          this.socket?.close(1002, "invalid spotlight");
          return;
        }
        this.hooks.onSpotlight(spotlight);
        break;
      }
      case "server.previews_cleared":
        if (typeof frame.actorId === "string") this.hooks.onPreview(null, `actor:${frame.actorId}`);
        break;
      case "server.resync_required":
        void this.resync(
          typeof frame.message === "string" ? frame.message : "The board needs to reload.",
        );
        break;
      case "server.in_sync":
        break;
      default:
        // Unknown server frames are ignored for forward compatibility. Client
        // frame types remain strict at the authoritative boundary.
        break;
    }
  }

  private receivePreview(frame: ServerFrame): void {
    const actorValue = isRecord(frame.actor) ? frame.actor : null;
    const actorId = typeof actorValue?.id === "string" ? actorValue.id : string(frame.actorId);
    const actorName =
      typeof actorValue?.displayName === "string"
        ? actorValue.displayName
        : (string(frame.displayName) ?? "Guest");
    const gestureId = string(frame.gestureId);
    const kind = string(frame.kind);
    if (!actorId || !gestureId || !kind) return;
    const key = `${string(frame.connectionId) ?? actorId}:${gestureId}`;
    if (kind === "gesture.cancel") {
      this.hooks.onPreview(null, key);
      return;
    }
    if (!["pencil.start", "pencil.segment", "shape.geometry", "selection.transform"].includes(kind))
      return;
    this.hooks.onPreview({
      key,
      actorId,
      actorName,
      gestureId,
      kind: kind as RemotePreview["kind"],
      payload: isRecord(frame.payload) ? frame.payload : {},
      updatedAt: Date.now(),
    });
  }

  private receivePresence(frame: ServerFrame): void {
    if (Array.isArray(frame.participants)) {
      const values = frame.participants.flatMap((value) => {
        const presence = asPresence(value);
        return presence ? [presence] : [];
      });
      this.hooks.onPresence(values, true);
      return;
    }
    const presence = asPresence(frame.participant ?? frame);
    if (!presence) return;
    if (frame.t === "server.presence.left") presence.cursor = null;
    this.hooks.onPresence([presence], false);
  }

  private setPhase(phase: ConnectionPhase): void {
    if (this.phaseValue === phase) return;
    this.phaseValue = phase;
    this.hooks.onPhase(phase);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.resyncing || this.reconnectTimer !== null) return;
    const base = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)] ?? 5_000;
    const jitter = base === 0 ? 0 : base * (Math.random() * 0.4 - 0.2);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(
      () => {
        this.reconnectTimer = null;
        this.connect();
      },
      Math.max(0, base + jitter),
    );
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private startSyncChecks(): void {
    this.stopSyncChecks();
    if (document.hidden) return;
    this.syncTimer = window.setInterval(() => {
      this.send(
        { v: PROTOCOL_VERSION, t: "client.sync_check", latestSeq: this.hooks.getSequence() },
        true,
      );
    }, 30_000);
  }

  private stopSyncChecks(): void {
    if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  private clearStableConnectionTimer(): void {
    if (this.stableConnectionTimer !== null) window.clearTimeout(this.stableConnectionTimer);
    this.stableConnectionTimer = null;
  }

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.stopSyncChecks();
      return;
    }
    if (this.ready) {
      this.startSyncChecks();
      this.send(
        { v: PROTOCOL_VERSION, t: "client.sync_check", latestSeq: this.hooks.getSequence() },
        true,
      );
    }
  };

  private scheduleSessionRefresh(expiresAt: number): void {
    if (this.expiryTimer !== null) window.clearTimeout(this.expiryTimer);
    const delay = Math.max(1_000, Math.min(2_147_000_000, expiresAt - Date.now() - 60_000));
    this.expiryTimer = window.setTimeout(() => void this.refreshAndReconnect(), delay);
  }

  private async refreshAndReconnect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.hooks.refreshSession();
    } catch {
      this.stop("Your session could not be renewed. Reload to try again.");
      return;
    }
    this.socket?.close(1000, "refreshing session");
    this.socket = null;
    this.setPhase("offline");
    this.scheduleReconnect();
  }

  private async resync(reason: string): Promise<void> {
    if (this.resyncing || this.stopped) return;
    this.resyncing = true;
    this.generation += 1;
    this.socket?.close(1000, "resynchronizing");
    this.socket = null;
    this.stopSyncChecks();
    this.setPhase("syncing");
    try {
      await this.hooks.onResync(reason);
      this.resyncing = false;
      this.connect();
    } catch {
      this.resyncing = false;
      this.setPhase("offline");
      this.scheduleReconnect();
    }
  }
}

function welcomeState(frame: ServerFrame): WelcomeState | null {
  const actor = isRecord(frame.actor) ? frame.actor : null;
  const role = frame.role ?? actor?.role;
  const policy = frame.drawingPolicy;
  const aclVersion = number(frame.aclVersion);
  const historyVersion = number(frame.historyVersion);
  const sessionExpiresAt = number(frame.sessionExpiresAt);
  const features = boardFeatures(frame.features);
  if (
    (role !== "viewer" && role !== "editor" && role !== "owner") ||
    (policy !== "editors_enabled" && policy !== "owner_only" && policy !== "locked") ||
    typeof frame.imagesEnabled !== "boolean" ||
    features === null ||
    frame.imagesEnabled !== features.images ||
    aclVersion === null ||
    historyVersion === null ||
    sessionExpiresAt === null
  ) {
    return null;
  }
  return {
    role,
    drawingPolicy: policy,
    imagesEnabled: frame.imagesEnabled,
    features,
    aclVersion,
    historyVersion,
    sessionExpiresAt,
    canUndo: frame.canUndo === true,
    canRedo: frame.canRedo === true,
  };
}

function boardFeatures(value: unknown): BoardFeatures | null {
  try {
    return normalizeBoardFeatures(value);
  } catch {
    return null;
  }
}

function asServerAction(value: unknown): ServerAction | null {
  if (!isRecord(value)) return null;
  const baseKeys = ["v", "t", "seq", "acceptedAt", "actor", "commandId", "actionId", "op"];
  const expectedKeys = value.creators === undefined ? baseKeys : [...baseKeys, "creators"];
  if (!hasExactKeys(value, expectedKeys)) return null;
  const actor = asServerActor(value.actor);
  const creators =
    value.creators === undefined ? undefined : asServerCreatorDirectory(value.creators);
  if (
    value.v !== PROTOCOL_VERSION ||
    value.t !== "server.action" ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    !Number.isSafeInteger(value.acceptedAt) ||
    (value.acceptedAt as number) < 0 ||
    (value.acceptedAt as number) > MAX_ACCEPTED_AT_MS ||
    !isCanonicalUuid(value.commandId) ||
    !isCanonicalUuid(value.actionId) ||
    actor === null ||
    (value.creators !== undefined && creators === null) ||
    !isRecord(value.op)
  ) {
    return null;
  }
  return {
    v: PROTOCOL_VERSION,
    t: "server.action",
    seq: value.seq as number,
    acceptedAt: value.acceptedAt as number,
    actor,
    ...(creators === undefined || creators === null ? {} : { creators }),
    commandId: value.commandId,
    actionId: value.actionId,
    op: value.op as ServerAction["op"],
  };
}

function asServerActor(value: unknown): ServerAction["actor"] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "displayName"])) return null;
  if (typeof value.id !== "string" || !ACTOR_ID_PATTERN.test(value.id)) return null;
  if (typeof value.displayName !== "string" || value.displayName.trim() !== value.displayName) {
    return null;
  }
  const displayNameLength = [...value.displayName].length;
  if (displayNameLength < 1 || displayNameLength > 40 || /\p{Cc}/u.test(value.displayName)) {
    return null;
  }
  return { id: value.id, displayName: value.displayName };
}

function asServerCreatorDirectory(value: unknown): NonNullable<ServerAction["creators"]> | null {
  if (!Array.isArray(value) || value.length > MAX_ACTION_CREATORS) return null;
  const result: NonNullable<ServerAction["creators"]> = [];
  const seen = new Set<string>();
  for (const valueActor of value) {
    const actor = asServerActor(valueActor);
    if (actor === null || seen.has(actor.id)) return null;
    seen.add(actor.id);
    result.push(actor);
  }
  return result;
}

function asPresence(value: unknown): Presence | null {
  if (!isRecord(value)) return null;
  const actor = isRecord(value.actor) ? value.actor : value;
  const id = string(actor.id) ?? string(value.actorId);
  const displayName = string(actor.displayName) ?? string(value.displayName);
  if (!id || !displayName) return null;
  let cursor: Presence["cursor"] = null;
  if (isRecord(value.cursor)) {
    const x = number(value.cursor.x);
    const y = number(value.cursor.y);
    if (x !== null && y !== null) cursor = { x, y };
  }
  const activeTool = string(value.activeTool);
  return {
    id,
    displayName,
    connectionId: string(value.connectionId) ?? undefined,
    role:
      value.role === "owner" || value.role === "editor" || value.role === "viewer"
        ? value.role
        : undefined,
    cursor,
    activeTool:
      activeTool &&
      [
        "select",
        "pencil",
        "line",
        "rectangle",
        "ellipse",
        "polygon",
        "protractor",
        "text",
        "sticky",
        "stamp",
        "image",
        "table",
        "zone",
        "eraser",
        "pan",
      ].includes(activeTool)
        ? (activeTool as ToolName)
        : undefined,
    color: string(value.color) ?? undefined,
    updatedAt: Date.now(),
  };
}

function asSpotlightFrame(value: unknown): SpotlightFrame | null {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION) return null;
  if (value.t !== "server.facilitation.spotlight" || !isCanonicalUuid(value.spotlightId)) {
    return null;
  }
  if (typeof value.active !== "boolean" || !isCanonicalUuid(value.connectionId)) return null;
  if (!isRecord(value.actor) || !hasExactKeys(value.actor, ["id", "displayName"])) return null;
  const actorId = string(value.actor.id);
  const displayName = string(value.actor.displayName);
  if (!actorId || !displayName || [...displayName].length > 40) return null;

  const base = {
    v: PROTOCOL_VERSION,
    t: "server.facilitation.spotlight" as const,
    spotlightId: value.spotlightId,
    actor: { id: actorId, displayName },
    connectionId: value.connectionId,
  };
  if (!value.active) {
    if (!hasExactKeys(value, ["v", "t", "spotlightId", "active", "actor", "connectionId"])) {
      return null;
    }
    return { ...base, active: false };
  }
  if (
    !hasExactKeys(value, [
      "v",
      "t",
      "spotlightId",
      "active",
      "viewport",
      "actor",
      "connectionId",
    ]) ||
    !isRecord(value.viewport) ||
    !hasExactKeys(value.viewport, ["center", "zoom"]) ||
    !isRecord(value.viewport.center) ||
    !hasExactKeys(value.viewport.center, ["x", "y"])
  ) {
    return null;
  }
  const x = boundedCoordinate(value.viewport.center.x);
  const y = boundedCoordinate(value.viewport.center.y);
  const zoom = number(value.viewport.zoom);
  if (x === null || y === null || zoom === null || zoom < 0.1 || zoom > 8) return null;
  return {
    ...base,
    active: true,
    viewport: { center: { x, y }, zoom },
  };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function boundedCoordinate(value: unknown): number | null {
  const coordinate = number(value);
  return coordinate !== null && Math.abs(coordinate) <= 1_000_000 ? coordinate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

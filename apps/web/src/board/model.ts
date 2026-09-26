import { applyAuthoritativeOperation } from "@collab/board-core";
import {
  itemBounds as canonicalItemBounds,
  lineArrowheadPoints,
  type OutlineGeometry,
  type OutlineGeometryKind,
  protractorSnapPoints,
  textLayoutEstimateSource,
  VIDEO_EMBED_HEIGHT,
  VIDEO_EMBED_WIDTH,
  visibleOutlinePaths,
  zoneGeometryContainsPoint,
} from "@collab/geometry";
import type {
  AuthoritativeItemOperation,
  AuthoritativeOperation,
  CanonicalItemChange,
  BoardItem as SharedBoardItem,
} from "@collab/protocol";
import { normalizeBoardItem } from "@collab/protocol";
import { eraseStrokeItem, isPartiallyErasableItem } from "../tools/stroke-erase";
import type {
  BatchItemOperation,
  BoardItem,
  BoardSnapshot,
  BoxGeometry,
  CommitFrame,
  DurableOperation,
  ItemPatch,
  Matrix,
  Point,
  ServerAction,
  TableGeometry,
  TextGeometry,
} from "../types";
import { isBoardItem } from "../types";

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export type ConnectorAnchor = {
  itemId: string;
  point: Point;
  z: number;
  distance: number;
  source?: "cardinal" | "endpoint" | "edge" | "protractor-center" | "protractor-tick";
  pathIndex?: number;
  segmentIndex?: number;
  t?: number;
};

type ModelListener = (changedIds: ReadonlySet<string> | null) => void;
type RebaseListener = (error: Error | null) => void;

type RenderedTextMeasurement = {
  signature: string;
  width: number;
  height: number;
};

const renderedTextMeasurements = new WeakMap<TextGeometry, RenderedTextMeasurement>();

function textMeasurementSignature(item: Extract<BoardItem, { kind: "text" }>): string {
  return JSON.stringify([
    item.geometry.text,
    item.style.fontSize,
    item.style.fontFamily,
    item.style.fontWeight,
    item.style.fontStyle,
    item.style.textDecoration,
  ]);
}

function renderedTextMeasurement(
  item: Extract<BoardItem, { kind: "text" }>,
): RenderedTextMeasurement | undefined {
  const measurement = renderedTextMeasurements.get(item.geometry);
  return measurement?.signature === textMeasurementSignature(item) ? measurement : undefined;
}

function preserveRenderedTextMeasurement(previous: BoardItem | undefined, next: BoardItem): void {
  if (previous?.kind !== "text" || next.kind !== "text") return;
  const measurement = renderedTextMeasurement(previous);
  if (measurement?.signature === textMeasurementSignature(next)) {
    renderedTextMeasurements.set(next.geometry, measurement);
  }
}

export class BoardModel {
  private authoritative = new Map<string, BoardItem>();
  private rendered = new Map<string, BoardItem>();
  private readonly optimistic = new Map<string, CommitFrame>();
  private readonly bounds = new Map<string, Bounds>();
  private readonly listeners = new Set<ModelListener>();
  private readonly rebaseListeners = new Set<RebaseListener>();
  private readonly recentActions = new Map<number, string>();
  private rebaseErrorValue: Error | null = null;

  lastAppliedSeq = 0;

  load(snapshot: BoardSnapshot, preserveOptimistic = false): void {
    if (!Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || !Array.isArray(snapshot.items)) {
      throw new Error("The authoritative board snapshot is invalid.");
    }
    this.authoritative.clear();
    for (const item of snapshot.items) {
      const normalized = normalizeBoardItem(item) as unknown as BoardItem;
      if (this.authoritative.has(normalized.id)) {
        throw new Error("The authoritative board snapshot contains a duplicate item.");
      }
      this.authoritative.set(normalized.id, normalized);
    }
    if (!preserveOptimistic) this.optimistic.clear();
    this.lastAppliedSeq = snapshot.seq;
    this.recentActions.clear();
    this.rebuildRendered(null);
  }

  subscribe(listener: ModelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeRebase(listener: RebaseListener): () => void {
    this.rebaseListeners.add(listener);
    return () => this.rebaseListeners.delete(listener);
  }

  get items(): ReadonlyMap<string, BoardItem> {
    return this.rendered;
  }

  get authoritativeItems(): ReadonlyMap<string, BoardItem> {
    return this.authoritative;
  }

  get pendingCount(): number {
    return this.optimistic.size;
  }

  get pendingCommands(): CommitFrame[] {
    return [...this.optimistic.values()];
  }

  get rebaseError(): Error | null {
    return this.rebaseErrorValue;
  }

  discardOptimistic(): CommitFrame[] {
    const discarded = this.pendingCommands;
    if (discarded.length === 0) return discarded;
    const affected = new Set<string>();
    for (const command of discarded) {
      for (const id of operationIds(command.op)) affected.add(id);
    }
    this.optimistic.clear();
    this.rebuildRendered(affected);
    return discarded;
  }

  getItem(id: string): BoardItem | undefined {
    return this.rendered.get(id);
  }

  getBounds(id: string): Bounds | undefined {
    const cached = this.bounds.get(id);
    if (cached) return cached;
    const item = this.rendered.get(id);
    if (!item) return undefined;
    const computed = itemBounds(item);
    this.bounds.set(id, computed);
    return computed;
  }

  setRenderedTextSize(id: string, expectedVersion: number, width: number, height: number): boolean {
    const item = this.rendered.get(id);
    if (
      item?.kind !== "text" ||
      item.version !== expectedVersion ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return false;
    }
    const previous = renderedTextMeasurement(item);
    if (previous?.width === width && previous.height === height) return false;
    renderedTextMeasurements.set(item.geometry, {
      signature: textMeasurementSignature(item),
      width,
      height,
    });
    this.bounds.delete(id);
    return true;
  }

  renderedTextSectionMembershipOperation(
    id: string,
    expectedVersion: number,
  ): Extract<BatchItemOperation, { kind: "item.update" }> | null {
    const item = this.rendered.get(id);
    const authoritative = this.authoritative.get(id);
    if (
      item?.kind !== "text" ||
      item.version <= 0 ||
      item.version !== expectedVersion ||
      renderedTextMeasurement(item) === undefined ||
      authoritative?.kind !== "text" ||
      authoritative.version !== expectedVersion ||
      authoritative.sectionId !== item.sectionId ||
      [...this.optimistic.values()].some((command) => operationIds(command.op).has(id))
    ) {
      return null;
    }
    let sectionId: string | undefined;
    if (item.sectionId !== undefined) {
      const section = this.rendered.get(item.sectionId);
      // Detaching and attaching both require the shared canonical estimate to agree with the
      // local measurement, so their preconditions can never hold at once. Without that, two
      // clients whose MathJax measurements straddle a Section edge take turns detaching and
      // reattaching the same formula forever, writing an unbounded stream of item.update
      // history. A dangling sectionId still detaches so the reference is cleaned up.
      if (
        section?.kind === "zone" &&
        (boundsContains(itemBounds(section), itemBounds(item)) ||
          boundsContains(canonicalBounds(section), canonicalBounds(item)))
      ) {
        return null;
      }
    } else {
      sectionId = [...this.rendered.values()]
        .filter(
          (candidate): candidate is Extract<BoardItem, { kind: "zone" }> =>
            candidate.kind === "zone" &&
            boundsContains(itemBounds(candidate), itemBounds(item)) &&
            boundsContains(canonicalBounds(candidate), canonicalBounds(item)),
        )
        .sort((left, right) => right.z - left.z || left.id.localeCompare(right.id))[0]?.id;
      if (sectionId === undefined) return null;
    }
    return {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { sectionId: sectionId ?? null },
    };
  }

  queue(command: CommitFrame, actorId: string): void {
    this.optimistic.set(command.commandId, command);
    this.rebuildRendered(operationIds(command.op));
    // createdBy is only a display hint before the authoritative echo.
    for (const id of operationIds(command.op)) {
      const item = this.rendered.get(id);
      if (item?.version === 0 && !item.createdBy) item.createdBy = actorId;
    }
  }

  restoreQueued(command: CommitFrame, actorId: string): void {
    if (this.optimistic.has(command.commandId)) return;
    this.queue(command, actorId);
  }

  reject(commandId: string): boolean {
    const command = this.optimistic.get(commandId);
    if (!command) return false;
    this.optimistic.delete(commandId);
    this.rebuildRendered(operationIds(command.op));
    return true;
  }

  hasSeenAction(seq: number, commandId: string): boolean {
    return this.recentActions.get(seq) === commandId;
  }

  applyAction(action: ServerAction): { acknowledged: boolean; changedIds: Set<string> } {
    if (action.seq !== this.lastAppliedSeq + 1) {
      throw new SequenceError(this.lastAppliedSeq + 1, action.seq);
    }

    const changedIds = new Set<string>();
    const authoritativeOperation = adaptAuthoritativeOperation(
      action.op,
      this.authoritative,
      action.seq,
    );
    if (authoritativeOperation) {
      this.authoritative = applyAuthoritativeOperation(
        this.authoritative as unknown as ReadonlyMap<string, SharedBoardItem>,
        authoritativeOperation,
      ) as unknown as Map<string, BoardItem>;
      for (const id of authoritativeOperationIds(authoritativeOperation)) changedIds.add(id);
    } else {
      // Restore actions are an edge-level extension that carry the same
      // explicit replacement/removal delta. They intentionally remain at this
      // adapter boundary until they join the shared protocol union.
      applyOperation(this.authoritative, action.op, action.actor.id, action.seq, changedIds, true);
    }
    this.lastAppliedSeq = action.seq;
    this.recentActions.set(action.seq, action.commandId);
    while (this.recentActions.size > 1_000) {
      const first = this.recentActions.keys().next().value as number | undefined;
      if (first === undefined) break;
      this.recentActions.delete(first);
    }

    const acknowledged = this.optimistic.delete(action.commandId);
    this.rebuildRendered(changedIds);
    return { acknowledged, changedIds };
  }

  toSnapshot(boardId?: string): BoardSnapshot {
    return {
      format: "cf-whiteboard-json",
      version: 1,
      boardId,
      seq: this.lastAppliedSeq,
      createdAt: Date.now(),
      items: [...this.rendered.values()]
        .sort((a, b) => a.z - b.z)
        .map((item) => structuredClone(item)),
    };
  }

  hitTest(point: Point, extra = 6): BoardItem | undefined {
    const candidates = [...this.rendered.values()].sort((a, b) => b.z - a.z);
    for (const item of candidates) {
      const bounds = this.getBounds(item.id);
      if (!bounds || !containsPoint(expandBounds(bounds, extra), point)) continue;
      if (preciseHit(item, point, extra)) return item;
    }
    return undefined;
  }

  nearestConnectorAnchor(
    point: Point,
    maxDistance: number,
    excludedItemIds: ReadonlySet<string> = new Set(),
  ): ConnectorAnchor | undefined {
    if (!Number.isFinite(maxDistance) || maxDistance < 0) return undefined;
    let nearest: ConnectorAnchor | undefined;
    for (const item of this.rendered.values()) {
      if (excludedItemIds.has(item.id)) continue;
      const bounds = this.getBounds(item.id);
      if (!bounds || !containsPoint(expandBounds(bounds, maxDistance), point)) continue;
      const hasVisibleFragments =
        isPartiallyErasableItem(item) && item.geometry.visiblePaths !== undefined;
      if (supportsConnectorAnchors(item) && !hasVisibleFragments) {
        for (const anchorPoint of transformedCardinalAnchorPoints(item)) {
          nearest = nearerAnchor(
            nearest,
            {
              itemId: item.id,
              point: anchorPoint,
              z: item.z,
              distance: pointDistance(point, anchorPoint),
            },
            maxDistance,
          );
        }
      }
      if (isPartiallyErasableItem(item)) {
        const paths = worldOutlinePaths(item);
        paths.forEach((path, pathIndex) => {
          for (let segmentIndex = 1; segmentIndex < path.length; segmentIndex += 1) {
            const start = path[segmentIndex - 1];
            const end = path[segmentIndex];
            if (!start || !end) continue;
            const projection = projectPointToSegment(point, start, end);
            const source = projection.t <= 1e-9 || projection.t >= 1 - 1e-9 ? "endpoint" : "edge";
            nearest = nearerAnchor(
              nearest,
              {
                itemId: item.id,
                point: projection.point,
                z: item.z,
                distance: projection.distance,
                source,
                pathIndex,
                segmentIndex: segmentIndex - 1,
                t: projection.t,
              },
              maxDistance,
            );
          }
        });
      } else if (item.kind === "protractor") {
        protractorSnapPoints(item.geometry).forEach((localPoint, index) => {
          const anchorPoint = transformPoint(localPoint, item.transform);
          nearest = nearerAnchor(
            nearest,
            {
              itemId: item.id,
              point: anchorPoint,
              z: item.z,
              distance: pointDistance(point, anchorPoint),
              source: index === 0 ? "protractor-center" : "protractor-tick",
            },
            maxDistance,
          );
        });
        const baselineStart = transformPoint([-item.geometry.radius, 0], item.transform);
        const baselineEnd = transformPoint([item.geometry.radius, 0], item.transform);
        const projection = projectPointToSegment(point, baselineStart, baselineEnd);
        nearest = nearerAnchor(
          nearest,
          {
            itemId: item.id,
            point: projection.point,
            z: item.z,
            distance: projection.distance,
            source: projection.t <= 1e-9 || projection.t >= 1 - 1e-9 ? "endpoint" : "edge",
            segmentIndex: 0,
            t: projection.t,
          },
          maxDistance,
        );
      }
    }
    return nearest;
  }

  strokeItemsNearPath(
    path: readonly Point[],
    radius: number,
    canModify: (item: BoardItem) => boolean = () => true,
  ): BoardItem[] {
    if (
      path.length === 0 ||
      !Number.isFinite(radius) ||
      radius < 0 ||
      path.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
    ) {
      return [];
    }
    const area = expandBounds(boundsFromPoints(path), radius);
    return [...this.rendered.values()]
      .filter((item) => {
        if (!isPartiallyErasableItem(item) || item.version <= 0 || !canModify(item)) return false;
        const bounds = this.getBounds(item.id);
        return Boolean(
          bounds && boundsIntersect(bounds, area) && eraseStrokeItem(item, path, radius),
        );
      })
      .sort((left, right) => right.z - left.z || left.id.localeCompare(right.id));
  }

  intersecting(area: Bounds): BoardItem[] {
    return [...this.rendered.values()].filter((item) => {
      const bounds = this.getBounds(item.id);
      if (!bounds) return false;
      return item.kind === "zone" ? boundsContains(area, bounds) : boundsIntersect(bounds, area);
    });
  }

  boundsFor(ids: Iterable<string>): Bounds | undefined {
    let result: Bounds | undefined;
    for (const id of ids) {
      const next = this.getBounds(id);
      if (!next) continue;
      result = result ? unionBounds(result, next) : { ...next };
    }
    return result;
  }

  private rebuildRendered(changed: ReadonlySet<string> | null): void {
    const previous = this.rendered;
    let next = this.cloneAuthoritative();
    let rebaseError: Error | null = null;

    try {
      let optimisticZ = Math.max(0, ...[...next.values()].map((item) => item.z)) + 1;
      for (const command of this.optimistic.values()) {
        applyOperation(next, command.op, "", 0, new Set(), false, () => optimisticZ++);
      }
    } catch (error) {
      // Replaying may have partially mutated the candidate map before it
      // failed. Re-clone canonical state while retaining the journal so the
      // durable outbox can be recovered or explicitly discarded by the user.
      next = this.cloneAuthoritative();
      rebaseError = error instanceof Error ? error : new Error("Optimistic rebase failed.");
    }

    for (const [id, item] of next) preserveRenderedTextMeasurement(previous.get(id), item);
    this.rendered = next;
    const affected = changed ? new Set(changed) : new Set<string>();
    if (!changed) {
      for (const id of previous.keys()) affected.add(id);
      for (const id of next.keys()) affected.add(id);
    } else {
      for (const command of this.optimistic.values()) {
        for (const id of operationIds(command.op)) affected.add(id);
      }
    }
    for (const id of affected) this.bounds.delete(id);
    for (const listener of this.listeners) listener(changed ? affected : null);
    this.setRebaseError(rebaseError);
  }

  private cloneAuthoritative(): Map<string, BoardItem> {
    const result = new Map<string, BoardItem>();
    for (const [id, item] of this.authoritative) result.set(id, structuredClone(item));
    return result;
  }

  private setRebaseError(error: Error | null): void {
    const wasFailed = this.rebaseErrorValue !== null;
    const isFailed = error !== null;
    this.rebaseErrorValue = error;
    if (wasFailed === isFailed) return;
    for (const listener of this.rebaseListeners) listener(error);
  }
}

export class SequenceError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`Expected board sequence ${expected}, received ${received}.`);
    this.name = "SequenceError";
  }
}

function adaptAuthoritativeOperation(
  value: unknown,
  current: ReadonlyMap<string, BoardItem>,
  seq: number,
): AuthoritativeOperation | null {
  if (!value || typeof value !== "object")
    throw new Error("The authoritative operation is invalid.");
  const operation = value as Record<string, unknown>;
  if (
    operation.kind === "item.create" ||
    operation.kind === "item.update" ||
    operation.kind === "item.delete" ||
    operation.kind === "item.copy"
  ) {
    return adaptAuthoritativeItem(operation, seq);
  }
  if (operation.kind === "items.batch") {
    if (!Array.isArray(operation.operations))
      throw new Error("The authoritative batch is invalid.");
    return {
      kind: "items.batch",
      operations: operation.operations.map((child) => {
        if (!child || typeof child !== "object")
          throw new Error("The authoritative batch child is invalid.");
        return adaptAuthoritativeItem(child as Record<string, unknown>, seq);
      }),
    };
  }
  if (operation.kind === "history.undo" || operation.kind === "history.redo") {
    if (!Array.isArray(operation.changes) || typeof operation.targetActionId !== "string") {
      throw new Error("The authoritative history operation is invalid.");
    }
    const changes: CanonicalItemChange[] = operation.changes.map((value) => {
      if (!value || typeof value !== "object")
        throw new Error("The authoritative history change is invalid.");
      const change = value as Record<string, unknown>;
      if ((change.kind === "item.replace" || change.item !== null) && isBoardItem(change.item)) {
        return { kind: "item.replace", item: change.item as unknown as SharedBoardItem };
      }
      if (
        typeof change.itemId === "string" &&
        (change.kind === "item.remove" || change.item === null)
      ) {
        return {
          kind: "item.remove",
          itemId: change.itemId,
          version: typeof change.version === "number" ? change.version : seq,
        };
      }
      throw new Error("The authoritative history change is invalid.");
    });
    return { kind: operation.kind, targetActionId: operation.targetActionId, changes };
  }
  if (operation.kind === "board.clear") {
    const rawRemoved = Array.isArray(operation.removed) ? operation.removed : [...current.keys()];
    const removed = rawRemoved.map((value) => {
      if (typeof value === "string") return { itemId: value, version: seq };
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { itemId?: unknown }).itemId === "string"
      ) {
        const removal = value as { itemId: string; version?: unknown };
        return {
          itemId: removal.itemId,
          version: typeof removal.version === "number" ? removal.version : seq,
        };
      }
      throw new Error("The authoritative clear removal is invalid.");
    });
    return { kind: "board.clear", removed };
  }
  if (operation.kind === "board.restore") return null;
  throw new Error("The authoritative operation kind is unsupported.");
}

function adaptAuthoritativeItem(
  operation: Record<string, unknown>,
  seq: number,
): AuthoritativeItemOperation {
  if (operation.kind === "item.create" && isBoardItem(operation.item)) {
    return { kind: "item.create", item: operation.item as unknown as SharedBoardItem };
  }
  if (operation.kind === "item.update" && isBoardItem(operation.item)) {
    return { kind: "item.update", item: operation.item as unknown as SharedBoardItem };
  }
  if (operation.kind === "item.delete" && typeof operation.itemId === "string") {
    return {
      kind: "item.delete",
      itemId: operation.itemId,
      version: typeof operation.version === "number" ? operation.version : seq,
    };
  }
  if (
    operation.kind === "item.copy" &&
    typeof operation.sourceItemId === "string" &&
    isBoardItem(operation.item)
  ) {
    return {
      kind: "item.copy",
      sourceItemId: operation.sourceItemId,
      item: operation.item as unknown as SharedBoardItem,
    };
  }
  throw new Error("The authoritative item operation is invalid.");
}

function authoritativeOperationIds(operation: AuthoritativeOperation): Set<string> {
  const ids = new Set<string>();
  const add = (itemOperation: AuthoritativeItemOperation): void => {
    if (itemOperation.kind === "item.delete") ids.add(itemOperation.itemId);
    else ids.add(itemOperation.item.id);
  };
  switch (operation.kind) {
    case "item.create":
    case "item.update":
    case "item.delete":
    case "item.copy":
      add(operation);
      break;
    case "items.batch":
      operation.operations.forEach(add);
      break;
    case "history.undo":
    case "history.redo":
      for (const change of operation.changes)
        ids.add(change.kind === "item.replace" ? change.item.id : change.itemId);
      break;
    case "board.clear":
      for (const removal of operation.removed) ids.add(removal.itemId);
      break;
  }
  return ids;
}

function applyOperation(
  target: Map<string, BoardItem>,
  operation: DurableOperation & Record<string, unknown>,
  actorId: string,
  version: number,
  changed: Set<string>,
  canonical: boolean,
  allocateZ: () => number = () => Math.max(0, ...[...target.values()].map((item) => item.z)) + 1,
): void {
  applyExplicitCanonicalDelta(target, operation, changed);

  switch (operation.kind) {
    case "item.create": {
      const candidate = operation.item as unknown;
      if (canonical && isBoardItem(candidate)) {
        target.set(candidate.id, structuredClone(candidate));
        changed.add(candidate.id);
        return;
      }
      const raw = candidate as Omit<BoardItem, "z" | "version" | "createdBy">;
      const item = {
        ...structuredClone(raw),
        z: allocateZ(),
        version,
        createdBy: actorId,
      } as BoardItem;
      target.set(item.id, item);
      changed.add(item.id);
      return;
    }
    case "item.update": {
      const canonicalItem = operation.item as unknown;
      if (canonical && isBoardItem(canonicalItem)) {
        target.set(canonicalItem.id, structuredClone(canonicalItem));
        changed.add(canonicalItem.id);
        return;
      }
      const existing = target.get(operation.itemId);
      if (!existing) throw new Error(`Cannot update missing item ${operation.itemId}.`);
      const next = patchItem(existing, operation.patch, version);
      target.set(existing.id, next);
      changed.add(existing.id);
      return;
    }
    case "item.delete": {
      target.delete(operation.itemId);
      changed.add(operation.itemId);
      return;
    }
    case "item.copy": {
      const canonicalItem = operation.item as unknown;
      if (canonical && isBoardItem(canonicalItem)) {
        target.set(canonicalItem.id, structuredClone(canonicalItem));
        changed.add(canonicalItem.id);
        return;
      }
      const source = target.get(operation.sourceItemId);
      if (!source) throw new Error(`Cannot copy missing item ${operation.sourceItemId}.`);
      const copy = structuredClone(source);
      copy.id = operation.newItemId;
      copy.z = allocateZ();
      copy.version = version;
      copy.createdBy = actorId;
      copy.transform = translateMatrix(
        copy.transform,
        operation.translate.x,
        operation.translate.y,
      );
      if (operation.newGroupId === null) delete copy.groupId;
      else if (operation.newGroupId !== undefined) copy.groupId = operation.newGroupId;
      if (operation.newSectionId === null) delete copy.sectionId;
      else if (operation.newSectionId !== undefined) copy.sectionId = operation.newSectionId;
      target.set(copy.id, copy);
      changed.add(copy.id);
      return;
    }
    case "items.batch": {
      for (const child of operation.operations) {
        applyOperation(
          target,
          child as BatchItemOperation & Record<string, unknown>,
          actorId,
          version,
          changed,
          canonical,
          allocateZ,
        );
      }
      return;
    }
    case "board.clear":
      for (const id of target.keys()) changed.add(id);
      target.clear();
      return;
    case "history.undo":
    case "history.redo":
      return;
  }
}

function applyExplicitCanonicalDelta(
  target: Map<string, BoardItem>,
  operation: Record<string, unknown>,
  changed: Set<string>,
): void {
  const replacements = [operation.items, operation.replacements, operation.upserts]
    .filter(Array.isArray)
    .flat() as unknown[];
  for (const item of replacements) {
    if (!isBoardItem(item)) continue;
    target.set(item.id, structuredClone(item));
    changed.add(item.id);
  }
  const removed = [
    operation.removedItemIds,
    operation.removals,
    operation.deletedItemIds,
    operation.removed,
  ]
    .filter(Array.isArray)
    .flat() as unknown[];
  for (const value of removed) {
    const id =
      typeof value === "string"
        ? value
        : value &&
            typeof value === "object" &&
            typeof (value as { itemId?: unknown }).itemId === "string"
          ? (value as { itemId: string }).itemId
          : null;
    if (!id) continue;
    target.delete(id);
    changed.add(id);
  }
  if (Array.isArray(operation.changes)) {
    for (const value of operation.changes) {
      if (!value || typeof value !== "object") continue;
      const change = value as { kind?: unknown; itemId?: unknown; item?: unknown };
      if (isBoardItem(change.item)) {
        target.set(change.item.id, structuredClone(change.item));
        changed.add(change.item.id);
        continue;
      }
      if (
        typeof change.itemId === "string" &&
        (change.item === null || change.kind === "item.remove")
      ) {
        target.delete(change.itemId);
        changed.add(change.itemId);
      }
    }
  }
}

function patchItem(item: BoardItem, patch: ItemPatch, version: number): BoardItem {
  const next = structuredClone(item) as BoardItem;
  if (patch.transform) next.transform = [...patch.transform] as Matrix;
  if (patch.style) (next as { style: typeof patch.style }).style = structuredClone(patch.style);
  if (patch.geometry) {
    (next as { geometry: typeof patch.geometry }).geometry = structuredClone(patch.geometry);
  }
  if (patch.groupId === null) delete next.groupId;
  else if (patch.groupId !== undefined) next.groupId = patch.groupId;
  if (patch.sectionId === null) delete next.sectionId;
  else if (patch.sectionId !== undefined) next.sectionId = patch.sectionId;
  next.version = version;
  return next;
}

export function operationIds(operation: DurableOperation): Set<string> {
  const ids = new Set<string>();
  const collect = (op: DurableOperation | BatchItemOperation): void => {
    switch (op.kind) {
      case "item.create":
        ids.add(op.item.id);
        break;
      case "item.update":
      case "item.delete":
        ids.add(op.itemId);
        break;
      case "item.copy":
        ids.add(op.sourceItemId);
        ids.add(op.newItemId);
        break;
      case "items.batch":
        op.operations.forEach(collect);
        break;
      default:
        break;
    }
  };
  collect(operation);
  return ids;
}

export function translateMatrix(matrix: Matrix, x: number, y: number): Matrix {
  return [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4] + x, matrix[5] + y];
}

export function itemBounds(item: BoardItem): Bounds {
  const raw = geometryBounds(item);
  const corners: Point[] = [
    [raw.minX, raw.minY],
    [raw.maxX, raw.minY],
    [raw.maxX, raw.maxY],
    [raw.minX, raw.maxY],
  ];
  const transformed = corners.map((point) => transformPoint(point, item.transform));
  const minX = Math.min(...transformed.map((point) => point[0]));
  const minY = Math.min(...transformed.map((point) => point[1]));
  const maxX = Math.max(...transformed.map((point) => point[0]));
  const maxY = Math.max(...transformed.map((point) => point[1]));
  const padding =
    item.kind === "text"
      ? 2
      : item.kind === "sticky" ||
          item.kind === "stamp" ||
          item.kind === "image" ||
          item.kind === "table" ||
          item.kind === "zone" ||
          item.kind === "protractor"
        ? 0
        : (item.style.width / 2) * maximumLinearScale(item.transform);
  return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
}

export function cardinalAnchorPoints(bounds: Bounds): readonly Point[] {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return [
    [centerX, bounds.minY],
    [bounds.maxX, centerY],
    [centerX, bounds.maxY],
    [bounds.minX, centerY],
  ];
}

function transformedCardinalAnchorPoints(
  item: Extract<
    BoardItem,
    { kind: "rectangle" | "ellipse" | "sticky" | "table" | "image" | "zone" }
  >,
): readonly Point[] {
  return cardinalAnchorPoints(geometryBounds(item)).map((point) =>
    transformPoint(point, item.transform),
  );
}

function nearerAnchor(
  current: ConnectorAnchor | undefined,
  candidate: ConnectorAnchor,
  maxDistance: number,
): ConnectorAnchor | undefined {
  if (candidate.distance > maxDistance + 1e-9) return current;
  if (!current) return candidate;
  if (candidate.distance < current.distance - 1e-9) return candidate;
  if (Math.abs(candidate.distance - current.distance) > 1e-9) return current;
  const candidatePriority = anchorPriority(candidate.source);
  const currentPriority = anchorPriority(current.source);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority ? candidate : current;
  }
  if (candidate.z !== current.z) return candidate.z > current.z ? candidate : current;
  if (candidate.itemId !== current.itemId) {
    return candidate.itemId.localeCompare(current.itemId) < 0 ? candidate : current;
  }
  if ((candidate.pathIndex ?? -1) !== (current.pathIndex ?? -1)) {
    return (candidate.pathIndex ?? -1) < (current.pathIndex ?? -1) ? candidate : current;
  }
  return (candidate.segmentIndex ?? -1) < (current.segmentIndex ?? -1) ? candidate : current;
}

function anchorPriority(source: ConnectorAnchor["source"]): number {
  if (source === "endpoint" || source === "protractor-center" || source === "protractor-tick") {
    return 2;
  }
  return source === "edge" ? 1 : 0;
}

function projectPointToSegment(
  point: Point,
  start: Point,
  end: Point,
): { point: Point; distance: number; t: number } {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const t =
    denominator <= 1e-12
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator),
        );
  const projection: Point = [start[0] + t * dx, start[1] + t * dy];
  return { point: projection, distance: pointDistance(point, projection), t };
}

function worldOutlinePaths(
  item: Extract<BoardItem, { kind: "pencil" | "line" | "rectangle" | "ellipse" | "polygon" }>,
): Point[][] {
  return visibleOutlinePaths(
    item.kind as OutlineGeometryKind,
    item.geometry as OutlineGeometry,
  ).map((path) => path.map((point) => transformPoint(point, item.transform)));
}

function lineTerminalIsVisible(item: Extract<BoardItem, { kind: "line" }>): boolean {
  if (!item.geometry.visiblePaths) return true;
  const terminal: Point = [item.geometry.x2, item.geometry.y2];
  return item.geometry.visiblePaths.some(
    (path) => pointsNear(path[0], terminal) || pointsNear(path.at(-1), terminal),
  );
}

function supportsConnectorAnchors(
  item: BoardItem,
): item is Extract<
  BoardItem,
  { kind: "rectangle" | "ellipse" | "sticky" | "table" | "image" | "zone" }
> {
  return (
    item.kind === "rectangle" ||
    item.kind === "ellipse" ||
    item.kind === "sticky" ||
    item.kind === "table" ||
    item.kind === "image" ||
    item.kind === "zone"
  );
}

function geometryBounds(item: BoardItem): Bounds {
  switch (item.kind) {
    case "pencil":
    case "rectangle":
    case "ellipse":
    case "polygon":
      return boundsFromPoints(visibleOutlinePaths(item.kind, item.geometry).flat());
    case "line": {
      let bounds = boundsFromPoints(visibleOutlinePaths("line", item.geometry).flat());
      if (item.style.arrowhead === "arrow" && lineTerminalIsVisible(item)) {
        const points = lineArrowheadPoints(item.geometry, item.style.width);
        if (points) {
          bounds = unionBounds(bounds, boundsFromPoints(points));
        }
      }
      return bounds;
    }
    case "sticky":
    case "image":
    case "zone":
      return boxBounds(item.geometry);
    case "protractor":
      return {
        minX: -item.geometry.radius,
        minY: -item.geometry.radius,
        maxX: item.geometry.radius,
        maxY: 0,
      };
    case "table":
      return tableBounds(item.geometry);
    case "stamp":
      return stampBounds(item.geometry);
    case "text": {
      if (item.geometry.embed === "video") {
        return {
          minX: item.geometry.x,
          minY: item.geometry.y - item.style.fontSize,
          maxX: item.geometry.x + VIDEO_EMBED_WIDTH,
          maxY: item.geometry.y - item.style.fontSize + VIDEO_EMBED_HEIGHT,
        };
      }
      const lines = textLayoutEstimateSource(item.geometry.text, item.style.fontSize).split("\n");
      const estimatedWidth =
        Math.max(1, ...lines.map((line) => [...line].length)) * item.style.fontSize * 0.61;
      const estimatedHeight = Math.max(1, lines.length) * item.style.fontSize * 1.2;
      const measurement = renderedTextMeasurement(item);
      const width = measurement?.width ?? estimatedWidth;
      const height = measurement?.height ?? estimatedHeight;
      return {
        minX: item.geometry.x,
        minY: item.geometry.y - item.style.fontSize,
        maxX: item.geometry.x + width,
        maxY: item.geometry.y - item.style.fontSize + height,
      };
    }
  }
}

function boxBounds(box: BoxGeometry): Bounds {
  return { minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height };
}

function tableBounds(table: TableGeometry): Bounds {
  return {
    minX: table.x,
    minY: table.y,
    maxX: table.x + table.columnWidths.reduce((total, width) => total + width, 0),
    maxY: table.y + table.rowHeights.reduce((total, height) => total + height, 0),
  };
}

function stampBounds(stamp: Extract<BoardItem, { kind: "stamp" }>["geometry"]): Bounds {
  const half = stamp.size / 2;
  return {
    minX: stamp.x - half,
    minY: stamp.y - half,
    maxX: stamp.x + half,
    maxY: stamp.y + half,
  };
}

function preciseHit(item: BoardItem, point: Point, extra: number): boolean {
  const local = inverseTransformPoint(point, item.transform);
  if (!local) return true;
  if (item.kind === "line" || item.kind === "pencil") {
    const threshold = extra + (item.style.width / 2) * maximumLinearScale(item.transform);
    for (const path of worldOutlinePaths(item)) {
      for (let index = 1; index < path.length; index += 1) {
        const start = path[index - 1];
        const end = path[index];
        if (start && end && distanceToSegment(point, start, end) <= threshold) return true;
      }
    }
    if (item.kind !== "line" || item.style.arrowhead !== "arrow" || !lineTerminalIsVisible(item)) {
      return false;
    }
    const arrowhead = lineArrowheadPoints(item.geometry, item.style.width);
    if (!arrowhead) return false;
    const transformed = arrowhead.map((arrowPoint) => transformPoint(arrowPoint, item.transform));
    return (
      distanceToSegment(point, transformed[0] as Point, transformed[1] as Point) <= threshold ||
      distanceToSegment(point, transformed[1] as Point, transformed[2] as Point) <= threshold
    );
  }
  if (item.kind === "protractor") {
    const distance = Math.hypot(local[0], local[1]);
    return (
      distance <= item.geometry.radius + extra &&
      local[1] <= extra &&
      local[1] >= -item.geometry.radius - extra
    );
  }
  if (item.kind === "sticky") {
    return containsPoint(expandBounds(boxBounds(item.geometry), extra), local);
  }
  if (item.kind === "image") {
    return containsPoint(expandBounds(boxBounds(item.geometry), extra), local);
  }
  if (item.kind === "table") {
    return containsPoint(expandBounds(tableBounds(item.geometry), extra), local);
  }
  if (item.kind === "zone") {
    return zoneGeometryContainsPoint(
      item.geometry,
      [local[0], local[1]],
      item.style.fontSize,
      extra,
    );
  }
  if (item.kind === "stamp") {
    return containsPoint(expandBounds(stampBounds(item.geometry), extra), local);
  }
  return true;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const amount = Math.max(
    0,
    Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point[0] - (start[0] + amount * dx), point[1] - (start[1] + amount * dy));
}

function pointDistance(left: Point, right: Point): number {
  return Math.hypot(right[0] - left[0], right[1] - left[1]);
}

function pointsNear(left: Point | undefined, right: Point, epsilon = 1e-7): boolean {
  return Boolean(
    left && Math.abs(left[0] - right[0]) <= epsilon && Math.abs(left[1] - right[1]) <= epsilon,
  );
}

function boundsFromPoints(points: readonly Point[]): Bounds {
  if (points.length === 0) throw new Error("Cannot calculate bounds for an empty point set.");
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  return { minX, minY, maxX, maxY };
}

function maximumLinearScale(matrix: Matrix): number {
  const [a, b, c, d] = matrix;
  const sum = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  const discriminant = Math.max(0, sum * sum - 4 * determinant * determinant);
  return Math.sqrt((sum + Math.sqrt(discriminant)) / 2);
}

function transformPoint(point: Point, matrix: Matrix): Point {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ];
}

function inverseTransformPoint(point: Point, matrix: Matrix): Point | null {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (Math.abs(determinant) < Number.EPSILON) return null;
  const x = point[0] - matrix[4];
  const y = point[1] - matrix[5];
  return [
    (matrix[3] * x - matrix[2] * y) / determinant,
    (-matrix[1] * x + matrix[0] * y) / determinant,
  ];
}

function containsPoint(bounds: Bounds, point: Point): boolean {
  return (
    point[0] >= bounds.minX &&
    point[0] <= bounds.maxX &&
    point[1] >= bounds.minY &&
    point[1] <= bounds.maxY
  );
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount,
  };
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

function canonicalBounds(item: BoardItem): Bounds {
  return canonicalItemBounds({
    ...item,
    transform: [...item.transform],
  } as Parameters<typeof canonicalItemBounds>[0]);
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

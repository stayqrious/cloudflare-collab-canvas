import {
  GeometryValidationError,
  type ItemGeometry,
  type Transform,
  translateTransform,
} from "@collab/geometry";
import {
  type AuthoritativeBatchOperation,
  type AuthoritativeClearOperation,
  type AuthoritativeHistoryOperation,
  type AuthoritativeItemOperation,
  type AuthoritativeOperation,
  assertCanonicalId,
  type BatchItemOperation,
  type BoardItem,
  type CanonicalItemChange,
  canonicalStringify,
  type DurableOperation,
  type ItemEffect,
  type ItemPatch,
  type LogicalItemState,
  MAX_ACTION_PAYLOAD_BYTES,
  MAX_BATCH_OPERATIONS,
  MAX_LIVE_ITEMS,
  MAX_PUBLIC_RESULT_BYTES,
  MAX_SNAPSHOT_BYTES,
  normalizeBoardItem,
  type ProtocolErrorCode,
  ProtocolValidationError,
  type ServerActionFrame,
  utf8Bytes,
  validateDurableOperation,
  validatePlainText,
} from "@collab/protocol";

export interface ItemRecord {
  readonly exists: boolean;
  readonly item: BoardItem;
  readonly stateToken: string;
}

export interface BoardState {
  readonly seq: number;
  readonly nextZ: number;
  readonly items: ReadonlyMap<string, ItemRecord>;
  readonly usedItemIds: ReadonlySet<string>;
}

export interface BoardStateInput {
  seq?: number;
  nextZ?: number;
  items?: readonly BoardItem[];
  records?: ReadonlyMap<string, ItemRecord> | readonly ItemRecord[];
  usedItemIds?: Iterable<string>;
}

export interface StateTokenFactoryInput {
  itemId: string;
  seq: number;
  effectIndex: number;
  beforeStateToken: string;
}

export interface ApplyContext {
  seq: number;
  actorId: string;
  tokenFactory?: (input: StateTokenFactoryInput) => string;
}

export interface ApplyResult {
  readonly state: BoardState;
  readonly operation: AuthoritativeOperation;
  readonly effects: readonly ItemEffect[];
  readonly affectedItemIds: readonly string[];
}

export interface MoveCopyRelationshipItem {
  readonly id: string;
  readonly kind: BoardItem["kind"];
  readonly groupId?: string;
  readonly sectionId?: string;
}

export interface MoveCopyClosureLimitViolation {
  readonly seedItemId: string;
  readonly itemCount: number;
}

/**
 * Finds a Section or explicit-group root whose fixed-point move/copy closure
 * cannot fit in one atomic item batch. Explicit groups expand symmetrically;
 * Sections expand down to their durable members.
 */
export function findMoveCopyClosureLimitViolation(
  items: Iterable<MoveCopyRelationshipItem>,
  limit = MAX_BATCH_OPERATIONS,
): MoveCopyClosureLimitViolation | null {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("The move/copy closure limit must be a positive safe integer.");
  }

  const byId = new Map<string, MoveCopyRelationshipItem>();
  const groupMembers = new Map<string, string[]>();
  const sectionMembers = new Map<string, string[]>();
  const groupSeeds = new Map<string, string>();
  const seeds = new Set<string>();

  for (const item of items) {
    byId.set(item.id, item);
    if (item.kind === "zone") seeds.add(item.id);
    if (item.groupId !== undefined) {
      const members = groupMembers.get(item.groupId) ?? [];
      members.push(item.id);
      groupMembers.set(item.groupId, members);
      if (!groupSeeds.has(item.groupId)) groupSeeds.set(item.groupId, item.id);
    }
    if (item.sectionId !== undefined) {
      const members = sectionMembers.get(item.sectionId) ?? [];
      members.push(item.id);
      sectionMembers.set(item.sectionId, members);
    }
  }
  for (const seed of groupSeeds.values()) seeds.add(seed);

  for (const seedItemId of [...seeds].sort()) {
    const selected = new Set<string>([seedItemId]);
    const pending = [seedItemId];
    for (let index = 0; index < pending.length; index += 1) {
      const itemId = pending[index];
      if (itemId === undefined) continue;
      const item = byId.get(itemId);
      if (item === undefined) continue;
      const related = [
        ...(item.groupId === undefined ? [] : (groupMembers.get(item.groupId) ?? [])),
        ...(item.kind === "zone" ? (sectionMembers.get(item.id) ?? []) : []),
      ];
      for (const relatedItemId of related) {
        if (selected.has(relatedItemId)) continue;
        selected.add(relatedItemId);
        if (selected.size > limit) {
          return { seedItemId, itemCount: selected.size };
        }
        pending.push(relatedItemId);
      }
    }
  }
  return null;
}

export interface ApplyHistoryContext {
  seq: number;
  targetActionId: string;
}

export class BoardCoreError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "BoardCoreError";
  }
}

function coreFail(
  code: ProtocolErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new BoardCoreError(code, message, details);
}

function expectSafeInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    coreFail(
      "INVALID_FRAME",
      `${name} must be a safe integer greater than or equal to ${minimum}.`,
    );
  }
  return value as number;
}

function cloneGeometry(geometry: ItemGeometry): ItemGeometry {
  if ("points" in geometry) {
    return {
      ...geometry,
      points: geometry.points.map(([x, y]) => [x, y]),
      ...(geometry.visiblePaths === undefined
        ? {}
        : {
            visiblePaths: geometry.visiblePaths.map((path) => path.map(([x, y]) => [x, y])),
          }),
    };
  }
  if ("cells" in geometry) {
    return {
      ...geometry,
      columnWidths: [...geometry.columnWidths],
      rowHeights: [...geometry.rowHeights],
      cells: geometry.cells.map((row) => [...row]),
    };
  }
  if ("visiblePaths" in geometry && geometry.visiblePaths !== undefined) {
    return {
      ...geometry,
      visiblePaths: geometry.visiblePaths.map((path) => path.map(([x, y]) => [x, y])),
    };
  }
  return { ...geometry };
}

export function cloneBoardItem(item: BoardItem): BoardItem {
  return {
    ...item,
    style: { ...item.style },
    transform: [...item.transform],
    geometry: cloneGeometry(item.geometry),
  } as BoardItem;
}

function cloneLogicalState(state: LogicalItemState): LogicalItemState {
  return state.exists ? { exists: true, item: cloneBoardItem(state.item) } : { exists: false };
}

function cloneRecord(record: ItemRecord): ItemRecord {
  return {
    exists: record.exists,
    item: cloneBoardItem(record.item),
    stateToken: record.stateToken,
  };
}

function validateStateToken(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    coreFail("INVALID_FRAME", `${name} must be a non-empty string no longer than 256 characters.`);
  }
  return value;
}

export function initialAbsenceToken(itemId: string): string {
  return `absent:${itemId}`;
}

function defaultTokenFactory(input: StateTokenFactoryInput): string {
  return `state:${input.seq}:${input.effectIndex}:${input.itemId}`;
}

function normalizeRecord(record: ItemRecord): ItemRecord {
  if (typeof record.exists !== "boolean") {
    coreFail("INVALID_FRAME", "Record exists must be a boolean.");
  }
  const item = normalizeBoardItem(record.item);
  if (item.id !== record.item.id)
    coreFail("INVALID_FRAME", "Record item ID changed during normalization.");
  return {
    exists: record.exists,
    item,
    stateToken: validateStateToken(record.stateToken, "stateToken"),
  };
}

export function createBoardState(input: BoardStateInput = {}): BoardState {
  const seq = expectSafeInteger(input.seq ?? 0, "seq");
  const records = new Map<string, ItemRecord>();

  if (input.items !== undefined) {
    for (const rawItem of input.items) {
      const item = normalizeBoardItem(rawItem);
      if (records.has(item.id)) coreFail("DUPLICATE_ITEM_ID", `Duplicate item ID ${item.id}.`);
      records.set(item.id, {
        exists: true,
        item,
        stateToken: `snapshot:${item.version}:${item.id}`,
      });
    }
  }

  if (input.records !== undefined) {
    const iterable = input.records instanceof Map ? input.records.values() : input.records;
    for (const rawRecord of iterable) {
      const record = normalizeRecord(rawRecord);
      if (records.has(record.item.id)) {
        coreFail("DUPLICATE_ITEM_ID", `Duplicate item ID ${record.item.id}.`);
      }
      records.set(record.item.id, record);
    }
  }

  const usedItemIds = new Set<string>();
  for (const id of input.usedItemIds ?? []) usedItemIds.add(assertCanonicalId(id));
  for (const id of records.keys()) usedItemIds.add(id);

  const liveItems = [...records.values()].filter((record) => record.exists);
  if (liveItems.length > MAX_LIVE_ITEMS) {
    coreFail("BOARD_LIMIT_REACHED", `A board may contain at most ${MAX_LIVE_ITEMS} live items.`);
  }
  const maximumZ = liveItems.reduce((maximum, record) => Math.max(maximum, record.item.z), 0);
  const nextZ = expectSafeInteger(input.nextZ ?? maximumZ + 1, "nextZ", 1);
  if (nextZ <= maximumZ)
    coreFail("INVALID_FRAME", "nextZ must be greater than every live item z value.");

  return { seq, nextZ, items: records, usedItemIds };
}

export function liveItemsInPaintOrder(state: BoardState): BoardItem[] {
  return [...state.items.values()]
    .filter((record) => record.exists)
    .map((record) => cloneBoardItem(record.item))
    .sort((left, right) => left.z - right.z || left.id.localeCompare(right.id));
}

export function liveItemCount(state: BoardState): number {
  let count = 0;
  for (const record of state.items.values()) if (record.exists) count += 1;
  return count;
}

function requireLiveRecord(records: ReadonlyMap<string, ItemRecord>, itemId: string): ItemRecord {
  const record = records.get(itemId);
  if (record === undefined || !record.exists) {
    coreFail("ITEM_NOT_FOUND", "The requested item does not exist.", { itemId });
  }
  return record;
}

function requireExpectedVersion(record: ItemRecord, expectedVersion: number): void {
  if (record.item.version !== expectedVersion) {
    coreFail("STALE_ITEM", "The item changed before the action was saved.", {
      itemId: record.item.id,
      expectedVersion,
      actualVersion: record.item.version,
    });
  }
}

function geometryMatchesKind(item: BoardItem, geometry: ItemGeometry): boolean {
  switch (item.kind) {
    case "pencil":
      return "points" in geometry;
    case "line":
      return "x1" in geometry;
    case "rectangle":
      return (
        "width" in geometry &&
        !("polygon" in geometry) &&
        !("text" in geometry) &&
        !("title" in geometry) &&
        !("assetId" in geometry) &&
        !("cells" in geometry)
      );
    case "ellipse":
      return (
        "width" in geometry &&
        !("shape" in geometry) &&
        !("polygon" in geometry) &&
        !("text" in geometry) &&
        !("title" in geometry) &&
        !("assetId" in geometry) &&
        !("cells" in geometry)
      );
    case "polygon":
      return "width" in geometry && "polygon" in geometry;
    case "protractor":
      return "radius" in geometry && !("width" in geometry);
    case "text":
      return "text" in geometry && !("width" in geometry);
    case "sticky":
      return (
        "width" in geometry &&
        "text" in geometry &&
        !("title" in geometry) &&
        !("assetId" in geometry) &&
        !("cells" in geometry)
      );
    case "image":
      return "assetId" in geometry;
    case "stamp":
      return "stamp" in geometry;
    case "table":
      return "cells" in geometry;
    case "zone":
      return (
        "width" in geometry &&
        "title" in geometry &&
        !("text" in geometry) &&
        !("assetId" in geometry) &&
        !("cells" in geometry)
      );
  }
}

function validatePatchForItem(item: BoardItem, patch: ItemPatch): void {
  if (patch.style !== undefined) {
    const expectedKind =
      item.kind === "line"
        ? "line"
        : item.kind === "protractor"
          ? "protractor"
          : item.kind === "text"
            ? "text"
            : item.kind === "sticky"
              ? "sticky"
              : item.kind === "image"
                ? "image"
                : item.kind === "stamp"
                  ? "stamp"
                  : item.kind === "table"
                    ? "table"
                    : item.kind === "zone"
                      ? "zone"
                      : "stroke";
    if (patch.style.kind !== expectedKind) {
      coreFail("INVALID_FRAME", `The patch style does not match the stored ${item.kind} item.`);
    }
  }
  if (patch.geometry !== undefined && !geometryMatchesKind(item, patch.geometry)) {
    coreFail("INVALID_FRAME", `The patch geometry does not match the stored ${item.kind} item.`);
  }
  if (item.kind === "image" && patch.geometry !== undefined && "assetId" in patch.geometry) {
    if (
      patch.geometry.assetId !== item.geometry.assetId ||
      patch.geometry.mimeType !== item.geometry.mimeType ||
      patch.geometry.intrinsicWidth !== item.geometry.intrinsicWidth ||
      patch.geometry.intrinsicHeight !== item.geometry.intrinsicHeight
    ) {
      coreFail("INVALID_FRAME", "An image item's immutable asset metadata cannot be changed.");
    }
  }
}

interface MutableApplication {
  records: Map<string, ItemRecord>;
  usedItemIds: Set<string>;
  nextZ: number;
  effects: ItemEffect[];
  publicOperations: AuthoritativeItemOperation[];
  context: ApplyContext;
  tokenFactory: (input: StateTokenFactoryInput) => string;
}

function nextStateToken(
  application: MutableApplication,
  itemId: string,
  beforeToken: string,
): string {
  const token = validateStateToken(
    application.tokenFactory({
      itemId,
      seq: application.context.seq,
      effectIndex: application.effects.length,
      beforeStateToken: beforeToken,
    }),
    "tokenFactory result",
  );
  if (token === beforeToken)
    coreFail("INVALID_FRAME", "A write must advance the private state token.");
  return token;
}

function addEffect(
  application: MutableApplication,
  itemId: string,
  before: LogicalItemState,
  after: LogicalItemState,
  beforeStateToken: string,
  afterStateToken: string,
): void {
  application.effects.push({
    itemId,
    before: cloneLogicalState(before),
    after: cloneLogicalState(after),
    beforeStateToken,
    afterStateToken,
  });
}

function applyCreate(
  application: MutableApplication,
  operation: Extract<BatchItemOperation, { kind: "item.create" }>,
): void {
  const itemId = operation.item.id;
  if (application.usedItemIds.has(itemId)) {
    coreFail("DUPLICATE_ITEM_ID", "An item ID may never be reused.", { itemId });
  }
  const item = normalizeBoardItem({
    ...operation.item,
    z: application.nextZ,
    version: application.context.seq,
    createdBy: application.context.actorId,
  });
  const beforeToken = initialAbsenceToken(itemId);
  const afterToken = nextStateToken(application, itemId, beforeToken);
  application.records.set(itemId, { exists: true, item, stateToken: afterToken });
  application.usedItemIds.add(itemId);
  application.nextZ += 1;
  addEffect(
    application,
    itemId,
    { exists: false },
    { exists: true, item },
    beforeToken,
    afterToken,
  );
  application.publicOperations.push({ kind: "item.create", item: cloneBoardItem(item) });
}

function applyUpdate(
  application: MutableApplication,
  operation: Extract<BatchItemOperation, { kind: "item.update" }>,
): void {
  const record = requireLiveRecord(application.records, operation.itemId);
  requireExpectedVersion(record, operation.expectedVersion);
  validatePatchForItem(record.item, operation.patch);
  const beforeItem = cloneBoardItem(record.item);
  const candidate = {
    ...record.item,
    ...(operation.patch.style === undefined ? {} : { style: operation.patch.style }),
    ...(operation.patch.transform === undefined ? {} : { transform: operation.patch.transform }),
    ...(operation.patch.geometry === undefined ? {} : { geometry: operation.patch.geometry }),
    version: application.context.seq,
  } as Record<string, unknown>;
  if (operation.patch.groupId === null) delete candidate.groupId;
  else if (operation.patch.groupId !== undefined) candidate.groupId = operation.patch.groupId;
  if (operation.patch.sectionId === null) delete candidate.sectionId;
  else if (operation.patch.sectionId !== undefined) candidate.sectionId = operation.patch.sectionId;
  const afterItem = normalizeBoardItem(candidate);
  const afterToken = nextStateToken(application, operation.itemId, record.stateToken);
  application.records.set(operation.itemId, {
    exists: true,
    item: afterItem,
    stateToken: afterToken,
  });
  addEffect(
    application,
    operation.itemId,
    { exists: true, item: beforeItem },
    { exists: true, item: afterItem },
    record.stateToken,
    afterToken,
  );
  application.publicOperations.push({ kind: "item.update", item: cloneBoardItem(afterItem) });
}

function applyDelete(
  application: MutableApplication,
  operation: Extract<BatchItemOperation, { kind: "item.delete" }>,
): void {
  const record = requireLiveRecord(application.records, operation.itemId);
  requireExpectedVersion(record, operation.expectedVersion);
  const beforeItem = cloneBoardItem(record.item);
  const tombstoneItem = cloneBoardItem({
    ...record.item,
    version: application.context.seq,
  } as BoardItem);
  const afterToken = nextStateToken(application, operation.itemId, record.stateToken);
  application.records.set(operation.itemId, {
    exists: false,
    item: tombstoneItem,
    stateToken: afterToken,
  });
  addEffect(
    application,
    operation.itemId,
    { exists: true, item: beforeItem },
    { exists: false },
    record.stateToken,
    afterToken,
  );
  application.publicOperations.push({
    kind: "item.delete",
    itemId: operation.itemId,
    version: application.context.seq,
  });
}

function applyCopy(
  application: MutableApplication,
  operation: Extract<BatchItemOperation, { kind: "item.copy" }>,
): void {
  const source = requireLiveRecord(application.records, operation.sourceItemId);
  requireExpectedVersion(source, operation.expectedVersion);
  if (application.usedItemIds.has(operation.newItemId)) {
    coreFail("DUPLICATE_ITEM_ID", "An item ID may never be reused.", {
      itemId: operation.newItemId,
    });
  }
  let transformed: Transform;
  try {
    transformed = translateTransform(
      source.item.transform,
      operation.translate.x,
      operation.translate.y,
    );
  } catch (error) {
    if (error instanceof GeometryValidationError) {
      coreFail("INVALID_FRAME", error.message);
    }
    throw error;
  }
  const copyCandidate = {
    ...source.item,
    id: operation.newItemId,
    z: application.nextZ,
    version: application.context.seq,
    createdBy: application.context.actorId,
    transform: transformed,
  } as Record<string, unknown>;
  if (operation.newGroupId === null) delete copyCandidate.groupId;
  else if (operation.newGroupId !== undefined) copyCandidate.groupId = operation.newGroupId;
  if (operation.newSectionId === null) delete copyCandidate.sectionId;
  else if (operation.newSectionId !== undefined) copyCandidate.sectionId = operation.newSectionId;
  const copiedItem = normalizeBoardItem(copyCandidate);
  const beforeToken = initialAbsenceToken(operation.newItemId);
  const afterToken = nextStateToken(application, operation.newItemId, beforeToken);
  application.records.set(operation.newItemId, {
    exists: true,
    item: copiedItem,
    stateToken: afterToken,
  });
  application.usedItemIds.add(operation.newItemId);
  application.nextZ += 1;
  addEffect(
    application,
    operation.newItemId,
    { exists: false },
    { exists: true, item: copiedItem },
    beforeToken,
    afterToken,
  );
  application.publicOperations.push({
    kind: "item.copy",
    sourceItemId: operation.sourceItemId,
    item: cloneBoardItem(copiedItem),
  });
}

function applyItemOperation(application: MutableApplication, operation: BatchItemOperation): void {
  switch (operation.kind) {
    case "item.create":
      applyCreate(application, operation);
      return;
    case "item.update":
      applyUpdate(application, operation);
      return;
    case "item.delete":
      applyDelete(application, operation);
      return;
    case "item.copy":
      applyCopy(application, operation);
      return;
  }
}

function assertResultSize(operation: AuthoritativeOperation, effects: readonly ItemEffect[]): void {
  if (utf8Bytes(canonicalStringify(operation)).byteLength > MAX_PUBLIC_RESULT_BYTES) {
    coreFail(
      "BOARD_LIMIT_REACHED",
      "The authoritative action result is too large to replay safely.",
    );
  }
  if (utf8Bytes(canonicalStringify({ operation, effects })).byteLength > MAX_ACTION_PAYLOAD_BYTES) {
    coreFail("BOARD_LIMIT_REACHED", "The action and undo effects are too large to store safely.");
  }
}

function finishNormalApplication(
  application: MutableApplication,
  operation: AuthoritativeOperation,
): ApplyResult {
  let liveCount = 0;
  for (const record of application.records.values()) if (record.exists) liveCount += 1;
  if (liveCount > MAX_LIVE_ITEMS) {
    coreFail("BOARD_LIMIT_REACHED", `A board may contain at most ${MAX_LIVE_ITEMS} live items.`);
  }
  assertResultSize(operation, application.effects);
  const state: BoardState = {
    seq: application.context.seq,
    nextZ: application.nextZ,
    items: application.records,
    usedItemIds: application.usedItemIds,
  };
  return {
    state,
    operation,
    effects: application.effects.map((effect) => ({
      ...effect,
      before: cloneLogicalState(effect.before),
      after: cloneLogicalState(effect.after),
    })),
    affectedItemIds: application.effects.map((effect) => effect.itemId),
  };
}

function applyClear(
  state: BoardState,
  expectedBoardSeq: number,
  context: ApplyContext,
): ApplyResult {
  if (expectedBoardSeq !== state.seq) {
    coreFail("STALE_BOARD", "The board changed before it could be cleared.", {
      expectedBoardSeq,
      actualBoardSeq: state.seq,
    });
  }
  const records = new Map([...state.items].map(([id, record]) => [id, cloneRecord(record)]));
  const effects: ItemEffect[] = [];
  const removed: Array<{ itemId: string; version: number }> = [];
  const tokenFactory = context.tokenFactory ?? defaultTokenFactory;
  const live = [...records.values()]
    .filter((record) => record.exists)
    .sort((left, right) => left.item.z - right.item.z || left.item.id.localeCompare(right.item.id));
  for (const record of live) {
    const afterToken = validateStateToken(
      tokenFactory({
        itemId: record.item.id,
        seq: context.seq,
        effectIndex: effects.length,
        beforeStateToken: record.stateToken,
      }),
      "tokenFactory result",
    );
    if (afterToken === record.stateToken)
      coreFail("INVALID_FRAME", "A clear must advance state tokens.");
    const beforeItem = cloneBoardItem(record.item);
    records.set(record.item.id, {
      exists: false,
      item: cloneBoardItem({ ...record.item, version: context.seq } as BoardItem),
      stateToken: afterToken,
    });
    effects.push({
      itemId: record.item.id,
      before: { exists: true, item: beforeItem },
      after: { exists: false },
      beforeStateToken: record.stateToken,
      afterStateToken: afterToken,
    });
    removed.push({ itemId: record.item.id, version: context.seq });
  }
  const operation: AuthoritativeClearOperation = { kind: "board.clear", removed };
  if (utf8Bytes(canonicalStringify(operation)).byteLength > MAX_PUBLIC_RESULT_BYTES) {
    coreFail("BOARD_LIMIT_REACHED", "The clear result is too large to replay safely.");
  }
  return {
    state: {
      seq: context.seq,
      nextZ: state.nextZ,
      items: records,
      usedItemIds: new Set(state.usedItemIds),
    },
    operation,
    effects,
    affectedItemIds: removed.map((entry) => entry.itemId),
  };
}

export function applyDurableOperation(
  state: BoardState,
  rawOperation: DurableOperation,
  context: ApplyContext,
): ApplyResult {
  if (!Number.isSafeInteger(context.seq) || context.seq !== state.seq + 1) {
    coreFail("STALE_BOARD", "The action sequence must be the board's next sequence.", {
      currentSeq: state.seq,
      requestedSeq: context.seq,
    });
  }
  try {
    assertCanonicalId(context.actorId, "$context.actorId");
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new BoardCoreError(error.code, error.message, error.details);
    }
    throw error;
  }

  let operation: DurableOperation;
  try {
    operation = validateDurableOperation(rawOperation);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new BoardCoreError(error.code, error.message, error.details);
    }
    throw error;
  }
  if (operation.kind === "history.undo" || operation.kind === "history.redo") {
    coreFail(
      "INVALID_FRAME",
      "History operations require stored effects; use applyUndoEffects or applyRedoEffects.",
    );
  }
  if (operation.kind === "board.clear") {
    return applyClear(state, operation.expectedBoardSeq, context);
  }

  const application: MutableApplication = {
    records: new Map([...state.items].map(([id, record]) => [id, cloneRecord(record)])),
    usedItemIds: new Set(state.usedItemIds),
    nextZ: state.nextZ,
    effects: [],
    publicOperations: [],
    context,
    tokenFactory: context.tokenFactory ?? defaultTokenFactory,
  };
  if (operation.kind === "items.batch") {
    for (const child of operation.operations) applyItemOperation(application, child);
    const authoritative: AuthoritativeBatchOperation = {
      kind: "items.batch",
      operations: application.publicOperations,
    };
    return finishNormalApplication(application, authoritative);
  }
  applyItemOperation(application, operation);
  const authoritative = application.publicOperations[0];
  if (authoritative === undefined) {
    coreFail("INTERNAL_ERROR", "The reducer did not produce an authoritative item operation.");
  }
  return finishNormalApplication(application, authoritative);
}

function normalizeEffectState(
  value: LogicalItemState,
  itemId: string,
  label: string,
): LogicalItemState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    coreFail("INVALID_FRAME", `${label} effect state is invalid.`);
  }
  const keys = Object.keys(value);
  if (value.exists === false) {
    if (keys.length !== 1 || keys[0] !== "exists") {
      coreFail("INVALID_FRAME", `${label} absent effect state contains unknown fields.`);
    }
    return { exists: false };
  }
  if (value.exists !== true || !("item" in value)) {
    coreFail("INVALID_FRAME", `${label} effect state is invalid.`);
  }
  if (keys.length !== 2 || !keys.includes("exists") || !keys.includes("item")) {
    coreFail("INVALID_FRAME", `${label} present effect state contains unknown fields.`);
  }
  const item = normalizeBoardItem(value.item);
  if (item.id !== itemId)
    coreFail("INVALID_FRAME", `${label} effect item ID does not match its effect.`);
  return { exists: true, item };
}

function imageAssetMetadataMatches(left: BoardItem, right: BoardItem): boolean {
  return (
    left.kind === "image" &&
    right.kind === "image" &&
    left.geometry.assetId === right.geometry.assetId &&
    left.geometry.mimeType === right.geometry.mimeType &&
    left.geometry.intrinsicWidth === right.geometry.intrinsicWidth &&
    left.geometry.intrinsicHeight === right.geometry.intrinsicHeight
  );
}

function validateImageHistoryTransition(
  before: LogicalItemState,
  after: LogicalItemState,
  label: string,
): void {
  if (!before.exists || !after.exists) return;
  if (before.item.kind !== "image" && after.item.kind !== "image") return;
  if (!imageAssetMetadataMatches(before.item, after.item)) {
    coreFail("INVALID_FRAME", `${label} changes immutable image asset metadata.`);
  }
}

function validateImageHistoryRestoration(current: BoardItem, target: BoardItem): void {
  if (current.kind !== "image" && target.kind !== "image") return;
  if (!imageAssetMetadataMatches(current, target)) {
    coreFail("INVALID_FRAME", "History cannot restore changed immutable image asset metadata.");
  }
}

function normalizeEffects(rawEffects: readonly ItemEffect[]): ItemEffect[] {
  if (!Array.isArray(rawEffects) || rawEffects.length === 0) {
    coreFail("INVALID_FRAME", "History effects must be a non-empty array.");
  }
  const seen = new Set<string>();
  return rawEffects.map((rawEffect, index) => {
    if (rawEffect === null || typeof rawEffect !== "object" || Array.isArray(rawEffect)) {
      coreFail("INVALID_FRAME", `History effect ${index} is invalid.`);
    }
    const keys = Object.keys(rawEffect);
    const allowed = new Set(["itemId", "before", "after", "beforeStateToken", "afterStateToken"]);
    if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
      coreFail("INVALID_FRAME", `History effect ${index} contains unknown or missing fields.`);
    }
    const itemId = assertCanonicalId(rawEffect.itemId, `$effects[${index}].itemId`);
    if (seen.has(itemId))
      coreFail("INVALID_FRAME", "History effects may contain each item only once.");
    seen.add(itemId);
    const before = normalizeEffectState(rawEffect.before, itemId, "before");
    const after = normalizeEffectState(rawEffect.after, itemId, "after");
    validateImageHistoryTransition(before, after, `History effect ${index}`);
    return {
      itemId,
      before,
      after,
      beforeStateToken: validateStateToken(rawEffect.beforeStateToken, "beforeStateToken"),
      afterStateToken: validateStateToken(rawEffect.afterStateToken, "afterStateToken"),
    };
  });
}

function applyHistoryEffects(
  state: BoardState,
  rawEffects: readonly ItemEffect[],
  context: ApplyHistoryContext,
  direction: "undo" | "redo",
): ApplyResult {
  if (!Number.isSafeInteger(context.seq) || context.seq !== state.seq + 1) {
    coreFail("STALE_BOARD", "The history action sequence must be the board's next sequence.");
  }
  assertCanonicalId(context.targetActionId, "$context.targetActionId");
  const effects = normalizeEffects(rawEffects);
  const expectedTokenKey = direction === "undo" ? "afterStateToken" : "beforeStateToken";
  for (const effect of effects) {
    const current = state.items.get(effect.itemId);
    if (current === undefined || current.stateToken !== effect[expectedTokenKey]) {
      coreFail("UNDO_CONFLICT", "A collaborator changed an affected item after this action.", {
        itemId: effect.itemId,
      });
    }
  }
  const records = new Map([...state.items].map(([id, record]) => [id, cloneRecord(record)]));
  const changes: CanonicalItemChange[] = [];
  for (const effect of effects) {
    const targetState = direction === "undo" ? effect.before : effect.after;
    const targetToken = direction === "undo" ? effect.beforeStateToken : effect.afterStateToken;
    const current = records.get(effect.itemId);
    if (current === undefined) {
      coreFail("INTERNAL_ERROR", "A validated history item disappeared during reduction.");
    }
    if (targetState.exists) {
      validateImageHistoryRestoration(current.item, targetState.item);
      const restored = normalizeBoardItem({ ...targetState.item, version: context.seq });
      records.set(effect.itemId, { exists: true, item: restored, stateToken: targetToken });
      changes.push({ kind: "item.replace", item: cloneBoardItem(restored) });
    } else {
      records.set(effect.itemId, {
        exists: false,
        item: cloneBoardItem({ ...current.item, version: context.seq } as BoardItem),
        stateToken: targetToken,
      });
      changes.push({ kind: "item.remove", itemId: effect.itemId, version: context.seq });
    }
  }
  let liveCount = 0;
  for (const record of records.values()) if (record.exists) liveCount += 1;
  if (liveCount > MAX_LIVE_ITEMS) {
    coreFail("BOARD_LIMIT_REACHED", `A board may contain at most ${MAX_LIVE_ITEMS} live items.`);
  }
  const operation: AuthoritativeHistoryOperation = {
    kind: direction === "undo" ? "history.undo" : "history.redo",
    targetActionId: context.targetActionId,
    changes,
  };
  assertResultSize(operation, effects);
  return {
    state: {
      seq: context.seq,
      nextZ: state.nextZ,
      items: records,
      usedItemIds: new Set(state.usedItemIds),
    },
    operation,
    effects,
    affectedItemIds: effects.map((effect) => effect.itemId),
  };
}

export function applyUndoEffects(
  state: BoardState,
  effects: readonly ItemEffect[],
  context: ApplyHistoryContext,
): ApplyResult {
  return applyHistoryEffects(state, effects, context, "undo");
}

export function applyRedoEffects(
  state: BoardState,
  effects: readonly ItemEffect[],
  context: ApplyHistoryContext,
): ApplyResult {
  return applyHistoryEffects(state, effects, context, "redo");
}

export function applyAuthoritativeOperation(
  currentItems: ReadonlyMap<string, BoardItem>,
  operation: AuthoritativeOperation,
): Map<string, BoardItem> {
  const items = new Map([...currentItems].map(([id, item]) => [id, cloneBoardItem(item)]));
  const applyItem = (itemOperation: AuthoritativeItemOperation): void => {
    switch (itemOperation.kind) {
      case "item.create":
      case "item.update":
        items.set(itemOperation.item.id, normalizeBoardItem(itemOperation.item));
        break;
      case "item.copy":
        items.set(itemOperation.item.id, normalizeBoardItem(itemOperation.item));
        break;
      case "item.delete":
        items.delete(itemOperation.itemId);
        break;
    }
  };
  switch (operation.kind) {
    case "item.create":
    case "item.update":
    case "item.delete":
    case "item.copy":
      applyItem(operation);
      break;
    case "items.batch":
      for (const child of operation.operations) applyItem(child);
      break;
    case "history.undo":
    case "history.redo":
      for (const change of operation.changes) {
        if (change.kind === "item.replace")
          items.set(change.item.id, normalizeBoardItem(change.item));
        else items.delete(change.itemId);
      }
      break;
    case "board.clear":
      for (const removal of operation.removed) items.delete(removal.itemId);
      break;
  }
  return items;
}

export interface AuthoritativeClientState {
  readonly seq: number;
  readonly items: ReadonlyMap<string, BoardItem>;
}

export function applyServerAction(
  state: AuthoritativeClientState,
  action: ServerActionFrame,
): AuthoritativeClientState {
  if (action.seq !== state.seq + 1) {
    coreFail(
      "REPLAY_UNAVAILABLE",
      "The authoritative action sequence contains a duplicate or gap.",
      {
        expectedSeq: state.seq + 1,
        actualSeq: action.seq,
      },
    );
  }
  return { seq: action.seq, items: applyAuthoritativeOperation(state.items, action.op) };
}

export interface CanonicalSnapshotSettings {
  title: string;
}

export interface CanonicalSnapshot {
  format: "cf-whiteboard-json";
  version: 1;
  boardId: string;
  seq: number;
  createdAt: number;
  settings: CanonicalSnapshotSettings;
  items: BoardItem[];
}

export interface CanonicalSnapshotInput {
  boardId: string;
  seq: number;
  createdAt: number;
  settings: CanonicalSnapshotSettings;
  items: readonly BoardItem[];
}

export interface CanonicalSnapshotByteParts extends Omit<CanonicalSnapshotInput, "items"> {
  itemCount: number;
  itemBytes: number;
}

function canonicalTextFormat(
  style: Pick<
    Extract<BoardItem["style"], { kind: "text" | "sticky" | "table" | "zone" }>,
    "fontFamily" | "fontWeight" | "fontStyle" | "textDecoration"
  >,
) {
  return {
    ...(style.fontFamily === undefined ? {} : { fontFamily: style.fontFamily }),
    ...(style.fontWeight === undefined ? {} : { fontWeight: style.fontWeight }),
    ...(style.fontStyle === undefined ? {} : { fontStyle: style.fontStyle }),
    ...(style.textDecoration === undefined ? {} : { textDecoration: style.textDecoration }),
  };
}

function canonicalItem(item: BoardItem): BoardItem {
  const normalized = normalizeBoardItem(item);
  const style =
    normalized.style.kind === "stroke"
      ? {
          kind: "stroke" as const,
          color: normalized.style.color,
          width: normalized.style.width,
          opacity: normalized.style.opacity,
        }
      : normalized.style.kind === "line"
        ? {
            kind: "line" as const,
            color: normalized.style.color,
            width: normalized.style.width,
            opacity: normalized.style.opacity,
            arrowhead: normalized.style.arrowhead,
          }
        : normalized.style.kind === "protractor"
          ? {
              kind: "protractor" as const,
              color: normalized.style.color,
              opacity: normalized.style.opacity,
            }
          : normalized.style.kind === "text"
            ? {
                kind: "text" as const,
                color: normalized.style.color,
                fontSize: normalized.style.fontSize,
                fontFamily: normalized.style.fontFamily,
                ...canonicalTextFormat(normalized.style),
                opacity: normalized.style.opacity,
              }
            : normalized.style.kind === "sticky"
              ? {
                  kind: "sticky" as const,
                  fill: normalized.style.fill,
                  textColor: normalized.style.textColor,
                  fontSize: normalized.style.fontSize,
                  ...canonicalTextFormat(normalized.style),
                  opacity: normalized.style.opacity,
                }
              : normalized.style.kind === "image"
                ? {
                    kind: "image" as const,
                    opacity: normalized.style.opacity,
                    radius: normalized.style.radius,
                  }
                : normalized.style.kind === "stamp"
                  ? {
                      kind: "stamp" as const,
                      color: normalized.style.color,
                      opacity: normalized.style.opacity,
                    }
                  : normalized.style.kind === "table"
                    ? {
                        kind: "table" as const,
                        borderColor: normalized.style.borderColor,
                        fill: normalized.style.fill,
                        headerFill: normalized.style.headerFill,
                        textColor: normalized.style.textColor,
                        fontSize: normalized.style.fontSize,
                        ...canonicalTextFormat(normalized.style),
                        opacity: normalized.style.opacity,
                      }
                    : {
                        kind: "zone" as const,
                        borderColor: normalized.style.borderColor,
                        fill: normalized.style.fill,
                        textColor: normalized.style.textColor,
                        fontSize: normalized.style.fontSize,
                        ...canonicalTextFormat(normalized.style),
                        opacity: normalized.style.opacity,
                      };
  const geometry =
    normalized.kind === "pencil"
      ? {
          points: normalized.geometry.points.map(([x, y]) => [x, y] as [number, number]),
          ...(normalized.geometry.visiblePaths === undefined
            ? {}
            : {
                visiblePaths: normalized.geometry.visiblePaths.map((path) =>
                  path.map(([x, y]) => [x, y] as [number, number]),
                ),
              }),
        }
      : normalized.kind === "line"
        ? {
            x1: normalized.geometry.x1,
            y1: normalized.geometry.y1,
            x2: normalized.geometry.x2,
            y2: normalized.geometry.y2,
            ...(normalized.geometry.visiblePaths === undefined
              ? {}
              : {
                  visiblePaths: normalized.geometry.visiblePaths.map((path) =>
                    path.map(([x, y]) => [x, y] as [number, number]),
                  ),
                }),
          }
        : normalized.kind === "polygon"
          ? {
              x: normalized.geometry.x,
              y: normalized.geometry.y,
              width: normalized.geometry.width,
              height: normalized.geometry.height,
              polygon: normalized.geometry.polygon,
              ...(normalized.geometry.visiblePaths === undefined
                ? {}
                : {
                    visiblePaths: normalized.geometry.visiblePaths.map((path) =>
                      path.map(([x, y]) => [x, y] as [number, number]),
                    ),
                  }),
            }
          : normalized.kind === "protractor"
            ? { radius: normalized.geometry.radius }
            : normalized.kind === "text"
              ? {
                  x: normalized.geometry.x,
                  y: normalized.geometry.y,
                  text: normalized.geometry.text,
                  ...(normalized.geometry.embed === undefined
                    ? {}
                    : { embed: normalized.geometry.embed }),
                }
              : normalized.kind === "sticky"
                ? {
                    x: normalized.geometry.x,
                    y: normalized.geometry.y,
                    width: normalized.geometry.width,
                    height: normalized.geometry.height,
                    text: normalized.geometry.text,
                  }
                : normalized.kind === "image"
                  ? {
                      x: normalized.geometry.x,
                      y: normalized.geometry.y,
                      width: normalized.geometry.width,
                      height: normalized.geometry.height,
                      assetId: normalized.geometry.assetId,
                      ...(normalized.geometry.alt === undefined
                        ? {}
                        : { alt: normalized.geometry.alt }),
                      mimeType: normalized.geometry.mimeType,
                      intrinsicWidth: normalized.geometry.intrinsicWidth,
                      intrinsicHeight: normalized.geometry.intrinsicHeight,
                    }
                  : normalized.kind === "stamp"
                    ? {
                        x: normalized.geometry.x,
                        y: normalized.geometry.y,
                        size: normalized.geometry.size,
                        stamp: normalized.geometry.stamp,
                      }
                    : normalized.kind === "zone"
                      ? {
                          x: normalized.geometry.x,
                          y: normalized.geometry.y,
                          width: normalized.geometry.width,
                          height: normalized.geometry.height,
                          title: normalized.geometry.title,
                          ...(normalized.geometry.locked === true ? { locked: true } : {}),
                        }
                      : normalized.kind === "table"
                        ? {
                            x: normalized.geometry.x,
                            y: normalized.geometry.y,
                            columnWidths: [...normalized.geometry.columnWidths],
                            rowHeights: [...normalized.geometry.rowHeights],
                            cells: normalized.geometry.cells.map((row) => [...row]),
                            ...(normalized.geometry.headerRow === undefined
                              ? {}
                              : { headerRow: normalized.geometry.headerRow }),
                          }
                        : normalized.kind === "rectangle"
                          ? {
                              x: normalized.geometry.x,
                              y: normalized.geometry.y,
                              width: normalized.geometry.width,
                              height: normalized.geometry.height,
                              shape: normalized.geometry.shape,
                              ...(normalized.geometry.visiblePaths === undefined
                                ? {}
                                : {
                                    visiblePaths: normalized.geometry.visiblePaths.map((path) =>
                                      path.map(([x, y]) => [x, y] as [number, number]),
                                    ),
                                  }),
                            }
                          : {
                              x: normalized.geometry.x,
                              y: normalized.geometry.y,
                              width: normalized.geometry.width,
                              height: normalized.geometry.height,
                              ...(normalized.geometry.visiblePaths === undefined
                                ? {}
                                : {
                                    visiblePaths: normalized.geometry.visiblePaths.map((path) =>
                                      path.map(([x, y]) => [x, y] as [number, number]),
                                    ),
                                  }),
                            };
  return {
    id: normalized.id,
    ...(normalized.groupId === undefined ? {} : { groupId: normalized.groupId }),
    ...(normalized.sectionId === undefined ? {} : { sectionId: normalized.sectionId }),
    kind: normalized.kind,
    z: normalized.z,
    version: normalized.version,
    createdBy: normalized.createdBy,
    ...(normalized.assistedBy === undefined ? {} : { assistedBy: normalized.assistedBy }),
    style,
    transform: [...normalized.transform],
    geometry,
  } as BoardItem;
}

export function canonicalSnapshotItemByteLength(item: BoardItem): number {
  return utf8Bytes(JSON.stringify(canonicalItem(item))).byteLength;
}

export function canonicalSnapshotByteLengthFromParts(input: CanonicalSnapshotByteParts): number {
  const itemCount = expectSafeInteger(input.itemCount, "snapshot itemCount");
  const itemBytes = expectSafeInteger(input.itemBytes, "snapshot itemBytes");
  if (itemCount > MAX_LIVE_ITEMS) {
    coreFail("BOARD_LIMIT_REACHED", `A snapshot may contain at most ${MAX_LIVE_ITEMS} items.`);
  }
  const envelope = createCanonicalSnapshot({
    boardId: input.boardId,
    seq: input.seq,
    createdAt: input.createdAt,
    settings: input.settings,
    items: [],
  });
  const envelopeBytes = utf8Bytes(JSON.stringify(envelope)).byteLength;
  const total = envelopeBytes + itemBytes + Math.max(0, itemCount - 1);
  if (!Number.isSafeInteger(total)) {
    coreFail("BOARD_LIMIT_REACHED", "Snapshot byte accounting exceeds the safe integer range.");
  }
  return total;
}

export function createCanonicalSnapshot(input: CanonicalSnapshotInput): CanonicalSnapshot {
  const boardId = assertCanonicalId(input.boardId, "$snapshot.boardId");
  const seq = expectSafeInteger(input.seq, "snapshot seq");
  const createdAt = expectSafeInteger(input.createdAt, "snapshot createdAt");
  if (input.settings === null || typeof input.settings !== "object") {
    coreFail("INVALID_FRAME", "Snapshot settings must be an object.");
  }
  const title = validatePlainText(input.settings.title, "$snapshot.settings.title");
  if (Array.from(title).length > 200)
    coreFail("INVALID_FRAME", "Board titles may contain at most 200 characters.");
  const items = input.items
    .map(canonicalItem)
    .sort((left, right) => left.z - right.z || left.id.localeCompare(right.id));
  const ids = new Set<string>();
  const zValues = new Set<number>();
  for (const item of items) {
    if (ids.has(item.id)) coreFail("DUPLICATE_ITEM_ID", `Duplicate snapshot item ID ${item.id}.`);
    if (zValues.has(item.z)) coreFail("INVALID_FRAME", `Duplicate snapshot paint order ${item.z}.`);
    ids.add(item.id);
    zValues.add(item.z);
  }
  if (items.length > MAX_LIVE_ITEMS) {
    coreFail("BOARD_LIMIT_REACHED", `A snapshot may contain at most ${MAX_LIVE_ITEMS} items.`);
  }
  return {
    format: "cf-whiteboard-json",
    version: 1,
    boardId,
    seq,
    createdAt,
    settings: { title },
    items,
  };
}

export function serializeCanonicalSnapshot(input: CanonicalSnapshotInput): string {
  const serialized = JSON.stringify(createCanonicalSnapshot(input));
  if (utf8Bytes(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
    coreFail("BOARD_LIMIT_REACHED", "The canonical snapshot exceeds the 20 MiB limit.");
  }
  return serialized;
}

export function canonicalSnapshotBytes(input: CanonicalSnapshotInput): Uint8Array {
  return utf8Bytes(serializeCanonicalSnapshot(input));
}

export function snapshotInputFromState(
  state: BoardState,
  metadata: Omit<CanonicalSnapshotInput, "seq" | "items">,
): CanonicalSnapshotInput {
  return {
    ...metadata,
    seq: state.seq,
    items: liveItemsInPaintOrder(state),
  };
}

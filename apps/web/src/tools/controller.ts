import { findMoveCopyClosureLimitViolation } from "@collab/board-core";
import { boundsContain, transformPoint } from "@collab/geometry";
import { MAX_BATCH_OPERATIONS } from "@collab/protocol";
import { videoEmbedFromText } from "../board/links";
import type { BoardModel, Bounds, ConnectorAnchor } from "../board/model";
import { itemBounds, translateMatrix } from "../board/model";
import type { BoardRenderer } from "../board/renderer";
import { STICKY_COLOR_VALUES, UI_COLORS } from "../palette";
import type {
  BatchItemOperation,
  BoardItem,
  BoxGeometry,
  DurableOperation,
  ImageGeometry,
  LineArrowhead,
  LineGeometry,
  LineStyle,
  Matrix,
  NewBoardItem,
  Point,
  PolygonGeometry,
  PolygonKind,
  ProtractorStyle,
  RectangleGeometry,
  StampKind,
  StampStyle,
  StickyGeometry,
  StickyStyle,
  StrokeStyle,
  TableGeometry,
  TextGeometry,
  ToolName,
  VisiblePaths,
  ZoneGeometry,
} from "../types";
import { createId, roundBoard } from "../types";
import {
  buildGroupBatch,
  buildGroupedSectionCopyBatch,
  buildUngroupBatch,
  effectiveMoveCopyClosure,
  explicitGroupClosure,
  GroupingError,
} from "./grouping";
import {
  buildCapturedStructuredResizeOperation,
  type CapturedStructuredResize,
  MIN_RESIZED_ZONE_HEIGHT,
  MIN_RESIZED_ZONE_WIDTH,
  resizedStructuredGeometry,
  type StructuredResizeHandle,
  structuredResizeGrabOffset,
} from "./resize";
import {
  eraseStrokeItem,
  isPartiallyErasableItem,
  type PartiallyErasableItem,
} from "./stroke-erase";
import {
  buildCapturedObjectTransformOperation,
  type CapturedObjectTransform,
  isRotatableObjectItem,
  isScalableObjectItem,
  objectLocalCenter,
  objectScaleGrabOffset,
  type RotatableObjectItem,
  rotatedMatrixAroundLocalPoint,
  type ScalableObjectItem,
  scaledObjectMatrix,
} from "./transform";

export type StyleState = {
  color: string;
  width: number;
  opacity: number;
  lineArrowhead: LineArrowhead;
  shapeVariant: ShapeVariant;
  fontSize: number;
  stickyFill: string;
  stickyTextColor: string;
  stickyFontSize: number;
  stickyOpacity: number;
  stampKind: StampKind;
  stampColor: string;
  stampOpacity: number;
  tableRows: number;
  tableColumns: number;
  tableHeaderRow: boolean;
};

export type ShapeVariant =
  | "square"
  | "rectangle"
  | "triangle"
  | "rhombus"
  | "pentagon"
  | "hexagon"
  | "circle";

type ShapeTool = "line" | "rectangle" | "ellipse" | "polygon";

export const DEFAULT_STICKY_WIDTH = 180;
export const DEFAULT_STICKY_HEIGHT = 140;
export const DEFAULT_STAMP_SIZE = 36;
export const MIN_RESIZED_STICKY_WIDTH = 96;
export const MIN_RESIZED_STICKY_HEIGHT = 72;
export const MIN_RESIZED_IMAGE_SIDE = 72;
export const MOUSE_SELECTION_PADDING_CSS_PX = 5;
export const TOUCH_SELECTION_PADDING_CSS_PX = 16;
export const DEFAULT_TABLE_COLUMNS = 3;
export const DEFAULT_TABLE_ROWS = 3;
export const DEFAULT_TABLE_COLUMN_WIDTH = 120;
export const DEFAULT_TABLE_ROW_HEIGHT = 48;
export const DEFAULT_ZONE_WIDTH = 520;
export const DEFAULT_ZONE_HEIGHT = 320;
export const CONNECTOR_SNAP_RADIUS_CSS_PX = 16;
export const CONNECTOR_SNAP_RELEASE_RADIUS_CSS_PX = 24;
export const DEFAULT_PROTRACTOR_RADIUS = 160;

const TOOL_SHORTCUTS: Partial<Record<string, ToolName>> = {
  v: "select",
  p: "pencil",
  l: "line",
  r: "rectangle",
  o: "ellipse",
  t: "text",
  n: "sticky",
  k: "stamp",
  i: "image",
  g: "table",
  z: "zone",
  e: "eraser",
  u: "protractor",
  h: "pan",
};

const SHORTCUT_DRAW_TOOLS = new Set<ToolName>([
  "pencil",
  "line",
  "rectangle",
  "ellipse",
  "polygon",
  "text",
  "sticky",
  "stamp",
  "image",
  "table",
  "zone",
  "eraser",
  "protractor",
]);

export function toolFromShortcut(key: string, canDraw: boolean): ToolName | undefined {
  const tool = TOOL_SHORTCUTS[key.toLowerCase()];
  return tool && (!SHORTCUT_DRAW_TOOLS.has(tool) || canDraw) ? tool : undefined;
}

export function stickyTapMoveThreshold(pointerType: string, zoom: number): number {
  return (pointerType === "touch" ? 10 : 3) / Math.max(0.1, zoom);
}

export function selectionHitPadding(pointerType: string, zoom: number): number {
  const cssPixels =
    pointerType === "touch" ? TOUCH_SELECTION_PADDING_CSS_PX : MOUSE_SELECTION_PADDING_CSS_PX;
  return cssPixels / Math.max(0.1, zoom);
}

export function tapAdjustedMovePoint(
  start: Point,
  current: Point,
  pointerType: string,
  zoom: number,
): Point {
  return Math.hypot(current[0] - start[0], current[1] - start[1]) <=
    stickyTapMoveThreshold(pointerType, zoom)
    ? start
    : current;
}

export function lineCreationReleaseAction(
  phase: "first" | "second",
  start: Point,
  current: Point,
  pointerType: string,
  zoom: number,
): "arm" | "commit" {
  return phase === "first" && tapAdjustedMovePoint(start, current, pointerType, zoom) === start
    ? "arm"
    : "commit";
}

export type CapturedMoveItem = {
  transform: Matrix;
  expectedVersion: number;
};

export type CapturedTextEdit = {
  itemId: string;
  expectedVersion: number;
  geometry: TextGeometry | StickyGeometry;
  item?: Extract<BoardItem, { kind: "text" | "sticky" }>;
};

export type ResizableCardItem = Extract<BoardItem, { kind: "sticky" | "image" }>;

export type CapturedCardResize = {
  item: ResizableCardItem;
  expectedVersion: number;
};

export function cardResizeGrabOffset(item: ResizableCardItem, localPointer: Point): Point {
  return [
    localPointer[0] - (item.geometry.x + item.geometry.width),
    localPointer[1] - (item.geometry.y + item.geometry.height),
  ];
}

export function resizedCardGeometry(
  item: ResizableCardItem,
  localPointer: Point,
  grabOffset: Point = [0, 0],
): StickyGeometry | ImageGeometry {
  const { geometry } = item;
  const pointer: Point = [localPointer[0] - grabOffset[0], localPointer[1] - grabOffset[1]];
  if (item.kind === "sticky") {
    return {
      ...geometry,
      width: roundBoard(Math.max(MIN_RESIZED_STICKY_WIDTH, pointer[0] - geometry.x)),
      height: roundBoard(Math.max(MIN_RESIZED_STICKY_HEIGHT, pointer[1] - geometry.y)),
    };
  }

  const width = Math.max(Number.EPSILON, geometry.width);
  const height = Math.max(Number.EPSILON, geometry.height);
  const pointerWidth = pointer[0] - geometry.x;
  const pointerHeight = pointer[1] - geometry.y;
  const projectedScale =
    (pointerWidth * width + pointerHeight * height) / (width ** 2 + height ** 2);
  const minimumScale = MIN_RESIZED_IMAGE_SIDE / Math.min(width, height);
  const scale = Math.max(minimumScale, projectedScale);
  return {
    ...geometry,
    width: roundBoard(width * scale),
    height: roundBoard(height * scale),
  };
}

export function buildCapturedCardResizeOperation(
  capture: CapturedCardResize,
  geometry: StickyGeometry | ImageGeometry,
): Extract<BatchItemOperation, { kind: "item.update" }> {
  return {
    kind: "item.update",
    itemId: capture.item.id,
    expectedVersion: capture.expectedVersion,
    patch: { geometry },
  };
}

export function buildCardResizeMembershipOperation(
  capture: CapturedCardResize,
  geometry: StickyGeometry | ImageGeometry,
  items: Iterable<BoardItem>,
  assignNewMembership = true,
): BatchItemOperation {
  const resize = buildCapturedCardResizeOperation(capture, geometry);
  const resizedItem = { ...capture.item, geometry } as BoardItem;
  const sectionId = sectionIdAfterBoundsChange(items, resizedItem, assignNewMembership);
  if (sectionId === capture.item.sectionId) return resize;
  return {
    ...resize,
    patch: { ...resize.patch, sectionId: sectionId ?? null },
  };
}

export function buildCapturedMoveOperations(
  items: ReadonlyMap<string, CapturedMoveItem>,
  delta: { x: number; y: number },
): Array<Extract<BatchItemOperation, { kind: "item.update" }>> {
  return [...items].map(([itemId, item]) => ({
    kind: "item.update",
    itemId,
    expectedVersion: item.expectedVersion,
    patch: { transform: translateMatrix(item.transform, delta.x, delta.y) },
  }));
}

export function buildTranslationMembershipOperations(
  directUpdates: readonly Extract<BatchItemOperation, { kind: "item.update" }>[],
  items: Iterable<BoardItem>,
  groupingEnabled: boolean,
  canModifyItem: (item: BoardItem) => boolean,
  maxItems = MAX_BATCH_OPERATIONS,
): BatchItemOperation[] {
  const savedItems = [...items];
  const itemIndex = new Map(savedItems.map((item) => [item.id, item]));
  const operations = new Map(directUpdates.map((operation) => [operation.itemId, operation]));
  const movedSectionIds = new Set<string>();

  for (const operation of directUpdates) {
    const section = itemIndex.get(operation.itemId);
    const transform = operation.patch.transform;
    if (section?.kind !== "zone" || transform === undefined) continue;
    const delta = {
      x: transform[4] - section.transform[4],
      y: transform[5] - section.transform[5],
    };
    if (delta.x === 0 && delta.y === 0) continue;
    if (!groupingEnabled) continue;
    movedSectionIds.add(section.id);
    for (const member of savedItems) {
      if (member.sectionId !== section.id || operations.has(member.id)) continue;
      operations.set(member.id, {
        kind: "item.update",
        itemId: member.id,
        expectedVersion: member.version,
        patch: { transform: translateMatrix(member.transform, delta.x, delta.y) },
      });
    }
  }

  if (groupingEnabled) {
    const pending = [...operations.values()];
    for (let index = 0; index < pending.length; index += 1) {
      const operation = pending[index];
      if (!operation) continue;
      const item = itemIndex.get(operation.itemId);
      const transform = operation.patch.transform;
      if (!item || transform === undefined) continue;
      const delta = {
        x: transform[4] - item.transform[4],
        y: transform[5] - item.transform[5],
      };
      if (delta.x === 0 && delta.y === 0) continue;
      if (item.kind === "zone") movedSectionIds.add(item.id);
      for (const related of savedItems) {
        const sharesExplicitGroup =
          item.groupId !== undefined && item.groupId !== null && related.groupId === item.groupId;
        const belongsToMovedSection = item.kind === "zone" && related.sectionId === item.id;
        if ((!sharesExplicitGroup && !belongsToMovedSection) || operations.has(related.id)) {
          continue;
        }
        const relatedOperation: Extract<BatchItemOperation, { kind: "item.update" }> = {
          kind: "item.update",
          itemId: related.id,
          expectedVersion: related.version,
          patch: { transform: translateMatrix(related.transform, delta.x, delta.y) },
        };
        operations.set(related.id, relatedOperation);
        pending.push(relatedOperation);
      }
    }
  }

  const sectionOverrides = new Map<string, Extract<BoardItem, { kind: "zone" }>>();
  for (const operation of operations.values()) {
    const item = itemIndex.get(operation.itemId);
    if (item?.kind === "zone" && operation.patch.transform !== undefined) {
      sectionOverrides.set(item.id, { ...item, transform: operation.patch.transform });
    }
  }
  if (!groupingEnabled && sectionOverrides.size > 0) {
    for (const item of savedItems) {
      if (
        item.kind === "zone" ||
        !item.sectionId ||
        !sectionOverrides.has(item.sectionId) ||
        operations.has(item.id)
      ) {
        continue;
      }
      const sectionId = sectionIdAfterBoundsChange(savedItems, item, false, sectionOverrides);
      if (sectionId === item.sectionId) continue;
      operations.set(item.id, {
        kind: "item.update",
        itemId: item.id,
        expectedVersion: item.version,
        patch: { sectionId: null },
      });
    }
  }

  const affectedItems = [...operations.keys()].flatMap((itemId) => {
    const item = itemIndex.get(itemId);
    return item ? [item] : [];
  });
  const limit = Math.max(1, Math.min(MAX_BATCH_OPERATIONS, Math.floor(maxItems)));
  if (operations.size > limit) {
    throw new GroupingError(`Arrange ${limit} related items or fewer at a time.`);
  }
  if (affectedItems.some((item) => item.version < 1)) {
    throw new GroupingError(
      "Wait for every affected Section item to finish saving before arranging.",
    );
  }
  if (affectedItems.some((item) => !canModifyItem(item))) {
    throw new GroupingError("This arrangement includes a related item you cannot modify.");
  }

  return [...operations.values()].map((operation) => {
    const item = itemIndex.get(operation.itemId);
    if (!item || item.kind === "zone" || operation.patch.transform === undefined) return operation;
    if (item.sectionId && movedSectionIds.has(item.sectionId)) return operation;
    const movedItem = { ...item, transform: operation.patch.transform } as BoardItem;
    const sectionId = sectionIdAfterBoundsChange(
      savedItems,
      movedItem,
      groupingEnabled,
      sectionOverrides,
    );
    if (sectionId === item.sectionId) return operation;
    return { ...operation, patch: { ...operation.patch, sectionId: sectionId ?? null } };
  });
}

export function effectiveMoveItemsWithinBatchLimit(
  items: Iterable<BoardItem>,
  selectedIds: Iterable<string>,
  groupingEnabled: boolean,
): BoardItem[] {
  const savedItems = [...items];
  const selected = new Set(selectedIds);
  const effectiveItems = groupingEnabled
    ? effectiveMoveCopyClosure(savedItems, selected)
    : [...selected].flatMap((id) => {
        const item = savedItems.find((candidate) => candidate.id === id);
        return item ? [item] : [];
      });
  const violation = groupingEnabled ? findMoveCopyClosureLimitViolation(savedItems) : null;
  if (
    effectiveItems.length > MAX_BATCH_OPERATIONS ||
    (violation !== null && effectiveItems.some((item) => item.id === violation.seedItemId))
  ) {
    throw new GroupingError(
      `Move ${MAX_BATCH_OPERATIONS} related items or fewer at once. Split large Sections or groups first.`,
    );
  }
  return effectiveItems;
}

export function buildCapturedDeleteOperations(
  versions: ReadonlyMap<string, number>,
): BatchItemOperation[] {
  return [...versions].map(([itemId, expectedVersion]) => ({
    kind: "item.delete",
    itemId,
    expectedVersion,
  }));
}

export function buildSectionDeleteMembershipOperation(
  selectedItems: readonly BoardItem[],
  items: Iterable<BoardItem>,
  canModifyItem: (item: BoardItem) => boolean,
): DurableOperation {
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  const deletedSectionIds = new Set(
    selectedItems.flatMap((item) => (item.kind === "zone" ? [item.id] : [])),
  );
  const survivingMembers = [...items].filter(
    (item) =>
      !selectedIds.has(item.id) &&
      item.sectionId !== undefined &&
      deletedSectionIds.has(item.sectionId),
  );

  if (survivingMembers.some((item) => item.version <= 0)) {
    throw new GroupingError(
      "Wait for every Section member to finish saving before deleting the Section.",
    );
  }
  // Membership is assigned by geometry, so whoever may edit the Section may
  // detach its members even when they cannot edit the members themselves.
  // The server applies the same rule to a bare `sectionId: null` update.
  const deletedSections = new Map(
    selectedItems.flatMap((item) => (item.kind === "zone" ? [[item.id, item] as const] : [])),
  );
  const canDetach = (item: BoardItem): boolean => {
    if (canModifyItem(item)) return true;
    const section = item.sectionId === undefined ? undefined : deletedSections.get(item.sectionId);
    return section !== undefined && canModifyItem(section);
  };
  if (survivingMembers.some((item) => !canDetach(item))) {
    throw new GroupingError("This Section contains an item you cannot remove from the Section.");
  }

  const operations: BatchItemOperation[] = [
    ...selectedItems.map((item) => ({
      kind: "item.delete" as const,
      itemId: item.id,
      expectedVersion: item.version,
    })),
    ...survivingMembers.map((item) => ({
      kind: "item.update" as const,
      itemId: item.id,
      expectedVersion: item.version,
      patch: { sectionId: null },
    })),
  ];
  if (operations.length > MAX_BATCH_OPERATIONS) {
    throw new GroupingError(
      `Delete ${MAX_BATCH_OPERATIONS} items and Section relationships or fewer at once.`,
    );
  }
  return { kind: "items.batch", operations };
}

export function buildFullEraserOperation(
  erasedItems: readonly BoardItem[],
  items: Iterable<BoardItem>,
  canModifyItem: (item: BoardItem) => boolean,
): DurableOperation {
  return buildSectionDeleteMembershipOperation(erasedItems, items, canModifyItem);
}

export function fitEraserOperationsWithinBatchLimit(
  operations: readonly BatchItemOperation[],
  capturedItems: ReadonlyMap<string, BoardItem>,
  items: Iterable<BoardItem>,
  maxItems = MAX_BATCH_OPERATIONS,
): BatchItemOperation[] {
  const savedItems = [...items];
  const limit = Math.max(1, Math.min(MAX_BATCH_OPERATIONS, Math.floor(maxItems)));
  const accepted: BatchItemOperation[] = [];
  for (const operation of operations) {
    const candidate = [...accepted, operation];
    const directItemIds = new Set(
      candidate.flatMap((entry) =>
        entry.kind === "item.update" || entry.kind === "item.delete" ? [entry.itemId] : [],
      ),
    );
    const deletedSectionIds = new Set(
      candidate.flatMap((entry) => {
        if (entry.kind !== "item.delete") return [];
        return capturedItems.get(entry.itemId)?.kind === "zone" ? [entry.itemId] : [];
      }),
    );
    const relationshipUpdates = savedItems.filter(
      (item) =>
        item.sectionId !== undefined &&
        deletedSectionIds.has(item.sectionId) &&
        !directItemIds.has(item.id),
    ).length;
    if (candidate.length + relationshipUpdates <= limit) accepted.push(operation);
  }
  return accepted;
}

export function expandPartialEraserSectionOperations(
  operations: readonly BatchItemOperation[],
  capturedItems: ReadonlyMap<string, BoardItem>,
  items: Iterable<BoardItem>,
  canModifyItem: (item: BoardItem) => boolean,
): BatchItemOperation[] {
  const deletedItems = operations.flatMap((operation) => {
    if (operation.kind !== "item.delete") return [];
    const item = capturedItems.get(operation.itemId);
    return item ? [item] : [];
  });
  if (!deletedItems.some((item) => item.kind === "zone")) return [...operations];

  const expanded = buildSectionDeleteMembershipOperation(deletedItems, items, canModifyItem);
  if (expanded.kind !== "items.batch") {
    throw new GroupingError("Could not expand partial eraser Section relationships.");
  }
  const result = [...operations];
  const operationIndexes = new Map<string, number>();
  for (const [index, operation] of result.entries()) {
    if (operation.kind === "item.update" || operation.kind === "item.delete") {
      operationIndexes.set(operation.itemId, index);
    }
  }
  for (const operation of expanded.operations) {
    if (operation.kind !== "item.update" && operation.kind !== "item.delete") continue;
    const index = operationIndexes.get(operation.itemId);
    if (index === undefined) {
      operationIndexes.set(operation.itemId, result.length);
      result.push(operation);
      continue;
    }
    const existing = result[index];
    if (operation.kind === "item.update" && existing?.kind === "item.update") {
      result[index] = {
        ...existing,
        patch: { ...existing.patch, ...operation.patch },
      } as BatchItemOperation;
    }
  }
  if (result.length > MAX_BATCH_OPERATIONS) {
    throw new GroupingError(
      `Erase ${MAX_BATCH_OPERATIONS} items and Section relationships or fewer at once.`,
    );
  }
  return result;
}

export function buildPartialEraserUpdateOperation(
  item: PartiallyErasableItem,
  expectedVersion: number,
  visiblePaths: VisiblePaths,
  items: Iterable<BoardItem>,
  assignNewMembership = true,
): Extract<BatchItemOperation, { kind: "item.update" }> {
  const geometry = { ...item.geometry, visiblePaths };
  const prospectiveItem = { ...item, geometry } as PartiallyErasableItem;
  const sectionId = sectionIdAfterBoundsChange(items, prospectiveItem, assignNewMembership);
  return {
    kind: "item.update",
    itemId: item.id,
    expectedVersion,
    patch: {
      geometry,
      ...(sectionId === item.sectionId ? {} : { sectionId: sectionId ?? null }),
    },
  };
}

export function buildCapturedTextUpdate(
  edit: CapturedTextEdit,
  text: string,
  items?: Iterable<BoardItem>,
  assignNewMembership = true,
): BatchItemOperation {
  const geometry = { ...edit.geometry, text };
  if ("embed" in geometry && geometry.embed === "video" && videoEmbedFromText(text) === null) {
    delete geometry.embed;
  }
  const update: BatchItemOperation = {
    kind: "item.update",
    itemId: edit.itemId,
    expectedVersion: edit.expectedVersion,
    patch: { geometry },
  };
  if (edit.item?.kind !== "text" || items === undefined) return update;
  const prospectiveItem = { ...edit.item, geometry } as Extract<BoardItem, { kind: "text" }>;
  const sectionId = sectionIdAfterBoundsChange(items, prospectiveItem, assignNewMembership);
  if (sectionId === edit.item.sectionId) return update;
  return { ...update, patch: { ...update.patch, sectionId: sectionId ?? null } };
}

export function buildStickyCreateOperation(
  itemId: string,
  point: Point,
  style: Pick<StyleState, "stickyFill" | "stickyTextColor" | "stickyFontSize" | "stickyOpacity">,
  text: string,
): BatchItemOperation {
  const stickyStyle: StickyStyle = {
    kind: "sticky",
    fill: style.stickyFill,
    textColor: style.stickyTextColor,
    fontSize: style.stickyFontSize,
    opacity: style.stickyOpacity,
  };
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "sticky",
      style: stickyStyle,
      transform: identityMatrix(),
      geometry: {
        x: point[0],
        y: point[1],
        width: DEFAULT_STICKY_WIDTH,
        height: DEFAULT_STICKY_HEIGHT,
        text,
      },
    },
  };
}

export function buildStampCreateOperation(
  itemId: string,
  point: Point,
  style: Pick<StyleState, "stampKind" | "stampColor" | "stampOpacity">,
): BatchItemOperation {
  const stampStyle: StampStyle = {
    kind: "stamp",
    color: style.stampColor,
    opacity: style.stampOpacity,
  };
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "stamp",
      style: stampStyle,
      transform: identityMatrix(),
      geometry: {
        x: point[0],
        y: point[1],
        size: DEFAULT_STAMP_SIZE,
        stamp: style.stampKind,
      },
    },
  };
}

export const DEFAULT_IMAGE_MAX_WIDTH = 360;
export const DEFAULT_IMAGE_MAX_HEIGHT = 280;
export const DEFAULT_IMAGE_RADIUS = 12;

export type ImageAssetMetadata = Pick<
  ImageGeometry,
  "assetId" | "mimeType" | "intrinsicWidth" | "intrinsicHeight"
>;

export function defaultImageCardSize(
  intrinsicWidth: number,
  intrinsicHeight: number,
): { width: number; height: number } {
  const scale = Math.min(
    DEFAULT_IMAGE_MAX_WIDTH / intrinsicWidth,
    DEFAULT_IMAGE_MAX_HEIGHT / intrinsicHeight,
  );
  return {
    width: Math.max(1, roundBoard(intrinsicWidth * scale)),
    height: Math.max(1, roundBoard(intrinsicHeight * scale)),
  };
}

export function buildImageCreateOperation(
  itemId: string,
  center: Point,
  asset: ImageAssetMetadata,
): BatchItemOperation {
  const size = defaultImageCardSize(asset.intrinsicWidth, asset.intrinsicHeight);
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "image",
      style: { kind: "image", opacity: 1, radius: DEFAULT_IMAGE_RADIUS },
      transform: identityMatrix(),
      geometry: {
        x: roundBoard(center[0] - size.width / 2),
        y: roundBoard(center[1] - size.height / 2),
        width: size.width,
        height: size.height,
        assetId: asset.assetId,
        mimeType: asset.mimeType,
        intrinsicWidth: asset.intrinsicWidth,
        intrinsicHeight: asset.intrinsicHeight,
      },
    },
  };
}

export function buildTableCreateOperation(
  itemId: string,
  center: Point,
  rows: number,
  columns: number,
  headerRow = false,
): BatchItemOperation {
  const rowCount = Math.max(1, Math.min(8, Math.round(rows)));
  const columnCount = Math.max(1, Math.min(6, Math.round(columns)));
  const width = columnCount * DEFAULT_TABLE_COLUMN_WIDTH;
  const height = rowCount * DEFAULT_TABLE_ROW_HEIGHT;
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "table",
      style: {
        kind: "table",
        borderColor: UI_COLORS.borderStrong,
        fill: UI_COLORS.surface,
        headerFill: STICKY_COLOR_VALUES.lavender,
        textColor: UI_COLORS.ink,
        fontSize: 16,
        opacity: 1,
      },
      transform: identityMatrix(),
      geometry: {
        x: roundBoard(center[0] - width / 2),
        y: roundBoard(center[1] - height / 2),
        columnWidths: Array.from({ length: columnCount }, () => DEFAULT_TABLE_COLUMN_WIDTH),
        rowHeights: Array.from({ length: rowCount }, () => DEFAULT_TABLE_ROW_HEIGHT),
        cells: Array.from({ length: rowCount }, () =>
          Array.from({ length: columnCount }, () => ""),
        ),
        ...(headerRow ? { headerRow: true } : {}),
      },
    },
  };
}

type ZoneCreateOperation = Extract<BatchItemOperation, { kind: "item.create" }> & {
  item: Extract<NewBoardItem, { kind: "zone" }>;
};

function zoneCreateOperation(itemId: string, geometry: ZoneGeometry): ZoneCreateOperation {
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "zone",
      style: {
        kind: "zone",
        borderColor: UI_COLORS.borderStrong,
        fill: STICKY_COLOR_VALUES.sky,
        textColor: UI_COLORS.ink,
        fontSize: 18,
        opacity: 0.18,
      },
      transform: identityMatrix(),
      geometry,
    },
  };
}

export function buildZoneCreateOperation(
  itemId: string,
  center: Point,
  title = "Section",
): ZoneCreateOperation {
  return zoneCreateOperation(itemId, defaultZoneGeometry(center, title));
}

function defaultZoneGeometry(center: Point, title: string): ZoneGeometry {
  return {
    x: roundBoard(center[0] - DEFAULT_ZONE_WIDTH / 2),
    y: roundBoard(center[1] - DEFAULT_ZONE_HEIGHT / 2),
    width: DEFAULT_ZONE_WIDTH,
    height: DEFAULT_ZONE_HEIGHT,
    title,
  };
}

// A Section drag covers the rectangle the participant swept out, in either
// direction. Anything smaller than a resized Section is read as a tap so a
// stray flick still lands the familiar default-sized Section.
export function draggedZoneGeometry(start: Point, end: Point, title = "Section"): ZoneGeometry {
  const width = Math.abs(end[0] - start[0]);
  const height = Math.abs(end[1] - start[1]);
  if (width < MIN_RESIZED_ZONE_WIDTH || height < MIN_RESIZED_ZONE_HEIGHT) {
    return defaultZoneGeometry(start, title);
  }
  return {
    x: roundBoard(Math.min(start[0], end[0])),
    y: roundBoard(Math.min(start[1], end[1])),
    width: roundBoard(width),
    height: roundBoard(height),
    title,
  };
}

export function buildDraggedZoneCreateOperation(
  itemId: string,
  start: Point,
  end: Point,
  title = "Section",
): ZoneCreateOperation {
  return zoneCreateOperation(itemId, draggedZoneGeometry(start, end, title));
}

export function buildSectionCreateMembershipOperation(
  operation: ZoneCreateOperation,
  items: Iterable<BoardItem>,
  canModifyItem: (item: BoardItem) => boolean,
): DurableOperation {
  const savedItems = [...items];
  const provisionalSection = {
    ...operation.item,
    z: Math.max(0, ...savedItems.map((item) => item.z)) + 1,
    version: 0,
    createdBy: operation.item.id,
  } as Extract<BoardItem, { kind: "zone" }>;
  const sectionBounds = itemBounds(provisionalSection);
  const containedItems = savedItems.filter(
    (item) =>
      item.kind !== "zone" &&
      item.sectionId !== operation.item.id &&
      boundsContain(sectionBounds, itemBounds(item)),
  );

  if (containedItems.some((item) => item.version < 1)) {
    throw new GroupingError(
      "Wait for every contained item to finish saving before creating a Section.",
    );
  }

  if (containedItems.some((item) => !canModifyItem(item))) {
    throw new GroupingError("This Section would contain an item you cannot add to the Section.");
  }

  const operations: BatchItemOperation[] = [
    operation,
    ...containedItems.map((item) => ({
      kind: "item.update" as const,
      itemId: item.id,
      expectedVersion: item.version,
      patch: { sectionId: operation.item.id },
    })),
  ];
  if (operations.length > MAX_BATCH_OPERATIONS) {
    throw new GroupingError(
      `Create a Section containing ${MAX_BATCH_OPERATIONS - 1} items or fewer.`,
    );
  }
  return operations.length === 1 ? operation : { kind: "items.batch", operations };
}

export function buildSectionResizeMembershipOperation(
  capture: CapturedStructuredResize,
  geometry: TableGeometry | ZoneGeometry,
  items: Iterable<BoardItem>,
  canModifyItem: (item: BoardItem) => boolean,
  assignNewMembership = true,
): DurableOperation {
  const resize = buildCapturedStructuredResizeOperation(capture, geometry);
  const savedItems = [...items];
  if (capture.item.kind !== "zone") {
    const resizedItem = { ...capture.item, geometry } as BoardItem;
    const sectionId = sectionIdAfterBoundsChange(savedItems, resizedItem, assignNewMembership);
    if (sectionId === capture.item.sectionId) return resize;
    return {
      ...resize,
      patch: { ...resize.patch, sectionId: sectionId ?? null },
    };
  }

  const resizedSection = { ...capture.item, geometry } as Extract<BoardItem, { kind: "zone" }>;
  const overrides = new Map([[capture.item.id, resizedSection]]);
  const membershipChanges: Array<{ item: BoardItem; sectionId?: string }> = [];
  for (const item of savedItems) {
    if (item.kind === "zone") continue;
    const sectionId = sectionIdAfterBoundsChange(savedItems, item, assignNewMembership, overrides);
    if (item.sectionId !== capture.item.id && sectionId !== capture.item.id) continue;
    if (sectionId === item.sectionId) continue;
    if (item.version < 1) {
      throw new GroupingError(
        "Wait for every affected item to finish saving before resizing this Section.",
      );
    }
    membershipChanges.push({ item, sectionId });
  }

  if (membershipChanges.some(({ item }) => !canModifyItem(item))) {
    throw new GroupingError(
      "This resize would change Section membership for an item you cannot modify.",
    );
  }

  const operations: BatchItemOperation[] = [
    resize,
    ...membershipChanges.map(({ item, sectionId }) => ({
      kind: "item.update" as const,
      itemId: item.id,
      expectedVersion: item.version,
      patch: { sectionId: sectionId ?? null },
    })),
  ];
  if (operations.length > MAX_BATCH_OPERATIONS) {
    throw new GroupingError(
      `Resize a Section containing ${MAX_BATCH_OPERATIONS - 1} items or fewer.`,
    );
  }
  return operations.length === 1 ? resize : { kind: "items.batch", operations };
}

export type ToolControllerOptions = {
  model: BoardModel;
  renderer: BoardRenderer;
  canDraw: () => boolean;
  canModifyItem: (item: BoardItem) => boolean;
  canUseImages: () => boolean;
  canUseTool: (tool: ToolName) => boolean;
  canSnapLines: () => boolean;
  canTransformObjects: () => boolean;
  canGroup: () => boolean;
  usePartialEraser: () => boolean;
  getStyle: () => StyleState;
  commit: (operation: DurableOperation, actionId?: string) => Promise<boolean>;
  preview: (
    gestureId: string,
    previewSeq: number,
    kind:
      | "pencil.start"
      | "pencil.segment"
      | "shape.geometry"
      | "selection.transform"
      | "gesture.cancel",
    payload?: Record<string, unknown>,
  ) => boolean;
  presence: (cursor: { x: number; y: number } | null, tool: ToolName) => void;
  editText: (point: Point, item?: BoardItem) => void;
  editImageAlt: (item: Extract<BoardItem, { kind: "image" }>) => void;
  editTableCell: (item: Extract<BoardItem, { kind: "table" }>, row: number, column: number) => void;
  editZoneTitle: (item: Extract<BoardItem, { kind: "zone" }>) => void;
  onZoneCreated: (itemId: string) => void;
  onToolChanged: (tool: ToolName) => void;
  onToolReactivated: (tool: ToolName) => void;
  onSelectionChanged: (ids: ReadonlySet<string>) => void;
  notify: (message: string, kind?: "info" | "warning" | "error") => void;
};

type Gesture =
  | { kind: "pan"; pointerId: number; lastClient: Point }
  | {
      kind: "pencil";
      pointerId: number;
      gestureId: string;
      itemId: string;
      points: Point[];
      sentPointCount: number;
      previewSeq: number;
      lastPreviewAt: number;
      style: StrokeStyle;
      animationFrame: number | null;
    }
  | {
      kind: "shape";
      pointerId: number;
      phase: "first" | "second";
      pointerStart: Point;
      pointerType: string;
      gestureId: string;
      itemId: string;
      shape: ShapeTool;
      variant?: ShapeVariant;
      start: Point;
      current: Point;
      constrained: boolean;
      snapEnabled: boolean;
      startAnchor?: ConnectorAnchor;
      endAnchor?: ConnectorAnchor;
      previewSeq: number;
      lastPreviewAt: number;
      style: StrokeStyle | LineStyle;
    }
  | {
      kind: "move";
      pointerId: number;
      gestureId: string;
      start: Point;
      current: Point;
      items: Map<string, CapturedMoveItem>;
      protractorCenter?: {
        itemId: string;
        original: Point;
        anchor?: ConnectorAnchor;
      };
      previewSeq: number;
      lastPreviewAt: number;
    }
  | {
      kind: "resize-card";
      pointerId: number;
      capture: CapturedCardResize;
      grabOffset: Point;
      geometry: StickyGeometry | ImageGeometry;
    }
  | {
      kind: "resize-structured";
      pointerId: number;
      capture: CapturedStructuredResize;
      grabOffset: Point;
      geometry: TableGeometry | ZoneGeometry;
    }
  | { kind: "marquee"; pointerId: number; start: Point; current: Point }
  | {
      kind: "eraser";
      pointerId: number;
      gestureId: string;
      versions: Map<string, number>;
      items: Map<string, BoardItem>;
      points: Point[];
      radius: number;
      partial: boolean;
    }
  | {
      kind: "scale-object";
      pointerId: number;
      item: ScalableObjectItem;
      expectedVersion: number;
      grabOffset: Point;
      transform: Matrix;
      currentTransform: Matrix;
    }
  | {
      kind: "rotate-object";
      pointerId: number;
      item: RotatableObjectItem;
      expectedVersion: number;
      localPivot: Point;
      pivot: Point;
      startAngle: number;
      transform: Matrix;
      currentTransform: Matrix;
    }
  | {
      kind: "sticky";
      pointerId: number;
      pointerType: string;
      start: Point;
      current: Point;
      item?: Extract<BoardItem, { kind: "sticky" }>;
    }
  | {
      kind: "stamp";
      pointerId: number;
      pointerType: string;
      start: Point;
      current: Point;
      operation: BatchItemOperation;
    }
  | {
      kind: "table";
      pointerId: number;
      pointerType: string;
      start: Point;
      current: Point;
      operation: BatchItemOperation;
    }
  | {
      kind: "zone";
      pointerId: number;
      pointerType: string;
      itemId: string;
      start: Point;
      current: Point;
    };

type PinchState = {
  pointerIds: readonly [number, number];
  distance: number;
  center: Point;
  zoom: number;
};

export function buildUngroupedCopyOperation(
  item: BoardItem,
  newItemId: string,
): Extract<BatchItemOperation, { kind: "item.copy" }> {
  return {
    kind: "item.copy",
    sourceItemId: item.id,
    expectedVersion: item.version,
    newItemId,
    translate: { x: 20, y: 20 },
    ...(typeof item.groupId === "string" ? { newGroupId: null } : {}),
    ...(typeof item.sectionId === "string" ? { newSectionId: null } : {}),
  };
}

export class ToolController {
  private toolValue: ToolName = "pencil";
  private gesture: Gesture | null = null;
  private pendingLine: Extract<Gesture, { kind: "shape" }> | null = null;
  private readonly selected = new Set<string>();
  private spaceHeld = false;
  private readonly pointers = new Map<number, Point>();
  private readonly expectedCaptureLosses = new Map<number, Set<object>>();
  private pinch: PinchState | null = null;
  private lastPresenceAt = 0;
  private lastStickyTap: { itemId: string; at: number } | null = null;
  private lastTableTap: {
    itemId: string;
    row: number;
    column: number;
    at: number;
  } | null = null;
  private lastZoneTap: { itemId: string; at: number } | null = null;

  constructor(private readonly options: ToolControllerOptions) {
    const { svg } = options.renderer;
    svg.addEventListener("pointerdown", this.onPointerDown);
    svg.addEventListener("pointermove", this.onPointerMove);
    svg.addEventListener("pointerup", this.onPointerUp);
    svg.addEventListener("pointercancel", this.onPointerCancel);
    svg.addEventListener("lostpointercapture", this.onLostPointerCapture);
    svg.addEventListener("wheel", this.onWheel, { passive: false });
    svg.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    options.renderer.setCursor(this.toolValue);
  }

  get tool(): ToolName {
    return this.toolValue;
  }

  get selection(): ReadonlySet<string> {
    return this.selected;
  }

  setTool(tool: ToolName): void {
    if (!this.options.canUseTool(tool)) {
      this.options.notify("That tool is disabled in Space settings.", "warning");
      return;
    }
    if (tool === "image" && !this.options.canUseImages()) {
      this.options.notify("Image cards are disabled by the owner.", "warning");
      return;
    }
    if (this.toolValue === tool) return;
    this.cancelGesture();
    this.lastStickyTap = null;
    this.lastTableTap = null;
    this.lastZoneTap = null;
    this.toolValue = tool;
    this.options.renderer.setCursor(tool, this.spaceHeld);
    this.options.onToolChanged(tool);
    this.options.presence(null, tool);
  }

  selectOnly(ids: Iterable<string>): void {
    this.selected.clear();
    for (const id of ids) {
      if (this.options.model.getItem(id)) this.selected.add(id);
    }
    this.renderSelection();
    this.options.onSelectionChanged(this.selected);
  }

  reconcileSelection(): void {
    const existing = [...this.selected].filter((id) => this.options.model.getItem(id));
    if (existing.length !== this.selected.size) {
      this.selectOnly(existing);
      return;
    }
    this.renderSelection();
  }

  cancelActiveGesture(): void {
    this.cancelGesture();
  }

  async deleteSelection(): Promise<void> {
    if (!this.options.canDraw() || this.selected.size === 0) return;
    const items = [...this.selected].map((id) => this.options.model.getItem(id));
    if (items.some((item) => !item)) {
      this.reconcileSelection();
      this.options.notify("That selection is no longer available.", "info");
      return;
    }
    if (items.some((item) => item && item.version <= 0)) {
      this.options.notify("Wait for the selected items to finish saving.", "info");
      return;
    }
    const selectedItems = items.filter((item): item is BoardItem => item !== undefined);
    let operation: DurableOperation;
    try {
      operation = buildSectionDeleteMembershipOperation(
        selectedItems,
        this.options.model.items.values(),
        this.options.canModifyItem,
      );
    } catch (error) {
      if (error instanceof GroupingError) {
        this.options.notify(error.message, "warning");
        return;
      }
      throw error;
    }
    const accepted = await this.commitOperation(operation);
    if (accepted) this.selectOnly([]);
  }

  async copySelection(): Promise<void> {
    if (!this.options.canDraw() || this.selected.size === 0) return;
    try {
      const result = this.options.canGroup()
        ? buildGroupedSectionCopyBatch(this.options.model.items.values(), this.selected, {
            createItemId: createId,
            createGroupId: createId,
          })
        : null;
      if (result) {
        const accepted = await this.commitOperation(result.operation);
        if (accepted) this.selectOnly(result.itemIds);
        return;
      }
    } catch (error) {
      if (error instanceof GroupingError) {
        this.options.notify(error.message, "warning");
        return;
      }
      throw error;
    }

    const items = [...this.selected].map((id) => this.options.model.getItem(id));
    if (items.some((item) => !item)) {
      this.reconcileSelection();
      this.options.notify("That selection is no longer available.", "info");
      return;
    }
    if (items.some((item) => item && item.version <= 0)) {
      this.options.notify("Wait for the selected items to finish saving.", "info");
      return;
    }
    const operations = items.flatMap((item) =>
      item ? [buildUngroupedCopyOperation(item, createId())] : [],
    );
    if (operations.length > 100) {
      this.options.notify("Select 100 items or fewer for one copy.", "warning");
      return;
    }
    const accepted = await this.commitOperation({ kind: "items.batch", operations });
    if (accepted) this.selectOnly(operations.map((operation) => operation.newItemId));
  }

  async groupSelection(): Promise<void> {
    if (!this.options.canDraw() || !this.options.canGroup()) return;
    const allItems = [...this.options.model.items.values()];
    const selectedCount = [...this.selected].filter((id) => this.options.model.getItem(id)).length;
    // Group the whole closure: every member of any group the selection
    // touches is included, so an existing group is never split.
    const items = explicitGroupClosure(allItems, this.selected);
    if (
      selectedCount !== this.selected.size ||
      items.some((item) => !this.options.canModifyItem(item))
    ) {
      this.options.notify("You can group only saved work that you can edit.", "warning");
      return;
    }
    try {
      const operation = buildGroupBatch(items, createId(), allItems);
      if (!operation) return;
      if (await this.commitOperation(operation)) this.selectOnly(items.map((item) => item.id));
    } catch (error) {
      if (error instanceof GroupingError) {
        this.options.notify(error.message, "warning");
        return;
      }
      throw error;
    }
  }

  async ungroupSelection(): Promise<void> {
    if (!this.options.canDraw() || !this.options.canGroup()) return;
    const items = [...this.selected].flatMap((id) => {
      const item = this.options.model.getItem(id);
      return item ? [item] : [];
    });
    if (
      items.length !== this.selected.size ||
      items.some((item) => !this.options.canModifyItem(item))
    ) {
      this.options.notify("You can ungroup only saved work that you can edit.", "warning");
      return;
    }
    try {
      const operation = buildUngroupBatch(items);
      if (operation) await this.commitOperation(operation);
    } catch (error) {
      if (error instanceof GroupingError) {
        this.options.notify(error.message, "warning");
        return;
      }
      throw error;
    }
  }

  destroy(): void {
    this.cancelGesture();
    this.expectedCaptureLosses.clear();
    const { svg } = this.options.renderer;
    svg.removeEventListener("pointerdown", this.onPointerDown);
    svg.removeEventListener("pointermove", this.onPointerMove);
    svg.removeEventListener("pointerup", this.onPointerUp);
    svg.removeEventListener("pointercancel", this.onPointerCancel);
    svg.removeEventListener("lostpointercapture", this.onLostPointerCapture);
    svg.removeEventListener("wheel", this.onWheel);
    svg.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.target instanceof Element && event.target.closest("[data-board-link]")) {
      event.stopPropagation();
      return;
    }
    this.options.renderer.svg.focus({ preventScroll: true });
    this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
    this.options.renderer.svg.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch" && this.pointers.size === 2) {
      this.cancelGesture();
      const entries = [...this.pointers.entries()];
      const first = entries[0];
      const second = entries[1];
      if (first && second) {
        this.pinch = {
          pointerIds: [first[0], second[0]],
          distance: pointDistance(first[1], second[1]),
          center: midpoint(first[1], second[1]),
          zoom: this.options.renderer.viewport.zoom,
        };
      }
      event.preventDefault();
      return;
    }
    if (this.pointers.size > 1) return;

    const point = boardPoint(event, this.options.renderer);
    if (event.button === 1 || this.spaceHeld || this.toolValue === "pan") {
      this.gesture = {
        kind: "pan",
        pointerId: event.pointerId,
        lastClient: [event.clientX, event.clientY],
      };
      event.preventDefault();
      return;
    }

    if (this.toolValue === "select") {
      this.beginSelection(event, point);
      return;
    }

    if (!this.options.canDraw()) {
      this.options.notify("Drawing is currently read only.", "warning");
      return;
    }
    if (!this.options.canUseTool(this.toolValue)) {
      this.options.notify("That tool is disabled in Space settings.", "warning");
      this.setTool("select");
      return;
    }

    if (this.toolValue === "line" && this.pendingLine) {
      const gesture = this.pendingLine;
      this.pendingLine = null;
      gesture.pointerId = event.pointerId;
      gesture.phase = "second";
      gesture.pointerStart = point;
      gesture.pointerType = event.pointerType;
      applyShapePointerState(
        gesture,
        resolveShapePointerState(
          "line",
          point,
          event.shiftKey,
          this.options.model,
          this.options.renderer.viewport.zoom,
          gesture.snapEnabled,
          gesture.endAnchor,
        ),
      );
      this.gesture = gesture;
      this.renderShapeGesture(gesture, true);
      event.preventDefault();
      return;
    }

    const style = this.options.getStyle();
    if (this.toolValue === "pencil") {
      const gestureId = createId();
      const itemId = createId();
      const strokeStyle: StrokeStyle = {
        kind: "stroke",
        color: style.color,
        width: style.width,
        opacity: style.opacity,
      };
      this.gesture = {
        kind: "pencil",
        pointerId: event.pointerId,
        gestureId,
        itemId,
        points: [point],
        sentPointCount: 1,
        previewSeq: 1,
        lastPreviewAt: performance.now(),
        style: strokeStyle,
        animationFrame: null,
      };
      this.options.renderer.showLocalPencil([point], strokeStyle);
      this.options.preview(gestureId, 1, "pencil.start", { itemId, point, style: strokeStyle });
      event.preventDefault();
      return;
    }

    if (
      this.toolValue === "line" ||
      this.toolValue === "rectangle" ||
      this.toolValue === "ellipse" ||
      this.toolValue === "polygon"
    ) {
      const shapeStyle: StrokeStyle | LineStyle =
        this.toolValue === "line"
          ? {
              kind: "line",
              color: style.color,
              width: style.width,
              opacity: style.opacity,
              arrowhead: style.lineArrowhead,
            }
          : {
              kind: "stroke",
              color: style.color,
              width: style.width,
              opacity: style.opacity,
            };
      const startAnchor =
        this.toolValue === "line" && this.options.canSnapLines()
          ? resolveConnectorEndpoint(this.options.model, point, this.options.renderer.viewport.zoom)
              .anchor
          : undefined;
      const start = startAnchor?.point ?? point;
      this.gesture = {
        kind: "shape",
        pointerId: event.pointerId,
        phase: "first",
        pointerStart: point,
        pointerType: event.pointerType,
        gestureId: createId(),
        itemId: createId(),
        shape: this.toolValue,
        ...(this.toolValue === "line"
          ? {}
          : { variant: shapeVariantForTool(this.toolValue, style) }),
        start,
        current: start,
        constrained: event.shiftKey,
        snapEnabled: this.toolValue === "line" && this.options.canSnapLines(),
        ...(startAnchor ? { startAnchor } : {}),
        previewSeq: 0,
        lastPreviewAt: 0,
        style: shapeStyle,
      };
      this.renderShapeGesture(this.gesture, true);
      event.preventDefault();
      return;
    }

    if (this.toolValue === "protractor") {
      const placement = this.options.canSnapLines()
        ? resolveConnectorEndpoint(this.options.model, point, this.options.renderer.viewport.zoom)
            .point
        : point;
      const itemId = createId();
      const operation = buildProtractorCreateOperation(itemId, placement, style);
      void this.commitOperation(operation).then((accepted) => {
        if (!accepted) return;
        this.setTool("select");
        this.selectOnly([itemId]);
      });
      event.preventDefault();
      return;
    }

    if (this.toolValue === "eraser") {
      const gesture: Gesture = {
        kind: "eraser",
        pointerId: event.pointerId,
        gestureId: createId(),
        versions: new Map(),
        items: new Map(),
        points: [],
        radius: 8 / this.options.renderer.viewport.zoom,
        partial: this.options.usePartialEraser(),
      };
      this.gesture = gesture;
      this.collectEraser(point, gesture);
      event.preventDefault();
      return;
    }

    if (this.toolValue === "text") {
      const hit = this.options.model.hitTest(point, 4);
      this.options.editText(point, hit?.kind === "text" ? hit : undefined);
      event.preventDefault();
      return;
    }

    if (this.toolValue === "sticky") {
      const hit = this.options.model.hitTest(point, 0);
      const sticky = hit?.kind === "sticky" ? hit : undefined;
      if (event.pointerType === "touch") {
        this.gesture = {
          kind: "sticky",
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          start: point,
          current: point,
          item: sticky,
        };
        event.preventDefault();
        return;
      }
      this.options.editText(point, sticky);
      event.preventDefault();
      return;
    }

    if (this.toolValue === "stamp") {
      const operation = buildStampCreateOperation(createId(), point, style);
      if (event.pointerType === "touch") {
        this.gesture = {
          kind: "stamp",
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          start: point,
          current: point,
          operation,
        };
      } else {
        void this.commitOperation(operation);
      }
      event.preventDefault();
      return;
    }

    if (this.toolValue === "table") {
      const operation = buildTableCreateOperation(
        createId(),
        point,
        style.tableRows,
        style.tableColumns,
        style.tableHeaderRow,
      );
      if (event.pointerType === "touch") {
        this.gesture = {
          kind: "table",
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          start: point,
          current: point,
          operation,
        };
      } else {
        void this.commitTable(operation);
      }
      event.preventDefault();
      return;
    }

    if (this.toolValue === "zone") {
      const gesture: Extract<Gesture, { kind: "zone" }> = {
        kind: "zone",
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        itemId: createId(),
        start: point,
        current: point,
      };
      this.gesture = gesture;
      this.renderZoneGesture(gesture);
      event.preventDefault();
      return;
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
    }
    const now = performance.now();
    if (!document.hidden && now - this.lastPresenceAt >= 200) {
      const point = boardPoint(event, this.options.renderer);
      this.options.presence({ x: roundBoard(point[0]), y: roundBoard(point[1]) }, this.toolValue);
      this.lastPresenceAt = now;
    }

    if (
      this.pinch &&
      this.pointers.has(this.pinch.pointerIds[0]) &&
      this.pointers.has(this.pinch.pointerIds[1])
    ) {
      const first = this.pointers.get(this.pinch.pointerIds[0]);
      const second = this.pointers.get(this.pinch.pointerIds[1]);
      if (!first || !second) return;
      const center = midpoint(first, second);
      const distance = Math.max(1, pointDistance(first, second));
      this.options.renderer.viewport.panByPixels(
        center[0] - this.pinch.center[0],
        center[1] - this.pinch.center[1],
      );
      this.options.renderer.viewport.zoomAt(
        center[0],
        center[1],
        this.pinch.zoom * (distance / this.pinch.distance),
      );
      this.pinch = { ...this.pinch, center };
      event.preventDefault();
      return;
    }

    if (!this.gesture && this.pendingLine) {
      const point = boardPoint(event, this.options.renderer);
      applyShapePointerState(
        this.pendingLine,
        resolveShapePointerState(
          "line",
          point,
          event.shiftKey,
          this.options.model,
          this.options.renderer.viewport.zoom,
          this.pendingLine.snapEnabled,
          this.pendingLine.endAnchor,
        ),
      );
      this.renderShapeGesture(this.pendingLine, false);
      event.preventDefault();
      return;
    }

    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.kind === "pan") {
      this.options.renderer.viewport.panByPixels(
        event.clientX - gesture.lastClient[0],
        event.clientY - gesture.lastClient[1],
      );
      gesture.lastClient = [event.clientX, event.clientY];
    } else if (gesture.kind === "pencil") {
      const events =
        typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
      for (const sample of events)
        appendUniquePoint(gesture.points, boardPoint(sample, this.options.renderer));
      if (gesture.points.length > 10_000) gesture.points.length = 10_000;
      if (gesture.animationFrame === null) {
        gesture.animationFrame = requestAnimationFrame(() => {
          gesture.animationFrame = null;
          this.options.renderer.showLocalPencil(gesture.points, gesture.style);
        });
      }
      if (now - gesture.lastPreviewAt >= 75 && gesture.sentPointCount < gesture.points.length) {
        const points = gesture.points.slice(Math.max(0, gesture.sentPointCount - 1));
        gesture.sentPointCount = gesture.points.length;
        gesture.previewSeq += 1;
        gesture.lastPreviewAt = now;
        this.options.preview(gesture.gestureId, gesture.previewSeq, "pencil.segment", {
          itemId: gesture.itemId,
          points,
        });
      }
    } else if (gesture.kind === "shape") {
      applyShapePointerState(
        gesture,
        resolveShapePointerState(
          gesture.shape,
          boardPoint(event, this.options.renderer),
          event.shiftKey,
          this.options.model,
          this.options.renderer.viewport.zoom,
          gesture.snapEnabled,
          gesture.endAnchor,
        ),
      );
      this.renderShapeGesture(gesture, false);
    } else if (gesture.kind === "move") {
      this.applyMovePointerState(gesture, boardPoint(event, this.options.renderer));
      const delta = gestureDelta(gesture);
      this.options.renderer.showMovePreview(
        [...gesture.items.keys()],
        delta.x,
        delta.y,
        gesture.protractorCenter?.anchor?.point,
      );
      if (now - gesture.lastPreviewAt >= 75) {
        gesture.previewSeq += 1;
        gesture.lastPreviewAt = now;
        this.options.preview(gesture.gestureId, gesture.previewSeq, "selection.transform", {
          itemIds: [...gesture.items.keys()],
          translate: delta,
        });
      }
    } else if (gesture.kind === "resize-card") {
      const localPointer = inverseTransformPoint(
        boardPoint(event, this.options.renderer),
        gesture.capture.item.transform,
      );
      if (localPointer) {
        gesture.geometry = resizedCardGeometry(
          gesture.capture.item,
          localPointer,
          gesture.grabOffset,
        );
        this.options.renderer.showCardResizePreview(gesture.capture.item, gesture.geometry);
      }
    } else if (gesture.kind === "resize-structured") {
      const localPointer = inverseTransformPoint(
        boardPoint(event, this.options.renderer),
        gesture.capture.item.transform,
      );
      if (localPointer) {
        gesture.geometry = resizedStructuredGeometry(
          gesture.capture.item,
          gesture.capture.handle,
          localPointer,
          gesture.grabOffset,
        );
        this.options.renderer.showStructuredResizePreview(gesture.capture.item, gesture.geometry);
      }
    } else if (gesture.kind === "scale-object") {
      gesture.currentTransform = scaledObjectMatrix(
        gesture.item,
        boardPoint(event, this.options.renderer),
        gesture.grabOffset,
      );
      this.options.renderer.showObjectScalePreview(gesture.item, gesture.currentTransform);
    } else if (gesture.kind === "rotate-object") {
      const delta = rotationDelta(
        gesture.startAngle,
        pointerAngle(gesture.pivot, boardPoint(event, this.options.renderer)),
        event.shiftKey,
      );
      gesture.currentTransform = rotatedMatrixAroundLocalPoint(
        gesture.transform,
        delta,
        gesture.localPivot,
      );
      this.options.renderer.showRotationPreview(gesture.item, gesture.currentTransform);
    } else if (gesture.kind === "marquee") {
      gesture.current = boardPoint(event, this.options.renderer);
      this.options.renderer.showMarquee(pointsBounds(gesture.start, gesture.current));
    } else if (gesture.kind === "eraser") {
      const events =
        typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event];
      for (const sample of events)
        this.collectEraser(boardPoint(sample, this.options.renderer), gesture);
    } else if (gesture.kind === "zone") {
      gesture.current = boardPoint(event, this.options.renderer);
      this.renderZoneGesture(gesture);
    } else if (gesture.kind === "sticky" || gesture.kind === "stamp" || gesture.kind === "table") {
      gesture.current = boardPoint(event, this.options.renderer);
    }
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.pinch.pointerIds.includes(event.pointerId)) this.pinch = null;
      this.releasePointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      this.releasePointerCapture(event.pointerId);
      return;
    }
    const tapPoint = boardPoint(event, this.options.renderer);
    if (gesture.kind === "shape") {
      applyShapePointerState(
        gesture,
        resolveShapePointerState(
          gesture.shape,
          tapPoint,
          event.shiftKey,
          this.options.model,
          this.options.renderer.viewport.zoom,
          gesture.snapEnabled,
          gesture.endAnchor,
        ),
      );
    } else if (gesture.kind === "move") {
      this.applyMovePointerState(gesture, tapPoint);
    } else if (gesture.kind === "resize-card") {
      const localPointer = inverseTransformPoint(tapPoint, gesture.capture.item.transform);
      if (localPointer) {
        gesture.geometry = resizedCardGeometry(
          gesture.capture.item,
          localPointer,
          gesture.grabOffset,
        );
      }
    } else if (gesture.kind === "resize-structured") {
      const localPointer = inverseTransformPoint(tapPoint, gesture.capture.item.transform);
      if (localPointer) {
        gesture.geometry = resizedStructuredGeometry(
          gesture.capture.item,
          gesture.capture.handle,
          localPointer,
          gesture.grabOffset,
        );
      }
    } else if (gesture.kind === "scale-object") {
      gesture.currentTransform = scaledObjectMatrix(gesture.item, tapPoint, gesture.grabOffset);
    } else if (gesture.kind === "rotate-object") {
      gesture.currentTransform = rotatedMatrixAroundLocalPoint(
        gesture.transform,
        rotationDelta(gesture.startAngle, pointerAngle(gesture.pivot, tapPoint), event.shiftKey),
        gesture.localPivot,
      );
    } else if (gesture.kind === "eraser") {
      this.collectEraser(tapPoint, gesture);
    } else if (gesture.kind === "zone") {
      gesture.current = tapPoint;
    }
    if (
      gesture.kind === "shape" &&
      gesture.shape === "line" &&
      gesture.phase === "first" &&
      lineCreationReleaseAction(
        gesture.phase,
        gesture.pointerStart,
        tapPoint,
        gesture.pointerType,
        this.options.renderer.viewport.zoom,
      ) === "arm"
    ) {
      gesture.current = gesture.start;
      delete gesture.endAnchor;
      this.gesture = null;
      this.pendingLine = gesture;
      this.releasePointerCapture(event.pointerId);
      this.renderShapeGesture(gesture, true);
      event.preventDefault();
      return;
    }
    this.gesture = null;
    this.releasePointerCapture(event.pointerId);
    const adjustedMovePoint =
      gesture.kind === "move"
        ? tapAdjustedMovePoint(
            gesture.start,
            gesture.current,
            event.pointerType,
            this.options.renderer.viewport.zoom,
          )
        : undefined;
    const isItemTap = gesture.kind === "move" && adjustedMovePoint === gesture.start;
    const tappedItem = isItemTap ? this.options.model.hitTest(tapPoint, 0) : undefined;
    if (isItemTap && gesture.kind === "move" && adjustedMovePoint) {
      gesture.current = adjustedMovePoint;
    }
    void this.finishGesture(gesture);
    if (isTapEditable(tappedItem)) this.handleEditableTap(tappedItem, pointFromItem(tappedItem));
    else this.lastStickyTap = null;
    if (tappedItem?.kind === "table") this.handleTableTap(tappedItem, tapPoint);
    else this.lastTableTap = null;
    if (tappedItem?.kind === "zone") this.handleZoneTap(tappedItem);
    else this.lastZoneTap = null;
    event.preventDefault();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pinch?.pointerIds.includes(event.pointerId)) this.pinch = null;
    if (this.gesture?.pointerId === event.pointerId) this.cancelGesture();
    this.releasePointerCapture(event.pointerId);
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    if (this.consumeExpectedCaptureLoss(event.pointerId)) return;
    this.pointers.delete(event.pointerId);
    if (this.gesture?.pointerId === event.pointerId) this.cancelGesture();
  };

  private releasePointerCapture(pointerId: number): void {
    const { svg } = this.options.renderer;
    if (!svg.hasPointerCapture(pointerId)) return;

    const token = {};
    let expected = this.expectedCaptureLosses.get(pointerId);
    if (!expected) {
      expected = new Set();
      this.expectedCaptureLosses.set(pointerId, expected);
    }
    expected.add(token);

    window.setTimeout(() => {
      expected?.delete(token);
      if (this.expectedCaptureLosses.get(pointerId) === expected && expected?.size === 0) {
        this.expectedCaptureLosses.delete(pointerId);
      }
    }, 1_000);

    try {
      svg.releasePointerCapture(pointerId);
    } catch {
      expected.delete(token);
      if (expected.size === 0) this.expectedCaptureLosses.delete(pointerId);
    }
  }

  private consumeExpectedCaptureLoss(pointerId: number): boolean {
    const expected = this.expectedCaptureLosses.get(pointerId);
    if (!expected || expected.size === 0) return false;
    const token = expected.values().next().value;
    if (!token) return false;
    expected.delete(token);
    if (expected.size === 0) this.expectedCaptureLosses.delete(pointerId);
    return true;
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const normalized =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    const factor = Math.exp(-normalized * 0.0015);
    this.options.renderer.viewport.zoomAt(
      event.clientX,
      event.clientY,
      this.options.renderer.viewport.zoom * factor,
    );
  };

  private readonly onContextMenu = (event: MouseEvent): void => event.preventDefault();

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isEditingTarget(event.target) || isOpenDialogTarget(event.target)) return;
    if (event.code === "Space") {
      this.spaceHeld = true;
      this.options.renderer.setCursor(this.toolValue, true);
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      this.cancelGesture();
      this.selectOnly([]);
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selected.size > 0) {
      event.preventDefault();
      void this.deleteSelection();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      void this.copySelection();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g") {
      event.preventDefault();
      if (event.shiftKey) void this.ungroupSelection();
      else void this.groupSelection();
      return;
    }
    if ((event.key === "Enter" || event.key === "F2") && this.selected.size === 1) {
      const [selectedId] = this.selected;
      const item = selectedId === undefined ? undefined : this.options.model.getItem(selectedId);
      if (isTapEditable(item) && this.options.canDraw()) {
        event.preventDefault();
        this.lastStickyTap = null;
        this.options.editText(pointFromItem(item), item);
        return;
      }
      if (item?.kind === "image" && this.options.canDraw()) {
        event.preventDefault();
        this.options.editImageAlt(item);
        return;
      }
      if (item?.kind === "table" && this.options.canDraw()) {
        event.preventDefault();
        this.lastTableTap = null;
        this.options.editTableCell(item, 0, 0);
        return;
      }
      if (item?.kind === "zone" && this.options.canDraw()) {
        event.preventDefault();
        this.openZoneTitleEditor(item);
        return;
      }
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const shortcutKey = event.key.toLowerCase();
    if (TOOL_SHORTCUTS[shortcutKey]) {
      const tool = toolFromShortcut(shortcutKey, this.options.canDraw());
      if (tool) {
        const wasActive = this.toolValue === tool;
        this.setTool(tool);
        if (wasActive) this.options.onToolReactivated(tool);
      }
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== "Space") return;
    this.spaceHeld = false;
    this.options.renderer.setCursor(this.toolValue);
  };

  private beginSelection(event: PointerEvent, point: Point): void {
    const eventTarget = event.target instanceof Element ? event.target : null;
    const rotateHandle = eventTarget?.closest<SVGGElement>("[data-rotate-handle]");
    if (rotateHandle) {
      const itemId = rotateHandle.dataset.itemId;
      const item = itemId ? this.options.model.getItem(itemId) : undefined;
      if (!this.options.canDraw()) {
        this.options.notify("Drawing is currently read only.", "warning");
      } else if (!this.options.canTransformObjects()) {
        this.options.notify("Object transforms are disabled in Space settings.", "warning");
      } else if (item && !this.options.canModifyItem(item)) {
        this.options.notify("You can rotate only items that you created.", "warning");
      } else if (
        item &&
        isRotatableObjectItem(item) &&
        item.version > 0 &&
        this.selected.size === 1 &&
        this.selected.has(item.id)
      ) {
        const captured = structuredClone(item);
        const localPivot = objectLocalCenter(captured);
        const pivot = transformPoint(localPivot, captured.transform);
        this.gesture = {
          kind: "rotate-object",
          pointerId: event.pointerId,
          item: captured,
          expectedVersion: item.version,
          localPivot,
          pivot,
          startAngle: pointerAngle(pivot, point),
          transform: [...item.transform] as Matrix,
          currentTransform: [...item.transform] as Matrix,
        };
      } else {
        this.options.notify("Wait for this item to finish saving before rotating it.", "info");
      }
      event.preventDefault();
      return;
    }
    const scaleHandle = eventTarget?.closest<SVGGElement>("[data-scale-handle]");
    if (scaleHandle) {
      const itemId = scaleHandle.dataset.itemId;
      const item = itemId ? this.options.model.getItem(itemId) : undefined;
      if (!this.options.canDraw()) {
        this.options.notify("Drawing is currently read only.", "warning");
      } else if (!this.options.canTransformObjects()) {
        this.options.notify("Object transforms are disabled in Space settings.", "warning");
      } else if (item && !this.options.canModifyItem(item)) {
        this.options.notify("You can scale only items that you created.", "warning");
      } else if (
        item &&
        isScalableObjectItem(item) &&
        item.version > 0 &&
        this.selected.size === 1 &&
        this.selected.has(item.id)
      ) {
        const captured = structuredClone(item);
        this.gesture = {
          kind: "scale-object",
          pointerId: event.pointerId,
          item: captured,
          expectedVersion: item.version,
          grabOffset: objectScaleGrabOffset(captured, point),
          transform: [...item.transform] as Matrix,
          currentTransform: [...item.transform] as Matrix,
        };
        this.options.renderer.showObjectScalePreview(captured, this.gesture.currentTransform);
      } else {
        this.options.notify("Wait for this item to finish saving before scaling it.", "info");
      }
      event.preventDefault();
      return;
    }
    const resizeHandle = eventTarget?.closest<SVGGElement>("[data-resize-handle]");
    if (resizeHandle) {
      const itemId = resizeHandle.dataset.itemId;
      const item = itemId ? this.options.model.getItem(itemId) : undefined;
      const structuredHandle = structuredResizeHandleFromDataset(resizeHandle.dataset);
      if (!this.options.canDraw()) {
        this.options.notify("Drawing is currently read only.", "warning");
      } else if (item && !this.options.canModifyItem(item)) {
        this.options.notify("You can resize only items that you created.", "warning");
      } else if (
        item &&
        (item.kind === "sticky" || item.kind === "image") &&
        resizeHandle.dataset.resizeHandle === "southeast" &&
        item.version > 0 &&
        this.selected.size === 1 &&
        this.selected.has(item.id)
      ) {
        const localPointer = inverseTransformPoint(point, item.transform);
        if (localPointer) {
          const capture = {
            item: structuredClone(item),
            expectedVersion: item.version,
          } satisfies CapturedCardResize;
          this.gesture = {
            kind: "resize-card",
            pointerId: event.pointerId,
            capture,
            grabOffset: cardResizeGrabOffset(capture.item, localPointer),
            geometry: structuredClone(capture.item.geometry),
          };
          this.options.renderer.showCardResizePreview(capture.item, this.gesture.geometry);
        }
      } else if (
        item &&
        (item.kind === "table" || item.kind === "zone") &&
        structuredHandle !== null &&
        structuredResizeHandleApplies(item, structuredHandle) &&
        item.version > 0 &&
        this.selected.size === 1 &&
        this.selected.has(item.id)
      ) {
        const localPointer = inverseTransformPoint(point, item.transform);
        if (localPointer) {
          const capture = {
            item: structuredClone(item),
            expectedVersion: item.version,
            handle: structuredHandle,
          } satisfies CapturedStructuredResize;
          this.gesture = {
            kind: "resize-structured",
            pointerId: event.pointerId,
            capture,
            grabOffset: structuredResizeGrabOffset(capture.item, capture.handle, localPointer),
            geometry: structuredClone(capture.item.geometry),
          };
          this.options.renderer.showStructuredResizePreview(capture.item, this.gesture.geometry);
        }
      } else {
        this.options.notify("Wait for this item to finish saving before resizing it.", "info");
      }
      event.preventDefault();
      return;
    }
    const videoDragTarget = eventTarget?.closest<SVGElement>(
      "[data-video-drag-frame], [data-video-drag-handle]",
    );
    const videoItemId = videoDragTarget?.closest<SVGElement>("[data-item-id]")?.dataset.itemId;
    const videoItem = videoItemId ? this.options.model.getItem(videoItemId) : undefined;
    const hit =
      videoItem?.kind === "text" && videoItem.geometry.embed === "video"
        ? videoItem
        : this.options.model.hitTest(
            point,
            selectionHitPadding(event.pointerType, this.options.renderer.viewport.zoom),
          );
    if (!isTapEditable(hit)) this.lastStickyTap = null;
    if (hit?.kind !== "table") this.lastTableTap = null;
    if (hit?.kind !== "zone") this.lastZoneTap = null;
    if (hit) {
      if (!this.selected.has(hit.id)) {
        const seeds = event.shiftKey ? [...this.selected, hit.id] : [hit.id];
        const selectedItems = this.options.canGroup()
          ? explicitGroupClosure(this.options.model.items.values(), seeds)
          : seeds.flatMap((id) => {
              const item = this.options.model.getItem(id);
              return item ? [item] : [];
            });
        this.selectOnly(selectedItems.map((item) => item.id));
      }
      if (this.options.canDraw()) {
        const items = new Map<string, CapturedMoveItem>();
        let effectiveItems: BoardItem[];
        try {
          effectiveItems = effectiveMoveItemsWithinBatchLimit(
            this.options.model.items.values(),
            this.selected,
            this.options.canGroup(),
          );
        } catch (error) {
          if (error instanceof GroupingError) {
            this.options.notify(error.message, "warning");
            event.preventDefault();
            return;
          }
          throw error;
        }
        let includesForeignWork = false;
        for (const item of effectiveItems) {
          if (item.version <= 0) {
            items.clear();
            break;
          }
          if (!this.options.canModifyItem(item)) {
            includesForeignWork = true;
            items.clear();
            break;
          }
          items.set(item.id, {
            transform: [...item.transform] as Matrix,
            expectedVersion: item.version,
          });
        }
        if (includesForeignWork) {
          this.options.notify(
            "You can move only work that you created. You can still copy this selection.",
            "warning",
          );
        } else if (items.size === effectiveItems.length) {
          const onlySelectedId =
            this.selected.size === 1 ? this.selected.values().next().value : undefined;
          const onlySelected =
            typeof onlySelectedId === "string"
              ? this.options.model.getItem(onlySelectedId)
              : undefined;
          this.gesture = {
            kind: "move",
            pointerId: event.pointerId,
            gestureId: createId(),
            start: point,
            current: point,
            items,
            ...(onlySelected?.kind === "protractor"
              ? {
                  protractorCenter: {
                    itemId: onlySelected.id,
                    original: [onlySelected.transform[4], onlySelected.transform[5]],
                  },
                }
              : {}),
            previewSeq: 0,
            lastPreviewAt: 0,
          };
        } else {
          this.options.notify("Wait for the grouped items to finish saving.", "info");
        }
      }
    } else {
      if (!event.shiftKey) this.selectOnly([]);
      this.gesture = { kind: "marquee", pointerId: event.pointerId, start: point, current: point };
      this.options.renderer.showMarquee(pointsBounds(point, point));
    }
    event.preventDefault();
  }

  private applyMovePointerState(gesture: Extract<Gesture, { kind: "move" }>, point: Point): void {
    if (!gesture.protractorCenter || !this.options.canSnapLines()) {
      gesture.current = point;
      if (gesture.protractorCenter) delete gesture.protractorCenter.anchor;
      return;
    }
    const resolved = resolveProtractorCenterMove(
      gesture.start,
      point,
      gesture.protractorCenter.original,
      gesture.protractorCenter.itemId,
      this.options.model,
      this.options.renderer.viewport.zoom,
      gesture.protractorCenter.anchor,
    );
    gesture.current = resolved.current;
    if (resolved.anchor) gesture.protractorCenter.anchor = resolved.anchor;
    else delete gesture.protractorCenter.anchor;
  }

  private renderShapeGesture(
    gesture: Extract<Gesture, { kind: "shape" }>,
    forcePreview: boolean,
  ): void {
    const geometry = shapeGeometry(
      gesture.shape,
      gesture.start,
      gesture.current,
      gesture.constrained || gesture.variant === "square" || gesture.variant === "circle",
      gesture.endAnchor !== undefined,
      gesture.variant,
    );
    const snapPoints = [gesture.startAnchor?.point, gesture.endAnchor?.point].filter(
      (point): point is Point => point !== undefined,
    );
    this.options.renderer.showLocalShape(gesture.shape, geometry, gesture.style, snapPoints);
    const now = performance.now();
    if (!forcePreview && now - gesture.lastPreviewAt < 75) return;
    gesture.previewSeq += 1;
    gesture.lastPreviewAt = now;
    this.options.preview(gesture.gestureId, gesture.previewSeq, "shape.geometry", {
      itemId: gesture.itemId,
      itemKind: gesture.shape,
      geometry,
      style: gesture.style,
    });
  }

  private collectEraser(point: Point, gesture: Extract<Gesture, { kind: "eraser" }>): void {
    appendUniquePoint(gesture.points, point);
    if (gesture.points.length > 10_000) gesture.points.splice(0, gesture.points.length - 10_000);
    if (gesture.partial) {
      const recentPath = gesture.points.slice(-2);
      for (const item of this.options.model.strokeItemsNearPath(
        recentPath,
        gesture.radius,
        (candidate) => this.options.canModifyItem(candidate),
      )) {
        if (gesture.versions.size >= MAX_BATCH_OPERATIONS) break;
        if (gesture.versions.has(item.id)) continue;
        gesture.versions.set(item.id, item.version);
        gesture.items.set(item.id, structuredClone(item));
      }
    }
    const hit = this.options.model.hitTest(point, gesture.radius);
    if (
      hit &&
      this.options.canModifyItem(hit) &&
      hit.version > 0 &&
      gesture.versions.size < MAX_BATCH_OPERATIONS &&
      !gesture.versions.has(hit.id)
    ) {
      gesture.versions.set(hit.id, hit.version);
      gesture.items.set(hit.id, structuredClone(hit));
    }
    this.options.renderer.highlightForErase(gesture.versions.keys());
  }

  private async finishGesture(gesture: Gesture): Promise<void> {
    if (gesture.kind === "sticky") {
      const point = tapAdjustedMovePoint(
        gesture.start,
        gesture.current,
        gesture.pointerType,
        this.options.renderer.viewport.zoom,
      );
      if (point === gesture.start) this.options.editText(gesture.start, gesture.item);
      return;
    }
    if (gesture.kind === "stamp") {
      const point = tapAdjustedMovePoint(
        gesture.start,
        gesture.current,
        gesture.pointerType,
        this.options.renderer.viewport.zoom,
      );
      if (point === gesture.start) await this.commitOperation(gesture.operation);
      return;
    }
    if (gesture.kind === "table") {
      const point = tapAdjustedMovePoint(
        gesture.start,
        gesture.current,
        gesture.pointerType,
        this.options.renderer.viewport.zoom,
      );
      if (point === gesture.start) await this.commitTable(gesture.operation);
      return;
    }
    if (gesture.kind === "zone") {
      this.options.renderer.clearLocalPreview();
      await this.commitZone(this.zoneGestureOperation(gesture));
      return;
    }
    if (gesture.kind === "pan") return;
    if (gesture.kind === "pencil") {
      if (gesture.animationFrame !== null) cancelAnimationFrame(gesture.animationFrame);
      this.options.renderer.clearLocalPreview();
      const points = deduplicatePoints(gesture.points).map(
        (point) => [roundBoard(point[0]), roundBoard(point[1])] as Point,
      );
      if (points.length === 1 && points[0]) points.push([points[0][0] + 0.01, points[0][1] + 0.01]);
      if (points.length < 2) {
        this.options.preview(gesture.gestureId, gesture.previewSeq + 1, "gesture.cancel");
        return;
      }
      await this.commitOperation(
        {
          kind: "item.create",
          item: {
            id: gesture.itemId,
            kind: "pencil",
            style: gesture.style,
            transform: identityMatrix(),
            geometry: { points },
          },
        },
        gesture.gestureId,
      );
      return;
    }
    if (gesture.kind === "shape") {
      this.options.renderer.clearLocalPreview();
      const geometry = shapeGeometry(
        gesture.shape,
        gesture.start,
        gesture.current,
        gesture.constrained || gesture.variant === "square" || gesture.variant === "circle",
        gesture.endAnchor !== undefined,
        gesture.variant,
      );
      const isEmpty =
        gesture.shape === "line"
          ? Math.hypot(
              (geometry as LineGeometry).x2 - (geometry as LineGeometry).x1,
              (geometry as LineGeometry).y2 - (geometry as LineGeometry).y1,
            ) < 0.5
          : (geometry as BoxGeometry).width < 0.5 && (geometry as BoxGeometry).height < 0.5;
      if (isEmpty) {
        this.options.preview(gesture.gestureId, gesture.previewSeq + 1, "gesture.cancel");
        return;
      }
      await this.commitOperation(
        buildShapeCreateOperation(
          gesture.itemId,
          gesture.shape,
          geometry,
          gesture.style,
          gesture.variant,
        ),
        gesture.gestureId,
      );
      return;
    }
    if (gesture.kind === "move") {
      const delta = gestureDelta(gesture);
      this.options.renderer.clearLocalPreview();
      if (Math.hypot(delta.x, delta.y) < 0.25) {
        this.options.preview(gesture.gestureId, gesture.previewSeq + 1, "gesture.cancel");
        return;
      }
      let operations: BatchItemOperation[];
      try {
        operations = this.moveOperationsWithSectionMembership(gesture.items, delta);
      } catch (error) {
        if (!(error instanceof GroupingError)) throw error;
        this.options.notify(error.message, "warning");
        return;
      }
      if (operations.length > 0)
        await this.commitOperation({ kind: "items.batch", operations }, gesture.gestureId);
      return;
    }
    if (gesture.kind === "resize-card") {
      this.options.renderer.clearLocalPreview();
      const before = gesture.capture.item.geometry;
      if (
        before.width === gesture.geometry.width &&
        before.height === gesture.geometry.height &&
        before.x === gesture.geometry.x &&
        before.y === gesture.geometry.y
      ) {
        return;
      }
      await this.commitOperation(this.cardResizeOperation(gesture.capture, gesture.geometry));
      return;
    }
    if (gesture.kind === "resize-structured") {
      this.options.renderer.clearLocalPreview();
      if (!structuredResizeChanged(gesture.capture.item, gesture.geometry)) return;
      try {
        await this.commitOperation(this.sectionResizeOperation(gesture.capture, gesture.geometry));
      } catch (error) {
        if (error instanceof GroupingError) {
          this.options.notify(error.message, "warning");
          return;
        }
        throw error;
      }
      return;
    }
    if (gesture.kind === "scale-object" || gesture.kind === "rotate-object") {
      this.options.renderer.clearLocalPreview();
      if (matricesEqual(gesture.transform, gesture.currentTransform)) return;
      await this.commitOperation(
        this.objectTransformOperation(
          { item: gesture.item, expectedVersion: gesture.expectedVersion },
          gesture.currentTransform,
        ),
      );
      return;
    }
    if (gesture.kind === "marquee") {
      const bounds = pointsBounds(gesture.start, gesture.current);
      const hits = this.options.model.intersecting(bounds).map((item) => item.id);
      // Match click selection: touching part of an explicit group selects the
      // whole group, so a marquee can never produce a partial group.
      this.selectOnly(
        this.options.canGroup()
          ? explicitGroupClosure(this.options.model.items.values(), hits).map((item) => item.id)
          : hits,
      );
      return;
    }
    if (gesture.kind === "eraser") {
      this.options.renderer.clearLocalPreview();
      if (!gesture.partial) {
        const directOperations = buildCapturedDeleteOperations(gesture.versions);
        const fittedOperations = fitEraserOperationsWithinBatchLimit(
          directOperations,
          gesture.items,
          this.options.model.items.values(),
        );
        if (fittedOperations.length < directOperations.length) {
          this.options.notify(
            `Some items were left unerased to keep this erase within ${MAX_BATCH_OPERATIONS} item and Section relationship changes.`,
            "warning",
          );
        }
        const fittedIds = new Set(
          fittedOperations.flatMap((operation) =>
            operation.kind === "item.delete" ? [operation.itemId] : [],
          ),
        );
        const erasedItems = [...gesture.items.values()].filter((item) => fittedIds.has(item.id));
        if (erasedItems.length === 0) return;
        try {
          await this.commitOperation(
            buildFullEraserOperation(
              erasedItems,
              this.options.model.items.values(),
              this.options.canModifyItem,
            ),
            gesture.gestureId,
          );
        } catch (error) {
          if (!(error instanceof GroupingError)) throw error;
          this.options.notify(error.message, "warning");
        }
        return;
      }
      const operations: BatchItemOperation[] = [];
      for (const [itemId, expectedVersion] of gesture.versions) {
        const item = gesture.items.get(itemId);
        if (!item) continue;
        if (gesture.partial && isPartiallyErasableItem(item)) {
          const result = eraseStrokeItem(item, gesture.points, gesture.radius);
          if (!result) continue;
          if (result.erased) {
            operations.push({ kind: "item.delete", itemId, expectedVersion });
          } else {
            operations.push(
              buildPartialEraserUpdateOperation(
                item,
                expectedVersion,
                result.visiblePaths,
                this.options.model.items.values(),
                this.options.canGroup(),
              ),
            );
          }
        } else {
          operations.push({ kind: "item.delete", itemId, expectedVersion });
        }
        if (operations.length >= 100) break;
      }
      if (operations.length > 0) {
        try {
          const fittedOperations = fitEraserOperationsWithinBatchLimit(
            operations,
            gesture.items,
            this.options.model.items.values(),
          );
          if (fittedOperations.length < operations.length) {
            this.options.notify(
              `Some items were left unerased to keep this erase within ${MAX_BATCH_OPERATIONS} item and Section relationship changes.`,
              "warning",
            );
          }
          if (fittedOperations.length === 0) return;
          const expanded = expandPartialEraserSectionOperations(
            fittedOperations,
            gesture.items,
            this.options.model.items.values(),
            this.options.canModifyItem,
          );
          await this.commitOperation(
            { kind: "items.batch", operations: expanded },
            gesture.gestureId,
          );
        } catch (error) {
          if (!(error instanceof GroupingError)) throw error;
          this.options.notify(error.message, "warning");
        }
      }
    }
  }

  private cancelGesture(): void {
    const gesture = this.gesture ?? this.pendingLine;
    this.gesture = null;
    this.pendingLine = null;
    if (
      !gesture ||
      gesture.kind === "pan" ||
      gesture.kind === "marquee" ||
      gesture.kind === "sticky" ||
      gesture.kind === "stamp" ||
      gesture.kind === "table" ||
      gesture.kind === "zone" ||
      gesture.kind === "resize-card" ||
      gesture.kind === "resize-structured" ||
      gesture.kind === "scale-object" ||
      gesture.kind === "rotate-object"
    ) {
      this.options.renderer.clearLocalPreview();
      return;
    }
    if (gesture.kind === "pencil" && gesture.animationFrame !== null)
      cancelAnimationFrame(gesture.animationFrame);
    this.options.preview(
      gesture.gestureId,
      "previewSeq" in gesture ? gesture.previewSeq + 1 : 1,
      "gesture.cancel",
    );
    this.options.renderer.clearLocalPreview();
  }

  private async commitOperation(operation: DurableOperation, actionId?: string): Promise<boolean> {
    // Section membership for created items is assigned exactly once, in
    // BoardApp.commit, so every entry point gets identical decoration.
    return this.options.commit(operation, actionId);
  }

  private moveOperationsWithSectionMembership(
    items: ReadonlyMap<string, CapturedMoveItem>,
    delta: { x: number; y: number },
  ): BatchItemOperation[] {
    return buildTranslationMembershipOperations(
      buildCapturedMoveOperations(items, delta),
      this.options.model.items.values(),
      this.options.canGroup(),
      this.options.canModifyItem,
    );
  }

  private objectTransformOperation(
    capture: CapturedObjectTransform,
    transform: Matrix,
  ): BatchItemOperation {
    return buildObjectTransformMembershipOperation(
      capture,
      transform,
      this.options.model.items.values(),
      this.options.canGroup(),
    );
  }

  private cardResizeOperation(
    capture: CapturedCardResize,
    geometry: StickyGeometry | ImageGeometry,
  ): BatchItemOperation {
    return buildCardResizeMembershipOperation(
      capture,
      geometry,
      this.options.model.items.values(),
      this.options.canGroup(),
    );
  }

  private sectionResizeOperation(
    capture: CapturedStructuredResize,
    geometry: TableGeometry | ZoneGeometry,
  ): DurableOperation {
    return buildSectionResizeMembershipOperation(
      capture,
      geometry,
      this.options.model.items.values(),
      this.options.canModifyItem,
      this.options.canGroup(),
    );
  }

  private async commitTable(operation: BatchItemOperation): Promise<void> {
    if (await this.commitOperation(operation)) this.setTool("select");
  }

  private renderSelection(): void {
    const [selectedId] = this.selected.size === 1 ? this.selected : [];
    const selected = selectedId ? this.options.model.getItem(selectedId) : undefined;
    this.options.renderer.setResizeHandlesEnabled(
      Boolean(selected && this.options.canDraw() && this.options.canModifyItem(selected)),
    );
    this.options.renderer.setSelection(this.selected);
  }

  /** A second tap on the same note or text within a beat opens it for editing. */
  private handleEditableTap(item: TapEditableItem, point: Point): void {
    const now = performance.now();
    if (this.lastStickyTap?.itemId === item.id && now - this.lastStickyTap.at <= 450) {
      this.lastStickyTap = null;
      this.options.editText(point, item);
      return;
    }
    this.lastStickyTap = { itemId: item.id, at: now };
  }

  private handleTableTap(item: Extract<BoardItem, { kind: "table" }>, point: Point): void {
    const cell = tableCellAtPoint(item, point);
    if (!cell) {
      this.lastTableTap = null;
      return;
    }
    const now = performance.now();
    if (
      this.lastTableTap?.itemId === item.id &&
      this.lastTableTap.row === cell.row &&
      this.lastTableTap.column === cell.column &&
      now - this.lastTableTap.at <= 450
    ) {
      this.lastTableTap = null;
      this.options.editTableCell(item, cell.row, cell.column);
      return;
    }
    this.lastTableTap = { itemId: item.id, ...cell, at: now };
  }

  private handleZoneTap(item: Extract<BoardItem, { kind: "zone" }>): void {
    const now = performance.now();
    if (this.lastZoneTap?.itemId === item.id && now - this.lastZoneTap.at <= 450) {
      this.openZoneTitleEditor(item);
      return;
    }
    this.lastZoneTap = { itemId: item.id, at: now };
  }

  private openZoneTitleEditor(item: Extract<BoardItem, { kind: "zone" }>): void {
    this.lastZoneTap = null;
    if (!this.options.canDraw()) return;
    if (item.version <= 0) {
      this.options.notify("Wait for the section to finish saving before renaming it.", "info");
      return;
    }
    this.options.editZoneTitle(item);
  }

  private renderZoneGesture(gesture: Extract<Gesture, { kind: "zone" }>): void {
    const operation = this.zoneGestureOperation(gesture);
    this.options.renderer.showLocalZone(operation.item.geometry, operation.item.style);
  }

  private zoneGestureOperation(gesture: Extract<Gesture, { kind: "zone" }>): ZoneCreateOperation {
    return buildDraggedZoneCreateOperation(
      gesture.itemId,
      gesture.start,
      tapAdjustedMovePoint(
        gesture.start,
        gesture.current,
        gesture.pointerType,
        this.options.renderer.viewport.zoom,
      ),
    );
  }

  private async commitZone(operation: ZoneCreateOperation): Promise<void> {
    let durable: DurableOperation = operation;
    if (this.options.canGroup()) {
      try {
        durable = buildSectionCreateMembershipOperation(
          operation,
          this.options.model.items.values(),
          this.options.canModifyItem,
        );
      } catch (error) {
        if (error instanceof GroupingError) {
          this.options.notify(error.message, "warning");
          return;
        }
        throw error;
      }
    }
    if (await this.commitOperation(durable)) this.options.onZoneCreated(operation.item.id);
  }
}

function structuredResizeHandleFromDataset(dataset: DOMStringMap): StructuredResizeHandle | null {
  if (dataset.resizeHandle === "southeast") return { kind: "southeast" };
  if (dataset.resizeHandle !== "table-column" && dataset.resizeHandle !== "table-row") return null;
  const index = Number(dataset.resizeIndex);
  if (!Number.isSafeInteger(index) || index < 0) return null;
  return { kind: dataset.resizeHandle, index };
}

function structuredResizeHandleApplies(
  item: Extract<BoardItem, { kind: "table" | "zone" }>,
  handle: StructuredResizeHandle,
): boolean {
  if (item.kind === "zone") return handle.kind === "southeast";
  if (handle.kind === "southeast") return true;
  return handle.kind === "table-column"
    ? handle.index < item.geometry.columnWidths.length
    : handle.index < item.geometry.rowHeights.length;
}

function structuredResizeChanged(
  item: Extract<BoardItem, { kind: "table" | "zone" }>,
  geometry: TableGeometry | ZoneGeometry,
): boolean {
  if (item.kind === "zone") {
    return (
      "width" in geometry &&
      (item.geometry.width !== geometry.width || item.geometry.height !== geometry.height)
    );
  }
  if (!("columnWidths" in geometry)) return false;
  return (
    item.geometry.columnWidths.some((width, index) => width !== geometry.columnWidths[index]) ||
    item.geometry.rowHeights.some((height, index) => height !== geometry.rowHeights[index])
  );
}

function boardPoint(
  event: Pick<PointerEvent, "clientX" | "clientY">,
  renderer: BoardRenderer,
): Point {
  const point = renderer.viewport.clientToBoard(event.clientX, event.clientY);
  return [roundBoard(point[0]), roundBoard(point[1])];
}

export function resolveConnectorEndpoint(
  model: Pick<BoardModel, "nearestConnectorAnchor">,
  point: Point,
  zoom: number,
  options: {
    lockedAnchor?: ConnectorAnchor;
    excludedItemIds?: ReadonlySet<string>;
  } = {},
): { point: Point; anchor?: ConnectorAnchor } {
  const scale = Math.max(0.1, zoom);
  const threshold = CONNECTOR_SNAP_RADIUS_CSS_PX / scale;
  const anchor = model.nearestConnectorAnchor(point, threshold, options.excludedItemIds);
  if (anchor) return { point: anchor.point, anchor };
  const lockedAnchor = options.lockedAnchor;
  const releaseThreshold = CONNECTOR_SNAP_RELEASE_RADIUS_CSS_PX / scale;
  if (
    lockedAnchor &&
    !options.excludedItemIds?.has(lockedAnchor.itemId) &&
    pointDistance(point, lockedAnchor.point) <= releaseThreshold
  ) {
    return { point: lockedAnchor.point, anchor: lockedAnchor };
  }
  return { point };
}

export type ResolvedProtractorCenterMove = {
  current: Point;
  center: Point;
  anchor?: ConnectorAnchor;
};

export function resolveProtractorCenterMove(
  start: Point,
  point: Point,
  originalCenter: Point,
  itemId: string,
  model: Pick<BoardModel, "nearestConnectorAnchor">,
  zoom: number,
  lockedAnchor?: ConnectorAnchor,
): ResolvedProtractorCenterMove {
  const intendedCenter: Point = [
    originalCenter[0] + point[0] - start[0],
    originalCenter[1] + point[1] - start[1],
  ];
  const resolved = resolveConnectorEndpoint(model, intendedCenter, zoom, {
    lockedAnchor,
    excludedItemIds: new Set([itemId]),
  });
  if (!resolved.anchor) return { current: point, center: intendedCenter };
  return {
    current: [
      point[0] + resolved.point[0] - intendedCenter[0],
      point[1] + resolved.point[1] - intendedCenter[1],
    ],
    center: resolved.point,
    anchor: resolved.anchor,
  };
}

export type ResolvedShapePointerState = {
  current: Point;
  constrained: boolean;
  endAnchor?: ConnectorAnchor;
};

export function resolveShapePointerState(
  shape: ShapeTool,
  point: Point,
  constrained: boolean,
  model: Pick<BoardModel, "nearestConnectorAnchor">,
  zoom: number,
  snapEnabled = true,
  lockedAnchor?: ConnectorAnchor,
): ResolvedShapePointerState {
  if (shape !== "line" || !snapEnabled) return { current: point, constrained };
  const resolved = resolveConnectorEndpoint(model, point, zoom, { lockedAnchor });
  return resolved.anchor
    ? { current: resolved.point, constrained, endAnchor: resolved.anchor }
    : { current: point, constrained };
}

function applyShapePointerState(
  gesture: Extract<Gesture, { kind: "shape" }>,
  state: ResolvedShapePointerState,
): void {
  gesture.current = state.current;
  gesture.constrained = state.constrained;
  if (state.endAnchor) gesture.endAnchor = state.endAnchor;
  else delete gesture.endAnchor;
}

function appendUniquePoint(points: Point[], point: Point): void {
  const previous = points.at(-1);
  if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) points.push(point);
}

function deduplicatePoints(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) appendUniquePoint(result, point);
  return result;
}

export function shapeGeometry(
  shape: ShapeTool,
  start: Point,
  end: Point,
  constrained: boolean,
  endpointSnapped = false,
  variant?: ShapeVariant,
): LineGeometry | BoxGeometry | PolygonGeometry | RectangleGeometry {
  let next = end;
  if (shape === "line" && constrained && !endpointSnapped) {
    const distance = pointDistance(start, end);
    const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
    const snapped = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
    next = [start[0] + Math.cos(snapped) * distance, start[1] + Math.sin(snapped) * distance];
  }
  if (shape === "line") {
    return { x1: start[0], y1: start[1], x2: roundBoard(next[0]), y2: roundBoard(next[1]) };
  }
  let dx = next[0] - start[0];
  let dy = next[1] - start[1];
  if (constrained) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * size;
    dy = Math.sign(dy || 1) * size;
  }
  const box = {
    x: roundBoard(Math.min(start[0], start[0] + dx)),
    y: roundBoard(Math.min(start[1], start[1] + dy)),
    width: roundBoard(Math.abs(dx)),
    height: roundBoard(Math.abs(dy)),
  };
  if (shape === "rectangle") {
    return { ...box, shape: variant === "square" ? "square" : "rectangle" };
  }
  if (shape !== "polygon") return box;
  return { ...box, polygon: isPolygonVariant(variant) ? variant : "triangle" };
}

function gestureDelta(gesture: Extract<Gesture, { kind: "move" }>): { x: number; y: number } {
  return {
    x: roundBoard(gesture.current[0] - gesture.start[0]),
    y: roundBoard(gesture.current[1] - gesture.start[1]),
  };
}

function pointsBounds(start: Point, end: Point): Bounds {
  return {
    minX: Math.min(start[0], end[0]),
    minY: Math.min(start[1], end[1]),
    maxX: Math.max(start[0], end[0]),
    maxY: Math.max(start[1], end[1]),
  };
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function pointerAngle(pivot: Point, point: Point): number {
  return Math.atan2(point[1] - pivot[1], point[0] - pivot[0]);
}

export function rotationDelta(
  startAngle: number,
  currentAngle: number,
  constrained: boolean,
): number {
  let delta = currentAngle - startAngle;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  if (constrained) {
    const step = Math.PI / 12;
    delta = Math.round(delta / step) * step;
  }
  return delta;
}

export function rotatedMatrix(matrix: Matrix, radians: number): Matrix {
  return rotatedMatrixAroundLocalPoint(matrix, radians, [0, 0]);
}

function matricesEqual(left: Matrix, right: Matrix): boolean {
  return left.every((value, index) => value === right[index]);
}

function midpoint(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function identityMatrix(): Matrix {
  return [1, 0, 0, 1, 0, 0];
}

function isPolygonVariant(value: ShapeVariant | undefined): value is PolygonKind {
  return value === "triangle" || value === "rhombus" || value === "pentagon" || value === "hexagon";
}

function shapeVariantForTool(tool: Exclude<ShapeTool, "line">, style: StyleState): ShapeVariant {
  if (tool === "ellipse") return "circle";
  if (tool === "polygon")
    return isPolygonVariant(style.shapeVariant) ? style.shapeVariant : "triangle";
  return style.shapeVariant === "square" ? "square" : "rectangle";
}

export function buildProtractorCreateOperation(
  itemId: string,
  point: Point,
  style: Pick<StyleState, "color" | "opacity">,
): BatchItemOperation {
  const protractorStyle: ProtractorStyle = {
    kind: "protractor",
    color: style.color,
    opacity: style.opacity,
  };
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "protractor",
      style: protractorStyle,
      transform: [1, 0, 0, 1, roundBoard(point[0]), roundBoard(point[1])],
      geometry: { radius: DEFAULT_PROTRACTOR_RADIUS },
    },
  };
}

export function tableCellAtPoint(
  item: Pick<Extract<BoardItem, { kind: "table" }>, "geometry" | "transform">,
  point: Point,
): { row: number; column: number } | null {
  const local = inverseTransformPoint(point, item.transform);
  if (!local) return null;
  const x = local[0] - item.geometry.x;
  const y = local[1] - item.geometry.y;
  const column = axisIndex(x, item.geometry.columnWidths);
  const row = axisIndex(y, item.geometry.rowHeights);
  return row === null || column === null ? null : { row, column };
}

function inverseTransformPoint(point: Point, matrix: Matrix): Point | null {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) return null;
  const x = point[0] - e;
  const y = point[1] - f;
  return [(d * x - c * y) / determinant, (-b * x + a * y) / determinant];
}

function axisIndex(position: number, sizes: readonly number[]): number | null {
  if (position < 0) return null;
  let edge = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    edge += sizes[index] ?? 0;
    if (position < edge || (index === sizes.length - 1 && position <= edge)) return index;
  }
  return null;
}

export function buildShapeCreateOperation(
  itemId: string,
  shape: ShapeTool,
  geometry: LineGeometry | BoxGeometry | PolygonGeometry,
  style: StrokeStyle | LineStyle,
  variant?: ShapeVariant,
): BatchItemOperation {
  if (shape === "line") {
    if (!("x1" in geometry)) throw new Error("Line geometry is invalid.");
    if (style.kind !== "line") throw new Error("Line style is invalid.");
    return {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "line",
        style,
        transform: identityMatrix(),
        geometry,
      },
    };
  }
  if (!("width" in geometry)) throw new Error("Box geometry is invalid.");
  if (style.kind !== "stroke") throw new Error("Shape style is invalid.");
  if (shape === "rectangle") {
    return {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "rectangle",
        style,
        transform: identityMatrix(),
        geometry: {
          ...geometry,
          shape: variant === "square" ? "square" : "rectangle",
        },
      },
    };
  }
  if (shape === "polygon") {
    return {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "polygon",
        style,
        transform: identityMatrix(),
        geometry: {
          ...geometry,
          polygon: isPolygonVariant(variant) ? variant : "triangle",
        } as PolygonGeometry,
      },
    };
  }
  return {
    kind: "item.create",
    item: {
      id: itemId,
      kind: "ellipse",
      style,
      transform: identityMatrix(),
      geometry,
    },
  };
}

/** Objects a double tap with the select tool opens for editing: notes and plain text. */
type TapEditableItem = Extract<BoardItem, { kind: "sticky" | "text" }>;

function isTapEditable(item: BoardItem | undefined): item is TapEditableItem {
  if (!item) return false;
  if (item.kind === "sticky") return true;
  // A video card is a text object carrying an embed; its text is not for editing in place.
  return item.kind === "text" && item.geometry.embed !== "video";
}

function pointFromItem(item: TapEditableItem): Point {
  return [item.geometry.x, item.geometry.y];
}

function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !==
      null
  );
}

function isOpenDialogTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("dialog[open]") !== null;
}

/**
 * Attaches each created non-Section item to the topmost Section that
 * geometrically contains it, considering existing Sections and Sections
 * created earlier in the same batch. Items that already carry a sectionId are
 * left alone. This is the only implementation; BoardApp.commit calls it once
 * per commit so controller and app entry points decorate identically.
 */
export function assignCreatedItemsToSections(
  operation: DurableOperation,
  items: Iterable<BoardItem>,
): DurableOperation {
  const children =
    operation.kind === "items.batch"
      ? operation.operations
      : operation.kind === "item.create" ||
          operation.kind === "item.update" ||
          operation.kind === "item.delete" ||
          operation.kind === "item.copy"
        ? [operation]
        : [];
  if (children.length === 0) return operation;
  const savedItems = [...items];
  const baseZ = Math.max(0, ...savedItems.map((item) => item.z));
  const provisional = (
    child: Extract<BatchItemOperation, { kind: "item.create" }>,
    index: number,
  ): BoardItem =>
    ({ ...child.item, z: baseZ + index + 1, version: 0, createdBy: child.item.id }) as BoardItem;
  const createdSections = children.flatMap((child, index) =>
    child.kind === "item.create" && child.item.kind === "zone" ? [provisional(child, index)] : [],
  );
  const candidates = [...savedItems, ...createdSections];
  const decorate = (child: BatchItemOperation, index: number): BatchItemOperation => {
    if (
      child.kind !== "item.create" ||
      child.item.kind === "zone" ||
      child.item.sectionId !== undefined
    ) {
      return child;
    }
    const sectionId = containingSectionIdFromItems(candidates, provisional(child, index));
    return sectionId
      ? ({ ...child, item: { ...child.item, sectionId } } as BatchItemOperation)
      : child;
  };
  if (operation.kind === "items.batch") {
    return { ...operation, operations: operation.operations.map(decorate) };
  }
  return decorate(operation as BatchItemOperation, 0);
}

function containingSectionIdFromItems(
  items: Iterable<BoardItem>,
  item: BoardItem,
  sectionOverrides: ReadonlyMap<string, Extract<BoardItem, { kind: "zone" }>> = new Map(),
): string | undefined {
  const candidateBounds = itemBounds(item);
  return [...items]
    .filter(
      (candidate): candidate is Extract<BoardItem, { kind: "zone" }> => candidate.kind === "zone",
    )
    .map((section) => sectionOverrides.get(section.id) ?? section)
    .filter((section) => boundsContain(itemBounds(section), candidateBounds))
    .sort((left, right) => right.z - left.z || left.id.localeCompare(right.id))[0]?.id;
}

export function sectionIdAfterBoundsChange(
  items: Iterable<BoardItem>,
  item: BoardItem,
  assignNewMembership: boolean,
  sectionOverrides: ReadonlyMap<string, Extract<BoardItem, { kind: "zone" }>> = new Map(),
): string | undefined {
  if (assignNewMembership) return containingSectionIdFromItems(items, item, sectionOverrides);
  if (!item.sectionId) return undefined;
  const section = [...items].find(
    (candidate): candidate is Extract<BoardItem, { kind: "zone" }> =>
      candidate.kind === "zone" && candidate.id === item.sectionId,
  );
  const prospectiveSection = section ? (sectionOverrides.get(section.id) ?? section) : undefined;
  return prospectiveSection && boundsContain(itemBounds(prospectiveSection), itemBounds(item))
    ? item.sectionId
    : undefined;
}

export function buildObjectTransformMembershipOperation(
  capture: CapturedObjectTransform,
  transform: Matrix,
  items: Iterable<BoardItem>,
  assignNewMembership = true,
): BatchItemOperation {
  const update = buildCapturedObjectTransformOperation(capture, transform);
  const transformedItem = { ...capture.item, transform } as BoardItem;
  const sectionId = sectionIdAfterBoundsChange(items, transformedItem, assignNewMembership);
  if (sectionId === capture.item.sectionId) return update;
  return {
    ...update,
    patch: { ...update.patch, sectionId: sectionId ?? null },
  };
}

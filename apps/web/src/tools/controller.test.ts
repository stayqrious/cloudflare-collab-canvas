import { MAX_BATCH_OPERATIONS } from "@collab/protocol";
import { describe, expect, it } from "vitest";
import type { BatchItemOperation, BoardItem, Matrix } from "../types";
import {
  buildCapturedCardResizeOperation,
  buildCapturedDeleteOperations,
  buildCapturedMoveOperations,
  buildCapturedTextUpdate,
  buildCardResizeMembershipOperation,
  buildDraggedZoneCreateOperation,
  buildFullEraserOperation,
  buildImageCreateOperation,
  buildObjectTransformMembershipOperation,
  buildPartialEraserUpdateOperation,
  buildSectionCreateMembershipOperation,
  buildSectionDeleteMembershipOperation,
  buildSectionResizeMembershipOperation,
  buildShapeCreateOperation,
  buildStampCreateOperation,
  buildStickyCreateOperation,
  buildTableCreateOperation,
  buildTranslationMembershipOperations,
  buildUngroupedCopyOperation,
  buildZoneCreateOperation,
  type CapturedMoveItem,
  cardResizeGrabOffset,
  defaultImageCardSize,
  draggedZoneGeometry,
  effectiveMoveItemsWithinBatchLimit,
  expandPartialEraserSectionOperations,
  fitEraserOperationsWithinBatchLimit,
  lineCreationReleaseAction,
  resizedCardGeometry,
  resolveConnectorEndpoint,
  resolveProtractorCenterMove,
  resolveShapePointerState,
  selectionHitPadding,
  shapeGeometry,
  stickyTapMoveThreshold,
  tableCellAtPoint,
  tapAdjustedMovePoint,
  toolFromShortcut,
} from "./controller";
import { GroupingError } from "./grouping";
import { MIN_RESIZED_ZONE_HEIGHT, MIN_RESIZED_ZONE_WIDTH } from "./resize";

const ITEM_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abd";
const SECTION_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abe";

function sectionItem(width = 200, height = 200): Extract<BoardItem, { kind: "zone" }> {
  return {
    id: SECTION_ID,
    kind: "zone",
    z: 1,
    version: 7,
    createdBy: "teacher-a",
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "zone",
      borderColor: "#d4d4d4",
      fill: "#a8daff",
      textColor: "#1e1e1e",
      fontSize: 18,
      opacity: 0.18,
    },
    geometry: { x: 0, y: 0, width, height, title: "Section" },
  };
}

function stickyItem(
  id: string,
  x: number,
  y: number,
  createdBy: string,
  sectionId?: string,
): Extract<BoardItem, { kind: "sticky" }> {
  return {
    id,
    kind: "sticky",
    z: 2,
    version: 4,
    createdBy,
    ...(sectionId === undefined ? {} : { sectionId }),
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#292524",
      fontSize: 20,
      opacity: 1,
    },
    geometry: { x, y, width: 40, height: 40, text: "Idea" },
  };
}

describe("captured gesture operations", () => {
  it("uses a finger-friendly CSS-pixel tolerance for sticky double taps", () => {
    expect(stickyTapMoveThreshold("touch", 1)).toBe(10);
    expect(stickyTapMoveThreshold("touch", 2)).toBe(5);
    expect(stickyTapMoveThreshold("mouse", 1)).toBe(3);
  });

  it("arms a first line click for mouse and touch, then commits the second click", () => {
    expect(lineCreationReleaseAction("first", [20, 30], [22.9, 30], "mouse", 1)).toBe("arm");
    expect(lineCreationReleaseAction("first", [20, 30], [24.9, 30], "touch", 2)).toBe("arm");
    expect(lineCreationReleaseAction("first", [20, 30], [23.1, 30], "mouse", 1)).toBe("commit");
    expect(lineCreationReleaseAction("second", [20, 30], [20, 30], "touch", 1)).toBe("commit");
  });

  it("keeps selection padding comfortable in CSS pixels across zoom levels", () => {
    expect(selectionHitPadding("mouse", 1)).toBe(5);
    expect(selectionHitPadding("mouse", 2)).toBe(2.5);
    expect(selectionHitPadding("touch", 1)).toBe(16);
    expect(selectionHitPadding("touch", 0.5)).toBe(32);
  });

  it("suppresses mouse tap jitter before move finalization", () => {
    const start = [20, 30] as const;
    expect(tapAdjustedMovePoint(start, [22.9, 30], "mouse", 1)).toBe(start);
    expect(tapAdjustedMovePoint(start, [23.1, 30], "mouse", 1)).toEqual([23.1, 30]);
  });

  it("distinguishes a touch stamp tap from a drag at the current zoom", () => {
    const start = [40, 50] as const;
    expect(tapAdjustedMovePoint(start, [44.9, 50], "touch", 2)).toBe(start);
    expect(tapAdjustedMovePoint(start, [45.1, 50], "touch", 2)).toEqual([45.1, 50]);
  });

  it("does not activate editing shortcuts while drawing is read only", () => {
    expect(toolFromShortcut("n", false)).toBeUndefined();
    expect(toolFromShortcut("N", true)).toBe("sticky");
    expect(toolFromShortcut("k", false)).toBeUndefined();
    expect(toolFromShortcut("K", true)).toBe("stamp");
    expect(toolFromShortcut("i", false)).toBeUndefined();
    expect(toolFromShortcut("I", true)).toBe("image");
    expect(toolFromShortcut("g", false)).toBeUndefined();
    expect(toolFromShortcut("G", true)).toBe("table");
    expect(toolFromShortcut("z", false)).toBeUndefined();
    expect(toolFromShortcut("Z", true)).toBe("zone");
    expect(toolFromShortcut("v", false)).toBe("select");
    expect(toolFromShortcut("h", false)).toBe("pan");
  });

  it("uses the move version and transform captured at pointer down", () => {
    const transform: Matrix = [1, 0, 0, 1, 4, 7];
    const captured = new Map<string, CapturedMoveItem>([
      [ITEM_ID, { transform, expectedVersion: 3 }],
    ]);

    expect(buildCapturedMoveOperations(captured, { x: 10, y: -2 })).toEqual([
      {
        kind: "item.update",
        itemId: ITEM_ID,
        expectedVersion: 3,
        patch: { transform: [1, 0, 0, 1, 14, 5] },
      },
    ]);
  });

  it("allows a Section move at the atomic batch boundary", () => {
    const section = sectionItem();
    const members = Array.from({ length: MAX_BATCH_OPERATIONS - 1 }, (_, index) =>
      stickyItem(`member-${index}`, 20, 20, "teacher-a", SECTION_ID),
    );

    expect(
      effectiveMoveItemsWithinBatchLimit([section, ...members], [SECTION_ID], true),
    ).toHaveLength(MAX_BATCH_OPERATIONS);
  });

  it("rejects a move whose Section closure exceeds the atomic batch limit", () => {
    const section = sectionItem();
    const members = Array.from({ length: MAX_BATCH_OPERATIONS }, (_, index) =>
      stickyItem(`member-${index}`, 20, 20, "teacher-a", SECTION_ID),
    );

    expect(() =>
      effectiveMoveItemsWithinBatchLimit([section, ...members], [SECTION_ID], true),
    ).toThrow(`Move ${MAX_BATCH_OPERATIONS} related items or fewer at once.`);
  });

  it("rejects an oversized ungrouped move selection", () => {
    const selected = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, index) =>
      stickyItem(`selected-${index}`, index * 50, 20, "teacher-a"),
    );

    expect(() =>
      effectiveMoveItemsWithinBatchLimit(
        selected,
        selected.map((item) => item.id),
        false,
      ),
    ).toThrow(GroupingError);
  });

  it("uses the first version captured by the eraser", () => {
    const captured = new Map([[ITEM_ID, 8]]);

    expect(buildCapturedDeleteOperations(captured)).toEqual([
      { kind: "item.delete", itemId: ITEM_ID, expectedVersion: 8 },
    ]);
  });

  it("moves Section members with Arrange and recomputes individual membership", () => {
    const section = sectionItem();
    const member = stickyItem("member-a", 20, 20, "teacher-a", SECTION_ID);
    const independent = stickyItem("member-b", 20, 80, "teacher-a", SECTION_ID);
    const operations = buildTranslationMembershipOperations(
      [
        {
          kind: "item.update",
          itemId: SECTION_ID,
          expectedVersion: section.version,
          patch: { transform: [1, 0, 0, 1, 100, 0] },
        },
      ],
      [section, member, independent],
      true,
      () => true,
    );

    expect(operations).toEqual([
      {
        kind: "item.update",
        itemId: SECTION_ID,
        expectedVersion: section.version,
        patch: { transform: [1, 0, 0, 1, 100, 0] },
      },
      {
        kind: "item.update",
        itemId: member.id,
        expectedVersion: member.version,
        patch: { transform: [1, 0, 0, 1, 100, 0] },
      },
      {
        kind: "item.update",
        itemId: independent.id,
        expectedVersion: independent.version,
        patch: { transform: [1, 0, 0, 1, 100, 0] },
      },
    ]);

    expect(
      buildTranslationMembershipOperations(
        [
          {
            kind: "item.update",
            itemId: member.id,
            expectedVersion: member.version,
            patch: { transform: [1, 0, 0, 1, 300, 0] },
          },
        ],
        [section, member],
        true,
        () => true,
      ),
    ).toEqual([
      {
        kind: "item.update",
        itemId: member.id,
        expectedVersion: member.version,
        patch: { transform: [1, 0, 0, 1, 300, 0], sectionId: null },
      },
    ]);
  });

  it("preserves a direct member update when its Section also moves", () => {
    const section = sectionItem();
    const member = stickyItem("member-a", 20, 20, "teacher-a", SECTION_ID);
    const directUpdates: Array<Extract<BatchItemOperation, { kind: "item.update" }>> = [
      {
        kind: "item.update",
        itemId: section.id,
        expectedVersion: section.version,
        patch: { transform: [1, 0, 0, 1, 100, 0] },
      },
      {
        kind: "item.update",
        itemId: member.id,
        expectedVersion: member.version,
        patch: { transform: [1, 0, 0, 1, 150, 0] },
      },
    ];

    expect(
      buildTranslationMembershipOperations(directUpdates, [section, member], true, () => true),
    ).toEqual(directUpdates);
  });

  it("moves non-sticky explicit-group peers with Arrange and includes them in guards", () => {
    const groupId = "018f47a1-7a2b-7c3d-8e4f-123456789ac0";
    const selected = {
      ...stickyItem(ITEM_ID, 20, 20, "teacher-a"),
      groupId,
    };
    const peer: Extract<BoardItem, { kind: "rectangle" }> = {
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac1",
      kind: "rectangle",
      groupId,
      z: 3,
      version: 6,
      createdBy: "teacher-a",
      transform: [1, 0, 0, 1, 10, 15],
      style: { kind: "stroke", color: "#20201e", width: 2, opacity: 1 },
      geometry: { x: 80, y: 20, width: 40, height: 40, shape: "rectangle" },
    };
    const directUpdates = [
      {
        kind: "item.update" as const,
        itemId: selected.id,
        expectedVersion: selected.version,
        patch: { transform: [1, 0, 0, 1, 100, 30] as Matrix },
      },
    ];

    expect(
      buildTranslationMembershipOperations(directUpdates, [selected, peer], true, () => true),
    ).toEqual([
      directUpdates[0],
      {
        kind: "item.update",
        itemId: peer.id,
        expectedVersion: peer.version,
        patch: { transform: [1, 0, 0, 1, 110, 45] },
      },
    ]);

    expect(() =>
      buildTranslationMembershipOperations(
        directUpdates,
        [selected, peer],
        true,
        (item) => item.id !== peer.id,
      ),
    ).toThrow("This arrangement includes a related item you cannot modify.");
    expect(() =>
      buildTranslationMembershipOperations(directUpdates, [selected, peer], true, () => true, 1),
    ).toThrow("Arrange 1 related items or fewer at a time.");
  });

  it("clears stale membership without assigning new membership when grouping is disabled", () => {
    const section = sectionItem();
    const member = stickyItem("member-a", 20, 20, "teacher-a", SECTION_ID);
    const unassigned = stickyItem("member-b", 260, 20, "teacher-a");

    expect(
      buildTranslationMembershipOperations(
        [
          {
            kind: "item.update",
            itemId: member.id,
            expectedVersion: member.version,
            patch: { transform: [1, 0, 0, 1, 300, 0] },
          },
          {
            kind: "item.update",
            itemId: unassigned.id,
            expectedVersion: unassigned.version,
            patch: { transform: [1, 0, 0, 1, -260, 0] },
          },
        ],
        [section, member, unassigned],
        false,
        () => true,
      ),
    ).toEqual([
      {
        kind: "item.update",
        itemId: member.id,
        expectedVersion: member.version,
        patch: { transform: [1, 0, 0, 1, 300, 0], sectionId: null },
      },
      {
        kind: "item.update",
        itemId: unassigned.id,
        expectedVersion: unassigned.version,
        patch: { transform: [1, 0, 0, 1, -260, 0] },
      },
    ]);
  });

  it("expands a full-eraser Section delete to surviving memberships", () => {
    const section = sectionItem();
    const member = stickyItem("member-a", 20, 20, "teacher-a", SECTION_ID);

    expect(buildFullEraserOperation([section], [section, member], () => true)).toEqual({
      kind: "items.batch",
      operations: [
        {
          kind: "item.delete",
          itemId: SECTION_ID,
          expectedVersion: section.version,
        },
        {
          kind: "item.update",
          itemId: member.id,
          expectedVersion: member.version,
          patch: { sectionId: null },
        },
      ],
    });
  });

  it("expands a partial-eraser Section delete to surviving memberships", () => {
    const section = sectionItem();
    const member = stickyItem("member-a", 20, 20, "teacher-a", SECTION_ID);
    const sectionDelete: BatchItemOperation = {
      kind: "item.delete",
      itemId: section.id,
      expectedVersion: section.version,
    };

    expect(
      expandPartialEraserSectionOperations(
        [sectionDelete],
        new Map([[section.id, section]]),
        [section, member],
        () => true,
      ),
    ).toEqual([
      sectionDelete,
      {
        kind: "item.update",
        itemId: member.id,
        expectedVersion: member.version,
        patch: { sectionId: null },
      },
    ]);
  });

  it("recomputes Section membership from partial-erasure bounds", () => {
    const lowerSection = sectionItem(300, 200);
    const higherSection = {
      ...sectionItem(100, 100),
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac2",
      z: 10,
      transform: [1, 0, 0, 1, 100, 0] as Matrix,
    };
    const line: Extract<BoardItem, { kind: "line" }> = {
      id: ITEM_ID,
      kind: "line",
      sectionId: lowerSection.id,
      z: 2,
      version: 8,
      createdBy: "teacher-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "line", color: "#20201e", width: 2, opacity: 1, arrowhead: "none" },
      geometry: { x1: 20, y1: 20, x2: 250, y2: 20 },
    };
    const visiblePaths: Array<Array<[number, number]>> = [
      [
        [120, 20],
        [150, 20],
      ],
    ];

    expect(
      buildPartialEraserUpdateOperation(line, line.version, visiblePaths, [
        lowerSection,
        higherSection,
        line,
      ]),
    ).toEqual({
      kind: "item.update",
      itemId: line.id,
      expectedVersion: line.version,
      patch: { geometry: { ...line.geometry, visiblePaths }, sectionId: higherSection.id },
    });
  });

  it("skips eraser captures whose Section cleanup would exceed the batch limit", () => {
    const section = sectionItem();
    const members = Array.from({ length: MAX_BATCH_OPERATIONS }, (_, index) =>
      stickyItem(`member-${index}`, 20, 20, "teacher-a", SECTION_ID),
    );
    const independent = stickyItem(ITEM_ID, 400, 20, "teacher-a");
    const captured = new Map<string, BoardItem>([
      [section.id, section],
      [independent.id, independent],
    ]);
    const operations = buildCapturedDeleteOperations(
      new Map([
        [section.id, section.version],
        [independent.id, independent.version],
      ]),
    );

    expect(
      fitEraserOperationsWithinBatchLimit(operations, captured, [section, ...members, independent]),
    ).toEqual([
      {
        kind: "item.delete",
        itemId: independent.id,
        expectedVersion: independent.version,
      },
    ]);
  });

  it("keeps partial erasure within the limit after Section cleanup expansion", () => {
    const section = sectionItem();
    const member = stickyItem("member-a", 20, 20, "teacher-a", SECTION_ID);
    const independent = stickyItem(ITEM_ID, 400, 20, "teacher-a");
    const partialUpdate: BatchItemOperation = {
      kind: "item.update",
      itemId: independent.id,
      expectedVersion: independent.version,
      patch: { transform: independent.transform },
    };
    const sectionDelete: BatchItemOperation = {
      kind: "item.delete",
      itemId: section.id,
      expectedVersion: section.version,
    };
    const captured = new Map<string, BoardItem>([
      [section.id, section],
      [independent.id, independent],
    ]);

    expect(
      fitEraserOperationsWithinBatchLimit(
        [partialUpdate, sectionDelete],
        captured,
        [section, member, independent],
        2,
      ),
    ).toEqual([partialUpdate]);
  });

  it("clears inherited relationships in the grouping-disabled copy fallback", () => {
    const related = {
      ...stickyItem(ITEM_ID, 20, 20, "teacher-a", SECTION_ID),
      groupId: "018f47a1-7a2b-7c3d-8e4f-123456789ac0",
    };

    expect(buildUngroupedCopyOperation(related, "018f47a1-7a2b-7c3d-8e4f-123456789ac1")).toEqual({
      kind: "item.copy",
      sourceItemId: ITEM_ID,
      expectedVersion: related.version,
      newItemId: "018f47a1-7a2b-7c3d-8e4f-123456789ac1",
      translate: { x: 20, y: 20 },
      newGroupId: null,
      newSectionId: null,
    });

    const plain = stickyItem(ITEM_ID, 20, 20, "teacher-a");
    expect(buildUngroupedCopyOperation(plain, "018f47a1-7a2b-7c3d-8e4f-123456789ac2")).toEqual({
      kind: "item.copy",
      sourceItemId: ITEM_ID,
      expectedVersion: plain.version,
      newItemId: "018f47a1-7a2b-7c3d-8e4f-123456789ac2",
      translate: { x: 20, y: 20 },
    });
  });

  it("resolves connector snapping in CSS pixels at the current zoom", () => {
    let receivedThreshold = 0;
    const anchor = {
      itemId: ITEM_ID,
      point: [100, 50] as const,
      z: 4,
      distance: 7,
    };
    const model = {
      nearestConnectorAnchor: (_point: readonly [number, number], threshold: number) => {
        receivedThreshold = threshold;
        return anchor;
      },
    };

    expect(resolveConnectorEndpoint(model, [94, 53], 2)).toEqual({ point: [100, 50], anchor });
    expect(receivedThreshold).toBe(8);
  });

  it("keeps an acquired line-edge snap locked through small release jitter", () => {
    const anchor = {
      itemId: ITEM_ID,
      point: [100, 50] as const,
      z: 4,
      distance: 1,
      source: "edge" as const,
    };
    const model = { nearestConnectorAnchor: () => undefined };

    const retained = resolveShapePointerState("line", [119, 50], false, model, 1, true, anchor);
    expect(retained).toEqual({ current: [100, 50], constrained: false, endAnchor: anchor });

    const released = resolveShapePointerState("line", [125, 50], false, model, 1, true, anchor);
    expect(released).toEqual({ current: [125, 50], constrained: false });
  });

  it("snaps a moved protractor center while excluding the protractor itself", () => {
    let excluded: ReadonlySet<string> | undefined;
    const anchor = {
      itemId: "018f47a1-7a2b-7c3d-8e4f-123456789abe",
      point: [130, 100] as const,
      z: 3,
      distance: 2,
      source: "edge" as const,
    };
    const model = {
      nearestConnectorAnchor: (
        _point: readonly [number, number],
        _threshold: number,
        excludedItemIds?: ReadonlySet<string>,
      ) => {
        excluded = excludedItemIds;
        return anchor;
      },
    };

    const resolved = resolveProtractorCenterMove(
      [150, 150],
      [182, 148],
      [100, 100],
      ITEM_ID,
      model,
      1,
    );

    expect(resolved).toEqual({
      current: [180, 150],
      center: [130, 100],
      anchor,
    });
    expect(excluded?.has(ITEM_ID)).toBe(true);
  });

  it("uses a pointerup-only final coordinate when resolving a connector snap", () => {
    const anchor = {
      itemId: ITEM_ID,
      point: [120, 80] as const,
      z: 4,
      distance: 5,
    };
    const release = resolveShapePointerState(
      "line",
      [116, 77],
      false,
      { nearestConnectorAnchor: () => anchor },
      1,
    );

    expect(release).toEqual({ current: [120, 80], constrained: false, endAnchor: anchor });
    expect(
      shapeGeometry("line", [10, 20], release.current, release.constrained, !!release.endAnchor),
    ).toEqual({ x1: 10, y1: 20, x2: 120, y2: 80 });
  });

  it("uses final pointerup Shift state while snapped endpoints retain precedence", () => {
    const noAnchor = { nearestConnectorAnchor: () => undefined };
    const shiftedRelease = resolveShapePointerState("line", [10, 3], true, noAnchor, 1);
    const unconstrainedRelease = resolveShapePointerState("line", [10, 3], false, noAnchor, 1);
    const shiftedGeometry = shapeGeometry(
      "line",
      [0, 0],
      shiftedRelease.current,
      shiftedRelease.constrained,
      !!shiftedRelease.endAnchor,
    );
    const unconstrainedGeometry = shapeGeometry(
      "line",
      [0, 0],
      unconstrainedRelease.current,
      unconstrainedRelease.constrained,
      !!unconstrainedRelease.endAnchor,
    );
    expect(shiftedGeometry).not.toEqual(unconstrainedGeometry);
    expect(unconstrainedGeometry).toEqual({ x1: 0, y1: 0, x2: 10, y2: 3 });

    const anchor = { itemId: ITEM_ID, point: [10, 3] as const, z: 4, distance: 1 };
    const snappedRelease = resolveShapePointerState(
      "line",
      [9, 3],
      true,
      { nearestConnectorAnchor: () => anchor },
      1,
    );
    expect(
      shapeGeometry(
        "line",
        [0, 0],
        snappedRelease.current,
        snappedRelease.constrained,
        !!snappedRelease.endAnchor,
      ),
    ).toEqual({ x1: 0, y1: 0, x2: 10, y2: 3 });
  });

  it("preserves square and rectangle subtypes in local and remote geometry", () => {
    expect(shapeGeometry("rectangle", [10, 20], [90, 55], true, false, "square")).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 80,
      shape: "square",
    });
    expect(shapeGeometry("rectangle", [10, 20], [90, 55], false, false, "rectangle")).toEqual({
      x: 10,
      y: 20,
      width: 80,
      height: 35,
      shape: "rectangle",
    });
  });

  it("persists connector endpoints as absolute geometry with its arrow variant", () => {
    expect(
      buildShapeCreateOperation(
        ITEM_ID,
        "line",
        { x1: 12, y1: 34, x2: 156, y2: 78 },
        { kind: "line", color: "#20201e", width: 4, opacity: 1, arrowhead: "arrow" },
      ),
    ).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "line",
        style: { kind: "line", color: "#20201e", width: 4, opacity: 1, arrowhead: "arrow" },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x1: 12, y1: 34, x2: 156, y2: 78 },
      },
    });
  });

  it("uses the text version and geometry captured when editing opened", () => {
    expect(
      buildCapturedTextUpdate(
        {
          itemId: ITEM_ID,
          expectedVersion: 13,
          geometry: { x: 20, y: 30, text: "before" },
        },
        "after",
      ),
    ).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 13,
      patch: { geometry: { x: 20, y: 30, text: "after" } },
    });
  });

  it("clears stale video markers while preserving valid replacement embeds", () => {
    const geometry = {
      x: 20,
      y: 30,
      text: "https://youtu.be/dQw4w9WgXcQ",
      embed: "video" as const,
    };
    const edit = { itemId: ITEM_ID, expectedVersion: 13, geometry };
    expect(buildCapturedTextUpdate(edit, "Plain text")).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 13,
      patch: { geometry: { x: 20, y: 30, text: "Plain text" } },
    });
    expect(buildCapturedTextUpdate(edit, "https://vimeo.com/76979871")).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 13,
      patch: {
        geometry: { x: 20, y: 30, text: "https://vimeo.com/76979871", embed: "video" },
      },
    });
  });

  it("clears Section membership when edited text grows outside its Section", () => {
    const section = sectionItem(100, 100);
    const item: Extract<BoardItem, { kind: "text" }> = {
      id: ITEM_ID,
      kind: "text",
      sectionId: SECTION_ID,
      z: 2,
      version: 13,
      createdBy: "teacher-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "text", color: "#20201e", fontSize: 20, fontFamily: "sans", opacity: 1 },
      geometry: { x: 10, y: 30, text: "a" },
    };

    expect(
      buildCapturedTextUpdate(
        {
          itemId: item.id,
          expectedVersion: item.version,
          geometry: item.geometry,
          item,
        },
        "1234567890",
        [section, item],
        false,
      ),
    ).toEqual({
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry: { ...item.geometry, text: "1234567890" }, sectionId: null },
    });
  });

  it("creates a default-sized sticky and updates its captured text geometry", () => {
    const create = buildStickyCreateOperation(
      ITEM_ID,
      [12, 34],
      {
        stickyFill: "#fecdd3",
        stickyTextColor: "#292524",
        stickyFontSize: 20,
        stickyOpacity: 1,
      },
      "",
    );
    expect(create).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "sticky",
        style: {
          kind: "sticky",
          fill: "#fecdd3",
          textColor: "#292524",
          fontSize: 20,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 12, y: 34, width: 180, height: 140, text: "" },
      },
    });
    expect(
      buildCapturedTextUpdate(
        {
          itemId: ITEM_ID,
          expectedVersion: 9,
          geometry: { x: 12, y: 34, width: 180, height: 140, text: "" },
        },
        "group idea",
      ),
    ).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 9,
      patch: {
        geometry: { x: 12, y: 34, width: 180, height: 140, text: "group idea" },
      },
    });
  });

  it("creates a centered default-sized stamp with the selected design and colour", () => {
    expect(
      buildStampCreateOperation(ITEM_ID, [72, 96], {
        stampKind: "sparkle",
        stampColor: "#8e4ec6",
        stampOpacity: 0.75,
      }),
    ).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "stamp",
        style: { kind: "stamp", color: "#8e4ec6", opacity: 0.75 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 72, y: 96, size: 36, stamp: "sparkle" },
      },
    });
  });

  it("freely resizes sticky cards from the southeast corner with classroom-safe minimums", () => {
    const item: Extract<BoardItem, { kind: "sticky" }> = {
      id: ITEM_ID,
      kind: "sticky",
      z: 2,
      version: 7,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "sticky",
        fill: "#fde68a",
        textColor: "#292524",
        fontSize: 20,
        opacity: 1,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "An idea" },
    };

    const offCenterGrab: [number, number] = [174, 149];
    const grabOffset = cardResizeGrabOffset(item, offCenterGrab);
    expect(grabOffset).toEqual([-16, -11]);
    expect(resizedCardGeometry(item, offCenterGrab, grabOffset)).toEqual(item.geometry);
    expect(resizedCardGeometry(item, [204, 164], grabOffset)).toEqual({
      ...item.geometry,
      width: 210,
      height: 155,
    });

    expect(resizedCardGeometry(item, [260, 220])).toEqual({
      ...item.geometry,
      width: 250,
      height: 200,
    });
    const minimum = resizedCardGeometry(item, [20, 30]);
    expect(minimum).toEqual({ ...item.geometry, width: 96, height: 72 });
    expect(buildCapturedCardResizeOperation({ item, expectedVersion: 7 }, minimum)).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 7,
      patch: { geometry: { ...item.geometry, width: 96, height: 72 } },
    });
  });

  it("preserves image card aspect ratio and immutable metadata while resizing", () => {
    const item: Extract<BoardItem, { kind: "image" }> = {
      id: ITEM_ID,
      kind: "image",
      z: 3,
      version: 11,
      createdBy: "coach-a",
      transform: [1, 0, 0, 1, 12, 18],
      style: { kind: "image", opacity: 1, radius: 12 },
      geometry: {
        x: 10,
        y: 20,
        width: 200,
        height: 100,
        assetId: `asset_${"a".repeat(43)}`,
        alt: "Classroom diagram",
        mimeType: "image/webp",
        intrinsicWidth: 1_200,
        intrinsicHeight: 600,
      },
    };

    expect(resizedCardGeometry(item, [410, 220])).toEqual({
      ...item.geometry,
      width: 400,
      height: 200,
    });
    expect(resizedCardGeometry(item, [10, 20])).toEqual({
      ...item.geometry,
      width: 144,
      height: 72,
    });
  });

  it("creates an aspect-preserving image card with metadata only", () => {
    expect(defaultImageCardSize(1_200, 800)).toEqual({ width: 360, height: 240 });
    expect(defaultImageCardSize(800, 1_600)).toEqual({ width: 140, height: 280 });

    const operation = buildImageCreateOperation(ITEM_ID, [400, 300], {
      assetId: `asset_${"a".repeat(43)}`,
      mimeType: "image/webp",
      intrinsicWidth: 1_200,
      intrinsicHeight: 800,
    });

    expect(operation).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "image",
        style: { kind: "image", opacity: 1, radius: 12 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 220,
          y: 180,
          width: 360,
          height: 240,
          assetId: `asset_${"a".repeat(43)}`,
          mimeType: "image/webp",
          intrinsicWidth: 1_200,
          intrinsicHeight: 800,
        },
      },
    });
    expect(JSON.stringify(operation)).not.toMatch(/data:|blob:|base64|ArrayBuffer/u);
  });

  it("creates a centered, readable 3 by 3 table and clamps the classroom size", () => {
    expect(buildTableCreateOperation(ITEM_ID, [400, 300], 3, 3, true)).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "table",
        style: {
          kind: "table",
          borderColor: "#d4d4d4",
          fill: "#ffffff",
          headerFill: "#d3bdff",
          textColor: "#1e1e1e",
          fontSize: 16,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 220,
          y: 228,
          columnWidths: [120, 120, 120],
          rowHeights: [48, 48, 48],
          cells: [
            ["", "", ""],
            ["", "", ""],
            ["", "", ""],
          ],
          headerRow: true,
        },
      },
    });

    const capped = buildTableCreateOperation(ITEM_ID, [0, 0], 20, 0);
    if (capped.kind !== "item.create") throw new Error("Expected a table create.");
    expect(capped.item.kind).toBe("table");
    if (capped.item.kind !== "table") throw new Error("Expected a table create.");
    expect(capped.item.geometry.rowHeights).toHaveLength(8);
    expect(capped.item.geometry.columnWidths).toHaveLength(1);
    expect(capped.item.geometry.headerRow).toBeUndefined();
  });

  it("finds a table cell through the item's affine transform", () => {
    const item = {
      transform: [0, 1, -1, 0, 300, 10] as Matrix,
      geometry: {
        x: 10,
        y: 20,
        columnWidths: [100, 120],
        rowHeights: [40, 50],
        cells: [
          ["a", "b"],
          ["c", "d"],
        ],
      },
    };

    expect(tableCellAtPoint(item, [220, 170])).toEqual({ row: 1, column: 1 });
    expect(tableCellAtPoint(item, [400, 170])).toBeNull();
  });

  it("creates a centered classroom zone with a readable default title", () => {
    expect(buildZoneCreateOperation(ITEM_ID, [400, 300])).toEqual({
      kind: "item.create",
      item: {
        id: ITEM_ID,
        kind: "zone",
        style: {
          kind: "zone",
          borderColor: "#d4d4d4",
          fill: "#a8daff",
          textColor: "#1e1e1e",
          fontSize: 18,
          opacity: 0.18,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 140, y: 140, width: 520, height: 320, title: "Section" },
      },
    });
  });

  it("creates a dragged Section covering the swept bounds in either direction", () => {
    const forward = buildDraggedZoneCreateOperation(ITEM_ID, [100, 80], [400, 300]);
    expect(forward.item.geometry).toEqual({
      x: 100,
      y: 80,
      width: 300,
      height: 220,
      title: "Section",
    });

    const backward = buildDraggedZoneCreateOperation(ITEM_ID, [400, 300], [100, 80]);
    expect(backward.item.geometry).toEqual(forward.item.geometry);
    expect(forward.item.style).toEqual(buildZoneCreateOperation(ITEM_ID, [0, 0]).item.style);
  });

  it("rounds dragged Section bounds onto the board grid", () => {
    expect(
      buildDraggedZoneCreateOperation(ITEM_ID, [10.126, 20.124], [220.126, 140.124]).item.geometry,
    ).toEqual({ x: 10.13, y: 20.12, width: 210, height: 120, title: "Section" });
  });

  it("falls back to a centered default Section when the drag stays under the minimum", () => {
    const centered = buildZoneCreateOperation(ITEM_ID, [400, 300]).item.geometry;
    expect(draggedZoneGeometry([400, 300], [400, 300])).toEqual(centered);
    expect(draggedZoneGeometry([400, 300], [400 + MIN_RESIZED_ZONE_WIDTH - 1, 300 + 400])).toEqual(
      centered,
    );
    expect(draggedZoneGeometry([400, 300], [400 + 400, 300 + MIN_RESIZED_ZONE_HEIGHT - 1])).toEqual(
      centered,
    );
    expect(
      draggedZoneGeometry(
        [400, 300],
        [400 + MIN_RESIZED_ZONE_WIDTH, 300 + MIN_RESIZED_ZONE_HEIGHT],
      ),
    ).toEqual({
      x: 400,
      y: 300,
      width: MIN_RESIZED_ZONE_WIDTH,
      height: MIN_RESIZED_ZONE_HEIGHT,
      title: "Section",
    });
  });

  it("binds items enclosed by a dragged Section", () => {
    const operation = buildDraggedZoneCreateOperation(SECTION_ID, [0, 0], [400, 300]);
    const inside = stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ad1", 20, 20, "teacher-a");
    const outside = stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ad2", 900, 900, "teacher-a");

    expect(buildSectionCreateMembershipOperation(operation, [inside, outside], () => true)).toEqual(
      {
        kind: "items.batch",
        operations: [
          operation,
          {
            kind: "item.update",
            itemId: inside.id,
            expectedVersion: inside.version,
            patch: { sectionId: SECTION_ID },
          },
        ],
      },
    );
  });

  it("rejects creating a Section around a foreign saved item", () => {
    const operation = buildZoneCreateOperation(SECTION_ID, [260, 160]);
    const ownedItem = stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789abf", 20, 20, "teacher-a");
    const foreignItem = stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ac0", 100, 20, "student-b");

    expect(() =>
      buildSectionCreateMembershipOperation(
        operation,
        [ownedItem, foreignItem],
        (item) => item.createdBy === "teacher-a",
      ),
    ).toThrow(GroupingError);
  });

  it("waits for contained pending items before creating a Section", () => {
    const operation = buildZoneCreateOperation(SECTION_ID, [260, 160]);
    const pendingItem = {
      ...stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ac5", 20, 20, "teacher-a"),
      version: 0,
    };

    expect(() =>
      buildSectionCreateMembershipOperation(operation, [pendingItem], () => true),
    ).toThrow("Wait for every contained item to finish saving before creating a Section.");
  });

  it("batches Section creation with every contained owned item", () => {
    const operation = buildZoneCreateOperation(SECTION_ID, [260, 160]);
    const firstItem = stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ac1", 20, 20, "teacher-a");
    const secondItem = stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ac2", 100, 20, "teacher-a");

    expect(
      buildSectionCreateMembershipOperation(
        operation,
        [firstItem, secondItem],
        (item) => item.createdBy === "teacher-a",
      ),
    ).toEqual({
      kind: "items.batch",
      operations: [
        operation,
        {
          kind: "item.update",
          itemId: firstItem.id,
          expectedVersion: firstItem.version,
          patch: { sectionId: SECTION_ID },
        },
        {
          kind: "item.update",
          itemId: secondItem.id,
          expectedVersion: secondItem.version,
          patch: { sectionId: SECTION_ID },
        },
      ],
    });
  });

  it("atomically clears surviving members when deleting a Section", () => {
    const section = sectionItem();
    const survivingMember = stickyItem(
      "018f47a1-7a2b-7c3d-8e4f-123456789ac3",
      20,
      20,
      "teacher-a",
      SECTION_ID,
    );
    const deletedMember = stickyItem(
      "018f47a1-7a2b-7c3d-8e4f-123456789ac4",
      80,
      20,
      "teacher-a",
      SECTION_ID,
    );

    expect(
      buildSectionDeleteMembershipOperation(
        [section, deletedMember],
        [section, survivingMember, deletedMember],
        () => true,
      ),
    ).toEqual({
      kind: "items.batch",
      operations: [
        {
          kind: "item.delete",
          itemId: SECTION_ID,
          expectedVersion: section.version,
        },
        {
          kind: "item.delete",
          itemId: deletedMember.id,
          expectedVersion: deletedMember.version,
        },
        {
          kind: "item.update",
          itemId: survivingMember.id,
          expectedVersion: survivingMember.version,
          patch: { sectionId: null },
        },
      ],
    });
  });

  it("detaches a foreign surviving member when the actor may edit the Section", () => {
    const section = sectionItem();
    const foreignMember = stickyItem(
      "018f47a1-7a2b-7c3d-8e4f-123456789ac3",
      20,
      20,
      "student-b",
      SECTION_ID,
    );

    // Membership was assigned by geometry, so the Section's editor may undo it
    // even though they cannot otherwise edit the member.
    expect(
      buildSectionDeleteMembershipOperation(
        [section],
        [section, foreignMember],
        (item) => item.createdBy === "teacher-a",
      ),
    ).toMatchObject({
      kind: "items.batch",
      operations: [
        { kind: "item.delete", itemId: SECTION_ID },
        { kind: "item.update", itemId: foreignMember.id, patch: { sectionId: null } },
      ],
    });
  });

  it("rejects deleting a Section when neither the member nor the Section is editable", () => {
    const section = sectionItem();
    const foreignMember = stickyItem(
      "018f47a1-7a2b-7c3d-8e4f-123456789ac3",
      20,
      20,
      "student-b",
      SECTION_ID,
    );

    expect(() =>
      buildSectionDeleteMembershipOperation(
        [section],
        [section, foreignMember],
        (item) => item.createdBy === "student-c",
      ),
    ).toThrow(GroupingError);
  });

  it("clears Section membership atomically when scaling a shape outside", () => {
    const section = sectionItem();
    const item: Extract<BoardItem, { kind: "rectangle" }> = {
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac5",
      kind: "rectangle",
      sectionId: SECTION_ID,
      z: 2,
      version: 4,
      createdBy: "teacher-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "stroke", color: "#20201e", width: 2, opacity: 1 },
      geometry: { x: 10, y: 20, width: 40, height: 40, shape: "rectangle" },
    };
    const transform: Matrix = [6, 0, 0, 6, 0, 0];

    expect(
      buildObjectTransformMembershipOperation({ item, expectedVersion: item.version }, transform, [
        section,
        item,
      ]),
    ).toEqual({
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { transform, sectionId: null },
    });
  });

  it("clears Section membership atomically when rotating an image outside", () => {
    const section = sectionItem();
    const item: Extract<BoardItem, { kind: "image" }> = {
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac6",
      kind: "image",
      sectionId: SECTION_ID,
      z: 2,
      version: 5,
      createdBy: "teacher-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "image", opacity: 1, radius: 12 },
      geometry: {
        x: 50,
        y: 10,
        width: 100,
        height: 20,
        assetId: `asset_${"a".repeat(43)}`,
        mimeType: "image/png",
        intrinsicWidth: 100,
        intrinsicHeight: 20,
      },
    };
    const transform: Matrix = [0, 1, -1, 0, 120, -80];

    expect(
      buildObjectTransformMembershipOperation({ item, expectedVersion: item.version }, transform, [
        section,
        item,
      ]),
    ).toEqual({
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { transform, sectionId: null },
    });
  });

  it("clears Section membership atomically when resizing a sticky outside", () => {
    const section = sectionItem();
    const item = stickyItem(
      "018f47a1-7a2b-7c3d-8e4f-123456789ac7",
      140,
      20,
      "teacher-a",
      SECTION_ID,
    );
    const geometry = { ...item.geometry, width: 80 };

    expect(
      buildCardResizeMembershipOperation({ item, expectedVersion: item.version }, geometry, [
        section,
        item,
      ]),
    ).toEqual({
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry, sectionId: null },
    });
  });

  it("clears Section membership atomically when resizing a table outside", () => {
    const section = sectionItem();
    const item: Extract<BoardItem, { kind: "table" }> = {
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac8",
      kind: "table",
      sectionId: SECTION_ID,
      z: 2,
      version: 4,
      createdBy: "teacher-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "table",
        borderColor: "#d4d4d4",
        fill: "#ffffff",
        headerFill: "#d3bdff",
        textColor: "#1e1e1e",
        fontSize: 16,
        opacity: 1,
      },
      geometry: {
        x: 140,
        y: 20,
        columnWidths: [40],
        rowHeights: [40],
        cells: [[""]],
      },
    };
    const geometry = { ...item.geometry, columnWidths: [80] };

    expect(
      buildSectionResizeMembershipOperation(
        { item, expectedVersion: item.version, handle: { kind: "southeast" } },
        geometry,
        [section, item],
        () => true,
      ),
    ).toEqual({
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry, sectionId: null },
    });
  });

  it.each([
    {
      name: "leaving",
      section: sectionItem(),
      item: {
        ...stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ac9", 140, 20, "teacher-a", SECTION_ID),
        version: 0,
      },
      geometry: { ...sectionItem().geometry, width: 100 },
    },
    {
      name: "entering",
      section: sectionItem(100, 100),
      item: {
        ...stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789aca", 140, 20, "teacher-a"),
        version: 0,
      },
      geometry: { ...sectionItem(100, 100).geometry, width: 200 },
    },
  ])("waits for a pending $name item before resizing a Section", ({ section, item, geometry }) => {
    expect(() =>
      buildSectionResizeMembershipOperation(
        { item: section, expectedVersion: section.version, handle: { kind: "southeast" } },
        geometry,
        [section, item],
        () => true,
      ),
    ).toThrow("Wait for every affected item to finish saving before resizing this Section.");
  });

  it("allows a Section resize when pending member relationships stay unchanged", () => {
    const section = sectionItem();
    const pendingMember = {
      ...stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789acb", 20, 20, "teacher-a", SECTION_ID),
      version: 0,
    };
    const geometry = { ...section.geometry, width: 180 };

    expect(
      buildSectionResizeMembershipOperation(
        { item: section, expectedVersion: section.version, handle: { kind: "southeast" } },
        geometry,
        [section, pendingMember],
        () => true,
      ),
    ).toEqual({
      kind: "item.update",
      itemId: SECTION_ID,
      expectedVersion: section.version,
      patch: { geometry },
    });
  });

  it("rejects shrinking a Section around a foreign member", () => {
    const section = sectionItem();
    const foreignMember = stickyItem(
      "018f47a1-7a2b-7c3d-8e4f-123456789abf",
      140,
      20,
      "student-b",
      SECTION_ID,
    );

    expect(() =>
      buildSectionResizeMembershipOperation(
        { item: section, expectedVersion: section.version, handle: { kind: "southeast" } },
        { ...section.geometry, width: 100 },
        [section, foreignMember],
        (item) => item.createdBy === "teacher-a",
      ),
    ).toThrow(GroupingError);
  });

  it("rejects expanding a Section around a foreign item", () => {
    const section = sectionItem(100, 100);
    const foreignItem = stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ac0", 140, 20, "student-b");

    expect(() =>
      buildSectionResizeMembershipOperation(
        { item: section, expectedVersion: section.version, handle: { kind: "southeast" } },
        { ...section.geometry, width: 200 },
        [section, foreignItem],
        (item) => item.createdBy === "teacher-a",
      ),
    ).toThrow(GroupingError);
  });

  it("batches owned resize membership changes without repairing unrelated foreign items", () => {
    const section = sectionItem();
    const enteringItem = stickyItem("018f47a1-7a2b-7c3d-8e4f-123456789ac1", 220, 20, "teacher-a");
    const leavingItem = stickyItem(
      "018f47a1-7a2b-7c3d-8e4f-123456789ac2",
      20,
      140,
      "teacher-a",
      SECTION_ID,
    );
    const unrelatedForeignItem = stickyItem(
      "018f47a1-7a2b-7c3d-8e4f-123456789ac3",
      400,
      400,
      "student-b",
      "018f47a1-7a2b-7c3d-8e4f-123456789ac4",
    );
    const geometry = { ...section.geometry, width: 300, height: 100 };

    expect(
      buildSectionResizeMembershipOperation(
        { item: section, expectedVersion: section.version, handle: { kind: "southeast" } },
        geometry,
        [section, enteringItem, leavingItem, unrelatedForeignItem],
        (item) => item.createdBy === "teacher-a",
      ),
    ).toEqual({
      kind: "items.batch",
      operations: [
        {
          kind: "item.update",
          itemId: SECTION_ID,
          expectedVersion: 7,
          patch: { geometry },
        },
        {
          kind: "item.update",
          itemId: enteringItem.id,
          expectedVersion: 4,
          patch: { sectionId: SECTION_ID },
        },
        {
          kind: "item.update",
          itemId: leavingItem.id,
          expectedVersion: 4,
          patch: { sectionId: null },
        },
      ],
    });
  });
});

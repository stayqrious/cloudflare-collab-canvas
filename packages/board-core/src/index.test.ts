import {
  type ImageGeometry,
  type ItemEffect,
  normalizeBoardItem,
  type TextFontFamily,
} from "@collab/protocol";
import { describe, expect, it } from "vitest";

import {
  applyAuthoritativeOperation,
  applyDurableOperation,
  applyRedoEffects,
  applyUndoEffects,
  BoardCoreError,
  canonicalSnapshotByteLengthFromParts,
  canonicalSnapshotBytes,
  canonicalSnapshotItemByteLength,
  cloneBoardItem,
  createBoardState,
  createCanonicalSnapshot,
  findMoveCopyClosureLimitViolation,
  liveItemsInPaintOrder,
  type MoveCopyRelationshipItem,
  serializeCanonicalSnapshot,
} from "./index.js";

const ALICE = "018f0000-0000-7000-8000-0000000000a1";
const BOB = "018f0000-0000-7000-8000-0000000000b1";
const RECTANGLE_ID = "018f0000-0000-7000-8000-000000000001";
const COPY_ID = "018f0000-0000-7000-8000-000000000002";
const ASSET_ID = "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_ASSET_ID = "asset_CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACTION_1 = "018f0000-0000-7000-8000-000000000101";
const ACTION_2 = "018f0000-0000-7000-8000-000000000102";

function rectangle(id = RECTANGLE_ID, shape: "rectangle" | "square" = "rectangle") {
  return {
    id,
    kind: "rectangle" as const,
    style: { kind: "stroke" as const, color: "#123456", width: 2, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 10, y: 20, width: 30, height: shape === "square" ? 30 : 40, shape },
  };
}

function line(id = RECTANGLE_ID) {
  return {
    id,
    kind: "line" as const,
    style: {
      kind: "line" as const,
      color: "#123456",
      width: 4,
      opacity: 1,
      arrowhead: "arrow" as const,
    },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x1: 10, y1: 20, x2: 130, y2: 80 },
  };
}

function polygon(id = RECTANGLE_ID) {
  return {
    id,
    kind: "polygon" as const,
    style: { kind: "stroke" as const, color: "#874fff", width: 3, opacity: 0.8 },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: {
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      polygon: "hexagon" as const,
      visiblePaths: [
        [[60, 20] as [number, number], [110, 40] as [number, number]],
        [[110, 80] as [number, number], [60, 100] as [number, number]],
      ],
    },
  };
}

function protractor(id = RECTANGLE_ID) {
  return {
    id,
    kind: "protractor" as const,
    style: { kind: "protractor" as const, color: "#3dadff", opacity: 0.75 },
    transform: [0, 1, -1, 0, 300, 200] as [number, number, number, number, number, number],
    geometry: { radius: 160 },
  };
}

function text(id = RECTANGLE_ID, fontFamily: TextFontFamily = "sans") {
  return {
    id,
    kind: "text" as const,
    style: {
      kind: "text" as const,
      color: "#123456",
      fontSize: 24,
      fontFamily,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 10, y: 20, text: "Shared words" },
  };
}

function sticky(id = RECTANGLE_ID) {
  return {
    id,
    kind: "sticky" as const,
    style: {
      kind: "sticky" as const,
      fill: "#ffeb3b",
      textColor: "#212121",
      fontSize: 16,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 10, y: 20, width: 180, height: 140, text: "" },
  };
}

function stamp(id = RECTANGLE_ID) {
  return {
    id,
    kind: "stamp" as const,
    style: { kind: "stamp" as const, color: "#e11d48", opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 40, y: 50, size: 72, stamp: "heart" as const },
  };
}

function image(id = RECTANGLE_ID) {
  return {
    id,
    kind: "image" as const,
    style: { kind: "image" as const, opacity: 1, radius: 12 },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: {
      x: 10,
      y: 20,
      width: 240,
      height: 160,
      assetId: ASSET_ID,
      alt: "Cell diagram",
      mimeType: "image/png" as const,
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
    },
  };
}

function table(id = RECTANGLE_ID) {
  return {
    id,
    kind: "table" as const,
    style: {
      kind: "table" as const,
      borderColor: "#94a3b8",
      fill: "#ffffff",
      headerFill: "#e2e8f0",
      textColor: "#0f172a",
      fontSize: 16,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: {
      x: 10,
      y: 20,
      columnWidths: [120, 120, 120],
      rowHeights: [48, 48, 48],
      cells: [
        ["Term", "Meaning", "Example"],
        ["Atom", "Small unit", "Carbon"],
        ["", "", ""],
      ],
      headerRow: true,
    },
  };
}

function zone(id = RECTANGLE_ID) {
  return {
    id,
    kind: "zone" as const,
    style: {
      kind: "zone" as const,
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    },
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    geometry: { x: 10, y: 20, width: 520, height: 320, title: "Evidence" },
  };
}

function corruptImageEffect(
  effects: readonly ItemEffect[],
  stateKey: "before" | "after",
  change: Partial<
    Pick<ImageGeometry, "assetId" | "mimeType" | "intrinsicWidth" | "intrinsicHeight">
  >,
): ItemEffect[] {
  const corrupted = structuredClone(effects) as ItemEffect[];
  const logicalState = corrupted[0]?.[stateKey];
  if (logicalState?.exists !== true || logicalState.item.kind !== "image") {
    throw new Error(`Expected ${stateKey} image effect state`);
  }
  logicalState.item.geometry = {
    ...logicalState.item.geometry,
    ...change,
  };
  return corrupted;
}

describe("normal board reductions", () => {
  it("preserves the authoritative square subtype through state and canonical snapshots", () => {
    const state = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle(RECTANGLE_ID, "square") },
      { seq: 1, actorId: ALICE },
    ).state;
    const [item] = liveItemsInPaintOrder(state);
    expect(item).toMatchObject({ kind: "rectangle", geometry: { shape: "square" } });
    const serialized = serializeCanonicalSnapshot({
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 1,
      createdAt: 1_785_840_000_000,
      settings: { title: "Square gating" },
      items: item ? [item] : [],
    });
    expect(JSON.parse(serialized).items[0].geometry.shape).toBe("square");
  });

  it("persists, clears, and remaps group and Section relationships", () => {
    const created = applyDurableOperation(
      createBoardState(),
      {
        kind: "item.create",
        item: { ...rectangle(), groupId: ACTION_1, sectionId: ACTION_2 },
      },
      { seq: 1, actorId: ALICE },
    ).state;
    const updated = applyDurableOperation(
      created,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: { groupId: null, sectionId: ACTION_1 },
      },
      { seq: 2, actorId: ALICE },
    ).state;
    const copied = applyDurableOperation(
      updated,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 20, y: 20 },
        newGroupId: ACTION_2,
        newSectionId: null,
      },
      { seq: 3, actorId: ALICE },
    ).state;

    expect(liveItemsInPaintOrder(updated)[0]).toMatchObject({
      sectionId: ACTION_1,
    });
    expect(liveItemsInPaintOrder(updated)[0]).not.toHaveProperty("groupId");
    expect(liveItemsInPaintOrder(copied)[1]).toMatchObject({
      id: COPY_ID,
      groupId: ACTION_2,
      createdBy: ALICE,
    });
    expect(liveItemsInPaintOrder(copied)[1]).not.toHaveProperty("sectionId");
  });

  it("assigns paint order/server fields and emits complete before/after effects", () => {
    const original = createBoardState();
    const result = applyDurableOperation(
      original,
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    );
    expect(original.items.size).toBe(0);
    expect(result.state.items.get(RECTANGLE_ID)).toMatchObject({
      exists: true,
      item: { z: 1, version: 1, createdBy: ALICE },
    });
    expect(result.effects).toEqual([
      {
        itemId: RECTANGLE_ID,
        before: { exists: false },
        after: {
          exists: true,
          item: expect.objectContaining({ id: RECTANGLE_ID, z: 1, version: 1 }),
        },
        beforeStateToken: `absent:${RECTANGLE_ID}`,
        afterStateToken: `state:1:0:${RECTANGLE_ID}`,
      },
    ]);
  });

  it("guards expected versions and item-specific patch schemas", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    expect(() =>
      applyDurableOperation(
        created,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 0,
          patch: { transform: [1, 0, 0, 1, 1, 1] },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_ITEM" }));
    expect(() =>
      applyDurableOperation(
        created,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { geometry: { x: 1, y: 2, text: "wrong kind" } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("applies a copy/delete batch atomically and allocates consecutive z values", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    const result = applyDurableOperation(
      created,
      {
        kind: "items.batch",
        operations: [
          {
            kind: "item.copy",
            sourceItemId: RECTANGLE_ID,
            expectedVersion: 1,
            newItemId: COPY_ID,
            translate: { x: 5.126, y: -2 },
          },
        ],
      },
      { seq: 2, actorId: BOB },
    );
    expect(result.state.items.get(COPY_ID)?.item).toMatchObject({
      z: 2,
      version: 2,
      createdBy: BOB,
      transform: [1, 0, 0, 1, 5.13, -2],
    });

    const beforeFailure = result.state;
    expect(() =>
      applyDurableOperation(
        beforeFailure,
        {
          kind: "items.batch",
          operations: [
            { kind: "item.delete", itemId: RECTANGLE_ID, expectedVersion: 1 },
            { kind: "item.delete", itemId: COPY_ID, expectedVersion: 999 },
          ],
        },
        { seq: 3, actorId: ALICE },
      ),
    ).toThrow(BoardCoreError);
    expect(beforeFailure.items.get(RECTANGLE_ID)?.exists).toBe(true);
    expect(beforeFailure.items.get(COPY_ID)?.exists).toBe(true);
  });

  it("commits successful multi-item batches, tombstones deletes, and never reuses IDs", () => {
    const batchedCreate = applyDurableOperation(
      createBoardState(),
      {
        kind: "items.batch",
        operations: [
          { kind: "item.create", item: rectangle(RECTANGLE_ID) },
          { kind: "item.create", item: rectangle(COPY_ID) },
        ],
      },
      { seq: 1, actorId: ALICE },
    );
    expect(liveItemsInPaintOrder(batchedCreate.state).map((item) => item.z)).toEqual([1, 2]);

    const changed = applyDurableOperation(
      batchedCreate.state,
      {
        kind: "items.batch",
        operations: [
          { kind: "item.delete", itemId: RECTANGLE_ID, expectedVersion: 1 },
          {
            kind: "item.update",
            itemId: COPY_ID,
            expectedVersion: 1,
            patch: { transform: [1, 0, 0, 1, 12, 14] },
          },
        ],
      },
      { seq: 2, actorId: ALICE },
    );
    expect(changed.state.items.get(RECTANGLE_ID)).toMatchObject({
      exists: false,
      item: { version: 2 },
    });
    expect(changed.state.items.get(COPY_ID)).toMatchObject({
      exists: true,
      item: { version: 2, transform: [1, 0, 0, 1, 12, 14] },
    });
    expect(() =>
      applyDurableOperation(
        changed.state,
        { kind: "item.create", item: rectangle(RECTANGLE_ID) },
        { seq: 3, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_ITEM_ID" }));
  });

  it("creates, edits, copies, and deletes sticky notes with matching schemas", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: sticky() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: {
            kind: "sticky",
            fill: "#f8bbd0",
            textColor: "#212121",
            fontSize: 18,
            opacity: 0.9,
          },
          geometry: { x: 10, y: 20, width: 180, height: 140, text: "Group idea" },
        },
      },
      { seq: 2, actorId: ALICE },
    );
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "sticky",
      version: 2,
      style: { fill: "#f8bbd0", fontSize: 18, opacity: 0.9 },
      geometry: { text: "Group idea" },
    });
    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Sticky ideas" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items[0]).toMatchObject({
      kind: "sticky",
      style: {
        kind: "sticky",
        fill: "#f8bbd0",
        textColor: "#212121",
        fontSize: 18,
        opacity: 0.9,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Group idea" },
    });

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 20, y: 30 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "sticky",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 20, 30],
      geometry: { text: "Group idea" },
    });

    const deleted = applyDurableOperation(
      copied.state,
      { kind: "item.delete", itemId: RECTANGLE_ID, expectedVersion: 2 },
      { seq: 4, actorId: ALICE },
    );
    expect(deleted.state.items.get(RECTANGLE_ID)?.exists).toBe(false);
    expect(deleted.state.items.get(COPY_ID)?.exists).toBe(true);

    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: {
            style: {
              kind: "text",
              color: "#123456",
              fontSize: 16,
              fontFamily: "sans",
              opacity: 1,
            },
          },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { geometry: { x: 1, y: 2, text: "ordinary text" } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("preserves text font family through updates, copies, and canonical snapshots", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: text(RECTANGLE_ID, "serif") },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: { style: { ...text().style, fontFamily: "handwritten" } },
      },
      { seq: 2, actorId: ALICE },
    );
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "text",
      style: { fontFamily: "handwritten" },
    });

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 20, y: 30 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "text",
      style: { fontFamily: "handwritten" },
    });

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 3,
        createdAt: 1_785_840_000_000,
        settings: { title: "Font families" },
        items: liveItemsInPaintOrder(copied.state),
      }),
    ) as { items: Array<{ style: { fontFamily?: string } }> };
    expect(snapshot.items.map((item) => item.style.fontFamily)).toEqual([
      "handwritten",
      "handwritten",
    ]);
  });

  it("preserves connector style through update, copy, history, and canonical snapshots", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: line() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: { style: { ...line().style, arrowhead: "none" } },
      },
      { seq: 2, actorId: ALICE },
    );
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "line",
      version: 2,
      style: { kind: "line", arrowhead: "none" },
    });

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 20, y: 30 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "line",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 20, 30],
      style: { kind: "line", arrowhead: "none" },
    });
    const deleted = applyDurableOperation(
      copied.state,
      { kind: "item.delete", itemId: COPY_ID, expectedVersion: 3 },
      { seq: 4, actorId: BOB },
    );
    const undone = applyUndoEffects(deleted.state, deleted.effects, {
      seq: 5,
      targetActionId: ACTION_2,
    });
    expect(undone.state.items.get(COPY_ID)).toMatchObject({
      exists: true,
      item: { kind: "line", version: 5, style: { arrowhead: "none" } },
    });
    const redone = applyRedoEffects(undone.state, deleted.effects, {
      seq: 6,
      targetActionId: ACTION_2,
    });
    expect(redone.state.items.get(COPY_ID)?.exists).toBe(false);

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Concept map" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "line",
        style: {
          kind: "line",
          color: "#123456",
          width: 4,
          opacity: 1,
          arrowhead: "none",
        },
        geometry: { x1: 10, y1: 20, x2: 130, y2: 80 },
      }),
    ]);
    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { style: rectangle().style },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("persists polygon fragments and rotatable protractors in canonical state", () => {
    const first = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: polygon() },
      { seq: 1, actorId: ALICE },
    ).state;
    const second = applyDurableOperation(
      first,
      { kind: "item.create", item: protractor(COPY_ID) },
      { seq: 2, actorId: ALICE },
    ).state;
    const items = liveItemsInPaintOrder(second);
    expect(items).toMatchObject([
      {
        kind: "polygon",
        geometry: {
          polygon: "hexagon",
          visiblePaths: [
            [
              [60, 20],
              [110, 40],
            ],
            [
              [110, 80],
              [60, 100],
            ],
          ],
        },
      },
      {
        kind: "protractor",
        transform: [0, 1, -1, 0, 300, 200],
        geometry: { radius: 160 },
      },
    ]);
    const original = items[0];
    if (original?.kind !== "polygon") throw new Error("Expected a polygon item.");
    const cloned = cloneBoardItem(original);
    if (cloned.kind !== "polygon") throw new Error("Expected a polygon clone.");
    const firstClonedPath = cloned.geometry.visiblePaths?.[0];
    if (!firstClonedPath) throw new Error("Expected cloned visible paths.");
    firstClonedPath[0] = [999, 20];
    expect(original.geometry.visiblePaths).toEqual(polygon().geometry.visiblePaths);

    const serialized = serializeCanonicalSnapshot({
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 2,
      createdAt: 1_785_840_000_000,
      settings: { title: "Geometry instruments" },
      items,
    });
    expect(JSON.parse(serialized).items).toMatchObject([
      { kind: "polygon", geometry: { polygon: "hexagon", visiblePaths: expect.any(Array) } },
      { kind: "protractor", style: { kind: "protractor" }, geometry: { radius: 160 } },
    ]);
  });

  it("persists stamp create, update, copy, delete, history, and snapshots", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: stamp() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: { kind: "stamp", color: "#2563eb", opacity: 0.8 },
          geometry: { x: 42, y: 54, size: 80, stamp: "sparkle" },
        },
      },
      { seq: 2, actorId: ALICE },
    );
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "stamp",
      version: 2,
      style: { kind: "stamp", color: "#2563eb", opacity: 0.8 },
      geometry: { x: 42, y: 54, size: 80, stamp: "sparkle" },
    });

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Stamp check-in" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "stamp",
        style: { kind: "stamp", color: "#2563eb", opacity: 0.8 },
        geometry: { x: 42, y: 54, size: 80, stamp: "sparkle" },
      }),
    ]);

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 10, y: -5 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "stamp",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 10, -5],
      geometry: { stamp: "sparkle" },
    });

    const deleted = applyDurableOperation(
      copied.state,
      { kind: "item.delete", itemId: RECTANGLE_ID, expectedVersion: 2 },
      { seq: 4, actorId: ALICE },
    );
    expect(deleted.state.items.get(RECTANGLE_ID)?.exists).toBe(false);
    const undone = applyUndoEffects(deleted.state, deleted.effects, {
      seq: 5,
      targetActionId: ACTION_2,
    });
    expect(undone.state.items.get(RECTANGLE_ID)).toMatchObject({
      exists: true,
      item: { kind: "stamp", version: 5, geometry: { stamp: "sparkle" } },
    });
    const redone = applyRedoEffects(undone.state, deleted.effects, {
      seq: 6,
      targetActionId: ACTION_2,
    });
    expect(redone.state.items.get(RECTANGLE_ID)).toMatchObject({ exists: false });

    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: {
            style: {
              kind: "text",
              color: "#123456",
              fontSize: 16,
              fontFamily: "sans",
              opacity: 1,
            },
          },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { geometry: { x: 1, y: 2, text: "wrong geometry" } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("persists, clones, copies, snapshots, and restores whole table grids", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: table() },
      { seq: 1, actorId: ALICE },
    );
    const revisedGeometry = {
      ...table().geometry,
      cells: [
        ["Word", "Definition", "Example"],
        ["Atom", "Small unit of matter", "Carbon"],
        ["Molecule", "Two or more atoms", "Water"],
      ],
    };
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: {
            ...table().style,
            headerFill: "#dbeafe",
            opacity: 0.9,
          },
          geometry: revisedGeometry,
        },
      },
      { seq: 2, actorId: ALICE },
    );
    const stored = updated.state.items.get(RECTANGLE_ID)?.item;
    expect(stored).toMatchObject({
      kind: "table",
      version: 2,
      style: { kind: "table", headerFill: "#dbeafe", opacity: 0.9 },
      geometry: { headerRow: true, cells: revisedGeometry.cells },
    });
    if (stored?.kind !== "table") throw new Error("Expected stored table fixture");
    const cloned = cloneBoardItem(stored);
    if (cloned.kind !== "table") throw new Error("Expected cloned table fixture");
    cloned.geometry.columnWidths[0] = 999;
    cloned.geometry.rowHeights[0] = 999;
    const firstClonedRow = cloned.geometry.cells[0];
    if (firstClonedRow === undefined) throw new Error("Expected cloned table row");
    firstClonedRow[0] = "Mutated";
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      geometry: {
        columnWidths: [120, 120, 120],
        rowHeights: [48, 48, 48],
        cells: revisedGeometry.cells,
      },
    });

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 25, y: -10 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "table",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 25, -10],
      geometry: { cells: revisedGeometry.cells },
    });

    const undone = applyUndoEffects(updated.state, updated.effects, {
      seq: 3,
      targetActionId: ACTION_2,
    });
    expect(undone.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "table",
      version: 3,
      style: { headerFill: "#e2e8f0", opacity: 1 },
      geometry: { cells: table().geometry.cells },
    });
    const redone = applyRedoEffects(undone.state, updated.effects, {
      seq: 4,
      targetActionId: ACTION_2,
    });
    expect(redone.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "table",
      version: 4,
      geometry: { cells: revisedGeometry.cells },
    });

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Vocabulary grid" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "table",
        style: {
          kind: "table",
          borderColor: "#94a3b8",
          fill: "#ffffff",
          headerFill: "#dbeafe",
          textColor: "#0f172a",
          fontSize: 16,
          opacity: 0.9,
        },
        geometry: {
          x: 10,
          y: 20,
          columnWidths: [120, 120, 120],
          rowHeights: [48, 48, 48],
          cells: revisedGeometry.cells,
          headerRow: true,
        },
      }),
    ]);

    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { style: { kind: "stamp", color: "#123456", opacity: 1 } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { geometry: { x: 0, y: 0, width: 100, height: 100 } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("keeps a Section lock in the canonical snapshot projection", () => {
    const locked = { ...zone(), geometry: { ...zone().geometry, locked: true as const } };
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: locked },
      { seq: 1, actorId: ALICE },
    );
    const stored = created.state.items.get(RECTANGLE_ID)?.item;
    if (stored?.kind !== "zone") throw new Error("Expected stored zone fixture");
    expect(stored.geometry.locked).toBe(true);

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 1,
        createdAt: 0,
        settings: { title: "Square gating" },
        items: [stored],
      }),
    ) as { items: Array<{ kind: string; geometry: { locked?: boolean } }> };
    const section = snapshot.items.find((item) => item.kind === "zone");
    expect(section?.geometry.locked).toBe(true);

    // An unlocked Section must not gain the key, so the canonical form stays stable.
    const unlocked = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 1,
        createdAt: 0,
        settings: { title: "Square gating" },
        items: [
          {
            ...stored,
            geometry: {
              x: stored.geometry.x,
              y: stored.geometry.y,
              width: stored.geometry.width,
              height: stored.geometry.height,
              title: stored.geometry.title,
            },
          },
        ],
      }),
    ) as { items: Array<{ geometry: Record<string, unknown> }> };
    expect("locked" in (unlocked.items[0]?.geometry ?? {})).toBe(false);
  });

  it("persists zone titles through copy, history, delete, and canonical snapshots", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: zone() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: { ...zone().style, opacity: 0.25 },
          geometry: { ...zone().geometry, title: "Finished examples" },
        },
      },
      { seq: 2, actorId: ALICE },
    );
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "zone",
      version: 2,
      style: { kind: "zone", opacity: 0.25 },
      geometry: { title: "Finished examples" },
    });
    const stored = updated.state.items.get(RECTANGLE_ID)?.item;
    if (stored?.kind !== "zone") throw new Error("Expected stored zone fixture");
    const cloned = cloneBoardItem(stored);
    if (cloned.kind !== "zone") throw new Error("Expected cloned zone fixture");
    cloned.geometry.title = "Changed clone";
    cloned.style.fill = "#ffffff";
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      style: { fill: "#e8edff" },
      geometry: { title: "Finished examples" },
    });

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 40, y: -15 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "zone",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 40, -15],
      geometry: { title: "Finished examples" },
    });
    const deleted = applyDurableOperation(
      copied.state,
      { kind: "item.delete", itemId: COPY_ID, expectedVersion: 3 },
      { seq: 4, actorId: BOB },
    );
    expect(deleted.state.items.get(COPY_ID)?.exists).toBe(false);
    const undoneDelete = applyUndoEffects(deleted.state, deleted.effects, {
      seq: 5,
      targetActionId: ACTION_2,
    });
    expect(undoneDelete.state.items.get(COPY_ID)).toMatchObject({
      exists: true,
      item: { kind: "zone", version: 5, geometry: { title: "Finished examples" } },
    });
    const redoneDelete = applyRedoEffects(undoneDelete.state, deleted.effects, {
      seq: 6,
      targetActionId: ACTION_2,
    });
    expect(redoneDelete.state.items.get(COPY_ID)?.exists).toBe(false);

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Group work" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "zone",
        style: {
          kind: "zone",
          borderColor: "#a8a59d",
          fill: "#e8edff",
          textColor: "#4f5b75",
          fontSize: 18,
          opacity: 0.25,
        },
        geometry: {
          x: 10,
          y: 20,
          width: 520,
          height: 320,
          title: "Finished examples",
        },
      }),
    ]);

    expect(() =>
      applyDurableOperation(
        created.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 1,
          patch: { geometry: { x: 0, y: 0, width: 100, height: 100 } },
        },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("persists image cards while keeping uploaded asset metadata immutable", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: image() },
      { seq: 1, actorId: ALICE },
    );
    const updated = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: {
          style: { kind: "image", opacity: 0.8, radius: 18 },
          geometry: {
            ...image().geometry,
            x: 30,
            y: 40,
            width: 300,
            height: 200,
            alt: "Labeled cell diagram",
          },
        },
      },
      { seq: 2, actorId: ALICE },
    );
    const stored = updated.state.items.get(RECTANGLE_ID)?.item;
    expect(stored).toMatchObject({
      kind: "image",
      version: 2,
      style: { kind: "image", opacity: 0.8, radius: 18 },
      geometry: {
        x: 30,
        y: 40,
        width: 300,
        height: 200,
        assetId: ASSET_ID,
        alt: "Labeled cell diagram",
        mimeType: "image/png",
        intrinsicWidth: 1200,
        intrinsicHeight: 800,
      },
    });

    const undone = applyUndoEffects(updated.state, updated.effects, {
      seq: 3,
      targetActionId: ACTION_2,
    });
    expect(undone.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "image",
      version: 3,
      style: { opacity: 1, radius: 12 },
      geometry: {
        assetId: ASSET_ID,
        alt: "Cell diagram",
        mimeType: "image/png",
        intrinsicWidth: 1200,
        intrinsicHeight: 800,
      },
    });
    const redone = applyRedoEffects(undone.state, updated.effects, {
      seq: 4,
      targetActionId: ACTION_2,
    });
    expect(redone.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      kind: "image",
      version: 4,
      geometry: { assetId: ASSET_ID, alt: "Labeled cell diagram" },
    });

    if (stored === undefined) throw new Error("Expected stored image fixture");
    const cloned = cloneBoardItem(stored);
    cloned.transform[4] = 999;
    cloned.style = { kind: "image", opacity: 0.5, radius: 4 };
    expect(updated.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      transform: [1, 0, 0, 1, 0, 0],
      style: { opacity: 0.8, radius: 18 },
    });

    const snapshot = JSON.parse(
      serializeCanonicalSnapshot({
        boardId: "018f0000-0000-7000-8000-0000000000ff",
        seq: 2,
        createdAt: 1_785_840_000_000,
        settings: { title: "Image source analysis" },
        items: liveItemsInPaintOrder(updated.state),
      }),
    ) as { items: unknown[] };
    expect(snapshot.items).toEqual([
      expect.objectContaining({
        kind: "image",
        style: { kind: "image", opacity: 0.8, radius: 18 },
        geometry: {
          x: 30,
          y: 40,
          width: 300,
          height: 200,
          assetId: ASSET_ID,
          alt: "Labeled cell diagram",
          mimeType: "image/png",
          intrinsicWidth: 1200,
          intrinsicHeight: 800,
        },
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/data:image|base64|https?:\/\//u);

    const copied = applyDurableOperation(
      updated.state,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 2,
        newItemId: COPY_ID,
        translate: { x: 15, y: -10 },
      },
      { seq: 3, actorId: BOB },
    );
    expect(copied.state.items.get(COPY_ID)?.item).toMatchObject({
      kind: "image",
      createdBy: BOB,
      transform: [1, 0, 0, 1, 15, -10],
      geometry: { assetId: ASSET_ID, mimeType: "image/png" },
    });

    const immutableChanges = [
      { assetId: OTHER_ASSET_ID },
      { mimeType: "image/webp" as const },
      { intrinsicWidth: 1199 },
      { intrinsicHeight: 799 },
    ];
    for (const change of immutableChanges) {
      expect(() =>
        applyDurableOperation(
          updated.state,
          {
            kind: "item.update",
            itemId: RECTANGLE_ID,
            expectedVersion: 2,
            patch: { geometry: { ...image().geometry, ...change } },
          },
          { seq: 3, actorId: ALICE },
        ),
      ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));

      expect(() =>
        applyUndoEffects(updated.state, corruptImageEffect(updated.effects, "before", change), {
          seq: 3,
          targetActionId: ACTION_2,
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
      expect(() =>
        applyRedoEffects(undone.state, corruptImageEffect(updated.effects, "after", change), {
          seq: 4,
          targetActionId: ACTION_2,
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
    }

    const consistentlyCorruptedEffects = corruptImageEffect(
      corruptImageEffect(updated.effects, "before", { assetId: OTHER_ASSET_ID }),
      "after",
      { assetId: OTHER_ASSET_ID },
    );
    expect(() =>
      applyUndoEffects(updated.state, consistentlyCorruptedEffects, {
        seq: 3,
        targetActionId: ACTION_2,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));

    expect(() =>
      applyDurableOperation(
        updated.state,
        {
          kind: "item.update",
          itemId: RECTANGLE_ID,
          expectedVersion: 2,
          patch: { style: { kind: "stroke", color: "#123456", width: 2, opacity: 1 } },
        },
        { seq: 3, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_FRAME" }));
  });

  it("clears all live items only at the exact expected board sequence", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    expect(() =>
      applyDurableOperation(
        created,
        { kind: "board.clear", expectedBoardSeq: 0 },
        { seq: 2, actorId: ALICE },
      ),
    ).toThrowError(expect.objectContaining({ code: "STALE_BOARD" }));
    const cleared = applyDurableOperation(
      created,
      { kind: "board.clear", expectedBoardSeq: 1 },
      { seq: 2, actorId: ALICE },
    );
    expect(cleared.operation).toEqual({
      kind: "board.clear",
      removed: [{ itemId: RECTANGLE_ID, version: 2 }],
    });
    expect(liveItemsInPaintOrder(cleared.state)).toEqual([]);
    expect(cleared.state.items.get(RECTANGLE_ID)?.exists).toBe(false);
  });
});

describe("lineage-aware undo and redo", () => {
  it("supports create → move → undo move → undo create without rewinding public versions", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    );
    const moved = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: { transform: [1, 0, 0, 1, 50, 60] },
      },
      { seq: 2, actorId: ALICE },
    );
    const undoMove = applyUndoEffects(moved.state, moved.effects, {
      seq: 3,
      targetActionId: ACTION_2,
    });
    expect(undoMove.state.items.get(RECTANGLE_ID)?.item).toMatchObject({
      version: 3,
      transform: [1, 0, 0, 1, 0, 0],
    });
    expect(undoMove.state.items.get(RECTANGLE_ID)?.stateToken).toBe(
      created.state.items.get(RECTANGLE_ID)?.stateToken,
    );

    const undoCreate = applyUndoEffects(undoMove.state, created.effects, {
      seq: 4,
      targetActionId: ACTION_1,
    });
    expect(undoCreate.state.items.get(RECTANGLE_ID)).toMatchObject({ exists: false });

    const redoCreate = applyRedoEffects(undoCreate.state, created.effects, {
      seq: 5,
      targetActionId: ACTION_1,
    });
    expect(redoCreate.state.items.get(RECTANGLE_ID)).toMatchObject({
      exists: true,
      item: { version: 5 },
    });
  });

  it("rejects undo after a collaborator changes the item without partial writes", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    );
    const collaboratorEdit = applyDurableOperation(
      created.state,
      {
        kind: "item.update",
        itemId: RECTANGLE_ID,
        expectedVersion: 1,
        patch: { transform: [1, 0, 0, 1, 7, 9] },
      },
      { seq: 2, actorId: BOB },
    );
    expect(() =>
      applyUndoEffects(collaboratorEdit.state, created.effects, {
        seq: 3,
        targetActionId: ACTION_1,
      }),
    ).toThrowError(expect.objectContaining({ code: "UNDO_CONFLICT" }));
    expect(collaboratorEdit.state.items.get(RECTANGLE_ID)?.item.transform).toEqual([
      1, 0, 0, 1, 7, 9,
    ]);
  });
});

describe("move/copy closure limits", () => {
  const sectionClosure = (memberCount: number): MoveCopyRelationshipItem[] => [
    { id: "section", kind: "zone" as const },
    ...Array.from({ length: memberCount }, (_, index) => ({
      id: `member-${index}`,
      kind: "rectangle" as const,
      sectionId: "section",
    })),
  ];

  it("allows a Section and 99 direct members in one atomic batch", () => {
    expect(findMoveCopyClosureLimitViolation(sectionClosure(99))).toBeNull();
  });

  it("rejects a Section whose direct membership would require 101 operations", () => {
    expect(findMoveCopyClosureLimitViolation(sectionClosure(100))).toEqual({
      seedItemId: "section",
      itemCount: 101,
    });
  });

  it("includes outward explicit-group links in the fixed-point Section closure", () => {
    const items = sectionClosure(98);
    items[1] = {
      id: "member-0",
      kind: "rectangle",
      sectionId: "section",
      groupId: "group",
    };
    items.push(
      {
        id: "outside-a",
        kind: "rectangle",
        groupId: "group",
      },
      {
        id: "outside-b",
        kind: "rectangle",
        groupId: "group",
      },
    );

    expect(findMoveCopyClosureLimitViolation(items)).toEqual({
      seedItemId: "section",
      itemCount: 101,
    });
  });

  it("allows a plain explicit group at the 100-item batch boundary", () => {
    const group = Array.from({ length: 100 }, (_, index) => ({
      id: `group-member-${index}`,
      kind: "rectangle" as const,
      groupId: "group",
    }));

    expect(findMoveCopyClosureLimitViolation(group)).toBeNull();
  });
});

describe("authoritative replay and snapshots", () => {
  it("applies canonical deltas without computing inverses", () => {
    const created = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    );
    const clientItems = applyAuthoritativeOperation(new Map(), created.operation);
    expect(clientItems.get(RECTANGLE_ID)).toEqual(created.state.items.get(RECTANGLE_ID)?.item);
    const removed = applyAuthoritativeOperation(clientItems, {
      kind: "history.undo",
      targetActionId: ACTION_1,
      changes: [{ kind: "item.remove", itemId: RECTANGLE_ID, version: 2 }],
    });
    expect(removed.size).toBe(0);
  });

  it("round-trips assistedBy through canonical snapshots", () => {
    const state = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: { ...rectangle(), assistedBy: "ai" } },
      { seq: 1, actorId: ALICE },
    ).state;
    const items = liveItemsInPaintOrder(state);
    expect(items[0]).toMatchObject({ assistedBy: "ai" });
    const input = {
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 1,
      createdAt: 1_785_840_000_000,
      settings: { title: "Assisted" },
      items,
    };
    const snapshot = createCanonicalSnapshot(input);
    expect(snapshot.items[0]).toMatchObject({ assistedBy: "ai" });
    expect(Object.keys(snapshot.items[0] ?? {})).toEqual([
      "id",
      "kind",
      "z",
      "version",
      "createdBy",
      "assistedBy",
      "style",
      "transform",
      "geometry",
    ]);
    const serialized = serializeCanonicalSnapshot(input);
    const parsed = JSON.parse(serialized) as { items: unknown[] };
    const restored = normalizeBoardItem(parsed.items[0]);
    expect(restored).toEqual(snapshot.items[0]);
    expect(restored.assistedBy).toBe("ai");
    expect(canonicalSnapshotItemByteLength(restored)).toBe(
      new TextEncoder().encode(JSON.stringify(parsed.items[0])).byteLength,
    );
    const { assistedBy: _assistedBy, ...plain } = items[0] as (typeof items)[number];
    const unassisted = createCanonicalSnapshot({ ...input, items: [plain] });
    expect(unassisted.items[0]).not.toHaveProperty("assistedBy");
  });

  it("round-trips the explicit video embed marker through canonical snapshots", () => {
    const state = applyDurableOperation(
      createBoardState(),
      {
        kind: "item.create",
        item: {
          ...text(),
          geometry: {
            ...text().geometry,
            text: "https://vimeo.com/76979871",
            embed: "video",
          },
        },
      },
      { seq: 1, actorId: ALICE },
    ).state;
    const input = {
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 1,
      createdAt: 1_785_840_000_000,
      settings: { title: "Video" },
      items: liveItemsInPaintOrder(state),
    };
    const snapshot = createCanonicalSnapshot(input);
    expect(snapshot.items[0]).toMatchObject({ geometry: { embed: "video" } });
    expect(normalizeBoardItem(JSON.parse(serializeCanonicalSnapshot(input)).items[0])).toEqual(
      snapshot.items[0],
    );
  });

  it("serializes stable top-level/item order and paint order", () => {
    const first = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    const second = applyDurableOperation(
      first,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 1,
        newItemId: COPY_ID,
        translate: { x: 5, y: 5 },
      },
      { seq: 2, actorId: ALICE },
    ).state;
    const items = liveItemsInPaintOrder(second).reverse();
    const input = {
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 2,
      createdAt: 1_785_840_000_000,
      settings: { title: "Algebra group" },
      items,
    };
    const one = serializeCanonicalSnapshot(input);
    const two = serializeCanonicalSnapshot({ ...input, items: [...items].reverse() });
    expect(one).toBe(two);
    expect(one.startsWith('{"format":"cf-whiteboard-json","version":1,"boardId":')).toBe(true);
    expect(JSON.parse(one).items.map((item: { z: number }) => item.z)).toEqual([1, 2]);
    expect(canonicalSnapshotBytes(input)).toEqual(new TextEncoder().encode(one));
  });

  it("decomposes canonical snapshot bytes exactly, including UTF-8 and commas", () => {
    const first = applyDurableOperation(
      createBoardState(),
      { kind: "item.create", item: rectangle() },
      { seq: 1, actorId: ALICE },
    ).state;
    const second = applyDurableOperation(
      first,
      {
        kind: "item.copy",
        sourceItemId: RECTANGLE_ID,
        expectedVersion: 1,
        newItemId: COPY_ID,
        translate: { x: 5, y: 5 },
      },
      { seq: 2, actorId: ALICE },
    ).state;
    const items = liveItemsInPaintOrder(second);
    const metadata = {
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 10,
      createdAt: 1_785_840_000_000,
      settings: { title: 'π algebra "group"\n第二行' },
    };
    const serialized = serializeCanonicalSnapshot({ ...metadata, items });
    const itemBytes = items.reduce(
      (total, item) => total + canonicalSnapshotItemByteLength(item),
      0,
    );
    expect(
      canonicalSnapshotByteLengthFromParts({
        ...metadata,
        itemCount: items.length,
        itemBytes,
      }),
    ).toBe(new TextEncoder().encode(serialized).byteLength);
  });

  it("accounts for the exact 20 MiB boundary without allocating a full snapshot", () => {
    const metadata = {
      boardId: "018f0000-0000-7000-8000-0000000000ff",
      seq: 99,
      createdAt: 1_785_840_000_000,
      settings: { title: "Boundary" },
      itemCount: 1,
    };
    const maximum = 20 * 1024 * 1024;
    const envelope = canonicalSnapshotByteLengthFromParts({ ...metadata, itemBytes: 0 });
    expect(
      canonicalSnapshotByteLengthFromParts({
        ...metadata,
        itemBytes: maximum - envelope,
      }),
    ).toBe(maximum);
    expect(
      canonicalSnapshotByteLengthFromParts({
        ...metadata,
        itemBytes: maximum - envelope + 1,
      }),
    ).toBe(maximum + 1);
  });
});

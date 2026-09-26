import { describe, expect, it } from "vitest";
import type { BoardItem, BoardSnapshot, CommitFrame, ServerAction } from "../types";
import { BoardModel, itemBounds, SequenceError } from "./model";

const ACTOR_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abc";
const ITEM_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abd";
const ACTION_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abe";
const PENDING_ID = "018f47a1-7a2b-7c3d-8e4f-123456789abf";
const REMOTE_ID = "018f47a1-7a2b-7c3d-8e4f-123456789ac0";

function rectangle(version = 1): BoardItem {
  return {
    id: ITEM_ID,
    kind: "rectangle",
    z: 1,
    version,
    createdBy: ACTOR_ID,
    style: { kind: "stroke", color: "#20201e", width: 4, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 20, width: 100, height: 60, shape: "rectangle" },
  };
}

function sticky(version = 1): BoardItem {
  return {
    id: ITEM_ID,
    kind: "sticky",
    z: 1,
    version,
    createdBy: ACTOR_ID,
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#292524",
      fontSize: 20,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 30, -5],
    geometry: { x: 10, y: 20, width: 180, height: 140, text: "" },
  };
}

function textItem(version = 1): Extract<BoardItem, { kind: "text" }> {
  return {
    id: ITEM_ID,
    kind: "text",
    z: 1,
    version,
    createdBy: ACTOR_ID,
    style: {
      kind: "text",
      color: "#20201e",
      fontSize: 20,
      fontFamily: "sans",
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 40, text: "$$\\frac{1}{2}$$" },
  };
}

function stamp(version = 1): BoardItem {
  return {
    id: ITEM_ID,
    kind: "stamp",
    z: 2,
    version,
    createdBy: ACTOR_ID,
    style: { kind: "stamp", color: "#e5484d", opacity: 0.8 },
    transform: [1, 0, 0, 1, 10, -5],
    geometry: { x: 100, y: 80, size: 72, stamp: "star" },
  };
}

function image(version = 1): BoardItem {
  return {
    id: ITEM_ID,
    kind: "image",
    z: 3,
    version,
    createdBy: ACTOR_ID,
    style: { kind: "image", opacity: 0.9, radius: 12 },
    transform: [1, 0, 0, 1, 15, -10],
    geometry: {
      x: 40,
      y: 50,
      width: 360,
      height: 240,
      assetId: `asset_${"c".repeat(43)}`,
      alt: "Microscope slide",
      mimeType: "image/png",
      intrinsicWidth: 1_200,
      intrinsicHeight: 800,
    },
  };
}

function zone(version = 1): Extract<BoardItem, { kind: "zone" }> {
  return {
    id: "018f47a1-7a2b-7c3d-8e4f-123456789ac1",
    kind: "zone",
    z: 3,
    version,
    createdBy: ACTOR_ID,
    style: {
      kind: "zone",
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 520, height: 320, title: "Evidence" },
  };
}

function line(version = 1): Extract<BoardItem, { kind: "line" }> {
  return {
    id: ITEM_ID,
    kind: "line",
    z: 4,
    version,
    createdBy: ACTOR_ID,
    style: { kind: "line", color: "#1e1e1e", width: 4, opacity: 1, arrowhead: "none" },
    transform: [1, 0, 0, 1, 10, 20],
    geometry: { x1: 0, y1: 0, x2: 100, y2: 0 },
  };
}

function polygon(): Extract<BoardItem, { kind: "polygon" }> {
  return {
    id: ITEM_ID,
    kind: "polygon",
    z: 5,
    version: 1,
    createdBy: ACTOR_ID,
    style: { kind: "stroke", color: "#1e1e1e", width: 4, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 100, height: 100, polygon: "rhombus" },
  };
}

function protractor(): Extract<BoardItem, { kind: "protractor" }> {
  return {
    id: ITEM_ID,
    kind: "protractor",
    z: 6,
    version: 1,
    createdBy: ACTOR_ID,
    style: { kind: "protractor", color: "#874fff", opacity: 0.78 },
    transform: [1, 0, 0, 1, 200, 200],
    geometry: { radius: 100 },
  };
}

function snapshot(items: BoardItem[] = [], seq = 0): BoardSnapshot {
  return { format: "cf-whiteboard-json", version: 1, seq, items };
}

describe("BoardModel", () => {
  it("renders an optimistic create and replaces it with the authoritative item", () => {
    const model = new BoardModel();
    model.load(snapshot());
    const command: CommitFrame = {
      v: 1,
      t: "client.commit",
      commandId: ACTION_ID,
      actionId: ACTION_ID,
      baseSeq: 0,
      op: {
        kind: "item.create",
        item: {
          id: ITEM_ID,
          kind: "rectangle",
          style: { kind: "stroke", color: "#20201e", width: 4, opacity: 1 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 10, y: 20, width: 100, height: 60, shape: "rectangle" },
        },
      },
    };
    model.queue(command, ACTOR_ID);
    expect(model.getItem(ITEM_ID)?.version).toBe(0);
    expect(model.pendingCount).toBe(1);

    model.applyAction({
      v: 1,
      t: "server.action",
      seq: 1,
      acceptedAt: 1,
      actor: { id: ACTOR_ID, displayName: "Sam" },
      commandId: ACTION_ID,
      actionId: ACTION_ID,
      op: { kind: "item.create", item: rectangle() },
    } as unknown as ServerAction);

    expect(model.pendingCount).toBe(0);
    expect(model.getItem(ITEM_ID)).toEqual(rectangle());
    expect(model.lastAppliedSeq).toBe(1);
  });

  it("applies shared canonical history changes", () => {
    const model = new BoardModel();
    model.load(snapshot([rectangle()], 1));
    model.applyAction({
      v: 1,
      t: "server.action",
      seq: 2,
      acceptedAt: 2,
      actor: { id: ACTOR_ID, displayName: "Sam" },
      commandId: "018f47a1-7a2b-7c3d-8e4f-123456789abf",
      actionId: "018f47a1-7a2b-7c3d-8e4f-123456789abf",
      op: {
        kind: "history.undo",
        targetActionId: ACTION_ID,
        changes: [{ kind: "item.remove", itemId: ITEM_ID, version: 2 }],
      },
    } as unknown as ServerAction);
    expect(model.getItem(ITEM_ID)).toBeUndefined();
    expect(model.lastAppliedSeq).toBe(2);
  });

  it("rejects a sequence gap before changing content", () => {
    const model = new BoardModel();
    model.load(snapshot([rectangle()], 1));
    expect(() =>
      model.applyAction({
        v: 1,
        t: "server.action",
        seq: 3,
        acceptedAt: 3,
        actor: { id: ACTOR_ID, displayName: "Sam" },
        commandId: ACTION_ID,
        actionId: ACTION_ID,
        op: { kind: "item.delete", itemId: ITEM_ID, version: 3 },
      } as unknown as ServerAction),
    ).toThrow(SequenceError);
    expect(model.getItem(ITEM_ID)).toEqual(rectangle());
  });

  it("caches transformed bounds for selection and hit testing", () => {
    const item = rectangle();
    item.transform = [1, 0, 0, 1, 30, -5];
    expect(itemBounds(item)).toEqual({ minX: 38, minY: 13, maxX: 142, maxY: 77 });
    const model = new BoardModel();
    model.load(snapshot([item], 1));
    expect(model.hitTest([50, 30])?.id).toBe(ITEM_ID);
    expect(model.hitTest([400, 300])).toBeUndefined();
  });

  it("uses measured MathJax dimensions for bounds and hit testing", () => {
    const item = textItem();
    item.geometry.text = `$$${"x".repeat(100)}$$`;
    const model = new BoardModel();
    model.load(snapshot([item], 1));
    expect(model.setRenderedTextSize(ITEM_ID, 1, 240, 180)).toBe(true);
    expect(model.getBounds(ITEM_ID)).toEqual({ minX: 8, minY: 18, maxX: 252, maxY: 202 });
    expect(itemBounds(model.getItem(ITEM_ID) as BoardItem)).toEqual({
      minX: 8,
      minY: 18,
      maxX: 252,
      maxY: 202,
    });
    expect(model.hitTest([200, 180], 0)?.id).toBe(ITEM_ID);
    expect(model.setRenderedTextSize(ITEM_ID, 0, 500, 500)).toBe(false);
  });

  it("builds a durable detach when measured and canonical bounds both leave a Section", () => {
    const section = zone();
    section.geometry.width = 260;
    section.geometry.height = 100;
    const item = textItem();
    item.geometry.text = Array.from({ length: 5 }, () => "$$\\frac{1}{2}$$").join("\n");
    item.sectionId = section.id;
    const model = new BoardModel();
    model.load(snapshot([section]));
    const command: CommitFrame = {
      v: 1,
      t: "client.commit",
      commandId: ACTION_ID,
      actionId: ACTION_ID,
      baseSeq: 0,
      op: {
        kind: "item.create",
        item: {
          id: item.id,
          kind: item.kind,
          sectionId: item.sectionId,
          style: item.style,
          transform: item.transform,
          geometry: item.geometry,
        },
      },
    };
    model.queue(command, ACTOR_ID);

    expect(model.setRenderedTextSize(ITEM_ID, 0, 240, 180)).toBe(true);
    expect(model.renderedTextSectionMembershipOperation(ITEM_ID, 0)).toBeNull();
    model.applyAction({
      v: 1,
      t: "server.action",
      seq: 1,
      acceptedAt: 1,
      actor: { id: ACTOR_ID, displayName: "Sam" },
      commandId: ACTION_ID,
      actionId: ACTION_ID,
      op: { kind: "item.create", item },
    } as unknown as ServerAction);

    expect(model.renderedTextSectionMembershipOperation(ITEM_ID, 1)).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 1,
      patch: { sectionId: null },
    });
  });

  it("keeps Section membership when only the local measurement leaves the Section", () => {
    const section = zone();
    section.geometry.width = 260;
    section.geometry.height = 100;
    const item = textItem();
    item.sectionId = section.id;
    const model = new BoardModel();
    model.load(snapshot([section, item], 1));

    // A client whose MathJax measurement overflows the Section must not detach while the
    // shared canonical estimate still fits, or clients that measure the same formula
    // differently take turns detaching and reattaching it forever.
    expect(model.setRenderedTextSize(ITEM_ID, 1, 240, 180)).toBe(true);
    expect(model.renderedTextSectionMembershipOperation(ITEM_ID, 1)).toBeNull();
  });

  it("builds a durable attachment when measured MathJax bounds fit a Section", () => {
    const section = zone();
    section.geometry.width = 100;
    section.geometry.height = 80;
    const item = textItem();
    const model = new BoardModel();
    model.load(snapshot([section, item], 1));

    expect(model.setRenderedTextSize(ITEM_ID, 1, 40, 24)).toBe(true);
    expect(model.renderedTextSectionMembershipOperation(ITEM_ID, 1)).toEqual({
      kind: "item.update",
      itemId: ITEM_ID,
      expectedVersion: 1,
      patch: { sectionId: section.id },
    });
  });

  it("finds connector anchors on transformed local edges", () => {
    const item = rectangle();
    item.transform = [0, 1, -1, 0, 200, 10];
    const model = new BoardModel();
    model.load(snapshot([item], 1));

    expect(itemBounds(item)).toEqual({ minX: 118, minY: 18, maxX: 182, maxY: 122 });
    expect(model.nearestConnectorAnchor([151, 19], 2)).toMatchObject({
      itemId: ITEM_ID,
      point: [151, 20],
      z: 1,
      distance: 1,
      source: "edge",
    });
    expect(model.nearestConnectorAnchor([151, 19], 0.5)).toBeUndefined();
  });

  it("does not expose empty AABB midpoints as anchors on rotated box items", () => {
    const item = image();
    const rotation = Math.PI / 4;
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    item.transform = [cosine, sine, -sine, cosine, 200, 10];
    const model = new BoardModel();
    model.load(snapshot([item], 1));

    const bounds = itemBounds(item);
    const emptyAabbMidpoint = [(bounds.minX + bounds.maxX) / 2, bounds.minY] as const;
    expect(model.nearestConnectorAnchor(emptyAabbMidpoint, 1)).toBeUndefined();

    const transformedTopMidpoint = [
      cosine * 220 - sine * 50 + 200,
      sine * 220 + cosine * 50 + 10,
    ] as const;
    const anchor = model.nearestConnectorAnchor(transformedTopMidpoint, 1);
    expect(anchor?.itemId).toBe(ITEM_ID);
    expect(anchor?.point[0]).toBeCloseTo(transformedTopMidpoint[0], 3);
    expect(anchor?.point[1]).toBeCloseTo(transformedTopMidpoint[1], 3);
    expect(anchor?.distance).toBeLessThan(0.001);
  });

  it("breaks equally near connector anchors by topmost z and excludes stamps", () => {
    const lower = rectangle();
    const higher: BoardItem = {
      ...structuredClone(lower),
      id: REMOTE_ID,
      z: 9,
    };
    const excluded = stamp();
    excluded.id = "018f47a1-7a2b-7c3d-8e4f-123456789ac2";
    excluded.z = 20;
    excluded.geometry = { x: 60, y: 18, size: 10, stamp: "star" };
    excluded.transform = [1, 0, 0, 1, 0, 0];
    const model = new BoardModel();
    model.load(snapshot([lower, higher, excluded], 1));

    expect(model.nearestConnectorAnchor([60, 19], 2)?.itemId).toBe(REMOTE_ID);
  });

  it("snaps to transformed line endpoints and finite segment projections", () => {
    const model = new BoardModel();
    model.load(snapshot([line()], 1));

    expect(model.nearestConnectorAnchor([9, 21], 2)).toMatchObject({
      itemId: ITEM_ID,
      point: [10, 20],
      source: "endpoint",
      t: 0,
    });
    const edge = model.nearestConnectorAnchor([61, 24], 5);
    expect(edge).toMatchObject({ itemId: ITEM_ID, point: [61, 20], source: "edge" });
    expect(edge?.distance).toBe(4);
    expect(edge?.t).toBeCloseTo(0.51);
  });

  it("excludes moving items from connector target lookup", () => {
    const model = new BoardModel();
    model.load(snapshot([line()], 1));

    expect(model.nearestConnectorAnchor([11, 21], 3, new Set([ITEM_ID]))).toBeUndefined();
    expect(model.nearestConnectorAnchor([11, 21], 3)).toBeDefined();
  });

  it("does not snap to an erased gap in a line", () => {
    const cut = line();
    cut.geometry.visiblePaths = [
      [
        [0, 0],
        [40, 0],
      ],
      [
        [60, 0],
        [100, 0],
      ],
    ];
    const model = new BoardModel();
    model.load(snapshot([cut], 1));

    expect(model.nearestConnectorAnchor([60, 21], 5)).toBeUndefined();
    expect(model.hitTest([60, 20], 0)).toBeUndefined();
    expect(model.nearestConnectorAnchor([50, 21], 2)).toMatchObject({
      point: [50, 20],
      source: "endpoint",
    });
  });

  it("does not retain cardinal snap anchors where a shape edge was erased", () => {
    const cut = rectangle() as Extract<BoardItem, { kind: "rectangle" }>;
    cut.geometry.visiblePaths = [
      [
        [10, 20],
        [50, 20],
      ],
      [
        [70, 20],
        [110, 20],
      ],
    ];
    const model = new BoardModel();
    model.load(snapshot([cut], 1));

    expect(model.nearestConnectorAnchor([60, 21], 2)).toBeUndefined();
  });

  it("snaps to a polygon perimeter rather than only its bounding box cardinals", () => {
    const model = new BoardModel();
    model.load(snapshot([polygon()], 1));

    const anchor = model.nearestConnectorAnchor([75, 30], 4);
    expect(anchor).toMatchObject({ itemId: ITEM_ID, source: "edge" });
    expect(anchor?.point[0]).toBeCloseTo(77.5);
    expect(anchor?.point[1]).toBeCloseTo(27.5);
    expect(anchor?.distance).toBeCloseTo(Math.sqrt(12.5));
  });

  it("snaps to protractor center, degree ticks, and its baseline", () => {
    const model = new BoardModel();
    model.load(snapshot([protractor()], 1));

    expect(model.nearestConnectorAnchor([200, 201], 2)).toMatchObject({
      point: [200, 200],
      source: "protractor-center",
    });
    expect(model.nearestConnectorAnchor([201, 99], 2)).toMatchObject({
      point: [200, 100],
      source: "protractor-tick",
    });
    expect(model.nearestConnectorAnchor([230, 202], 3)).toMatchObject({
      point: [230, 200],
      source: "edge",
    });
  });

  it("transforms protractor snap anchors when the tool is rotated", () => {
    const rotated = protractor();
    rotated.transform = [0, 1, -1, 0, 200, 200];
    const model = new BoardModel();
    model.load(snapshot([rotated], 1));

    expect(model.nearestConnectorAnchor([299, 201], 2)).toMatchObject({
      point: [300, 200],
      source: "protractor-tick",
    });
    expect(model.nearestConnectorAnchor([201, 230], 2)).toMatchObject({
      point: [200, 230],
      source: "edge",
    });
  });

  it("queries every saved, modifiable stroke touched by a swept eraser path", () => {
    const upper = line();
    upper.id = REMOTE_ID;
    upper.z = 8;
    const model = new BoardModel();
    model.load(snapshot([line(), upper], 1));
    const sweep = [
      [60, 10],
      [60, 30],
    ] as const;

    expect(model.strokeItemsNearPath(sweep, 2, () => true).map((item) => item.id)).toEqual([
      REMOTE_ID,
      ITEM_ID,
    ]);
    expect(
      model.strokeItemsNearPath(sweep, 2, (item) => item.id === ITEM_ID).map((item) => item.id),
    ).toEqual([ITEM_ID]);
    expect(model.strokeItemsNearPath([[400, 400]], 2, () => true)).toEqual([]);
  });

  it("uses the complete sticky rectangle for bounds and hit testing", () => {
    const item = sticky();
    expect(itemBounds(item)).toEqual({ minX: 40, minY: 15, maxX: 220, maxY: 155 });
    const model = new BoardModel();
    model.load(snapshot([item], 1));
    expect(model.hitTest([219, 154], 0)?.id).toBe(ITEM_ID);
    expect(model.hitTest([39, 14], 0)).toBeUndefined();
  });

  it("does not hit the empty corners of a rotated sticky AABB", () => {
    const item = sticky();
    const diagonal = Math.SQRT1_2;
    item.geometry = { x: 0, y: 0, width: 100, height: 100, text: "" };
    item.transform = [diagonal, diagonal, -diagonal, diagonal, 0, 0];
    const model = new BoardModel();
    model.load(snapshot([item], 1));

    expect(model.hitTest([0, 70], 0)?.id).toBe(ITEM_ID);
    expect(model.hitTest([-65, 5], 0)).toBeUndefined();
  });

  it("loads stamps from snapshots and uses their centered square for bounds and hits", () => {
    const item = stamp();
    expect(itemBounds(item)).toEqual({ minX: 74, minY: 39, maxX: 146, maxY: 111 });

    const model = new BoardModel();
    model.load(snapshot([item], 4));

    expect(model.getItem(ITEM_ID)).toEqual(item);
    expect(model.hitTest([75, 40], 0)?.kind).toBe("stamp");
    expect(model.hitTest([73, 38], 0)).toBeUndefined();
  });

  it("uses the full transformed image card for bounds and hit testing", () => {
    const item = image();
    expect(itemBounds(item)).toEqual({ minX: 55, minY: 40, maxX: 415, maxY: 280 });

    const model = new BoardModel();
    model.load(snapshot([item], 5));

    expect(model.getItem(ITEM_ID)).toEqual(item);
    expect(model.hitTest([56, 41], 0)?.kind).toBe("image");
    expect(model.hitTest([54, 39], 0)).toBeUndefined();
  });

  it("selects a zone only by its title or border so inner items remain reachable", () => {
    const inner = rectangle();
    const frame = zone();
    expect(itemBounds(frame)).toEqual({ minX: 0, minY: 0, maxX: 520, maxY: 320 });

    const model = new BoardModel();
    model.load(snapshot([inner, frame], 6));

    expect(model.hitTest([300, 20], 0)?.kind).toBe("zone");
    expect(model.hitTest([2, 180], 0)?.kind).toBe("zone");
    expect(model.hitTest([50, 60], 0)?.kind).toBe("rectangle");
    expect(model.hitTest([300, 180], 0)).toBeUndefined();
  });

  it("requires a marquee to fully contain a zone", () => {
    const frame = zone();
    const model = new BoardModel();
    model.load(snapshot([frame], 7));

    expect(
      model.intersecting({ minX: 0, minY: 0, maxX: 519, maxY: 320 }).map((item) => item.id),
    ).not.toContain(frame.id);
    expect(
      model.intersecting({ minX: -1, minY: -1, maxX: 521, maxY: 321 }).map((item) => item.id),
    ).toContain(frame.id);
  });

  it("retains the optimistic journal when a remote action makes rebase unsafe", () => {
    const model = new BoardModel();
    model.load(snapshot([rectangle()], 1));
    const rebaseStates: boolean[] = [];
    model.subscribeRebase((error) => rebaseStates.push(error !== null));
    const pending: CommitFrame = {
      v: 1,
      t: "client.commit",
      commandId: PENDING_ID,
      actionId: PENDING_ID,
      baseSeq: 1,
      op: {
        kind: "item.update",
        itemId: ITEM_ID,
        expectedVersion: 1,
        patch: { transform: [1, 0, 0, 1, 24, 0] },
      },
    };
    model.queue(pending, ACTOR_ID);

    model.applyAction({
      v: 1,
      t: "server.action",
      seq: 2,
      acceptedAt: 2,
      actor: { id: ACTOR_ID, displayName: "Taylor" },
      commandId: REMOTE_ID,
      actionId: REMOTE_ID,
      op: { kind: "item.delete", itemId: ITEM_ID, version: 2 },
    } as unknown as ServerAction);

    expect(model.getItem(ITEM_ID)).toBeUndefined();
    expect(model.pendingCount).toBe(1);
    expect(model.pendingCommands).toEqual([pending]);
    expect(model.rebaseError).toBeInstanceOf(Error);
    expect(rebaseStates).toEqual([true]);

    expect(model.discardOptimistic()).toEqual([pending]);
    expect(model.pendingCount).toBe(0);
    expect(model.rebaseError).toBeNull();
    expect(rebaseStates).toEqual([true, false]);
  });
});

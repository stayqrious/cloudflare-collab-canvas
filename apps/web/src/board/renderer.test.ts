import { textFontStack } from "@collab/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_RENDERED_VOTE_TABLES, VOTE_TABLE_STYLE } from "../activities/voting";
import type { BoardItem, TableItem } from "../types";
import {
  CanvasViewport,
  creatorBadge,
  creatorInitials,
  lineNode,
  renderVoteCounts,
  selectionObjectRotateHandle,
  selectionObjectScaleHandle,
  selectionResizeHandle,
  selectionResizeHandles,
  tableDimensionResizeHandles,
  tableNode,
  textNode,
  wrapStickyText,
  wrapTableCellText,
  zoneNode,
} from "./renderer";

describe("canvas text rendering", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders the persisted allowlisted font family for every text line", () => {
    const node = textNode(
      { x: 12, y: 34, text: "First\nSecond" },
      {
        kind: "text",
        color: "#112233",
        fontSize: 28,
        fontFamily: "handwritten",
        opacity: 0.8,
      },
    ) as unknown as FakeSvgNode;

    expect(node.attributes.get("font-family")).toBe(textFontStack("handwritten"));
    expect(node.attributes.get("font-size")).toBe("28");
    expect(node.children.map((child) => child.textContent)).toEqual(["First", "Second"]);
    expect(node.children[1]?.attributes.get("dy")).toBe("1.2em");
  });

  it("renders safe links and block typography without activating unsafe schemes", () => {
    const node = textNode(
      {
        x: 12,
        y: 34,
        text: "Read https://example.com/docs, not javascript:alert(1)",
      },
      {
        kind: "text",
        color: "#112233",
        fontSize: 24,
        fontFamily: "serif",
        fontWeight: "bold",
        fontStyle: "italic",
        textDecoration: "underline",
        opacity: 1,
      },
    ) as unknown as FakeSvgNode;

    expect(node.attributes.get("font-family")).toBe(textFontStack("serif"));
    expect(node.attributes.get("font-weight")).toBe("700");
    expect(node.attributes.get("font-style")).toBe("italic");
    expect(node.attributes.get("text-decoration")).toBe("underline");
    const link = node.children.find((child) => child.name === "a");
    expect(link?.dataset.boardLink).toBe("true");
    expect(link?.attributes.get("href")).toBe("https://example.com/docs");
    expect(link?.attributes.get("target")).toBe("_blank");
    expect(link?.children[0]?.textContent).toBe("https://example.com/docs");
    expect(node.children.filter((child) => child.name === "a")).toHaveLength(1);
    expect(node.children.at(-1)?.textContent).toContain("javascript:alert(1)");
  });
});

describe("creator attribution", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("uses compact display-name initials without exposing the actor identifier", () => {
    const item: Extract<BoardItem, { kind: "sticky" }> = {
      id: "sticky-attributed",
      kind: "sticky",
      z: 1,
      version: 1,
      createdBy: "private-stable-user-id",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "sticky",
        fill: "#fde68a",
        textColor: "#292524",
        fontSize: 20,
        opacity: 1,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Idea" },
    };

    expect(creatorInitials(" Coach Mira ")).toBe("CM");
    expect(creatorInitials("Asha")).toBe("AS");
    expect(creatorInitials("李 雷")).toBe("李雷");

    const badge = creatorBadge(item, "Coach Mira") as unknown as FakeSvgNode;
    expect(badge.classList.values.has("creator-badge")).toBe(true);
    expect(badge.children[1]?.textContent).toBe("CM");
    expect(badge.children.map((child) => child.textContent)).not.toContain(
      "private-stable-user-id",
    );
  });
});

describe("connector rendering", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a plain connector as one shaft", () => {
    const node = lineNode(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { kind: "line", color: "#20201e", width: 4, opacity: 1, arrowhead: "none" },
    ) as unknown as FakeSvgNode;

    expect(node.children).toHaveLength(1);
    expect(node.children[0]?.classList.values.has("connector-shaft")).toBe(true);
    expect(node.children[0]?.attributes.get("x2")).toBe("100");
  });

  it("renders a shared-math open arrowhead without closing or filling it", () => {
    const node = lineNode(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      { kind: "line", color: "#20201e", width: 4, opacity: 0.8, arrowhead: "arrow" },
    ) as unknown as FakeSvgNode;

    expect(node.children).toHaveLength(2);
    const arrowhead = node.children[1];
    expect(arrowhead?.classList.values.has("connector-arrowhead")).toBe(true);
    expect(arrowhead?.attributes.get("d")).toBe("M 88 5.4 L 100 0 L 88 -5.4");
    expect(arrowhead?.attributes.get("fill")).toBe("none");
    expect(arrowhead?.attributes.get("stroke-opacity")).toBe("0.8");
  });
});

describe("sticky note text wrapping", () => {
  it("wraps words within the default note and preserves blank paragraphs", () => {
    expect(wrapStickyText("one two three four\n\nsix", 180, 140, 20)).toEqual([
      "one two three",
      "four",
      "",
      "six",
    ]);
  });

  it("hard-wraps long Unicode tokens by code point", () => {
    expect(wrapStickyText("😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀", 180, 140, 20)).toEqual([
      "😀😀😀😀😀😀😀😀😀😀😀😀😀",
      "😀😀",
    ]);
  });

  it("normalizes common line endings and clips overflowing lines", () => {
    expect(wrapStickyText("one\r\ntwo\rthree\nfour\nfive", 180, 140, 20)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });
});

describe("selection resize handle", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a southeast card handle with a constant CSS-pixel touch target", () => {
    const item: Extract<BoardItem, { kind: "sticky" }> = {
      id: "sticky-a",
      kind: "sticky",
      z: 1,
      version: 4,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 12, 18],
      style: {
        kind: "sticky",
        fill: "#fde68a",
        textColor: "#292524",
        fontSize: 20,
        opacity: 1,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Idea" },
    };

    const handle = selectionResizeHandle(item, 2, { x: 4, y: 6 }) as unknown as FakeSvgNode;
    expect(handle.dataset).toEqual({ resizeHandle: "southeast", itemId: "sticky-a" });
    expect(handle.attributes.get("aria-hidden")).toBe("true");
    expect(handle.children).toHaveLength(2);
    expect(handle.children[0]?.attributes.get("cx")).toBe("206");
    expect(handle.children[0]?.attributes.get("cy")).toBe("184");
    expect(handle.children[0]?.attributes.get("r")).toBe("11");
    expect(handle.children[1]?.attributes.get("r")).toBe("3");
  });

  it("renders transformed column, row, and overall handles for a selected table", () => {
    const item: Extract<BoardItem, { kind: "table" }> = {
      id: "table-a",
      kind: "table",
      z: 1,
      version: 4,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 12, 18],
      style: {
        kind: "table",
        borderColor: "#a8a59d",
        fill: "#fffefa",
        headerFill: "#e8edff",
        textColor: "#20201e",
        fontSize: 16,
        opacity: 1,
      },
      geometry: {
        x: 10,
        y: 20,
        columnWidths: [100, 120],
        rowHeights: [40, 50],
        cells: [
          ["A", "B"],
          ["C", "D"],
        ],
      },
    };

    const axisHandles = tableDimensionResizeHandles(item, 2) as unknown as FakeSvgNode[];
    expect(axisHandles.map((handle) => handle.dataset)).toEqual([
      { resizeHandle: "table-column", resizeIndex: "0", itemId: "table-a" },
      { resizeHandle: "table-column", resizeIndex: "1", itemId: "table-a" },
      { resizeHandle: "table-row", resizeIndex: "0", itemId: "table-a" },
      { resizeHandle: "table-row", resizeIndex: "1", itemId: "table-a" },
    ]);
    expect(axisHandles[0]?.attributes.get("aria-hidden")).toBe("true");
    expect(axisHandles[0]?.children[0]?.attributes.get("cx")).toBe("122");
    expect(axisHandles[0]?.children[0]?.attributes.get("cy")).toBe("25");
    expect(axisHandles[0]?.children[0]?.attributes.get("r")).toBe("11");

    const allHandles = selectionResizeHandles(item, 2) as unknown as FakeSvgNode[];
    expect(allHandles).toHaveLength(5);
    expect(allHandles.at(-1)?.dataset.resizeHandle).toBe("southeast");
    expect(allHandles.at(-1)?.attributes.get("aria-hidden")).toBe("true");
  });

  it("renders one overall handle for a selected section", () => {
    const item: Extract<BoardItem, { kind: "zone" }> = {
      id: "zone-a",
      kind: "zone",
      z: 1,
      version: 2,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "zone",
        borderColor: "#a8a59d",
        fill: "#e8edff",
        textColor: "#4f5b75",
        fontSize: 18,
        opacity: 0.18,
      },
      geometry: { x: 20, y: 30, width: 520, height: 320, title: "Evidence" },
    };
    const handles = selectionResizeHandles(item, 1) as unknown as FakeSvgNode[];
    expect(handles).toHaveLength(1);
    expect(handles[0]?.dataset.resizeHandle).toBe("southeast");
    expect(handles[0]?.attributes.get("aria-hidden")).toBe("true");
  });
});

describe("shape and image transform handles", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("positions scale and rotate handles through an existing object transform", () => {
    const item: Extract<BoardItem, { kind: "rectangle" }> = {
      id: "shape-a",
      kind: "rectangle",
      z: 1,
      version: 3,
      createdBy: "student-a",
      transform: [0, 1, -1, 0, 200, 10],
      style: { kind: "stroke", color: "#20201e", width: 4, opacity: 1 },
      geometry: { x: 10, y: 20, width: 100, height: 60, shape: "rectangle" },
    };

    const scale = selectionObjectScaleHandle(item, 2, {
      x: 5,
      y: -4,
    }) as unknown as FakeSvgNode;
    expect(scale.dataset).toEqual({ scaleHandle: "southeast", itemId: "shape-a" });
    expect(scale.children[0]?.attributes.get("cx")).toBe("125");
    expect(scale.children[0]?.attributes.get("cy")).toBe("116");
    expect(scale.children[0]?.attributes.get("r")).toBe("11");
    expect(scale.children[1]?.attributes.get("r")).toBe("3");

    const rotate = selectionObjectRotateHandle(item, 2) as unknown as FakeSvgNode;
    expect(rotate.dataset).toEqual({ rotateHandle: "object", itemId: "shape-a" });
    expect(rotate.children[0]?.attributes.get("cx")).toBe("195");
    expect(rotate.children[0]?.attributes.get("cy")).toBe("70");
    expect(rotate.children[0]?.attributes.get("r")).toBe("11");
  });
});

describe("table cell text wrapping", () => {
  it("wraps plain text within the cell padding and preserves explicit blank lines", () => {
    expect(wrapTableCellText("one two three four\n\nfive", 120, 120, 16)).toEqual([
      "one two",
      "three four",
      "",
      "five",
    ]);
  });

  it("hard-wraps Unicode by code point and clips to the visible row height", () => {
    expect(wrapTableCellText("😀".repeat(24), 120, 64, 16)).toEqual([
      "😀".repeat(11),
      "😀".repeat(11),
    ]);
    expect(wrapTableCellText("", 120, 48, 16)).toEqual([]);
  });
});

type FakeSvgNode = {
  name: string;
  attributes: Map<string, string>;
  children: FakeSvgNode[];
  dataset: Record<string, string>;
  textContent: string | null;
  classList: { values: Set<string>; add: (...names: string[]) => void };
  setAttribute: (name: string, value: string) => void;
  append: (...children: FakeSvgNode[]) => void;
  replaceChildren: (...children: FakeSvgNode[]) => void;
};

function fakeSvgNode(name: string): FakeSvgNode {
  const node: FakeSvgNode = {
    name,
    attributes: new Map(),
    children: [],
    dataset: {},
    textContent: null,
    classList: {
      values: new Set(),
      add: (...names) => {
        for (const value of names) node.classList.values.add(value);
      },
    },
    setAttribute: (attribute, value) => node.attributes.set(attribute, value),
    append: (...children) => node.children.push(...children),
    replaceChildren: (...children) => {
      node.children = [...children];
    },
  };
  return node;
}

describe("section rendering", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a named, accessible section with fill-only opacity", () => {
    const node = zoneNode(
      "zone/unsafe",
      { x: 20, y: 30, width: 520, height: 320, title: "Evidence <script>" },
      {
        kind: "zone",
        borderColor: "#a8a59d",
        fill: "#e8edff",
        textColor: "#4f5b75",
        fontSize: 18,
        opacity: 0.18,
      },
    ) as unknown as FakeSvgNode;

    expect(node.attributes.get("role")).toBe("group");
    expect(node.attributes.get("aria-label")).toBe("Section: Evidence <script>");
    expect(node.dataset.zoneTitle).toBe("Evidence <script>");
    const fill = node.children.find((child) => child.classList.values.has("zone-fill"));
    const border = node.children.find((child) => child.classList.values.has("zone-border"));
    const title = node.children.find((child) => child.classList.values.has("zone-title"));
    expect(fill?.attributes.get("fill-opacity")).toBe("0.18");
    expect(border?.attributes.get("stroke")).toBe("#a8a59d");
    expect(border?.attributes.has("opacity")).toBe(false);
    expect(title?.textContent).toBeNull();
    expect(title?.children).toHaveLength(1);
    expect(title?.children[0]?.textContent).toBe("Evidence <script>");
    expect(title?.attributes.get("clip-path")).toBe("url(#zone-title-clip-zone-unsafe)");
  });

  it("keeps a linkified Section title pointer-active", () => {
    const node = zoneNode(
      "linked-zone",
      { x: 20, y: 30, width: 520, height: 320, title: "https://example.com/evidence" },
      {
        kind: "zone",
        borderColor: "#a8a59d",
        fill: "#e8edff",
        textColor: "#4f5b75",
        fontSize: 18,
        opacity: 0.18,
      },
    ) as unknown as FakeSvgNode;
    const title = node.children.find((child) => child.classList.values.has("zone-title"));

    expect(title?.classList.values.has("has-board-text-link")).toBe(true);
    expect(title?.children[0]?.name).toBe("a");
  });

  it("uses the bold Section default only when font weight is omitted", () => {
    const geometry = { x: 20, y: 30, width: 520, height: 320, title: "Evidence" };
    const style = {
      kind: "zone" as const,
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    };
    const defaultTitle = (
      zoneNode("default-zone", geometry, style) as unknown as FakeSvgNode
    ).children.find((child) => child.classList.values.has("zone-title"));
    const normalTitle = (
      zoneNode("normal-zone", geometry, {
        ...style,
        fontWeight: "normal",
      }) as unknown as FakeSvgNode
    ).children.find((child) => child.classList.values.has("zone-title"));

    expect(defaultTitle?.attributes.get("font-weight")).toBe("700");
    expect(normalTitle?.attributes.get("font-weight")).toBe("normal");
  });

  it("renders an accessible lock badge and state for a locked Section", () => {
    const node = zoneNode(
      "locked-zone",
      { x: 20, y: 30, width: 520, height: 320, title: "Frozen work", locked: true },
      {
        kind: "zone",
        borderColor: "#a8a59d",
        fill: "#e8edff",
        textColor: "#4f5b75",
        fontSize: 18,
        opacity: 0.18,
      },
    ) as unknown as FakeSvgNode;

    expect(node.dataset.sectionLocked).toBe("true");
    expect(node.attributes.get("aria-label")).toBe("Locked Section: Frozen work");
    const badge = node.children.find((child) => child.classList.values.has("zone-lock-badge"));
    expect(badge?.children).toHaveLength(3);
    expect(badge?.attributes.get("pointer-events")).toBe("none");
  });
});

describe("table typography defaults", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lets explicit normal override both header and body weight defaults", () => {
    const geometry = {
      x: 0,
      y: 0,
      columnWidths: [120],
      rowHeights: [40, 40],
      cells: [["Header"], ["Body"]],
      headerRow: true,
    };
    const style = {
      kind: "table" as const,
      borderColor: "#64748b",
      fill: "#ffffff",
      headerFill: "#dbeafe",
      textColor: "#0f172a",
      fontSize: 14,
      opacity: 1,
    };
    const rowWeights = (node: FakeSvgNode) =>
      node.children
        .filter((child) => child.classList.values.has("table-row"))
        .map((row) =>
          row.children[0]?.children
            .find((child) => child.classList.values.has("table-cell-text"))
            ?.attributes.get("font-weight"),
        );

    const defaultNode = tableNode("default-table", geometry, style) as unknown as FakeSvgNode;
    const normalNode = tableNode("normal-table", geometry, {
      ...style,
      fontWeight: "normal",
    }) as unknown as FakeSvgNode;

    expect(rowWeights(defaultNode)).toEqual(["700", "500"]);
    expect(rowWeights(normalNode)).toEqual(["normal", "normal"]);
  });

  it("keeps linkified table-cell text pointer-active", () => {
    const node = tableNode(
      "linked-table",
      {
        x: 0,
        y: 0,
        columnWidths: [240],
        rowHeights: [48],
        cells: [["https://example.com/evidence"]],
        headerRow: false,
      },
      {
        kind: "table",
        borderColor: "#64748b",
        fill: "#ffffff",
        headerFill: "#dbeafe",
        textColor: "#0f172a",
        fontSize: 14,
        opacity: 1,
      },
    ) as unknown as FakeSvgNode;
    const row = node.children.find((child) => child.classList.values.has("table-row"));
    const text = row?.children[0]?.children.find((child) =>
      child.classList.values.has("table-cell-text"),
    );

    expect(text?.classList.values.has("has-board-text-link")).toBe(true);
    expect(text?.children[0]?.name).toBe("a");
  });
});

describe("derived vote counts", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders pointer-free count pills and replaces them when stamp totals change", () => {
    const table: TableItem = {
      id: "vote-table",
      kind: "table",
      z: 1,
      version: 1,
      createdBy: "teacher",
      transform: [1, 0, 0, 1, 40, 60],
      style: { ...VOTE_TABLE_STYLE },
      geometry: {
        x: 0,
        y: 0,
        columnWidths: [160, 160],
        rowHeights: [52, 160],
        cells: [
          ["Yes", "Not yet"],
          ["", ""],
        ],
        headerRow: true,
      },
    };
    const first: BoardItem = {
      id: "first-vote",
      kind: "stamp",
      z: 2,
      version: 2,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 40, 60],
      style: { kind: "stamp", color: "#e5484d", opacity: 1 },
      geometry: { x: 80, y: 100, size: 36, stamp: "star" },
    };
    const second: BoardItem = {
      ...first,
      id: "second-vote",
      z: 3,
      version: 3,
      createdBy: "student-b",
      geometry: { x: 240, y: 100, size: 36, stamp: "check" },
    };
    const layer = fakeSvgNode("g");

    renderVoteCounts(layer as unknown as SVGGElement, [table]);
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0]?.attributes.get("pointer-events")).toBe("none");
    expect(layer.children[0]?.attributes.get("transform")).toBe("matrix(1 0 0 1 40 60)");
    expect(layer.children[0]?.children.map((badge) => badge.dataset.voteCount)).toEqual(["0", "0"]);

    renderVoteCounts(layer as unknown as SVGGElement, [table, first, second]);
    expect(layer.children).toHaveLength(1);
    expect(layer.children[0]?.children.map((badge) => badge.dataset.voteCount)).toEqual(["1", "1"]);
    expect(layer.children[0]?.attributes.get("aria-label")).toContain("Yes, 1 vote");
  });

  it("renders no more than the classroom-safe vote-table cap", () => {
    const source: TableItem = {
      id: "vote-table-source",
      kind: "table",
      z: 1,
      version: 1,
      createdBy: "teacher",
      transform: [1, 0, 0, 1, 0, 0],
      style: { ...VOTE_TABLE_STYLE },
      geometry: {
        x: 0,
        y: 0,
        columnWidths: [160, 160],
        rowHeights: [52, 160],
        cells: [
          ["Yes", "Not yet"],
          ["", ""],
        ],
        headerRow: true,
      },
    };
    const tables = Array.from({ length: MAX_RENDERED_VOTE_TABLES + 1 }, (_, index) => ({
      ...structuredClone(source),
      id: `vote-table-${index}`,
      z: index + 1,
    }));
    const layer = fakeSvgNode("g");

    renderVoteCounts(layer as unknown as SVGGElement, tables);
    expect(layer.children).toHaveLength(MAX_RENDERED_VOTE_TABLES);
    expect(layer.children.at(-1)?.dataset.voteTableId).toBe(
      `vote-table-${MAX_RENDERED_VOTE_TABLES - 1}`,
    );
  });
});

describe("canvas viewport view state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(): void {
          this.callback([], this as unknown as ResizeObserver);
        }
        disconnect(): void {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("gets and sets center plus zoom while retaining zoom-only subscriptions", () => {
    const attributes = new Map<string, string>();
    const svg = {
      dataset: {} as DOMStringMap,
      style: { setProperty: vi.fn() },
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 800, height: 600 }),
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    } as unknown as SVGSVGElement;
    const viewport = new CanvasViewport(svg);
    const zoomListener = vi.fn();
    const viewListener = vi.fn();
    viewport.subscribe(zoomListener);
    viewport.subscribeView(viewListener);

    expect(viewport.viewState).toEqual({ center: { x: 400, y: 300 }, zoom: 1 });
    viewport.setViewState({ center: { x: 120, y: -30 }, zoom: 2 });

    expect(viewport.viewState).toEqual({ center: { x: 120, y: -30 }, zoom: 2 });
    expect(attributes.get("viewBox")).toBe("-80 -180 400 300");
    expect(zoomListener).toHaveBeenLastCalledWith(2);
    expect(viewListener).toHaveBeenLastCalledWith({ center: { x: 120, y: -30 }, zoom: 2 });

    viewport.panByPixels(20, -10);
    expect(viewport.viewState).toEqual({ center: { x: 110, y: -25 }, zoom: 2 });
    expect(zoomListener).toHaveBeenCalledTimes(1);
    expect(viewListener).toHaveBeenLastCalledWith({ center: { x: 110, y: -25 }, zoom: 2 });
  });

  it("locks a calibrated rectangle to the same A5 page on differently sized screens", () => {
    for (const rect of [
      { left: 100, top: 200, width: 400, height: 600 },
      { left: 200, top: 150, width: 1600, height: 800 },
    ]) {
      const attributes = new Map<string, string>();
      const svg = {
        dataset: {} as DOMStringMap,
        style: { setProperty: vi.fn() },
        getBoundingClientRect: () => rect,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      } as unknown as SVGSVGElement;
      const viewport = new CanvasViewport(svg);
      viewport.setFixedPage({ width: 740, height: 1050 });
      expect(
        viewport.clientToBoard(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ).toEqual([370, 525]);
      expect(viewport.boardToClient([740, 1050])).toEqual([
        rect.left + rect.width,
        rect.top + rect.height,
      ]);
      viewport.panByPixels(80, 120);
      viewport.zoomAt(300, 400, 3);
      viewport.reset();
      viewport.fit({ minX: -100, minY: -100, maxX: 2000, maxY: 2000 });
      viewport.setViewState({ center: { x: 2000, y: 3000 }, zoom: 2 });
      expect(attributes.get("viewBox")).toBe("0 0 740 1050");
      expect(attributes.get("preserveAspectRatio")).toBe("none");
      expect(viewport.viewBounds).toEqual({ minX: 0, minY: 0, maxX: 740, maxY: 1050 });
      viewport.setFixedPage(null);
      viewport.reset();
      viewport.panByPixels(20, 30);
      expect(viewport.clientToBoard(rect.left, rect.top)).toEqual([-20, -30]);
      viewport.destroy();
    }
  });

  it("rejects non-finite view state and clamps zoom to the supported range", () => {
    const svg = {
      dataset: {} as DOMStringMap,
      style: { setProperty: vi.fn() },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
      setAttribute: vi.fn(),
    } as unknown as SVGSVGElement;
    const viewport = new CanvasViewport(svg);

    expect(() => viewport.setViewState({ center: { x: Number.NaN, y: 0 }, zoom: 1 })).toThrow(
      RangeError,
    );
    viewport.setViewState({ center: { x: 0, y: 0 }, zoom: 20 });
    expect(viewport.viewState.zoom).toBe(8);
  });
});

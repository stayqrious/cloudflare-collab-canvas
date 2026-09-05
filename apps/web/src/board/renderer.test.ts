import { textFontStack } from "@collab/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_RENDERED_VOTE_TABLES, VOTE_TABLE_STYLE } from "../activities/voting";
import type { BoardItem, TableItem } from "../types";
import { VIDEO_EMBED_WIDTH } from "./links";
import {
  BoardRenderer,
  CanvasViewport,
  commentMarkerNode,
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

describe("lightweight movement previews", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElement: (name: string) => fakeSvgNode(name),
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders a lightweight card without creating another video iframe", () => {
    const item: Extract<BoardItem, { kind: "text" }> = {
      id: "video-item",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: "owner",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "text",
        color: "#111827",
        fontSize: 20,
        fontFamily: "sans",
        opacity: 0.4,
      },
      geometry: {
        x: 20,
        y: 40,
        text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        embed: "video",
      },
    };
    const localLayer = fakeSvgNode("g");
    const setSelection = vi.fn();
    const renderer = {
      clearLocalLayer: () => localLayer.replaceChildren(),
      imageAssets: { load: vi.fn() },
      localLayer,
      model: { getItem: (id: string) => (id === item.id ? item : undefined) },
      setSelection,
    } as unknown as BoardRenderer;

    BoardRenderer.prototype.showMovePreview.call(renderer, [item.id], 24, 12);

    const preview = localLayer.children[0];
    expect(preview?.classList.values.has("move-preview")).toBe(true);
    expect(preview?.classList.values.has("video-embed-preview-item")).toBe(true);
    expect(preview?.attributes.get("opacity")).toBe("0.4");
    const foreign = preview?.children.find((child) => child.name === "foreignObject");
    const card = foreign?.children[0];
    expect(card?.children.some((child) => child.name === "iframe")).toBe(false);
    expect(card?.children[1]?.className).toBe("video-embed-preview");
    expect(card?.children[1]?.textContent).toBe("Video preview");
    expect(setSelection).toHaveBeenCalledWith([item.id], { x: 24, y: 12 });
  });

  it("repositions a rendered video card in place so its player is not reloaded", () => {
    const iframes: FakeSvgNode[] = [];
    vi.stubGlobal("document", {
      createElement: (name: string) => {
        const node = fakeSvgNode(name);
        if (name === "iframe") iframes.push(node);
        return node;
      },
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });

    const item: Extract<BoardItem, { kind: "text" }> = {
      id: "video-item",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: "owner",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "text",
        color: "#111827",
        fontSize: 20,
        fontFamily: "sans",
        opacity: 1,
      },
      geometry: {
        x: 20,
        y: 40,
        text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        embed: "video",
      },
    };
    const drawingArea = fakeSvgNode("g");
    const itemNodes = new Map<string, FakeSvgNode>();
    const insertInPaintOrder = vi.fn((node: FakeSvgNode) => drawingArea.append(node));
    const renderer = {
      drawingArea,
      imageAssets: { load: vi.fn(), retain: vi.fn() },
      insertInPaintOrder,
      itemNodes,
      model: {
        getItem: (id: string) => (id === item.id ? item : undefined),
        items: new Map([[item.id, item]]),
      },
      renderCommentMarkers: vi.fn(),
      renderVoteCounts: vi.fn(),
      resolveCreatorName: () => "",
      selectedIds: new Set<string>(),
      setSelection: vi.fn(),
    } as unknown as BoardRenderer;
    const render = (
      BoardRenderer.prototype as unknown as {
        render: (this: BoardRenderer, changedIds: ReadonlySet<string> | null) => void;
      }
    ).render;

    render.call(renderer, new Set([item.id]));
    const created = itemNodes.get(item.id);
    expect(iframes).toHaveLength(1);
    expect(insertInPaintOrder).toHaveBeenCalledTimes(1);

    item.geometry.x = 120;
    render.call(renderer, new Set([item.id]));

    // Rebuilding or re-inserting the node would detach the iframe and restart playback.
    expect(itemNodes.get(item.id)).toBe(created);
    expect(iframes).toHaveLength(1);
    expect(insertInPaintOrder).toHaveBeenCalledTimes(1);
    const foreign = created?.children.find((child) => child.name === "foreignObject");
    const border = created?.children.find((child) =>
      child.classList.values.has("video-embed-border"),
    );
    const dragFrame = created?.children.find((child) =>
      child.classList.values.has("video-embed-drag-frame"),
    );
    expect(foreign?.attributes.get("x")).toBe("120");
    expect(dragFrame?.attributes.get("x")).toBe("120");
    expect(dragFrame?.dataset.videoDragFrame).toBe("true");
    expect(border?.attributes.get("x")).toBe("120");
  });

  it("rebuilds a video card when the item points at a different video", () => {
    const iframes: FakeSvgNode[] = [];
    vi.stubGlobal("document", {
      createElement: (name: string) => {
        const node = fakeSvgNode(name);
        if (name === "iframe") iframes.push(node);
        return node;
      },
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });

    const item: Extract<BoardItem, { kind: "text" }> = {
      id: "video-item",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: "owner",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "text",
        color: "#111827",
        fontSize: 20,
        fontFamily: "sans",
        opacity: 1,
      },
      geometry: {
        x: 20,
        y: 40,
        text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        embed: "video",
      },
    };
    const drawingArea = fakeSvgNode("g");
    const itemNodes = new Map<string, FakeSvgNode>();
    const renderer = {
      drawingArea,
      imageAssets: { load: vi.fn(), retain: vi.fn() },
      insertInPaintOrder: vi.fn((node: FakeSvgNode) => drawingArea.append(node)),
      itemNodes,
      model: {
        getItem: (id: string) => (id === item.id ? item : undefined),
        items: new Map([[item.id, item]]),
      },
      renderCommentMarkers: vi.fn(),
      renderVoteCounts: vi.fn(),
      resolveCreatorName: () => "",
      selectedIds: new Set<string>(),
      setSelection: vi.fn(),
    } as unknown as BoardRenderer;
    const render = (
      BoardRenderer.prototype as unknown as {
        render: (this: BoardRenderer, changedIds: ReadonlySet<string> | null) => void;
      }
    ).render;

    render.call(renderer, new Set([item.id]));
    const created = itemNodes.get(item.id);

    item.geometry.text = "https://vimeo.com/76979871";
    render.call(renderer, new Set([item.id]));

    expect(itemNodes.get(item.id)).not.toBe(created);
    expect(iframes).toHaveLength(2);
  });

  it("renders formula source without queueing MathJax work", () => {
    const item: Extract<BoardItem, { kind: "text" }> = {
      id: "math-item",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: "owner",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "text",
        color: "#111827",
        fontSize: 20,
        fontFamily: "sans",
        opacity: 1,
      },
      geometry: { x: 20, y: 40, text: "$$x^2$$" },
    };
    const localLayer = fakeSvgNode("g");
    const renderer = {
      clearLocalLayer: () => localLayer.replaceChildren(),
      imageAssets: { load: vi.fn() },
      localLayer,
      model: { getItem: (id: string) => (id === item.id ? item : undefined) },
      setSelection: vi.fn(),
    } as unknown as BoardRenderer;

    BoardRenderer.prototype.showMovePreview.call(renderer, [item.id], 24, 12);

    const preview = localLayer.children[0];
    expect(preview?.classList.values.has("move-preview")).toBe(true);
    expect(preview?.classList.values.has("board-math-preview")).toBe(true);
    expect(preview?.attributes.get("aria-hidden")).toBe("true");
    expect(preview?.dataset.mathState).toBeUndefined();
    expect(preview?.children[0]?.textContent).toBe("$$x^2$$");
  });

  it("keeps sticky, table, and Section formula previews free of MathJax work", () => {
    const items: BoardItem[] = [
      {
        id: "math-sticky",
        kind: "sticky",
        z: 1,
        version: 1,
        createdBy: "owner",
        transform: [1, 0, 0, 1, 0, 0],
        style: {
          kind: "sticky",
          fill: "#fde68a",
          textColor: "#292524",
          fontSize: 20,
          opacity: 1,
        },
        geometry: { x: 10, y: 20, width: 180, height: 140, text: "$$x^2$$" },
      },
      {
        id: "math-table",
        kind: "table",
        z: 2,
        version: 1,
        createdBy: "owner",
        transform: [1, 0, 0, 1, 0, 0],
        style: {
          kind: "table",
          borderColor: "#64748b",
          fill: "#ffffff",
          headerFill: "#dbeafe",
          textColor: "#0f172a",
          fontSize: 16,
          opacity: 1,
        },
        geometry: {
          x: 10,
          y: 20,
          columnWidths: [180],
          rowHeights: [60],
          cells: [["$$x^2$$"]],
          headerRow: false,
        },
      },
      {
        id: "math-zone",
        kind: "zone",
        z: 3,
        version: 1,
        createdBy: "owner",
        transform: [1, 0, 0, 1, 0, 0],
        style: {
          kind: "zone",
          borderColor: "#a8a59d",
          fill: "#e8edff",
          textColor: "#4f5b75",
          fontSize: 18,
          opacity: 0.18,
        },
        geometry: { x: 20, y: 30, width: 520, height: 320, title: "$$x^2$$" },
      },
    ];
    const localLayer = fakeSvgNode("g");
    let current = items[0];
    const renderer = {
      clearLocalLayer: () => localLayer.replaceChildren(),
      imageAssets: { load: vi.fn() },
      localLayer,
      model: { getItem: () => current },
      setSelection: vi.fn(),
    } as unknown as BoardRenderer;

    for (const item of items) {
      current = item;
      BoardRenderer.prototype.showMovePreview.call(renderer, [item.id], 24, 12);
      const preview = localLayer.children[0];
      expect(preview).toBeDefined();
      if (!preview) continue;
      const descendants = fakeDescendants(preview);
      expect(
        descendants.some((node) => node.name === "foreignObject"),
        item.kind,
      ).toBe(false);
      expect(
        descendants.some((node) =>
          [...node.classList.values].some((name) => name.endsWith("-math-preview")),
        ),
        item.kind,
      ).toBe(true);
      expect(
        descendants.some((node) => node.textContent?.includes("$$x^2$$")),
        item.kind,
      ).toBe(true);
    }

    const sticky = items[0];
    if (sticky?.kind !== "sticky") throw new Error("Expected sticky fixture.");
    BoardRenderer.prototype.showLocalSticky.call(renderer, sticky.geometry, sticky.style);
    const draft = localLayer.children[0];
    expect(draft).toBeDefined();
    if (!draft) return;
    expect(fakeDescendants(draft).some((node) => node.name === "foreignObject")).toBe(false);
    expect(
      fakeDescendants(draft).some((node) => node.classList.values.has("sticky-math-preview")),
    ).toBe(true);
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

  it("adds an AI disc to the responsible author's badge for assisted content", () => {
    const item: Extract<BoardItem, { kind: "sticky" }> = {
      id: "sticky-ai-assisted",
      kind: "sticky",
      z: 1,
      version: 1,
      createdBy: "responsible-teacher-id",
      assistedBy: "ai",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "sticky",
        fill: "#eee5ff",
        textColor: "#38284f",
        fontSize: 16,
        opacity: 1,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Synthesis" },
    };

    const badge = creatorBadge(item, "Coach Mira") as unknown as FakeSvgNode;
    expect(badge.classList.values.has("creator-badge-ai")).toBe(true);
    expect(badge.children[1]?.textContent).toBe("CM");
    const aiText = badge.children.find((child) => child.textContent === "AI");
    expect(aiText?.name).toBe("text");
    expect(badge.children.map((child) => child.textContent)).not.toContain(
      "responsible-teacher-id",
    );
  });
});

describe("assistance marks", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElement: (name: string) => fakeSvgNode(name),
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const base = {
    z: 1,
    version: 1,
    createdBy: "responsible-teacher-id",
    assistedBy: "ai" as const,
    transform: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
  };
  const textStyle = {
    kind: "text" as const,
    color: "#111827",
    fontSize: 20,
    fontFamily: "sans" as const,
    opacity: 1,
  };

  /** Drives the authoritative render path so `itemNode` is exercised as the board uses it. */
  function authoritativeRenderer(item: BoardItem, creatorName = "Coach Mira") {
    const drawingArea = fakeSvgNode("g");
    const itemNodes = new Map<string, FakeSvgNode>();
    const renderer = {
      drawingArea,
      imageAssets: { load: vi.fn(), retain: vi.fn() },
      insertInPaintOrder: vi.fn((node: FakeSvgNode) => drawingArea.append(node)),
      itemNodes,
      model: {
        getItem: (id: string) => (id === item.id ? item : undefined),
        items: new Map([[item.id, item]]),
        setRenderedTextSize: vi.fn(() => false),
      },
      renderCommentMarkers: vi.fn(),
      renderVoteCounts: vi.fn(),
      resolveCreatorName: () => creatorName,
      selectedIds: new Set<string>(),
      setSelection: vi.fn(),
    } as unknown as BoardRenderer;
    const render = (
      BoardRenderer.prototype as unknown as {
        render: (this: BoardRenderer, changedIds: ReadonlySet<string> | null) => void;
      }
    ).render;
    return {
      render: (): FakeSvgNode => {
        render.call(renderer, new Set([item.id]));
        const node = itemNodes.get(item.id);
        if (!node) throw new Error("item was not rendered");
        return node;
      },
    };
  }

  const marksIn = (node: FakeSvgNode) =>
    fakeDescendants(node).filter((child) => child.classList.values.has("assistance-mark"));

  const expectSingleMark = (node: FakeSvgNode) => {
    const marks = marksIn(node);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.attributes.get("aria-hidden")).toBe("true");
    expect(marks[0]?.attributes.get("pointer-events")).toBe("none");
    expect(marks[0]?.children.map((child) => child.textContent)).toContain("AI");
    expect(node.dataset.assistedBy).toBe("ai");
    expect(node.attributes.get("aria-description")).toBe(
      "Created by Coach Mira with AI assistance",
    );
  };

  it("wraps assisted plain text in a group that carries one mark", () => {
    const item: BoardItem = {
      ...base,
      id: "text-ai",
      kind: "text",
      style: textStyle,
      geometry: { x: 20, y: 40, text: "Summary" },
    };
    const node = authoritativeRenderer(item).render();
    expectSingleMark(node);
    expect(node.name).toBe("g");
    expect(node.classList.values.has("board-item-text")).toBe(true);
    expect(node.attributes.get("transform")).toBe("matrix(1 0 0 1 0 0)");
    expect(node.children[0]?.name).toBe("text");
    expect(node.children[0]?.textContent ?? node.children[0]?.children[0]?.textContent).toBe(
      "Summary",
    );
  });

  it("marks an assisted table once", () => {
    const item: BoardItem = {
      ...base,
      id: "table-ai",
      kind: "table",
      style: {
        kind: "table",
        borderColor: "#20201e",
        fill: "#ffffff",
        headerFill: "#f2f0ea",
        textColor: "#20201e",
        fontSize: 14,
        opacity: 1,
      },
      geometry: {
        x: 10,
        y: 10,
        columnWidths: [120, 120],
        rowHeights: [32, 32],
        cells: [
          ["Claim", "Evidence"],
          ["", ""],
        ],
      },
    };
    const node = authoritativeRenderer(item).render();
    expectSingleMark(node);
    expect(marksIn(node)[0]?.attributes.get("transform")).toBe("translate(233 13)");
  });

  it("marks an assisted section at the right end of its title bar", () => {
    const item: BoardItem = {
      ...base,
      id: "zone-ai",
      kind: "zone",
      style: {
        kind: "zone",
        borderColor: "#1f5eff",
        fill: "#e8f0ff",
        textColor: "#20201e",
        fontSize: 16,
        opacity: 1,
      },
      geometry: { x: 0, y: 0, width: 400, height: 300, title: "Ideas" },
    };
    const node = authoritativeRenderer(item).render();
    expectSingleMark(node);
  });

  it("marks an assisted connector outside its top-right point", () => {
    const item: BoardItem = {
      ...base,
      id: "line-ai",
      kind: "line",
      style: { kind: "line", color: "#20201e", width: 4, opacity: 1, arrowhead: "none" },
      geometry: { x1: 0, y1: 50, x2: 100, y2: 0 },
    };
    const node = authoritativeRenderer(item).render();
    expectSingleMark(node);
    expect(marksIn(node)[0]?.attributes.get("transform")).toBe("translate(102 -12)");
  });

  it("wraps assisted strokes and outline shapes so they can carry a mark", () => {
    const pencil: BoardItem = {
      ...base,
      id: "pencil-ai",
      kind: "pencil",
      style: { kind: "stroke", color: "#20201e", width: 3, opacity: 1 },
      geometry: {
        points: [
          [0, 10],
          [20, 0],
          [40, 10],
        ],
      },
    };
    const rectangle: BoardItem = {
      ...base,
      id: "rectangle-ai",
      kind: "rectangle",
      style: { kind: "stroke", color: "#20201e", width: 3, opacity: 1 },
      geometry: { x: 10, y: 20, width: 100, height: 60, shape: "rectangle" },
    };
    for (const item of [pencil, rectangle]) {
      const node = authoritativeRenderer(item).render();
      expectSingleMark(node);
      expect(node.name).toBe("g");
      expect(node.children[0]?.name).toBe(item.kind === "pencil" ? "path" : "rect");
      expect(node.classList.values.has(`board-item-${item.kind}`)).toBe(true);
    }
  });

  it("falls back to the standalone mark on a sticky when no creator name is known", () => {
    const item: BoardItem = {
      ...base,
      id: "sticky-ai-anonymous",
      kind: "sticky",
      style: { kind: "sticky", fill: "#fde68a", textColor: "#292524", fontSize: 20, opacity: 1 },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Idea" },
    };
    const node = authoritativeRenderer(item, "").render();
    expect(marksIn(node)).toHaveLength(1);
    expect(node.dataset.assistedBy).toBe("ai");
    expect(node.attributes.get("aria-description")).toBe("Created with AI assistance");
    expect(fakeDescendants(node).some((child) => child.classList.values.has("creator-badge"))).toBe(
      false,
    );
  });

  it("keeps the badge, not a standalone mark, on an assisted sticky with a known creator", () => {
    const item: BoardItem = {
      ...base,
      id: "sticky-ai-badged",
      kind: "sticky",
      style: { kind: "sticky", fill: "#fde68a", textColor: "#292524", fontSize: 20, opacity: 1 },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Idea" },
    };
    const node = authoritativeRenderer(item).render();
    expect(marksIn(node)).toHaveLength(0);
    expect(node.dataset.assistedBy).toBe("ai");
    expect(node.attributes.get("aria-description")).toBe(
      "Created by Coach Mira with AI assistance",
    );
    const badge = fakeDescendants(node).find((child) =>
      child.classList.values.has("creator-badge-ai"),
    );
    expect(badge).toBeDefined();
  });

  it("leaves unassisted items unmarked and unwrapped", () => {
    const { assistedBy: _assistedBy, ...plain } = base;
    const item: BoardItem = {
      ...plain,
      id: "text-plain",
      kind: "text",
      style: textStyle,
      geometry: { x: 20, y: 40, text: "Typed by hand" },
    };
    const node = authoritativeRenderer(item).render();
    expect(marksIn(node)).toHaveLength(0);
    expect(node.name).toBe("text");
    expect(node.dataset.assistedBy).toBeUndefined();
    expect(node.attributes.has("aria-description")).toBe(false);
  });

  it("keeps exactly one mark on a reused video card and moves it with the card", () => {
    const item: BoardItem = {
      ...base,
      id: "video-ai",
      kind: "text",
      style: textStyle,
      geometry: {
        x: 20,
        y: 40,
        text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        embed: "video",
      },
    };
    const { render } = authoritativeRenderer(item);
    const created = render();
    expectSingleMark(created);
    expect(marksIn(created)[0]?.attributes.get("transform")).toBe(
      `translate(${20 + VIDEO_EMBED_WIDTH - 52} 24)`,
    );

    item.geometry.x = 120;
    const reused = render();
    expect(reused).toBe(created);
    expect(marksIn(reused)).toHaveLength(1);
    expect(marksIn(reused)[0]?.attributes.get("transform")).toBe(
      `translate(${120 + VIDEO_EMBED_WIDTH - 52} 24)`,
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
      {
        kind: "line",
        color: "#20201e",
        width: 4,
        opacity: 1,
        arrowhead: "none",
      },
    ) as unknown as FakeSvgNode;

    expect(node.children).toHaveLength(1);
    expect(node.children[0]?.classList.values.has("connector-shaft")).toBe(true);
    expect(node.children[0]?.attributes.get("x2")).toBe("100");
  });

  it("renders a shared-math open arrowhead without closing or filling it", () => {
    const node = lineNode(
      { x1: 0, y1: 0, x2: 100, y2: 0 },
      {
        kind: "line",
        color: "#20201e",
        width: 4,
        opacity: 0.8,
        arrowhead: "arrow",
      },
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

    const handle = selectionResizeHandle(item, 2, {
      x: 4,
      y: 6,
    }) as unknown as FakeSvgNode;
    expect(handle.dataset).toEqual({
      resizeHandle: "southeast",
      itemId: "sticky-a",
    });
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

describe("object comment markers and shape transform handles", () => {
  beforeEach(() => {
    vi.stubGlobal("document", {
      createElementNS: (_namespace: string, name: string) => fakeSvgNode(name),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("anchors the open-comment badge to the current object bounds", () => {
    const initial = commentMarkerNode(
      "018f0000-0000-7000-8000-000000000c01",
      2,
      { minX: 10, minY: 20, maxX: 110, maxY: 80 },
      1,
    ) as unknown as FakeSvgNode;
    const moved = commentMarkerNode(
      "018f0000-0000-7000-8000-000000000c01",
      2,
      { minX: 90, minY: 65, maxX: 190, maxY: 125 },
      1,
    ) as unknown as FakeSvgNode;

    expect(initial.attributes.get("aria-label")).toBe("2 open comments on this object");
    expect(initial.children[0]?.attributes.get("cx")).toBe("118");
    expect(initial.children[0]?.attributes.get("cy")).toBe("12");
    expect(moved.children[0]?.attributes.get("cx")).toBe("198");
    expect(moved.children[0]?.attributes.get("cy")).toBe("57");
  });
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
  className?: string;
  attributes: Map<string, string>;
  children: FakeSvgNode[];
  parent?: FakeSvgNode;
  dataset: Record<string, string>;
  textContent: string | null;
  classList: { values: Set<string>; add: (...names: string[]) => void };
  setAttribute: (name: string, value: string) => void;
  append: (...children: FakeSvgNode[]) => void;
  prepend: (...children: FakeSvgNode[]) => void;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  dispatchEvent: (event: Event) => boolean;
  replaceChildren: (...children: FakeSvgNode[]) => void;
  replaceWith: (next: FakeSvgNode) => void;
  remove: () => void;
  querySelectorAll: () => FakeSvgNode[];
};

function fakeDescendants(node: FakeSvgNode): FakeSvgNode[] {
  return [node, ...node.children.flatMap(fakeDescendants)];
}

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
    append: (...children) => {
      for (const child of children) child.parent = node;
      node.children.push(...children);
    },
    prepend: (...children) => {
      for (const child of children) child.parent = node;
      node.children.unshift(...children);
    },
    addEventListener: () => undefined,
    dispatchEvent: () => true,
    replaceChildren: (...children) => {
      for (const child of children) child.parent = node;
      node.children = [...children];
    },
    replaceWith: (next) => {
      const parent = node.parent;
      if (!parent) return;
      const index = parent.children.indexOf(node);
      if (index === -1) return;
      next.parent = parent;
      parent.children.splice(index, 1, next);
      node.parent = undefined;
    },
    remove: () => {
      const parent = node.parent;
      if (!parent) return;
      const index = parent.children.indexOf(node);
      if (index !== -1) parent.children.splice(index, 1);
      node.parent = undefined;
    },
    querySelectorAll: () => [],
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
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 800,
        height: 600,
      }),
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
    expect(viewListener).toHaveBeenLastCalledWith({
      center: { x: 120, y: -30 },
      zoom: 2,
    });

    viewport.panByPixels(20, -10);
    expect(viewport.viewState).toEqual({ center: { x: 110, y: -25 }, zoom: 2 });
    expect(zoomListener).toHaveBeenCalledTimes(1);
    expect(viewListener).toHaveBeenLastCalledWith({
      center: { x: 110, y: -25 },
      zoom: 2,
    });
  });

  it("rejects non-finite view state and clamps zoom to the supported range", () => {
    const svg = {
      dataset: {} as DOMStringMap,
      style: { setProperty: vi.fn() },
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 400,
        height: 300,
      }),
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

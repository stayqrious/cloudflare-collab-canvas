import { type BoardItem, MAX_STICKY_TEXT_CODE_POINTS } from "@collab/protocol";
import { describe, expect, it } from "vitest";
import {
  createSvgExport,
  STAMP_SVG_PATHS,
  SvgExportError,
  serializeSvg,
  svgDownloadHeaders,
} from "./index.js";

const ACTOR = "018f0000-0000-7000-8000-0000000000a1";
const BOARD = "018f0000-0000-7000-8000-0000000000ff";

function rectangle(
  id: string,
  z: number,
  shape: "rectangle" | "square" = "rectangle",
): Extract<BoardItem, { kind: "rectangle" }> {
  return {
    id,
    kind: "rectangle",
    z,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "stroke", color: "#123456", width: 2, opacity: 0.75 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 10, height: 20, shape },
  };
}

function lineItem(id: string, arrowhead: "none" | "arrow"): Extract<BoardItem, { kind: "line" }> {
  return {
    id,
    kind: "line",
    z: 2,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "line", color: "#123456", width: 4, opacity: 0.75, arrowhead },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x1: 0, y1: 0, x2: 100, y2: 0 },
  };
}

function polygonItem(id: string): Extract<BoardItem, { kind: "polygon" }> {
  return {
    id,
    kind: "polygon",
    z: 3,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "stroke", color: "#874fff", width: 3, opacity: 0.8 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 20, width: 100, height: 80, polygon: "triangle" },
  };
}

function protractorItem(id: string): Extract<BoardItem, { kind: "protractor" }> {
  return {
    id,
    kind: "protractor",
    z: 4,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "protractor", color: "#3dadff", opacity: 0.75 },
    transform: [0, 1, -1, 0, 300, 200],
    geometry: { radius: 100 },
  };
}

function sticky(id: string, text: string): Extract<BoardItem, { kind: "sticky" }> {
  return {
    id,
    kind: "sticky",
    z: 4,
    version: 1,
    createdBy: ACTOR,
    style: {
      kind: "sticky",
      fill: "#fff2a8",
      textColor: "#27231b",
      fontSize: 20,
      opacity: 0.9,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 20, width: 180, height: 140, text },
  };
}

function stampItem(
  id: string,
  stamp: Extract<BoardItem, { kind: "stamp" }>["geometry"]["stamp"],
): Extract<BoardItem, { kind: "stamp" }> {
  return {
    id,
    kind: "stamp",
    z: 5,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "stamp", color: "#e11d48", opacity: 0.8 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 50, y: 60, size: 48, stamp },
  };
}

function imageItem(id: string, alt?: string): Extract<BoardItem, { kind: "image" }> {
  return {
    id,
    kind: "image",
    z: 6,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "image", opacity: 0.75, radius: 20 },
    transform: [1, 0, 0, 1, 5, 7],
    geometry: {
      x: 10,
      y: 20,
      width: 120,
      height: 80,
      assetId: "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ...(alt === undefined ? {} : { alt }),
      mimeType: "image/png",
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
    },
  };
}

function tableItem(id: string): Extract<BoardItem, { kind: "table" }> {
  return {
    id,
    kind: "table",
    z: 7,
    version: 1,
    createdBy: ACTOR,
    style: {
      kind: "table",
      borderColor: "#64748b",
      fill: "#ffffff",
      headerFill: "#dbeafe",
      textColor: "#0f172a",
      fontSize: 10,
      opacity: 0.9,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: 10,
      y: 20,
      columnWidths: [80, 100],
      rowHeights: [40, 50],
      cells: [
        ["Header <&>", "Meaning"],
        ["one two three four", `safe </text><script>alert("x")</script>`],
      ],
      headerRow: true,
    },
  };
}

function zoneItem(id: string): Extract<BoardItem, { kind: "zone" }> {
  return {
    id,
    kind: "zone",
    z: 8,
    version: 1,
    createdBy: ACTOR,
    style: {
      kind: "zone",
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18,
      opacity: 0.18,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: 10,
      y: 20,
      width: 520,
      height: 320,
      title: "Evidence <&>\n</text><script>alert(1)</script>",
    },
  };
}

describe("safe SVG serialization", () => {
  it("escapes text, title, attributes, and never emits user markup", () => {
    const text: BoardItem = {
      id: "018f0000-0000-7000-8000-000000000001",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: ACTOR,
      style: {
        kind: "text",
        color: "#000000",
        fontSize: 16,
        fontFamily: "handwritten",
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 4, y: 8, text: `<script>alert("x")</script> & 'ok'` },
    };
    const svg = serializeSvg({
      boardId: BOARD,
      seq: 3,
      title: `"><script>title</script>`,
      items: [text],
    });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("onload=");
    expect(svg).toContain("&lt;script&gt;alert(\"x\")&lt;/script&gt; &amp; 'ok'");
    expect(svg).toContain(
      'font-family="&quot;Comic Sans MS&quot;, &quot;Segoe Print&quot;, &quot;Bradley Hand&quot;, cursive"',
    );
    expect(svg).toContain('<title>"&gt;&lt;script&gt;title&lt;/script&gt;</title>');
    expect(svg).not.toContain("foreignObject");
  });

  it("derives a padded viewBox from canonical transformed stroke bounds", () => {
    const result = createSvgExport({
      boardId: BOARD,
      seq: 1,
      padding: 10,
      items: [rectangle("018f0000-0000-7000-8000-000000000001", 1)],
    });
    expect(result.viewBox).toEqual({ minX: -11, minY: -11, maxX: 21, maxY: 31 });
    expect(result.svg).toContain('viewBox="-11 -11 32 42"');
    expect(result.svg).toContain('data-format="cf-whiteboard-svg"');
    expect(result.svg).toContain('data-seq="1"');
  });

  it("renders deterministic open arrowheads and includes them in the export viewBox", () => {
    const arrow = lineItem("018f0000-0000-7000-8000-000000000002", "arrow");
    const first = createSvgExport({ boardId: BOARD, seq: 2, padding: 0, items: [arrow] });
    const second = createSvgExport({ boardId: BOARD, seq: 2, padding: 0, items: [arrow] });
    expect(first.svg).toBe(second.svg);
    expect(first.viewBox).toEqual({ minX: -2, minY: -7.4, maxX: 102, maxY: 7.4 });
    expect(first.svg).toContain(
      'd="M 0 0 L 100 0 M 88 5.4 L 100 0 L 88 -5.4" fill="none" stroke="#123456"',
    );
    expect(first.svg).not.toContain("marker-end");
    expect(first.svg).not.toContain("foreignObject");

    const plain = serializeSvg({
      boardId: BOARD,
      seq: 3,
      items: [lineItem("018f0000-0000-7000-8000-000000000003", "none")],
    });
    expect(plain).toContain('<line x1="0" y1="0" x2="100" y2="0"');
  });

  it("exports only surviving visible line and box outline paths", () => {
    const line = lineItem("018f0000-0000-7000-8000-000000000012", "arrow");
    line.geometry.visiblePaths = [
      [
        [0, 0],
        [40, 0],
      ],
      [
        [60, 0],
        [100, 0],
      ],
    ];
    const box = rectangle("018f0000-0000-7000-8000-000000000013", 3);
    box.geometry.visiblePaths = [
      [
        [0, 0],
        [10, 0],
      ],
    ];
    const svg = serializeSvg({ boardId: BOARD, seq: 3, items: [line, box] });
    expect(svg).toContain("M 0 0 L 40 0 M 60 0 L 100 0 M 88 5.4 L 100 0 L 88 -5.4");
    expect(svg).toContain('d="M 0 0 L 10 0" data-shape="rectangle" fill="none" stroke="#123456"');
    expect(svg).not.toContain('<rect x="0" y="0" width="10" height="20"');
  });

  it("preserves rectangle versus square subtype metadata", () => {
    const square = rectangle("018f0000-0000-7000-8000-000000000016", 1, "square");
    square.geometry.width = 20;
    const svg = serializeSvg({ boardId: BOARD, seq: 1, items: [square] });
    expect(svg).toContain('width="20" height="20" data-shape="square"');
  });

  it("exports semantic polygons and a deterministic rotatable 180 degree protractor", () => {
    const polygon = polygonItem("018f0000-0000-7000-8000-000000000014");
    const protractor = protractorItem("018f0000-0000-7000-8000-000000000015");
    const first = createSvgExport({
      boardId: BOARD,
      seq: 4,
      padding: 0,
      items: [polygon, protractor],
    });
    const second = createSvgExport({
      boardId: BOARD,
      seq: 4,
      padding: 0,
      items: [polygon, protractor],
    });
    expect(first.svg).toBe(second.svg);
    expect(first.svg).toContain('<polygon points="60,20 110,100 10,100"');
    expect(first.svg).toContain('transform="matrix(0 1 -1 0 300 200)"');
    expect(first.svg).toContain('aria-label="180 degree protractor"');
    expect(first.svg).toContain("<title>180 degree protractor</title>");
    expect(first.svg).toContain(">90</text>");
    expect(first.viewBox).toEqual({ minX: 8.5, minY: 18.5, maxX: 400, maxY: 300 });
  });

  it("sorts paint order and supports multiline plain text with tspans", () => {
    const later = rectangle("018f0000-0000-7000-8000-000000000002", 2);
    const earlier = rectangle("018f0000-0000-7000-8000-000000000001", 1);
    const svg = serializeSvg({ boardId: BOARD, seq: 2, items: [later, earlier] });
    expect(svg.indexOf(earlier.id)).toBeLessThan(svg.indexOf(later.id));

    const text: BoardItem = {
      id: "018f0000-0000-7000-8000-000000000003",
      kind: "text",
      z: 3,
      version: 2,
      createdBy: ACTOR,
      style: {
        kind: "text",
        color: "#112233",
        fontSize: 10,
        fontFamily: "mono",
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 1, y: 2, text: "one\ntwo" },
    };
    const textSvg = serializeSvg({ boardId: BOARD, seq: 2, items: [text] });
    expect(textSvg).toContain('<tspan x="1" dy="12">two</tspan>');
    expect(textSvg).toContain(
      'font-family="ui-monospace, &quot;SFMono-Regular&quot;, Consolas, &quot;Liberation Mono&quot;, monospace"',
    );
  });

  it("keeps exported TeX source inside the computed viewBox", () => {
    const source = "$$\\displaystyle x$$";
    const text: BoardItem = {
      id: "018f0000-0000-7000-8000-000000000016",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: ACTOR,
      style: {
        kind: "text",
        color: "#112233",
        fontSize: 20,
        fontFamily: "sans",
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 100, y: 40, text: source },
    };

    const result = createSvgExport({ boardId: BOARD, seq: 3, padding: 0, items: [text] });

    expect(result.svg).toContain("$$\\displaystyle x$$");
    expect(result.viewBox).toEqual({
      minX: 100,
      minY: 20,
      maxX: 100 + Array.from(source).length * 20 * 0.6,
      maxY: 44,
    });
  });

  it("keeps a video fallback URL inside its fixed card bounds", () => {
    const source = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const text: BoardItem = {
      id: "018f0000-0000-7000-8000-000000000017",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: ACTOR,
      style: {
        kind: "text",
        color: "#112233",
        fontSize: 28,
        fontFamily: "sans",
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 100, y: 40, text: source, embed: "video" },
    };

    const result = createSvgExport({ boardId: BOARD, seq: 3, padding: 0, items: [text] });

    expect(result.svg).toContain(source);
    expect(result.viewBox.maxX).toBe(100 + Array.from(source).length * 28 * 0.6);
  });

  it("renders sticky notes with deterministic wrapping, clipping, and escaped text", () => {
    const item = sticky(
      "018f0000-0000-7000-8000-000000000004",
      `one two three four five\n<script> & 😀`,
    );
    const first = createSvgExport({ boardId: BOARD, seq: 4, padding: 0, items: [item] });
    const second = createSvgExport({ boardId: BOARD, seq: 4, padding: 0, items: [item] });

    expect(first.svg).toBe(second.svg);
    expect(first.viewBox).toEqual({ minX: 10, minY: 20, maxX: 190, maxY: 160 });
    expect(first.svg).toContain(
      '<g transform="matrix(1 0 0 1 0 0)" opacity="0.9" data-item-id="018f0000-0000-7000-8000-000000000004">',
    );
    expect(first.svg).toContain(
      '<rect x="10" y="20" width="180" height="140" rx="12" fill="#fff2a8" />',
    );
    expect(first.svg).toContain(
      '<clipPath id="sticky-clip-018f0000-0000-7000-8000-000000000004" clipPathUnits="userSpaceOnUse"><rect x="24" y="34" width="152" height="112" /></clipPath>',
    );
    expect(first.svg).toContain(
      'x="24" y="54" fill="#27231b" font-size="20" font-family="Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, sans-serif" font-weight="normal" font-style="normal" text-decoration="none"',
    );
    expect(first.svg).toContain('<tspan x="24" dy="0">one two three</tspan>');
    expect(first.svg).toContain('<tspan x="24" dy="24">four five</tspan>');
    expect(first.svg).toContain("&lt;script&gt; &amp; 😀");
    expect(first.svg).not.toContain("<script>");
    expect(first.svg).not.toContain("foreignObject");
  });

  it("hard-wraps sticky text by Unicode code point and clamps visible lines", () => {
    const item = sticky("018f0000-0000-7000-8000-000000000005", "😀😀😀😀😀");
    item.geometry = { x: 0, y: 0, width: 51, height: 52, text: item.geometry.text };
    item.style = { ...item.style, fontSize: 10 };

    const svg = serializeSvg({ boardId: BOARD, seq: 5, items: [item] });
    expect(svg).toContain('<tspan x="14" dy="0">😀😀😀😀</tspan>');
    expect(svg).toContain('<tspan x="14" dy="12">😀</tspan>');
    expect(svg.match(/<tspan /gu)).toHaveLength(2);
  });

  it("keeps HTTP URLs intact in sticky and table exports", () => {
    const url = "https://example.com/a/long/copyable/path";
    const stickyItem = sticky("018f0000-0000-7000-8000-000000000005", url);
    const stickySvg = serializeSvg({ boardId: BOARD, seq: 5, items: [stickyItem] });
    expect(stickySvg).toContain(`<tspan x="24" dy="0">${url}</tspan>`);
    expect(stickySvg.match(/<tspan /gu)).toHaveLength(1);

    const table = tableItem("018f0000-0000-7000-8000-00000000000a");
    table.geometry = {
      ...table.geometry,
      columnWidths: [80],
      rowHeights: [40],
      cells: [[url]],
      headerRow: false,
    };
    const tableSvg = serializeSvg({ boardId: BOARD, seq: 11, items: [table] });
    expect(tableSvg).toContain(`<tspan x="18" dy="0">${url}</tspan>`);
    expect(tableSvg.match(/<tspan /gu)).toHaveLength(1);
  });

  it("bounds a max-length hard split to the one visible line of a tiny sticky", () => {
    const text = `<${"😀".repeat(MAX_STICKY_TEXT_CODE_POINTS - 2)}&`;
    expect(Array.from(text)).toHaveLength(MAX_STICKY_TEXT_CODE_POINTS);
    const item = sticky("018f0000-0000-7000-8000-000000000007", text);
    item.geometry = { x: 0, y: 0, width: 29, height: 29, text };
    item.style = { ...item.style, fontSize: 10 };

    const svg = serializeSvg({ boardId: BOARD, seq: 7, items: [item] });
    expect(svg).toContain('<tspan x="14" dy="0">&lt;</tspan>');
    expect(svg.match(/<tspan /gu)).toHaveLength(1);
    expect(svg).not.toContain("😀");
    expect(svg).not.toContain("&amp;");
    expect(svg.length).toBeLessThan(1_500);
  });

  it("omits unnecessary sticky text markup for an empty note", () => {
    const item = sticky("018f0000-0000-7000-8000-000000000006", "");
    const svg = serializeSvg({ boardId: BOARD, seq: 6, items: [item] });
    expect(svg).toContain('<rect x="10" y="20" width="180" height="140" rx="12"');
    expect(svg).not.toContain("<clipPath");
    expect(svg).not.toContain("<text ");
  });

  it("renders every stamp with deterministic local SVG primitives and centered bounds", () => {
    const variants = ["star", "check", "heart", "question", "smile", "sparkle"] as const;
    const rendered = new Map<string, string>();
    for (const stamp of variants) {
      const item = stampItem("018f0000-0000-7000-8000-000000000008", stamp);
      const first = createSvgExport({ boardId: BOARD, seq: 8, padding: 0, items: [item] });
      const second = createSvgExport({ boardId: BOARD, seq: 8, padding: 0, items: [item] });
      expect(first.svg).toBe(second.svg);
      expect(first.viewBox).toEqual({ minX: 26, minY: 36, maxX: 74, maxY: 84 });
      expect(first.svg).toContain('opacity="0.8"');
      expect(first.svg).toContain('transform="translate(26 36) scale(2)"');
      expect(first.svg).not.toMatch(/<image|href=|foreignObject|😀/u);
      rendered.set(stamp, first.svg);
    }
    expect(rendered.get("star")).toContain(`d="${STAMP_SVG_PATHS.star}" fill="#e11d48"`);
    expect(rendered.get("heart")).toContain(`d="${STAMP_SVG_PATHS.heart}" fill="#e11d48"`);
    expect(rendered.get("check")).toContain(
      `d="${STAMP_SVG_PATHS.check}" fill="none" stroke="#e11d48" stroke-width="2.8"`,
    );
    expect(rendered.get("question")).toContain('<circle cx="12" cy="17.6" r="1.2"');
    expect(rendered.get("smile")).toContain('<circle cx="12" cy="12" r="9"');
    expect(rendered.get("sparkle")).toContain(`d="${STAMP_SVG_PATHS.sparkle}" fill="#e11d48"`);
  });

  it("emits deterministic non-fetching placeholders for private image assets", () => {
    const item = imageItem(
      "018f0000-0000-7000-8000-000000000009",
      "Microscope slide <unsafe> & detail",
    );
    const first = createSvgExport({ boardId: BOARD, seq: 9, padding: 0, items: [item] });
    const second = createSvgExport({ boardId: BOARD, seq: 9, padding: 0, items: [item] });

    expect(first.svg).toBe(second.svg);
    expect(first.viewBox).toEqual({ minX: 15, minY: 27, maxX: 135, maxY: 107 });
    expect(first.svg).toContain('data-export-placeholder="private-image"');
    expect(first.svg).toContain('aria-label="Microscope slide &lt;unsafe&gt; &amp; detail"');
    expect(first.svg).toContain("<title>Microscope slide &lt;unsafe&gt; &amp; detail</title>");
    expect(first.svg).toContain('rx="20" fill="#f1f5f9" stroke="#64748b"');
    expect(first.svg).not.toMatch(/<image(?:\s|>)/u);
    expect(first.svg).not.toMatch(/(?:href|src)=/u);
    expect(first.svg).not.toMatch(/data:image|;base64,/u);
    expect(first.svg).not.toContain(item.geometry.assetId);
    expect(first.svg).not.toContain(item.geometry.mimeType);
    expect(first.svg).not.toMatch(/data-(?:asset-id|mime-type|intrinsic-(?:width|height))=/u);
    expect(first.svg).not.toContain('"intrinsicWidth"');
  });

  it("uses a safe accessible fallback label when image alt text is omitted", () => {
    const svg = serializeSvg({
      boardId: BOARD,
      seq: 10,
      items: [imageItem("018f0000-0000-7000-8000-000000000009", undefined)],
    });
    expect(svg).toContain('role="img" aria-label="Image"><title>Image</title>');
  });

  it("renders deterministic clipped and wrapped table cells without executable markup", () => {
    const item = tableItem("018f0000-0000-7000-8000-00000000000a");
    const first = createSvgExport({ boardId: BOARD, seq: 11, padding: 0, items: [item] });
    const second = createSvgExport({ boardId: BOARD, seq: 11, padding: 0, items: [item] });

    expect(first.svg).toBe(second.svg);
    expect(first.viewBox).toEqual({ minX: 10, minY: 20, maxX: 190, maxY: 110 });
    expect(first.svg).toContain(
      '<g transform="matrix(1 0 0 1 0 0)" opacity="0.9" data-item-id="018f0000-0000-7000-8000-00000000000a" role="table">',
    );
    expect(first.svg).toContain(
      '<rect x="10" y="20" width="80" height="40" fill="#dbeafe" stroke="#64748b" stroke-width="1" />',
    );
    expect(first.svg).toContain(
      '<rect x="10" y="60" width="80" height="50" fill="#ffffff" stroke="#64748b" stroke-width="1" />',
    );
    expect(first.svg).toContain(
      '<clipPath id="table-clip-018f0000-0000-7000-8000-00000000000a-1-0" clipPathUnits="userSpaceOnUse"><rect x="18" y="68" width="64" height="34" /></clipPath>',
    );
    expect(first.svg).toContain('<tspan x="18" dy="0">one two</tspan>');
    expect(first.svg).toContain('<tspan x="18" dy="12">three four</tspan>');
    expect(first.svg).toContain('aria-label="Header &lt;&amp;&gt;"');
    expect(first.svg).toContain(
      'aria-label="safe &lt;/text&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"',
    );
    expect(first.svg).toContain("&lt;/text&gt;&lt;script");
    expect(first.svg).not.toContain("<script>");
    expect(first.svg).not.toContain("foreignObject");
  });

  it("renders a deterministic muted section with clipped, escaped title text", () => {
    const item = zoneItem("018f0000-0000-7000-8000-00000000000b");
    const first = createSvgExport({ boardId: BOARD, seq: 12, padding: 0, items: [item] });
    const second = createSvgExport({ boardId: BOARD, seq: 12, padding: 0, items: [item] });

    expect(first.svg).toBe(second.svg);
    expect(first.viewBox).toEqual({ minX: 10, minY: 20, maxX: 530, maxY: 340 });
    expect(first.svg).toContain('fill="#e8edff" fill-opacity="0.18"');
    expect(first.svg).toContain('fill="none" stroke="#a8a59d" stroke-width="1.5"');
    expect(first.svg).toContain('role="group" aria-label="Section: Evidence &lt;&amp;&gt;');
    expect(first.svg).toContain(
      '<clipPath id="zone-title-clip-018f0000-0000-7000-8000-00000000000b" clipPathUnits="userSpaceOnUse"><rect x="22" y="20" width="496" height="33.6" /></clipPath>',
    );
    expect(first.svg).toContain(
      "Evidence &lt;&amp;&gt; &lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(first.svg).not.toContain("<script>");
    expect(first.svg).not.toContain("foreignObject");
  });

  it("preserves rich typography across text, sticky, table, and section exports", () => {
    const text: Extract<BoardItem, { kind: "text" }> = {
      id: "018f0000-0000-7000-8000-000000000010",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: ACTOR,
      style: {
        kind: "text",
        color: "#112233",
        fontSize: 16,
        fontFamily: "serif",
        fontWeight: "bold",
        fontStyle: "italic",
        textDecoration: "underline",
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 10, y: 20, text: "Rich text" },
    };
    const stickyNote = sticky("018f0000-0000-7000-8000-000000000011", "Rich sticky");
    const table = tableItem("018f0000-0000-7000-8000-000000000012");
    const section = zoneItem("018f0000-0000-7000-8000-000000000013");
    for (const item of [stickyNote, table, section]) {
      item.style = {
        ...item.style,
        fontFamily: "serif",
        fontWeight: "bold",
        fontStyle: "italic",
        textDecoration: "underline",
      };
    }
    const typography =
      'font-family="Georgia, &quot;Times New Roman&quot;, Times, serif" font-weight="700" font-style="italic" text-decoration="underline"';

    for (const item of [text, stickyNote, table, section]) {
      const svg = serializeSvg({ boardId: BOARD, seq: 13, items: [item] });
      expect(svg, item.kind).toContain(typography);
    }
  });

  it("uses table and Section weight defaults only when font weight is omitted", () => {
    const table = tableItem("018f0000-0000-7000-8000-000000000014");
    const defaultTableSvg = serializeSvg({ boardId: BOARD, seq: 14, items: [table] });
    const normalTableSvg = serializeSvg({
      boardId: BOARD,
      seq: 14,
      items: [{ ...table, style: { ...table.style, fontWeight: "normal" } }],
    });

    expect(defaultTableSvg.match(/font-weight="700"/gu)).toHaveLength(2);
    expect(defaultTableSvg.match(/font-weight="500"/gu)).toHaveLength(2);
    expect(normalTableSvg.match(/font-weight="normal"/gu)).toHaveLength(4);
    expect(normalTableSvg).not.toContain('font-weight="700"');
    expect(normalTableSvg).not.toContain('font-weight="500"');

    const section = zoneItem("018f0000-0000-7000-8000-000000000015");
    const defaultSectionSvg = serializeSvg({ boardId: BOARD, seq: 15, items: [section] });
    const normalSectionSvg = serializeSvg({
      boardId: BOARD,
      seq: 15,
      items: [{ ...section, style: { ...section.style, fontWeight: "normal" } }],
    });

    expect(defaultSectionSvg).toContain('font-weight="700"');
    expect(normalSectionSvg).toContain('font-weight="normal"');
    expect(normalSectionSvg).not.toContain('font-weight="700"');
  });

  it("rejects unrecognized/non-canonical items rather than serializing arbitrary data", () => {
    expect(() =>
      serializeSvg({
        boardId: BOARD,
        seq: 1,
        items: [
          {
            ...rectangle("018f0000-0000-7000-8000-000000000001", 1),
            kind: "image",
            href: "https://bad",
          } as never,
        ],
      }),
    ).toThrow(SvgExportError);
  });

  it("returns hardened download headers", () => {
    expect(svgDownloadHeaders("../bad\r\nX-Evil: yes.svg")).toEqual({
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="_bad__X-Evil__yes.svg"',
    });
  });
});

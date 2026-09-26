import { describe, expect, it } from "vitest";

import {
  boundsContain,
  boundsForItems,
  defaultOutlinePaths,
  formatCanonicalNumber,
  GeometryValidationError,
  imageGeometryContainsPoint,
  isCanonicalImageAssetId,
  itemBounds,
  lineArrowheadPoints,
  normalizeBoxGeometry,
  normalizeImageGeometry,
  normalizeLineGeometry,
  normalizeOutlineBoxGeometry,
  normalizePencilGeometry,
  normalizePolygonGeometry,
  normalizeProtractorGeometry,
  normalizeRectangleGeometry,
  normalizeStampGeometry,
  normalizeStickyGeometry,
  normalizeTableGeometry,
  normalizeTextGeometry,
  normalizeTransform,
  normalizeZoneGeometry,
  parseVideoEmbedReference,
  polygonPoints,
  protractorSnapPoints,
  tableGeometryContainsPoint,
  textLayoutEstimateSource,
  transformBounds,
  translateTransform,
  visibleOutlinePaths,
  zoneGeometryContainsPoint,
  zoneTitleBandHeight,
} from "./index.js";

const ASSET_ID = "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("geometry normalization", () => {
  it("rounds coordinates, removes adjacent duplicate points, and preserves order", () => {
    expect(
      normalizePencilGeometry({
        points: [
          [1.234, -0],
          [1.231, 0],
          [2.999, 4.004],
        ],
      }),
    ).toEqual({
      points: [
        [1.23, 0],
        [3, 4],
      ],
    });
  });

  it("canonicalizes boxes dragged in any direction", () => {
    expect(normalizeBoxGeometry({ x: 10, y: 20, width: -4.555, height: -8 })).toEqual({
      x: 5.44,
      y: 12,
      width: 4.56,
      height: 8,
    });
  });

  it("accepts only supported video URLs with the explicit embed marker", () => {
    expect(parseVideoEmbedReference("https://youtu.be/dQw4w9WgXcQ?t=10")).toEqual({
      provider: "youtube",
      videoId: "dQw4w9WgXcQ",
      sourceUrl: "https://youtu.be/dQw4w9WgXcQ?t=10",
    });
    expect(parseVideoEmbedReference("https://vimeo.com/76979871/abc123def4")).toEqual({
      provider: "vimeo",
      videoId: "76979871",
      sourceUrl: "https://vimeo.com/76979871/abc123def4",
      vimeoHash: "abc123def4",
    });
    expect(
      parseVideoEmbedReference("https://player.vimeo.com/video/76979871?h=abc123def4"),
    ).toEqual({
      provider: "vimeo",
      videoId: "76979871",
      sourceUrl: "https://player.vimeo.com/video/76979871?h=abc123def4",
      vimeoHash: "abc123def4",
    });
    expect(
      normalizeTextGeometry({
        x: 10,
        y: 20,
        text: "https://vimeo.com/76979871",
        embed: "video",
      }),
    ).toMatchObject({ embed: "video" });
    expect(() =>
      normalizeTextGeometry({ x: 10, y: 20, text: "not a video", embed: "video" }),
    ).toThrow(/supported HTTPS YouTube or Vimeo/);
    expect(() =>
      normalizeTextGeometry({
        x: 10,
        y: 20,
        text: "https://example.com/video",
        embed: "video",
      }),
    ).toThrow(/supported HTTPS YouTube or Vimeo/);
    expect(parseVideoEmbedReference("https://vimeo.com/76979871/bad/hash")).toBeNull();
    expect(parseVideoEmbedReference("https://vimeo.com/76979871/a?h=b")).toBeNull();
    expect(parseVideoEmbedReference("https://vimeo.com/76979871?h=")).toBeNull();
    expect(parseVideoEmbedReference("https://vimeo.com/76979871/abc123def4?h=")).toBeNull();
  });

  it("canonicalizes legacy rectangles and persists an explicit square subtype", () => {
    expect(normalizeRectangleGeometry({ x: 0, y: 0, width: 40, height: 20 })).toEqual({
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      shape: "rectangle",
    });
    expect(
      normalizeRectangleGeometry({ x: 0, y: 0, width: 40, height: 40, shape: "square" }),
    ).toEqual({ x: 0, y: 0, width: 40, height: 40, shape: "square" });
    expect(() =>
      normalizeRectangleGeometry({ x: 0, y: 0, width: 40, height: 20, shape: "diamond" }),
    ).toThrow(/Rectangle shape must be one of/);
    expect(() =>
      normalizeRectangleGeometry({ x: 0, y: 0, width: 40, height: 20, shape: "square" }),
    ).toThrow(/width and height must be equal/);
  });

  it("normalizes visible outline fragments with strict path and point limits", () => {
    expect(
      normalizeLineGeometry({
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 0,
        visiblePaths: [
          [
            [0, 0],
            [0, 0],
            [40.126, 0],
          ],
          [
            [60, 0],
            [100, 0],
          ],
        ],
      }),
    ).toEqual({
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      visiblePaths: [
        [
          [0, 0],
          [40.13, 0],
        ],
        [
          [60, 0],
          [100, 0],
        ],
      ],
    });
    expect(() =>
      normalizeOutlineBoxGeometry({
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        visiblePaths: [],
      }),
    ).toThrow(/between 1 and 256/);
    expect(() =>
      normalizeOutlineBoxGeometry({
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        visiblePaths: [[[0, 0]]],
      }),
    ).toThrow(/at least 2/);
    expect(() =>
      normalizeOutlineBoxGeometry({
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        visiblePaths: Array.from({ length: 257 }, () => [
          [0, 0],
          [1, 0],
        ]),
      }),
    ).toThrow(/between 1 and 256/);
  });

  it("normalizes polygon and protractor geometry with exact keys", () => {
    expect(
      normalizePolygonGeometry({
        x: 10,
        y: 20,
        width: -40,
        height: 30,
        polygon: "rhombus",
      }),
    ).toEqual({ x: -30, y: 20, width: 40, height: 30, polygon: "rhombus" });
    expect(() =>
      normalizePolygonGeometry({ x: 0, y: 0, width: 10, height: 10, polygon: "octagon" }),
    ).toThrow(/Polygon must be one of/);
    expect(normalizeProtractorGeometry({ radius: 159.999 })).toEqual({ radius: 160 });
    expect(() => normalizeProtractorGeometry({ radius: 0 })).toThrow(/greater than 0/);
    expect(() => normalizeProtractorGeometry({ radius: 100, angle: 30 })).toThrow(/Unknown field/);
  });

  it("derives deterministic default and visible paths for outline items", () => {
    const rectangle = { x: 10, y: 20, width: 30, height: 40 };
    expect(defaultOutlinePaths("rectangle", rectangle)).toEqual([
      [
        [10, 20],
        [40, 20],
        [40, 60],
        [10, 60],
        [10, 20],
      ],
    ]);
    expect(defaultOutlinePaths("ellipse", rectangle)[0]).toHaveLength(97);
    expect(
      visibleOutlinePaths("rectangle", {
        ...rectangle,
        visiblePaths: [
          [
            [10, 20],
            [25, 20],
          ],
        ],
      }),
    ).toEqual([
      [
        [10, 20],
        [25, 20],
      ],
    ]);
  });

  it("derives canonical polygon vertices and protractor snap marks", () => {
    expect(polygonPoints({ x: 0, y: 0, width: 100, height: 80, polygon: "triangle" })).toEqual([
      [50, 0],
      [100, 80],
      [0, 80],
    ]);
    const snapPoints = protractorSnapPoints({ radius: 100 }, 90);
    expect(snapPoints).toEqual([
      [0, 0],
      [100, 0],
      [0, -100],
      [-100, 0],
    ]);
    expect(() => protractorSnapPoints({ radius: 100 }, 7)).toThrow(/divisor of 180/);
  });

  it("canonicalizes sticky extents while preserving text", () => {
    expect(
      normalizeStickyGeometry({ x: 10, y: 20, width: -4.555, height: -8, text: "Plan" }),
    ).toEqual({
      x: 5.44,
      y: 12,
      width: 4.56,
      height: 8,
      text: "Plan",
    });
  });

  it("requires positive, exact-key sticky geometry", () => {
    expect(() => normalizeStickyGeometry({ x: 0, y: 0, width: 0, height: 10, text: "" })).toThrow(
      /greater than 0/,
    );
    expect(() =>
      normalizeStickyGeometry({ x: 0, y: 0, width: 10, height: 10, text: "", extra: true }),
    ).toThrow(/Unknown field/);
  });

  it("canonicalizes positive, exact-key zone geometry while preserving its title", () => {
    expect(
      normalizeZoneGeometry({
        x: 10,
        y: 20,
        width: -400.125,
        height: -240.555,
        title: "Evidence",
        locked: true,
      }),
    ).toEqual({
      x: -390.13,
      y: -220.56,
      width: 400.13,
      height: 240.56,
      title: "Evidence",
      locked: true,
    });
    expect(
      normalizeZoneGeometry({
        x: 10,
        y: 20,
        width: 40,
        height: 30,
        title: "Open",
        locked: false,
      }),
    ).toEqual({ x: 10, y: 20, width: 40, height: 30, title: "Open" });
    expect(() =>
      normalizeZoneGeometry({
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        title: "Zone",
        locked: "yes",
      }),
    ).toThrow(/boolean/);
    expect(() =>
      normalizeZoneGeometry({ x: 0, y: 0, width: 0, height: 10, title: "Zone" }),
    ).toThrow(/greater than 0/);
    expect(() =>
      normalizeZoneGeometry({ x: 0, y: 0, width: 10, height: 0, title: "Zone" }),
    ).toThrow(/greater than 0/);
    expect(() =>
      normalizeZoneGeometry({ x: 0, y: 0, width: 10, height: 10, title: "Zone", text: "no" }),
    ).toThrow(/Unknown field/);
  });

  it("canonicalizes every stamp kind and rejects unsafe centered extents", () => {
    for (const stamp of ["star", "check", "heart", "question", "smile", "sparkle"] as const) {
      expect(normalizeStampGeometry({ x: 1.234, y: -2.345, size: 71.999, stamp })).toEqual({
        x: 1.23,
        y: -2.35,
        size: 72,
        stamp,
      });
    }
    expect(() => normalizeStampGeometry({ x: 0, y: 0, size: 0, stamp: "star" })).toThrow(
      /greater than 0/,
    );
    expect(() => normalizeStampGeometry({ x: 0, y: 0, size: 72, stamp: "award" })).toThrow(
      /Stamp must be one of/,
    );
    expect(() =>
      normalizeStampGeometry({ x: 0, y: 0, size: 72, stamp: "star", extra: true }),
    ).toThrow(/Unknown field/);
    expect(() => normalizeStampGeometry({ x: 1_000_000, y: 0, size: 2, stamp: "star" })).toThrow(
      /Coordinate/,
    );
  });

  it("canonicalizes small rectangular table grids", () => {
    expect(
      normalizeTableGeometry({
        x: 10.129,
        y: -2.555,
        columnWidths: [100.125, 80.555, 90],
        rowHeights: [40.125, 50.555],
        cells: [
          ["A", "B", "C"],
          ["1", "2", "3"],
        ],
        headerRow: true,
      }),
    ).toEqual({
      x: 10.13,
      y: -2.56,
      columnWidths: [100.13, 80.56, 90],
      rowHeights: [40.13, 50.56],
      cells: [
        ["A", "B", "C"],
        ["1", "2", "3"],
      ],
      headerRow: true,
    });
  });

  it("rejects malformed, oversized, and kind-confused table geometry", () => {
    const valid = {
      x: 0,
      y: 0,
      columnWidths: [100, 100],
      rowHeights: [40, 40],
      cells: [
        ["A", "B"],
        ["C", "D"],
      ],
    };
    expect(() => normalizeTableGeometry({ ...valid, columnWidths: [] })).toThrow(/between 1 and 6/);
    expect(() => normalizeTableGeometry({ ...valid, columnWidths: Array(7).fill(100) })).toThrow(
      /between 1 and 6/,
    );
    expect(() => normalizeTableGeometry({ ...valid, rowHeights: Array(9).fill(40) })).toThrow(
      /between 1 and 8/,
    );
    expect(() => normalizeTableGeometry({ ...valid, columnWidths: [100, 0] })).toThrow(
      /greater than 0/,
    );
    expect(() => normalizeTableGeometry({ ...valid, rowHeights: [40, Number.NaN] })).toThrow(
      /finite dimension/,
    );
    expect(() => normalizeTableGeometry({ ...valid, cells: [["A", "B"]] })).toThrow(
      /one array per row height/,
    );
    expect(() => normalizeTableGeometry({ ...valid, cells: [["A"], ["B"]] })).toThrow(
      /one string per column width/,
    );
    expect(() =>
      normalizeTableGeometry({
        ...valid,
        cells: [
          ["A", 2],
          ["C", "D"],
        ],
      }),
    ).toThrow(/cell text to be a string/);
    expect(() => normalizeTableGeometry({ ...valid, headerRow: "yes" })).toThrow(/boolean/);
    expect(() => normalizeTableGeometry({ ...valid, width: 200 })).toThrow(/Unknown field/);
    expect(() => normalizeTableGeometry({ ...valid, assetId: ASSET_ID })).toThrow(/Unknown field/);
    expect(() =>
      normalizeTableGeometry({ ...valid, x: 999_900, columnWidths: [100, 100] }),
    ).toThrow(/Coordinate/);
  });

  it("canonicalizes bounded image cards and omits empty alt text", () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp", "image/gif"] as const) {
      expect(
        normalizeImageGeometry({
          x: 10,
          y: 20,
          width: -100.555,
          height: -50.444,
          assetId: ASSET_ID,
          alt: "",
          mimeType,
          intrinsicWidth: 1200,
          intrinsicHeight: 800,
        }),
      ).toEqual({
        x: -90.56,
        y: -30.44,
        width: 100.56,
        height: 50.44,
        assetId: ASSET_ID,
        mimeType,
        intrinsicWidth: 1200,
        intrinsicHeight: 800,
      });
    }
  });

  it("enforces canonical SHA-256 base64url trailing bits in image asset IDs", () => {
    const prefix = `asset_${"A".repeat(42)}`;
    for (const last of ["A", "E", "8"]) {
      expect(isCanonicalImageAssetId(`${prefix}${last}`)).toBe(true);
    }
    for (const last of ["B", "-", "_"]) {
      expect(isCanonicalImageAssetId(`${prefix}${last}`)).toBe(false);
    }
  });

  it("rejects non-canonical image assets, unsupported MIME types, and raw content", () => {
    const valid = {
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      assetId: ASSET_ID,
      mimeType: "image/png",
      intrinsicWidth: 100,
      intrinsicHeight: 80,
    };
    for (const assetId of [
      "https://assets.example/image.png",
      "data:image/png;base64,AAAA",
      "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    ]) {
      expect(() => normalizeImageGeometry({ ...valid, assetId })).toThrow(/base64url SHA-256/);
    }
    expect(() => normalizeImageGeometry({ ...valid, mimeType: "image/svg+xml" })).toThrow(
      /MIME type/,
    );
    expect(() => normalizeImageGeometry({ ...valid, bytes: "AAAA" })).toThrow(/Unknown field/);
    expect(() => normalizeImageGeometry({ ...valid, href: "https://bad.example" })).toThrow(
      /Unknown field/,
    );
  });

  it("enforces positive card/intrinsic dimensions, pixel budget, and safe alt text", () => {
    const valid = {
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      assetId: ASSET_ID,
      mimeType: "image/webp",
      intrinsicWidth: 100,
      intrinsicHeight: 80,
    };
    expect(() => normalizeImageGeometry({ ...valid, width: 0 })).toThrow(/greater than 0/);
    expect(() => normalizeImageGeometry({ ...valid, height: 0 })).toThrow(/greater than 0/);
    expect(() => normalizeImageGeometry({ ...valid, intrinsicWidth: 1.5 })).toThrow(
      /positive integer/,
    );
    expect(() => normalizeImageGeometry({ ...valid, intrinsicHeight: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => normalizeImageGeometry({ ...valid, intrinsicWidth: 4097 })).toThrow(
      /at most 4096/,
    );
    expect(() =>
      normalizeImageGeometry({ ...valid, intrinsicWidth: 4001, intrinsicHeight: 4000 }),
    ).toThrow(/16000000 pixels/);
    expect(() => normalizeImageGeometry({ ...valid, alt: "😀".repeat(501) })).toThrow(
      /at most 500/,
    );
    expect(() => normalizeImageGeometry({ ...valid, alt: "bad\u0000alt" })).toThrow(/control/);
    expect(() => normalizeImageGeometry({ ...valid, alt: "bad\ud800alt" })).toThrow(/surrogate/);
  });

  it("rejects non-finite, out-of-range, and unknown input", () => {
    expect(() => normalizeTransform([1, 0, 0, 1, Number.NaN, 0])).toThrow(GeometryValidationError);
    expect(() => normalizeTransform([1_000_001, 0, 0, 1, 0, 0])).toThrow(/Transform component/);
    expect(() => normalizeBoxGeometry({ x: 1_000_001, y: 0, width: 1, height: 1 })).toThrow(
      /Coordinate/,
    );
    expect(() => normalizeBoxGeometry({ x: 0, y: 0, width: 1, height: 1, onclick: "bad" })).toThrow(
      /Unknown field/,
    );
  });
});

describe("bounds and transforms", () => {
  it("uses all transformed corners for an affine transform", () => {
    expect(transformBounds({ minX: 0, minY: 0, maxX: 10, maxY: 5 }, [0, 1, -1, 0, 20, 30])).toEqual(
      { minX: 15, minY: 30, maxX: 20, maxY: 40 },
    );
  });

  it("includes transformed stroke extents", () => {
    expect(
      itemBounds({
        kind: "line",
        geometry: { x1: 0, y1: 0, x2: 10, y2: 0 },
        transform: [2, 0, 0, 2, 5, 7],
        style: { kind: "line", width: 4, arrowhead: "none" },
      }),
    ).toEqual({ minX: 1, minY: 3, maxX: 29, maxY: 11 });
  });

  it("uses only surviving visible paths for outline bounds", () => {
    expect(
      itemBounds({
        kind: "rectangle",
        geometry: {
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          visiblePaths: [
            [
              [20, 10],
              [40, 10],
            ],
          ],
        },
        transform: [1, 0, 0, 1, 5, 7],
        style: { kind: "stroke", width: 2 },
      }),
    ).toEqual({ minX: 24, minY: 16, maxX: 46, maxY: 18 });
  });

  it("rotates protractor-local semicircle bounds through its affine transform", () => {
    expect(
      itemBounds({
        kind: "protractor",
        geometry: { radius: 100 },
        transform: [0, 1, -1, 0, 300, 200],
        style: { kind: "protractor" },
      }),
    ).toEqual({ minX: 300, minY: 100, maxX: 400, maxY: 300 });
  });

  it("uses one deterministic open arrowhead for rendering and transformed bounds", () => {
    const geometry = { x1: 0, y1: 0, x2: 100, y2: 0 };
    expect(lineArrowheadPoints(geometry, 4)).toEqual([
      [88, 5.4],
      [100, 0],
      [88, -5.4],
    ]);
    expect(
      itemBounds({
        kind: "line",
        geometry,
        transform: [0, 1, -1, 0, 10, 20],
        style: { kind: "line", width: 4, arrowhead: "arrow" },
      }),
    ).toEqual({ minX: 2.5999999999999996, minY: 18, maxX: 17.4, maxY: 122 });
    expect(lineArrowheadPoints({ x1: 1, y1: 2, x2: 1, y2: 2 }, 4)).toBeNull();
    expect(() => lineArrowheadPoints(geometry, 0)).toThrow(/stroke width/);
  });

  it("uses the full transformed sticky rectangle", () => {
    expect(
      itemBounds({
        kind: "sticky",
        geometry: { x: 2, y: 3, width: 20, height: 10, text: "Wrapped note" },
        transform: [1, 0, 0, 1, 5, 7],
        style: { kind: "sticky", fontSize: 16 },
      }),
    ).toEqual({ minX: 7, minY: 10, maxX: 27, maxY: 20 });
  });

  it("uses full zone bounds while only its title band and border are interactive", () => {
    const geometry = { x: 10, y: 20, width: 300, height: 200, title: "Questions" };
    expect(
      itemBounds({
        kind: "zone",
        geometry,
        transform: [0, 1, -1, 0, 500, 0],
        style: { kind: "zone", fontSize: 18 },
      }),
    ).toEqual({ minX: 280, minY: 10, maxX: 480, maxY: 310 });
    expect(zoneTitleBandHeight(18)).toBeCloseTo(45.6);
    expect(zoneGeometryContainsPoint(geometry, [150, 35], 18)).toBe(true);
    expect(zoneGeometryContainsPoint(geometry, [12, 130], 18)).toBe(true);
    expect(zoneGeometryContainsPoint(geometry, [150, 130], 18)).toBe(false);
    expect(zoneGeometryContainsPoint(geometry, [315, 130], 18, 5)).toBe(true);
    expect(zoneGeometryContainsPoint(geometry, [400, 130], 18, 5)).toBe(false);
    expect(() => zoneGeometryContainsPoint(geometry, [20, 20], 18, -1)).toThrow(/padding/);
    expect(() => zoneTitleBandHeight(Number.NaN)).toThrow(/font size/);
  });

  it("uses the transformed square centered on the stamp anchor", () => {
    expect(
      itemBounds({
        kind: "stamp",
        geometry: { x: 10, y: 20, size: 8, stamp: "star" },
        transform: [0, 1, -1, 0, 100, 0],
        style: { kind: "stamp" },
      }),
    ).toEqual({ minX: 76, minY: 6, maxX: 84, maxY: 14 });
  });

  it("uses the canonical video-card size for explicitly embedded text", () => {
    expect(
      itemBounds({
        kind: "text",
        geometry: {
          x: 100,
          y: 40,
          text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          embed: "video",
        },
        transform: [1, 0, 0, 1, 0, 0],
        style: { kind: "text", fontSize: 20 },
      }),
    ).toEqual({ minX: 100, minY: 20, maxX: 460, maxY: 252 });
  });

  it("counts explicit TeX dimensions in canonical text bounds", () => {
    // Collapsing \hspace to one glyph let a crafted item claim the width of a few letters
    // while MathJax rendered about 20 em, so a Section could accept a formula that spills out.
    expect(textLayoutEstimateSource("$$\\hspace{20em}x$$", 20)).toHaveLength(35);
    // A lone $ is a dollar sign, so this one is plain text and estimates as itself.
    expect(textLayoutEstimateSource("$\\hspace{20em}x$", 20)).toBe("$\\hspace{20em}x$");
    expect(
      itemBounds({
        kind: "text",
        geometry: { x: 0, y: 40, text: "$$\\hspace{20em}x$$" },
        transform: [1, 0, 0, 1, 0, 0],
        style: { kind: "text", fontSize: 20 },
      }),
    ).toEqual({ minX: 0, minY: 20, maxX: 420, maxY: 44 });
    // Absolute units resolve against the font size, so tiny kerns stay tiny.
    expect(textLayoutEstimateSource("$$\\kern 2pt x$$", 20)).toBe("x x");

    // Negative movement extends the bounds to the left instead of disappearing from them.
    expect(
      itemBounds({
        kind: "text",
        geometry: { x: 0, y: 40, text: "$$x\\kern-20em y$$" },
        transform: [1, 0, 0, 1, 0, 0],
        style: { kind: "text", fontSize: 20 },
      }),
    ).toEqual({ minX: -400, minY: 20, maxX: 36, maxY: 44 });
    const negativeThinSpaceBounds = itemBounds({
      kind: "text",
      geometry: { x: 0, y: 40, text: "$$x\\!y$$" },
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "text", fontSize: 20 },
    });
    expect(negativeThinSpaceBounds.minX).toBeCloseTo(-10 / 3);
    expect(negativeThinSpaceBounds.maxX).toBe(24);

    // Vertical space and rule heights extend the estimate downwards.
    expect(
      itemBounds({
        kind: "text",
        geometry: { x: 0, y: 40, text: "$$\\vspace{4em}x$$" },
        transform: [1, 0, 0, 1, 0, 0],
        style: { kind: "text", fontSize: 20 },
      }),
    ).toEqual({ minX: 0, minY: 20, maxX: 12, maxY: 140 });
    expect(
      itemBounds({
        kind: "text",
        geometry: { x: 0, y: 40, text: "$$\\rule{5em}{3em}$$" },
        transform: [1, 0, 0, 1, 0, 0],
        style: { kind: "text", fontSize: 20 },
      }),
    ).toEqual({ minX: 0, minY: -20, maxX: 108, maxY: 116 });
    expect(
      itemBounds({
        kind: "text",
        geometry: { x: 0, y: 440, text: "$$\\rule[20em]{1em}{1em}$$" },
        transform: [1, 0, 0, 1, 0, 0],
        style: { kind: "text", fontSize: 20 },
      }),
    ).toEqual({ minX: 0, minY: 20, maxX: 24, maxY: 468 });

    // A sized command with no dimension we model is over- rather than under-reported.
    expect(textLayoutEstimateSource("$$\\makebox{x}$$", 20)).toBe(`${"x".repeat(64)}x`);

    // A hostile dimension cannot expand the estimate without bound.
    expect(textLayoutEstimateSource("$$\\hspace{999999in}x$$", 20)).toHaveLength(4097);
    const repeatedDimensions = `$$${"\\hspace{999999in}".repeat(200)}x$$`;
    expect(repeatedDimensions.length).toBeLessThanOrEqual(5_000);
    expect(textLayoutEstimateSource(repeatedDimensions, 20)).toHaveLength(4097);

    // The budget applies across separate formula fragments in the same text item too.
    const repeatedFormulae = `${"$$\\hspace{999999in}$$".repeat(200)}x`;
    expect(repeatedFormulae.length).toBeLessThanOrEqual(5_000);
    expect(textLayoutEstimateSource(repeatedFormulae, 20)).toHaveLength(4097);
  });

  it("does not count zero-width TeX syntax in canonical text bounds", () => {
    expect(textLayoutEstimateSource("Result: $$\\displaystyle x$$")).toBe("Result:  x");
    expect(textLayoutEstimateSource("$$\\frac{1}{2}$$")).toBe("12");
    expect(
      itemBounds({
        kind: "text",
        geometry: { x: 100, y: 40, text: "$$\\displaystyle x$$" },
        transform: [1, 0, 0, 1, 0, 0],
        style: { kind: "text", fontSize: 20 },
      }),
    ).toEqual({ minX: 100, minY: 20, maxX: 124, maxY: 44 });
    expect(
      itemBounds({
        kind: "text",
        geometry: { x: 100, y: 40, text: "$$\\frac{1}{2}$$" },
        transform: [1, 0, 0, 1, 0, 0],
        style: { kind: "text", fontSize: 20 },
      }),
    ).toEqual({ minX: 100, minY: 20, maxX: 124, maxY: 44 });
  });

  it("rejects transformed sticky bounds outside the finite world envelope", () => {
    expect(() =>
      itemBounds({
        kind: "sticky",
        geometry: { x: 1_000_000, y: 0, width: 1, height: 1, text: "Bounded" },
        transform: [2, 0, 0, 1, 0, 0],
        style: { kind: "sticky", fontSize: 16 },
      }),
    ).toThrow(/Transformed item bounds/);
  });

  it("uses the full transformed image card and inclusive local hit testing", () => {
    const geometry = {
      x: 2,
      y: 3,
      width: 20,
      height: 10,
      assetId: ASSET_ID,
      alt: "Source diagram",
      mimeType: "image/png" as const,
      intrinsicWidth: 200,
      intrinsicHeight: 100,
    };
    expect(
      itemBounds({
        kind: "image",
        geometry,
        transform: [0, 1, -1, 0, 100, 0],
        style: { kind: "image" },
      }),
    ).toEqual({ minX: 87, minY: 2, maxX: 97, maxY: 22 });
    expect(imageGeometryContainsPoint(geometry, [2, 3])).toBe(true);
    expect(imageGeometryContainsPoint(geometry, [22, 13])).toBe(true);
    expect(imageGeometryContainsPoint(geometry, [1.5, 2.5])).toBe(false);
    expect(imageGeometryContainsPoint(geometry, [1.5, 2.5], 0.5)).toBe(true);
    expect(() => imageGeometryContainsPoint(geometry, [5, 5], Number.NaN)).toThrow(/padding/);
  });

  it("uses summed table dimensions for transformed bounds and inclusive hit testing", () => {
    const geometry = {
      x: 2,
      y: 3,
      columnWidths: [20, 30],
      rowHeights: [10, 15],
      cells: [
        ["A", "B"],
        ["C", "D"],
      ],
      headerRow: true,
    };
    expect(
      itemBounds({
        kind: "table",
        geometry,
        transform: [0, 1, -1, 0, 100, 0],
        style: { kind: "table", fontSize: 16 },
      }),
    ).toEqual({ minX: 72, minY: 2, maxX: 97, maxY: 52 });
    expect(tableGeometryContainsPoint(geometry, [2, 3])).toBe(true);
    expect(tableGeometryContainsPoint(geometry, [52, 28])).toBe(true);
    expect(tableGeometryContainsPoint(geometry, [1.5, 2.5])).toBe(false);
    expect(tableGeometryContainsPoint(geometry, [1.5, 2.5], 0.5)).toBe(true);
    expect(() => tableGeometryContainsPoint(geometry, [5, 5], -1)).toThrow(/padding/);
  });

  it("unions item bounds and translates only the affine offset", () => {
    const transform = translateTransform([1, 0, 0, 1, 2, 3], 4.126, -5.555);
    expect(transform).toEqual([1, 0, 0, 1, 6.13, -2.56]);
    expect(
      boundsForItems([
        {
          kind: "rectangle",
          geometry: { x: 0, y: 0, width: 10, height: 10 },
          transform: [1, 0, 0, 1, 0, 0],
          style: { kind: "stroke", width: 2 },
        },
        {
          kind: "rectangle",
          geometry: { x: 20, y: 30, width: 5, height: 5 },
          transform: [1, 0, 0, 1, 0, 0],
          style: { kind: "stroke", width: 2 },
        },
      ]),
    ).toEqual({ minX: -1, minY: -1, maxX: 26, maxY: 36 });
  });
});

describe("canonical number formatting", () => {
  it("normalizes negative zero and exponent notation", () => {
    expect(formatCanonicalNumber(-0)).toBe("0");
    expect(formatCanonicalNumber(1e-7)).toBe("0.0000001");
    expect(formatCanonicalNumber(1.2e21)).toBe("1200000000000000000000");
  });
});

describe("boundsContain", () => {
  const container = { minX: 0, minY: 0, maxX: 100, maxY: 50 };

  it("accepts candidates inside or exactly on the container edges", () => {
    expect(boundsContain(container, { minX: 10, minY: 10, maxX: 90, maxY: 40 })).toBe(true);
    expect(boundsContain(container, container)).toBe(true);
  });

  it("tolerates floating-point drift at the edges but not real overflow", () => {
    expect(boundsContain(container, { minX: -1e-9, minY: 0, maxX: 100 + 1e-9, maxY: 50 })).toBe(
      true,
    );
    expect(boundsContain(container, { minX: -0.001, minY: 0, maxX: 100, maxY: 50 })).toBe(false);
    expect(boundsContain(container, { minX: 0, minY: 0, maxX: 100.001, maxY: 50 })).toBe(false);
    expect(boundsContain(container, { minX: 0, minY: 0, maxX: 100.001, maxY: 50 }, 0.01)).toBe(
      true,
    );
  });
});

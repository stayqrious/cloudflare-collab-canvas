import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_TOOLS,
  assertCanonicalAssetId,
  BOARD_FEATURE_KEYS,
  CommentMediaError,
  canonicalRequestHashInput,
  canonicalStringify,
  DEFAULT_BOARD_FEATURES,
  MAX_IMAGE_ALT_CODE_POINTS,
  normalizeBoardAccessPolicy,
  normalizeBoardFeatures,
  normalizeCommentMedia,
  ProtocolValidationError,
  parseClientFrame,
  TEXT_FONT_FAMILIES,
  textFontStack,
  validateDurableOperation,
  validatePlainText,
  validateTableCellText,
  validateZoneTitle,
} from "./index.js";

const ID_1 = "018f0000-0000-7000-8000-000000000001";
const ID_2 = "018f0000-0000-7000-8000-000000000002";
const ID_3 = "018f0000-0000-7000-8000-000000000003";
const ASSET_ID = "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function rectangle(id = ID_1) {
  return {
    id,
    kind: "rectangle",
    style: { kind: "stroke", color: "#abcdef", width: 2.125, opacity: 0.555 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 5.129, y: 7.555, width: -2, height: 4 },
  };
}

function line(id = ID_1, arrowhead = "arrow") {
  return {
    id,
    kind: "line",
    style: {
      kind: "line",
      color: "#abcdef",
      width: 2.125,
      opacity: 0.555,
      arrowhead,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x1: 5.129, y1: 7.555, x2: 25.555, y2: 17.129 },
  };
}

function polygon(id = ID_1) {
  return {
    id,
    kind: "polygon",
    style: { kind: "stroke", color: "#abcdef", width: 2.125, opacity: 0.555 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: 5.129,
      y: 7.555,
      width: 80,
      height: 60,
      polygon: "pentagon",
    },
  };
}

function protractor(id = ID_1) {
  return {
    id,
    kind: "protractor",
    style: { kind: "protractor", color: "#3dadff", opacity: 0.8 },
    transform: [0, 1, -1, 0, 100, 200],
    geometry: { radius: 160.125 },
  };
}

function text(id = ID_1, fontFamily = "sans") {
  return {
    id,
    kind: "text",
    style: {
      kind: "text",
      color: "#123456",
      fontSize: 16.125,
      fontFamily,
      opacity: 0.555,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 15.129, y: 17.555, text: "Shared words" },
  };
}

function sticky(id = ID_1) {
  return {
    id,
    kind: "sticky",
    style: {
      kind: "sticky",
      fill: "#ffeb3b",
      textColor: "#212121",
      fontSize: 16.125,
      opacity: 0.555,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 15.129, y: 17.555, width: -10, height: 14, text: "" },
  };
}

function stamp(id = ID_1, stampKind = "star") {
  return {
    id,
    kind: "stamp",
    style: { kind: "stamp", color: "#e11d48", opacity: 0.555 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 12.345, y: -7.555, size: 71.999, stamp: stampKind },
  };
}

function image(id = ID_1) {
  return {
    id,
    kind: "image",
    style: { kind: "image", opacity: 0.555, radius: 12.125 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: 15.129,
      y: 17.555,
      width: -100,
      height: 80,
      assetId: ASSET_ID,
      alt: "Source diagram",
      mimeType: "image/png",
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
    },
  };
}

function table(id = ID_1) {
  return {
    id,
    kind: "table",
    style: {
      kind: "table",
      borderColor: "#94a3b8",
      fill: "#ffffff",
      headerFill: "#e2e8f0",
      textColor: "#0f172a",
      fontSize: 16.125,
      opacity: 0.555,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: 10.125,
      y: 20.555,
      columnWidths: [120.125, 120, 120],
      rowHeights: [48.125, 48, 48],
      cells: [
        ["Term", "Meaning", "Example"],
        ["Atom", "Small unit", "Carbon"],
        ["", "", ""],
      ],
      headerRow: true,
    },
  };
}

function zone(id = ID_1) {
  return {
    id,
    kind: "zone",
    style: {
      kind: "zone",
      borderColor: "#a8a59d",
      fill: "#e8edff",
      textColor: "#4f5b75",
      fontSize: 18.125,
      opacity: 0.175,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: {
      x: 10.125,
      y: 20.555,
      width: 520.125,
      height: 320,
      title: "Evidence",
    },
  };
}

describe("durable operation validation", () => {
  it("normalizes a valid create and rejects server-owned fields", () => {
    expect(validateDurableOperation({ kind: "item.create", item: rectangle() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "rectangle",
        style: { kind: "stroke", color: "#abcdef", width: 2.13, opacity: 0.56 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 3.13, y: 7.56, width: 2, height: 4, shape: "rectangle" },
      },
    });
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...rectangle(), z: 10 },
      }),
    ).toThrow(/Unknown field/);

    expect(
      validateDurableOperation({
        kind: "item.create",
        item: { ...rectangle(), assistedBy: "ai" },
      }),
    ).toMatchObject({ item: { assistedBy: "ai" } });
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...rectangle(), assistedBy: "automation" },
      }),
    ).toThrow(/Expected one of "ai"/);
  });

  it("persists explicit video embeds without interpreting ordinary URL text as an embed", () => {
    expect(
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...text(),
          geometry: {
            ...text().geometry,
            text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            embed: "video",
          },
        },
      }),
    ).toMatchObject({ item: { geometry: { embed: "video" } } });
    expect(validateDurableOperation({ kind: "item.create", item: text() })).not.toHaveProperty(
      "item.geometry.embed",
    );
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...text(), geometry: { ...text().geometry, embed: "automatic" } },
      }),
    ).toThrow(/text embed/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...text(),
          geometry: { ...text().geometry, text: "not a video", embed: "video" },
        },
      }),
    ).toThrow(/supported HTTPS YouTube or Vimeo/);
  });

  it("normalizes explicit groups, Section membership, copy remapping, and block typography", () => {
    const groupedSticky = {
      ...sticky(),
      groupId: ID_2,
      sectionId: ID_3,
      style: {
        ...sticky().style,
        fontFamily: "serif",
        fontWeight: "bold",
        fontStyle: "italic",
        textDecoration: "underline",
      },
    };
    expect(validateDurableOperation({ kind: "item.create", item: groupedSticky })).toMatchObject({
      item: {
        groupId: ID_2,
        sectionId: ID_3,
        style: {
          fontFamily: "serif",
          fontWeight: "bold",
          fontStyle: "italic",
          textDecoration: "underline",
        },
      },
    });
    expect(
      validateDurableOperation({
        kind: "item.create",
        item: { ...zone(), geometry: { ...zone().geometry, locked: true } },
      }),
    ).toMatchObject({ item: { kind: "zone", geometry: { locked: true } } });
    expect(
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 4,
        patch: { groupId: null, sectionId: ID_3 },
      }),
    ).toEqual({
      kind: "item.update",
      itemId: ID_1,
      expectedVersion: 4,
      patch: { groupId: null, sectionId: ID_3 },
    });
    expect(
      validateDurableOperation({
        kind: "item.copy",
        sourceItemId: ID_1,
        expectedVersion: 4,
        newItemId: ID_2,
        translate: { x: 20, y: 20 },
        newGroupId: ID_3,
        newSectionId: null,
      }),
    ).toMatchObject({ newGroupId: ID_3, newSectionId: null });
  });

  it("persists an explicit square subtype while canonicalizing legacy rectangles", () => {
    expect(
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...rectangle(),
          geometry: {
            ...rectangle().geometry,
            width: 40,
            height: 40,
            shape: "square",
          },
        },
      }),
    ).toMatchObject({
      item: {
        kind: "rectangle",
        geometry: { width: 40, height: 40, shape: "square" },
      },
    });
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...rectangle(),
          geometry: { ...rectangle().geometry, shape: "circle" },
        },
      }),
    ).toThrow(/Rectangle shape must be one of/);
  });

  it("requires a strict line-specific arrowhead style", () => {
    expect(validateDurableOperation({ kind: "item.create", item: line() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "line",
        style: {
          kind: "line",
          color: "#abcdef",
          width: 2.13,
          opacity: 0.56,
          arrowhead: "arrow",
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x1: 5.13, y1: 7.56, x2: 25.56, y2: 17.13 },
      },
    });
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...line(),
          style: { kind: "stroke", color: "#abcdef", width: 2, opacity: 1 },
        },
      }),
    ).toThrow(/line/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...line(), style: { ...line().style, arrowhead: "diamond" } },
      }),
    ).toThrow(/arrowhead/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...line(), style: { ...line().style, extra: true } },
      }),
    ).toThrow(/Unknown field/);
  });

  it("normalizes visible line fragments and strict polygon/protractor items", () => {
    expect(
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...line(),
          geometry: {
            ...line().geometry,
            visiblePaths: [
              [
                [5.129, 7.555],
                [10.126, 9],
              ],
              [
                [20, 15],
                [25.555, 17.129],
              ],
            ],
          },
        },
      }),
    ).toMatchObject({
      item: {
        geometry: {
          visiblePaths: [
            [
              [5.13, 7.56],
              [10.13, 9],
            ],
            [
              [20, 15],
              [25.56, 17.13],
            ],
          ],
        },
      },
    });
    expect(validateDurableOperation({ kind: "item.create", item: polygon() })).toMatchObject({
      item: {
        kind: "polygon",
        geometry: {
          x: 5.13,
          y: 7.56,
          width: 80,
          height: 60,
          polygon: "pentagon",
        },
      },
    });
    expect(validateDurableOperation({ kind: "item.create", item: protractor() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "protractor",
        style: { kind: "protractor", color: "#3dadff", opacity: 0.8 },
        transform: [0, 1, -1, 0, 100, 200],
        geometry: { radius: 160.13 },
      },
    });
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...protractor(), style: polygon().style },
      }),
    ).toThrow(/protractor/);
  });

  it("persists only allowlisted text font families with trusted local stacks", () => {
    for (const fontFamily of TEXT_FONT_FAMILIES) {
      expect(
        validateDurableOperation({
          kind: "item.create",
          item: text(ID_1, fontFamily),
        }),
      ).toMatchObject({ item: { style: { fontFamily } } });
      expect(textFontStack(fontFamily)).not.toMatch(/url\(|https?:/u);
    }
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: text(ID_1, "remote-font"),
      }),
    ).toThrow(/fontFamily/u);
  });

  it("normalizes sticky creates and permits empty sticky text", () => {
    expect(validateDurableOperation({ kind: "item.create", item: sticky() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "sticky",
        style: {
          kind: "sticky",
          fill: "#ffeb3b",
          textColor: "#212121",
          fontSize: 16.13,
          opacity: 0.56,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 5.13, y: 17.56, width: 10, height: 14, text: "" },
      },
    });
  });

  it("validates sticky dimensions, styles, text, and patch inference", () => {
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...sticky(),
          geometry: { x: 0, y: 0, width: 0, height: 10, text: "" },
        },
      }),
    ).toThrow(/greater than 0/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...sticky(), style: { ...sticky().style, fill: "#FFEB3B" } },
      }),
    ).toThrow(/lowercase/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...sticky(),
          geometry: { ...sticky().geometry, text: "x".repeat(1_001) },
        },
      }),
    ).toThrow(/at most 1000/);
    for (const text of ["hidden\u007fcontrol", "hidden\u0085control"]) {
      expect(() =>
        validateDurableOperation({
          kind: "item.create",
          item: { ...sticky(), geometry: { ...sticky().geometry, text } },
        }),
      ).toThrow(/control character/);
    }
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...sticky(),
          geometry: { ...sticky().geometry, text: "unpaired\ud800" },
        },
      }),
    ).toThrow(/unpaired surrogate/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...sticky(),
          transform: [Number.MAX_VALUE, 0, 0, 1, 0, 0],
        },
      }),
    ).toThrow(/Transform component/);
    expect(
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 1,
        patch: { geometry: { x: 1, y: 2, width: 180, height: 140, text: "" } },
      }),
    ).toMatchObject({
      patch: { geometry: { x: 1, y: 2, width: 180, height: 140, text: "" } },
    });
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          id: ID_1,
          kind: "text",
          style: {
            kind: "text",
            color: "#123456",
            fontSize: 16,
            fontFamily: "sans",
            opacity: 1,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 0, y: 0, text: "" },
        },
      }),
    ).toThrow(/must not be empty/);
  });

  it("normalizes every durable stamp and rejects unsafe geometry and styles", () => {
    for (const stampKind of ["star", "check", "heart", "question", "smile", "sparkle"]) {
      expect(
        validateDurableOperation({
          kind: "item.create",
          item: stamp(ID_1, stampKind),
        }),
      ).toEqual({
        kind: "item.create",
        item: {
          id: ID_1,
          kind: "stamp",
          style: { kind: "stamp", color: "#e11d48", opacity: 0.56 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 12.35, y: -7.56, size: 72, stamp: stampKind },
        },
      });
    }
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: { ...stamp(), geometry: { x: 0, y: 0, size: 0, stamp: "star" } },
      }),
    ).toThrow(/greater than 0/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...stamp(),
          geometry: { x: 0, y: 0, size: 72, stamp: "award" },
        },
      }),
    ).toThrow(/Stamp must be one of/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...stamp(),
          style: { kind: "stamp", color: "#E11D48", opacity: 1 },
        },
      }),
    ).toThrow(/lowercase/);
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...stamp(),
          style: { kind: "stamp", color: "#e11d48", opacity: 0 },
        },
      }),
    ).toThrow(/between 0.1 and 1/);
    expect(
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 1,
        patch: { geometry: { x: 20, y: 30, size: 80, stamp: "check" } },
      }),
    ).toMatchObject({
      patch: { geometry: { x: 20, y: 30, size: 80, stamp: "check" } },
    });
  });

  it("normalizes durable image cards without embedding asset bytes", () => {
    expect(validateDurableOperation({ kind: "item.create", item: image() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "image",
        style: { kind: "image", opacity: 0.56, radius: 12.13 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: -84.87,
          y: 17.56,
          width: 100,
          height: 80,
          assetId: ASSET_ID,
          alt: "Source diagram",
          mimeType: "image/png",
          intrinsicWidth: 1200,
          intrinsicHeight: 800,
        },
      },
    });
    expect(assertCanonicalAssetId(ASSET_ID)).toBe(ASSET_ID);
    expect(ACTIVE_TOOLS).toContain("image");
    expect(
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 1,
        patch: { geometry: { ...image().geometry, alt: "" } },
      }),
    ).toMatchObject({
      patch: {
        geometry: expect.not.objectContaining({ alt: expect.anything() }),
      },
    });
  });

  it("rejects hostile image references, metadata, dimensions, alt, and styles", () => {
    const cases = [
      {
        ...image(),
        geometry: {
          ...image().geometry,
          assetId: "data:image/png;base64,AAAA",
        },
      },
      {
        ...image(),
        geometry: { ...image().geometry, mimeType: "image/svg+xml" },
      },
      { ...image(), geometry: { ...image().geometry, intrinsicWidth: 4097 } },
      {
        ...image(),
        geometry: {
          ...image().geometry,
          intrinsicWidth: 4001,
          intrinsicHeight: 4000,
        },
      },
      { ...image(), geometry: { ...image().geometry, alt: "x".repeat(501) } },
      { ...image(), geometry: { ...image().geometry, bytes: "AAAA" } },
      { ...image(), style: { kind: "image", opacity: 1, radius: -1 } },
      { ...image(), style: { kind: "image", opacity: 1, radius: 257 } },
    ];
    for (const item of cases) {
      expect(() => validateDurableOperation({ kind: "item.create", item })).toThrow(
        ProtocolValidationError,
      );
    }
    expect(() =>
      assertCanonicalAssetId("asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB"),
    ).toThrow(/base64url SHA-256/);
  });

  it("normalizes durable table grids and whole-geometry patches", () => {
    expect(validateDurableOperation({ kind: "item.create", item: table() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "table",
        style: {
          kind: "table",
          borderColor: "#94a3b8",
          fill: "#ffffff",
          headerFill: "#e2e8f0",
          textColor: "#0f172a",
          fontSize: 16.13,
          opacity: 0.56,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 10.13,
          y: 20.56,
          columnWidths: [120.13, 120, 120],
          rowHeights: [48.13, 48, 48],
          cells: [
            ["Term", "Meaning", "Example"],
            ["Atom", "Small unit", "Carbon"],
            ["", "", ""],
          ],
          headerRow: true,
        },
      },
    });
    expect(ACTIVE_TOOLS).toContain("table");
    expect(validateTableCellText("")).toBe("");
    expect(
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 1,
        patch: {
          geometry: {
            ...table().geometry,
            cells: [["A", "B", "C"], ...table().geometry.cells.slice(1)],
          },
        },
      }),
    ).toMatchObject({
      patch: {
        geometry: {
          cells: [["A", "B", "C"], ...table().geometry.cells.slice(1)],
        },
      },
    });
  });

  it("rejects malformed table grids, hostile text, unsafe sizes, and kind confusion", () => {
    const base = table();
    const cases = [
      { ...base, geometry: { ...base.geometry, columnWidths: [] } },
      {
        ...base,
        geometry: { ...base.geometry, rowHeights: Array(9).fill(48) },
      },
      { ...base, geometry: { ...base.geometry, columnWidths: [120, 0, 120] } },
      {
        ...base,
        geometry: { ...base.geometry, cells: base.geometry.cells.slice(0, 2) },
      },
      {
        ...base,
        geometry: {
          ...base.geometry,
          cells: [["A"], ...base.geometry.cells.slice(1)],
        },
      },
      {
        ...base,
        geometry: {
          ...base.geometry,
          cells: [["x".repeat(501), "", ""], ...base.geometry.cells.slice(1)],
        },
      },
      {
        ...base,
        geometry: {
          ...base.geometry,
          cells: [["bad\u0000cell", "", ""], ...base.geometry.cells.slice(1)],
        },
      },
      {
        ...base,
        geometry: {
          ...base.geometry,
          cells: [["bad\ud800cell", "", ""], ...base.geometry.cells.slice(1)],
        },
      },
      { ...base, geometry: { ...base.geometry, headerRow: "true" } },
      { ...base, geometry: { ...base.geometry, width: 360 } },
      { ...base, style: { ...base.style, borderColor: "#94A3B8" } },
      { ...base, style: { ...base.style, fontSize: 7 } },
      {
        ...base,
        style: {
          kind: "sticky",
          fill: "#ffffff",
          textColor: "#000000",
          fontSize: 16,
          opacity: 1,
        },
      },
    ];
    for (const item of cases) {
      expect(() => validateDurableOperation({ kind: "item.create", item })).toThrow(
        ProtocolValidationError,
      );
    }

    const tooMuchText = Array.from({ length: 3 }, () =>
      Array.from({ length: 6 }, () => "x".repeat(500)),
    );
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...base,
          geometry: {
            ...base.geometry,
            columnWidths: Array(6).fill(80),
            rowHeights: Array(3).fill(48),
            cells: tooMuchText,
          },
        },
      }),
    ).toThrow(/at most 8000/);
  });

  it("normalizes durable zones and whole-title geometry patches", () => {
    expect(validateDurableOperation({ kind: "item.create", item: zone() })).toEqual({
      kind: "item.create",
      item: {
        id: ID_1,
        kind: "zone",
        style: {
          kind: "zone",
          borderColor: "#a8a59d",
          fill: "#e8edff",
          textColor: "#4f5b75",
          fontSize: 18.13,
          opacity: 0.18,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 10.13,
          y: 20.56,
          width: 520.13,
          height: 320,
          title: "Evidence",
        },
      },
    });
    expect(ACTIVE_TOOLS).toContain("zone");
    expect(validateZoneTitle("Questions")).toBe("Questions");
    expect(
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 4,
        patch: { geometry: { ...zone().geometry, title: "Finished examples" } },
      }),
    ).toMatchObject({ patch: { geometry: { title: "Finished examples" } } });
  });

  it("rejects unsafe zone titles, dimensions, styles, and kind confusion", () => {
    const base = zone();
    const cases = [
      { ...base, geometry: { ...base.geometry, title: "" } },
      { ...base, geometry: { ...base.geometry, title: "😀".repeat(121) } },
      { ...base, geometry: { ...base.geometry, title: "bad\u0000title" } },
      { ...base, geometry: { ...base.geometry, title: "bad\ud800title" } },
      { ...base, geometry: { ...base.geometry, width: 0 } },
      { ...base, geometry: { ...base.geometry, text: "not a zone" } },
      { ...base, style: { ...base.style, fill: "#E8EDFF" } },
      { ...base, style: { ...base.style, opacity: 0.09 } },
      { ...base, style: { ...base.style, fontSize: 257 } },
      {
        ...base,
        style: { kind: "stroke", color: "#a8a59d", width: 2, opacity: 1 },
      },
    ];
    for (const item of cases) {
      expect(() => validateDurableOperation({ kind: "item.create", item })).toThrow(
        ProtocolValidationError,
      );
    }
  });

  it("requires imagesEnabled in canonical authoritative board policy", () => {
    expect(
      normalizeBoardAccessPolicy({
        accessMode: "private",
        drawingPolicy: "owner_only",
        imagesEnabled: false,
        aclVersion: 3,
      }),
    ).toEqual({
      accessMode: "private",
      drawingPolicy: "owner_only",
      imagesEnabled: false,
      aclVersion: 3,
    });
    expect(() =>
      normalizeBoardAccessPolicy({
        accessMode: "private",
        drawingPolicy: "owner_only",
        aclVersion: 3,
      }),
    ).toThrow(/Missing field "imagesEnabled"/);
    expect(() =>
      normalizeBoardAccessPolicy({
        accessMode: "private",
        drawingPolicy: "owner_only",
        imagesEnabled: "false",
        aclVersion: 3,
      }),
    ).toThrow(/must be a boolean/);
    expect(() =>
      normalizeBoardAccessPolicy({
        accessMode: "private",
        drawingPolicy: "owner_only",
        imagesEnabled: false,
        aclVersion: 0,
      }),
    ).toThrow(/greater than or equal to 1/);
  });

  it("normalizes an exact, complete board feature map with images on by default", () => {
    expect(BOARD_FEATURE_KEYS).toHaveLength(25);
    expect(DEFAULT_BOARD_FEATURES.images).toBe(true);
    expect(normalizeBoardFeatures(DEFAULT_BOARD_FEATURES)).toEqual(DEFAULT_BOARD_FEATURES);
    expect(() => normalizeBoardFeatures({ ...DEFAULT_BOARD_FEATURES, protractor: "yes" })).toThrow(
      /protractor must be a boolean/,
    );
    const { voting: _voting, ...missingVoting } = DEFAULT_BOARD_FEATURES;
    expect(() => normalizeBoardFeatures(missingVoting)).toThrow(/Missing field "voting"/);
    expect(() => normalizeBoardFeatures({ ...DEFAULT_BOARD_FEATURES, unknown: true })).toThrow(
      /Unknown field "unknown"/,
    );
  });

  it("rejects nested batches, unknown patch fields, and duplicate affected IDs", () => {
    expect(() =>
      validateDurableOperation({
        kind: "items.batch",
        operations: [{ kind: "items.batch", operations: [] }],
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      validateDurableOperation({
        kind: "item.update",
        itemId: ID_1,
        expectedVersion: 1,
        patch: { z: 9 },
      }),
    ).toThrow(/Unknown field/);
    expect(() =>
      validateDurableOperation({
        kind: "items.batch",
        operations: [
          { kind: "item.delete", itemId: ID_1, expectedVersion: 1 },
          {
            kind: "item.update",
            itemId: ID_1,
            expectedVersion: 1,
            patch: { transform: [1, 0, 0, 1, 2, 2] },
          },
        ],
      }),
    ).toThrow(/only once/);
  });

  it("rejects mismatched styles, non-finite numbers, and invalid IDs", () => {
    expect(() =>
      validateDurableOperation({
        kind: "item.create",
        item: {
          ...rectangle(),
          style: {
            kind: "text",
            color: "#abcdef",
            fontSize: 16,
            fontFamily: "sans",
            opacity: 1,
          },
        },
      }),
    ).toThrow(/stroke/);
    expect(() =>
      validateDurableOperation({
        kind: "item.copy",
        sourceItemId: ID_1,
        expectedVersion: 1,
        newItemId: ID_2,
        translate: { x: Number.POSITIVE_INFINITY, y: 0 },
      }),
    ).toThrow(/finite/);
    expect(() =>
      validateDurableOperation({
        kind: "item.delete",
        itemId: "../bad",
        expectedVersion: 1,
      }),
    ).toThrow(/canonical UUID/);
  });
});

describe("hostile frame parsing", () => {
  it("parses and normalizes a commit frame", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: ID_2,
        actionId: ID_3,
        baseSeq: 0,
        op: { kind: "item.create", item: rectangle() },
      }),
    );
    expect(frame.t).toBe("client.commit");
    expect(frame.t === "client.commit" && frame.op.kind).toBe("item.create");
  });

  it("admits a bounded table create nested inside an item batch", () => {
    expect(
      parseClientFrame(
        JSON.stringify({
          v: 1,
          t: "client.commit",
          commandId: ID_2,
          actionId: ID_3,
          baseSeq: 0,
          op: {
            kind: "items.batch",
            operations: [{ kind: "item.create", item: table() }],
          },
        }),
      ),
    ).toMatchObject({
      t: "client.commit",
      op: {
        kind: "items.batch",
        operations: [
          {
            kind: "item.create",
            item: {
              kind: "table",
              geometry: {
                cells: [
                  ["Term", "Meaning", "Example"],
                  ["Atom", "Small unit", "Carbon"],
                  ["", "", ""],
                ],
              },
            },
          },
        ],
      },
    });
  });

  it("admits bounded visible fragments inside a batched partial erase", () => {
    expect(
      parseClientFrame(
        JSON.stringify({
          v: 1,
          t: "client.commit",
          commandId: ID_2,
          actionId: ID_3,
          baseSeq: 0,
          op: {
            kind: "items.batch",
            operations: [
              {
                kind: "item.update",
                itemId: ID_1,
                expectedVersion: 1,
                patch: {
                  geometry: {
                    ...line().geometry,
                    visiblePaths: [
                      [
                        [5, 7],
                        [10, 9],
                      ],
                    ],
                  },
                },
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      op: {
        kind: "items.batch",
        operations: [
          {
            kind: "item.update",
            patch: {
              geometry: {
                visiblePaths: [
                  [
                    [5, 7],
                    [10, 9],
                  ],
                ],
              },
            },
          },
        ],
      },
    });
  });

  it("normalizes line previews and preserves the frozen v1 stroke-style preview", () => {
    const preview = {
      v: 1,
      t: "client.preview",
      gestureId: ID_2,
      previewSeq: 1,
      kind: "shape.geometry",
      payload: {
        itemId: ID_1,
        itemKind: "line",
        geometry: line().geometry,
        style: line().style,
      },
    };
    expect(parseClientFrame(JSON.stringify(preview))).toMatchObject({
      payload: {
        itemKind: "line",
        geometry: { x1: 5.13, y1: 7.56, x2: 25.56, y2: 17.13 },
        style: { kind: "line", width: 2.13, opacity: 0.56, arrowhead: "arrow" },
      },
    });
    expect(
      parseClientFrame(
        JSON.stringify({
          ...preview,
          payload: { ...preview.payload, style: rectangle().style },
        }),
      ),
    ).toMatchObject({
      payload: { itemKind: "line", style: { kind: "stroke" } },
    });
    expect(() =>
      parseClientFrame(
        JSON.stringify({
          ...preview,
          payload: {
            ...preview.payload,
            itemKind: "rectangle",
            geometry: rectangle().geometry,
          },
        }),
      ),
    ).toThrow(/stroke/);
  });

  it("normalizes polygon geometry previews with stroke styles", () => {
    const preview = {
      v: 1,
      t: "client.preview",
      gestureId: ID_2,
      previewSeq: 2,
      kind: "shape.geometry",
      payload: {
        itemId: ID_1,
        itemKind: "polygon",
        geometry: polygon().geometry,
        style: polygon().style,
      },
    };
    expect(parseClientFrame(JSON.stringify(preview))).toMatchObject({
      payload: {
        itemKind: "polygon",
        geometry: {
          x: 5.13,
          y: 7.56,
          width: 80,
          height: 60,
          polygon: "pentagon",
        },
        style: { kind: "stroke", width: 2.13, opacity: 0.56 },
      },
    });
  });

  it("preserves the square subtype in rectangle geometry previews", () => {
    expect(
      parseClientFrame(
        JSON.stringify({
          v: 1,
          t: "client.preview",
          gestureId: ID_2,
          previewSeq: 3,
          kind: "shape.geometry",
          payload: {
            itemId: ID_1,
            itemKind: "rectangle",
            geometry: { x: 5, y: 7, width: 80, height: 80, shape: "square" },
            style: rectangle().style,
          },
        }),
      ),
    ).toMatchObject({
      payload: {
        itemKind: "rectangle",
        geometry: { x: 5, y: 7, width: 80, height: 80, shape: "square" },
      },
    });
  });

  it("rejects binary, unsupported, unknown, deep, and non-finite frames with typed errors", () => {
    expect(() => parseClientFrame(new Uint8Array([1, 2]))).toThrow(ProtocolValidationError);
    expect(() => parseClientFrame('{"v":2,"t":"client.sync_check","latestSeq":0}')).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_VERSION",
        details: { reloadRequired: true },
      }),
    );
    expect(() => parseClientFrame('{"v":1,"t":"unknown"}')).toThrow(/Unknown frame type/);
    let nested: unknown = 1;
    for (let depth = 0; depth < 12; depth += 1) nested = [nested];
    expect(() =>
      parseClientFrame(JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: 0, nested })),
    ).toThrow(/nesting/);
    expect(() =>
      // validateClientFrame accepts programmatic hostile values too; JSON itself
      // cannot encode Infinity.
      validateDurableOperation({
        kind: "board.clear",
        expectedBoardSeq: Number.NaN,
      }),
    ).toThrow(/safe integer/);
  });

  it("enforces the ordinary frame byte limit", () => {
    const payload = JSON.stringify({
      v: 1,
      t: "client.presence",
      cursor: { x: 0, y: 0 },
      activeTool: "pencil",
      padding: "x".repeat(70_000),
    });
    expect(() => parseClientFrame(payload)).toThrowError(
      expect.objectContaining({ code: "MESSAGE_TOO_LARGE" }),
    );
  });

  it("strictly normalizes active and stopped facilitation spotlight frames", () => {
    expect(
      parseClientFrame(
        JSON.stringify({
          v: 1,
          t: "client.facilitation.spotlight",
          spotlightId: ID_1,
          active: true,
          viewport: { center: { x: 12.345, y: -45.555 }, zoom: 1.23456 },
        }),
      ),
    ).toEqual({
      v: 1,
      t: "client.facilitation.spotlight",
      spotlightId: ID_1,
      active: true,
      viewport: { center: { x: 12.35, y: -45.56 }, zoom: 1.2346 },
    });
    expect(
      parseClientFrame(
        JSON.stringify({
          v: 1,
          t: "client.facilitation.spotlight",
          spotlightId: ID_1,
          active: false,
        }),
      ),
    ).toEqual({
      v: 1,
      t: "client.facilitation.spotlight",
      spotlightId: ID_1,
      active: false,
    });
  });

  it("rejects malformed facilitation spotlight sessions and viewports", () => {
    const active = {
      v: 1,
      t: "client.facilitation.spotlight",
      spotlightId: ID_1,
      active: true,
      viewport: { center: { x: 0, y: 0 }, zoom: 1 },
    };
    for (const frame of [
      { ...active, spotlightId: "not-a-uuid" },
      { ...active, viewport: undefined },
      { ...active, viewport: { center: { x: 0, y: 0 }, zoom: 0.09 } },
      { ...active, viewport: { center: { x: 0, y: 0 }, zoom: 8.01 } },
      { ...active, viewport: { center: { x: 1_000_001, y: 0 }, zoom: 1 } },
      { ...active, viewport: { center: { x: 0, y: 0, z: 0 }, zoom: 1 } },
      { ...active, active: false, viewport: active.viewport },
    ]) {
      expect(() => parseClientFrame(JSON.stringify(frame))).toThrow(ProtocolValidationError);
    }
  });

  it("always returns a typed rejection for arbitrary hostile JSON operations", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 12 }), (candidate) => {
        try {
          validateDurableOperation(candidate);
        } catch (error) {
          expect(error).toBeInstanceOf(ProtocolValidationError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("rejects randomly deep JSON without overflowing the call stack", () => {
    fc.assert(
      fc.property(fc.integer({ min: 9, max: 100 }), (depth) => {
        let nested: unknown = 0;
        for (let index = 0; index < depth; index += 1) nested = [nested];
        expect(() =>
          parseClientFrame(
            JSON.stringify({
              v: 1,
              t: "client.sync_check",
              latestSeq: 0,
              nested,
            }),
          ),
        ).toThrow(ProtocolValidationError);
      }),
      { numRuns: 50 },
    );
  });
});

describe("canonical and Unicode handling", () => {
  it("sorts keys recursively and creates identical hash bytes", () => {
    expect(canonicalStringify({ z: 1, a: { y: -0, x: "ok" } })).toBe(
      '{"a":{"x":"ok","y":0},"z":1}',
    );
    expect(canonicalRequestHashInput({ kind: "board.clear", expectedBoardSeq: 2 })).toEqual(
      new TextEncoder().encode('{"expectedBoardSeq":2,"kind":"board.clear"}'),
    );
  });

  it("counts Unicode code points and rejects XML-invalid or unpaired input", () => {
    expect(validatePlainText("hello 🌍")).toBe("hello 🌍");
    expect(() => validatePlainText("bad\u0000text")).toThrow(/control/);
    expect(() => validatePlainText("\ud800")).toThrow(/surrogate/);
  });
});

describe("comment media", () => {
  const assetId = `asset_${"A".repeat(43)}`;

  it("canonicalizes a picture already stored on the board", () => {
    expect(
      normalizeCommentMedia({
        kind: "image",
        assetId,
        mimeType: "image/png",
        intrinsicWidth: 800,
        intrinsicHeight: 600,
        alt: "  A parabola opening upward  ",
      }),
    ).toEqual({
      kind: "image",
      assetId,
      mimeType: "image/png",
      intrinsicWidth: 800,
      intrinsicHeight: 600,
      alt: "A parabola opening upward",
    });
    // An empty description is the same as none at all.
    expect(
      normalizeCommentMedia({
        kind: "image",
        assetId,
        mimeType: "image/png",
        intrinsicWidth: 800,
        intrinsicHeight: 600,
        alt: "   ",
      }),
    ).not.toHaveProperty("alt");
  });

  it("derives a video's provider from its link and normalizes the link", () => {
    expect(normalizeCommentMedia({ kind: "video", url: "https://youtu.be/dQw4w9WgXcQ" })).toEqual({
      kind: "video",
      provider: "youtube",
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(
      normalizeCommentMedia({
        kind: "video",
        provider: "vimeo",
        url: "https://vimeo.com/123456?h=abcdef",
      }),
    ).toMatchObject({ provider: "vimeo" });
  });

  it("refuses anything the board would not store or play", () => {
    const cases: unknown[] = [
      null,
      "https://youtu.be/dQw4w9WgXcQ",
      { kind: "sound", url: "https://example.com/a.mp3" },
      { kind: "video", url: "https://example.com/clip.mp4" },
      { kind: "video", url: "http://youtu.be/dQw4w9WgXcQ" },
      { kind: "video", provider: "youtube", url: "https://vimeo.com/123456" },
      { kind: "video", url: "https://youtu.be/dQw4w9WgXcQ", title: "extra" },
      {
        kind: "image",
        assetId: "asset_short",
        mimeType: "image/png",
        intrinsicWidth: 8,
        intrinsicHeight: 6,
      },
      { kind: "image", assetId, mimeType: "image/svg+xml", intrinsicWidth: 8, intrinsicHeight: 6 },
      { kind: "image", assetId, mimeType: "image/png", intrinsicWidth: 0, intrinsicHeight: 6 },
      { kind: "image", assetId, mimeType: "image/png", intrinsicWidth: 8.5, intrinsicHeight: 6 },
      { kind: "image", assetId, mimeType: "image/png", intrinsicHeight: 6 },
      {
        kind: "image",
        assetId,
        mimeType: "image/png",
        intrinsicWidth: 8,
        intrinsicHeight: 6,
        alt: "a".repeat(MAX_IMAGE_ALT_CODE_POINTS + 1),
      },
    ];
    for (const value of cases) {
      expect(() => normalizeCommentMedia(value)).toThrow(CommentMediaError);
    }
  });
});

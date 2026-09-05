import { describe, expect, it } from "vitest";
import type { BoardItem } from "../types";
import { serializeVisualPreview } from "./board-image";

const ACTOR_ID = "018f0000-0000-7000-8000-0000000000a1";
const PENCIL_ID = "018f0000-0000-7000-8000-0000000000b1";
const STICKY_ID = "018f0000-0000-7000-8000-0000000000b2";
const IMAGE_ID = "018f0000-0000-7000-8000-0000000000b3";

function pencil(): Extract<BoardItem, { kind: "pencil" }> {
  return {
    id: PENCIL_ID,
    kind: "pencil",
    z: 2,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 12, 18],
    style: { kind: "stroke", color: "#123456", width: 4, opacity: 1 },
    geometry: {
      points: [
        [0, 20],
        [12, 0],
        [24, 20],
        [18, 10],
        [6, 10],
      ],
    },
  };
}

function sticky(): Extract<BoardItem, { kind: "sticky" }> {
  return {
    id: STICKY_ID,
    kind: "sticky",
    z: 1,
    version: 3,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "sticky",
      fill: "#fff2a8",
      textColor: "#27231b",
      fontSize: 20,
      opacity: 1,
    },
    geometry: { x: 60, y: 10, width: 180, height: 120, text: "Selected context" },
  };
}

function privateImage(): Extract<BoardItem, { kind: "image" }> {
  return {
    id: IMAGE_ID,
    kind: "image",
    z: 3,
    version: 1,
    createdBy: ACTOR_ID,
    transform: [1, 0, 0, 1, 0, 0],
    style: { kind: "image", opacity: 1, radius: 12 },
    geometry: {
      x: 260,
      y: 10,
      width: 120,
      height: 80,
      assetId: "asset_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      alt: "Secret student photo description",
      mimeType: "image/png",
      intrinsicWidth: 1200,
      intrinsicHeight: 800,
    },
  };
}

describe("selected board visual serialization", () => {
  it("renders handwriting and selected context with aliases instead of stable IDs", () => {
    const preview = serializeVisualPreview([pencil(), sticky()]);

    expect(preview.viewBox.split(" ").map(Number).every(Number.isFinite)).toBe(true);
    expect(preview.ariaLabel).toContain("2 browser-selected items");
    expect(preview.content).toContain("<path");
    expect(preview.content).toContain(">Selected<");
    expect(preview.content).toContain(">context<");
    expect(preview.content).toContain('data-item-id="visual_1"');
    expect(preview.content).toContain('data-item-id="visual_2"');
    expect(preview.content).not.toContain(PENCIL_ID);
    expect(preview.content).not.toContain(STICKY_ID);
    expect(preview.content).not.toContain(ACTOR_ID);
    expect(preview.content).not.toContain("Unselected private note");
  });

  it("requires a non-empty visual", () => {
    expect(() => serializeVisualPreview([])).toThrow("at least one item");
  });

  it("renders a generic placeholder without private image pixels or alt text", () => {
    const preview = serializeVisualPreview([privateImage()]);

    expect(preview.content).toContain("Private image not shared");
    expect(preview.content).toContain('data-export-placeholder="private-image"');
    expect(preview.content).not.toContain("Secret student photo description");
    expect(preview.content).not.toContain("asset_A");
    expect(preview.content).not.toContain(IMAGE_ID);
  });
});

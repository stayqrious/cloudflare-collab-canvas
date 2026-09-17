import { describe, expect, it } from "vitest";
import type { Point } from "../types";
import { A5_CORNERS, calibrate, toClient, toPage, validateCorner } from "./calibration";

const available = { left: 0, top: 0, width: 1920, height: 1080 };
const rectangle: Point[] = [
  [20, 2],
  [620, 2],
  [620, 902],
  [20, 902],
];
const trapezoid: Point[] = [
  [300, 50],
  [900, 80],
  [840, 950],
  [240, 1000],
];

describe("four-corner Smart Note calibration", () => {
  it("pins all four measured corners exactly, including the top of the viewport", () => {
    for (const corners of [rectangle, trapezoid]) {
      const mapping = calibrate(corners, available);
      if (!mapping) throw new Error("Expected a valid page");
      corners.forEach((corner, index) => {
        const page = A5_CORNERS[index] as Point;
        const actual = toPage(mapping, ...corner);
        expect(actual[0]).toBeCloseTo(page[0], 8);
        expect(actual[1]).toBeCloseTo(page[1], 8);
        const screen = toClient(mapping, page);
        expect(screen[0]).toBeCloseTo(corner[0], 8);
        expect(screen[1]).toBeCloseTo(corner[1], 8);
      });
    }
  });
  it("maps different screens and skewed areas to the same page without losing interior points", () => {
    for (const corners of [rectangle, trapezoid]) {
      const mapping = calibrate(corners, available);
      if (!mapping) throw new Error("Expected a valid page");
      for (const point of [
        [185, 262.5],
        [370, 525],
        [555, 787.5],
      ] satisfies Point[]) {
        const client = toClient(mapping, point);
        const result = toPage(mapping, ...client);
        expect(result[0]).toBeCloseTo(point[0], 8);
        expect(result[1]).toBeCloseTo(point[1], 8);
      }
    }
  });
  it("rejects incomplete, reversed, folded, tiny, inaccessible and non-finite pages", () => {
    const invalid: Point[][] = [
      rectangle.slice(0, 3),
      [...rectangle].reverse(),
      [
        [0, 0],
        [500, 0],
        [0, 700],
        [500, 700],
      ],
      [
        [0, 0],
        [40, 0],
        [40, 900],
        [0, 900],
      ],
      [
        [0, -1],
        [500, 0],
        [500, 900],
        [0, 900],
      ],
      [
        [0, 0],
        [500, 0],
        [500, 1200],
        [0, 900],
      ],
      [
        [0, 0],
        [NaN, 0],
        [500, 900],
        [0, 900],
      ],
    ];
    for (const corners of invalid) expect(calibrate(corners, available)).toBeNull();
  });
  it("rejects nearby marks at every step without consuming previously accepted corners", () => {
    for (let index = 1; index < 4; index++) {
      const previous = rectangle.slice(0, index);
      for (const [x, y] of previous) {
        expect(validateCorner(previous, [x + 4, y + 4], available)).toContain("too close");
      }
      expect(validateCorner(previous, rectangle[index] as Point, available)).toBeNull();
      expect(previous).toEqual(rectangle.slice(0, index));
    }
  });
  it("rejects wrong directions, flat or narrow pages, and mismatched bottom edges immediately", () => {
    expect(validateCorner([[20, 2]], [10, 600], available)).toContain("top-right");
    expect(validateCorner(rectangle.slice(0, 2), [620, 300], available)).toContain("A5");
    expect(
      validateCorner(
        [
          [20, 2],
          [200, 2],
        ],
        [200, 1000],
        available,
      ),
    ).toContain("A5");
    expect(validateCorner(rectangle.slice(0, 3), [200, 902], available)).toContain("bottom-left");
    expect(validateCorner(rectangle.slice(0, 2), [620, 1060], available)).toBeNull();
  });
  it("keeps out-of-bounds samples outside instead of smearing them along an edge", () => {
    const mapping = calibrate(rectangle, available);
    if (!mapping) throw new Error("Expected a valid page");
    expect(toPage(mapping, 10, 200)[0]).toBeLessThan(0);
    expect(toPage(mapping, 640, 200)[0]).toBeGreaterThan(740);
  });
});

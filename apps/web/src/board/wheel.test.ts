import { describe, expect, it } from "vitest";
import { wheelScrollPixels } from "./wheel";

const page = { width: 800, height: 600 };

describe("wheelScrollPixels", () => {
  it("passes pixel deltas through for trackpad and mouse scrolling", () => {
    expect(
      wheelScrollPixels({ deltaX: 12, deltaY: -30, deltaMode: 0, shiftKey: false }, page),
    ).toEqual([12, -30]);
  });

  it("scales line and page deltas to pixels", () => {
    expect(
      wheelScrollPixels({ deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: false }, page),
    ).toEqual([0, 48]);
    expect(
      wheelScrollPixels({ deltaX: 1, deltaY: -1, deltaMode: 2, shiftKey: false }, page),
    ).toEqual([800, -600]);
  });

  it("turns a vertical wheel into horizontal scrolling while Shift is held", () => {
    expect(
      wheelScrollPixels({ deltaX: 0, deltaY: 40, deltaMode: 0, shiftKey: true }, page),
    ).toEqual([40, 0]);
    expect(
      wheelScrollPixels({ deltaX: 25, deltaY: 0, deltaMode: 0, shiftKey: true }, page),
    ).toEqual([25, 0]);
  });

  it("ignores non-finite deltas", () => {
    expect(
      wheelScrollPixels(
        { deltaX: Number.NaN, deltaY: Number.POSITIVE_INFINITY, deltaMode: 0, shiftKey: false },
        page,
      ),
    ).toEqual([0, 0]);
  });
});

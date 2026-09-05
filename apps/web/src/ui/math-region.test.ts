import { describe, expect, it } from "vitest";

import { mathRegionAtCaret, replaceMathRegion, unclosedOpeningAt, wrapMath } from "./math-region";

describe("mathRegionAtCaret", () => {
  it("finds the display formula the caret is inside", () => {
    const value = "Solve $$x^2$$ now";
    expect(mathRegionAtCaret(value, 8)).toMatchObject({ start: 8, end: 11, closed: true });
    expect(mathRegionAtCaret(value, 11)).toMatchObject({ start: 8, end: 11, closed: true });
    expect(mathRegionAtCaret(value, 8)?.delimiter.display).toBe(true);
  });

  it("finds an inline formula and reports it as inline", () => {
    const value = "Solve \\(x^2\\) now";
    const region = mathRegionAtCaret(value, 9);
    expect(region).toMatchObject({ start: 8, end: 11, closed: true });
    expect(region?.delimiter).toMatchObject({ open: "\\(", close: "\\)", display: false });
  });

  it("finds a display formula written with bracket delimiters", () => {
    const region = mathRegionAtCaret("A \\[x=1\\] B", 5);
    expect(region).toMatchObject({ start: 4, end: 7, closed: true });
    expect(region?.delimiter.display).toBe(true);
  });

  it("reports no formula when the caret is in the prose around it", () => {
    const value = "Solve $$x^2$$ now";
    expect(mathRegionAtCaret(value, 0)).toBeNull();
    expect(mathRegionAtCaret(value, 5)).toBeNull();
    expect(mathRegionAtCaret(value, 15)).toBeNull();
  });

  it("treats an unclosed opening as a formula running to the end", () => {
    expect(mathRegionAtCaret("Solve $$x^2", 11)).toMatchObject({
      start: 8,
      end: 11,
      closed: false,
    });
    expect(mathRegionAtCaret("Solve $$", 8)).toMatchObject({ start: 8, end: 8, closed: false });
    expect(mathRegionAtCaret("Solve \\(x", 9)).toMatchObject({ start: 8, end: 9, closed: false });
  });

  it("leaves prices alone", () => {
    // A lone dollar is never a delimiter, so a price cannot open a formula.
    expect(mathRegionAtCaret("Kits cost $12 to $20", 14)).toBeNull();
    expect(mathRegionAtCaret("The total is \\$12", 16)).toBeNull();
  });

  it("pairs delimiters left to right across several formulas", () => {
    const value = "$$a$$ and $$b$$";
    expect(mathRegionAtCaret(value, 3)).toMatchObject({ start: 2, end: 3, closed: true });
    expect(mathRegionAtCaret(value, 7)).toBeNull();
    expect(mathRegionAtCaret(value, 12)).toMatchObject({ start: 12, end: 13, closed: true });
  });

  it("ignores an escaped dollar pair", () => {
    expect(mathRegionAtCaret("Costs \\$$5", 9)).toBeNull();
  });
});

describe("unclosedOpeningAt", () => {
  it("reports the delimiter a fresh opening needs closing with", () => {
    expect(unclosedOpeningAt("Solve $$", 8)).toMatchObject({ open: "$$", close: "$$" });
    expect(unclosedOpeningAt("Solve \\(", 8)).toMatchObject({ open: "\\(", close: "\\)" });
    expect(unclosedOpeningAt("Solve \\[", 8)).toMatchObject({ open: "\\[", close: "\\]" });
  });

  it("reports nothing when the caret is not just past an opening", () => {
    expect(unclosedOpeningAt("Solve $$x", 9)).toBeNull();
    expect(unclosedOpeningAt("Solve $", 7)).toBeNull();
    expect(unclosedOpeningAt("", 0)).toBeNull();
  });

  it("reports nothing for the closing half of a pair", () => {
    expect(unclosedOpeningAt("$$x$$", 5)).toBeNull();
    expect(unclosedOpeningAt("\\(x\\)", 5)).toBeNull();
  });

  it("reports nothing for an escaped pair", () => {
    expect(unclosedOpeningAt("Costs \\$$", 9)).toBeNull();
  });
});

describe("replaceMathRegion", () => {
  it("writes new TeX into a closed formula and leaves the prose around it", () => {
    const value = "Solve $$x^2$$ now";
    const region = mathRegionAtCaret(value, 9);
    if (!region) throw new Error("The formula was not found.");
    const next = replaceMathRegion(value, region, "\\frac{1}{2}");
    expect(next.value).toBe("Solve $$\\frac{1}{2}$$ now");
    expect(next.region.end).toBe(8 + "\\frac{1}{2}".length);
  });

  it("keeps an inline formula inline", () => {
    const value = "Solve \\(x\\) now";
    const region = mathRegionAtCaret(value, 9);
    if (!region) throw new Error("The formula was not found.");
    expect(replaceMathRegion(value, region, "y^2").value).toBe("Solve \\(y^2\\) now");
  });

  it("fills an opening that nothing closes yet", () => {
    const value = "Solve $$";
    const region = mathRegionAtCaret(value, 8);
    if (!region) throw new Error("The opening was not found.");
    expect(replaceMathRegion(value, region, "x+1").value).toBe("Solve $$x+1");
  });

  it("round-trips through wrapMath", () => {
    const value = "A \\(x\\) B";
    const region = mathRegionAtCaret(value, 5);
    if (!region) throw new Error("The formula was not found.");
    expect(wrapMath("x", region.delimiter)).toBe("\\(x\\)");
  });
});

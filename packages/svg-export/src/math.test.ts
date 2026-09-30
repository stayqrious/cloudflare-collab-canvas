import type { BoardItem } from "@collab/protocol";
import { describe, expect, it } from "vitest";

import { type MathSvg, renderSvgItem, type TextMeasurer } from "./index.js";

/** Stands in for the browser: a proportional font where W is wide and i is narrow. */
const measureText: TextMeasurer = (text, fontSize) => {
  let width = 0;
  for (const character of text) {
    width += fontSize * (character === "W" ? 1.2 : character === "i" ? 0.25 : 0.5);
  }
  return width;
};

const ACTOR = "018f0000-0000-7000-8000-0000000000a1";

/** Stands in for MathJax: one recognizable box per expression, sized from the font. */
function fakeRenderer(seen: Array<{ tex: string; fontSize: number; display: boolean }> = []) {
  const renderMath = (tex: string, fontSize: number, display: boolean): MathSvg | undefined => {
    seen.push({ tex, fontSize, display });
    if (tex === "unrenderable") return undefined;
    return {
      svg: `<svg data-tex="${tex}"></svg>`,
      width: fontSize * 2,
      height: fontSize,
      baseline: fontSize * 0.75,
    };
  };
  return { renderMath, seen };
}

function textItem(text: string): Extract<BoardItem, { kind: "text" }> {
  return {
    id: "018f0000-0000-7000-8000-0000000000b1",
    kind: "text",
    z: 1,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "text", color: "#111111", fontSize: 20, fontFamily: "sans", opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 10, y: 40, text },
  };
}

function stickyItem(text: string): Extract<BoardItem, { kind: "sticky" }> {
  return {
    id: "018f0000-0000-7000-8000-0000000000b2",
    kind: "sticky",
    z: 1,
    version: 1,
    createdBy: ACTOR,
    style: { kind: "sticky", fill: "#ffe299", textColor: "#111111", fontSize: 20, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 400, height: 200, text },
  };
}

function zoneItem(title: string): Extract<BoardItem, { kind: "zone" }> {
  return {
    id: "018f0000-0000-7000-8000-0000000000b3",
    kind: "zone",
    z: 1,
    version: 1,
    createdBy: ACTOR,
    style: {
      kind: "zone",
      borderColor: "#d4d4d4",
      fill: "#a8daff",
      textColor: "#111111",
      fontSize: 18,
      opacity: 0.18,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 500, height: 300, title },
  };
}

function tableItem(cell: string): Extract<BoardItem, { kind: "table" }> {
  return {
    id: "018f0000-0000-7000-8000-0000000000b4",
    kind: "table",
    z: 1,
    version: 1,
    createdBy: ACTOR,
    style: {
      kind: "table",
      borderColor: "#d4d4d4",
      fill: "#ffffff",
      headerFill: "#d3bdff",
      textColor: "#111111",
      fontSize: 16,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, columnWidths: [200], rowHeights: [60], cells: [[cell]] },
  };
}

describe("exporting math", () => {
  it("writes the source when no typesetter is supplied, as the edge exporter has none", () => {
    const svg = renderSvgItem(textItem("Solve $$x^2=4$$ now"));
    expect(svg).toContain("Solve $$x^2=4$$ now");
    expect(svg).not.toContain("data-tex");
  });

  it("is byte-identical with and without a typesetter when there is no math", () => {
    const { renderMath } = fakeRenderer();
    for (const item of [textItem("no math"), stickyItem("no math"), zoneItem("Plain")]) {
      expect(renderSvgItem(item, { renderMath })).toBe(renderSvgItem(item));
    }
  });

  it("draws each formula and leaves the prose around it as text", () => {
    const { renderMath, seen } = fakeRenderer();
    const svg = renderSvgItem(textItem("Solve $$x^2=4$$ now"), { renderMath });

    expect(seen).toEqual([{ tex: "x^2=4", fontSize: 20, display: true }]);
    expect(svg).toContain('<svg data-tex="x^2=4"></svg>');
    expect(svg).toContain(">Solve </text>");
    expect(svg).toContain("> now</text>");
    // The source is gone: this is the whole point of the change.
    expect(svg).not.toContain("$$x^2=4$$");
    // Placed on the line's baseline, dropped by the formula's own baseline.
    expect(svg).toContain('transform="translate(');
    expect(svg).toContain('role="math"');
    expect(svg).toContain('aria-label="Formula: x^2=4"');
  });

  it("advances past a formula so the text after it does not overlap", () => {
    const { renderMath } = fakeRenderer();
    const svg = renderSvgItem(textItem("$$a$$ then"), { renderMath });
    const after = svg.match(/<text x="([\d.]+)"[^>]*> then<\/text>/u);
    if (!after) throw new Error("The trailing prose was not drawn.");
    // x = 10 (the item's x) + 40 (the formula's measured width at font size 20).
    expect(Number(after[1])).toBeCloseTo(50, 5);
  });

  it("places a formula where the measured prose actually ends", () => {
    const { renderMath } = fakeRenderer();
    // Four W at font size 20 measure 96, where a per-character estimate would claim 44.8.
    const svg = renderSvgItem(textItem("WWWW $$x$$"), { renderMath, measureText });
    const formula = svg.match(/translate\(([\d.]+) /u);
    if (!formula) throw new Error("The formula was not drawn.");
    // x = 10 + 96 for the four W plus 10 for the space that follows them.
    expect(Number(formula[1])).toBeCloseTo(116, 5);
  });

  it("falls back to an estimate when no measurer is supplied", () => {
    const { renderMath } = fakeRenderer();
    const svg = renderSvgItem(textItem("WWWW $$x$$"), { renderMath });
    const formula = svg.match(/translate\(([\d.]+) /u);
    if (!formula) throw new Error("The formula was not drawn.");
    // Five code points, "WWWW ", at 0.56 em of font size 20.
    expect(Number(formula[1])).toBeCloseTo(10 + 5 * 20 * 0.56, 5);
  });

  it("keeps a formula whole when a sticky note wraps around it", () => {
    const { renderMath } = fakeRenderer();
    // The words before it force a wrap; the formula must not be split across the break.
    const sticky = stickyItem("one two three four five six seven $$\\frac{1}{2}$$ after");
    const svg = renderSvgItem(sticky, { renderMath, measureText });
    expect(svg).toContain('<svg data-tex="\\frac{1}{2}"></svg>');
    expect(svg).not.toContain("$$");
    // Wrapping put the later words on a lower baseline than the first ones.
    const baselines = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)"/gu)].map((match) =>
      Number(match[1]),
    );
    expect(new Set(baselines).size).toBeGreaterThan(1);
  });

  it("draws a formula written across a newline", () => {
    const { renderMath } = fakeRenderer();
    // The delimiters sit on different lines, so per-line detection would miss this entirely.
    const svg = renderSvgItem(textItem("before $$a +\nb$$ after"), { renderMath, measureText });
    expect(svg).toContain('data-tex="a +\nb"');
    expect(svg).not.toContain("$$");
  });

  it("keeps the source visible when one expression cannot be typeset", () => {
    const { renderMath } = fakeRenderer();
    const svg = renderSvgItem(textItem("$$unrenderable$$ and $$a$$"), { renderMath });
    expect(svg).toContain("$$unrenderable$$");
    expect(svg).toContain('<svg data-tex="a"></svg>');
  });

  it("tells inline math from display math", () => {
    const { renderMath, seen } = fakeRenderer();
    renderSvgItem(textItem("\\(a\\) and \\[b\\] and $$c$$"), { renderMath });
    expect(seen).toEqual([
      { tex: "a", fontSize: 20, display: false },
      { tex: "b", fontSize: 20, display: true },
      { tex: "c", fontSize: 20, display: true },
    ]);
  });

  it("leaves an escaped delimiter as the dollars the participant typed", () => {
    const { renderMath, seen } = fakeRenderer();
    // MathJax is configured with processEscapes, so \$ is a literal dollar and the board shows
    // this whole line as text. A picture of it has to agree.
    const svg = renderSvgItem(textItem("Costs \\$$5$$ a kit"), { renderMath });
    expect(seen).toEqual([]);
    expect(svg).toContain("Costs \\$$5$$ a kit");
  });

  it("still reads a real formula after an escaped dollar", () => {
    const { renderMath, seen } = fakeRenderer();
    renderSvgItem(textItem("\\$5 a kit, so $$5n$$"), { renderMath });
    expect(seen).toEqual([{ tex: "5n", fontSize: 20, display: true }]);
  });

  it("pairs delimiters after an escape the way MathJax does", () => {
    const { renderMath, seen } = fakeRenderer();
    // Checked against MathJax itself in a browser, with this board's own configuration:
    // "Costs \$$5$$ then $$x$$" renders "Costs $$5", one formula, then "x$$". The escape
    // consumes one dollar, so the pair that opens is the one after it and the pair before x
    // closes it. Reading this any other way would put the picture at odds with the board.
    renderSvgItem(textItem("Costs \\$$5$$ then $$x$$"), { renderMath });
    expect(seen).toEqual([{ tex: " then ", fontSize: 20, display: true }]);
  });

  it("leaves a price alone", () => {
    const { renderMath, seen } = fakeRenderer();
    const svg = renderSvgItem(textItem("Kits cost $12 to $20 each"), { renderMath });
    expect(seen).toEqual([]);
    expect(svg).toContain("Kits cost $12 to $20 each");
  });

  it("draws math on sticky notes, Section titles, and table cells", () => {
    const sticky = fakeRenderer();
    expect(renderSvgItem(stickyItem("Try $$x+1$$"), { renderMath: sticky.renderMath })).toContain(
      '<svg data-tex="x+1"></svg>',
    );
    expect(sticky.seen[0]?.fontSize).toBe(20);

    const zone = fakeRenderer();
    expect(renderSvgItem(zoneItem("Prove $$n>0$$"), { renderMath: zone.renderMath })).toContain(
      '<svg data-tex="n>0"></svg>',
    );

    const table = fakeRenderer();
    const cell = renderSvgItem(tableItem("$$\\pi$$"), { renderMath: table.renderMath });
    expect(cell).toContain('<svg data-tex="\\pi"></svg>');
    // A drawn cell is still clipped to the cell box, as its text always was.
    expect(cell).toContain("clip-path=");
  });

  it("keeps every drawn surface clipped to its own box", () => {
    const { renderMath } = fakeRenderer();
    expect(renderSvgItem(stickyItem("Try $$x+1$$"), { renderMath })).toContain(
      'clip-path="url(#sticky-clip-018f0000-0000-7000-8000-0000000000b2)"',
    );
    expect(renderSvgItem(zoneItem("Prove $$n>0$$"), { renderMath })).toContain(
      'clip-path="url(#zone-title-clip-018f0000-0000-7000-8000-0000000000b3)"',
    );
  });
});

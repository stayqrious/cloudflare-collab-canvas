import { resolveTextFontWeight, textFontStack } from "@collab/protocol";
import type { SvgItemOptions, TextMeasurer } from "@collab/svg-export";

import { mathExpressionsIn, mathSvgRenderer, typesetMathSvg } from "../mathjax";
import type { BoardItem } from "../types";

/** Every place a board item holds text, with the size that text is drawn at. */
function textSurfaces(items: readonly BoardItem[]): Array<{ text: string; fontSize: number }> {
  const surfaces: Array<{ text: string; fontSize: number }> = [];
  for (const item of items) {
    if (item.kind === "text") {
      surfaces.push({ text: item.geometry.text, fontSize: item.style.fontSize });
    } else if (item.kind === "sticky") {
      surfaces.push({ text: item.geometry.text, fontSize: item.style.fontSize });
    } else if (item.kind === "zone") {
      surfaces.push({ text: item.geometry.title, fontSize: item.style.fontSize });
    } else if (item.kind === "table") {
      for (const row of item.geometry.cells) {
        for (const cell of row) surfaces.push({ text: cell, fontSize: item.style.fontSize });
      }
    }
  }
  return surfaces;
}

/**
 * Typesets every formula these items hold so a picture of them can draw math instead of writing
 * its source. A board with no formulas costs nothing, and a browser where MathJax will not load
 * falls back to the source rather than to a gap.
 */
export async function mathExportOptions(items: readonly BoardItem[]): Promise<SvgItemOptions> {
  const expressions = mathExpressionsIn(textSurfaces(items));
  if (expressions.length === 0) return {};
  const rendered = await typesetMathSvg(expressions);
  if (rendered.size === 0) return {};
  const measureText = browserTextMeasurer();
  return {
    renderMath: mathSvgRenderer(rendered),
    ...(measureText === undefined ? {} : { measureText }),
  };
}

/**
 * Measures prose with the browser's own font metrics, so a formula is placed where the words
 * before it actually end. A per-character estimate drifts badly on a proportional font: "WWWW"
 * and "iiii" are the same length and nothing like the same width.
 */
function browserTextMeasurer(): TextMeasurer | undefined {
  if (typeof document === "undefined") return undefined;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return undefined;
  const widths = new Map<string, number>();
  return (text, fontSize, style) => {
    const font = `${style.fontStyle ?? "normal"} ${resolveTextFontWeight(style.fontWeight, "normal")} ${fontSize}px ${textFontStack(style.fontFamily ?? "sans")}`;
    const key = `${font}\u0000${text}`;
    const cached = widths.get(key);
    if (cached !== undefined) return cached;
    context.font = font;
    const width = context.measureText(text).width;
    widths.set(key, width);
    return width;
  };
}

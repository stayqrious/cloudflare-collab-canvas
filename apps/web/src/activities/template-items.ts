import { DRAWING_COLOR_VALUES, STICKY_COLOR_VALUES, UI_COLORS } from "../palette";
import type { NewBoardItem, Point, TableStyle, TextFontFamily } from "../types";
import { VOTE_TABLE_STYLE } from "./voting";

export type ActivityTemplateItem = {
  [Kind in NewBoardItem["kind"]]: Omit<Extract<NewBoardItem, { kind: Kind }>, "id" | "transform">;
}[NewBoardItem["kind"]];

export const INK = UI_COLORS.ink;
export const MUTED = "#6f6d66";
export const OUTLINE = UI_COLORS.borderStrong;
export const DEFAULT_TABLE_STYLE: TableStyle = {
  kind: "table",
  borderColor: OUTLINE,
  fill: UI_COLORS.surface,
  headerFill: STICKY_COLOR_VALUES.lavender,
  textColor: INK,
  fontSize: 16,
  opacity: 1,
};

export function text(
  x: number,
  y: number,
  value: string,
  fontSize = 22,
  color: string = INK,
  fontFamily: TextFontFamily = "sans",
): ActivityTemplateItem {
  return {
    kind: "text",
    style: { kind: "text", color, fontSize, fontFamily, opacity: 1 },
    geometry: { x, y, text: value },
  };
}

export function outline(x: number, y: number, width: number, height: number): ActivityTemplateItem {
  return {
    kind: "rectangle",
    style: { kind: "stroke", color: OUTLINE, width: 3, opacity: 1 },
    geometry: { x, y, width, height, shape: "rectangle" },
  };
}

export function sticky(
  x: number,
  y: number,
  width: number,
  height: number,
  value: string,
  fill: string,
  fontSize = 20,
): ActivityTemplateItem {
  return {
    kind: "sticky",
    style: { kind: "sticky", fill, textColor: INK, fontSize, opacity: 1 },
    geometry: { x, y, width, height, text: value },
  };
}

export function table(
  x: number,
  y: number,
  columnWidths: number[],
  rowHeights: number[],
  cells: string[][],
  style: TableStyle = DEFAULT_TABLE_STYLE,
): ActivityTemplateItem {
  return {
    kind: "table",
    style: { ...style },
    geometry: { x, y, columnWidths, rowHeights, cells, headerRow: true },
  };
}

export function voteTable(
  x: number,
  y: number,
  columnWidths: number[],
  rowHeights: number[],
  cells: string[][],
): ActivityTemplateItem {
  return table(x, y, columnWidths, rowHeights, cells, VOTE_TABLE_STYLE);
}

export function pencil(
  points: readonly (readonly [number, number])[],
  color: string = INK,
  width = 3,
): ActivityTemplateItem {
  return {
    kind: "pencil",
    style: { kind: "stroke", color, width, opacity: 1 },
    geometry: { points: points.map(([x, y]) => [x, y] as Point) },
  };
}

export function zone(
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
): ActivityTemplateItem {
  return {
    kind: "zone",
    style: {
      kind: "zone",
      borderColor: OUTLINE,
      fill: STICKY_COLOR_VALUES.sky,
      textColor: INK,
      fontSize: 18,
      opacity: 0.18,
    },
    geometry: { x, y, width, height, title },
  };
}

export function stamp(
  x: number,
  y: number,
  kind: "star" | "check" | "heart" | "question" | "smile" | "sparkle" = "star",
  color: string = DRAWING_COLOR_VALUES.red,
): ActivityTemplateItem {
  return {
    kind: "stamp",
    style: { kind: "stamp", color, opacity: 1 },
    geometry: { x, y, size: 36, stamp: kind },
  };
}

/** A small deterministic generator, so a "random" layout is the same on every insert. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

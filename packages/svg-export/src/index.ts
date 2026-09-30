import {
  type Bounds,
  boundsForItems,
  boundsHeight,
  boundsWidth,
  expandBounds,
  formatCanonicalNumber,
  lineArrowheadPoints,
  polygonPoints,
  protractorPoint,
  splitTexSegments,
  transformBounds,
  unionBounds,
  visibleOutlinePaths,
  ZONE_TITLE_PADDING,
  zoneTitleBandHeight,
} from "@collab/geometry";
import {
  assertCanonicalId,
  type BoardItem,
  normalizeBoardItem,
  type Point,
  type ProtocolErrorCode,
  ProtocolValidationError,
  resolveTextFontWeight,
  type StickyStyle,
  type TableStyle,
  type TextStyle,
  textFontStack,
  utf8Bytes,
  validatePlainText,
  type ZoneStyle,
} from "@collab/protocol";

export const DEFAULT_SVG_PADDING = 24;

const STICKY_PADDING = 14;
const STICKY_CORNER_RADIUS = 12;
const STICKY_LINE_HEIGHT = 1.2;
const STICKY_CODE_POINT_WIDTH = 0.56;
const STICKY_WHITESPACE = /\s/u;

export const STAMP_SVG_PATHS = {
  star: "M12 2.5 14.9 8.6 21.5 9.5 16.7 14.1 17.9 20.7 12 17.5 6.1 20.7 7.3 14.1 2.5 9.5 9.1 8.6Z",
  heart: "M12 21S3 15.5 3 9.5C3 5 8.5 3 12 7c3.5-4 9-2 9 2.5C21 15.5 12 21 12 21Z",
  check: "M4 12.5 9.2 17.5 20 6.5",
  question: "M9.4 8.2a2.8 2.8 0 1 1 4.9 1.9c-.9.9-2.3 1.5-2.3 3.1",
  smileMouth: "M8 14.2c1.1 2 2.4 2.8 4 2.8s2.9-.8 4-2.8",
  sparkle:
    "M12 2 14.2 8.2 20.5 10.5 14.2 12.8 12 19 9.8 12.8 3.5 10.5 9.8 8.2Z M19 15.5 20 18 22.5 19 20 20 19 22.5 18 20 15.5 19 18 18Z",
} as const;

type StrokeBoardItem = Extract<
  BoardItem,
  { kind: "pencil" | "line" | "rectangle" | "ellipse" | "polygon" }
>;
type LineBoardItem = Extract<BoardItem, { kind: "line" }>;
type ProtractorBoardItem = Extract<BoardItem, { kind: "protractor" }>;
type StickyBoardItem = Extract<BoardItem, { kind: "sticky" }>;
type ImageBoardItem = Extract<BoardItem, { kind: "image" }>;
type StampBoardItem = Extract<BoardItem, { kind: "stamp" }>;
type TableBoardItem = Extract<BoardItem, { kind: "table" }>;
type ZoneBoardItem = Extract<BoardItem, { kind: "zone" }>;

export interface SvgExportInput {
  boardId: string;
  seq: number;
  items: readonly BoardItem[];
  title?: string;
  padding?: number;
}

export interface SvgExportResult {
  svg: string;
  bytes: Uint8Array;
  viewBox: Bounds;
  itemCount: number;
}

export class SvgExportError extends Error {
  constructor(
    readonly code: ProtocolErrorCode | "INVALID_EXPORT",
    message: string,
  ) {
    super(message);
    this.name = "SvgExportError";
  }
}

function exportFail(
  message: string,
  code: ProtocolErrorCode | "INVALID_EXPORT" = "INVALID_EXPORT",
): never {
  throw new SvgExportError(code, message);
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function number(value: number): string {
  try {
    return formatCanonicalNumber(value);
  } catch {
    exportFail("The export contains a non-finite calculated number.");
  }
}

function transformAttribute(item: BoardItem): string {
  return `matrix(${item.transform.map(number).join(" ")})`;
}

type TextBearingStyle = Pick<
  TextStyle | StickyStyle | TableStyle | ZoneStyle,
  "fontFamily" | "fontWeight" | "fontStyle" | "textDecoration"
>;

function typographyAttributes(style: TextBearingStyle, defaultWeight = "normal"): string {
  return [
    `font-family="${escapeXmlAttribute(textFontStack(style.fontFamily ?? "sans"))}"`,
    `font-weight="${resolveTextFontWeight(style.fontWeight, defaultWeight)}"`,
    `font-style="${style.fontStyle ?? "normal"}"`,
    `text-decoration="${style.textDecoration ?? "none"}"`,
  ].join(" ");
}

function commonStrokeAttributes(item: StrokeBoardItem): string {
  return [
    `fill="none"`,
    `stroke="${escapeXmlAttribute(item.style.color)}"`,
    `stroke-width="${number(item.style.width)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `stroke-linecap="round"`,
    `stroke-linejoin="round"`,
    `transform="${transformAttribute(item)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
  ].join(" ");
}

function outlinePathData(paths: readonly (readonly Point[])[]): string {
  return paths
    .map(([first, ...remaining]) => {
      if (first === undefined) exportFail("A canonical visible path must contain points.");
      return [
        `M ${number(first[0])} ${number(first[1])}`,
        ...remaining.map(([x, y]) => `L ${number(x)} ${number(y)}`),
      ].join(" ");
    })
    .join(" ");
}

function renderVisibleOutline(item: StrokeBoardItem): string {
  const paths = visibleOutlinePaths(item.kind, item.geometry);
  const subtype = item.kind === "rectangle" ? ` data-shape="${item.geometry.shape}"` : "";
  return `<path d="${outlinePathData(paths)}"${subtype} ${commonStrokeAttributes(item)} />`;
}

function renderLine(item: LineBoardItem): string {
  const { x1, y1, x2, y2 } = item.geometry;
  const attributes = commonStrokeAttributes(item);
  if (item.geometry.visiblePaths !== undefined) {
    const paths = visibleOutlinePaths("line", item.geometry);
    const shaft = outlinePathData(paths);
    const tipVisible = paths.some((path) => {
      const last = path.at(-1);
      return last?.[0] === x2 && last[1] === y2;
    });
    if (item.style.arrowhead === "none" || !tipVisible) {
      return `<path d="${shaft}" ${attributes} />`;
    }
    const arrowhead = lineArrowheadPoints(item.geometry, item.style.width);
    if (arrowhead === null) return `<path d="${shaft}" ${attributes} />`;
    const [left, tip, right] = arrowhead;
    const path = `${shaft} M ${number(left[0])} ${number(left[1])} L ${number(tip[0])} ${number(tip[1])} L ${number(right[0])} ${number(right[1])}`;
    return `<path d="${path}" ${attributes} />`;
  }
  if (item.style.arrowhead === "none") {
    return `<line x1="${number(x1)}" y1="${number(y1)}" x2="${number(x2)}" y2="${number(y2)}" ${attributes} />`;
  }
  const arrowhead = lineArrowheadPoints(item.geometry, item.style.width);
  if (arrowhead === null) {
    return `<line x1="${number(x1)}" y1="${number(y1)}" x2="${number(x2)}" y2="${number(y2)}" ${attributes} />`;
  }
  const [left, tip, right] = arrowhead;
  const path = [
    `M ${number(x1)} ${number(y1)} L ${number(x2)} ${number(y2)}`,
    `M ${number(left[0])} ${number(left[1])} L ${number(tip[0])} ${number(tip[1])} L ${number(right[0])} ${number(right[1])}`,
  ].join(" ");
  return `<path d="${path}" ${attributes} />`;
}

function codePointWidthAt(value: string, index: number): number {
  return (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

function isStickyWhitespaceAt(value: string, index: number): boolean {
  return STICKY_WHITESPACE.test(value[index] ?? "");
}

function isStickyLineBreakAt(value: string, index: number): boolean {
  const codeUnit = value.charCodeAt(index);
  return codeUnit === 0x0a || codeUnit === 0x0d;
}

interface StickyWordChunk {
  end: number;
  codePoints: number;
  hasMore: boolean;
}

function scanStickyWordChunk(value: string, start: number, maxCharacters: number): StickyWordChunk {
  let wordEnd = start;
  let wordCodePoints = 0;
  while (wordEnd < value.length && !isStickyWhitespaceAt(value, wordEnd)) {
    wordEnd += codePointWidthAt(value, wordEnd);
    wordCodePoints += 1;
  }
  if (/^https?:\/\/\S+$/iu.test(value.slice(start, wordEnd))) {
    return { end: wordEnd, codePoints: wordCodePoints, hasMore: false };
  }
  let end = start;
  let codePoints = 0;
  while (end < value.length && codePoints < maxCharacters && !isStickyWhitespaceAt(value, end)) {
    end += codePointWidthAt(value, end);
    codePoints += 1;
  }
  return {
    end,
    codePoints,
    hasMore: end < value.length && !isStickyWhitespaceAt(value, end),
  };
}

function appendStickyLine(lines: string[], line: string, maxLines: number): boolean {
  lines.push(line);
  return lines.length >= maxLines;
}

function appendStickyParagraphLines(
  value: string,
  start: number,
  maxCharacters: number,
  maxLines: number,
  lines: string[],
): number | null {
  let index = start;
  let sawWord = false;
  let currentWords: string[] = [];
  let currentCodePoints = 0;

  while (index < value.length && !isStickyLineBreakAt(value, index)) {
    while (
      index < value.length &&
      !isStickyLineBreakAt(value, index) &&
      isStickyWhitespaceAt(value, index)
    ) {
      index += codePointWidthAt(value, index);
    }
    if (index >= value.length || isStickyLineBreakAt(value, index)) break;

    sawWord = true;
    const wordStart = index;
    let chunk = scanStickyWordChunk(value, wordStart, maxCharacters);
    if (!chunk.hasMore) {
      const word = value.slice(wordStart, chunk.end);
      if (currentWords.length === 0) {
        currentWords.push(word);
        currentCodePoints = chunk.codePoints;
      } else if (currentCodePoints + 1 + chunk.codePoints <= maxCharacters) {
        currentWords.push(word);
        currentCodePoints += 1 + chunk.codePoints;
      } else {
        if (appendStickyLine(lines, currentWords.join(" "), maxLines)) return null;
        currentWords = [word];
        currentCodePoints = chunk.codePoints;
      }
      index = chunk.end;
      continue;
    }

    if (currentWords.length > 0) {
      if (appendStickyLine(lines, currentWords.join(" "), maxLines)) return null;
      currentWords = [];
      currentCodePoints = 0;
    }
    let chunkStart = wordStart;
    while (chunk.hasMore) {
      if (appendStickyLine(lines, value.slice(chunkStart, chunk.end), maxLines)) return null;
      chunkStart = chunk.end;
      chunk = scanStickyWordChunk(value, chunkStart, maxCharacters);
    }
    currentWords = [value.slice(chunkStart, chunk.end)];
    currentCodePoints = chunk.codePoints;
    index = chunk.end;
  }

  if (appendStickyLine(lines, sawWord ? currentWords.join(" ") : "", maxLines)) return null;
  if (index >= value.length) return value.length + 1;
  return value.charCodeAt(index) === 0x0d && value.charCodeAt(index + 1) === 0x0a
    ? index + 2
    : index + 1;
}

function stickyTextLines(item: StickyBoardItem): string[] {
  const contentWidth = Math.max(0, item.geometry.width - STICKY_PADDING * 2);
  const contentHeight = Math.max(0, item.geometry.height - STICKY_PADDING * 2);
  const maxCharacters = Math.max(
    1,
    Math.floor(contentWidth / (item.style.fontSize * STICKY_CODE_POINT_WIDTH)),
  );
  const maxLines = Math.max(
    1,
    Math.floor(contentHeight / (item.style.fontSize * STICKY_LINE_HEIGHT)),
  );
  const lines: string[] = [];
  let paragraphStart = 0;
  while (paragraphStart <= item.geometry.text.length && lines.length < maxLines) {
    const nextParagraph = appendStickyParagraphLines(
      item.geometry.text,
      paragraphStart,
      maxCharacters,
      maxLines,
      lines,
    );
    if (nextParagraph === null) break;
    paragraphStart = nextParagraph;
  }
  return lines;
}

function renderSticky(item: StickyBoardItem, options: SvgItemOptions = {}): string {
  const { x, y, width, height, text } = item.geometry;
  const clipId = `sticky-clip-${item.id}`;
  const attributes = [
    `transform="${transformAttribute(item)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
  ].join(" ");
  const rectangle = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="${number(STICKY_CORNER_RADIUS)}" fill="${escapeXmlAttribute(item.style.fill)}" />`;
  if (text.length === 0) return `<g ${attributes}>${rectangle}</g>`;

  const contentX = x + STICKY_PADDING;
  const contentY = y + STICKY_PADDING;
  const contentWidth = Math.max(0, width - STICKY_PADDING * 2);
  const contentHeight = Math.max(0, height - STICKY_PADDING * 2);
  const lineHeight = number(item.style.fontSize * STICKY_LINE_HEIGHT);
  const lines = stickyTextLines(item);
  const clipAttribute = `clip-path="url(#${escapeXmlAttribute(clipId)})"`;
  const mathText = renderBoxedMath(
    text,
    contentX,
    contentY + item.style.fontSize,
    contentWidth,
    item.style.fontSize,
    STICKY_LINE_HEIGHT,
    Math.max(1, Math.floor(contentHeight / (item.style.fontSize * STICKY_LINE_HEIGHT))),
    item.style.textColor,
    item.style,
    typographyAttributes(item.style),
    clipAttribute,
    options,
  );
  const spans = lines
    .map(
      (line, index) =>
        `<tspan x="${number(contentX)}" dy="${index === 0 ? "0" : lineHeight}">${escapeXmlText(line || " ")}</tspan>`,
    )
    .join("");
  const clip = `<defs><clipPath id="${escapeXmlAttribute(clipId)}" clipPathUnits="userSpaceOnUse"><rect x="${number(contentX)}" y="${number(contentY)}" width="${number(contentWidth)}" height="${number(contentHeight)}" /></clipPath></defs>`;
  const renderedText =
    mathText ??
    `<text x="${number(contentX)}" y="${number(contentY + item.style.fontSize)}" fill="${escapeXmlAttribute(item.style.textColor)}" font-size="${number(item.style.fontSize)}" ${typographyAttributes(item.style)} xml:space="preserve" ${clipAttribute}>${spans}</text>`;
  return `<g ${attributes}>${clip}${rectangle}${renderedText}</g>`;
}

function renderImagePlaceholder(item: ImageBoardItem): string {
  const { x, y, width, height, alt } = item.geometry;
  const radius = Math.min(item.style.radius, width / 2, height / 2);
  const inset = Math.min(width, height) * 0.2;
  const left = x + inset;
  const top = y + inset;
  const right = x + width - inset;
  const bottom = y + height - inset;
  const label = alt ?? "Image";
  const attributes = [
    `transform="${transformAttribute(item)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
    `data-export-placeholder="private-image"`,
    `role="img"`,
    `aria-label="${escapeXmlAttribute(label)}"`,
  ].join(" ");
  const rectangle = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="${number(radius)}" fill="#f1f5f9" stroke="#64748b" stroke-width="1" />`;
  const crossedFrame = `<path d="M ${number(left)} ${number(top)} L ${number(right)} ${number(bottom)} M ${number(right)} ${number(top)} L ${number(left)} ${number(bottom)}" fill="none" stroke="#64748b" stroke-width="1.5" stroke-linecap="round" />`;
  return `<g ${attributes}><title>${escapeXmlText(label)}</title>${rectangle}${crossedFrame}</g>`;
}

function renderStamp(item: StampBoardItem): string {
  const { x, y, size, stamp } = item.geometry;
  const color = escapeXmlAttribute(item.style.color);
  const symbolTransform = `translate(${number(x - size / 2)} ${number(y - size / 2)}) scale(${number(size / 24)})`;
  let symbol: string;
  switch (stamp) {
    case "star":
      symbol = `<path d="${STAMP_SVG_PATHS.star}" fill="${color}" />`;
      break;
    case "heart":
      symbol = `<path d="${STAMP_SVG_PATHS.heart}" fill="${color}" />`;
      break;
    case "check":
      symbol = `<path d="${STAMP_SVG_PATHS.check}" fill="none" stroke="${color}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" />`;
      break;
    case "question":
      symbol = `<path d="${STAMP_SVG_PATHS.question}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" /><circle cx="12" cy="17.6" r="1.2" fill="${color}" />`;
      break;
    case "smile":
      symbol = `<circle cx="12" cy="12" r="9" fill="none" stroke="${color}" stroke-width="2" /><circle cx="8.5" cy="10" r="1.2" fill="${color}" /><circle cx="15.5" cy="10" r="1.2" fill="${color}" /><path d="${STAMP_SVG_PATHS.smileMouth}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" />`;
      break;
    case "sparkle":
      symbol = `<path d="${STAMP_SVG_PATHS.sparkle}" fill="${color}" />`;
      break;
  }
  const attributes = [
    `transform="${transformAttribute(item)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
  ].join(" ");
  return `<g ${attributes}><g transform="${symbolTransform}">${symbol}</g></g>`;
}

const TABLE_CELL_PADDING = 8;
const TABLE_LINE_HEIGHT = 1.2;
const TABLE_CODE_POINT_WIDTH = 0.56;

function tableCellTextLines(
  text: string,
  width: number,
  height: number,
  fontSize: number,
): string[] {
  const contentWidth = width - TABLE_CELL_PADDING * 2;
  const contentHeight = height - TABLE_CELL_PADDING * 2;
  if (text.length === 0 || contentWidth <= 0 || contentHeight <= 0) return [];
  const maxCharacters = Math.max(1, Math.floor(contentWidth / (fontSize * TABLE_CODE_POINT_WIDTH)));
  const maxLines = Math.max(1, Math.floor(contentHeight / (fontSize * TABLE_LINE_HEIGHT)));
  const lines: string[] = [];
  let paragraphStart = 0;
  while (paragraphStart <= text.length && lines.length < maxLines) {
    const nextParagraph = appendStickyParagraphLines(
      text,
      paragraphStart,
      maxCharacters,
      maxLines,
      lines,
    );
    if (nextParagraph === null) break;
    paragraphStart = nextParagraph;
  }
  return lines;
}

function renderTable(item: TableBoardItem, options: SvgItemOptions = {}): string {
  const { x, y, columnWidths, rowHeights, cells, headerRow } = item.geometry;
  const attributes = [
    `transform="${transformAttribute(item)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
    `role="table"`,
  ].join(" ");
  const clips: string[] = [];
  const content: string[] = [];
  let cellY = y;
  for (let rowIndex = 0; rowIndex < rowHeights.length; rowIndex += 1) {
    const height = rowHeights[rowIndex];
    const row = cells[rowIndex];
    if (height === undefined || row === undefined) {
      exportFail("A canonical table must contain matching row heights and cells.");
    }
    let cellX = x;
    for (let columnIndex = 0; columnIndex < columnWidths.length; columnIndex += 1) {
      const width = columnWidths[columnIndex];
      const text = row[columnIndex];
      if (width === undefined || text === undefined) {
        exportFail("A canonical table must contain matching column widths and cells.");
      }
      const isHeader = headerRow === true && rowIndex === 0;
      const fill = isHeader ? item.style.headerFill : item.style.fill;
      const cellRole = isHeader ? "columnheader" : "cell";
      const rectangle = `<rect x="${number(cellX)}" y="${number(cellY)}" width="${number(width)}" height="${number(height)}" fill="${escapeXmlAttribute(fill)}" stroke="${escapeXmlAttribute(item.style.borderColor)}" stroke-width="1" />`;
      const textLines = tableCellTextLines(text, width, height, item.style.fontSize);
      let renderedText = "";
      if (textLines.length > 0) {
        const clipId = `table-clip-${item.id}-${rowIndex}-${columnIndex}`;
        const contentX = cellX + TABLE_CELL_PADDING;
        const contentY = cellY + TABLE_CELL_PADDING;
        const contentWidth = Math.max(0, width - TABLE_CELL_PADDING * 2);
        const contentHeight = Math.max(0, height - TABLE_CELL_PADDING * 2);
        clips.push(
          `<clipPath id="${escapeXmlAttribute(clipId)}" clipPathUnits="userSpaceOnUse"><rect x="${number(contentX)}" y="${number(contentY)}" width="${number(contentWidth)}" height="${number(contentHeight)}" /></clipPath>`,
        );
        const cellTypography = typographyAttributes(item.style, isHeader ? "700" : "500");
        const cellClip = `clip-path="url(#${escapeXmlAttribute(clipId)})"`;
        const cellMath = renderBoxedMath(
          text,
          contentX,
          contentY + item.style.fontSize,
          contentWidth,
          item.style.fontSize,
          TABLE_LINE_HEIGHT,
          Math.max(1, Math.floor(contentHeight / (item.style.fontSize * TABLE_LINE_HEIGHT))),
          item.style.textColor,
          item.style,
          cellTypography,
          cellClip,
          options,
        );
        if (cellMath !== null) {
          renderedText = cellMath;
        } else {
          const lineHeight = number(item.style.fontSize * TABLE_LINE_HEIGHT);
          const spans = textLines
            .map(
              (line, index) =>
                `<tspan x="${number(contentX)}" dy="${index === 0 ? "0" : lineHeight}">${escapeXmlText(line || " ")}</tspan>`,
            )
            .join("");
          renderedText = `<text x="${number(contentX)}" y="${number(contentY + item.style.fontSize)}" fill="${escapeXmlAttribute(item.style.textColor)}" font-size="${number(item.style.fontSize)}" ${cellTypography} xml:space="preserve" ${cellClip}>${spans}</text>`;
        }
      }
      content.push(
        `<g role="${cellRole}" aria-label="${escapeXmlAttribute(text)}">${rectangle}${renderedText}</g>`,
      );
      cellX += width;
    }
    cellY += height;
  }
  const definitions = clips.length === 0 ? "" : `<defs>${clips.join("")}</defs>`;
  return `<g ${attributes}>${definitions}${content.join("")}</g>`;
}

function renderZone(item: ZoneBoardItem, options: SvgItemOptions = {}): string {
  const { x, y, width, height, title } = item.geometry;
  const clipId = `zone-title-clip-${item.id}`;
  const titleBandHeight = Math.min(height, zoneTitleBandHeight(item.style.fontSize));
  const contentX = x + ZONE_TITLE_PADDING;
  const contentWidth = Math.max(0, width - ZONE_TITLE_PADDING * 2);
  const contentHeight = Math.max(0, titleBandHeight - ZONE_TITLE_PADDING);
  const visibleTitle = title.replace(/\r\n?|\n/gu, " ");
  const attributes = [
    `transform="${transformAttribute(item)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
    `role="group"`,
    `aria-label="Section: ${escapeXmlAttribute(title)}"`,
  ].join(" ");
  const clip = `<defs><clipPath id="${escapeXmlAttribute(clipId)}" clipPathUnits="userSpaceOnUse"><rect x="${number(contentX)}" y="${number(y)}" width="${number(contentWidth)}" height="${number(contentHeight)}" /></clipPath></defs>`;
  const fill = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="12" fill="${escapeXmlAttribute(item.style.fill)}" fill-opacity="${number(item.style.opacity)}" />`;
  const border = `<rect x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="12" fill="none" stroke="${escapeXmlAttribute(item.style.borderColor)}" stroke-width="1.5" vector-effect="non-scaling-stroke" />`;
  const titleClip = `clip-path="url(#${escapeXmlAttribute(clipId)})"`;
  const titleTypography = typographyAttributes(item.style, "700");
  const titleBaseline = y + ZONE_TITLE_PADDING + item.style.fontSize;
  const renderedTitle =
    renderBoxedMath(
      visibleTitle,
      contentX,
      titleBaseline,
      Number.POSITIVE_INFINITY,
      item.style.fontSize,
      1,
      1,
      item.style.textColor,
      item.style,
      titleTypography,
      titleClip,
      options,
    ) ??
    `<text x="${number(contentX)}" y="${number(titleBaseline)}" fill="${escapeXmlAttribute(item.style.textColor)}" font-size="${number(item.style.fontSize)}" ${titleTypography} xml:space="preserve" ${titleClip}>${escapeXmlText(visibleTitle)}</text>`;
  return `<g ${attributes}><title>${escapeXmlText(title)}</title>${clip}${fill}${border}${renderedTitle}</g>`;
}

function renderProtractor(item: ProtractorBoardItem): string {
  const { radius } = item.geometry;
  const color = escapeXmlAttribute(item.style.color);
  const outerPoints = Array.from({ length: 91 }, (_, index) =>
    protractorPoint(item.geometry, 180 - index * 2),
  );
  const arc = outlinePathData([outerPoints]);
  const silhouette = `${arc} L ${number(-radius)} 0 Z`;
  const ticks = Array.from({ length: 181 }, (_, degrees) => {
    const insetRatio = degrees % 10 === 0 ? 0.1 : degrees % 5 === 0 ? 0.065 : 0.035;
    const outer = protractorPoint(item.geometry, degrees);
    const inner = protractorPoint(item.geometry, degrees, radius * insetRatio);
    return `M ${number(outer[0])} ${number(outer[1])} L ${number(inner[0])} ${number(inner[1])}`;
  }).join(" ");
  const fontSize = Math.max(8, radius * 0.055);
  const labels = Array.from({ length: 19 }, (_, index) => index * 10)
    .map((degrees) => {
      const point = protractorPoint(item.geometry, degrees, radius * 0.18);
      return `<text x="${number(point[0])}" y="${number(point[1] + fontSize * 0.34)}" text-anchor="middle" fill="${color}" font-size="${number(fontSize)}" font-family="Inter, ui-sans-serif, system-ui, sans-serif">${degrees}</text>`;
    })
    .join("");
  const attributes = [
    `transform="${transformAttribute(item)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
    `role="img"`,
    `aria-label="180 degree protractor"`,
  ].join(" ");
  return `<g ${attributes}><title>180 degree protractor</title><path d="${silhouette}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" /><path d="M ${number(-radius)} 0 L ${number(radius)} 0 ${ticks}" fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round" vector-effect="non-scaling-stroke" />${labels}<circle cx="0" cy="0" r="3" fill="${color}" /></g>`;
}

/** One TeX expression typeset as a standalone SVG element, measured in board units. */
export interface MathSvg {
  /**
   * A complete `<svg>…</svg>` element, already sized in board units. It is inlined verbatim, so
   * only a typesetter that produces its own well-formed markup may supply it. The browser's
   * renderer serializes MathJax's own DOM output; nothing here ever carries board text through.
   */
  svg: string;
  width: number;
  height: number;
  /** Distance from the top of that box down to the surrounding text's baseline. */
  baseline: number;
}

/**
 * Typesets one TeX expression. Returning undefined leaves the expression as its source text, which
 * is what an exporter with no typesetter available does for every expression.
 */
export type MathSvgRenderer = (
  tex: string,
  fontSize: number,
  display: boolean,
) => MathSvg | undefined;

export interface SvgItemOptions {
  /**
   * Draws math instead of writing its source. Omit it and every text surface renders exactly as
   * it always has, which is what the edge exporter does: it has no typesetter.
   */
  renderMath?: MathSvgRenderer;
}

/** Used only when no measurer is supplied; matches what the plain-text wrappers already assume. */
const ESTIMATED_CODE_POINT_WIDTH = 0.56;

/**
 * Measures one run of prose in board units. The browser hands over real font metrics; without one
 * the estimate stands in, which is what an exporter with no layout engine has to do.
 */
export type TextMeasurer = (text: string, fontSize: number, style: TextBearingStyle) => number;

export interface SvgItemOptions {
  /**
   * Draws math instead of writing its source. Omit it and every text surface renders exactly as
   * it always has, which is what the edge exporter does: it has no typesetter.
   */
  renderMath?: MathSvgRenderer;
  /**
   * Measures prose so a formula can be placed after it. Without it the run width is estimated per
   * code point, which drifts on a proportional font.
   */
  measureText?: TextMeasurer;
}

/** One piece of a laid-out line: a run of prose, or one typeset formula. */
type LaidOutRun =
  | { kind: "text"; text: string; width: number }
  | { kind: "math"; tex: string; math: MathSvg };

type MathLayout = { lines: LaidOutRun[][]; holdsMath: boolean };

function runWidth(
  text: string,
  fontSize: number,
  style: TextBearingStyle,
  measure: TextMeasurer | undefined,
): number {
  if (measure) return measure(text, fontSize, style);
  return [...text].length * fontSize * ESTIMATED_CODE_POINT_WIDTH;
}

/**
 * Lays a whole text value out as lines of runs, keeping each formula whole. Splitting the value
 * first is what lets a formula wrap as one thing: wrapping the characters first would leave its
 * opening and closing delimiters on different lines, and neither line would read as maths.
 *
 * `maxWidth` of Infinity wraps only at explicit newlines, which is how a canvas text object
 * behaves; a sticky note or a table cell passes its content box instead.
 */
function layOutMath(
  value: string,
  fontSize: number,
  style: TextBearingStyle,
  maxWidth: number,
  maxLines: number,
  options: SvgItemOptions,
): MathLayout | null {
  const renderMath = options.renderMath;
  if (renderMath === undefined) return null;
  const segments = splitTexSegments(value);
  if (!segments.some((segment) => segment.kind === "math")) return null;

  const lines: LaidOutRun[][] = [[]];
  let used = 0;
  const current = (): LaidOutRun[] => lines[lines.length - 1] as LaidOutRun[];
  const newline = (): boolean => {
    if (lines.length >= maxLines) return false;
    lines.push([]);
    used = 0;
    return true;
  };
  const place = (run: LaidOutRun, width: number): boolean => {
    if (used > 0 && used + width > maxWidth && !newline()) return false;
    current().push(run);
    used += width;
    return true;
  };

  for (const segment of segments) {
    if (segment.kind === "math") {
      const math = renderMath(segment.tex, fontSize, segment.display);
      if (math === undefined) {
        // Better the source than a gap: a reader can still see what was written.
        if (!placeProse(segment.text, fontSize, style, options, place, newline)) break;
        continue;
      }
      if (!place({ kind: "math", tex: segment.tex, math }, math.width)) break;
      continue;
    }
    if (!placeProse(segment.text, fontSize, style, options, place, newline)) break;
  }
  return { lines, holdsMath: true };
}

/** Places prose word by word, breaking at explicit newlines and wrapping between words. */
function placeProse(
  text: string,
  fontSize: number,
  style: TextBearingStyle,
  options: SvgItemOptions,
  place: (run: LaidOutRun, width: number) => boolean,
  newline: () => boolean,
): boolean {
  const paragraphs = text.split(/\r\n?|\n/u);
  for (let index = 0; index < paragraphs.length; index += 1) {
    if (index > 0 && !newline()) return false;
    const paragraph = paragraphs[index] ?? "";
    if (paragraph.length === 0) continue;
    // Keep the spaces: they are what separates a formula from the word before it.
    for (const word of paragraph.split(/(?<=\s)/u)) {
      if (word.length === 0) continue;
      const width = runWidth(word, fontSize, style, options.measureText);
      if (!place({ kind: "text", text: word, width }, width)) return false;
    }
  }
  return true;
}

/** Draws laid-out lines, placing each formula on the baseline of the line it belongs to. */
function drawMathLayout(
  layout: MathLayout,
  x: number,
  firstBaseline: number,
  lineHeight: number,
  fontSize: number,
  fill: string,
  typography: string,
): string {
  const parts: string[] = [];
  layout.lines.forEach((runs, index) => {
    const baselineY = firstBaseline + index * lineHeight;
    let cursor = x;
    let prose = "";
    let proseStart = cursor;
    const flushProse = (): void => {
      if (prose.length === 0) return;
      parts.push(
        `<text x="${number(proseStart)}" y="${number(baselineY)}" fill="${escapeXmlAttribute(fill)}" font-size="${number(fontSize)}" ${typography} xml:space="preserve">${escapeXmlText(prose)}</text>`,
      );
      prose = "";
    };
    for (const run of runs) {
      if (run.kind === "text") {
        if (prose.length === 0) proseStart = cursor;
        prose += run.text;
        cursor += run.width;
        continue;
      }
      flushProse();
      parts.push(
        `<g transform="translate(${number(cursor)} ${number(baselineY - run.math.baseline)})" role="math" aria-label="${escapeXmlAttribute(`Formula: ${run.tex}`)}">${run.math.svg}</g>`,
      );
      cursor += run.math.width;
      proseStart = cursor;
    }
    flushProse();
  });
  return parts.join("");
}

function renderText(
  item: Extract<BoardItem, { kind: "text" }>,
  options: SvgItemOptions = {},
): string {
  const lines = item.geometry.text.split(/\r\n?|\n/u);
  const mathContent = renderTextMath(item, options);
  if (mathContent !== null) return mathContent;
  const attributes = [
    `x="${number(item.geometry.x)}"`,
    `y="${number(item.geometry.y)}"`,
    `fill="${escapeXmlAttribute(item.style.color)}"`,
    `font-size="${number(item.style.fontSize)}"`,
    `opacity="${number(item.style.opacity)}"`,
    `transform="${transformAttribute(item)}"`,
    `data-item-id="${escapeXmlAttribute(item.id)}"`,
    typographyAttributes(item.style),
    `xml:space="preserve"`,
  ].join(" ");
  if (lines.length === 1) return `<text ${attributes}>${escapeXmlText(lines[0] ?? "")}</text>`;
  const lineHeight = number(item.style.fontSize * 1.2);
  const content = lines
    .map((line, index) => {
      const dy = index === 0 ? "0" : lineHeight;
      return `<tspan x="${number(item.geometry.x)}" dy="${dy}">${escapeXmlText(line)}</tspan>`;
    })
    .join("");
  return `<text ${attributes}>${content}</text>`;
}

/**
 * Draws a boxed surface (a sticky note, a table cell, a Section title) holding math, wrapped to
 * its own content box and clipped like the plain-text form it replaces. Returns null when the
 * surface holds no math, so every math-free surface keeps the markup it has always produced.
 */
function renderBoxedMath(
  value: string,
  x: number,
  firstBaseline: number,
  contentWidth: number,
  fontSize: number,
  lineHeightRatio: number,
  maxLines: number,
  fill: string,
  style: TextBearingStyle,
  typography: string,
  clipAttribute: string,
  options: SvgItemOptions,
): string | null {
  const layout = layOutMath(value, fontSize, style, contentWidth, maxLines, options);
  if (layout === null) return null;
  const content = drawMathLayout(
    layout,
    x,
    firstBaseline,
    fontSize * lineHeightRatio,
    fontSize,
    fill,
    typography,
  );
  return `<g ${clipAttribute}>${content}</g>`;
}

/** Draws a canvas text object holding math. Returns null when it holds none. */
function renderTextMath(
  item: Extract<BoardItem, { kind: "text" }>,
  options: SvgItemOptions,
): string | null {
  const lineHeight = item.style.fontSize * 1.2;
  // A canvas text object grows rather than wraps, so only its own newlines break a line.
  const layout = layOutMath(
    item.geometry.text,
    item.style.fontSize,
    item.style,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    options,
  );
  if (layout === null) return null;
  const content = drawMathLayout(
    layout,
    item.geometry.x,
    item.geometry.y,
    lineHeight,
    item.style.fontSize,
    item.style.color,
    typographyAttributes(item.style),
  );
  return `<g opacity="${number(item.style.opacity)}" transform="${transformAttribute(item)}" data-item-id="${escapeXmlAttribute(item.id)}">${content}</g>`;
}

export function renderSvgItem(item: BoardItem, options: SvgItemOptions = {}): string {
  switch (item.kind) {
    case "pencil": {
      return renderVisibleOutline(item);
    }
    case "line":
      return renderLine(item);
    case "rectangle":
      if (item.geometry.visiblePaths !== undefined) return renderVisibleOutline(item);
      return `<rect x="${number(item.geometry.x)}" y="${number(item.geometry.y)}" width="${number(item.geometry.width)}" height="${number(item.geometry.height)}" data-shape="${item.geometry.shape}" ${commonStrokeAttributes(item)} />`;
    case "ellipse":
      if (item.geometry.visiblePaths !== undefined) return renderVisibleOutline(item);
      return `<ellipse cx="${number(item.geometry.x + item.geometry.width / 2)}" cy="${number(item.geometry.y + item.geometry.height / 2)}" rx="${number(item.geometry.width / 2)}" ry="${number(item.geometry.height / 2)}" ${commonStrokeAttributes(item)} />`;
    case "polygon":
      if (item.geometry.visiblePaths !== undefined) return renderVisibleOutline(item);
      return `<polygon points="${polygonPoints(item.geometry)
        .map(([x, y]) => `${number(x)},${number(y)}`)
        .join(" ")}" ${commonStrokeAttributes(item)} />`;
    case "protractor":
      return renderProtractor(item);
    case "text":
      return renderText(item, options);
    case "sticky":
      return renderSticky(item, options);
    case "image":
      return renderImagePlaceholder(item);
    case "stamp":
      return renderStamp(item);
    case "table":
      return renderTable(item, options);
    case "zone":
      return renderZone(item, options);
  }
}

function normalizePadding(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    exportFail("SVG padding must be a finite number between 0 and 1,000,000.");
  }
  return value;
}

function ensureNonDegenerate(bounds: Bounds): Bounds {
  let { minX, minY, maxX, maxY } = bounds;
  if (maxX === minX) {
    minX -= 0.5;
    maxX += 0.5;
  }
  if (maxY === minY) {
    minY -= 0.5;
    maxY += 0.5;
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
    exportFail("The calculated SVG viewBox is not finite.");
  }
  return { minX, minY, maxX, maxY };
}

function rawExportTextBounds(item: Extract<BoardItem, { kind: "text" }>): Bounds {
  const lines = item.geometry.text.split(/\r\n?|\n/u);
  const lineHeight = item.style.fontSize * 1.2;
  const width = Math.max(
    ...lines.map((line) => Array.from(line).length * item.style.fontSize * 0.6),
  );
  return transformBounds(
    {
      minX: item.geometry.x,
      minY: item.geometry.y - item.style.fontSize,
      maxX: item.geometry.x + width,
      maxY: item.geometry.y - item.style.fontSize + Math.max(1, lines.length) * lineHeight,
    },
    item.transform,
  );
}

/** Bounds the exact fallback representation emitted by renderSvgItem. */
export function boundsForSvgItems(items: readonly BoardItem[]): Bounds | null {
  let contentBounds = boundsForItems(items);
  if (contentBounds === null) return null;
  for (const item of items) {
    if (item.kind === "text") {
      contentBounds = unionBounds(contentBounds, rawExportTextBounds(item));
    }
  }
  return contentBounds;
}

function calculateViewBox(items: readonly BoardItem[], padding: number): Bounds {
  const contentBounds = boundsForSvgItems(items);
  if (contentBounds === null) return { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  return ensureNonDegenerate(expandBounds(contentBounds, padding));
}

export function createSvgExport(input: SvgExportInput): SvgExportResult {
  let boardId: string;
  try {
    boardId = assertCanonicalId(input.boardId, "$export.boardId");
  } catch (error) {
    if (error instanceof ProtocolValidationError)
      throw new SvgExportError(error.code, error.message);
    throw error;
  }
  if (!Number.isSafeInteger(input.seq) || input.seq < 0) {
    exportFail("SVG sequence must be a non-negative safe integer.");
  }
  if (!Array.isArray(input.items)) exportFail("SVG items must be an array.");
  const padding = normalizePadding(input.padding ?? DEFAULT_SVG_PADDING);
  const items = input.items
    .map((item) => {
      try {
        return normalizeBoardItem(item);
      } catch (error) {
        if (error instanceof ProtocolValidationError)
          throw new SvgExportError(error.code, error.message);
        throw error;
      }
    })
    .sort((left, right) => left.z - right.z || left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) exportFail(`The export contains duplicate item ID ${item.id}.`);
    ids.add(item.id);
  }

  let title: string | undefined;
  if (input.title !== undefined) {
    try {
      title = validatePlainText(input.title, "$export.title");
    } catch (error) {
      if (error instanceof ProtocolValidationError)
        throw new SvgExportError(error.code, error.message);
      throw error;
    }
  }
  const viewBox = calculateViewBox(items, padding);
  const metadata = JSON.stringify({
    format: "cf-whiteboard-svg",
    version: 1,
    boardId,
    seq: input.seq,
  });
  const markup = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${number(viewBox.minX)} ${number(viewBox.minY)} ${number(boundsWidth(viewBox))} ${number(boundsHeight(viewBox))}" data-format="cf-whiteboard-svg" data-version="1" data-seq="${input.seq}">`,
    `<metadata>${escapeXmlText(metadata)}</metadata>`,
    ...(title === undefined ? [] : [`<title>${escapeXmlText(title)}</title>`]),
    `<g data-layer="drawing">`,
    ...items.map((item) => renderSvgItem(item)),
    `</g>`,
    `</svg>`,
  ].join("\n");
  return { svg: markup, bytes: utf8Bytes(markup), viewBox, itemCount: items.length };
}

export function serializeSvg(input: SvgExportInput): string {
  return createSvgExport(input).svg;
}

export function svgExportBytes(input: SvgExportInput): Uint8Array {
  return createSvgExport(input).bytes;
}

export function svgDownloadHeaders(filename = "whiteboard.svg"): Readonly<Record<string, string>> {
  const safeFilename =
    filename.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "") || "whiteboard.svg";
  return {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Content-Disposition": `attachment; filename="${safeFilename}"`,
  };
}

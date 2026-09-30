import { boundsForItems, boundsHeight, boundsWidth } from "@collab/geometry";
import { normalizeBoardItem } from "@collab/protocol";
import { renderSvgItem, type SvgItemOptions } from "@collab/svg-export";
import { mathExportOptions } from "../board/math-export";
import type { BoardItem } from "../types";

export function visualAlias(index: number): string {
  return `visual_${index + 1}`;
}

export function serializeVisualPreview(
  items: readonly BoardItem[],
  options: SvgItemOptions = {},
): {
  viewBox: string;
  ariaLabel: string;
  content: string;
} {
  if (items.length === 0) throw new Error("A visual preview needs at least one item.");
  const sanitized = items
    .map((item, index) => {
      const normalized = normalizeBoardItem(item);
      const sanitized = {
        ...normalized,
        id: visualAlias(index),
        createdBy: "shared-visual",
      };
      return sanitized.kind === "image"
        ? {
            ...sanitized,
            geometry: { ...sanitized.geometry, alt: "Private image not shared" },
          }
        : sanitized;
    })
    .sort((left, right) => left.z - right.z);
  const bounds = boundsForItems(sanitized);
  if (bounds === null) throw new Error("The selected visual has no renderable bounds.");
  const width = Math.max(1, boundsWidth(bounds));
  const height = Math.max(1, boundsHeight(bounds));
  const padding = Math.max(18, Math.min(72, Math.min(width, height) * 0.08));
  const minX = bounds.minX - padding;
  const minY = bounds.minY - padding;
  const viewWidth = width + padding * 2;
  const viewHeight = height + padding * 2;
  return {
    viewBox: `${minX} ${minY} ${viewWidth} ${viewHeight}`,
    ariaLabel: `Board visual containing ${items.length} browser-selected item${items.length === 1 ? "" : "s"}`,
    content: `<rect x="${minX}" y="${minY}" width="${viewWidth}" height="${viewHeight}" fill="#ffffff"/>${sanitized.map((item) => renderSvgItem(item, options)).join("")}`,
  };
}

/** Longest edge of a captured board image. Bounds the base64 a tool result has to carry. */
const MAX_IMAGE_EDGE = 1_280;
/**
 * Ceiling on the encoded PNG. A board of dense handwriting can rasterize large, and a tool
 * result that a host refuses to read is worse than one without a picture, so an oversized
 * capture is dropped rather than sent.
 */
const MAX_IMAGE_DATA_URL_LENGTH = 3_000_000;

export type BoardImage = {
  /** A PNG data URL of the objects, ready to display. */
  pngDataUrl: string;
  width: number;
  height: number;
  itemCount: number;
};

/** True when a board holds work that has to be seen rather than read. */
export function hasVisualContent(items: readonly BoardItem[]): boolean {
  return items.some(
    (item) =>
      item.kind === "pencil" ||
      item.kind === "image" ||
      item.kind === "line" ||
      item.kind === "rectangle" ||
      item.kind === "ellipse" ||
      item.kind === "polygon" ||
      item.kind === "stamp" ||
      item.kind === "protractor" ||
      (item.kind === "text" && item.geometry.embed === "video"),
  );
}

/**
 * Rasterizes saved board objects to a PNG so a host can see handwriting and sketches instead of
 * reading a description of them. Uses the same selected-only serializer the visual inspector
 * does, so private image assets stay placeholders rather than pixels.
 */
export async function captureBoardImage(
  items: readonly BoardItem[],
): Promise<BoardImage | undefined> {
  if (items.length === 0) return undefined;
  if (typeof document === "undefined" || typeof Image === "undefined") return undefined;

  let preview: ReturnType<typeof serializeVisualPreview>;
  try {
    // A picture of a board must show its formulas, not their source: an assistant reading the
    // picture is exactly the reader who cannot fall back to the text.
    preview = serializeVisualPreview(items, await mathExportOptions(items));
  } catch {
    return undefined;
  }
  const [, , viewWidth = 0, viewHeight = 0] = preview.viewBox.split(" ").map(Number);
  if (!(viewWidth > 0) || !(viewHeight > 0)) return undefined;

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(viewWidth, viewHeight));
  const width = Math.max(1, Math.round(viewWidth * scale));
  const height = Math.max(1, Math.round(viewHeight * scale));
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${preview.viewBox}" role="img" aria-label="${preview.ariaLabel}">${preview.content}</svg>`;
  const objectUrl = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml" }));

  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const pngDataUrl = canvas.toDataURL("image/png");
    if (pngDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) return undefined;
    return { pngDataUrl, width, height, itemCount: items.length };
  } catch {
    return undefined;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

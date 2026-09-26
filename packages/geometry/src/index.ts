export const COORDINATE_LIMIT = 1_000_000;
export const DIMENSION_LIMIT = 2_000_000;
export const TRANSFORM_LINEAR_COMPONENT_LIMIT = COORDINATE_LIMIT;
export const WORLD_COORDINATE_LIMIT = DIMENSION_LIMIT;
export const MAX_PENCIL_POINTS = 10_000;
export const MIN_PENCIL_POINTS = 2;
export const MAX_VISIBLE_PATHS = 256;
export const MAX_VISIBLE_PATH_POINTS = 10_000;
export const MIN_VISIBLE_PATH_POINTS = 2;
export const ELLIPSE_OUTLINE_SEGMENTS = 96;
export const PROTRACTOR_SNAP_STEP_DEGREES = 5;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_IMAGE_ALT_CODE_POINTS = 500;
export const MAX_IMAGE_INTRINSIC_DIMENSION = 4_096;
export const MAX_IMAGE_INTRINSIC_PIXELS = 16_000_000;
export const MAX_TABLE_COLUMNS = 6;
export const MAX_TABLE_ROWS = 8;
export const LINE_ARROWHEAD_MIN_LENGTH = 10;
export const LINE_ARROWHEAD_MAX_LENGTH = 32;
export const LINE_ARROWHEAD_WIDTH_RATIO = 0.45;
export const ZONE_TITLE_PADDING = 12;
export const ZONE_BORDER_HIT_WIDTH = 6;

const IMAGE_ASSET_ID_PATTERN = /^asset_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

export type Point = readonly [number, number];
export type Transform = [number, number, number, number, number, number];

export interface PencilGeometry {
  points: Point[];
  visiblePaths?: VisiblePaths;
}

export interface LineGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  visiblePaths?: VisiblePaths;
}

export interface BoxGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VisiblePaths = Point[][];

export interface OutlineBoxGeometry extends BoxGeometry {
  visiblePaths?: VisiblePaths;
}

export const RECTANGLE_KINDS = ["rectangle", "square"] as const;
export type RectangleKind = (typeof RECTANGLE_KINDS)[number];

export interface RectangleGeometry extends OutlineBoxGeometry {
  shape: RectangleKind;
}

export const POLYGON_KINDS = ["triangle", "rhombus", "pentagon", "hexagon"] as const;
export type PolygonKind = (typeof POLYGON_KINDS)[number];

export interface PolygonGeometry extends OutlineBoxGeometry {
  polygon: PolygonKind;
}

export interface ProtractorGeometry {
  radius: number;
}

export interface TextGeometry {
  x: number;
  y: number;
  text: string;
  embed?: "video";
}

export const VIDEO_EMBED_WIDTH = 360;
export const VIDEO_EMBED_HEIGHT = 232;

export interface VideoEmbedReference {
  provider: "youtube" | "vimeo";
  videoId: string;
  sourceUrl: string;
  vimeoHash?: string;
}

/** Parses the complete HTTPS video URLs supported by every render and validation surface. */
export function parseVideoEmbedReference(value: string): VideoEmbedReference | null {
  const candidate = value.trim();
  if (!candidate || /\s/u.test(candidate)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be" || host === "www.youtu.be") {
    return youtubeVideoReference(parsed.pathname.split("/").filter(Boolean)[0], parsed.href);
  }
  if (
    host === "youtube.com" ||
    host === "www.youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "www.youtube-nocookie.com"
  ) {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const videoId =
      parsed.pathname === "/watch"
        ? parsed.searchParams.get("v")
        : parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live"
          ? parts[1]
          : null;
    return youtubeVideoReference(videoId, parsed.href);
  }
  if (host === "vimeo.com" || host === "www.vimeo.com" || host === "player.vimeo.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const playerUrl = host === "player.vimeo.com";
    const videoId =
      playerUrl && parts[0] === "video" && parts.length === 2
        ? parts[1]
        : !playerUrl && parts.length >= 1 && parts.length <= 2
          ? parts[0]
          : null;
    if (!videoId || !/^\d{5,12}$/u.test(videoId)) return null;
    const pathHash = !playerUrl && parts.length === 2 ? parts[1] : undefined;
    // A present "h" always yields a string, so an empty ?h= stays defined and is rejected
    // below by the hash pattern rather than silently falling back to the path hash.
    const queryHash = parsed.searchParams.get("h") ?? undefined;
    if (pathHash !== undefined && queryHash !== undefined && pathHash !== queryHash) {
      return null;
    }
    const vimeoHash = queryHash ?? pathHash;
    if (vimeoHash !== undefined && !/^[A-Za-z0-9_-]{6,64}$/u.test(vimeoHash)) return null;
    return {
      provider: "vimeo",
      videoId,
      sourceUrl: parsed.href,
      ...(vimeoHash === undefined ? {} : { vimeoHash }),
    };
  }
  return null;
}

function youtubeVideoReference(
  videoId: string | null | undefined,
  sourceUrl: string,
): VideoEmbedReference | null {
  if (!videoId || !/^[A-Za-z0-9_-]{6,15}$/u.test(videoId)) return null;
  return { provider: "youtube", videoId, sourceUrl };
}

export interface StickyGeometry extends BoxGeometry {
  text: string;
}

export interface ZoneGeometry extends BoxGeometry {
  title: string;
  locked?: boolean;
}

export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export interface ImageGeometry extends BoxGeometry {
  assetId: string;
  alt?: string;
  mimeType: ImageMimeType;
  intrinsicWidth: number;
  intrinsicHeight: number;
}

export const STAMP_KINDS = ["star", "check", "heart", "question", "smile", "sparkle"] as const;
export type StampKind = (typeof STAMP_KINDS)[number];

export interface StampGeometry {
  x: number;
  y: number;
  size: number;
  stamp: StampKind;
}

export interface TableGeometry {
  x: number;
  y: number;
  columnWidths: number[];
  rowHeights: number[];
  cells: string[][];
  headerRow?: boolean;
}

export type ItemGeometry =
  | PencilGeometry
  | LineGeometry
  | BoxGeometry
  | OutlineBoxGeometry
  | RectangleGeometry
  | PolygonGeometry
  | ProtractorGeometry
  | TextGeometry
  | StickyGeometry
  | ZoneGeometry
  | ImageGeometry
  | StampGeometry
  | TableGeometry;

export type GeometryKind =
  | "pencil"
  | "line"
  | "rectangle"
  | "ellipse"
  | "polygon"
  | "protractor"
  | "text"
  | "sticky"
  | "zone"
  | "image"
  | "stamp"
  | "table";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BoundsItem {
  kind: GeometryKind;
  geometry: ItemGeometry;
  transform: Transform;
  style:
    | { kind: "stroke"; width: number }
    | { kind: "line"; width: number; arrowhead: "none" | "arrow" }
    | { kind: "protractor" }
    | { kind: "text"; fontSize: number }
    | { kind: "sticky"; fontSize: number }
    | { kind: "zone"; fontSize: number }
    | { kind: "image" }
    | { kind: "stamp" }
    | { kind: "table"; fontSize: number };
}

export class GeometryValidationError extends Error {
  readonly code = "INVALID_GEOMETRY" as const;

  constructor(
    readonly reason: string,
    readonly path = "$",
  ) {
    super(path === "$" ? reason : `${reason} at ${path}`);
    this.name = "GeometryValidationError";
  }
}

const own = Object.prototype.hasOwnProperty;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GeometryValidationError("Expected an object", path);
  }
  return value;
}

function expectOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new GeometryValidationError(`Unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
  for (const key of allowed) {
    if (!own.call(value, key)) {
      throw new GeometryValidationError(`Missing field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
}

function expectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowedSet = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new GeometryValidationError(`Unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!own.call(value, key)) {
      throw new GeometryValidationError(`Missing field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
}

export function canonicalNumber(value: number, decimalPlaces: number): number {
  if (!Number.isFinite(value)) {
    throw new GeometryValidationError("Expected a finite number");
  }
  const scale = 10 ** decimalPlaces;
  const magnitude = Math.abs(value);
  const scaled = (magnitude + Number.EPSILON * Math.max(1, magnitude) * 2) * scale;
  const roundedMagnitude = Number.isFinite(scaled) ? Math.round(scaled) / scale : magnitude;
  // Decimal ties round away from zero. This avoids the surprising asymmetry of
  // Math.round for negative halves and gives one canonical policy everywhere.
  const rounded = Math.sign(value) * roundedMagnitude;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function normalizeCoordinate(value: unknown, path = "$", decimalPlaces = 2): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GeometryValidationError("Expected a finite coordinate", path);
  }
  const normalized = canonicalNumber(value, decimalPlaces);
  if (Math.abs(normalized) > COORDINATE_LIMIT) {
    throw new GeometryValidationError(
      `Coordinate must be between -${COORDINATE_LIMIT} and ${COORDINATE_LIMIT}`,
      path,
    );
  }
  return normalized;
}

export function normalizeDimension(value: unknown, path = "$", decimalPlaces = 2): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GeometryValidationError("Expected a finite dimension", path);
  }
  const normalized = canonicalNumber(value, decimalPlaces);
  if (normalized < 0 || normalized > DIMENSION_LIMIT) {
    throw new GeometryValidationError(`Dimension must be between 0 and ${DIMENSION_LIMIT}`, path);
  }
  return normalized;
}

export function normalizePoint(value: unknown, path = "$point"): Point {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new GeometryValidationError("Expected a two-coordinate point", path);
  }
  return [normalizeCoordinate(value[0], `${path}[0]`), normalizeCoordinate(value[1], `${path}[1]`)];
}

export function normalizeTransform(value: unknown, path = "$transform"): Transform {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new GeometryValidationError("Expected a six-component affine transform", path);
  }
  const normalizeLinearComponent = (component: unknown, index: number): number => {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new GeometryValidationError(
        "Expected a finite transform component",
        `${path}[${index}]`,
      );
    }
    const normalized = canonicalNumber(component, 6);
    if (Math.abs(normalized) > TRANSFORM_LINEAR_COMPONENT_LIMIT) {
      throw new GeometryValidationError(
        `Transform component must be between -${TRANSFORM_LINEAR_COMPONENT_LIMIT} and ${TRANSFORM_LINEAR_COMPONENT_LIMIT}`,
        `${path}[${index}]`,
      );
    }
    return normalized;
  };
  return [
    normalizeLinearComponent(value[0], 0),
    normalizeLinearComponent(value[1], 1),
    normalizeLinearComponent(value[2], 2),
    normalizeLinearComponent(value[3], 3),
    normalizeCoordinate(value[4], `${path}[4]`),
    normalizeCoordinate(value[5], `${path}[5]`),
  ];
}

export function normalizeVisiblePaths(
  value: unknown,
  path = "$geometry.visiblePaths",
): VisiblePaths {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_VISIBLE_PATHS) {
    throw new GeometryValidationError(
      `Visible paths must contain between 1 and ${MAX_VISIBLE_PATHS} paths`,
      path,
    );
  }
  let totalPoints = 0;
  return value.map((rawPath, pathIndex) => {
    const pathLocation = `${path}[${pathIndex}]`;
    if (!Array.isArray(rawPath)) {
      throw new GeometryValidationError("Expected an array of points", pathLocation);
    }
    const points: Point[] = [];
    for (let pointIndex = 0; pointIndex < rawPath.length; pointIndex += 1) {
      const point = normalizePoint(rawPath[pointIndex], `${pathLocation}[${pointIndex}]`);
      const previous = points.at(-1);
      if (previous === undefined || previous[0] !== point[0] || previous[1] !== point[1]) {
        points.push(point);
        totalPoints += 1;
        if (totalPoints > MAX_VISIBLE_PATH_POINTS) {
          throw new GeometryValidationError(
            `Visible paths may contain at most ${MAX_VISIBLE_PATH_POINTS} points`,
            path,
          );
        }
      }
    }
    if (points.length < MIN_VISIBLE_PATH_POINTS) {
      throw new GeometryValidationError(
        `Each visible path requires at least ${MIN_VISIBLE_PATH_POINTS} distinct adjacent points`,
        pathLocation,
      );
    }
    return points;
  });
}

export function normalizePencilGeometry(value: unknown, path = "$geometry"): PencilGeometry {
  const object = expectRecord(value, path);
  expectKeys(object, ["points"], ["visiblePaths"], path);
  if (!Array.isArray(object.points)) {
    throw new GeometryValidationError("Expected an array of points", `${path}.points`);
  }

  const points: Point[] = [];
  for (let index = 0; index < object.points.length; index += 1) {
    const point = normalizePoint(object.points[index], `${path}.points[${index}]`);
    const previous = points.at(-1);
    if (previous === undefined || previous[0] !== point[0] || previous[1] !== point[1]) {
      points.push(point);
      if (points.length > MAX_PENCIL_POINTS) {
        throw new GeometryValidationError(
          `Pencil geometry may contain at most ${MAX_PENCIL_POINTS} simplified points`,
          `${path}.points`,
        );
      }
    }
  }

  if (points.length < MIN_PENCIL_POINTS) {
    throw new GeometryValidationError(
      `Pencil geometry requires at least ${MIN_PENCIL_POINTS} distinct adjacent points`,
      `${path}.points`,
    );
  }
  const visiblePaths = own.call(object, "visiblePaths")
    ? normalizeVisiblePaths(object.visiblePaths, `${path}.visiblePaths`)
    : undefined;
  return { points, ...(visiblePaths === undefined ? {} : { visiblePaths }) };
}

export function normalizeLineGeometry(value: unknown, path = "$geometry"): LineGeometry {
  const object = expectRecord(value, path);
  expectKeys(object, ["x1", "y1", "x2", "y2"], ["visiblePaths"], path);
  const visiblePaths = own.call(object, "visiblePaths")
    ? normalizeVisiblePaths(object.visiblePaths, `${path}.visiblePaths`)
    : undefined;
  return {
    x1: normalizeCoordinate(object.x1, `${path}.x1`),
    y1: normalizeCoordinate(object.y1, `${path}.y1`),
    x2: normalizeCoordinate(object.x2, `${path}.x2`),
    y2: normalizeCoordinate(object.y2, `${path}.y2`),
    ...(visiblePaths === undefined ? {} : { visiblePaths }),
  };
}

export function normalizeBoxGeometry(value: unknown, path = "$geometry"): BoxGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x", "y", "width", "height"], path);
  const rawX = normalizeCoordinate(object.x, `${path}.x`);
  const rawY = normalizeCoordinate(object.y, `${path}.y`);
  if (typeof object.width !== "number" || !Number.isFinite(object.width)) {
    throw new GeometryValidationError("Expected a finite dimension", `${path}.width`);
  }
  if (typeof object.height !== "number" || !Number.isFinite(object.height)) {
    throw new GeometryValidationError("Expected a finite dimension", `${path}.height`);
  }

  // Negative drag extents are accepted as input and canonicalized. Canonical
  // geometry always has a non-negative width and height.
  const rawWidth = canonicalNumber(object.width, 2);
  const rawHeight = canonicalNumber(object.height, 2);
  const x = normalizeCoordinate(rawWidth < 0 ? rawX + rawWidth : rawX, `${path}.x`);
  const y = normalizeCoordinate(rawHeight < 0 ? rawY + rawHeight : rawY, `${path}.y`);
  const width = normalizeDimension(Math.abs(rawWidth), `${path}.width`);
  const height = normalizeDimension(Math.abs(rawHeight), `${path}.height`);
  normalizeCoordinate(x + width, `${path}.x+width`);
  normalizeCoordinate(y + height, `${path}.y+height`);
  return { x, y, width, height };
}

export function normalizeOutlineBoxGeometry(
  value: unknown,
  path = "$geometry",
): OutlineBoxGeometry {
  const object = expectRecord(value, path);
  expectKeys(object, ["x", "y", "width", "height"], ["visiblePaths"], path);
  const box = normalizeBoxGeometry(
    { x: object.x, y: object.y, width: object.width, height: object.height },
    path,
  );
  const visiblePaths = own.call(object, "visiblePaths")
    ? normalizeVisiblePaths(object.visiblePaths, `${path}.visiblePaths`)
    : undefined;
  return { ...box, ...(visiblePaths === undefined ? {} : { visiblePaths }) };
}

export function normalizeRectangleGeometry(value: unknown, path = "$geometry"): RectangleGeometry {
  const object = expectRecord(value, path);
  expectKeys(object, ["x", "y", "width", "height"], ["shape", "visiblePaths"], path);
  const box = normalizeOutlineBoxGeometry(
    {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      ...(own.call(object, "visiblePaths") ? { visiblePaths: object.visiblePaths } : {}),
    },
    path,
  );
  const shape = own.call(object, "shape")
    ? typeof object.shape === "string" && RECTANGLE_KINDS.includes(object.shape as RectangleKind)
      ? (object.shape as RectangleKind)
      : null
    : "rectangle";
  if (shape === null) {
    throw new GeometryValidationError(
      `Rectangle shape must be one of ${RECTANGLE_KINDS.map((kind) => JSON.stringify(kind)).join(", ")}`,
      `${path}.shape`,
    );
  }
  if (shape === "square" && box.width !== box.height) {
    throw new GeometryValidationError("Square width and height must be equal", `${path}.shape`);
  }
  return { ...box, shape };
}

export function normalizePolygonGeometry(value: unknown, path = "$geometry"): PolygonGeometry {
  const object = expectRecord(value, path);
  expectKeys(object, ["x", "y", "width", "height", "polygon"], ["visiblePaths"], path);
  const box = normalizeOutlineBoxGeometry(
    {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      ...(own.call(object, "visiblePaths") ? { visiblePaths: object.visiblePaths } : {}),
    },
    path,
  );
  if (
    typeof object.polygon !== "string" ||
    !POLYGON_KINDS.includes(object.polygon as PolygonKind)
  ) {
    throw new GeometryValidationError(
      `Polygon must be one of ${POLYGON_KINDS.map((kind) => JSON.stringify(kind)).join(", ")}`,
      `${path}.polygon`,
    );
  }
  return { ...box, polygon: object.polygon as PolygonKind };
}

export function normalizeProtractorGeometry(
  value: unknown,
  path = "$geometry",
): ProtractorGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["radius"], path);
  const radius = normalizeDimension(object.radius, `${path}.radius`);
  if (radius === 0) {
    throw new GeometryValidationError("Protractor radius must be greater than 0", `${path}.radius`);
  }
  return { radius };
}

export function normalizeTextGeometry(value: unknown, path = "$geometry"): TextGeometry {
  const object = expectRecord(value, path);
  expectKeys(object, ["x", "y", "text"], ["embed"], path);
  if (typeof object.text !== "string") {
    throw new GeometryValidationError("Expected text to be a string", `${path}.text`);
  }
  if (object.embed !== undefined && object.embed !== "video") {
    throw new GeometryValidationError('Expected text embed to be "video"', `${path}.embed`);
  }
  if (object.embed === "video" && parseVideoEmbedReference(object.text) === null) {
    throw new GeometryValidationError(
      "Video embed text must be a supported HTTPS YouTube or Vimeo URL",
      `${path}.text`,
    );
  }
  return {
    x: normalizeCoordinate(object.x, `${path}.x`),
    y: normalizeCoordinate(object.y, `${path}.y`),
    text: object.text,
    ...(object.embed === "video" ? { embed: "video" as const } : {}),
  };
}

export function normalizeStickyGeometry(value: unknown, path = "$geometry"): StickyGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x", "y", "width", "height", "text"], path);
  if (typeof object.text !== "string") {
    throw new GeometryValidationError("Expected text to be a string", `${path}.text`);
  }
  const box = normalizeBoxGeometry(
    {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
    },
    path,
  );
  if (box.width === 0) {
    throw new GeometryValidationError("Sticky width must be greater than 0", `${path}.width`);
  }
  if (box.height === 0) {
    throw new GeometryValidationError("Sticky height must be greater than 0", `${path}.height`);
  }
  return { ...box, text: object.text };
}

export function normalizeZoneGeometry(value: unknown, path = "$geometry"): ZoneGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(
    object,
    ["x", "y", "width", "height", "title", ...(own.call(object, "locked") ? ["locked"] : [])],
    path,
  );
  if (typeof object.title !== "string") {
    throw new GeometryValidationError("Expected zone title to be a string", `${path}.title`);
  }
  if (object.locked !== undefined && typeof object.locked !== "boolean") {
    throw new GeometryValidationError("Expected zone locked to be a boolean", `${path}.locked`);
  }
  const box = normalizeBoxGeometry(
    { x: object.x, y: object.y, width: object.width, height: object.height },
    path,
  );
  if (box.width === 0) {
    throw new GeometryValidationError("Zone width must be greater than 0", `${path}.width`);
  }
  if (box.height === 0) {
    throw new GeometryValidationError("Zone height must be greater than 0", `${path}.height`);
  }
  return { ...box, title: object.title, ...(object.locked === true ? { locked: true } : {}) };
}

export function isCanonicalImageAssetId(value: unknown): value is string {
  return typeof value === "string" && IMAGE_ASSET_ID_PATTERN.test(value);
}

function normalizeImageAlt(value: unknown, path: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") {
    throw new GeometryValidationError("Expected image alt text to be a string", path);
  }
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!Number.isInteger(second) || second < 0xdc00 || second > 0xdfff) {
        throw new GeometryValidationError("Image alt text contains an unpaired surrogate", path);
      }
      codePoint = (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new GeometryValidationError("Image alt text contains an unpaired surrogate", path);
    }
    const validXmlCodePoint =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!validXmlCodePoint) {
      throw new GeometryValidationError(
        "Image alt text contains a disallowed control character",
        path,
      );
    }
    count += 1;
    if (count > MAX_IMAGE_ALT_CODE_POINTS) {
      throw new GeometryValidationError(
        `Image alt text may contain at most ${MAX_IMAGE_ALT_CODE_POINTS} Unicode code points`,
        path,
      );
    }
  }
  return value;
}

function normalizeIntrinsicDimension(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GeometryValidationError("Expected a positive integer image dimension", path);
  }
  if ((value as number) > MAX_IMAGE_INTRINSIC_DIMENSION) {
    throw new GeometryValidationError(
      `Image dimension must be at most ${MAX_IMAGE_INTRINSIC_DIMENSION} pixels`,
      path,
    );
  }
  return value as number;
}

export function normalizeImageGeometry(value: unknown, path = "$geometry"): ImageGeometry {
  const object = expectRecord(value, path);
  const required = [
    "x",
    "y",
    "width",
    "height",
    "assetId",
    "mimeType",
    "intrinsicWidth",
    "intrinsicHeight",
  ] as const;
  const allowed = new Set<string>([...required, "alt"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new GeometryValidationError(`Unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!own.call(object, key)) {
      throw new GeometryValidationError(`Missing field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }

  const box = normalizeBoxGeometry(
    { x: object.x, y: object.y, width: object.width, height: object.height },
    path,
  );
  if (box.width === 0) {
    throw new GeometryValidationError("Image width must be greater than 0", `${path}.width`);
  }
  if (box.height === 0) {
    throw new GeometryValidationError("Image height must be greater than 0", `${path}.height`);
  }
  if (!isCanonicalImageAssetId(object.assetId)) {
    throw new GeometryValidationError(
      "Expected asset_ followed by a canonical 43-character base64url SHA-256 digest",
      `${path}.assetId`,
    );
  }
  if (
    typeof object.mimeType !== "string" ||
    !IMAGE_MIME_TYPES.includes(object.mimeType as ImageMimeType)
  ) {
    throw new GeometryValidationError(
      `Image MIME type must be one of ${IMAGE_MIME_TYPES.map((mimeType) => JSON.stringify(mimeType)).join(", ")}`,
      `${path}.mimeType`,
    );
  }
  const intrinsicWidth = normalizeIntrinsicDimension(
    object.intrinsicWidth,
    `${path}.intrinsicWidth`,
  );
  const intrinsicHeight = normalizeIntrinsicDimension(
    object.intrinsicHeight,
    `${path}.intrinsicHeight`,
  );
  if (intrinsicWidth * intrinsicHeight > MAX_IMAGE_INTRINSIC_PIXELS) {
    throw new GeometryValidationError(
      `Image dimensions may contain at most ${MAX_IMAGE_INTRINSIC_PIXELS} pixels`,
      path,
    );
  }
  const alt = own.call(object, "alt") ? normalizeImageAlt(object.alt, `${path}.alt`) : undefined;
  return {
    ...box,
    assetId: object.assetId,
    ...(alt === undefined ? {} : { alt }),
    mimeType: object.mimeType as ImageMimeType,
    intrinsicWidth,
    intrinsicHeight,
  };
}

export function normalizeStampGeometry(value: unknown, path = "$geometry"): StampGeometry {
  const object = expectRecord(value, path);
  expectOnlyKeys(object, ["x", "y", "size", "stamp"], path);
  const x = normalizeCoordinate(object.x, `${path}.x`);
  const y = normalizeCoordinate(object.y, `${path}.y`);
  const size = normalizeDimension(object.size, `${path}.size`);
  if (size === 0) {
    throw new GeometryValidationError("Stamp size must be greater than 0", `${path}.size`);
  }
  if (typeof object.stamp !== "string" || !STAMP_KINDS.includes(object.stamp as StampKind)) {
    throw new GeometryValidationError(
      `Stamp must be one of ${STAMP_KINDS.map((stamp) => JSON.stringify(stamp)).join(", ")}`,
      `${path}.stamp`,
    );
  }
  const halfSize = size / 2;
  normalizeCoordinate(x - halfSize, `${path}.x-size/2`);
  normalizeCoordinate(x + halfSize, `${path}.x+size/2`);
  normalizeCoordinate(y - halfSize, `${path}.y-size/2`);
  normalizeCoordinate(y + halfSize, `${path}.y+size/2`);
  return { x, y, size, stamp: object.stamp as StampKind };
}

function normalizeTableSizes(
  value: unknown,
  minimum: number,
  maximum: number,
  label: "column" | "row",
  path: string,
): number[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new GeometryValidationError(
      `Table must contain between ${minimum} and ${maximum} ${label}${maximum === 1 ? "" : "s"}`,
      path,
    );
  }
  return value.map((entry, index) => {
    const normalized = normalizeDimension(entry, `${path}[${index}]`);
    if (normalized === 0) {
      throw new GeometryValidationError(
        `Table ${label} size must be greater than 0`,
        `${path}[${index}]`,
      );
    }
    return normalized;
  });
}

export function tableGeometrySize(geometry: Pick<TableGeometry, "columnWidths" | "rowHeights">): {
  width: number;
  height: number;
} {
  return {
    width: canonicalNumber(
      geometry.columnWidths.reduce((total, width) => total + width, 0),
      2,
    ),
    height: canonicalNumber(
      geometry.rowHeights.reduce((total, height) => total + height, 0),
      2,
    ),
  };
}

export function normalizeTableGeometry(value: unknown, path = "$geometry"): TableGeometry {
  const object = expectRecord(value, path);
  const required = ["x", "y", "columnWidths", "rowHeights", "cells"] as const;
  const allowed = new Set<string>([...required, "headerRow"]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new GeometryValidationError(`Unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (!own.call(object, key)) {
      throw new GeometryValidationError(`Missing field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }

  const x = normalizeCoordinate(object.x, `${path}.x`);
  const y = normalizeCoordinate(object.y, `${path}.y`);
  const columnWidths = normalizeTableSizes(
    object.columnWidths,
    1,
    MAX_TABLE_COLUMNS,
    "column",
    `${path}.columnWidths`,
  );
  const rowHeights = normalizeTableSizes(
    object.rowHeights,
    1,
    MAX_TABLE_ROWS,
    "row",
    `${path}.rowHeights`,
  );
  if (!Array.isArray(object.cells) || object.cells.length !== rowHeights.length) {
    throw new GeometryValidationError(
      "Table cells must contain exactly one array per row height",
      `${path}.cells`,
    );
  }
  const cells = object.cells.map((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow) || rawRow.length !== columnWidths.length) {
      throw new GeometryValidationError(
        "Every table cell row must contain exactly one string per column width",
        `${path}.cells[${rowIndex}]`,
      );
    }
    return rawRow.map((cell, columnIndex) => {
      if (typeof cell !== "string") {
        throw new GeometryValidationError(
          "Expected table cell text to be a string",
          `${path}.cells[${rowIndex}][${columnIndex}]`,
        );
      }
      return cell;
    });
  });
  if (own.call(object, "headerRow") && typeof object.headerRow !== "boolean") {
    throw new GeometryValidationError("Table headerRow must be a boolean", `${path}.headerRow`);
  }
  const { width, height } = tableGeometrySize({ columnWidths, rowHeights });
  normalizeDimension(width, `${path}.columnWidths`);
  normalizeDimension(height, `${path}.rowHeights`);
  normalizeCoordinate(x + width, `${path}.x+width`);
  normalizeCoordinate(y + height, `${path}.y+height`);
  return {
    x,
    y,
    columnWidths,
    rowHeights,
    cells,
    ...(own.call(object, "headerRow") ? { headerRow: object.headerRow as boolean } : {}),
  };
}

export function normalizeGeometry(kind: "pencil", value: unknown, path?: string): PencilGeometry;
export function normalizeGeometry(kind: "line", value: unknown, path?: string): LineGeometry;
export function normalizeGeometry(
  kind: "rectangle",
  value: unknown,
  path?: string,
): RectangleGeometry;
export function normalizeGeometry(
  kind: "ellipse",
  value: unknown,
  path?: string,
): OutlineBoxGeometry;
export function normalizeGeometry(kind: "polygon", value: unknown, path?: string): PolygonGeometry;
export function normalizeGeometry(
  kind: "protractor",
  value: unknown,
  path?: string,
): ProtractorGeometry;
export function normalizeGeometry(kind: "text", value: unknown, path?: string): TextGeometry;
export function normalizeGeometry(kind: "sticky", value: unknown, path?: string): StickyGeometry;
export function normalizeGeometry(kind: "zone", value: unknown, path?: string): ZoneGeometry;
export function normalizeGeometry(kind: "image", value: unknown, path?: string): ImageGeometry;
export function normalizeGeometry(kind: "stamp", value: unknown, path?: string): StampGeometry;
export function normalizeGeometry(kind: "table", value: unknown, path?: string): TableGeometry;
export function normalizeGeometry(kind: GeometryKind, value: unknown, path?: string): ItemGeometry;
export function normalizeGeometry(
  kind: GeometryKind,
  value: unknown,
  path = "$geometry",
): ItemGeometry {
  switch (kind) {
    case "pencil":
      return normalizePencilGeometry(value, path);
    case "line":
      return normalizeLineGeometry(value, path);
    case "rectangle":
      return normalizeRectangleGeometry(value, path);
    case "ellipse":
      return normalizeOutlineBoxGeometry(value, path);
    case "polygon":
      return normalizePolygonGeometry(value, path);
    case "protractor":
      return normalizeProtractorGeometry(value, path);
    case "text":
      return normalizeTextGeometry(value, path);
    case "sticky":
      return normalizeStickyGeometry(value, path);
    case "zone":
      return normalizeZoneGeometry(value, path);
    case "image":
      return normalizeImageGeometry(value, path);
    case "stamp":
      return normalizeStampGeometry(value, path);
    case "table":
      return normalizeTableGeometry(value, path);
  }
}

export function inferAndNormalizeGeometry(value: unknown, path = "$geometry"): ItemGeometry {
  const object = expectRecord(value, path);
  if (own.call(object, "points")) return normalizePencilGeometry(object, path);
  if (own.call(object, "x1")) return normalizeLineGeometry(object, path);
  if (own.call(object, "polygon")) return normalizePolygonGeometry(object, path);
  if (own.call(object, "shape")) return normalizeRectangleGeometry(object, path);
  if (own.call(object, "radius") && !own.call(object, "width")) {
    return normalizeProtractorGeometry(object, path);
  }
  if (own.call(object, "stamp")) return normalizeStampGeometry(object, path);
  if (own.call(object, "assetId")) return normalizeImageGeometry(object, path);
  if (own.call(object, "cells")) return normalizeTableGeometry(object, path);
  if (own.call(object, "title")) return normalizeZoneGeometry(object, path);
  if (own.call(object, "width") && own.call(object, "text")) {
    return normalizeStickyGeometry(object, path);
  }
  if (own.call(object, "width")) return normalizeOutlineBoxGeometry(object, path);
  if (own.call(object, "text")) return normalizeTextGeometry(object, path);
  throw new GeometryValidationError("Unrecognized geometry shape", path);
}

export function transformPoint(point: Point, transform: Readonly<Transform>): Point {
  const [x, y] = point;
  const [a, b, c, d, e, f] = transform;
  return [a * x + c * y + e, b * x + d * y + f];
}

export function translateTransform(transform: Transform, x: unknown, y: unknown): Transform {
  const dx = normalizeCoordinate(x, "$translate.x");
  const dy = normalizeCoordinate(y, "$translate.y");
  return normalizeTransform(
    [transform[0], transform[1], transform[2], transform[3], transform[4] + dx, transform[5] + dy],
    "$transform",
  );
}

export function transformBounds(bounds: Bounds, transform: Transform): Bounds {
  const corners: Point[] = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ];
  return boundsFromPoints(corners.map((point) => transformPoint(point, transform)));
}

export function boundsFromPoints(points: readonly Point[]): Bounds {
  if (points.length === 0) {
    throw new GeometryValidationError("Cannot calculate bounds for an empty point set");
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

export function lineArrowheadPoints(
  geometry: LineGeometry,
  strokeWidth: number,
): [Point, Point, Point] | null {
  if (!Number.isFinite(strokeWidth) || strokeWidth <= 0) {
    throw new GeometryValidationError(
      "Line arrowhead stroke width must be a finite positive number",
      "$strokeWidth",
    );
  }
  const dx = geometry.x2 - geometry.x1;
  const dy = geometry.y2 - geometry.y1;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;

  const headLength = Math.min(
    length / 2,
    Math.max(LINE_ARROWHEAD_MIN_LENGTH, Math.min(LINE_ARROWHEAD_MAX_LENGTH, strokeWidth * 3)),
  );
  const halfWidth = headLength * LINE_ARROWHEAD_WIDTH_RATIO;
  const unitX = dx / length;
  const unitY = dy / length;
  const baseX = geometry.x2 - unitX * headLength;
  const baseY = geometry.y2 - unitY * headLength;
  return [
    [baseX - unitY * halfWidth, baseY + unitX * halfWidth],
    [geometry.x2, geometry.y2],
    [baseX + unitY * halfWidth, baseY - unitX * halfWidth],
  ];
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * The board's TeX delimiters, which are MathJax's own defaults: `\(…\)` for inline math, and
 * `\[…\]` or `$$…$$` for display math. A lone `$` is a dollar sign. Prices are far more common
 * on a classroom board than inline math, and "$5 to $12" must never become a formula.
 *
 * The browser renderer, the canonical geometry, and the picture exporter all read math through
 * this one pattern, so Section membership can never disagree with what MathJax typeset.
 */
const UNAMBIGUOUS_TEX_MARKUP = /\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\$\$[\s\S]+?\$\$/gu;

/** True when the character at `index` is escaped by an odd run of backslashes before it. */
function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Every formula in a value, skipping any whose opening delimiter is escaped. MathJax is configured
 * with processEscapes, so `\$` is a dollar sign a participant asked for literally; reading it as a
 * delimiter would let a picture of the board, and the bounds that decide Section membership,
 * disagree with what the board actually shows.
 */
function texMarkupMatches(value: string): Array<{ markup: string; index: number }> {
  const matches: Array<{ markup: string; index: number }> = [];
  let cursor = 0;
  while (cursor < value.length) {
    UNAMBIGUOUS_TEX_MARKUP.lastIndex = cursor;
    const match = UNAMBIGUOUS_TEX_MARKUP.exec(value);
    if (!match) break;
    const index = match.index;
    if (isEscaped(value, index)) {
      // Step past the escaped delimiter and keep looking; a later one may still be real.
      cursor = index + 1;
      continue;
    }
    matches.push({ markup: match[0], index });
    cursor = index + match[0].length;
  }
  UNAMBIGUOUS_TEX_MARKUP.lastIndex = 0;
  return matches;
}
const TEX_ENVIRONMENT_COMMAND = /\\(?:begin|end)\s*\{[^{}]*\}/gu;
const ZERO_WIDTH_TEX_LAYOUT_COMMAND =
  /\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle|frac|dfrac|tfrac|binom|dbinom|tbinom|left|right|middle|text|textrm|textsf|texttt|textnormal|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|boldsymbol|operatorname|overline|underline|hat|widehat|bar|vec|dot|ddot|tilde|widetilde|overbrace|underbrace)\b/gu;
const TEX_CONTROL_WORD = /\\[A-Za-z]+/gu;
const TEX_ESCAPED_VISIBLE_SYMBOL = /\\([#$%&_{}])/gu;

/**
 * Spacing and rule commands lay out an explicit dimension rather than glyphs. Collapsing them
 * to one representative character would let `$$\hspace{20em}x$$` claim the width of a few
 * letters, so a crafted item could be attached to a Section that the rendered formula spills
 * far outside of, and edge containment would accept it.
 */
const TEX_DIMENSION = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)\s*(?:em|ex|mu|pt|pc|bp|dd|cc|sp|in|cm|mm|px)`;
const TEX_HORIZONTAL_DIMENSION_COMMAND = new RegExp(
  String.raw`\\(?:hspace\*?|mspace)\s*\{\s*(${TEX_DIMENSION})\s*\}` +
    String.raw`|\\(?:kern|mkern|hskip|mskip)\s*(${TEX_DIMENSION})`,
  "gu",
);
const TEX_VERTICAL_DIMENSION_COMMAND = new RegExp(
  String.raw`\\vspace\*?\s*\{\s*(${TEX_DIMENSION})\s*\}|\\vskip\s*(${TEX_DIMENSION})`,
  "gu",
);
const TEX_RULE_COMMAND = new RegExp(
  String.raw`\\rule\s*(?:\[\s*(${TEX_DIMENSION})\s*\])?\s*\{\s*(${TEX_DIMENSION})\s*\}\s*\{\s*(${TEX_DIMENSION})\s*\}`,
  "gu",
);
/** Sized commands left over once the parseable forms above are expanded. */
const TEX_UNSIZED_DIMENSION_COMMAND =
  /\\(?:hspace\*?|vspace\*?|mspace|kern|mkern|hskip|vskip|mskip|rule|raisebox|makebox|framebox|parbox|resizebox|scalebox)\b/gu;
const TEX_DIMENSION_PARTS = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z]+)$/u;
/** Fixed-width math spaces, in em. */
const TEX_FIXED_SPACE_EM = new Map<string, number>([
  ["\\!", -3 / 18],
  ["\\negthinspace", -3 / 18],
  ["\\,", 3 / 18],
  ["\\thinspace", 3 / 18],
  ["\\:", 4 / 18],
  ["\\>", 4 / 18],
  ["\\medspace", 4 / 18],
  ["\\;", 5 / 18],
  ["\\thickspace", 5 / 18],
  ["\\enspace", 0.5],
  ["\\quad", 1],
  ["\\qquad", 2],
]);
const TEX_FIXED_SPACE =
  /\\(?:negthinspace|thinspace|medspace|thickspace|enspace|qquad|quad|[!,:;>])/gu;
/** Horizontal movements whose signed cursor offsets can escape the estimated text width. */
const TEX_HORIZONTAL_MOVEMENT = new RegExp(
  `(?:${TEX_HORIZONTAL_DIMENSION_COMMAND.source})|(${TEX_FIXED_SPACE.source})`,
  "gu",
);
/** Layout ratios the canonical text estimate below is expressed in. */
const TEXT_GLYPH_WIDTH_RATIO = 0.6;
const TEXT_LINE_HEIGHT_RATIO = 1.2;
/** Keeps a hostile dimension from expanding into an unbounded estimate string. */
const TEX_MAX_ESTIMATE_GLYPHS = 4096;
const TEX_MAX_ESTIMATE_LINES = 512;
/** Used for an unparseable sized command, so its extent is over- rather than under-reported. */
const TEX_UNSIZED_COMMAND_GLYPHS = 64;
const DEFAULT_TEX_ESTIMATE_FONT_SIZE = 16;
const PX_PER_POINT = 4 / 3;
const TEX_UNIT_PIXELS = new Map<string, number>([
  ["px", 1],
  ["pt", PX_PER_POINT],
  ["bp", PX_PER_POINT],
  ["pc", 12 * PX_PER_POINT],
  ["in", 72 * PX_PER_POINT],
  ["cm", (72 / 2.54) * PX_PER_POINT],
  ["mm", (7.2 / 2.54) * PX_PER_POINT],
  ["dd", 1.07 * PX_PER_POINT],
  ["cc", 12 * 1.07 * PX_PER_POINT],
  ["sp", PX_PER_POINT / 65536],
]);

/** Resolves a TeX dimension to pixels, or null when the unit is not one we model. */
function texDimensionPixels(dimension: string, fontSize: number): number | null {
  const parts = TEX_DIMENSION_PARTS.exec(dimension.trim());
  if (!parts) return null;
  const unit = parts[2];
  const amount = Number(parts[1]);
  if (!Number.isFinite(amount) || unit === undefined) return null;
  if (unit === "em") return amount * fontSize;
  if (unit === "ex") return amount * fontSize * 0.5;
  if (unit === "mu") return (amount / 18) * fontSize;
  const pixels = TEX_UNIT_PIXELS.get(unit);
  return pixels === undefined ? null : amount * pixels;
}

function texWidthGlyphCount(pixels: number, fontSize: number): number {
  return Math.ceil(Math.max(0, pixels) / Math.max(1, fontSize * TEXT_GLYPH_WIDTH_RATIO));
}

function texHeightLineCount(pixels: number, fontSize: number): number {
  return Math.ceil(Math.max(0, pixels) / Math.max(1, fontSize * TEXT_LINE_HEIGHT_RATIO));
}

type TexExpansionBudget = { remainingGlyphs: number; remainingLines: number };

function expandTexDimensions(markup: string, fontSize: number, budget: TexExpansionBudget): string {
  const glyphRun = (requested: number): string => {
    const count = Math.min(budget.remainingGlyphs, Math.max(0, requested));
    budget.remainingGlyphs -= count;
    return "x".repeat(count);
  };
  const lineRun = (requested: number): string => {
    const count = Math.min(budget.remainingLines, Math.max(0, requested));
    budget.remainingLines -= count;
    return "\n".repeat(count);
  };
  const width = (dimension: string | undefined): string => {
    const pixels = dimension === undefined ? null : texDimensionPixels(dimension, fontSize);
    return pixels === null
      ? glyphRun(TEX_UNSIZED_COMMAND_GLYPHS)
      : glyphRun(texWidthGlyphCount(pixels, fontSize));
  };
  const height = (dimension: string | undefined): string => {
    const pixels = dimension === undefined ? null : texDimensionPixels(dimension, fontSize);
    return pixels === null ? lineRun(1) : lineRun(texHeightLineCount(pixels, fontSize));
  };
  return markup
    .replace(
      TEX_RULE_COMMAND,
      (_match, _ruleRaise?: string, ruleWidth?: string, ruleHeight?: string) =>
        `${width(ruleWidth)}${height(ruleHeight)}`,
    )
    .replace(TEX_HORIZONTAL_DIMENSION_COMMAND, (_match, braced?: string, bare?: string) =>
      width(braced ?? bare),
    )
    .replace(TEX_VERTICAL_DIMENSION_COMMAND, (_match, braced?: string, bare?: string) =>
      height(braced ?? bare),
    )
    .replace(TEX_FIXED_SPACE, (match) =>
      glyphRun(texWidthGlyphCount((TEX_FIXED_SPACE_EM.get(match) ?? 0) * fontSize, fontSize)),
    )
    .replace(TEX_UNSIZED_DIMENSION_COMMAND, () => glyphRun(TEX_UNSIZED_COMMAND_GLYPHS));
}

function raisedRuleVerticalExtents(
  value: string,
  fontSize: number,
): { upward: number; downward: number } {
  let upward = 0;
  let downward = 0;
  const maximum = TEX_MAX_ESTIMATE_LINES * fontSize * TEXT_LINE_HEIGHT_RATIO;
  for (const markupMatch of texMarkupMatches(value)) {
    for (const ruleMatch of markupMatch.markup.matchAll(TEX_RULE_COMMAND)) {
      const raise = ruleMatch[1] === undefined ? 0 : texDimensionPixels(ruleMatch[1], fontSize);
      const height = ruleMatch[3] === undefined ? null : texDimensionPixels(ruleMatch[3], fontSize);
      if (raise === null || height === null) continue;
      const edge = raise + height;
      upward = Math.max(upward, Math.min(maximum, Math.max(0, raise, edge)));
      downward = Math.max(downward, Math.min(maximum, Math.max(0, -raise, -edge)));
    }
  }
  return { upward, downward };
}

function texHorizontalMovementExtents(
  value: string,
  fontSize: number,
): { left: number; right: number } {
  let left = 0;
  let right = 0;
  const maximum = TEX_MAX_ESTIMATE_GLYPHS * fontSize * TEXT_GLYPH_WIDTH_RATIO;
  for (const markupMatch of texMarkupMatches(value)) {
    let cursor = 0;
    let minimum = 0;
    let maximumCursor = 0;
    for (const movementMatch of markupMatch.markup.matchAll(TEX_HORIZONTAL_MOVEMENT)) {
      const dimension = movementMatch[1] ?? movementMatch[2];
      const fixedSpace = movementMatch[3];
      const pixels =
        dimension !== undefined
          ? texDimensionPixels(dimension, fontSize)
          : fixedSpace === undefined
            ? null
            : (TEX_FIXED_SPACE_EM.get(fixedSpace) ?? 0) * fontSize;
      if (pixels === null) continue;
      cursor = Math.max(-maximum, Math.min(maximum, cursor + pixels));
      minimum = Math.min(minimum, cursor);
      maximumCursor = Math.max(maximumCursor, cursor);
    }
    left = Math.max(left, -minimum);
    right = Math.max(right, maximumCursor);
  }
  return { left, right };
}

function texLayoutEstimateSource(
  markup: string,
  fontSize: number,
  budget: TexExpansionBudget,
): string {
  return expandTexDimensions(markup.slice(2, -2), fontSize, budget)
    .replace(TEX_ENVIRONMENT_COMMAND, "")
    .replace(/\\\\/gu, "\n")
    .replace(ZERO_WIDTH_TEX_LAYOUT_COMMAND, "")
    .replace(TEX_CONTROL_WORD, "x")
    .replace(TEX_ESCAPED_VISIBLE_SYMBOL, (_match, symbol: string) =>
      symbol === "{" ? "(" : symbol === "}" ? ")" : symbol === "_" ? "-" : symbol,
    )
    .replace(/[{}^_]/gu, "");
}

/**
 * Normalizes TeX markup to representative visible glyphs for deterministic bounds estimates.
 * The font size resolves absolute dimensions; callers that have one must pass it so clients
 * and the edge agree on the estimate.
 */
export function textLayoutEstimateSource(
  value: string,
  fontSize: number = DEFAULT_TEX_ESTIMATE_FONT_SIZE,
): string {
  const size =
    Number.isFinite(fontSize) && fontSize > 0 ? fontSize : DEFAULT_TEX_ESTIMATE_FONT_SIZE;
  const budget: TexExpansionBudget = {
    remainingGlyphs: TEX_MAX_ESTIMATE_GLYPHS,
    remainingLines: TEX_MAX_ESTIMATE_LINES,
  };
  // Rebuilt rather than replaced, so an escaped delimiter is left exactly as the participant
  // typed it: the estimate has to describe the same text MathJax will draw.
  let estimated = "";
  let copied = 0;
  for (const { markup, index } of texMarkupMatches(value)) {
    estimated += value.slice(copied, index) + texLayoutEstimateSource(markup, size, budget);
    copied = index + markup.length;
  }
  return estimated + value.slice(copied);
}

/** One run of a text value: either literal characters or one TeX expression. */
export type TexSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; text: string; tex: string; display: boolean };

/**
 * Splits a text value into literal runs and TeX expressions. Renderers that draw math and
 * renderers that only measure it share this, so a picture of a board can never disagree with the
 * board about where a formula begins.
 */
export function splitTexSegments(value: string): TexSegment[] {
  const segments: TexSegment[] = [];
  let cursor = 0;
  for (const { markup, index } of texMarkupMatches(value)) {
    if (index > cursor) segments.push({ kind: "text", text: value.slice(cursor, index) });
    const display = markup.startsWith("$$") || markup.startsWith("\\[");
    segments.push({ kind: "math", text: markup, tex: markup.slice(2, -2), display });
    cursor = index + markup.length;
  }
  if (cursor < value.length) segments.push({ kind: "text", text: value.slice(cursor) });
  return segments;
}

export type OutlineGeometryKind = "pencil" | "line" | "rectangle" | "ellipse" | "polygon";
export type OutlineGeometry = PencilGeometry | LineGeometry | OutlineBoxGeometry | PolygonGeometry;

export function polygonPoints(geometry: PolygonGeometry): Point[] {
  const { x, y, width, height } = geometry;
  if (geometry.polygon === "triangle") {
    return [
      [canonicalNumber(x + width / 2, 2), y],
      [canonicalNumber(x + width, 2), canonicalNumber(y + height, 2)],
      [x, canonicalNumber(y + height, 2)],
    ];
  }
  if (geometry.polygon === "rhombus") {
    return [
      [canonicalNumber(x + width / 2, 2), y],
      [canonicalNumber(x + width, 2), canonicalNumber(y + height / 2, 2)],
      [canonicalNumber(x + width / 2, 2), canonicalNumber(y + height, 2)],
      [x, canonicalNumber(y + height / 2, 2)],
    ];
  }
  const sides = geometry.polygon === "pentagon" ? 5 : 6;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  return Array.from({ length: sides }, (_, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / sides;
    return [
      canonicalNumber(centerX + Math.cos(angle) * (width / 2), 2),
      canonicalNumber(centerY + Math.sin(angle) * (height / 2), 2),
    ];
  });
}

function closedPath(points: readonly Point[]): Point[] {
  const first = points[0];
  if (!first) return [];
  return [...points.map(([x, y]) => [x, y] as Point), [first[0], first[1]]];
}

function ellipseOutlinePoints(geometry: OutlineBoxGeometry): Point[] {
  const centerX = geometry.x + geometry.width / 2;
  const centerY = geometry.y + geometry.height / 2;
  const points = Array.from({ length: ELLIPSE_OUTLINE_SEGMENTS }, (_, index) => {
    const angle = (index * Math.PI * 2) / ELLIPSE_OUTLINE_SEGMENTS;
    return [
      canonicalNumber(centerX + Math.cos(angle) * (geometry.width / 2), 2),
      canonicalNumber(centerY + Math.sin(angle) * (geometry.height / 2), 2),
    ] as Point;
  });
  return closedPath(points);
}

export function defaultOutlinePaths(
  kind: OutlineGeometryKind,
  geometry: OutlineGeometry,
): VisiblePaths {
  switch (kind) {
    case "pencil":
      return [(geometry as PencilGeometry).points.map(([x, y]) => [x, y])];
    case "line": {
      const line = geometry as LineGeometry;
      return [
        [
          [line.x1, line.y1],
          [line.x2, line.y2],
        ],
      ];
    }
    case "rectangle": {
      const box = geometry as OutlineBoxGeometry;
      return [
        closedPath([
          [box.x, box.y],
          [box.x + box.width, box.y],
          [box.x + box.width, box.y + box.height],
          [box.x, box.y + box.height],
        ]),
      ];
    }
    case "ellipse":
      return [ellipseOutlinePoints(geometry as OutlineBoxGeometry)];
    case "polygon":
      return [closedPath(polygonPoints(geometry as PolygonGeometry))];
  }
}

export function visibleOutlinePaths(
  kind: OutlineGeometryKind,
  geometry: OutlineGeometry,
): VisiblePaths {
  if ("visiblePaths" in geometry && geometry.visiblePaths !== undefined) {
    return geometry.visiblePaths.map((path) => path.map(([x, y]) => [x, y]));
  }
  return defaultOutlinePaths(kind, geometry);
}

export function protractorPoint(geometry: ProtractorGeometry, degrees: number, inset = 0): Point {
  if (!Number.isFinite(degrees) || degrees < 0 || degrees > 180) {
    throw new GeometryValidationError("Protractor degrees must be between 0 and 180", "$degrees");
  }
  if (!Number.isFinite(inset) || inset < 0 || inset > geometry.radius) {
    throw new GeometryValidationError(
      "Protractor inset must be between 0 and its radius",
      "$inset",
    );
  }
  const angle = (degrees * Math.PI) / 180;
  const radius = geometry.radius - inset;
  return [
    canonicalNumber(Math.cos(angle) * radius, 2),
    canonicalNumber(-Math.sin(angle) * radius, 2),
  ];
}

export function protractorSnapPoints(
  geometry: ProtractorGeometry,
  stepDegrees = PROTRACTOR_SNAP_STEP_DEGREES,
): Point[] {
  if (
    !Number.isSafeInteger(stepDegrees) ||
    stepDegrees < 1 ||
    stepDegrees > 180 ||
    180 % stepDegrees !== 0
  ) {
    throw new GeometryValidationError(
      "Protractor snap step must be a positive divisor of 180",
      "$stepDegrees",
    );
  }
  return [
    [0, 0],
    ...Array.from({ length: 180 / stepDegrees + 1 }, (_, index) =>
      protractorPoint(geometry, index * stepDegrees),
    ),
  ];
}

export function geometryBounds(
  kind: GeometryKind,
  geometry: ItemGeometry,
  textFontSize = 16,
): Bounds {
  switch (kind) {
    case "pencil":
      return boundsFromPoints(visibleOutlinePaths("pencil", geometry as PencilGeometry).flat());
    case "line": {
      const line = geometry as LineGeometry;
      return boundsFromPoints(visibleOutlinePaths("line", line).flat());
    }
    case "rectangle":
    case "ellipse": {
      const outline = geometry as OutlineBoxGeometry;
      if (outline.visiblePaths !== undefined) {
        return boundsFromPoints(visibleOutlinePaths(kind, outline).flat());
      }
      return {
        minX: outline.x,
        minY: outline.y,
        maxX: outline.x + outline.width,
        maxY: outline.y + outline.height,
      };
    }
    case "polygon": {
      const polygon = geometry as PolygonGeometry;
      if (polygon.visiblePaths !== undefined) {
        return boundsFromPoints(visibleOutlinePaths("polygon", polygon).flat());
      }
      return {
        minX: polygon.x,
        minY: polygon.y,
        maxX: polygon.x + polygon.width,
        maxY: polygon.y + polygon.height,
      };
    }
    case "protractor": {
      const protractor = geometry as ProtractorGeometry;
      return {
        minX: -protractor.radius,
        minY: -protractor.radius,
        maxX: protractor.radius,
        maxY: 0,
      };
    }
    case "sticky":
    case "zone":
    case "image":
    case "table": {
      const box =
        kind === "table"
          ? {
              x: (geometry as TableGeometry).x,
              y: (geometry as TableGeometry).y,
              ...tableGeometrySize(geometry as TableGeometry),
            }
          : (geometry as BoxGeometry);
      return {
        minX: box.x,
        minY: box.y,
        maxX: box.x + box.width,
        maxY: box.y + box.height,
      };
    }
    case "stamp": {
      const stamp = geometry as StampGeometry;
      const halfSize = stamp.size / 2;
      return {
        minX: stamp.x - halfSize,
        minY: stamp.y - halfSize,
        maxX: stamp.x + halfSize,
        maxY: stamp.y + halfSize,
      };
    }
    case "text": {
      const text = geometry as TextGeometry;
      if (text.embed === "video") {
        return {
          minX: text.x,
          minY: text.y - textFontSize,
          maxX: text.x + VIDEO_EMBED_WIDTH,
          maxY: text.y - textFontSize + VIDEO_EMBED_HEIGHT,
        };
      }
      const lines = textLayoutEstimateSource(text.text, textFontSize).split(/\r\n?|\n/u);
      const lineHeight = textFontSize * TEXT_LINE_HEIGHT_RATIO;
      const ruleExtents = raisedRuleVerticalExtents(text.text, textFontSize);
      const horizontalExtents = texHorizontalMovementExtents(text.text, textFontSize);
      const width = Math.max(
        ...lines.map((line) => codePointLength(line) * textFontSize * TEXT_GLYPH_WIDTH_RATIO),
      );
      return {
        minX: text.x - horizontalExtents.left,
        minY: Math.min(text.y - textFontSize, text.y - ruleExtents.upward),
        maxX: text.x + Math.max(width, horizontalExtents.right),
        maxY: Math.max(
          text.y - textFontSize + Math.max(1, lines.length) * lineHeight,
          text.y + ruleExtents.downward,
        ),
      };
    }
  }
}

export function imageGeometryContainsPoint(
  geometry: ImageGeometry,
  point: Point,
  padding = 0,
): boolean {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GeometryValidationError(
      "Image hit-test padding must be a finite non-negative number",
      "$padding",
    );
  }
  return (
    point[0] >= geometry.x - padding &&
    point[0] <= geometry.x + geometry.width + padding &&
    point[1] >= geometry.y - padding &&
    point[1] <= geometry.y + geometry.height + padding
  );
}

export function tableGeometryContainsPoint(
  geometry: TableGeometry,
  point: Point,
  padding = 0,
): boolean {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GeometryValidationError(
      "Table hit-test padding must be a finite non-negative number",
      "$padding",
    );
  }
  const { width, height } = tableGeometrySize(geometry);
  return (
    point[0] >= geometry.x - padding &&
    point[0] <= geometry.x + width + padding &&
    point[1] >= geometry.y - padding &&
    point[1] <= geometry.y + height + padding
  );
}

export function zoneTitleBandHeight(fontSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new GeometryValidationError(
      "Zone title font size must be a finite positive number",
      "$fontSize",
    );
  }
  return canonicalNumber(fontSize * 1.2 + ZONE_TITLE_PADDING * 2, 2);
}

export function zoneGeometryContainsPoint(
  geometry: ZoneGeometry,
  point: Point,
  fontSize: number,
  padding = 0,
): boolean {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GeometryValidationError(
      "Zone hit-test padding must be a finite non-negative number",
      "$padding",
    );
  }
  const [pointX, pointY] = point;
  const outerLeft = geometry.x - padding;
  const outerTop = geometry.y - padding;
  const outerRight = geometry.x + geometry.width + padding;
  const outerBottom = geometry.y + geometry.height + padding;
  if (pointX < outerLeft || pointX > outerRight || pointY < outerTop || pointY > outerBottom) {
    return false;
  }

  const titleBottom = Math.min(
    geometry.y + geometry.height,
    geometry.y + zoneTitleBandHeight(fontSize),
  );
  const inTitle = pointY <= titleBottom + padding;
  const borderWidth = ZONE_BORDER_HIT_WIDTH + padding;
  const inInterior =
    pointX > geometry.x + borderWidth &&
    pointX < geometry.x + geometry.width - borderWidth &&
    pointY > geometry.y + borderWidth &&
    pointY < geometry.y + geometry.height - borderWidth;
  return inTitle || !inInterior;
}

function maximumLinearScale(transform: Transform): number {
  const [a, b, c, d] = transform;
  // Largest singular value of the 2x2 linear part. This is a conservative,
  // rotation-aware expansion for transformed SVG strokes.
  const sum = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  const discriminant = Math.max(0, sum * sum - 4 * determinant * determinant);
  return Math.sqrt((sum + Math.sqrt(discriminant)) / 2);
}

export function expandBounds(bounds: Bounds, padding: number): Bounds {
  if (!Number.isFinite(padding) || padding < 0) {
    throw new GeometryValidationError("Padding must be a finite non-negative number", "$padding");
  }
  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
}

export function itemBounds(item: BoundsItem): Bounds {
  let local = geometryBounds(
    item.kind,
    item.geometry,
    item.style.kind === "text" ? item.style.fontSize : 16,
  );
  if (item.kind === "line" && item.style.kind === "line" && item.style.arrowhead === "arrow") {
    const arrowhead = lineArrowheadPoints(item.geometry as LineGeometry, item.style.width);
    if (arrowhead !== null) local = unionBounds(local, boundsFromPoints(arrowhead));
  }
  const transformed = transformBounds(local, item.transform);
  const result =
    item.style.kind === "stroke" || item.style.kind === "line"
      ? expandBounds(transformed, (item.style.width / 2) * maximumLinearScale(item.transform))
      : transformed;
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || Math.abs(value) > WORLD_COORDINATE_LIMIT) {
      throw new GeometryValidationError(
        `Transformed item bounds must remain between -${WORLD_COORDINATE_LIMIT} and ${WORLD_COORDINATE_LIMIT}`,
        `$bounds.${name}`,
      );
    }
  }
  return result;
}

export function unionBounds(left: Bounds, right: Bounds): Bounds {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

/**
 * Reports whether `candidate` lies entirely inside `container`, tolerating
 * floating-point drift at the shared edges. This is the single containment
 * predicate used for Section membership, so every caller agrees on the
 * epsilon.
 */
export function boundsContain(container: Bounds, candidate: Bounds, epsilon = 1e-6): boolean {
  return (
    candidate.minX >= container.minX - epsilon &&
    candidate.minY >= container.minY - epsilon &&
    candidate.maxX <= container.maxX + epsilon &&
    candidate.maxY <= container.maxY + epsilon
  );
}

export function boundsForItems(items: readonly BoundsItem[]): Bounds | null {
  let bounds: Bounds | null = null;
  for (const item of items) {
    const next = itemBounds(item);
    bounds = bounds === null ? next : unionBounds(bounds, next);
  }
  return bounds;
}

export function boundsWidth(bounds: Bounds): number {
  return bounds.maxX - bounds.minX;
}

export function boundsHeight(bounds: Bounds): number {
  return bounds.maxY - bounds.minY;
}

export function formatCanonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new GeometryValidationError("Cannot format a non-finite number");
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  const rendered = normalized.toString();
  if (!/[eE]/u.test(rendered)) return rendered;

  const [coefficient = "0", exponentText = "0"] = rendered.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + exponent;
  let expanded: string;
  if (decimalPosition <= 0) {
    expanded = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    expanded = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }
  if (expanded.includes(".")) {
    expanded = expanded.replace(/0+$/u, "").replace(/\.$/u, "");
  }
  if (expanded === "" || expanded === "-0") expanded = "0";
  return negative && expanded !== "0" ? `-${expanded}` : expanded;
}

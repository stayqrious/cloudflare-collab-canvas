import {
  canonicalNumber,
  GeometryValidationError,
  IMAGE_MIME_TYPES,
  type ImageGeometry,
  type ImageMimeType,
  type ItemGeometry,
  inferAndNormalizeGeometry,
  isCanonicalImageAssetId,
  type LineGeometry,
  MAX_IMAGE_ALT_CODE_POINTS,
  MAX_IMAGE_INTRINSIC_DIMENSION,
  MAX_IMAGE_INTRINSIC_PIXELS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  normalizeCoordinate,
  normalizeGeometry,
  normalizePoint,
  normalizeTransform,
  type OutlineBoxGeometry,
  type PencilGeometry,
  type Point,
  type PolygonGeometry,
  type ProtractorGeometry,
  parseVideoEmbedReference,
  type RectangleGeometry,
  type StampGeometry,
  type StickyGeometry,
  type TableGeometry,
  type TextGeometry,
  type Transform,
  type VideoEmbedReference,
  type ZoneGeometry,
} from "@collab/geometry";

export type {
  Bounds,
  BoxGeometry,
  GeometryKind,
  ImageGeometry,
  ImageMimeType,
  ItemGeometry,
  LineGeometry,
  OutlineBoxGeometry,
  PencilGeometry,
  Point,
  PolygonGeometry,
  PolygonKind,
  ProtractorGeometry,
  RectangleGeometry,
  RectangleKind,
  StampGeometry,
  StampKind,
  StickyGeometry,
  TableGeometry,
  TextGeometry,
  Transform,
  VisiblePaths,
  ZoneGeometry,
} from "@collab/geometry";
export {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_ALT_CODE_POINTS,
  MAX_IMAGE_INTRINSIC_DIMENSION,
  MAX_IMAGE_INTRINSIC_PIXELS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MAX_VISIBLE_PATH_POINTS,
  MAX_VISIBLE_PATHS,
  MIN_VISIBLE_PATH_POINTS,
  POLYGON_KINDS,
  PROTRACTOR_SNAP_STEP_DEGREES,
  RECTANGLE_KINDS,
  STAMP_KINDS,
  ZONE_BORDER_HIT_WIDTH,
  ZONE_TITLE_PADDING,
  zoneGeometryContainsPoint,
  zoneTitleBandHeight,
} from "@collab/geometry";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_ORDINARY_FRAME_BYTES = 64 * 1024;
export const MAX_PENCIL_FRAME_BYTES = 256 * 1024;
export const MAX_FRAME_DEPTH = 10;
export const MAX_BATCH_OPERATIONS = 100;
export const MAX_LIVE_ITEMS = 10_000;
export const MAX_TEXT_CODE_POINTS = 5_000;
export const MAX_STICKY_TEXT_CODE_POINTS = 1_000;
export const MAX_PUBLIC_RESULT_BYTES = 512 * 1024;
export const MAX_ACTION_PAYLOAD_BYTES = 1.5 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_RADIUS = 256;
export const MAX_TABLE_CELL_TEXT_CODE_POINTS = 500;
export const MAX_TABLE_TEXT_CODE_POINTS = 8_000;
export const MAX_ZONE_TITLE_CODE_POINTS = 120;
/**
 * Upper bound of the export-only Section index appended to canonical exports.
 * Every live item contributes at most one summary entry (a Section: id, title
 * of up to MAX_ZONE_TITLE_CODE_POINTS four-byte code points, lock flag and
 * framing) or one member id, so the index can never exceed this many bytes.
 */
export const MAX_SECTION_EXPORT_INDEX_BYTES =
  MAX_LIVE_ITEMS * (MAX_ZONE_TITLE_CODE_POINTS * 4 + 160);
/** Largest canonical export a consumer must accept: the snapshot plus its Section index. */
export const MAX_CANONICAL_EXPORT_BYTES = MAX_SNAPSHOT_BYTES + MAX_SECTION_EXPORT_INDEX_BYTES;
export const LINE_ARROWHEADS = ["none", "arrow"] as const;
export const TEXT_FONT_FAMILIES = ["sans", "serif", "handwritten", "mono"] as const;
export const TEXT_FONT_WEIGHTS = ["normal", "bold"] as const;
export const TEXT_FONT_STYLES = ["normal", "italic"] as const;
export const TEXT_DECORATIONS = ["none", "underline"] as const;

export type TextFontFamily = (typeof TEXT_FONT_FAMILIES)[number];
export type TextFontWeight = (typeof TEXT_FONT_WEIGHTS)[number];
export type TextFontStyle = (typeof TEXT_FONT_STYLES)[number];
export type TextDecoration = (typeof TEXT_DECORATIONS)[number];

export const TEXT_FONT_STACKS: Readonly<Record<TextFontFamily, string>> = {
  sans: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  handwritten: '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive',
  mono: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
};

export function textFontStack(fontFamily: TextFontFamily): string {
  return TEXT_FONT_STACKS[fontFamily];
}

export function resolveTextFontWeight(
  fontWeight: TextFontWeight | undefined,
  defaultWeight = "normal",
): string {
  if (fontWeight === "bold") return "700";
  if (fontWeight === "normal") return "normal";
  return defaultWeight;
}

export const BOARD_FEATURE_KEYS = [
  "pencil",
  "line",
  "lineSnapping",
  "square",
  "rectangle",
  "triangle",
  "rhombus",
  "pentagon",
  "hexagon",
  "circle",
  "text",
  "stickyNotes",
  "stamps",
  "images",
  "tables",
  "sections",
  "protractor",
  "eraser",
  "partialEraser",
  "objectTransforms",
  "grouping",
  "templates",
  "organisationTemplates",
  "voting",
  "spotlight",
] as const;

export type BoardFeatureKey = (typeof BOARD_FEATURE_KEYS)[number];
export type BoardFeatures = { [Key in BoardFeatureKey]: boolean };

export const DEFAULT_BOARD_FEATURES: BoardFeatures = {
  pencil: true,
  line: true,
  lineSnapping: true,
  square: true,
  rectangle: true,
  triangle: true,
  rhombus: true,
  pentagon: true,
  hexagon: true,
  circle: true,
  text: true,
  stickyNotes: true,
  stamps: true,
  images: true,
  tables: true,
  sections: true,
  protractor: true,
  eraser: true,
  partialEraser: true,
  objectTransforms: true,
  grouping: true,
  templates: true,
  organisationTemplates: true,
  voting: true,
  spotlight: true,
};

export const ITEM_KINDS = [
  "pencil",
  "line",
  "rectangle",
  "ellipse",
  "polygon",
  "protractor",
  "text",
  "sticky",
  "image",
  "stamp",
  "table",
  "zone",
] as const;
export const BOARD_ROLES = ["viewer", "editor", "owner"] as const;
export const DRAWING_POLICIES = ["editors_enabled", "owner_only", "locked"] as const;
export const ACCESS_MODES = ["private", "link_view"] as const;
export const ITEM_ASSISTANCE = ["ai"] as const;
/**
 * Actions a participant can request from the board's AI button while a WebMCP problem-step
 * watch is live. Shared so the web tool schema, the comment metadata the edge validates, and
 * the catalog cannot drift apart.
 */
export const ASSIST_ACTIONS = [
  "explain",
  "ideate",
  "critique",
  "check_work",
  "examples",
  "explain_with_video",
] as const;
/** Longest tool name the comment assistance metadata accepts. */
export const MAX_ASSISTANCE_TOOL_LENGTH = 64;
export const ASSISTANCE_TOOL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export type ItemKind = (typeof ITEM_KINDS)[number];
export type BoardItemKind = ItemKind;
export type BoardRole = (typeof BOARD_ROLES)[number];
export type DrawingPolicy = (typeof DRAWING_POLICIES)[number];
export type AccessMode = (typeof ACCESS_MODES)[number];
export type ItemAssistance = (typeof ITEM_ASSISTANCE)[number];
export type AssistAction = (typeof ASSIST_ACTIONS)[number];
/** Which WebMCP tool wrote an assisted comment, and the participant action it answered. */
export type Assistance = {
  tool: string;
  action?: AssistAction;
};

/**
 * The picture and video a comment can carry beside its text.
 *
 * A comment holds at most one of them, and it is the same material the canvas already takes:
 * an image is a committed board asset from the private per-board bucket, never an external
 * URL, and a video is one of the public YouTube or Vimeo links every embed surface accepts.
 * Shared so the composer, the WebMCP write tool, the edge's validation and the stored row all
 * read one definition.
 */
export const COMMENT_MEDIA_KINDS = ["image", "video"] as const;
export type CommentMediaKind = (typeof COMMENT_MEDIA_KINDS)[number];

/** Longest video link a comment accepts, matching the board's own embed field. */
export const MAX_COMMENT_MEDIA_URL_LENGTH = 2_048;
/**
 * Longest JSON encoding of one comment's media. Every field above is separately bounded, so
 * this only has to stop a pathological encoding from reaching the stored column.
 */
export const MAX_COMMENT_MEDIA_JSON_LENGTH = 4_096;

export interface CommentImageMedia {
  kind: "image";
  assetId: string;
  mimeType: ImageMimeType;
  intrinsicWidth: number;
  intrinsicHeight: number;
  /** What the picture shows, for participants who cannot see it. */
  alt?: string;
}

export interface CommentVideoMedia {
  kind: "video";
  provider: VideoEmbedReference["provider"];
  url: string;
}

export type CommentMedia = CommentImageMedia | CommentVideoMedia;

/** Why a comment's media was refused, carrying the field that failed for the caller's message. */
export class CommentMediaError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = "CommentMediaError";
    this.field = field;
  }
}

/**
 * Validates one comment attachment and returns it in canonical form: an image's stored asset
 * identity, or a video's provider and normalized source URL. Throws CommentMediaError with the
 * offending field. The same function checks a request body, a server response, and a stored row,
 * so none of the three can drift from the others.
 */
export function normalizeCommentMedia(value: unknown, path = "media"): CommentMedia {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommentMediaError("Comment media must be an object.", path);
  }
  const media = value as Record<string, unknown>;
  if (media.kind === "image") return normalizeCommentImageMedia(media, path);
  if (media.kind === "video") return normalizeCommentVideoMedia(media, path);
  throw new CommentMediaError(
    `Comment media kind must be one of ${COMMENT_MEDIA_KINDS.join(", ")}.`,
    `${path}.kind`,
  );
}

function normalizeCommentImageMedia(
  media: Record<string, unknown>,
  path: string,
): CommentImageMedia {
  expectCommentMediaKeys(
    media,
    ["kind", "assetId", "mimeType", "intrinsicWidth", "intrinsicHeight", "alt"],
    ["kind", "assetId", "mimeType", "intrinsicWidth", "intrinsicHeight"],
    path,
  );
  if (!isCanonicalImageAssetId(media.assetId)) {
    throw new CommentMediaError(
      "The image must be one already uploaded to this Space.",
      `${path}.assetId`,
    );
  }
  if (
    typeof media.mimeType !== "string" ||
    !(IMAGE_MIME_TYPES as readonly string[]).includes(media.mimeType)
  ) {
    throw new CommentMediaError(
      `The image type must be one of ${IMAGE_MIME_TYPES.join(", ")}.`,
      `${path}.mimeType`,
    );
  }
  const intrinsicWidth = commentMediaDimension(media.intrinsicWidth, `${path}.intrinsicWidth`);
  const intrinsicHeight = commentMediaDimension(media.intrinsicHeight, `${path}.intrinsicHeight`);
  if (intrinsicWidth * intrinsicHeight > MAX_IMAGE_INTRINSIC_PIXELS) {
    throw new CommentMediaError("That image has too many pixels.", `${path}.intrinsicWidth`);
  }
  const alt = commentMediaAlt(media.alt, `${path}.alt`);
  return {
    kind: "image",
    assetId: media.assetId,
    mimeType: media.mimeType as ImageMimeType,
    intrinsicWidth,
    intrinsicHeight,
    ...(alt === undefined ? {} : { alt }),
  };
}

function normalizeCommentVideoMedia(
  media: Record<string, unknown>,
  path: string,
): CommentVideoMedia {
  expectCommentMediaKeys(media, ["kind", "provider", "url"], ["kind", "url"], path);
  if (typeof media.url !== "string" || media.url.length > MAX_COMMENT_MEDIA_URL_LENGTH) {
    throw new CommentMediaError(
      `The video link must be text of at most ${MAX_COMMENT_MEDIA_URL_LENGTH} characters.`,
      `${path}.url`,
    );
  }
  const reference = parseVideoEmbedReference(media.url);
  if (reference === null) {
    throw new CommentMediaError(
      "The video link must be a complete HTTPS YouTube or Vimeo link.",
      `${path}.url`,
    );
  }
  // A caller may echo the provider back; it is derived, so it may agree but never decide.
  if (media.provider !== undefined && media.provider !== reference.provider) {
    throw new CommentMediaError("The video provider does not match its link.", `${path}.provider`);
  }
  return { kind: "video", provider: reference.provider, url: reference.sourceUrl };
}

function expectCommentMediaKeys(
  media: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(media)) {
    if (!allowed.includes(key)) {
      throw new CommentMediaError(`Unknown comment media field ${key}.`, `${path}.${key}`);
    }
  }
  for (const key of required) {
    if (media[key] === undefined) {
      throw new CommentMediaError(`Comment media is missing ${key}.`, `${path}.${key}`);
    }
  }
}

function commentMediaDimension(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_IMAGE_INTRINSIC_DIMENSION
  ) {
    throw new CommentMediaError(
      `The image dimension must be a whole number of pixels up to ${MAX_IMAGE_INTRINSIC_DIMENSION}.`,
      path,
    );
  }
  return value;
}

function commentMediaAlt(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new CommentMediaError("The image description must be text.", path);
  }
  const alt = value.trim();
  if (alt.length === 0) return undefined;
  if ([...alt].length > MAX_IMAGE_ALT_CODE_POINTS) {
    throw new CommentMediaError(
      `The image description must be at most ${MAX_IMAGE_ALT_CODE_POINTS} characters.`,
      path,
    );
  }
  return alt;
}

export interface BoardAccessPolicy {
  accessMode: AccessMode;
  drawingPolicy: DrawingPolicy;
  imagesEnabled: boolean;
  aclVersion: number;
}

export type Matrix = Transform;

export interface Frame {
  v: 1;
  t: string;
  [key: string]: unknown;
}

export interface StrokeStyle {
  kind: "stroke";
  color: string;
  width: number;
  opacity: number;
}

export type LineArrowhead = (typeof LINE_ARROWHEADS)[number];

export interface LineStyle {
  kind: "line";
  color: string;
  width: number;
  opacity: number;
  arrowhead: LineArrowhead;
}

export interface ProtractorStyle {
  kind: "protractor";
  color: string;
  opacity: number;
}

export interface TextStyle {
  kind: "text";
  color: string;
  fontSize: number;
  fontFamily: TextFontFamily;
  fontWeight?: TextFontWeight;
  fontStyle?: TextFontStyle;
  textDecoration?: TextDecoration;
  opacity: number;
}

export interface StickyStyle {
  kind: "sticky";
  fill: string;
  textColor: string;
  fontSize: number;
  fontFamily?: TextFontFamily;
  fontWeight?: TextFontWeight;
  fontStyle?: TextFontStyle;
  textDecoration?: TextDecoration;
  opacity: number;
}

export interface ImageStyle {
  kind: "image";
  opacity: number;
  radius: number;
}

export interface StampStyle {
  kind: "stamp";
  color: string;
  opacity: number;
}

export interface TableStyle {
  kind: "table";
  borderColor: string;
  fill: string;
  headerFill: string;
  textColor: string;
  fontSize: number;
  fontFamily?: TextFontFamily;
  fontWeight?: TextFontWeight;
  fontStyle?: TextFontStyle;
  textDecoration?: TextDecoration;
  opacity: number;
}

export interface ZoneStyle {
  kind: "zone";
  borderColor: string;
  fill: string;
  textColor: string;
  fontSize: number;
  fontFamily?: TextFontFamily;
  fontWeight?: TextFontWeight;
  fontStyle?: TextFontStyle;
  textDecoration?: TextDecoration;
  opacity: number;
}

export type ItemStyle =
  | StrokeStyle
  | LineStyle
  | ProtractorStyle
  | TextStyle
  | StickyStyle
  | ImageStyle
  | StampStyle
  | TableStyle
  | ZoneStyle;

interface BoardItemBase {
  id: string;
  groupId?: string;
  sectionId?: string;
  z: number;
  version: number;
  createdBy: string;
  assistedBy?: ItemAssistance;
  transform: Transform;
}

export interface PencilItem extends BoardItemBase {
  kind: "pencil";
  style: StrokeStyle;
  geometry: PencilGeometry;
}

export interface LineItem extends BoardItemBase {
  kind: "line";
  style: LineStyle;
  geometry: LineGeometry;
}

export interface RectangleItem extends BoardItemBase {
  kind: "rectangle";
  style: StrokeStyle;
  geometry: RectangleGeometry;
}

export interface EllipseItem extends BoardItemBase {
  kind: "ellipse";
  style: StrokeStyle;
  geometry: OutlineBoxGeometry;
}

export interface PolygonItem extends BoardItemBase {
  kind: "polygon";
  style: StrokeStyle;
  geometry: PolygonGeometry;
}

export interface ProtractorItem extends BoardItemBase {
  kind: "protractor";
  style: ProtractorStyle;
  geometry: ProtractorGeometry;
}

export interface TextItem extends BoardItemBase {
  kind: "text";
  style: TextStyle;
  geometry: TextGeometry;
}

export interface StickyItem extends BoardItemBase {
  kind: "sticky";
  style: StickyStyle;
  geometry: StickyGeometry;
}

export interface ImageItem extends BoardItemBase {
  kind: "image";
  style: ImageStyle;
  geometry: ImageGeometry;
}

export interface StampItem extends BoardItemBase {
  kind: "stamp";
  style: StampStyle;
  geometry: StampGeometry;
}

export interface TableItem extends BoardItemBase {
  kind: "table";
  style: TableStyle;
  geometry: TableGeometry;
}

export interface ZoneItem extends BoardItemBase {
  kind: "zone";
  style: ZoneStyle;
  geometry: ZoneGeometry;
}

export type BoardItem =
  | PencilItem
  | LineItem
  | RectangleItem
  | EllipseItem
  | PolygonItem
  | ProtractorItem
  | TextItem
  | StickyItem
  | ImageItem
  | StampItem
  | TableItem
  | ZoneItem;

type WithoutServerFields<T> = T extends BoardItem ? Omit<T, "z" | "version" | "createdBy"> : never;

export type NewBoardItem = WithoutServerFields<BoardItem>;

export interface ItemPatch {
  style?: ItemStyle;
  transform?: Transform;
  geometry?: ItemGeometry;
  groupId?: string | null;
  sectionId?: string | null;
}

export interface ItemCreateOperation {
  kind: "item.create";
  item: NewBoardItem;
}

export interface ItemUpdateOperation {
  kind: "item.update";
  itemId: string;
  expectedVersion: number;
  patch: ItemPatch;
}

export interface ItemDeleteOperation {
  kind: "item.delete";
  itemId: string;
  expectedVersion: number;
}

export interface ItemCopyOperation {
  kind: "item.copy";
  sourceItemId: string;
  expectedVersion: number;
  newItemId: string;
  translate: { x: number; y: number };
  newGroupId?: string | null;
  newSectionId?: string | null;
}

export type BatchItemOperation =
  | ItemCreateOperation
  | ItemUpdateOperation
  | ItemDeleteOperation
  | ItemCopyOperation;

export interface ItemsBatchOperation {
  kind: "items.batch";
  operations: BatchItemOperation[];
}

export interface HistoryUndoOperation {
  kind: "history.undo";
  expectedHistoryVersion: number;
  targetActionId?: string;
}

export interface HistoryRedoOperation {
  kind: "history.redo";
  expectedHistoryVersion: number;
  targetActionId?: string;
}

export interface BoardClearOperation {
  kind: "board.clear";
  expectedBoardSeq: number;
}

export type DurableOperation =
  | BatchItemOperation
  | ItemsBatchOperation
  | HistoryUndoOperation
  | HistoryRedoOperation
  | BoardClearOperation;

export type LogicalItemState = { exists: false } | { exists: true; item: BoardItem };

export interface ItemEffect {
  itemId: string;
  before: LogicalItemState;
  after: LogicalItemState;
  beforeStateToken: string;
  afterStateToken: string;
}

export interface AuthoritativeItemCreate {
  kind: "item.create";
  item: BoardItem;
}

export interface AuthoritativeItemUpdate {
  kind: "item.update";
  item: BoardItem;
}

export interface AuthoritativeItemDelete {
  kind: "item.delete";
  itemId: string;
  version: number;
}

export interface AuthoritativeItemCopy {
  kind: "item.copy";
  sourceItemId: string;
  item: BoardItem;
}

export type AuthoritativeItemOperation =
  | AuthoritativeItemCreate
  | AuthoritativeItemUpdate
  | AuthoritativeItemDelete
  | AuthoritativeItemCopy;

export interface AuthoritativeBatchOperation {
  kind: "items.batch";
  operations: AuthoritativeItemOperation[];
}

export type CanonicalItemChange =
  | { kind: "item.replace"; item: BoardItem }
  | { kind: "item.remove"; itemId: string; version: number };

export interface AuthoritativeHistoryOperation {
  kind: "history.undo" | "history.redo";
  targetActionId: string;
  changes: CanonicalItemChange[];
}

export interface AuthoritativeClearOperation {
  kind: "board.clear";
  removed: Array<{ itemId: string; version: number }>;
}

export type AuthoritativeOperation =
  | AuthoritativeItemOperation
  | AuthoritativeBatchOperation
  | AuthoritativeHistoryOperation
  | AuthoritativeClearOperation;

export interface ClientCommitFrame {
  v: 1;
  t: "client.commit";
  commandId: string;
  actionId: string;
  baseSeq: number;
  op: DurableOperation;
}

export interface PencilStartPreview {
  v: 1;
  t: "client.preview";
  gestureId: string;
  previewSeq: number;
  kind: "pencil.start";
  payload: { itemId: string; point: Point; style: StrokeStyle };
}

export interface PencilSegmentPreview {
  v: 1;
  t: "client.preview";
  gestureId: string;
  previewSeq: number;
  kind: "pencil.segment";
  payload: { itemId: string; points: Point[] };
}

export interface ShapeGeometryPreview {
  v: 1;
  t: "client.preview";
  gestureId: string;
  previewSeq: number;
  kind: "shape.geometry";
  payload: {
    itemId: string;
    itemKind: "line" | "rectangle" | "ellipse" | "polygon";
    geometry: LineGeometry | RectangleGeometry | OutlineBoxGeometry | PolygonGeometry;
    style: StrokeStyle | LineStyle;
  };
}

export interface SelectionTransformPreview {
  v: 1;
  t: "client.preview";
  gestureId: string;
  previewSeq: number;
  kind: "selection.transform";
  payload: { itemIds: string[]; translate: { x: number; y: number } };
}

export interface GestureCancelPreview {
  v: 1;
  t: "client.preview";
  gestureId: string;
  previewSeq: number;
  kind: "gesture.cancel";
  payload: Record<string, never>;
}

export type ClientPreviewFrame =
  | PencilStartPreview
  | PencilSegmentPreview
  | ShapeGeometryPreview
  | SelectionTransformPreview
  | GestureCancelPreview;

export const ACTIVE_TOOLS = [
  "pencil",
  "line",
  "rectangle",
  "ellipse",
  "polygon",
  "protractor",
  "text",
  "sticky",
  "image",
  "stamp",
  "table",
  "zone",
  "eraser",
  "select",
  "pan",
] as const;

export type ActiveTool = (typeof ACTIVE_TOOLS)[number];

export interface ClientPresenceFrame {
  v: 1;
  t: "client.presence";
  cursor: { x: number; y: number };
  activeTool: ActiveTool;
}

export interface SpotlightViewport {
  center: { x: number; y: number };
  zoom: number;
}

export interface ClientActiveSpotlightFrame {
  v: 1;
  t: "client.facilitation.spotlight";
  spotlightId: string;
  active: true;
  viewport: SpotlightViewport;
}

export interface ClientStopSpotlightFrame {
  v: 1;
  t: "client.facilitation.spotlight";
  spotlightId: string;
  active: false;
}

export type ClientFacilitationSpotlightFrame =
  | ClientActiveSpotlightFrame
  | ClientStopSpotlightFrame;

export interface ClientSyncCheckFrame {
  v: 1;
  t: "client.sync_check";
  latestSeq: number;
}

export type ClientFrame =
  | ClientCommitFrame
  | ClientPreviewFrame
  | ClientPresenceFrame
  | ClientFacilitationSpotlightFrame
  | ClientSyncCheckFrame;

export interface ServerActor {
  id: string;
  displayName: string;
}

export interface ServerActionFrame {
  v: 1;
  t: "server.action";
  seq: number;
  acceptedAt: number;
  actor: ServerActor;
  creators?: ServerActor[];
  commandId: string;
  actionId: string;
  op: AuthoritativeOperation;
}

export interface ServerReplayFrame {
  v: 1;
  t: "server.replay";
  fromExclusive: number;
  toInclusive: number;
  actions: ServerActionFrame[];
}

export type ProtocolErrorCode =
  | "INVALID_FRAME"
  | "MESSAGE_TOO_LARGE"
  | "UNSUPPORTED_VERSION"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "BOARD_FULL"
  | "RATE_LIMITED"
  | "STALE_BOARD"
  | "STALE_ITEM"
  | "DUPLICATE_ITEM_ID"
  | "ITEM_NOT_FOUND"
  | "BOARD_LIMIT_REACHED"
  | "UNDO_EMPTY"
  | "UNDO_CONFLICT"
  | "REDO_EMPTY"
  | "STALE_HISTORY"
  | "REPLAY_UNAVAILABLE"
  | "TEMPORARILY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class ProtocolValidationError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly path = "$",
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(path === "$" ? message : `${message} at ${path}`);
    this.name = "ProtocolValidationError";
  }
}

export interface ServerRejectedFrame {
  v: 1;
  t: "server.rejected";
  commandId?: string;
  code: ProtocolErrorCode;
  message: string;
  latestSeq?: number;
  reloadRequired?: boolean;
  details?: Readonly<Record<string, unknown>>;
}

const own = Object.prototype.hasOwnProperty;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PREFIXED_BASE64URL_PATTERN = /^[a-z][a-z0-9]{0,15}_([A-Za-z0-9_-]{16,128})$/u;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/u;

function fail(
  message: string,
  path = "$",
  code: ProtocolErrorCode = "INVALID_FRAME",
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new ProtocolValidationError(code, message, path, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail("Expected an object", path);
  return value;
}

function expectExactKeys(
  object: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`Unknown field ${JSON.stringify(key)}`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!own.call(object, key)) fail(`Missing field ${JSON.stringify(key)}`, `${path}.${key}`);
  }
}

function expectLiteral<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`Expected one of ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}`, path);
  }
  return value as T;
}

function expectSafeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`Expected a safe integer greater than or equal to ${minimum}`, path);
  }
  return value as number;
}

export function normalizeBoardFeatures(value: unknown, path = "$features"): BoardFeatures {
  const object = expectRecord(value, path);
  expectExactKeys(object, BOARD_FEATURE_KEYS, [], path);
  const features = {} as BoardFeatures;
  for (const key of BOARD_FEATURE_KEYS) {
    if (typeof object[key] !== "boolean") {
      fail(`${key} must be a boolean`, `${path}.${key}`);
    }
    features[key] = object[key];
  }
  return features;
}

export function normalizeBoardAccessPolicy(
  value: unknown,
  path = "$boardPolicy",
): BoardAccessPolicy {
  const object = expectRecord(value, path);
  expectExactKeys(object, ["accessMode", "drawingPolicy", "imagesEnabled", "aclVersion"], [], path);
  if (typeof object.imagesEnabled !== "boolean") {
    fail("imagesEnabled must be a boolean", `${path}.imagesEnabled`);
  }
  return {
    accessMode: expectLiteral(object.accessMode, ACCESS_MODES, `${path}.accessMode`),
    drawingPolicy: expectLiteral(object.drawingPolicy, DRAWING_POLICIES, `${path}.drawingPolicy`),
    imagesEnabled: object.imagesEnabled,
    aclVersion: expectSafeInteger(object.aclVersion, `${path}.aclVersion`, 1),
  };
}

function base64UrlIsCanonical(value: string): boolean {
  const match = PREFIXED_BASE64URL_PATTERN.exec(value);
  if (match === null) return false;
  const payload = match[1];
  if (payload === undefined) return false;
  const remainder = payload.length % 4;
  if (remainder === 1) return false;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = payload.at(-1);
  if (last === undefined) return false;
  const lastIndex = alphabet.indexOf(last);
  if (remainder === 2 && lastIndex % 16 !== 0) return false;
  if (remainder === 3 && lastIndex % 4 !== 0) return false;
  return true;
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isCanonicalBase64UrlId(value: unknown): value is string {
  return typeof value === "string" && base64UrlIsCanonical(value);
}

export function isCanonicalId(value: unknown): value is string {
  return isCanonicalUuid(value) || isCanonicalBase64UrlId(value);
}

export function assertCanonicalId(value: unknown, path = "$id"): string {
  if (!isCanonicalId(value)) {
    fail("Expected a canonical UUID or prefixed base64url ID", path);
  }
  return value;
}

export function isCanonicalAssetId(value: unknown): value is string {
  return isCanonicalImageAssetId(value);
}

export function assertCanonicalAssetId(value: unknown, path = "$assetId"): string {
  if (!isCanonicalAssetId(value)) {
    fail("Expected asset_ followed by a canonical 43-character base64url SHA-256 digest", path);
  }
  return value;
}

function fromGeometry<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof GeometryValidationError) {
      throw new ProtocolValidationError("INVALID_FRAME", error.reason, error.path);
    }
    throw error;
  }
}

function normalizeOpacity(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.1 || value > 1) {
    fail("Opacity must be a finite number between 0.1 and 1", path);
  }
  return canonicalNumber(value, 2);
}

function normalizeColor(value: unknown, path: string): string {
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) {
    fail("Color must be a lowercase #rrggbb value", path);
  }
  return value;
}

function normalizeStrokeWidth(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("Stroke width must be a finite number", path);
  }
  const width = canonicalNumber(value, 2);
  if (width < 1 || width > 100) fail("Stroke width must be between 1 and 100", path);
  return width;
}

export function normalizeStrokeStyle(value: unknown, path = "$style"): StrokeStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "stroke") fail('Expected style kind "stroke"', `${path}.kind`);
  expectExactKeys(object, ["kind", "color", "width", "opacity"], [], path);
  return {
    kind: "stroke",
    color: normalizeColor(object.color, `${path}.color`),
    width: normalizeStrokeWidth(object.width, `${path}.width`),
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
  };
}

export function normalizeLineStyle(value: unknown, path = "$style"): LineStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "line") fail('Expected style kind "line"', `${path}.kind`);
  expectExactKeys(object, ["kind", "color", "width", "opacity", "arrowhead"], [], path);
  return {
    kind: "line",
    color: normalizeColor(object.color, `${path}.color`),
    width: normalizeStrokeWidth(object.width, `${path}.width`),
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
    arrowhead: expectLiteral(object.arrowhead, LINE_ARROWHEADS, `${path}.arrowhead`),
  };
}

export function normalizeProtractorStyle(value: unknown, path = "$style"): ProtractorStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "protractor") fail('Expected style kind "protractor"', `${path}.kind`);
  expectExactKeys(object, ["kind", "color", "opacity"], [], path);
  return {
    kind: "protractor",
    color: normalizeColor(object.color, `${path}.color`),
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
  };
}

function normalizeOptionalTextFormat(
  object: Record<string, unknown>,
  path: string,
): Partial<Pick<TextStyle, "fontFamily" | "fontWeight" | "fontStyle" | "textDecoration">> {
  return {
    ...(own.call(object, "fontFamily")
      ? { fontFamily: expectLiteral(object.fontFamily, TEXT_FONT_FAMILIES, `${path}.fontFamily`) }
      : {}),
    ...(own.call(object, "fontWeight")
      ? { fontWeight: expectLiteral(object.fontWeight, TEXT_FONT_WEIGHTS, `${path}.fontWeight`) }
      : {}),
    ...(own.call(object, "fontStyle")
      ? { fontStyle: expectLiteral(object.fontStyle, TEXT_FONT_STYLES, `${path}.fontStyle`) }
      : {}),
    ...(own.call(object, "textDecoration")
      ? {
          textDecoration: expectLiteral(
            object.textDecoration,
            TEXT_DECORATIONS,
            `${path}.textDecoration`,
          ),
        }
      : {}),
  };
}

export function normalizeTextStyle(value: unknown, path = "$style"): TextStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "text") fail('Expected style kind "text"', `${path}.kind`);
  expectExactKeys(
    object,
    ["kind", "color", "fontSize", "fontFamily", "opacity"],
    ["fontWeight", "fontStyle", "textDecoration"],
    path,
  );
  if (typeof object.fontSize !== "number" || !Number.isFinite(object.fontSize)) {
    fail("Font size must be a finite number", `${path}.fontSize`);
  }
  const fontSize = canonicalNumber(object.fontSize, 2);
  if (fontSize < 8 || fontSize > 256)
    fail("Font size must be between 8 and 256", `${path}.fontSize`);
  return {
    kind: "text",
    color: normalizeColor(object.color, `${path}.color`),
    fontSize,
    fontFamily: expectLiteral(object.fontFamily, TEXT_FONT_FAMILIES, `${path}.fontFamily`),
    ...normalizeOptionalTextFormat(object, path),
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
  };
}

export function normalizeStickyStyle(value: unknown, path = "$style"): StickyStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "sticky") fail('Expected style kind "sticky"', `${path}.kind`);
  expectExactKeys(
    object,
    ["kind", "fill", "textColor", "fontSize", "opacity"],
    ["fontFamily", "fontWeight", "fontStyle", "textDecoration"],
    path,
  );
  if (typeof object.fontSize !== "number" || !Number.isFinite(object.fontSize)) {
    fail("Font size must be a finite number", `${path}.fontSize`);
  }
  const fontSize = canonicalNumber(object.fontSize, 2);
  if (fontSize < 8 || fontSize > 256) {
    fail("Font size must be between 8 and 256", `${path}.fontSize`);
  }
  return {
    kind: "sticky",
    fill: normalizeColor(object.fill, `${path}.fill`),
    textColor: normalizeColor(object.textColor, `${path}.textColor`),
    fontSize,
    ...normalizeOptionalTextFormat(object, path),
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
  };
}

export function normalizeImageStyle(value: unknown, path = "$style"): ImageStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "image") fail('Expected style kind "image"', `${path}.kind`);
  expectExactKeys(object, ["kind", "opacity", "radius"], [], path);
  if (typeof object.radius !== "number" || !Number.isFinite(object.radius)) {
    fail("Image corner radius must be a finite number", `${path}.radius`);
  }
  const radius = canonicalNumber(object.radius, 2);
  if (radius < 0 || radius > MAX_IMAGE_RADIUS) {
    fail(`Image corner radius must be between 0 and ${MAX_IMAGE_RADIUS}`, `${path}.radius`);
  }
  return {
    kind: "image",
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
    radius,
  };
}

export function normalizeStampStyle(value: unknown, path = "$style"): StampStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "stamp") fail('Expected style kind "stamp"', `${path}.kind`);
  expectExactKeys(object, ["kind", "color", "opacity"], [], path);
  return {
    kind: "stamp",
    color: normalizeColor(object.color, `${path}.color`),
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
  };
}

export function normalizeTableStyle(value: unknown, path = "$style"): TableStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "table") fail('Expected style kind "table"', `${path}.kind`);
  expectExactKeys(
    object,
    ["kind", "borderColor", "fill", "headerFill", "textColor", "fontSize", "opacity"],
    ["fontFamily", "fontWeight", "fontStyle", "textDecoration"],
    path,
  );
  if (typeof object.fontSize !== "number" || !Number.isFinite(object.fontSize)) {
    fail("Font size must be a finite number", `${path}.fontSize`);
  }
  const fontSize = canonicalNumber(object.fontSize, 2);
  if (fontSize < 8 || fontSize > 256) {
    fail("Font size must be between 8 and 256", `${path}.fontSize`);
  }
  return {
    kind: "table",
    borderColor: normalizeColor(object.borderColor, `${path}.borderColor`),
    fill: normalizeColor(object.fill, `${path}.fill`),
    headerFill: normalizeColor(object.headerFill, `${path}.headerFill`),
    textColor: normalizeColor(object.textColor, `${path}.textColor`),
    fontSize,
    ...normalizeOptionalTextFormat(object, path),
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
  };
}

export function normalizeZoneStyle(value: unknown, path = "$style"): ZoneStyle {
  const object = expectRecord(value, path);
  if (object.kind !== "zone") fail('Expected style kind "zone"', `${path}.kind`);
  expectExactKeys(
    object,
    ["kind", "borderColor", "fill", "textColor", "fontSize", "opacity"],
    ["fontFamily", "fontWeight", "fontStyle", "textDecoration"],
    path,
  );
  if (typeof object.fontSize !== "number" || !Number.isFinite(object.fontSize)) {
    fail("Font size must be a finite number", `${path}.fontSize`);
  }
  const fontSize = canonicalNumber(object.fontSize, 2);
  if (fontSize < 8 || fontSize > 256) {
    fail("Font size must be between 8 and 256", `${path}.fontSize`);
  }
  return {
    kind: "zone",
    borderColor: normalizeColor(object.borderColor, `${path}.borderColor`),
    fill: normalizeColor(object.fill, `${path}.fill`),
    textColor: normalizeColor(object.textColor, `${path}.textColor`),
    fontSize,
    ...normalizeOptionalTextFormat(object, path),
    opacity: normalizeOpacity(object.opacity, `${path}.opacity`),
  };
}

export function normalizeItemStyle(value: unknown, path = "$style"): ItemStyle {
  const object = expectRecord(value, path);
  if (object.kind === "stroke") return normalizeStrokeStyle(object, path);
  if (object.kind === "line") return normalizeLineStyle(object, path);
  if (object.kind === "protractor") return normalizeProtractorStyle(object, path);
  if (object.kind === "text") return normalizeTextStyle(object, path);
  if (object.kind === "sticky") return normalizeStickyStyle(object, path);
  if (object.kind === "image") return normalizeImageStyle(object, path);
  if (object.kind === "stamp") return normalizeStampStyle(object, path);
  if (object.kind === "table") return normalizeTableStyle(object, path);
  if (object.kind === "zone") return normalizeZoneStyle(object, path);
  fail(
    'Style kind must be "stroke", "line", "protractor", "text", "sticky", "image", "stamp", "table", or "zone"',
    `${path}.kind`,
  );
}

function isValidXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function validateText(
  value: unknown,
  path: string,
  maximumCodePoints: number,
  allowEmpty: boolean,
  label: string,
): string {
  if (typeof value !== "string") fail("Expected plain text", path);
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!Number.isInteger(second) || second < 0xdc00 || second > 0xdfff) {
        fail("Text contains an unpaired surrogate", path);
      }
      codePoint = (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      fail("Text contains an unpaired surrogate", path);
    }
    if (!isValidXmlCodePoint(codePoint)) fail("Text contains a disallowed control character", path);
    count += 1;
    if (count > maximumCodePoints) {
      fail(`${label} may contain at most ${maximumCodePoints} Unicode code points`, path);
    }
  }
  if (!allowEmpty && count === 0) fail("Text must not be empty", path);
  return value;
}

export function validatePlainText(value: unknown, path = "$text"): string {
  return validateText(value, path, MAX_TEXT_CODE_POINTS, false, "Text");
}

export function validateStickyText(value: unknown, path = "$text"): string {
  return validateText(value, path, MAX_STICKY_TEXT_CODE_POINTS, true, "Sticky text");
}

export function validateTableCellText(value: unknown, path = "$cell"): string {
  return validateText(value, path, MAX_TABLE_CELL_TEXT_CODE_POINTS, true, "Table cell text");
}

export function validateZoneTitle(value: unknown, path = "$title"): string {
  return validateText(value, path, MAX_ZONE_TITLE_CODE_POINTS, false, "Zone title");
}

export function validateTableCells(value: unknown, path = "$cells"): string[][] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TABLE_ROWS) {
    fail(`Table cells must contain between 1 and ${MAX_TABLE_ROWS} rows`, path);
  }
  let columnCount: number | undefined;
  let totalCodePoints = 0;
  return value.map((rawRow, rowIndex) => {
    if (!Array.isArray(rawRow) || rawRow.length < 1 || rawRow.length > MAX_TABLE_COLUMNS) {
      fail(
        `Every table row must contain between 1 and ${MAX_TABLE_COLUMNS} cells`,
        `${path}[${rowIndex}]`,
      );
    }
    if (columnCount === undefined) columnCount = rawRow.length;
    if (rawRow.length !== columnCount) {
      fail("Table cells must form a rectangular grid", `${path}[${rowIndex}]`);
    }
    return rawRow.map((rawCell, columnIndex) => {
      const cellPath = `${path}[${rowIndex}][${columnIndex}]`;
      const cell = validateTableCellText(rawCell, cellPath);
      totalCodePoints += Array.from(cell).length;
      if (totalCodePoints > MAX_TABLE_TEXT_CODE_POINTS) {
        fail(
          `Table text may contain at most ${MAX_TABLE_TEXT_CODE_POINTS} Unicode code points in total`,
          cellPath,
        );
      }
      return cell;
    });
  });
}

function normalizeGeometryForItem(kind: ItemKind, value: unknown, path: string): ItemGeometry {
  const geometry = fromGeometry(() => normalizeGeometry(kind, value, path));
  if (kind === "text") {
    return {
      ...(geometry as TextGeometry),
      text: validatePlainText((geometry as TextGeometry).text, `${path}.text`),
    };
  }
  if (kind === "sticky") {
    return {
      ...(geometry as StickyGeometry),
      text: validateStickyText((geometry as StickyGeometry).text, `${path}.text`),
    };
  }
  if (kind === "image") {
    const image = geometry as ImageGeometry;
    assertCanonicalAssetId(image.assetId, `${path}.assetId`);
    return image;
  }
  if (kind === "table") {
    const table = geometry as TableGeometry;
    return {
      ...table,
      cells: validateTableCells(table.cells, `${path}.cells`),
    };
  }
  if (kind === "zone") {
    const zone = geometry as ZoneGeometry;
    return { ...zone, title: validateZoneTitle(zone.title, `${path}.title`) };
  }
  return geometry;
}

function normalizeStyleForKind(kind: ItemKind, value: unknown, path: string): ItemStyle {
  if (kind === "line") return normalizeLineStyle(value, path);
  if (kind === "protractor") return normalizeProtractorStyle(value, path);
  if (kind === "text") return normalizeTextStyle(value, path);
  if (kind === "sticky") return normalizeStickyStyle(value, path);
  if (kind === "image") return normalizeImageStyle(value, path);
  if (kind === "stamp") return normalizeStampStyle(value, path);
  if (kind === "table") return normalizeTableStyle(value, path);
  if (kind === "zone") return normalizeZoneStyle(value, path);
  return normalizeStrokeStyle(value, path);
}

export function normalizeNewBoardItem(value: unknown, path = "$item"): NewBoardItem {
  const object = expectRecord(value, path);
  expectExactKeys(
    object,
    ["id", "kind", "style", "transform", "geometry"],
    ["assistedBy", "groupId", "sectionId"],
    path,
  );
  const kind = expectLiteral(object.kind, ITEM_KINDS, `${path}.kind`);
  const common = {
    id: assertCanonicalId(object.id, `${path}.id`),
    ...(own.call(object, "groupId")
      ? { groupId: assertCanonicalId(object.groupId, `${path}.groupId`) }
      : {}),
    ...(own.call(object, "sectionId")
      ? { sectionId: assertCanonicalId(object.sectionId, `${path}.sectionId`) }
      : {}),
    transform: fromGeometry(() => normalizeTransform(object.transform, `${path}.transform`)),
  };
  const assistance = own.call(object, "assistedBy")
    ? {
        assistedBy: expectLiteral(object.assistedBy, ITEM_ASSISTANCE, `${path}.assistedBy`),
      }
    : {};
  const style = normalizeStyleForKind(kind, object.style, `${path}.style`);
  const geometry = normalizeGeometryForItem(kind, object.geometry, `${path}.geometry`);
  return { ...common, ...assistance, kind, style, geometry } as NewBoardItem;
}

export function normalizeBoardItem(value: unknown, path = "$item"): BoardItem {
  const object = expectRecord(value, path);
  expectExactKeys(
    object,
    ["id", "kind", "z", "version", "createdBy", "style", "transform", "geometry"],
    ["assistedBy", "groupId", "sectionId"],
    path,
  );
  const normalized = normalizeNewBoardItem(
    {
      id: object.id,
      ...(own.call(object, "groupId") ? { groupId: object.groupId } : {}),
      ...(own.call(object, "sectionId") ? { sectionId: object.sectionId } : {}),
      kind: object.kind,
      style: object.style,
      transform: object.transform,
      geometry: object.geometry,
      ...(own.call(object, "assistedBy") ? { assistedBy: object.assistedBy } : {}),
    },
    path,
  );
  return {
    ...normalized,
    z: expectSafeInteger(object.z, `${path}.z`),
    version: expectSafeInteger(object.version, `${path}.version`),
    createdBy: assertCanonicalId(object.createdBy, `${path}.createdBy`),
  } as BoardItem;
}

export function normalizeItemPatch(value: unknown, path = "$patch"): ItemPatch {
  const object = expectRecord(value, path);
  expectExactKeys(object, [], ["style", "transform", "geometry", "groupId", "sectionId"], path);
  if (Object.keys(object).length === 0) fail("An item patch must change at least one field", path);
  const patch: ItemPatch = {};
  if (own.call(object, "groupId")) {
    patch.groupId =
      object.groupId === null ? null : assertCanonicalId(object.groupId, `${path}.groupId`);
  }
  if (own.call(object, "sectionId")) {
    patch.sectionId =
      object.sectionId === null ? null : assertCanonicalId(object.sectionId, `${path}.sectionId`);
  }
  if (own.call(object, "style")) patch.style = normalizeItemStyle(object.style, `${path}.style`);
  if (own.call(object, "transform")) {
    patch.transform = fromGeometry(() => normalizeTransform(object.transform, `${path}.transform`));
  }
  if (own.call(object, "geometry")) {
    patch.geometry = fromGeometry(() =>
      inferAndNormalizeGeometry(object.geometry, `${path}.geometry`),
    );
    if ("text" in patch.geometry) {
      patch.geometry = {
        ...patch.geometry,
        text:
          "width" in patch.geometry
            ? validateStickyText(patch.geometry.text, `${path}.geometry.text`)
            : validatePlainText(patch.geometry.text, `${path}.geometry.text`),
      };
    }
    if ("cells" in patch.geometry) {
      patch.geometry = {
        ...patch.geometry,
        cells: validateTableCells(patch.geometry.cells, `${path}.geometry.cells`),
      };
    }
    if ("title" in patch.geometry) {
      patch.geometry = {
        ...patch.geometry,
        title: validateZoneTitle(patch.geometry.title, `${path}.geometry.title`),
      };
    }
  }
  return patch;
}

function validateItemOperation(value: unknown, path: string): BatchItemOperation {
  const object = expectRecord(value, path);
  const kind = object.kind;
  switch (kind) {
    case "item.create":
      expectExactKeys(object, ["kind", "item"], [], path);
      return { kind, item: normalizeNewBoardItem(object.item, `${path}.item`) };
    case "item.update":
      expectExactKeys(object, ["kind", "itemId", "expectedVersion", "patch"], [], path);
      return {
        kind,
        itemId: assertCanonicalId(object.itemId, `${path}.itemId`),
        expectedVersion: expectSafeInteger(object.expectedVersion, `${path}.expectedVersion`),
        patch: normalizeItemPatch(object.patch, `${path}.patch`),
      };
    case "item.delete":
      expectExactKeys(object, ["kind", "itemId", "expectedVersion"], [], path);
      return {
        kind,
        itemId: assertCanonicalId(object.itemId, `${path}.itemId`),
        expectedVersion: expectSafeInteger(object.expectedVersion, `${path}.expectedVersion`),
      };
    case "item.copy": {
      expectExactKeys(
        object,
        ["kind", "sourceItemId", "expectedVersion", "newItemId", "translate"],
        ["newGroupId", "newSectionId"],
        path,
      );
      const translate = expectRecord(object.translate, `${path}.translate`);
      expectExactKeys(translate, ["x", "y"], [], `${path}.translate`);
      return {
        kind,
        sourceItemId: assertCanonicalId(object.sourceItemId, `${path}.sourceItemId`),
        expectedVersion: expectSafeInteger(object.expectedVersion, `${path}.expectedVersion`),
        newItemId: assertCanonicalId(object.newItemId, `${path}.newItemId`),
        ...(own.call(object, "newGroupId")
          ? {
              newGroupId:
                object.newGroupId === null
                  ? null
                  : assertCanonicalId(object.newGroupId, `${path}.newGroupId`),
            }
          : {}),
        ...(own.call(object, "newSectionId")
          ? {
              newSectionId:
                object.newSectionId === null
                  ? null
                  : assertCanonicalId(object.newSectionId, `${path}.newSectionId`),
            }
          : {}),
        translate: {
          x: fromGeometry(() => normalizeCoordinate(translate.x, `${path}.translate.x`)),
          y: fromGeometry(() => normalizeCoordinate(translate.y, `${path}.translate.y`)),
        },
      };
    }
    default:
      fail("Expected an item create, update, delete, or copy operation", `${path}.kind`);
  }
}

export function validateDurableOperation(value: unknown, path = "$op"): DurableOperation {
  const object = expectRecord(value, path);
  switch (object.kind) {
    case "item.create":
    case "item.update":
    case "item.delete":
    case "item.copy":
      return validateItemOperation(object, path);
    case "items.batch": {
      expectExactKeys(object, ["kind", "operations"], [], path);
      if (!Array.isArray(object.operations))
        fail("Batch operations must be an array", `${path}.operations`);
      if (object.operations.length === 0 || object.operations.length > MAX_BATCH_OPERATIONS) {
        fail(
          `Batch must contain between 1 and ${MAX_BATCH_OPERATIONS} operations`,
          `${path}.operations`,
        );
      }
      const operations = object.operations.map((entry, index) =>
        validateItemOperation(entry, `${path}.operations[${index}]`),
      );

      // Multiple writes to the same ID in one action have ambiguous client-side
      // expected-version semantics. Reject them before any state is touched.
      const affected = new Set<string>();
      for (const [index, operation] of operations.entries()) {
        const ids =
          operation.kind === "item.create"
            ? [operation.item.id]
            : operation.kind === "item.copy"
              ? [operation.sourceItemId, operation.newItemId]
              : [operation.itemId];
        for (const id of ids) {
          if (affected.has(id))
            fail("A batch may affect an item ID only once", `${path}.operations[${index}]`);
          affected.add(id);
        }
      }
      return { kind: "items.batch", operations };
    }
    case "history.undo":
    case "history.redo": {
      expectExactKeys(object, ["kind", "expectedHistoryVersion"], ["targetActionId"], path);
      const operation: HistoryUndoOperation | HistoryRedoOperation = {
        kind: object.kind,
        expectedHistoryVersion: expectSafeInteger(
          object.expectedHistoryVersion,
          `${path}.expectedHistoryVersion`,
        ),
      };
      if (own.call(object, "targetActionId")) {
        operation.targetActionId = assertCanonicalId(
          object.targetActionId,
          `${path}.targetActionId`,
        );
      }
      return operation;
    }
    case "board.clear":
      expectExactKeys(object, ["kind", "expectedBoardSeq"], [], path);
      return {
        kind: "board.clear",
        expectedBoardSeq: expectSafeInteger(object.expectedBoardSeq, `${path}.expectedBoardSeq`),
      };
    default:
      fail("Unknown durable operation kind", `${path}.kind`);
  }
}

function normalizePreviewBase(object: Record<string, unknown>, path: string) {
  return {
    v: PROTOCOL_VERSION,
    t: "client.preview" as const,
    gestureId: assertCanonicalId(object.gestureId, `${path}.gestureId`),
    previewSeq: expectSafeInteger(object.previewSeq, `${path}.previewSeq`),
  };
}

function validatePreviewFrame(object: Record<string, unknown>, path: string): ClientPreviewFrame {
  expectExactKeys(object, ["v", "t", "gestureId", "previewSeq", "kind", "payload"], [], path);
  const base = normalizePreviewBase(object, path);
  const payload = expectRecord(object.payload, `${path}.payload`);
  switch (object.kind) {
    case "pencil.start":
      expectExactKeys(payload, ["itemId", "point", "style"], [], `${path}.payload`);
      return {
        ...base,
        kind: "pencil.start",
        payload: {
          itemId: assertCanonicalId(payload.itemId, `${path}.payload.itemId`),
          point: fromGeometry(() => normalizePoint(payload.point, `${path}.payload.point`)),
          style: normalizeStrokeStyle(payload.style, `${path}.payload.style`),
        },
      };
    case "pencil.segment": {
      expectExactKeys(payload, ["itemId", "points"], [], `${path}.payload`);
      if (
        !Array.isArray(payload.points) ||
        payload.points.length === 0 ||
        payload.points.length > 1_000
      ) {
        fail("A pencil segment must contain 1 to 1000 points", `${path}.payload.points`);
      }
      const points = payload.points.map((point, index) =>
        fromGeometry(() => normalizePoint(point, `${path}.payload.points[${index}]`)),
      );
      return {
        ...base,
        kind: "pencil.segment",
        payload: {
          itemId: assertCanonicalId(payload.itemId, `${path}.payload.itemId`),
          points,
        },
      };
    }
    case "shape.geometry": {
      expectExactKeys(payload, ["itemId", "itemKind", "geometry", "style"], [], `${path}.payload`);
      const itemKind = expectLiteral(
        payload.itemKind,
        ["line", "rectangle", "ellipse", "polygon"] as const,
        `${path}.payload.itemKind`,
      );
      return {
        ...base,
        kind: "shape.geometry",
        payload: {
          itemId: assertCanonicalId(payload.itemId, `${path}.payload.itemId`),
          itemKind,
          geometry: fromGeometry(() =>
            itemKind === "line"
              ? normalizeGeometry("line", payload.geometry, `${path}.payload.geometry`)
              : itemKind === "polygon"
                ? normalizeGeometry("polygon", payload.geometry, `${path}.payload.geometry`)
                : itemKind === "rectangle"
                  ? normalizeGeometry("rectangle", payload.geometry, `${path}.payload.geometry`)
                  : normalizeGeometry("ellipse", payload.geometry, `${path}.payload.geometry`),
          ),
          style:
            itemKind === "line"
              ? isRecord(payload.style) && payload.style.kind === "stroke"
                ? normalizeStrokeStyle(payload.style, `${path}.payload.style`)
                : normalizeLineStyle(payload.style, `${path}.payload.style`)
              : normalizeStrokeStyle(payload.style, `${path}.payload.style`),
        },
      };
    }
    case "selection.transform": {
      expectExactKeys(payload, ["itemIds", "translate"], [], `${path}.payload`);
      if (
        !Array.isArray(payload.itemIds) ||
        payload.itemIds.length === 0 ||
        payload.itemIds.length > 100
      ) {
        fail("Selection preview must contain 1 to 100 item IDs", `${path}.payload.itemIds`);
      }
      const itemIds = payload.itemIds.map((id, index) =>
        assertCanonicalId(id, `${path}.payload.itemIds[${index}]`),
      );
      if (new Set(itemIds).size !== itemIds.length)
        fail("Selection item IDs must be unique", `${path}.payload.itemIds`);
      const translate = expectRecord(payload.translate, `${path}.payload.translate`);
      expectExactKeys(translate, ["x", "y"], [], `${path}.payload.translate`);
      return {
        ...base,
        kind: "selection.transform",
        payload: {
          itemIds,
          translate: {
            x: fromGeometry(() => normalizeCoordinate(translate.x, `${path}.payload.translate.x`)),
            y: fromGeometry(() => normalizeCoordinate(translate.y, `${path}.payload.translate.y`)),
          },
        },
      };
    }
    case "gesture.cancel":
      expectExactKeys(payload, [], [], `${path}.payload`);
      return { ...base, kind: "gesture.cancel", payload: {} };
    default:
      fail("Unknown preview kind", `${path}.kind`);
  }
}

function validateFrameVersion(object: Record<string, unknown>, path: string): void {
  if (object.v !== PROTOCOL_VERSION) {
    fail(
      `Only protocol version ${PROTOCOL_VERSION} is supported`,
      `${path}.v`,
      "UNSUPPORTED_VERSION",
      { reloadRequired: true },
    );
  }
}

export function validateClientFrame(value: unknown, path = "$frame"): ClientFrame {
  inspectJsonValue(value, MAX_FRAME_DEPTH);
  const object = expectRecord(value, path);
  if (!own.call(object, "v")) fail('Missing field "v"', `${path}.v`);
  if (!own.call(object, "t")) fail('Missing field "t"', `${path}.t`);
  validateFrameVersion(object, path);
  switch (object.t) {
    case "client.commit":
      expectExactKeys(object, ["v", "t", "commandId", "actionId", "baseSeq", "op"], [], path);
      return {
        v: PROTOCOL_VERSION,
        t: "client.commit",
        commandId: assertCanonicalId(object.commandId, `${path}.commandId`),
        actionId: assertCanonicalId(object.actionId, `${path}.actionId`),
        baseSeq: expectSafeInteger(object.baseSeq, `${path}.baseSeq`),
        op: validateDurableOperation(object.op, `${path}.op`),
      };
    case "client.preview":
      return validatePreviewFrame(object, path);
    case "client.presence": {
      expectExactKeys(object, ["v", "t", "cursor", "activeTool"], [], path);
      const cursor = expectRecord(object.cursor, `${path}.cursor`);
      expectExactKeys(cursor, ["x", "y"], [], `${path}.cursor`);
      return {
        v: PROTOCOL_VERSION,
        t: "client.presence",
        cursor: {
          x: fromGeometry(() => normalizeCoordinate(cursor.x, `${path}.cursor.x`)),
          y: fromGeometry(() => normalizeCoordinate(cursor.y, `${path}.cursor.y`)),
        },
        activeTool: expectLiteral(object.activeTool, ACTIVE_TOOLS, `${path}.activeTool`),
      };
    }
    case "client.facilitation.spotlight": {
      if (!isCanonicalUuid(object.spotlightId)) {
        fail("Expected a canonical UUID", `${path}.spotlightId`);
      }
      if (typeof object.active !== "boolean") {
        fail("Spotlight active must be a boolean", `${path}.active`);
      }
      if (!object.active) {
        expectExactKeys(object, ["v", "t", "spotlightId", "active"], [], path);
        return {
          v: PROTOCOL_VERSION,
          t: "client.facilitation.spotlight",
          spotlightId: object.spotlightId,
          active: false,
        };
      }
      expectExactKeys(object, ["v", "t", "spotlightId", "active", "viewport"], [], path);
      const viewport = expectRecord(object.viewport, `${path}.viewport`);
      expectExactKeys(viewport, ["center", "zoom"], [], `${path}.viewport`);
      const center = expectRecord(viewport.center, `${path}.viewport.center`);
      expectExactKeys(center, ["x", "y"], [], `${path}.viewport.center`);
      if (typeof viewport.zoom !== "number" || !Number.isFinite(viewport.zoom)) {
        fail("Spotlight zoom must be a finite number", `${path}.viewport.zoom`);
      }
      const zoom = canonicalNumber(viewport.zoom, 4);
      if (zoom < 0.1 || zoom > 8) {
        fail("Spotlight zoom must be between 0.1 and 8", `${path}.viewport.zoom`);
      }
      return {
        v: PROTOCOL_VERSION,
        t: "client.facilitation.spotlight",
        spotlightId: object.spotlightId,
        active: true,
        viewport: {
          center: {
            x: fromGeometry(() => normalizeCoordinate(center.x, `${path}.viewport.center.x`)),
            y: fromGeometry(() => normalizeCoordinate(center.y, `${path}.viewport.center.y`)),
          },
          zoom,
        },
      };
    }
    case "client.sync_check":
      expectExactKeys(object, ["v", "t", "latestSeq"], [], path);
      return {
        v: PROTOCOL_VERSION,
        t: "client.sync_check",
        latestSeq: expectSafeInteger(object.latestSeq, `${path}.latestSeq`),
      };
    default:
      fail("Unknown frame type", `${path}.t`);
  }
}

function operationContainsPencil(operation: DurableOperation): boolean {
  if (operation.kind === "item.create") return operation.item.kind === "pencil";
  if (operation.kind === "item.update") return "points" in (operation.patch.geometry ?? {});
  if (operation.kind === "items.batch") return operation.operations.some(operationContainsPencil);
  return false;
}

function rawOperationMayContainPencil(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "item.create") {
    return isRecord(value.item) && value.item.kind === "pencil";
  }
  if (value.kind === "item.update") {
    return (
      isRecord(value.patch) &&
      isRecord(value.patch.geometry) &&
      Array.isArray(value.patch.geometry.points)
    );
  }
  if (value.kind === "items.batch" && Array.isArray(value.operations)) {
    return value.operations.some(rawOperationMayContainPencil);
  }
  return false;
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function parseClientFrame(payload: string | ArrayBuffer | ArrayBufferView): ClientFrame {
  if (typeof payload !== "string") {
    fail("Binary WebSocket frames are not supported", "$frame");
  }
  const byteLength = utf8Bytes(payload).byteLength;
  if (byteLength > MAX_PENCIL_FRAME_BYTES) {
    fail(`Frame exceeds ${MAX_PENCIL_FRAME_BYTES} bytes`, "$frame", "MESSAGE_TOO_LARGE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    fail("Frame is not valid JSON", "$frame");
  }
  if (
    byteLength > MAX_ORDINARY_FRAME_BYTES &&
    (!isRecord(parsed) || parsed.t !== "client.commit" || !rawOperationMayContainPencil(parsed.op))
  ) {
    fail(`Frame exceeds ${MAX_ORDINARY_FRAME_BYTES} bytes`, "$frame", "MESSAGE_TOO_LARGE");
  }
  const frame = validateClientFrame(parsed);
  const permitsPencilLimit = frame.t === "client.commit" && operationContainsPencil(frame.op);
  if (byteLength > MAX_ORDINARY_FRAME_BYTES && !permitsPencilLimit) {
    fail(`Frame exceeds ${MAX_ORDINARY_FRAME_BYTES} bytes`, "$frame", "MESSAGE_TOO_LARGE");
  }
  return frame;
}

function inspectJsonValue(value: unknown, maximumDepth: number): void {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; path: string }> = [
    { value, depth: 1, path: "$frame" },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const entry = current.value;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") continue;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) fail("JSON numbers must be finite", current.path);
      continue;
    }
    if (typeof entry !== "object") fail("Value is not valid JSON", current.path);
    // Depth limits protect traversal of nested containers. Scalar leaves do not
    // add another recursively traversable level, so allow them immediately
    // below the deepest permitted object or array. This keeps bounded table
    // rows valid inside item batches without relaxing the container-depth cap.
    if (current.depth > maximumDepth) fail(`JSON nesting exceeds ${maximumDepth}`, current.path);
    if (seen.has(entry)) fail("Cyclic values are not valid JSON", current.path);
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        stack.push({
          value: entry[index],
          depth: current.depth + 1,
          path: `${current.path}[${index}]`,
        });
      }
      continue;
    }
    if (!isRecord(entry)) fail("Value is not a plain JSON object", current.path);
    for (const [key, nested] of Object.entries(entry)) {
      stack.push({
        value: nested,
        depth: current.depth + 1,
        path: `${current.path}.${key}`,
      });
    }
  }
}

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function canonicalStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (entry: unknown, path: string): string => {
    if (entry === null) return "null";
    switch (typeof entry) {
      case "boolean":
        return entry ? "true" : "false";
      case "number":
        if (!Number.isFinite(entry)) fail("Canonical JSON requires finite numbers", path);
        return Object.is(entry, -0) ? "0" : JSON.stringify(entry);
      case "string":
        return JSON.stringify(entry);
      case "object": {
        if (ancestors.has(entry)) fail("Canonical JSON cannot contain cycles", path);
        ancestors.add(entry);
        try {
          if (Array.isArray(entry)) {
            return `[${entry.map((item, index) => serialize(item, `${path}[${index}]`)).join(",")}]`;
          }
          if (!isRecord(entry)) fail("Canonical JSON accepts only plain objects", path);
          const keys = Object.keys(entry).sort();
          return `{${keys
            .map((key) => `${JSON.stringify(key)}:${serialize(entry[key], `${path}.${key}`)}`)
            .join(",")}}`;
        } finally {
          ancestors.delete(entry);
        }
      }
      default:
        fail("Canonical JSON cannot contain undefined, functions, bigint, or symbols", path);
    }
  };
  return serialize(value, "$canonical");
}

export function canonicalRequestString(value: ClientCommitFrame | DurableOperation): string {
  return canonicalStringify(value);
}

export function canonicalRequestHashInput(value: ClientCommitFrame | DurableOperation): Uint8Array {
  return utf8Bytes(canonicalRequestString(value));
}

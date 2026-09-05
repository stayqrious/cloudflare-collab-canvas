import { ZONE_TITLE_PADDING, zoneTitleBandHeight } from "@collab/geometry";
import {
  ASSIST_ACTIONS,
  type AssistAction,
  type Assistance,
  BOARD_FEATURE_KEYS,
  type BoardFeatureKey,
  type BoardFeatures,
  MAX_IMAGE_INTRINSIC_DIMENSION,
  MAX_IMAGE_INTRINSIC_PIXELS,
  MAX_STICKY_TEXT_CODE_POINTS,
  MAX_TABLE_CELL_TEXT_CODE_POINTS,
  MAX_ZONE_TITLE_CODE_POINTS,
  normalizeBoardFeatures,
  normalizeBoardItem,
  resolveTextFontWeight,
  textFontStack,
  validateClientFrame,
  validateDurableOperation,
} from "@collab/protocol";
import { boundsForSvgItems, renderSvgItem, type SvgItemOptions } from "@collab/svg-export";
import {
  buildOrganisationTemplateBatch,
  OrganisationTemplateError,
  organisationTemplateSelectionIssue,
} from "../activities/organisation-templates";
import {
  ACTIVITY_TEMPLATES,
  type ActivityTemplate,
  type ActivityTemplateId,
  buildActivityBatch,
} from "../activities/templates";
import { buildClearVoteDeletes, isVoteTable, summarizeVotes } from "../activities/voting";
import { VIDEO_EMBED_HEIGHT, VIDEO_EMBED_WIDTH, videoEmbedFromText } from "../board/links";
import { mathExportOptions } from "../board/math-export";
import { BoardModel, SequenceError, translateMatrix } from "../board/model";
import { BoardRenderer, STICKY_PADDING } from "../board/renderer";
import { randomBoardName } from "../board-name";
import {
  BRAND_MARK_HTML,
  brandedDocumentTitle,
  PRODUCT_HOME_LABEL,
  PRODUCT_NAME,
} from "../branding";
import { clearTypesetMath, typesetMath } from "../mathjax";
import { DRAWING_COLOR_VALUES, DRAWING_COLORS, STICKY_COLORS, UI_COLORS } from "../palette";
import {
  DurableOutbox,
  type OutboxEntry,
  OutboxLimitError,
  type OutboxRecoveryMetadata,
} from "../persistence/outbox";
import { type ArrangeKind, buildArrangeUpdates } from "../tools/arrange";
import {
  buildCapturedTextUpdate,
  buildImageCreateOperation,
  buildStickyCreateOperation,
  buildTranslationMembershipOperations,
  type CapturedTextEdit,
  DEFAULT_STICKY_HEIGHT,
  DEFAULT_STICKY_WIDTH,
  assignCreatedItemsToSections as decorateCreatedItemsWithSections,
  type ImageAssetMetadata,
  type ShapeVariant,
  sectionIdAfterBoundsChange,
  ToolController,
} from "../tools/controller";
import { explicitGroupClosure, GroupingError } from "../tools/grouping";
import {
  type ApiClient,
  ApiError,
  type AttributedDataExport,
  type BoardImageAsset,
  type FragmentClaim,
  type ManagedInvitation,
  type OrganisationTemplate,
  type OrganisationWebhookSettings,
  type RecoverySnapshot,
} from "../transport/api";
import { BoardSocket } from "../transport/socket";
import type {
  AccessMode,
  Actor,
  BatchItemOperation,
  BoardComment,
  BoardItem,
  BoardSnapshot,
  Bootstrap,
  CommentMedia,
  CommitFrame,
  ConnectionPhase,
  DrawingPolicy,
  DurableOperation,
  HistoryState,
  ImageGeometry,
  Matrix,
  Member,
  Point,
  Presence,
  RemotePreview,
  Role,
  ServerAction,
  ServerFrame,
  SpotlightFrame,
  StampKind,
  TableGeometry,
  TextDecoration,
  TextFontFamily,
  TextFontStyle,
  TextFontWeight,
  ToolName,
} from "../types";
import { canRoleComment, canRoleDraw, createId, PROTOCOL_VERSION } from "../types";
import { ActivityTemplateWebMcp } from "../webmcp/activity-templates";
import { BoardWriteWebMcp, type StickyMove } from "../webmcp/board-writes";
import { ClassDecisionWebMcp } from "../webmcp/class-decision";
import { CollectiveInquiryWebMcp } from "../webmcp/collective-inquiry";
import { EducationPartnerWebMcp, type EducationVisualSource } from "../webmcp/education-partner";
import { InquiryMapWebMcp } from "../webmcp/inquiry-map";
import {
  ASSIST_GUIDANCE,
  ASSIST_NOTE_MAX_LENGTH,
  assistActionLabel,
  PROBLEM_STEP_WATCH_DURATION_MS,
  type WatchState,
} from "../webmcp/problem-step-watch";
import {
  isVisibleWebMcpActivityCall,
  observeWebMcpRegistry,
  type WebMcpRegistryState,
  webMcpRegistryState,
} from "../webmcp/shared";
import { MathFieldPanel } from "./math-field";
import {
  type MathRegion,
  mathRegionAtCaret,
  replaceMathRegion,
  unclosedOpeningAt,
} from "./math-region";

// The four-point glitter mark is the conventional "ask the AI" affordance: a sparkle rather than
// an "AI" badge, so the button reads as a request you can make and twinkles under the pointer.
const aiSparkleIcon = (extraClass = ""): string =>
  `<span class="ai-sparkle${extraClass ? ` ${extraClass}` : ""}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" focusable="false" aria-hidden="true"><path class="ai-sparkle-core" d="M10.5 4Q10.5 12.5 19 12.5Q10.5 12.5 10.5 21Q10.5 12.5 2 12.5Q10.5 12.5 10.5 4Z"/><path class="ai-sparkle-spark" d="M18.5 1.5Q18.5 5 22 5Q18.5 5 18.5 8.5Q18.5 5 15 5Q18.5 5 18.5 1.5Z"/><path class="ai-sparkle-spark ai-sparkle-spark-late" d="M19.5 15.5Q19.5 18 22 18Q19.5 18 19.5 20.5Q19.5 18 17 18Q19.5 18 19.5 15.5Z"/></svg></span>`;

const TOOL_DEFINITIONS: Array<{
  name: ToolName;
  label: string;
  shortcut: string;
  glyph: string;
  iconSvg?: string;
  dockLabel: string;
}> = [
  { name: "select", label: "Select and move", dockLabel: "Select", shortcut: "V", glyph: "↖" },
  { name: "pan", label: "Pan canvas", dockLabel: "Hand", shortcut: "H", glyph: "✋" },
  { name: "pencil", label: "Pencil", dockLabel: "Draw", shortcut: "P", glyph: "✎" },
  { name: "line", label: "Straight line", dockLabel: "Line", shortcut: "L", glyph: "╱" },
  {
    name: "rectangle",
    label: "Shapes",
    dockLabel: "Shape",
    shortcut: "R",
    glyph: "",
    iconSvg:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M12 4 21 20H3Z"/></svg>',
  },
  { name: "text", label: "Text", dockLabel: "Text", shortcut: "T", glyph: "T" },
  {
    name: "sticky",
    label: "Sticky note",
    dockLabel: "Sticky",
    shortcut: "N",
    glyph: "",
    iconSvg:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M5 3h14v12l-6 6H5Z"/><path d="M13 21v-6h6"/></svg>',
  },
  {
    name: "image",
    label: "Add image",
    dockLabel: "Image",
    shortcut: "I",
    glyph: "",
    iconSvg:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
  },
  { name: "table", label: "Table", dockLabel: "Table", shortcut: "G", glyph: "▦" },
  { name: "stamp", label: "Stamp", dockLabel: "Stamp", shortcut: "K", glyph: "★" },
  {
    name: "zone",
    label: "Section",
    dockLabel: "Section",
    shortcut: "Z",
    glyph: "",
    iconSvg:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M8 8h8v8H8z" opacity=".45"/></svg>',
  },
  {
    name: "eraser",
    label: "Eraser",
    dockLabel: "Eraser",
    shortcut: "E",
    glyph: "",
    iconSvg:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="m7 21-4-4a2.83 2.83 0 0 1 0-4L13.1 2.9a2.83 2.83 0 0 1 4 0l4 4a2.83 2.83 0 0 1 0 4L11 21"/><path d="m5 11 9 9"/><path d="M21 21H7"/></svg>',
  },
];

const MORE_TOOL_NAMES = new Set<ToolName>(["stamp", "image", "table", "protractor"]);

const DRAW_TOOLS = new Set<ToolName>([
  "pencil",
  "line",
  "rectangle",
  "ellipse",
  "polygon",
  "text",
  "sticky",
  "stamp",
  "image",
  "table",
  "zone",
  "eraser",
  "protractor",
]);

const SHAPE_CHOICES: ReadonlyArray<{
  variant: ShapeVariant;
  label: string;
  glyph: string;
  tool: Extract<ToolName, "rectangle" | "ellipse" | "polygon">;
}> = [
  { variant: "square", label: "Square", glyph: "□", tool: "rectangle" },
  { variant: "rectangle", label: "Rectangle", glyph: "▭", tool: "rectangle" },
  { variant: "triangle", label: "Triangle", glyph: "△", tool: "polygon" },
  { variant: "rhombus", label: "Rhombus", glyph: "◇", tool: "polygon" },
  { variant: "pentagon", label: "Pentagon", glyph: "⬠", tool: "polygon" },
  { variant: "hexagon", label: "Hexagon", glyph: "⬡", tool: "polygon" },
  { variant: "circle", label: "Circle", glyph: "○", tool: "ellipse" },
];

const FEATURE_LABELS: Readonly<Record<BoardFeatureKey, { label: string; detail: string }>> = {
  pencil: { label: "Pencil", detail: "Freehand drawing" },
  line: { label: "Lines", detail: "Straight line tool" },
  lineSnapping: { label: "Line snapping", detail: "Snap endpoints to nearby edges" },
  square: { label: "Square", detail: "Square shape preset" },
  rectangle: { label: "Rectangle", detail: "Rectangle shape preset" },
  triangle: { label: "Triangle", detail: "Triangle shape preset" },
  rhombus: { label: "Rhombus", detail: "Rhombus shape preset" },
  pentagon: { label: "Pentagon", detail: "Pentagon shape preset" },
  hexagon: { label: "Hexagon", detail: "Hexagon shape preset" },
  circle: { label: "Circle", detail: "Circle shape preset" },
  text: { label: "Text", detail: "Canvas text" },
  stickyNotes: { label: "Sticky notes", detail: "Resizable note cards" },
  stamps: { label: "Stickers", detail: "Stamps and reactions" },
  images: { label: "Images", detail: "Upload image cards" },
  tables: { label: "Tables", detail: "Resizable grids" },
  sections: { label: "Sections", detail: "Organise areas of the Space" },
  protractor: { label: "Protractor", detail: "Movable 180° measuring tool" },
  eraser: { label: "Eraser", detail: "Erase board work" },
  partialEraser: { label: "Partial eraser", detail: "Cut only touched line segments" },
  objectTransforms: { label: "Scale and rotate", detail: "Transform shapes, images, and tools" },
  grouping: { label: "Grouping", detail: "Move and copy related items together" },
  templates: { label: "Templates", detail: "Built-in starter layouts" },
  organisationTemplates: { label: "Organisation templates", detail: "Shared reusable layouts" },
  voting: { label: "Voting", detail: "Vote controls on templates" },
  spotlight: { label: "Follow me", detail: "Coach-led viewport spotlight" },
};

/**
 * A template that seeds a vote is hidden rather than disabled when voting is off, as the stamp
 * vote always has been. Both such templates are covered here so the activities menu, the WebMCP
 * catalogue, and the insert can never disagree about what this Space offers.
 */
export function templateHiddenByVoting(
  templateId: ActivityTemplateId,
  features: BoardFeatures,
): boolean {
  return (
    (templateId === "vote-with-stamps" || templateId === "collective-inquiry-demo") &&
    !features.voting
  );
}

/** Why this Space cannot take a WebMCP-written object of this kind, or null when it can. */
export function webMcpWriteFeatureIssue(
  kind: "sticky" | "image" | "video",
  features: BoardFeatures,
): string | null {
  if (kind === "sticky") {
    return features.stickyNotes ? null : "Enable sticky notes to add one to this Space.";
  }
  if (kind === "image") {
    return features.images ? null : "Enable images to add an image card to this Space.";
  }
  // A video embed is a canvas text object carrying a video link, so it follows the text feature.
  return features.text ? null : "Enable text to embed a video in this Space.";
}

/** Why this board cannot insert the template, or null when it can. */
export function templateAvailabilityIssue(
  template: ActivityTemplate,
  features: BoardFeatures,
): string | null {
  if (!features.templates) return "Enable templates to use this template.";
  if (templateHiddenByVoting(template.id, features)) {
    return "Enable voting to use this template.";
  }
  return templateFeatureIssue(template.items, features);
}

export function templateFeatureIssue(
  items: readonly { kind: string; geometry?: unknown; transform?: readonly number[] }[],
  features: BoardFeatures,
): string | null {
  const unavailable = new Set<BoardFeatureKey>();
  for (const item of items) {
    const feature = featureForTemplateItem(item);
    if (feature !== null && !features[feature]) unavailable.add(feature);
    if (
      !features.objectTransforms &&
      Array.isArray(item.transform) &&
      [1, 0, 0, 1].some((expected, index) => item.transform?.[index] !== expected)
    ) {
      unavailable.add("objectTransforms");
    }
    if (
      item.geometry !== null &&
      typeof item.geometry === "object" &&
      !Array.isArray(item.geometry) &&
      Array.isArray((item.geometry as Record<string, unknown>).visiblePaths) &&
      (!features.eraser || !features.partialEraser)
    ) {
      unavailable.add("partialEraser");
    }
  }
  if (unavailable.size === 0) return null;
  const labels = [...unavailable].map((feature) => FEATURE_LABELS[feature].label);
  return `Enable ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(labels)} to use this template.`;
}

function featureForTemplateItem(item: {
  kind: string;
  geometry?: unknown;
}): BoardFeatureKey | null {
  const geometry =
    item.geometry !== null && typeof item.geometry === "object" && !Array.isArray(item.geometry)
      ? (item.geometry as Record<string, unknown>)
      : {};
  if (item.kind === "rectangle") return geometry.shape === "square" ? "square" : "rectangle";
  if (item.kind === "polygon") {
    const polygon = geometry.polygon;
    return polygon === "triangle" ||
      polygon === "rhombus" ||
      polygon === "pentagon" ||
      polygon === "hexagon"
      ? polygon
      : null;
  }
  switch (item.kind) {
    case "pencil":
    case "line":
    case "text":
    case "protractor":
      return item.kind;
    case "image":
      return "images";
    case "table":
      return "tables";
    case "ellipse":
      return "circle";
    case "sticky":
      return "stickyNotes";
    case "stamp":
      return "stamps";
    case "zone":
      return "sections";
    default:
      return null;
  }
}

const BRUSH_PRESETS = {
  pen: { width: 2, opacity: 1 },
  marker: { width: 10, opacity: 1 },
  highlighter: { width: 20, opacity: 0.35 },
} as const;

type BrushPreset = keyof typeof BRUSH_PRESETS;

const SPOTLIGHT_UPDATE_THROTTLE_MS = 100;
const SPOTLIGHT_HEARTBEAT_MS = 1_000;
const SPOTLIGHT_STALE_MS = 3_500;

type FollowedSpotlight = {
  spotlightId: string;
  actorId: string;
  connectionId: string;
  displayName: string;
  updatedAt: number;
};

type StyleState = {
  color: string;
  width: number;
  opacity: number;
  lineArrowhead: "none" | "arrow";
  shapeVariant: ShapeVariant;
  fontSize: number;
  fontFamily: TextFontFamily;
  stickyFill: string;
  stickyTextColor: string;
  stickyFontSize: number;
  stickyOpacity: number;
  stampKind: StampKind;
  stampColor: string;
  stampOpacity: number;
  tableRows: number;
  tableColumns: number;
  tableHeaderRow: boolean;
};

type StickyDraftRecovery = {
  itemId?: string;
  draftItemId: string;
  point: Point;
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

export const IMAGE_UPLOAD_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1_024 * 1_024;
export const MAX_IMAGE_ALT_CODE_POINTS = 500;

class ImagePreparationError extends Error {}

type ImageAltEdit = {
  itemId: string;
  expectedVersion: number;
  geometry: ImageGeometry;
};

type TableCellEdit = {
  itemId: string;
  expectedVersion: number;
  geometry: TableGeometry;
  row: number;
  column: number;
};

type TableCellDraftRecovery = {
  itemId: string;
  row: number;
  column: number;
  text: string;
  selectionStart: number;
  selectionEnd: number;
};

type ZoneTitleEdit = {
  itemId: string;
  expectedVersion: number;
  geometry: Extract<BoardItem, { kind: "zone" }>["geometry"];
};

type ZoneTitleDraftRecovery = {
  itemId: string;
  title: string;
  selectionStart: number;
  selectionEnd: number;
};

export function imageUploadIssue(image: Pick<Blob, "size" | "type">): string | null {
  if (!IMAGE_UPLOAD_MIME_TYPES.includes(image.type as (typeof IMAGE_UPLOAD_MIME_TYPES)[number])) {
    return "Choose a PNG, JPEG, WebP, or GIF image.";
  }
  if (image.size < 1) return "That image file is empty.";
  if (image.size > MAX_IMAGE_UPLOAD_BYTES) return "Choose an image no larger than 5 MiB.";
  return null;
}

async function privacySafeImageUpload(image: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image, { imageOrientation: "from-image" });
  } catch {
    throw new ImagePreparationError("That image could not be read.");
  }

  try {
    if (
      bitmap.width < 1 ||
      bitmap.height < 1 ||
      bitmap.width > MAX_IMAGE_INTRINSIC_DIMENSION ||
      bitmap.height > MAX_IMAGE_INTRINSIC_DIMENSION ||
      bitmap.width * bitmap.height > MAX_IMAGE_INTRINSIC_PIXELS
    ) {
      throw new ImagePreparationError(
        `Choose an image no larger than ${MAX_IMAGE_INTRINSIC_DIMENSION}px per side and 16 megapixels.`,
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new ImagePreparationError("That image could not be prepared safely.");
    context.drawImage(bitmap, 0, 0);

    const outputType =
      image.type === "image/jpeg"
        ? "image/jpeg"
        : image.type === "image/webp"
          ? "image/webp"
          : "image/png";
    const prepared = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outputType, 0.92),
    );
    if (!prepared) throw new ImagePreparationError("That image could not be prepared safely.");
    const issue = imageUploadIssue(prepared);
    if (issue) throw new ImagePreparationError(issue);
    return prepared;
  } finally {
    bitmap.close();
  }
}

const MEME_CANVAS_WIDTH = 1_200;
const MEME_CANVAS_HEIGHT = 675;

const MEME_PALETTES: Record<
  Extract<EducationVisualSource, { format: "meme_card" }>["palette"],
  readonly [string, string, string]
> = {
  sunset: ["#ff7657", "#ffbd59", "#642b73"],
  ocean: ["#006d77", "#00b4d8", "#caf0f8"],
  lime: ["#1b4332", "#70e000", "#d8f3dc"],
  violet: ["#3c096c", "#9d4edd", "#ff9eeb"],
  chalkboard: ["#172a24", "#315c4c", "#f4e8c1"],
  confetti: ["#ff4d6d", "#4361ee", "#ffd60a"],
};

function inlineImageDataUrlBlob(value: string): Blob {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new ImagePreparationError(
      "The generated image must be an inline PNG, JPEG, WebP, or GIF.",
    );
  }
  let decoded: string;
  try {
    decoded = atob(match[2]);
  } catch {
    throw new ImagePreparationError("The generated image data could not be decoded.");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  const blob = new Blob([bytes], { type: match[1] });
  const issue = imageUploadIssue(blob);
  if (issue) throw new ImagePreparationError(issue);
  return blob;
}

async function educationVisualBlob(source: EducationVisualSource): Promise<Blob> {
  if (source.format === "inline_image") return inlineImageDataUrlBlob(source.imageDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = MEME_CANVAS_WIDTH;
  canvas.height = MEME_CANVAS_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new ImagePreparationError("The class meme could not be rendered.");
  const colors = MEME_PALETTES[source.palette];
  const gradient = context.createLinearGradient(0, 0, MEME_CANVAS_WIDTH, MEME_CANVAS_HEIGHT);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.58, colors[1]);
  gradient.addColorStop(1, colors[2]);
  context.fillStyle = gradient;
  context.fillRect(0, 0, MEME_CANVAS_WIDTH, MEME_CANVAS_HEIGHT);

  context.fillStyle = "rgba(12, 10, 22, 0.3)";
  context.fillRect(0, 0, MEME_CANVAS_WIDTH, 172);
  context.fillRect(0, MEME_CANVAS_HEIGHT - 196, MEME_CANVAS_WIDTH, 196);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "180px sans-serif";
  context.fillStyle = "rgba(255, 255, 255, 0.95)";
  context.fillText(source.emoji, MEME_CANVAS_WIDTH / 2, MEME_CANVAS_HEIGHT / 2 + 4);
  drawMemeCopy(context, source.headline.toLocaleUpperCase(), 82, 56, 2);
  drawMemeCopy(context, source.punchline.toLocaleUpperCase(), MEME_CANVAS_HEIGHT - 98, 50, 3);

  const rendered = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!rendered) throw new ImagePreparationError("The class meme could not be rendered.");
  return rendered;
}

function drawMemeCopy(
  context: CanvasRenderingContext2D,
  text: string,
  centerY: number,
  initialFontSize: number,
  maxLines: number,
): void {
  let fontSize = initialFontSize;
  let lines: string[] = [];
  while (fontSize >= 30) {
    context.font = `800 ${fontSize}px sans-serif`;
    lines = wrapCanvasText(context, text, MEME_CANVAS_WIDTH - 100);
    if (lines.length <= maxLines) break;
    fontSize -= 4;
  }
  lines = lines.slice(0, maxLines);
  const lineHeight = fontSize * 1.08;
  const firstY = centerY - ((lines.length - 1) * lineHeight) / 2;
  context.lineJoin = "round";
  context.lineWidth = Math.max(5, fontSize / 9);
  context.strokeStyle = "rgba(18, 13, 28, 0.94)";
  context.fillStyle = "#ffffff";
  lines.forEach((line, index) => {
    const y = firstY + index * lineHeight;
    context.strokeText(line, MEME_CANVAS_WIDTH / 2, y);
    context.fillText(line, MEME_CANVAS_WIDTH / 2, y);
  });
}

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/u)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function clampImageAlt(value: string): string {
  return [...value].slice(0, MAX_IMAGE_ALT_CODE_POINTS).join("");
}

export function clampTableCellText(value: string): string {
  return [...value].slice(0, MAX_TABLE_CELL_TEXT_CODE_POINTS).join("");
}

export function clampZoneTitle(value: string): string {
  return [...value].slice(0, MAX_ZONE_TITLE_CODE_POINTS).join("");
}

export { STICKY_COLORS } from "../palette";

export function elementColour(item: BoardItem): string | null {
  switch (item.kind) {
    case "sticky":
    case "table":
    case "zone":
      return item.style.fill;
    case "image":
      return null;
    case "text":
      return item.geometry.embed === "video" ? null : item.style.color;
    default:
      return item.style.color;
  }
}

export function buildElementColourOperations(
  items: readonly BoardItem[],
  color: string,
): BatchItemOperation[] {
  if (
    items.length === 0 ||
    items.some((item) => item.version <= 0 || elementColour(item) === null)
  ) {
    return [];
  }
  return items.flatMap((item) => {
    if (item.kind === "image" || (item.kind === "text" && item.geometry.embed === "video")) {
      return [];
    }
    const nextStyle =
      item.kind === "sticky" || item.kind === "table" || item.kind === "zone"
        ? item.style.fill === color
          ? null
          : { ...item.style, fill: color }
        : item.style.color === color
          ? null
          : { ...item.style, color };
    return nextStyle
      ? [
          {
            kind: "item.update" as const,
            itemId: item.id,
            expectedVersion: item.version,
            patch: { style: nextStyle },
          },
        ]
      : [];
  });
}

export type TextStylePatch = {
  fontFamily?: TextFontFamily;
  fontSize?: number;
  fontWeight?: TextFontWeight;
  fontStyle?: TextFontStyle;
  textDecoration?: TextDecoration;
};

type TextWeightItem = {
  kind: "text" | "sticky" | "table" | "zone";
  style: { fontWeight?: TextFontWeight };
};

type TextStyleItem = Extract<BoardItem, { kind: "text" | "sticky" | "table" | "zone" }>;

function supportsTextStyling(item: BoardItem): item is TextStyleItem {
  return (
    (item.kind === "text" && item.geometry.embed !== "video") ||
    item.kind === "sticky" ||
    item.kind === "table" ||
    item.kind === "zone"
  );
}

export function effectiveTextFontWeight(item: TextWeightItem): TextFontWeight {
  return item.style.fontWeight ?? (item.kind === "zone" ? "bold" : "normal");
}

export function buildTextStyleOperations(
  items: readonly BoardItem[],
  patch: TextStylePatch,
  allItems: Iterable<BoardItem> = items,
  assignNewMembership = true,
): BatchItemOperation[] {
  const textItems = items.filter(supportsTextStyling);
  if (
    textItems.length !== items.length ||
    textItems.length === 0 ||
    textItems.some((item) => item.version <= 0)
  ) {
    return [];
  }
  const boardItems = [...allItems];
  return textItems.flatMap((item) => {
    const nextStyle = { ...item.style, ...patch };
    const changed = (Object.keys(patch) as Array<keyof TextStylePatch>).some(
      (key) => nextStyle[key] !== item.style[key],
    );
    if (!changed) return [];
    const sectionId =
      item.kind === "text" && patch.fontSize !== undefined
        ? sectionIdAfterBoundsChange(
            boardItems,
            { ...item, style: nextStyle } as Extract<BoardItem, { kind: "text" }>,
            assignNewMembership,
          )
        : item.sectionId;
    return [
      {
        kind: "item.update" as const,
        itemId: item.id,
        expectedVersion: item.version,
        patch: {
          style: nextStyle,
          ...(sectionId === item.sectionId ? {} : { sectionId: sectionId ?? null }),
        },
      } as BatchItemOperation,
    ];
  });
}

export function savedAuthoritativeItems(
  itemIds: readonly string[],
  renderedItems: ReadonlyMap<string, BoardItem>,
  authoritativeItems: ReadonlyMap<string, BoardItem>,
): BoardItem[] | null {
  const result: BoardItem[] = [];
  for (const itemId of itemIds) {
    const rendered = renderedItems.get(itemId);
    const authoritative = authoritativeItems.get(itemId);
    if (
      !rendered ||
      rendered.version <= 0 ||
      !authoritative ||
      authoritative.version !== rendered.version
    ) {
      return null;
    }
    result.push(authoritative);
  }
  return result;
}

/**
 * Why a set of per-note translations would tear apart objects the board moves as one, or null
 * when it would not.
 *
 * `buildTranslationMembershipOperations` spreads a move outwards to a fixed point over two
 * relations — everything sharing an explicit group travels together, and a Section that moves
 * carries its members — but it never overrides a delta the call supplied. So when that spread
 * reaches another named note holding a different delta, the two end up translated by different
 * amounts while still grouped, or with a member drifting away from the Section it still claims:
 * states no drag can produce, because a drag moves a whole selection by one delta.
 *
 * The walk mirrors that spread rather than approximating it. In particular the Section relation
 * is one-way: a Section carries its members, but a member does not carry its Section, so two
 * notes that merely share a Section are independent and are not refused. A note that already
 * holds its own delta stops the walk, exactly as a direct update stops the propagation; its own
 * walk covers whatever lies beyond it.
 */
export function conflictingMoveIssue(
  named: readonly BoardItem[],
  deltaById: ReadonlyMap<string, { x: number; y: number }>,
  boardItems: Iterable<BoardItem>,
): string | null {
  const byGroup = new Map<string, BoardItem[]>();
  const bySection = new Map<string, BoardItem[]>();
  for (const item of boardItems) {
    if (item.groupId) byGroup.set(item.groupId, [...(byGroup.get(item.groupId) ?? []), item]);
    if (item.sectionId) {
      bySection.set(item.sectionId, [...(bySection.get(item.sectionId) ?? []), item]);
    }
  }
  const requested = new Map(named.map((item) => [item.id, deltaById.get(item.id) ?? ZERO_DELTA]));

  for (const start of named) {
    const delta = requested.get(start.id) ?? ZERO_DELTA;
    const seen = new Set([start.id]);
    const queue: BoardItem[] = [start];
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!item) continue;
      const carried = [
        ...(item.groupId ? (byGroup.get(item.groupId) ?? []) : []),
        ...(item.kind === "zone" ? (bySection.get(item.id) ?? []) : []),
      ];
      for (const related of carried) {
        if (seen.has(related.id)) continue;
        seen.add(related.id);
        const other = requested.get(related.id);
        if (other) {
          if (other.x !== delta.x || other.y !== delta.y) return CONFLICTING_MOVE_MESSAGE;
          // Its own delta is what spreads from here, and its own walk already covers that.
          continue;
        }
        queue.push(related);
      }
    }
  }
  return null;
}

const ZERO_DELTA = { x: 0, y: 0 } as const;

const CONFLICTING_MOVE_MESSAGE =
  "Some of these notes are grouped together, or sit in a Section another of them carries, so the board moves them as one unit. Sending them to different places would pull that unit apart. Give every note the board moves together the same shift — a note asked to stay put counts as a different shift — or name just one of them and let the rest follow it.";

export function lockedSectionIdForItem(
  item: BoardItem,
  items: ReadonlyMap<string, BoardItem>,
): string | null {
  if (item.kind === "zone" && item.geometry.locked === true) return item.id;
  if (item.sectionId === undefined) return null;
  const section = items.get(item.sectionId);
  return section?.kind === "zone" && section.geometry.locked === true ? section.id : null;
}

function sectionLockChange(
  operation: BatchItemOperation,
  items: ReadonlyMap<string, BoardItem>,
): { section: Extract<BoardItem, { kind: "zone" }>; locked: boolean } | null {
  if (operation.kind !== "item.update" || operation.patch.geometry === undefined) return null;
  const section = items.get(operation.itemId);
  if (section?.kind !== "zone") return null;
  const geometry = operation.patch.geometry as Partial<typeof section.geometry>;
  const locked = geometry.locked === true;
  return locked === (section.geometry.locked === true) ? null : { section, locked };
}

function pureSectionLockChange(
  operation: BatchItemOperation,
  section: Extract<BoardItem, { kind: "zone" }>,
): boolean {
  if (
    operation.kind !== "item.update" ||
    operation.patch.geometry === undefined ||
    Object.keys(operation.patch).length !== 1
  ) {
    return false;
  }
  const geometry = operation.patch.geometry;
  return (
    "title" in geometry &&
    geometry.x === section.geometry.x &&
    geometry.y === section.geometry.y &&
    geometry.width === section.geometry.width &&
    geometry.height === section.geometry.height &&
    geometry.title === section.geometry.title &&
    (geometry.locked === true) !== (section.geometry.locked === true)
  );
}

export function operationBlockedBySectionLock(
  operation: DurableOperation,
  role: Role,
  items: ReadonlyMap<string, BoardItem>,
): boolean {
  if (operation.kind === "board.clear") {
    return [...items.values()].some(
      (item) => item.kind === "zone" && item.geometry.locked === true,
    );
  }
  if (operation.kind === "history.undo" || operation.kind === "history.redo") return false;
  const operations = operation.kind === "items.batch" ? operation.operations : [operation];
  const lockChanges = operations.flatMap((child) => {
    const change = sectionLockChange(child, items);
    return change === null ? [] : [{ operation: child, ...change }];
  });
  const [lockChange] = lockChanges;
  if (
    lockChange !== undefined &&
    (role !== "owner" ||
      operations.length !== 1 ||
      lockChanges.length !== 1 ||
      !pureSectionLockChange(lockChange.operation, lockChange.section))
  ) {
    return true;
  }

  for (const child of operations) {
    if (
      child.kind === "item.create" &&
      child.item.kind === "zone" &&
      child.item.geometry.locked === true &&
      role !== "owner"
    ) {
      return true;
    }
    const source =
      child.kind === "item.create"
        ? undefined
        : items.get(child.kind === "item.copy" ? child.sourceItemId : child.itemId);
    if (source?.kind === "zone" && source.geometry.locked === true) {
      const change = sectionLockChange(child, items);
      if (
        change !== null &&
        role === "owner" &&
        change.locked === false &&
        pureSectionLockChange(child, source)
      ) {
        continue;
      }
      return true;
    }
    if (source && lockedSectionIdForItem(source, items) !== null) return true;
    const prospectiveSectionId =
      child.kind === "item.create"
        ? child.item.sectionId
        : child.kind === "item.update"
          ? typeof child.patch.sectionId === "string"
            ? child.patch.sectionId
            : undefined
          : child.kind === "item.copy" && typeof child.newSectionId === "string"
            ? child.newSectionId
            : undefined;
    if (prospectiveSectionId !== undefined) {
      const section = items.get(prospectiveSectionId);
      if (section?.kind === "zone" && section.geometry.locked === true) return true;
    }
  }
  return false;
}

export type OperationDenial = "section-locked" | "ownership";

/**
 * Explains why the local actor may not commit `operation`, or returns null
 * when it is allowed. The Section-lock scan runs exactly once here; callers
 * that need to pick a message should use this rather than re-running it.
 */
export function operationDenialForActor(
  operation: DurableOperation,
  role: Role,
  actorId: string,
  authoritativeItems: ReadonlyMap<string, BoardItem>,
): OperationDenial | null {
  if (operationBlockedBySectionLock(operation, role, authoritativeItems)) return "section-locked";
  if (role === "owner") return null;
  if (role !== "editor") return "ownership";
  if (operation.kind === "history.undo" || operation.kind === "history.redo") return null;
  if (operation.kind === "board.clear") return "ownership";

  const ownedItemIds = new Set(
    [...authoritativeItems.values()]
      .filter((item) => item.createdBy === actorId)
      .map((item) => item.id),
  );
  const operations = operation.kind === "items.batch" ? operation.operations : [operation];
  for (const child of operations) {
    if (child.kind === "item.create") {
      ownedItemIds.add(child.item.id);
    } else if (child.kind === "item.copy") {
      ownedItemIds.add(child.newItemId);
    } else if (!ownedItemIds.has(child.itemId)) {
      if (!isOwnSectionDetach(child, actorId, authoritativeItems)) return "ownership";
    } else if (child.kind === "item.delete") {
      ownedItemIds.delete(child.itemId);
    }
  }
  return null;
}

export function operationAllowedForActor(
  operation: DurableOperation,
  role: Role,
  actorId: string,
  authoritativeItems: ReadonlyMap<string, BoardItem>,
): boolean {
  return operationDenialForActor(operation, role, actorId, authoritativeItems) === null;
}

/**
 * A Section's creator may detach members they do not own from that Section.
 * Membership is assigned by geometry, so the creator must be able to reverse
 * it (and delete the Section) without the member's author. Only a bare
 * `{ sectionId: null }` patch qualifies; the edge enforces the same rule.
 */
function isOwnSectionDetach(
  child: BatchItemOperation,
  actorId: string,
  items: ReadonlyMap<string, BoardItem>,
): boolean {
  if (child.kind !== "item.update") return false;
  const patch = child.patch as Record<string, unknown>;
  if (Object.keys(patch).length !== 1 || patch.sectionId !== null) return false;
  const member = items.get(child.itemId);
  const section = member?.sectionId === undefined ? undefined : items.get(member.sectionId);
  return section?.kind === "zone" && section.createdBy === actorId;
}

export function buildCreatorNameMap(creators: readonly Actor[], self: Actor): Map<string, string> {
  const result = new Map<string, string>();
  for (const creator of [...creators, self]) {
    const displayName = creator.displayName.trim();
    if (displayName) result.set(creator.id, displayName);
  }
  return result;
}

export function actorFromAccessChanged(frame: ServerFrame): Actor | null {
  const actor = frame.affectedActor;
  if (!isRecord(actor) || Object.keys(actor).length !== 2) return null;
  if (
    typeof frame.affectedActorId !== "string" ||
    typeof actor.id !== "string" ||
    actor.id !== frame.affectedActorId ||
    !/^a_[A-Za-z\d_-]{22}$/u.test(actor.id)
  ) {
    return null;
  }
  if (
    typeof actor.displayName !== "string" ||
    actor.displayName.trim() !== actor.displayName ||
    [...actor.displayName].length < 1 ||
    [...actor.displayName].length > 40 ||
    /\p{Cc}/u.test(actor.displayName)
  ) {
    return null;
  }
  return { id: actor.id, displayName: actor.displayName };
}

export function organisationTemplateManagementForRole(
  organisationId: string | null,
  role: Role,
): boolean | null {
  return organisationId === null ? null : role === "owner";
}

export const STAMP_CHOICES: ReadonlyArray<{ kind: StampKind; name: string; glyph: string }> = [
  { kind: "star", name: "Star", glyph: "★" },
  { kind: "check", name: "Check", glyph: "✓" },
  { kind: "heart", name: "Heart", glyph: "♥" },
  { kind: "question", name: "Question mark", glyph: "?" },
  { kind: "smile", name: "Smile", glyph: "☺" },
  { kind: "sparkle", name: "Sparkle", glyph: "✦" },
];

export class BoardApp {
  private readonly model = new BoardModel();
  private readonly outbox = new DurableOutbox();
  private readonly renderer: BoardRenderer;
  private readonly tools: ToolController;
  private readonly socket: BoardSocket;
  private webMcp: CollectiveInquiryWebMcp | null = null;
  private inquiryMapWebMcp: InquiryMapWebMcp | null = null;
  private classDecisionWebMcp: ClassDecisionWebMcp | null = null;
  private educationPartnerWebMcp: EducationPartnerWebMcp | null = null;
  private activityTemplateWebMcp: ActivityTemplateWebMcp | null = null;
  private boardWriteWebMcp: BoardWriteWebMcp | null = null;
  private readonly pendingWebMcpCommits = new PendingCommitTracker();
  /** True until the board first becomes editable, when the landing tool is chosen. */
  private landingToolPending = true;
  private aiWatchState: WatchState = { phase: "idle", expiresAt: null, watchedItemIds: new Set() };
  private webMcpState: WebMcpRegistryState = webMcpRegistryState();
  private stopObservingWebMcp: (() => void) | null = null;
  private mathFieldPanel: MathFieldPanel | null = null;
  private mathFieldTarget: {
    editor: HTMLTextAreaElement | HTMLInputElement;
    region: MathRegion;
    onValueChanged: () => void;
    /** Finishes the edit the field belongs to, as that editor's own blur would. */
    finish: (save: boolean) => void;
  } | null = null;
  private webMcpWatchCountdown: number | null = null;
  private aiAssistSelectionKey = "";
  private readonly pendingRenderedTextSectionUpdates = new Set<string>();
  private bootstrap: Bootstrap;
  private phase: ConnectionPhase = "idle";
  private history: HistoryState;
  private style: StyleState = {
    color: DRAWING_COLOR_VALUES.ink,
    width: 2,
    opacity: 1,
    lineArrowhead: "none",
    shapeVariant: "rectangle",
    fontSize: 20,
    fontFamily: "sans",
    stickyFill: STICKY_COLORS[0].value,
    stickyTextColor: UI_COLORS.ink,
    stickyFontSize: 20,
    stickyOpacity: 1,
    stampKind: "star",
    stampColor: DRAWING_COLOR_VALUES.red,
    stampOpacity: 1,
    tableRows: 3,
    tableColumns: 3,
    tableHeaderRow: false,
  };
  private readonly remotePreviews = new Map<string, RemotePreview>();
  private readonly presences = new Map<string, Presence>();
  private readonly creatorNames = new Map<string, string>();
  private readonly ignoredSpotlightIds = new Set<string>();
  private readonly localSpotlightIds = new Set<string>();
  private broadcastSpotlightId: string | null = null;
  private followedSpotlight: FollowedSpotlight | null = null;
  private spotlightHeartbeatTimer: number | null = null;
  private spotlightUpdateTimer: number | null = null;
  private spotlightLastSentAt = 0;
  private unsubscribeViewport: (() => void) | null = null;
  private expiredRecovery: OutboxEntry[] = [];
  private previewExpiryTimer: number;
  private textEditor: HTMLTextAreaElement | null = null;
  private textEditContext: CapturedTextEdit | null = null;
  private textEditorMode: "text" | "sticky" | null = null;
  private textEditorPreview: (() => void) | null = null;
  private textEditorClosing = false;
  private textEditorCloseAttempt = 0;
  private imageUploadInFlight = false;
  private videoEmbedPending = false;
  private imageAltEdit: ImageAltEdit | null = null;
  private tableCellEditor: HTMLTextAreaElement | null = null;
  private tableCellEdit: TableCellEdit | null = null;
  private zoneTitleEditor: HTMLInputElement | null = null;
  private zoneTitleEdit: ZoneTitleEdit | null = null;
  private readonly pendingStickyDrafts = new Map<string, StickyDraftRecovery>();
  private readonly rejectedStickyDrafts: StickyDraftRecovery[] = [];
  private readonly pendingTableCellDrafts = new Map<string, TableCellDraftRecovery>();
  private readonly rejectedTableCellDrafts: TableCellDraftRecovery[] = [];
  private readonly pendingZoneTitleDrafts = new Map<string, ZoneTitleDraftRecovery>();
  private readonly rejectedZoneTitleDrafts: ZoneTitleDraftRecovery[] = [];
  private readonly pendingNewZoneTitles = new Set<string>();
  private readonly comments = new CommentStore(
    (itemId) => this.model.getItem(itemId) !== undefined,
  );
  private readonly commentsResolving = new Set<string>();
  private activeCommentTargetId: string | null = null;
  /** The one object whose comments the drawer shows, when opened from its marker. */
  private commentsFocusItemId: string | null = null;
  private showHiddenComments = false;
  private commentSubmitting = false;
  private commentsLoading = true;
  /** The picture or video the composer will send with the next comment, if any. */
  private pendingCommentMedia: CommentMedia | null = null;
  private commentImageUploading = false;
  /** The comment whose video the participant is playing in the drawer, if any. */
  private playingCommentVideoId: string | null = null;
  /** Set when a render was withheld to keep a playing comment video alive. */
  private commentsRenderPending = false;
  /** Object URLs for the pictures comments carry, one per asset, revoked on teardown. */
  private readonly commentImageUrls = new Map<string, Promise<string>>();
  private accessMembers: Member[] = [];
  private readonly participantRoleChangesPending = new Set<string>();
  private participantRenderPending = false;
  private managedInvitations: ManagedInvitation[];
  private recoverySnapshots: RecoverySnapshot[] = [];
  private outboxAvailable = true;
  private optimisticRecovery = false;
  private archivePending = false;
  private activityInsertPending = false;
  private organisationId: string | null = null;
  private organisationTemplates: OrganisationTemplate[] = [];
  private organisationTemplatesCanManage = false;
  private organisationTemplatesLoaded = false;
  private organisationTemplatesLoading = false;
  private organisationTemplatesError: string | null = null;
  private organisationTemplateSavePending = false;
  private organisationTemplateItemsToSave: BoardItem[] = [];
  private readonly organisationTemplateDeletesPending = new Set<string>();
  private organisationWebhookSettings: OrganisationWebhookSettings | null = null;
  private organisationWebhookSavePending = false;
  private organisationWebhookSendPending = false;
  private organisationWebhookIdempotencyKey: string | null = null;
  private readonly titleInput: HTMLInputElement;
  private readonly saveStatus: HTMLElement;
  private readonly saveStatusText: HTMLElement;
  private readonly participantsButton: HTMLButtonElement;
  private readonly participantCount: HTMLElement;
  private readonly participantDrawer: HTMLElement;
  private readonly participantList: HTMLElement;
  private readonly commentsButton: HTMLButtonElement;
  private readonly commentsCount: HTMLElement;
  private readonly commentsDrawer: HTMLElement;
  private readonly commentsList: HTMLElement;
  private readonly commentComposer: HTMLElement;
  private readonly commentTargetLabel: HTMLElement;
  private readonly commentInput: HTMLTextAreaElement;
  private readonly commentImageInput: HTMLInputElement;
  private readonly commentAttachment: HTMLElement;
  private readonly commentAttachmentLabel: HTMLElement;
  private readonly commentImageAltInput: HTMLInputElement;
  private readonly commentVideoField: HTMLElement;
  private readonly commentVideoUrl: HTMLInputElement;
  private readonly showHiddenCommentsInput: HTMLInputElement;
  private readonly commentsFilter: HTMLElement;
  private readonly commentsEyebrow: HTMLElement;
  private readonly commentsHeading: HTMLElement;
  private readonly spotlightToggle: HTMLButtonElement;
  private readonly spotlightFollowBanner: HTMLElement;
  private readonly spotlightFollowText: HTMLElement;
  private readonly activitiesButton: HTMLButtonElement;
  private readonly activitiesMenu: HTMLElement;
  private readonly accessButton: HTMLButtonElement;
  private readonly accessDrawer: HTMLElement;
  private readonly accessBody: HTMLElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly settingsDrawer: HTMLElement;
  private readonly settingsBody: HTMLElement;
  private readonly shapeMenu: HTMLElement;
  private readonly toolsMenu: HTMLElement;
  private readonly stylePopover: HTMLElement;
  private readonly moreToolsButton: HTMLButtonElement;
  private toolRailResizeObserver: ResizeObserver | null = null;
  private readonly selectionActions: HTMLElement;
  private readonly aiAssistWrap: HTMLElement;
  private readonly aiAssistButton: HTMLButtonElement;
  private readonly aiAssistMenu: HTMLElement;
  private readonly aiAssistNote: HTMLInputElement;
  private readonly webMcpStatus: HTMLButtonElement;
  private readonly webMcpStatusText: HTMLElement;
  private readonly webMcpStatusTime: HTMLElement;
  private readonly mcpActivityMenu: HTMLElement;
  private readonly mcpActivitySummary: HTMLElement;
  private readonly mcpActivityList: HTMLOListElement;
  private readonly mcpActivityEmpty: HTMLElement;
  private readonly aiShareButton: HTMLButtonElement;
  private readonly aiShareMenu: HTMLElement;
  private readonly aiShareNote: HTMLInputElement;
  private readonly selectionColourButton: HTMLButtonElement;
  private readonly selectionColourMenu: HTMLElement;
  private readonly arrangeButton: HTMLButtonElement;
  private readonly arrangeMenu: HTMLElement;
  private readonly imageInput: HTMLInputElement;
  private readonly videoEmbedDialog: HTMLDialogElement;
  private readonly videoEmbedUrl: HTMLInputElement;
  private readonly tablePickerDialog: HTMLDialogElement;
  private readonly imageAltDialog: HTMLDialogElement;
  private readonly imageAltInput: HTMLTextAreaElement;
  private readonly organisationTemplateDialog: HTMLDialogElement;
  private readonly organisationTemplateName: HTMLInputElement;
  private readonly organisationTemplateDescription: HTMLTextAreaElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly redoButton: HTMLButtonElement;
  private readonly archivedBanner: HTMLElement;
  private readonly recoveryBanner: HTMLElement;
  private readonly toastRegion: HTMLElement;
  private readonly liveRegion: HTMLElement;
  private readonly zoomLabel: HTMLElement;

  private constructor(
    private readonly root: HTMLElement,
    private readonly api: ApiClient,
    bootstrap: Bootstrap,
  ) {
    this.bootstrap = bootstrap;
    for (const [actorId, displayName] of buildCreatorNameMap(bootstrap.creators, bootstrap.actor)) {
      this.creatorNames.set(actorId, displayName);
    }
    this.managedInvitations = loadManagedInvitations(bootstrap.board.id);
    this.history = {
      historyVersion: bootstrap.actor.historyVersion,
      canUndo: bootstrap.actor.canUndo ?? false,
      canRedo: bootstrap.actor.canRedo ?? false,
    };
    const snapshot = bootstrap.snapshot as BoardSnapshot;
    this.model.load(snapshot);
    this.buildShell();

    this.titleInput = query(this.root, "[data-testid='board-title']", HTMLInputElement);
    this.saveStatus = query(this.root, "[data-testid='save-status']", HTMLElement);
    this.saveStatusText = query(this.root, "[data-save-status-text]", HTMLElement);
    this.participantsButton = query(
      this.root,
      "[data-testid='participants-button']",
      HTMLButtonElement,
    );
    this.participantCount = query(this.root, "[data-participant-count]", HTMLElement);
    this.participantDrawer = query(this.root, "[data-testid='participant-drawer']", HTMLElement);
    this.participantList = query(this.root, "[data-participant-list]", HTMLElement);
    this.commentsButton = query(this.root, "[data-testid='comments-button']", HTMLButtonElement);
    this.commentsCount = query(this.commentsButton, "[data-comments-count]", HTMLElement);
    this.commentsDrawer = query(this.root, "[data-testid='comments-drawer']", HTMLElement);
    this.commentsList = query(this.commentsDrawer, "[data-comments-list]", HTMLElement);
    this.commentComposer = query(this.commentsDrawer, "[data-comment-composer]", HTMLElement);
    this.commentTargetLabel = query(this.commentComposer, "[data-comment-target]", HTMLElement);
    this.commentInput = query(this.commentComposer, "[data-comment-input]", HTMLTextAreaElement);
    this.commentImageInput = query(
      this.commentComposer,
      "[data-comment-image-input]",
      HTMLInputElement,
    );
    this.commentAttachment = query(this.commentComposer, "[data-comment-attachment]", HTMLElement);
    this.commentAttachmentLabel = query(
      this.commentAttachment,
      "[data-comment-attachment-label]",
      HTMLElement,
    );
    this.commentImageAltInput = query(
      this.commentAttachment,
      "[data-comment-image-alt]",
      HTMLInputElement,
    );
    this.commentVideoField = query(this.commentComposer, "[data-comment-video-field]", HTMLElement);
    this.commentVideoUrl = query(
      this.commentVideoField,
      "[data-comment-video-url]",
      HTMLInputElement,
    );
    this.showHiddenCommentsInput = query(
      this.commentsDrawer,
      "[data-show-hidden-comments]",
      HTMLInputElement,
    );
    this.commentsFilter = query(this.commentsDrawer, "[data-comments-filter]", HTMLElement);
    this.commentsEyebrow = query(this.commentsDrawer, "[data-comments-eyebrow]", HTMLElement);
    this.commentsHeading = query(this.commentsDrawer, "[data-comments-heading]", HTMLElement);
    this.spotlightToggle = query(this.root, "[data-testid='spotlight-toggle']", HTMLButtonElement);
    this.spotlightFollowBanner = query(
      this.root,
      "[data-testid='spotlight-follow-banner']",
      HTMLElement,
    );
    this.spotlightFollowText = query(
      this.spotlightFollowBanner,
      "[data-spotlight-follow-text]",
      HTMLElement,
    );
    this.activitiesButton = query(
      this.root,
      "[data-testid='activities-button']",
      HTMLButtonElement,
    );
    this.activitiesMenu = query(this.root, "[data-testid='activities-menu']", HTMLElement);
    this.buildActivitiesMenu();
    this.accessButton = query(this.root, "[data-testid='access-button']", HTMLButtonElement);
    this.accessDrawer = query(this.root, "[data-testid='access-drawer']", HTMLElement);
    this.accessBody = query(this.root, "[data-access-body]", HTMLElement);
    this.settingsButton = query(this.root, "[data-testid='settings-button']", HTMLButtonElement);
    this.settingsDrawer = query(this.root, "[data-testid='settings-drawer']", HTMLElement);
    this.settingsBody = query(this.root, "[data-settings-body]", HTMLElement);
    this.shapeMenu = query(this.root, "[data-testid='shape-menu']", HTMLElement);
    this.toolsMenu = query(this.root, "[data-testid='tools-menu']", HTMLElement);
    this.stylePopover = query(this.root, "[data-testid='style-popover']", HTMLElement);
    this.selectionActions = query(this.root, "[data-testid='selection-actions']", HTMLElement);
    this.moreToolsButton = query(this.root, "[data-testid='tool-more']", HTMLButtonElement);
    this.aiAssistWrap = query(this.selectionActions, "[data-selection-ai-wrap]", HTMLElement);
    this.aiAssistButton = query(this.selectionActions, "[data-selection-ai]", HTMLButtonElement);
    this.aiAssistMenu = query(this.selectionActions, "[data-testid='ai-assist-menu']", HTMLElement);
    this.aiAssistNote = query(this.aiAssistMenu, "[data-ai-assist-note]", HTMLInputElement);
    this.webMcpStatus = query(this.root, "[data-webmcp-status]", HTMLButtonElement);
    this.webMcpStatusText = query(this.root, "[data-webmcp-status-text]", HTMLElement);
    this.webMcpStatusTime = query(this.root, "[data-webmcp-status-time]", HTMLElement);
    this.mcpActivityMenu = query(this.root, "[data-testid='mcp-activity-menu']", HTMLElement);
    this.mcpActivitySummary = query(
      this.mcpActivityMenu,
      "[data-mcp-activity-summary]",
      HTMLElement,
    );
    this.mcpActivityList = query(
      this.mcpActivityMenu,
      "[data-mcp-activity-list]",
      HTMLOListElement,
    );
    this.mcpActivityEmpty = query(this.mcpActivityMenu, "[data-mcp-activity-empty]", HTMLElement);
    this.aiShareButton = query(this.root, "[data-ai-share]", HTMLButtonElement);
    this.aiShareMenu = query(this.root, "[data-testid='ai-share-menu']", HTMLElement);
    this.aiShareNote = query(this.aiShareMenu, "[data-ai-share-note]", HTMLInputElement);
    this.selectionColourButton = query(
      this.selectionActions,
      "[data-selection-colour]",
      HTMLButtonElement,
    );
    this.selectionColourMenu = query(
      this.selectionActions,
      "[data-testid='selection-colour-menu']",
      HTMLElement,
    );
    this.arrangeButton = query(
      this.selectionActions,
      "[data-selection-arrange]",
      HTMLButtonElement,
    );
    this.arrangeMenu = query(this.selectionActions, "[data-testid='arrange-menu']", HTMLElement);
    this.imageInput = query(this.root, "[data-image-input]", HTMLInputElement);
    this.videoEmbedDialog = query(
      this.root,
      "[data-testid='video-embed-dialog']",
      HTMLDialogElement,
    );
    this.videoEmbedUrl = query(this.videoEmbedDialog, "[data-video-url]", HTMLInputElement);
    this.tablePickerDialog = query(this.root, "[data-testid='table-picker']", HTMLDialogElement);
    this.imageAltDialog = query(this.root, "[data-testid='image-alt-dialog']", HTMLDialogElement);
    this.imageAltInput = query(this.imageAltDialog, "[data-image-alt-input]", HTMLTextAreaElement);
    this.organisationTemplateDialog = query(
      this.root,
      "[data-testid='organisation-template-dialog']",
      HTMLDialogElement,
    );
    this.organisationTemplateName = query(
      this.organisationTemplateDialog,
      "[data-organisation-template-name]",
      HTMLInputElement,
    );
    this.organisationTemplateDescription = query(
      this.organisationTemplateDialog,
      "[data-organisation-template-description]",
      HTMLTextAreaElement,
    );
    this.undoButton = query(this.root, "[data-testid='undo-button']", HTMLButtonElement);
    this.redoButton = query(this.root, "[data-testid='redo-button']", HTMLButtonElement);
    this.archivedBanner = query(this.root, "[data-testid='archived-banner']", HTMLElement);
    this.recoveryBanner = query(this.root, "[data-testid='recovery-banner']", HTMLElement);
    this.toastRegion = query(this.root, "[data-testid='toast-region']", HTMLElement);
    this.liveRegion = query(this.root, "[data-testid='live-region']", HTMLElement);
    this.zoomLabel = query(this.root, "[data-zoom-label]", HTMLElement);

    this.titleInput.value = bootstrap.board.title;
    this.renderer = new BoardRenderer(
      query(this.root, "[data-canvas-host]", HTMLElement),
      this.model,
      (assetId) => this.api.boardImage(this.bootstrap.board.id, assetId),
      (actorId) => this.creatorNames.get(actorId),
      (itemId, expectedVersion) =>
        this.reconcileRenderedTextSectionMembership(itemId, expectedVersion),
    );
    this.renderer.setVotingEnabled(this.bootstrap.board.features.voting);
    this.renderer.setObjectTransformsEnabled(this.bootstrap.board.features.objectTransforms);
    this.renderer.viewport.subscribe((zoom) => {
      this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      this.renderer.refreshSelection();
      this.renderer.refreshComments();
    });
    this.unsubscribeViewport = this.renderer.viewport.subscribeView(() => {
      this.scheduleSpotlightViewportUpdate();
    });
    this.tools = new ToolController({
      model: this.model,
      renderer: this.renderer,
      canDraw: () => this.canCommit(),
      canModifyItem: (item) => this.canModifyItem(item),
      canUseImages: () => this.canUploadImages(),
      canUseTool: (tool) => this.isToolEnabled(tool),
      canSnapLines: () => this.bootstrap.board.features.lineSnapping,
      canTransformObjects: () => this.bootstrap.board.features.objectTransforms,
      canGroup: () => this.bootstrap.board.features.grouping,
      usePartialEraser: () => this.bootstrap.board.features.partialEraser,
      getStyle: () => this.style,
      commit: (operation, actionId) => this.commit(operation, actionId),
      preview: (gestureId, previewSeq, kind, payload) =>
        this.socket.sendPreview(gestureId, previewSeq, kind, payload),
      presence: (cursor, tool) => {
        this.socket.sendPresence(cursor, tool);
      },
      editText: (point, item) => this.openTextEditor(point, item),
      editImageAlt: (item) => this.openImageAltEditor(item),
      editTableCell: (item, row, column) => this.openTableCellEditor(item, row, column),
      editZoneTitle: (item) => this.openZoneTitleEditor(item),
      onZoneCreated: (itemId) => {
        this.pendingNewZoneTitles.add(itemId);
        this.tools.setTool("select");
        this.tools.selectOnly([itemId]);
        this.syncNewZoneTitleEditor();
      },
      onToolChanged: (tool) => {
        this.setActiveToolButton(tool);
        if (tool === "stamp" || tool === "sticky") this.setStylePopoverOpen(true);
        this.setTablePickerOpen(tool === "table");
        if (tool === "image") {
          this.setStylePopoverOpen(false);
          this.openImagePicker();
        }
      },
      onToolReactivated: (tool) => this.reactivateTool(tool),
      onSelectionChanged: (ids) => this.updateSelectionActions(ids),
      notify: (message, kind) => this.notify(message, kind),
    });

    this.socket = new BoardSocket(
      bootstrap.board.id,
      {
        getSequence: () => this.model.lastAppliedSeq,
        onPhase: (phase) => {
          this.phase = phase;
          if (phase === "archived") this.enterArchivedState();
          this.updatePermissions();
        },
        onWelcome: (state) => {
          this.bootstrap.actor.role = state.role;
          this.bootstrap.actor.sessionExpiresAt = state.sessionExpiresAt;
          this.bootstrap.board.drawingPolicy = state.drawingPolicy;
          this.bootstrap.board.imagesEnabled = state.imagesEnabled;
          this.bootstrap.board.features = state.features;
          this.bootstrap.board.aclVersion = state.aclVersion;
          this.history.historyVersion = state.historyVersion;
          this.history.canUndo = state.canUndo;
          this.history.canRedo = state.canRedo;
          this.updatePermissions();
        },
        onAction: (action, replay) => this.handleAction(action, replay),
        onReady: () => {
          this.flushOutbox();
          this.socket.sendPresence(null, this.tools.tool);
          this.sendCurrentSpotlight();
          void this.reloadComments(false);
        },
        onRejected: (frame) => this.handleRejection(frame),
        onCommentsChanged: () => void this.reloadComments(false),
        onHistory: (state) => {
          this.history = state;
          this.updateHistoryControls();
        },
        onAccessChanged: (frame) => this.handleAccessChanged(frame),
        onOwnerRecovery: (token, aclVersion) => this.handleOwnerRecovery(token, aclVersion),
        onPreview: (preview, cancelKey) => this.handlePreview(preview, cancelKey),
        onPresence: (presences, replace) => this.handlePresence(presences, replace),
        onSpotlight: (frame) => this.handleSpotlight(frame),
        onResync: (reason) => this.resync(reason),
        onNotice: (message, kind) => this.notify(message, kind),
        refreshSession: () => this.api.refreshSession(),
      },
      api.embedSessionToken,
    );

    this.webMcpState = webMcpRegistryState();
    this.renderWebMcpStatus(this.webMcpState);
    this.stopObservingWebMcp = observeWebMcpRegistry((state) => {
      this.renderWebMcpStatus(state);
    });

    this.mathFieldPanel = new MathFieldPanel({
      root: this.root,
      onChange: this.applyMathField,
      onDone: this.finishMathField,
      onFocusLeft: this.leaveMathField,
    });

    this.webMcp = new CollectiveInquiryWebMcp({
      root: this.root,
      getSelectedItems: () =>
        savedAuthoritativeItems(
          [...this.tools.selection],
          this.model.items,
          this.model.authoritativeItems,
        ),
      getBoardItems: () => [...this.model.authoritativeItems.values()],
      getAuthoritativeItem: (itemId) => this.model.authoritativeItems.get(itemId),
      getSequence: () => this.model.lastAppliedSeq,
      getParticipantDisplayName: (participantId) => this.creatorNames.get(participantId) ?? null,
      notify: (message, kind) => this.notify(message, kind),
      canComment: () => this.canComment(),
      canWrite: () => this.canCommit(),
      createComment: (itemId, body, assistance) => this.commentFromWebMcp(itemId, body, assistance),
      onWatchStateChanged: (state) => this.setAiWatchState(state),
    });

    this.educationPartnerWebMcp = new EducationPartnerWebMcp({
      canWrite: () => this.canCommit(),
      getSnapshot: (token) => this.webMcp?.getSnapshot(token),
      getItemVersion: (itemId) => this.model.authoritativeItems.get(itemId)?.version,
      getItemBounds: (itemId) => this.model.getBounds(itemId),
      getPlacementBounds: () => this.model.boundsFor(this.model.items.keys()),
      imagesEnabled: () => this.bootstrap.board.imagesEnabled,
      storeVisualImages: (sources, signal) => this.storeEducationVisualImages(sources, signal),
      commit: (operation) => this.commitAndWait(operation),
      selectItems: (itemIds) => {
        this.tools.setTool("select");
        this.tools.selectOnly(itemIds);
      },
      notify: (message, kind) => this.notify(message, kind),
    });

    this.activityTemplateWebMcp = new ActivityTemplateWebMcp({
      canWrite: () => this.canCommit(),
      templateIssue: (template) =>
        templateAvailabilityIssue(template, this.bootstrap.board.features),
      getPlacementCenter: () => {
        const view = this.renderer.viewport.viewState;
        return [view.center.x, view.center.y];
      },
      commit: (operation) => this.commitAndWait(operation),
      revealItems: (itemIds) => {
        this.tools.setTool("select");
        this.tools.selectOnly(itemIds);
        this.renderer.viewport.fit(this.model.boundsFor(itemIds));
      },
      notify: (message, kind) => this.notify(message, kind),
    });

    this.boardWriteWebMcp = new BoardWriteWebMcp({
      canWrite: () => this.canCommit(),
      canComment: () => this.canComment(),
      imagesEnabled: () => this.bootstrap.board.imagesEnabled,
      featureIssue: (kind) => webMcpWriteFeatureIssue(kind, this.bootstrap.board.features),
      getStyle: () => ({
        stickyFill: this.style.stickyFill,
        stickyTextColor: this.style.stickyTextColor,
        stickyFontSize: this.style.stickyFontSize,
        stickyOpacity: this.style.stickyOpacity,
        textColor: this.style.color,
        textFontSize: this.style.fontSize,
        textFontFamily: this.style.fontFamily,
        textOpacity: this.style.opacity,
      }),
      getPlacementCenter: () => this.imagePlacementCenter(),
      itemAt: (point) => this.savedItemAt(point),
      getSelectedItem: () => this.singleSavedSelection(),
      resolveWatchedStep: (watchToken, stepAlias, action) => {
        const inquiry = this.webMcp;
        if (!inquiry) throw new Error("The board watch is not available in this browser.");
        return inquiry.watchedStepCommentTarget(watchToken, stepAlias, action);
      },
      resolveWatchedStickies: (watchToken, stepAliases) => {
        const inquiry = this.webMcp;
        if (!inquiry) throw new Error("The board watch is not available in this browser.");
        return inquiry.watchedStepItems(watchToken, stepAliases);
      },
      moveItems: (moves) => this.moveItemsFromWebMcp(moves),
      commit: (operation) => this.commitAndWait(operation),
      createComment: (itemId, body, assistance, media) =>
        this.commentFromWebMcp(itemId, body, assistance, media),
      storeImage: (imageDataUrl, signal) => this.storeWebMcpImage(imageDataUrl, signal),
      revealItems: (itemIds) => {
        this.tools.setTool("select");
        this.tools.selectOnly(itemIds);
      },
      notify: (message, kind) => this.notify(message, kind),
    });

    this.inquiryMapWebMcp = new InquiryMapWebMcp({
      root: this.root,
      canWrite: () => this.canCommit(),
      getSnapshot: (token) => this.webMcp?.getSnapshot(token),
      getItemVersion: (itemId) => this.model.authoritativeItems.get(itemId)?.version,
      getItemBounds: (itemId) => this.model.getBounds(itemId),
      commit: (operation) => this.commitAndWait(operation),
      selectItems: (itemIds) => {
        this.tools.setTool("select");
        this.tools.selectOnly(itemIds);
      },
      notify: (message, kind) => this.notify(message, kind),
    });

    this.classDecisionWebMcp = new ClassDecisionWebMcp({
      root: this.root,
      canWrite: () => this.canCommit(),
      getSelectedItems: () =>
        savedAuthoritativeItems(
          [...this.tools.selection],
          this.model.items,
          this.model.authoritativeItems,
        ),
      getItem: (itemId) => this.model.authoritativeItems.get(itemId),
      getItems: () => this.model.items.values(),
      getItemBounds: (itemId) => this.model.getBounds(itemId),
      commit: (operation) => this.commitAndWait(operation),
      selectItems: (itemIds) => {
        this.tools.setTool("select");
        this.tools.selectOnly(itemIds);
      },
      notify: (message, kind) => this.notify(message, kind),
    });

    this.bindShellEvents();
    this.model.subscribe(() => {
      this.updateStatus();
      this.tools.reconcileSelection();
      this.updateSelectionActions(this.tools.selection);
      this.syncNewZoneTitleEditor();
      this.reconcileCommentStates();
    });
    this.model.subscribeRebase((error) => this.handleRebaseState(error));
    this.presences.set(bootstrap.actor.id, {
      ...bootstrap.actor,
      role: bootstrap.actor.role,
      updatedAt: Date.now(),
    });
    this.previewExpiryTimer = window.setInterval(() => this.expireEphemeralState(), 1_000);
  }

  static async mount(root: HTMLElement, api: ApiClient, bootstrap: Bootstrap): Promise<BoardApp> {
    const app = new BoardApp(root, api, bootstrap);
    await app.restoreOutbox();
    app.updateAll();
    if (bootstrap.board.features.organisationTemplates) void app.loadOrganisationTemplates();
    app.socket.connect();
    return app;
  }

  destroy(): void {
    window.clearInterval(this.previewExpiryTimer);
    if (this.webMcpWatchCountdown !== null) {
      window.clearInterval(this.webMcpWatchCountdown);
      this.webMcpWatchCountdown = null;
    }
    this.toolRailResizeObserver?.disconnect();
    this.toolRailResizeObserver = null;
    this.stopBroadcastingSpotlight();
    this.clearFollowingSpotlight();
    this.unsubscribeViewport?.();
    this.unsubscribeViewport = null;
    this.pendingStickyDrafts.clear();
    this.rejectedStickyDrafts.length = 0;
    this.pendingTableCellDrafts.clear();
    this.rejectedTableCellDrafts.length = 0;
    this.pendingZoneTitleDrafts.clear();
    this.rejectedZoneTitleDrafts.length = 0;
    this.pendingNewZoneTitles.clear();
    clearTypesetMath(this.commentsList);
    this.playingCommentVideoId = null;
    this.releaseCommentImages();
    document.removeEventListener("paste", this.onImagePaste);
    this.renderer.svg.removeEventListener("dragover", this.onImageDragOver);
    this.renderer.svg.removeEventListener("drop", this.onImageDrop);
    this.tablePickerDialog.close();
    this.videoEmbedDialog.close();
    this.closeImageAltEditor();
    this.organisationTemplateDialog.close();
    void this.closeTableCellEditor(false);
    void this.closeZoneTitleEditor(false);
    void this.closeTextEditor(false);
    this.pendingWebMcpCommits.finishAll(false);
    this.socket.destroy();
    this.activityTemplateWebMcp?.destroy();
    this.activityTemplateWebMcp = null;
    this.boardWriteWebMcp?.destroy();
    this.boardWriteWebMcp = null;
    this.educationPartnerWebMcp?.destroy();
    this.educationPartnerWebMcp = null;
    this.classDecisionWebMcp?.destroy();
    this.classDecisionWebMcp = null;
    this.inquiryMapWebMcp?.destroy();
    this.inquiryMapWebMcp = null;
    this.webMcp?.destroy();
    this.webMcp = null;
    this.stopObservingWebMcp?.();
    this.stopObservingWebMcp = null;
    this.mathFieldPanel?.destroy();
    this.mathFieldPanel = null;
    this.mathFieldTarget = null;
    this.setAiWatchState({ phase: "idle", expiresAt: null, watchedItemIds: new Set() });
    this.tools.destroy();
    this.renderer.destroy();
    window.removeEventListener("keydown", this.onGlobalKeyDown);
  }

  private buildShell(): void {
    this.root.innerHTML = `
      <div class="workspace" data-testid="board-shell">
        <header class="topbar">
          <a class="wordmark" href="/" aria-label="${PRODUCT_HOME_LABEL}">
            ${BRAND_MARK_HTML}
            <span class="wordmark-text">${PRODUCT_NAME}</span>
          </a>
          <div class="board-identity">
            <label class="board-title-wrap">
              <span class="sr-only">Board title</span>
              <input class="board-title" data-testid="board-title" maxlength="100" autocomplete="off" />
            </label>
            <div class="save-status" data-testid="save-status" role="status" aria-live="polite">
              <svg class="save-cloud-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7.6 18.2h9.3a4.1 4.1 0 0 0 .7-8.1A6 6 0 0 0 6.2 8.9a4.7 4.7 0 0 0 1.4 9.3Z"></path>
                <path class="save-cloud-check" d="m9.2 13.4 1.9 1.9 3.9-4"></path>
              </svg>
              <span data-save-status-text>Connecting…</span>
            </div>
          </div>
          <div class="topbar-actions">
            <div class="menu-wrap mcp-status-wrap">
              <button class="webmcp-status" type="button" data-webmcp-status data-testid="webmcp-status" data-state="ready" data-host="unlinked" aria-haspopup="dialog" aria-controls="mcp-activity-menu" aria-expanded="false">
                <svg class="webmcp-status-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m5 4 14 7.2-6.1 2.1-2.2 6.2L5 4Z"></path>
                  <path d="m12.9 13.3 4.4 4.4"></path>
                </svg>
                <span class="webmcp-status-copy">
                  <span data-webmcp-status-text>MCP</span>
                  <small class="webmcp-status-time" data-webmcp-status-time data-testid="webmcp-status-time">Ready</small>
                </span>
              </button>
              <section class="floating-menu mcp-activity-menu" data-testid="mcp-activity-menu" id="mcp-activity-menu" role="dialog" aria-label="MCP call activity" hidden>
                <header class="mcp-activity-heading">
                  <span>
                    <strong>MCP activity</strong>
                    <small data-mcp-activity-summary>Waiting for a compatible browser</small>
                  </span>
                  <span class="mcp-activity-live" aria-hidden="true"></span>
                </header>
                <p class="mcp-activity-empty" data-mcp-activity-empty>No MCP calls in this tab yet.</p>
                <ol class="mcp-activity-list" data-mcp-activity-list aria-live="polite"></ol>
              </section>
            </div>
            <div class="menu-wrap activities-wrap">
              <button class="topbar-button activities-button" type="button" data-testid="activities-button" aria-label="Add a template" aria-haspopup="menu" aria-controls="activities-menu" aria-expanded="false" hidden>
                <span class="activities-button-mark" aria-hidden="true">＋</span>
                <span class="activities-button-label">Templates</span>
              </button>
              <div class="floating-menu activities-menu" data-testid="activities-menu" id="activities-menu" role="menu" aria-label="Space templates" hidden>
                <p class="menu-eyebrow" data-built-in-templates>Built-in templates</p>
                <p class="activities-menu-note" data-built-in-templates>Starter layouts made from ordinary board items.</p>
                <div class="activities-template-list" data-activities-template-list data-built-in-templates></div>
                <section class="organisation-templates-section" data-organisation-templates-section hidden>
                  <div class="activities-menu-divider" aria-hidden="true"></div>
                  <p class="menu-eyebrow">Organisation templates</p>
                  <p class="activities-menu-note" data-organisation-templates-note>Reusable layouts shared across every Space in this organisation.</p>
                  <div class="activities-template-list organisation-template-list" data-organisation-template-list></div>
                  <p class="activities-template-status" data-organisation-template-status role="status"></p>
                  <button class="organisation-template-save" type="button" role="menuitem" data-save-organisation-template hidden>Save selected objects as template</button>
                </section>
              </div>
            </div>
            <button class="topbar-button people-button" type="button" data-testid="participants-button" aria-label="1 person here" aria-controls="participant-drawer" aria-expanded="false" title="1 person here">
              <span class="avatar-stack" aria-hidden="true"><i></i><i></i></span>
              <span data-participant-count>1</span>
              <span class="wide-label">here</span>
            </button>
            <button class="topbar-button access-button" type="button" data-testid="access-button" aria-label="Share and export Space" aria-controls="access-drawer" aria-expanded="false" title="Share and export"><span class="access-button-mark" aria-hidden="true">↗</span><span class="access-button-label">Share</span></button>
            <button class="icon-button settings-button" type="button" data-testid="settings-button" aria-label="Space settings" aria-controls="settings-drawer" aria-expanded="false" title="Settings">⚙</button>
          </div>
        </header>

        <div class="archived-banner" data-testid="archived-banner" role="status" aria-live="polite" hidden>
          <strong>Board archived</strong>
          <span>This board is permanently read only. Existing access and invitation links can no longer open it.</span>
        </div>

        <div class="spotlight-follow-banner" data-testid="spotlight-follow-banner" role="status" aria-live="polite" hidden>
          <span data-spotlight-follow-text></span>
          <button class="spotlight-stop" type="button" data-stop-spotlight>Stop</button>
        </div>

        <main class="board-stage">
          <div class="tool-rail-shell" data-tool-rail-shell data-overflow="false">
            <button class="tool-rail-scroll tool-rail-scroll-back" type="button" data-tool-rail-scroll="-1" aria-label="Scroll tools left" hidden>‹</button>
            <nav class="tool-rail" aria-label="Drawing tools" data-testid="tool-rail"></nav>
            <button class="tool-rail-scroll tool-rail-scroll-forward" type="button" data-tool-rail-scroll="1" aria-label="Scroll tools right" hidden>›</button>
          </div>
          <section class="canvas-wrap" data-canvas-host>
            <p class="sr-only" id="canvas-help">Use the bottom toolbar to draw. Hold Space to pan. Scroll or pinch to zoom.</p>
            <div class="canvas-hint" data-canvas-hint aria-hidden="true">Draw or add an element to get started</div>
            <dialog class="claim-dialog table-picker" data-testid="table-picker" aria-labelledby="table-picker-title" aria-describedby="table-picker-note">
              <form data-table-picker-form>
                <span class="eyebrow">Table</span>
                <h2 id="table-picker-title">Choose a table size</h2>
                <p class="table-picker-note" id="table-picker-note">Set up the grid, then choose where to place it on the canvas.</p>
                <div class="table-picker-fields">
                  <label><span class="table-picker-field-label">Columns</span><select data-table-columns aria-label="Table columns">
                    <option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option><option>6</option>
                  </select></label>
                  <label><span class="table-picker-field-label">Rows</span><select data-table-rows aria-label="Table rows">
                    <option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option><option>6</option><option>7</option><option>8</option>
                  </select></label>
                </div>
                <label class="table-header-toggle"><input type="checkbox" data-table-header /> <span>Header row</span></label>
                <div class="dialog-actions">
                  <button type="button" data-table-picker-cancel>Cancel</button>
                  <button class="primary-button" type="submit">Choose placement</button>
                </div>
              </form>
            </dialog>
            <dialog class="claim-dialog video-embed-dialog" data-testid="video-embed-dialog" aria-labelledby="video-embed-title" aria-describedby="video-embed-note">
              <form data-video-embed-form>
                <span class="eyebrow">Video</span>
                <h2 id="video-embed-title">Embed a video</h2>
                <p id="video-embed-note">Paste a public YouTube or Vimeo link. SpaceScale uses privacy-conscious player URLs.</p>
                <label><span>Video URL</span><input type="url" inputmode="url" autocomplete="url" placeholder="https://www.youtube.com/watch?v=…" data-video-url required /></label>
                <p class="dialog-field-error" data-video-error role="alert"></p>
                <div class="dialog-actions">
                  <button type="button" data-video-cancel>Cancel</button>
                  <button class="primary-button" type="submit" data-video-submit>Embed video</button>
                </div>
              </form>
            </dialog>
            <div class="selection-actions" data-testid="selection-actions" hidden>
              <button type="button" data-selection-alt aria-label="Edit image alt text" hidden>Edit alt text</button>
              <div class="selection-colour-wrap" hidden>
                <button class="selection-colour-trigger" type="button" data-selection-colour aria-label="Change selected element colour" title="Colour" aria-haspopup="menu" aria-controls="selection-colour-menu" aria-expanded="false"><span class="selection-current-colour" data-selection-current-colour aria-hidden="true"></span></button>
                <div class="selection-colour-menu" data-testid="selection-colour-menu" id="selection-colour-menu" role="menu" aria-label="Element colour" hidden></div>
              </div>
              <div class="selection-font-controls" data-selection-font-controls hidden>
                <select data-selection-font-family aria-label="Font family">
                  <option value="" disabled>Mixed fonts</option>
                  <option value="sans">Sans</option>
                  <option value="serif">Serif</option>
                  <option value="handwritten">Handwritten</option>
                  <option value="mono">Mono</option>
                </select>
                <select data-selection-font-size aria-label="Text size">
                  <option value="" disabled>Mixed sizes</option>
                  <option value="16">Small</option>
                  <option value="20">Default</option>
                  <option value="24">Medium</option>
                  <option value="36">Large</option>
                  <option value="52">Extra large</option>
                  <option value="72">Huge</option>
                </select>
                <button type="button" data-selection-font-weight aria-label="Bold" aria-pressed="false"><strong>B</strong></button>
                <button type="button" data-selection-font-style aria-label="Italic" aria-pressed="false"><em>I</em></button>
                <button type="button" data-selection-text-decoration aria-label="Underline" aria-pressed="false"><u>U</u></button>
              </div>
              <span class="selection-actions-divider" data-selection-style-divider aria-hidden="true" hidden></span>
              <div class="selection-ai-wrap" data-selection-ai-wrap hidden>
                <button type="button" data-selection-ai data-testid="selection-ai" aria-label="Ask the AI assistant about the selection" title="Ask AI" aria-haspopup="menu" aria-controls="ai-assist-menu" aria-expanded="false">${aiSparkleIcon()}<span>Ask AI</span></button>
                <div class="arrange-menu ai-assist-menu" data-testid="ai-assist-menu" id="ai-assist-menu" role="menu" aria-label="Ask the AI assistant" hidden>
                  ${ASSIST_ACTIONS.map(
                    (action) =>
                      `<button type="button" role="menuitem" data-ai-action="${action}">${ASSIST_GUIDANCE[action].label}</button>`,
                  ).join("")}
                  <label class="ai-assist-note"><span>Other instruction</span><input type="text" maxlength="${ASSIST_NOTE_MAX_LENGTH}" data-ai-assist-note placeholder="What are you unsure about?" autocomplete="off" /></label>
                </div>
              </div>
              <button class="selection-comment-button" type="button" data-selection-comment aria-label="Comment on selected object" title="Comment"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/></svg></button>
              <button class="selection-icon-button" type="button" data-selection-section-lock data-section-locked="false" aria-label="Lock Section" title="Lock Section" aria-pressed="false" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path class="section-lock-icon-closed" d="M8 10V7a4 4 0 0 1 8 0v3"/><path class="section-lock-icon-open" d="M16 10V7a4 4 0 0 0-7.8-1.2"/><circle cx="12" cy="15.5" r="1"/></svg></button>
              <button type="button" data-selection-group aria-label="Group selected items" hidden>Group</button>
              <button type="button" data-selection-ungroup aria-label="Ungroup selected items" hidden>Ungroup</button>
              <div class="selection-arrange-wrap">
                <button type="button" data-selection-arrange aria-label="Arrange selected items" aria-haspopup="menu" aria-controls="arrange-menu" aria-expanded="false">Arrange</button>
                <div class="arrange-menu" data-testid="arrange-menu" id="arrange-menu" role="menu" aria-label="Arrange selected items" hidden>
                  <span class="arrange-menu-label">Align</span>
                  <button type="button" role="menuitem" data-arrange="align-left">Align left</button>
                  <button type="button" role="menuitem" data-arrange="align-top">Align top</button>
                  <button type="button" role="menuitem" data-arrange="align-horizontal-center">Center horizontally</button>
                  <span class="arrange-menu-label">Distribute</span>
                  <button type="button" role="menuitem" data-arrange="distribute-horizontal">Space horizontally</button>
                  <button type="button" role="menuitem" data-arrange="distribute-vertical">Space vertically</button>
                  <span class="arrange-menu-label">Tidy</span>
                  <button type="button" role="menuitem" data-arrange="tidy-stickies">Tidy stickies into grid</button>
                </div>
              </div>
              <button type="button" data-selection-clear-votes aria-label="Clear votes from selected template" hidden>Clear votes</button>
            </div>
            <div class="quick-style-bar" data-testid="quick-style-bar" aria-label="Brush and colour" hidden>
              <div class="brush-preset-group" data-brush-preset-group>
                <button class="brush-preset" type="button" data-brush-preset="pen" aria-label="Pen" title="Pen" aria-pressed="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 20 4.2-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5.2 16Z"/><path d="m13.8 7.4 3 3"/></svg></button>
                <button class="brush-preset" type="button" data-brush-preset="marker" aria-label="Marker" title="Marker" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15.2 4.1 4.7 4.7-9.4 9.4-6.4 1.7 1.7-6.4Z"/><path d="m12.8 6.5 4.7 4.7M4 21h16"/></svg></button>
                <button class="brush-preset" type="button" data-brush-preset="highlighter" aria-label="Highlighter" title="Highlighter" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14.8 3.8 5.4 5.4-9.8 9.8-6.5 1.1 1.1-6.5Z"/><path d="m12.1 6.5 5.4 5.4"/><path class="brush-highlighter-mark" d="M3 21h18"/></svg></button>
              </div>
              <span class="quick-style-divider" data-quick-style-divider aria-hidden="true"></span>
              <div data-quick-colours></div>
            </div>
            <div class="zoom-controls" aria-label="Canvas zoom">
              <button type="button" data-zoom-out aria-label="Zoom out">−</button>
              <button type="button" data-zoom-reset aria-label="Reset zoom"><span data-zoom-label>100%</span></button>
              <button type="button" data-zoom-in aria-label="Zoom in">+</button>
              <button type="button" data-zoom-fit aria-label="Fit drawing to view" title="Fit drawing">⌗</button>
            </div>
          </section>
        </main>

        <input type="file" data-testid="image-input" data-image-input accept="image/png,image/jpeg,image/webp,image/gif" hidden />

        <div class="style-wrap">
          <button class="style-trigger" type="button" data-style-trigger aria-label="Open drawing style" aria-controls="style-popover" aria-expanded="false">
            <span class="style-swatch" data-style-swatch aria-hidden="true"></span>
            <span class="style-width" data-style-width aria-hidden="true"></span>
          </button>
          <section class="shape-menu" data-testid="shape-menu" id="shape-menu" role="menu" aria-label="Choose a shape" hidden>
            <div class="shape-menu-grid" data-shape-menu-grid></div>
          </section>
          <section class="shape-menu tools-menu" data-testid="tools-menu" id="tools-menu" role="menu" aria-label="More tools" hidden>
            <div class="shape-menu-grid tools-menu-grid" data-more-tools-grid>
              <button type="button" data-tools-tool="protractor" data-testid="tools-protractor" role="menuitemradio" aria-checked="false" aria-label="Protractor"><span class="shape-choice-glyph" aria-hidden="true">∠</span><span>Protractor</span></button>
            </div>
          </section>
          <section class="shape-menu ai-share-menu" data-testid="ai-share-menu" id="ai-share-menu" role="menu" aria-label="Share the whole board with the AI assistant" hidden>
            <p class="ai-share-heading">Share the whole board</p>
            <div class="shape-menu-grid ai-share-grid">
              ${ASSIST_ACTIONS.map(
                (action) =>
                  `<button type="button" role="menuitem" data-ai-share-action="${action}">${aiSparkleIcon("ai-sparkle-menu")}<span>${ASSIST_GUIDANCE[action].label}</span></button>`,
              ).join("")}
            </div>
            <label class="ai-assist-note"><span>Other instruction</span><input type="text" maxlength="${ASSIST_NOTE_MAX_LENGTH}" data-ai-share-note placeholder="What should the assistant do?" autocomplete="off" /></label>
            <p class="ai-assist-menu-note">Asks the assistant watching this Space to do what you picked, across the whole board.</p>
          </section>
          <section class="style-popover" data-testid="style-popover" id="style-popover" aria-label="Drawing style" hidden>
            <div class="popover-heading"><strong>Style</strong><span data-style-heading-context>New marks</span></div>
            <fieldset class="stamp-fieldset" data-stamp-fieldset hidden>
              <legend>Stamp</legend>
              <div class="stamp-grid" data-stamp-grid></div>
            </fieldset>
            <fieldset class="color-fieldset">
              <legend data-style-color-label>Colour</legend>
              <div class="color-grid" data-color-grid></div>
              <div class="color-grid sticky-color-grid" data-sticky-color-grid hidden></div>
              <label class="custom-color" title="Custom colour" data-custom-color><span class="sr-only">Custom colour</span><input type="color" value="${UI_COLORS.ink}" data-style-color /></label>
            </fieldset>
            <label class="range-row" data-style-stroke-row><span>Stroke</span><output data-width-output>2</output><input type="range" min="1" max="32" value="2" step="1" data-style-stroke /></label>
            <label class="style-checkbox-row" data-line-arrow-row hidden><input type="checkbox" data-line-arrow /> <span>End arrow</span><span class="line-arrow-preview" aria-hidden="true">→</span></label>
            <label class="range-row" data-style-opacity-row><span>Opacity</span><output data-opacity-output>100%</output><input type="range" min="10" max="100" value="100" step="5" data-style-opacity /></label>
            <label class="style-select-row" data-style-font-family-row><span>Font</span><select data-style-font-family>
              <option value="sans">Sans</option>
              <option value="serif">Serif</option>
              <option value="handwritten">Handwritten</option>
              <option value="mono">Mono</option>
            </select></label>
            <label class="range-row" data-style-font-row><span>Text</span><output data-font-output>20</output><input type="range" min="8" max="96" value="20" step="1" data-style-font /></label>
          </section>
        </div>

        <aside class="side-drawer comments-drawer" id="comments-drawer" data-testid="comments-drawer" aria-label="Comments" hidden>
          <div class="drawer-heading"><div><span class="eyebrow" data-comments-eyebrow>Objects</span><h2 data-comments-heading>Comments</h2></div><button type="button" data-close-drawer aria-label="Close comments">×</button></div>
          <label class="comments-filter" data-comments-filter><input type="checkbox" data-show-hidden-comments /> <span>Show resolved &amp; orphaned</span></label>
          <section class="comment-composer" data-comment-composer hidden>
            <span class="comment-target-label" data-comment-target></span>
            <form data-comment-form>
              <label class="sr-only" for="object-comment-input">Comment</label>
              <textarea id="object-comment-input" data-comment-input rows="3" maxlength="2000" placeholder="Add a comment…" required></textarea>
              <div class="comment-attachment" data-testid="comment-attachment" data-comment-attachment hidden>
                <div class="comment-attachment-row">
                  <span class="comment-attachment-label" data-comment-attachment-label></span>
                  <button type="button" data-comment-attachment-remove>Remove</button>
                </div>
                <label class="comment-attachment-alt" data-comment-image-alt-field hidden><span class="sr-only">Describe the image</span><input type="text" maxlength="${MAX_IMAGE_ALT_CODE_POINTS}" placeholder="Describe the image (optional)" data-comment-image-alt /></label>
              </div>
              <div class="comment-video-field" data-comment-video-field hidden>
                <label><span class="sr-only">Video link</span><input type="text" inputmode="url" autocomplete="url" placeholder="https://www.youtube.com/watch?v=…" data-comment-video-url /></label>
                <button type="button" data-comment-video-attach>Attach video</button>
                <p class="dialog-field-error" data-comment-video-error role="alert"></p>
              </div>
              <div class="comment-composer-actions">
                <button type="button" data-testid="comment-add-image" data-comment-add-image>Add image</button>
                <button type="button" data-testid="comment-add-video" data-comment-add-video>Add video</button>
                <button type="button" data-comment-cancel>Cancel</button>
                <button class="primary-button" type="submit" data-comment-submit>Comment</button>
              </div>
            </form>
            <input type="file" data-testid="comment-image-input" data-comment-image-input accept="image/png,image/jpeg,image/webp,image/gif" hidden />
          </section>
          <div class="comments-list" data-comments-list></div>
        </aside>

        <aside class="side-drawer participant-drawer" id="participant-drawer" data-testid="participant-drawer" aria-label="Participants" hidden>
          <div class="drawer-heading"><div><span class="eyebrow">Live Space</span><h2>Participants</h2></div><button type="button" data-close-drawer aria-label="Close participants">×</button></div>
          <section class="drawer-action-section">
            <button class="drawer-action-button spotlight-toggle" type="button" data-testid="spotlight-toggle" aria-label="Start Follow me" aria-pressed="false" hidden>
              <span class="spotlight-toggle-mark" aria-hidden="true"></span>
              <span class="spotlight-toggle-label">Follow me</span>
            </button>
          </section>
          <div class="participant-list" data-participant-list></div>
        </aside>

        <aside class="side-drawer access-drawer" id="access-drawer" data-testid="access-drawer" aria-label="Share and export" hidden>
          <div class="drawer-heading"><div><span class="eyebrow">Collaborate</span><h2>Share & export</h2></div><button type="button" data-close-drawer aria-label="Close access panel">×</button></div>
          <div data-access-body></div>
          <section class="access-section access-export-section">
            <h3>Export Space</h3>
            <div class="export-menu access-export-actions" data-testid="export-menu" id="export-menu">
              <button type="button" data-export-attributed-json${attributedDataDownloadAllowed(this.bootstrap.actor.role) ? "" : " hidden"}>Attributed data JSON <span>people + text attribution</span></button>
              <a data-export-svg download href="/api/v1/boards/${encodeURIComponent(this.bootstrap.board.id)}/export.svg">SVG image <span>authoritative</span></a>
              <a data-export-json download href="/api/v1/boards/${encodeURIComponent(this.bootstrap.board.id)}/export.json">Canonical JSON <span>authoritative</span></a>
              <button type="button" data-local-svg>Local SVG <span>includes pending edits</span></button>
              <button type="button" data-local-json>Local recovery JSON <span>includes outbox</span></button>
            </div>
          </section>
        </aside>
        <aside class="side-drawer settings-drawer" id="settings-drawer" data-testid="settings-drawer" aria-label="Space settings" hidden>
          <div class="drawer-heading"><div><span class="eyebrow">Space</span><h2>Settings</h2></div><button type="button" data-close-drawer aria-label="Close settings">×</button></div>
          <section class="drawer-action-section">
            <div class="drawer-section-label">History</div>
            <div class="settings-history-controls" aria-label="Board history">
              <button class="drawer-action-button" type="button" data-testid="undo-button" aria-label="Undo (Control or Command Z)" title="Undo · Ctrl/⌘ Z"><span aria-hidden="true">↶</span> Undo</button>
              <button class="drawer-action-button" type="button" data-testid="redo-button" aria-label="Redo (Control or Command Shift Z)" title="Redo · Ctrl/⌘ Shift Z"><span aria-hidden="true">↷</span> Redo</button>
            </div>
            <div class="drawer-section-label">Comments</div>
            <button class="drawer-action-button comments-button" type="button" data-testid="comments-button" aria-label="View all comments" aria-controls="comments-drawer" aria-expanded="false">
              <span class="comments-button-mark" aria-hidden="true">●</span>
              <span class="comments-button-label">View all comments</span>
              <span class="comments-count" data-comments-count>0</span>
              <span class="drawer-action-arrow" aria-hidden="true">›</span>
            </button>
          </section>
          <div data-settings-body></div>
        </aside>
        <dialog class="claim-dialog organisation-template-dialog" data-testid="organisation-template-dialog" aria-labelledby="organisation-template-title">
          <form data-organisation-template-form>
            <span class="eyebrow">Organisation template</span>
            <h2 id="organisation-template-title">Save selected objects</h2>
            <p>This template will be available in every Space in your organisation.</p>
            <label><span>Name</span><input data-organisation-template-name maxlength="100" autocomplete="off" required /></label>
            <label><span>Description <i>optional</i></span><textarea data-organisation-template-description maxlength="500" rows="3"></textarea></label>
            <small data-organisation-template-count></small>
            <p class="inline-error" data-organisation-template-error role="alert" hidden></p>
            <div class="dialog-actions">
              <button type="button" data-organisation-template-cancel>Cancel</button>
              <button class="primary-button" type="submit" data-organisation-template-submit>Save template</button>
            </div>
          </form>
        </dialog>

        <dialog class="claim-dialog image-alt-dialog" data-testid="image-alt-dialog" aria-labelledby="image-alt-title">
          <form data-image-alt-form>
            <span class="eyebrow">Accessibility</span>
            <h2 id="image-alt-title">Describe this image</h2>
            <p>Alt text helps people using screen readers understand what this card shows.</p>
            <label><span>Alt text <i>optional</i></span><textarea data-image-alt-input rows="4" placeholder="Describe the important visual information"></textarea></label>
            <small><output data-image-alt-count>0</output> / ${MAX_IMAGE_ALT_CODE_POINTS}</small>
            <div class="dialog-actions">
              <button type="button" data-image-alt-cancel>Cancel</button>
              <button class="primary-button" type="submit">Save alt text</button>
            </div>
          </form>
        </dialog>

        <div class="recovery-banner" data-testid="recovery-banner" hidden>
          <div><strong data-recovery-title>Unsaved recovery data</strong><span data-recovery-message>Some commands are too old to resend safely.</span></div>
          <button type="button" data-recovery-download>Download JSON</button>
          <button type="button" data-recovery-discard hidden>Discard unsaved edits</button>
          <button type="button" data-recovery-dismiss aria-label="Dismiss recovery notice">×</button>
        </div>

        <div class="toast-region" data-testid="toast-region" aria-label="Notifications"></div>
        <div class="sr-only" data-testid="live-region" aria-live="assertive"></div>
      </div>
    `;

    const rail = query(this.root, "[data-testid='tool-rail']", HTMLElement);
    const shapeGrid = query(this.root, "[data-shape-menu-grid]", HTMLElement);
    const moreToolsGrid = query(this.root, "[data-more-tools-grid]", HTMLElement);
    for (const definition of TOOL_DEFINITIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tool = definition.name;
      button.dataset.testid = `tool-${definition.name}`;
      button.setAttribute("aria-label", `${definition.label} (${definition.shortcut})`);
      button.setAttribute("aria-pressed", definition.name === "pencil" ? "true" : "false");
      if (definition.name === "rectangle") {
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-controls", "shape-menu");
        button.setAttribute("aria-expanded", "false");
      }
      button.title = `${definition.label} · ${definition.shortcut}`;
      const glyph = document.createElement("span");
      glyph.className = `tool-glyph tool-glyph-${definition.name}`;
      glyph.setAttribute("aria-hidden", "true");
      if (definition.iconSvg) glyph.innerHTML = definition.iconSvg;
      else glyph.textContent = definition.glyph;
      const label = document.createElement("span");
      label.className = "tool-label";
      label.textContent = definition.dockLabel;
      button.append(glyph, label);
      if (definition.name === "line") {
        button.setAttribute("role", "menuitem");
        button.classList.add("shape-menu-tool");
        glyph.className = "shape-choice-glyph";
        label.className = "";
        shapeGrid.append(button);
      } else if (definition.name === "eraser") {
        button.classList.add("brush-preset");
        label.remove();
        query(this.root, "[data-brush-preset-group]", HTMLElement).append(button);
      } else if (MORE_TOOL_NAMES.has(definition.name)) {
        button.setAttribute("role", "menuitem");
        button.classList.add("more-tool-choice");
        moreToolsGrid.append(button);
      } else {
        rail.append(button);
      }
      if (definition.name === "image") {
        const video = document.createElement("button");
        video.type = "button";
        video.dataset.videoEmbed = "true";
        video.dataset.testid = "tool-video";
        video.setAttribute("aria-label", "Embed video");
        video.title = "Embed a YouTube or Vimeo video";
        video.innerHTML =
          '<span class="tool-glyph tool-glyph-video" aria-hidden="true">▶</span><span class="tool-label">Video</span>';
        moreToolsGrid.append(video);
      }
    }
    const aiShare = document.createElement("button");
    aiShare.type = "button";
    const moreToolsButton = document.createElement("button");
    moreToolsButton.type = "button";
    moreToolsButton.dataset.moreTools = "true";
    moreToolsButton.dataset.testid = "tool-more";
    moreToolsButton.setAttribute("aria-label", "More tools");
    moreToolsButton.setAttribute("aria-haspopup", "menu");
    moreToolsButton.setAttribute("aria-controls", "tools-menu");
    moreToolsButton.setAttribute("aria-expanded", "false");
    moreToolsButton.setAttribute("aria-pressed", "false");
    moreToolsButton.title = "More tools";
    moreToolsButton.innerHTML =
      '<span class="tool-glyph tool-glyph-more" aria-hidden="true">•••</span><span class="tool-label">More</span>';
    rail.append(moreToolsButton);
    aiShare.dataset.aiShare = "true";
    aiShare.dataset.testid = "tool-ai";
    aiShare.hidden = true;
    aiShare.setAttribute("aria-label", "Share the whole board with the AI assistant");
    aiShare.setAttribute("aria-haspopup", "menu");
    aiShare.setAttribute("aria-controls", "ai-share-menu");
    aiShare.setAttribute("aria-expanded", "false");
    aiShare.title = "Share the whole board with the AI assistant";
    aiShare.innerHTML = `${aiSparkleIcon("tool-glyph")}<span class="tool-label">AI</span>`;
    rail.append(aiShare);

    // Templates are a secondary creation tool in More. Its fixed popover stays at workspace
    // level so it is not clipped when the More menu closes.
    const activitiesWrap = query(this.root, ".activities-wrap", HTMLElement);
    const activitiesButton = query(
      activitiesWrap,
      "[data-testid='activities-button']",
      HTMLElement,
    );
    const activitiesMenu = query(activitiesWrap, "[data-testid='activities-menu']", HTMLElement);
    activitiesButton.classList.remove("topbar-button");
    query(activitiesButton, ".activities-button-mark", HTMLElement).classList.add("tool-glyph");
    query(activitiesButton, ".activities-button-label", HTMLElement).classList.add("tool-label");
    activitiesButton.classList.add("more-tool-choice");
    activitiesButton.setAttribute("role", "menuitem");
    moreToolsGrid.append(activitiesButton);
    query(this.root, ".workspace", HTMLElement).append(activitiesMenu);
    activitiesWrap.remove();

    const divider = document.createElement("span");
    divider.className = "tool-divider";
    divider.setAttribute("aria-hidden", "true");
    rail.append(divider);
    const styleShortcut = document.createElement("button");
    styleShortcut.type = "button";
    styleShortcut.dataset.openStyle = "true";
    styleShortcut.dataset.testid = "style-button";
    styleShortcut.setAttribute("aria-label", "Drawing style");
    styleShortcut.setAttribute("aria-controls", "style-popover");
    styleShortcut.setAttribute("aria-pressed", "false");
    styleShortcut.innerHTML =
      '<span class="rail-color-dot" aria-hidden="true"></span><span class="tool-label">Style</span>';
    rail.append(styleShortcut);

    for (const choice of SHAPE_CHOICES) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.shapeVariant = choice.variant;
      button.dataset.shapeTool = choice.tool;
      button.dataset.testid = `shape-${choice.variant}`;
      button.setAttribute("aria-label", choice.label);
      button.setAttribute("aria-pressed", String(choice.variant === this.style.shapeVariant));
      const glyph = document.createElement("span");
      glyph.className = "shape-choice-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = choice.glyph;
      const label = document.createElement("span");
      label.textContent = choice.label;
      button.append(glyph, label);
      shapeGrid.append(button);
    }

    const colorGrid = query(this.root, "[data-color-grid]", HTMLElement);
    const quickColours = query(this.root, "[data-quick-colours]", HTMLElement);
    DRAWING_COLORS.forEach(({ value: color }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "color-choice";
      button.dataset.color = color;
      button.setAttribute("aria-label", `Use ${color}`);
      button.setAttribute("aria-pressed", String(color === this.style.color));
      button.style.setProperty("--choice-color", color);
      colorGrid.append(button);
      const quickButton = document.createElement("button");
      quickButton.type = "button";
      quickButton.className = "quick-colour";
      quickButton.dataset.quickColor = color;
      quickButton.setAttribute("aria-label", `Draw with ${color}`);
      quickButton.setAttribute("aria-pressed", String(color === this.style.color));
      quickButton.style.setProperty("--choice-color", color);
      quickColours.append(quickButton);
    });
    const stickyColorGrid = query(this.root, "[data-sticky-color-grid]", HTMLElement);
    STICKY_COLORS.forEach(({ name, value }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "color-choice sticky-color-choice";
      button.dataset.stickyColor = value;
      button.setAttribute("aria-label", `Use ${name.toLowerCase()} sticky notes`);
      button.setAttribute("aria-pressed", String(value === this.style.stickyFill));
      button.style.setProperty("--choice-color", value);
      stickyColorGrid.append(button);
    });
    const selectionColourMenu = query(
      this.root,
      "[data-testid='selection-colour-menu']",
      HTMLElement,
    );
    const addSelectionColour = (
      name: string,
      value: string,
      palette: "sticky" | "drawing",
    ): void => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "selection-colour-choice";
      button.dataset.selectionColour = value;
      button.dataset.palette = palette;
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-label", `${name} colour`);
      button.setAttribute("aria-checked", "false");
      button.style.setProperty("--choice-color", value);
      selectionColourMenu.append(button);
    };
    STICKY_COLORS.forEach(({ name, value }) => {
      addSelectionColour(name, value, "sticky");
    });
    DRAWING_COLORS.forEach(({ name, value }) => {
      addSelectionColour(name, value, "drawing");
    });
    const stampGrid = query(this.root, "[data-stamp-grid]", HTMLElement);
    STAMP_CHOICES.forEach(({ kind, name, glyph }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stamp-choice";
      button.dataset.stampKind = kind;
      button.dataset.testid = `stamp-choice-${kind}`;
      button.setAttribute("aria-label", `Use ${name.toLowerCase()} stamp`);
      button.setAttribute("aria-pressed", String(kind === this.style.stampKind));
      const mark = document.createElement("span");
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = glyph;
      button.append(mark);
      stampGrid.append(button);
    });
  }

  private buildActivitiesMenu(): void {
    const list = query(this.activitiesMenu, "[data-activities-template-list]", HTMLElement);
    for (const template of ACTIVITY_TEMPLATES) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.activityTemplate = template.id;
      button.dataset.testid = `activity-${template.id}`;
      button.setAttribute("role", "menuitem");
      button.setAttribute("aria-label", `Add ${template.label} template`);
      const label = document.createElement("strong");
      label.textContent = template.label;
      const description = document.createElement("span");
      description.textContent = template.description;
      button.append(label, description);
      button.addEventListener("click", () => {
        void this.insertActivity(template.id);
      });
      list.append(button);
    }
  }

  private async insertActivity(templateId: ActivityTemplateId): Promise<void> {
    if (!this.bootstrap.board.features.templates || !this.canCommit() || this.activityInsertPending)
      return;
    const template = ACTIVITY_TEMPLATES.find((value) => value.id === templateId);
    if (!template) return;
    const featureIssue = templateAvailabilityIssue(template, this.bootstrap.board.features);
    if (featureIssue) {
      // A hidden button cannot be clicked, so there is nobody to tell.
      if (!templateHiddenByVoting(template.id, this.bootstrap.board.features))
        this.notify(featureIssue, "warning");
      return;
    }
    this.activityInsertPending = true;
    this.updatePermissions();
    this.activitiesButton.focus();
    try {
      const view = this.renderer.viewport.viewState;
      const activity = buildActivityBatch(templateId, [view.center.x, view.center.y], createId);
      const accepted = await this.commit(activity.operation);
      if (!accepted) return;
      this.closeActivitiesMenu();
      this.tools.setTool("select");
      this.tools.selectOnly(activity.itemIds);
      this.renderer.viewport.fit(this.model.boundsFor(activity.itemIds));
      this.notify(`${template.label} added.`, "info");
    } finally {
      this.activityInsertPending = false;
      this.updatePermissions();
    }
  }

  private async loadOrganisationTemplates(): Promise<void> {
    if (!this.bootstrap.board.features.organisationTemplates) return;
    if (this.organisationTemplatesLoading) return;
    this.organisationTemplatesLoading = true;
    this.organisationTemplatesError = null;
    this.renderOrganisationTemplates();
    try {
      const collection = await this.api.organisationTemplates(this.bootstrap.board.id);
      this.organisationId = collection.organisationId;
      this.organisationTemplatesCanManage = collection.canManage;
      this.organisationTemplates = collection.templates;
    } catch (error) {
      this.organisationTemplatesError =
        error instanceof ApiError ? error.message : "Organisation templates could not be loaded.";
    } finally {
      this.organisationTemplatesLoading = false;
      this.organisationTemplatesLoaded = true;
      this.renderOrganisationTemplates();
      this.updateOrganisationTemplateSaveButton();
    }
  }

  private renderOrganisationTemplates(): void {
    const section = query(
      this.activitiesMenu,
      "[data-organisation-templates-section]",
      HTMLElement,
    );
    const list = query(section, "[data-organisation-template-list]", HTMLElement);
    const status = query(section, "[data-organisation-template-status]", HTMLElement);
    section.hidden =
      !this.bootstrap.board.features.organisationTemplates || this.organisationId === null;
    list.replaceChildren();
    status.textContent = "";
    if (section.hidden) return;

    for (const template of this.organisationTemplates) {
      const row = document.createElement("div");
      row.className = "organisation-template-row";
      const add = document.createElement("button");
      add.type = "button";
      add.dataset.organisationTemplate = template.id;
      add.dataset.testid = `organisation-template-${template.id}`;
      add.setAttribute("role", "menuitem");
      add.setAttribute("aria-label", `Add ${template.name} organisation template`);
      const label = document.createElement("strong");
      label.textContent = template.name;
      const description = document.createElement("span");
      description.textContent = template.description ?? `${template.items.length} objects`;
      add.append(label, description);
      const featureIssue = templateFeatureIssue(template.items, this.bootstrap.board.features);
      add.disabled = featureIssue !== null;
      add.title = featureIssue ?? "";
      add.addEventListener("click", () => void this.insertOrganisationTemplate(template));
      row.append(add);

      if (this.organisationTemplatesCanManage && this.bootstrap.actor.role === "owner") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "organisation-template-delete";
        remove.dataset.deleteOrganisationTemplate = template.id;
        remove.setAttribute("role", "menuitem");
        remove.setAttribute("aria-label", `Delete ${template.name} organisation template`);
        remove.title = "Delete organisation template";
        remove.textContent = "×";
        remove.disabled = this.organisationTemplateDeletesPending.has(template.id);
        remove.addEventListener("click", () => void this.deleteOrganisationTemplate(template));
        row.append(remove);
      }
      list.append(row);
    }

    if (this.organisationTemplatesLoading && !this.organisationTemplatesLoaded) {
      status.textContent = "Loading organisation templates…";
    } else if (this.organisationTemplatesError) {
      status.textContent = this.organisationTemplatesError;
    } else if (this.organisationTemplates.length === 0) {
      status.textContent = "No organisation templates yet.";
    }
    this.updateOrganisationTemplateSaveButton();
  }

  private async insertOrganisationTemplate(template: OrganisationTemplate): Promise<void> {
    if (
      !this.bootstrap.board.features.organisationTemplates ||
      !this.canCommit() ||
      this.activityInsertPending
    )
      return;
    const featureIssue = templateFeatureIssue(template.items, this.bootstrap.board.features);
    if (featureIssue) {
      this.notify(featureIssue, "warning");
      return;
    }
    const maxBatchItems = Math.max(
      1,
      Math.min(100, Math.floor(this.bootstrap.limits.maxBatchItems)),
    );
    if (template.items.length > maxBatchItems) {
      this.notify(`This template exceeds the ${maxBatchItems}-object Space limit.`, "warning");
      return;
    }
    this.activityInsertPending = true;
    this.updatePermissions();
    this.activitiesButton.focus();
    try {
      const view = this.renderer.viewport.viewState;
      const batch = buildOrganisationTemplateBatch(
        template,
        [view.center.x, view.center.y],
        createId,
        this.bootstrap.board.features.grouping,
      );
      const accepted = await this.commit(batch.operation);
      if (!accepted) return;
      this.closeActivitiesMenu();
      this.tools.setTool("select");
      this.tools.selectOnly(batch.itemIds);
      this.renderer.viewport.fit(this.model.boundsFor(batch.itemIds));
      this.notify(`${template.name} added.`, "info");
    } catch (error) {
      this.notify(
        error instanceof OrganisationTemplateError
          ? error.message
          : "This organisation template could not be added.",
        "error",
      );
    } finally {
      this.activityInsertPending = false;
      this.updatePermissions();
    }
  }

  private openOrganisationTemplateDialog(): void {
    if (
      this.bootstrap.actor.role !== "owner" ||
      !this.bootstrap.board.features.organisationTemplates ||
      !this.organisationTemplatesCanManage ||
      this.organisationId === null
    ) {
      return;
    }
    const selectedIds = [...this.tools.selection];
    const items = savedAuthoritativeItems(
      selectedIds,
      this.model.items,
      this.model.authoritativeItems,
    );
    const maxItems = Math.max(1, Math.min(100, Math.floor(this.bootstrap.limits.maxBatchItems)));
    const issue = items
      ? organisationTemplateSelectionIssue(items, maxItems)
      : "Wait for the selected objects to finish saving.";
    if (issue || !items) {
      this.notify(issue ?? "Select saved objects first.", "warning");
      return;
    }
    this.organisationTemplateItemsToSave = items.map((item) => structuredClone(item));
    this.organisationTemplateName.value = "";
    this.organisationTemplateDescription.value = "";
    query(
      this.organisationTemplateDialog,
      "[data-organisation-template-count]",
      HTMLElement,
    ).textContent = `${items.length} selected object${items.length === 1 ? "" : "s"}`;
    const error = query(
      this.organisationTemplateDialog,
      "[data-organisation-template-error]",
      HTMLElement,
    );
    error.hidden = true;
    error.textContent = "";
    this.closeActivitiesMenu();
    this.organisationTemplateDialog.showModal();
    this.organisationTemplateName.focus();
  }

  private async saveOrganisationTemplate(): Promise<void> {
    if (
      this.organisationTemplateSavePending ||
      this.bootstrap.actor.role !== "owner" ||
      !this.bootstrap.board.features.organisationTemplates
    )
      return;
    const name = this.organisationTemplateName.value.trim();
    const description = this.organisationTemplateDescription.value.trim();
    const error = query(
      this.organisationTemplateDialog,
      "[data-organisation-template-error]",
      HTMLElement,
    );
    if (!name) {
      error.textContent = "Enter a template name.";
      error.hidden = false;
      this.organisationTemplateName.focus();
      return;
    }
    const issue = organisationTemplateSelectionIssue(
      this.organisationTemplateItemsToSave,
      this.bootstrap.limits.maxBatchItems,
    );
    if (issue) {
      error.textContent = issue;
      error.hidden = false;
      return;
    }
    this.organisationTemplateSavePending = true;
    query(
      this.organisationTemplateDialog,
      "[data-organisation-template-submit]",
      HTMLButtonElement,
    ).disabled = true;
    try {
      const created = await this.api.createOrganisationTemplate(this.bootstrap.board.id, {
        name,
        ...(description ? { description } : {}),
        items: this.organisationTemplateItemsToSave,
      });
      this.organisationTemplates = [
        ...this.organisationTemplates.filter((template) => template.id !== created.id),
        created,
      ].sort((left, right) => left.name.localeCompare(right.name));
      this.organisationTemplateDialog.close();
      this.renderOrganisationTemplates();
      this.notify(`${created.name} saved for this organisation.`, "info");
    } catch (cause) {
      error.textContent =
        cause instanceof ApiError
          ? cause.message
          : "This organisation template could not be saved.";
      error.hidden = false;
    } finally {
      this.organisationTemplateSavePending = false;
      query(
        this.organisationTemplateDialog,
        "[data-organisation-template-submit]",
        HTMLButtonElement,
      ).disabled = false;
    }
  }

  private async deleteOrganisationTemplate(template: OrganisationTemplate): Promise<void> {
    if (
      this.bootstrap.actor.role !== "owner" ||
      !this.bootstrap.board.features.organisationTemplates ||
      !this.organisationTemplatesCanManage ||
      this.organisationTemplateDeletesPending.has(template.id) ||
      !confirm(
        `Delete “${template.name}” for every Space in this organisation? Existing board objects will not change.`,
      )
    ) {
      return;
    }
    this.organisationTemplateDeletesPending.add(template.id);
    this.renderOrganisationTemplates();
    try {
      await this.api.deleteOrganisationTemplate(this.bootstrap.board.id, template.id);
      this.organisationTemplates = this.organisationTemplates.filter(
        (candidate) => candidate.id !== template.id,
      );
      this.notify(`${template.name} deleted from organisation templates.`, "info");
    } catch (error) {
      this.notify(
        error instanceof ApiError
          ? error.message
          : "This organisation template could not be deleted.",
        "error",
      );
    } finally {
      this.organisationTemplateDeletesPending.delete(template.id);
      this.renderOrganisationTemplates();
    }
  }

  private updateOrganisationTemplateSaveButton(): void {
    const button = this.activitiesMenu.querySelector<HTMLButtonElement>(
      "[data-save-organisation-template]",
    );
    if (!button) return;
    const canManage =
      this.bootstrap.board.features.organisationTemplates &&
      this.organisationId !== null &&
      this.organisationTemplatesCanManage &&
      this.bootstrap.actor.role === "owner";
    button.hidden = !canManage;
    if (!canManage) return;
    const selectedIds = [...this.tools.selection];
    const selected = savedAuthoritativeItems(
      selectedIds,
      this.model.items,
      this.model.authoritativeItems,
    );
    const issue = selected
      ? organisationTemplateSelectionIssue(selected, this.bootstrap.limits.maxBatchItems)
      : "Wait for the selected objects to finish saving.";
    button.disabled = !this.canCommit() || this.activityInsertPending || issue !== null;
    button.title = issue ?? "Save these objects for every Space in this organisation.";
  }

  private async clearSelectedVotes(): Promise<void> {
    if (
      this.bootstrap.actor.role !== "owner" ||
      !this.bootstrap.board.features.voting ||
      !this.canCommit() ||
      this.tools.selection.size !== 1
    ) {
      return;
    }
    const [selectedId] = this.tools.selection;
    const table = selectedId ? this.model.authoritativeItems.get(selectedId) : undefined;
    if (!table || !isVoteTable(table)) return;
    const clear = buildClearVoteDeletes(table, this.model.authoritativeItems.values());
    if (clear.operations.length === 0) {
      this.notify("There are no saved votes to clear.", "info");
      return;
    }
    const amount = clear.operations.length;
    const cappedNote = clear.remaining > 0 ? ` ${clear.remaining} more will remain.` : "";
    if (
      !confirm(`Clear ${amount} vote${amount === 1 ? "" : "s"} from this template?${cappedNote}`)
    ) {
      return;
    }
    const accepted = await this.commit({ kind: "items.batch", operations: clear.operations });
    if (!accepted) return;
    this.notify(
      clear.remaining > 0
        ? `${amount} votes cleared. ${clear.remaining} remain; clear again to remove the next group.`
        : `${amount} vote${amount === 1 ? "" : "s"} cleared.`,
      "info",
    );
  }

  private async recolourSelectedElements(color: string): Promise<void> {
    if (!this.canCommit()) return;
    const selectedIds = [...this.tools.selection];
    const limit = Math.max(1, Math.min(100, Math.floor(this.bootstrap.limits.maxBatchItems)));
    if (selectedIds.length > limit) {
      this.notify(`Recolour ${limit} elements or fewer at a time.`, "warning");
      return;
    }
    const items = savedAuthoritativeItems(
      selectedIds,
      this.model.items,
      this.model.authoritativeItems,
    );
    if (!items) {
      this.tools.reconcileSelection();
      this.notify("Wait for every selected element to finish saving.", "info");
      return;
    }
    if (items.some((item) => !this.canModifyItem(item))) {
      this.notify("You can edit only work that you created.", "warning");
      return;
    }
    const operations = buildElementColourOperations(items, color);
    if (operations.length === 0) {
      this.notify(
        items.every((item) => elementColour(item) === color)
          ? "Those elements already use that colour."
          : "The selected element does not support colour changes.",
        "info",
      );
      return;
    }
    await this.commit({ kind: "items.batch", operations });
  }

  private async restyleSelectedText(patch: TextStylePatch): Promise<void> {
    if (!this.canCommit()) return;
    const selectedIds = [...this.tools.selection];
    const limit = Math.max(1, Math.min(100, Math.floor(this.bootstrap.limits.maxBatchItems)));
    if (selectedIds.length > limit) {
      this.notify(`Style ${limit} text elements or fewer at a time.`, "warning");
      return;
    }
    const items = savedAuthoritativeItems(
      selectedIds,
      this.model.items,
      this.model.authoritativeItems,
    );
    if (!items) {
      this.notify("Wait for every selected text element to finish saving.", "info");
      return;
    }
    if (items.some((item) => !this.canModifyItem(item))) {
      this.notify("You can edit only work that you created.", "warning");
      return;
    }
    const operations = buildTextStyleOperations(
      items,
      patch,
      this.model.authoritativeItems.values(),
      this.bootstrap.board.features.grouping,
    );
    if (operations.length > 0) await this.commit({ kind: "items.batch", operations });
  }

  private async toggleSelectedSectionLock(): Promise<void> {
    if (this.bootstrap.actor.role !== "owner" || !this.canCommit()) return;
    const [selectedId] = this.tools.selection;
    if (this.tools.selection.size !== 1 || selectedId === undefined) return;
    const selected = savedAuthoritativeItems(
      [selectedId],
      this.model.items,
      this.model.authoritativeItems,
    )?.[0];
    if (selected?.kind !== "zone") return;
    const nextLocked = selected.geometry.locked !== true;
    const accepted = await this.commit({
      kind: "item.update",
      itemId: selected.id,
      expectedVersion: selected.version,
      patch: { geometry: { ...selected.geometry, locked: nextLocked } },
    });
    if (accepted) {
      this.notify(
        nextLocked
          ? "Section locked. Its contents are now read only for everyone."
          : "Section unlocked. Its contents can be edited again.",
        "info",
      );
    }
  }

  private async arrangeSelection(kind: ArrangeKind): Promise<void> {
    if (!this.canCommit()) return;
    const selectedIds = [...this.tools.selection];
    const seedIds =
      kind === "tidy-stickies"
        ? selectedIds.filter((id) => this.model.getItem(id)?.kind === "sticky")
        : selectedIds;
    const minimum = kind.startsWith("distribute-") ? 3 : 2;
    if (seedIds.length < minimum) return;
    const participantIds = this.bootstrap.board.features.grouping
      ? explicitGroupClosure(this.model.items.values(), seedIds).map((item) => item.id)
      : seedIds;
    const limit = Math.max(1, Math.min(100, Math.floor(this.bootstrap.limits.maxBatchItems)));
    if (participantIds.length > limit) {
      this.notify(`Arrange ${limit} items or fewer at a time.`, "warning");
      return;
    }
    const items = savedAuthoritativeItems(
      participantIds,
      this.model.items,
      this.model.authoritativeItems,
    );
    if (!items) {
      this.notify("Wait for every selected item to finish saving before arranging.", "info");
      return;
    }
    const directUpdates = buildArrangeUpdates(kind, items, this.bootstrap.board.features.grouping);
    this.setArrangeMenuOpen(false);
    this.arrangeButton.focus();
    if (directUpdates.length === 0) {
      this.notify("Those items are already arranged that way.", "info");
      return;
    }
    let operations: BatchItemOperation[];
    try {
      operations = buildTranslationMembershipOperations(
        directUpdates,
        this.model.items.values(),
        this.bootstrap.board.features.grouping,
        (item) => this.canModifyItem(item),
        limit,
      );
    } catch (error) {
      if (!(error instanceof GroupingError)) throw error;
      this.notify(error.message, "warning");
      return;
    }
    const accepted = await this.commit({ kind: "items.batch", operations });
    if (accepted) this.notify(arrangeSuccessMessage(kind), "info");
  }

  private bindShellEvents(): void {
    this.moreToolsButton.addEventListener("click", () => {
      const opening = this.toolsMenu.hidden === true;
      if (opening) this.tools.setTool("select");
      this.setShapeMenuOpen(false);
      this.setToolsMenuOpen(opening);
      if (opening) this.toolsMenu.querySelector<HTMLButtonElement>("button:not([hidden])")?.focus();
    });
    const toolRail = query(this.root, "[data-testid='tool-rail']", HTMLElement);
    toolRail.addEventListener("scroll", () => this.updateToolRailOverflow(), { passive: true });
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tool-rail-scroll]")) {
      button.addEventListener("click", () => {
        const direction = Number(button.dataset.toolRailScroll);
        toolRail.scrollBy({
          left: direction * Math.max(160, toolRail.clientWidth * 0.7),
          behavior: "smooth",
        });
      });
    }
    this.toolRailResizeObserver = new ResizeObserver(() => this.updateToolRailOverflow());
    this.toolRailResizeObserver.observe(toolRail);
    window.requestAnimationFrame(() => this.updateToolRailOverflow());

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-tool]")) {
      button.addEventListener("click", () => this.activateTool(button.dataset.tool as ToolName));
    }
    query(this.toolsMenu, "[data-tools-tool='protractor']", HTMLButtonElement).addEventListener(
      "click",
      () => {
        if (!this.isToolEnabled("protractor") || !this.canCommit()) return;
        this.setToolsMenuOpen(false);
        this.tools.setTool("protractor");
      },
    );
    for (const button of this.shapeMenu.querySelectorAll<HTMLButtonElement>(
      "[data-shape-variant]",
    )) {
      button.addEventListener("click", () => {
        const variant = button.dataset.shapeVariant as ShapeVariant | undefined;
        const tool = button.dataset.shapeTool as ToolName | undefined;
        if (!variant || !tool || !this.isShapeVariantEnabled(variant)) return;
        this.style.shapeVariant = variant;
        this.setShapeMenuOpen(false);
        this.tools.setTool(tool);
        this.setActiveToolButton(tool);
      });
    }
    const tableColumns = query(this.root, "[data-table-columns]", HTMLSelectElement);
    const tableRows = query(this.root, "[data-table-rows]", HTMLSelectElement);
    const tableHeader = query(this.root, "[data-table-header]", HTMLInputElement);
    const tablePickerForm = query(
      this.tablePickerDialog,
      "[data-table-picker-form]",
      HTMLFormElement,
    );
    const cancelTablePicker = (): void => {
      this.setTablePickerOpen(false);
      if (this.tools.tool === "table") this.tools.setTool("select");
      query(this.root, "[data-testid='tool-select']", HTMLButtonElement).focus();
    };
    tablePickerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.setTablePickerOpen(false);
    });
    query(this.tablePickerDialog, "[data-table-picker-cancel]", HTMLButtonElement).addEventListener(
      "click",
      cancelTablePicker,
    );
    this.tablePickerDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      cancelTablePicker();
    });
    tableColumns.addEventListener("change", () => {
      this.style.tableColumns = Math.max(1, Math.min(6, Number(tableColumns.value)));
    });
    tableRows.addEventListener("change", () => {
      this.style.tableRows = Math.max(1, Math.min(8, Number(tableRows.value)));
    });
    tableHeader.addEventListener("change", () => {
      this.style.tableHeaderRow = tableHeader.checked;
    });
    const toggleStyle = (): void => this.setStylePopoverOpen(Boolean(this.stylePopover.hidden));
    query(this.root, "[data-style-trigger]", HTMLButtonElement).addEventListener(
      "click",
      toggleStyle,
    );
    query(this.root, "[data-open-style]", HTMLButtonElement).addEventListener("click", toggleStyle);

    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      button.addEventListener("click", () => {
        const next = button.dataset.color ?? this.style.color;
        if (this.tools.tool === "stamp") this.style.stampColor = next;
        else this.style.color = next;
        this.updateStyleControls();
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-quick-color]")) {
      button.addEventListener("click", () => {
        this.style.color = button.dataset.quickColor ?? this.style.color;
        this.updateStyleControls();
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-brush-preset]")) {
      button.addEventListener("click", () => {
        const preset = button.dataset.brushPreset as BrushPreset | undefined;
        if (!preset) return;
        this.style.width = BRUSH_PRESETS[preset].width;
        this.style.opacity = BRUSH_PRESETS[preset].opacity;
        this.tools.setTool("pencil");
        this.setActiveToolButton("pencil");
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-sticky-color]")) {
      button.addEventListener("click", () => {
        this.style.stickyFill = button.dataset.stickyColor ?? this.style.stickyFill;
        this.updateStyleControls();
      });
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-stamp-kind]")) {
      button.addEventListener("click", () => {
        const kind = button.dataset.stampKind as StampKind | undefined;
        if (kind) this.style.stampKind = kind;
        this.updateStyleControls();
      });
    }
    const color = query(this.root, "[data-style-color]", HTMLInputElement);
    color.addEventListener("input", () => {
      const next = color.value.toLowerCase();
      if (this.tools.tool === "stamp") this.style.stampColor = next;
      else this.style.color = next;
      this.updateStyleControls();
    });
    const stroke = query(this.root, "[data-style-stroke]", HTMLInputElement);
    stroke.addEventListener("input", () => {
      this.style.width = Number(stroke.value);
      this.updateStyleControls();
    });
    const lineArrow = query(this.root, "[data-line-arrow]", HTMLInputElement);
    lineArrow.addEventListener("change", () => {
      this.style.lineArrowhead = lineArrow.checked ? "arrow" : "none";
      this.updateStyleControls();
    });
    const opacity = query(this.root, "[data-style-opacity]", HTMLInputElement);
    opacity.addEventListener("input", () => {
      if (this.tools.tool === "sticky") this.style.stickyOpacity = Number(opacity.value) / 100;
      else if (this.tools.tool === "stamp") this.style.stampOpacity = Number(opacity.value) / 100;
      else this.style.opacity = Number(opacity.value) / 100;
      this.updateStyleControls();
    });
    const font = query(this.root, "[data-style-font]", HTMLInputElement);
    font.addEventListener("input", () => {
      if (this.tools.tool === "sticky") this.style.stickyFontSize = Number(font.value);
      else this.style.fontSize = Number(font.value);
      this.updateStyleControls();
    });
    query(this.root, "[data-style-font-family]", HTMLSelectElement).addEventListener(
      "change",
      (event) => {
        this.style.fontFamily = (event.currentTarget as HTMLSelectElement).value as TextFontFamily;
        this.updateStyleControls();
      },
    );

    this.undoButton.addEventListener("click", () => void this.undo());
    this.redoButton.addEventListener("click", () => void this.redo());
    this.selectionColourButton.addEventListener("click", () => {
      if (this.selectionColourButton.disabled) return;
      this.setSelectionColourMenuOpen(this.selectionColourMenu.hidden !== false);
    });
    for (const button of this.selectionColourMenu.querySelectorAll<HTMLButtonElement>(
      "[data-selection-colour]",
    )) {
      button.addEventListener("click", () => {
        const color = button.dataset.selectionColour;
        if (color) void this.recolourSelectedElements(color);
        this.setSelectionColourMenuOpen(false);
      });
    }
    query(
      this.selectionActions,
      "[data-selection-font-family]",
      HTMLSelectElement,
    ).addEventListener("change", (event) => {
      const fontFamily = (event.currentTarget as HTMLSelectElement).value as TextFontFamily;
      void this.restyleSelectedText({ fontFamily });
    });
    query(this.selectionActions, "[data-selection-font-size]", HTMLSelectElement).addEventListener(
      "change",
      (event) => {
        const fontSize = Number((event.currentTarget as HTMLSelectElement).value);
        void this.restyleSelectedText({ fontSize });
      },
    );
    const toggleTextStyle = (
      key: "fontWeight" | "fontStyle" | "textDecoration",
      active: "bold" | "italic" | "underline",
      inactive: "normal" | "none",
    ): void => {
      const items = [...this.tools.selection].flatMap((id) => {
        const item = this.model.getItem(id);
        return item && supportsTextStyling(item) ? [item] : [];
      });
      const allActive =
        items.length > 0 &&
        items.every((item) =>
          key === "fontWeight"
            ? effectiveTextFontWeight(item) === "bold"
            : item.style[key] === active,
        );
      void this.restyleSelectedText({ [key]: allActive ? inactive : active });
    };
    query(
      this.selectionActions,
      "[data-selection-font-weight]",
      HTMLButtonElement,
    ).addEventListener("click", () => toggleTextStyle("fontWeight", "bold", "normal"));
    query(this.selectionActions, "[data-selection-font-style]", HTMLButtonElement).addEventListener(
      "click",
      () => toggleTextStyle("fontStyle", "italic", "normal"),
    );
    query(
      this.selectionActions,
      "[data-selection-text-decoration]",
      HTMLButtonElement,
    ).addEventListener("click", () => toggleTextStyle("textDecoration", "underline", "none"));
    this.selectionColourMenu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.setSelectionColourMenuOpen(false);
      this.selectionColourButton.focus();
    });
    query(this.root, "[data-selection-comment]", HTMLButtonElement).addEventListener(
      "click",
      () => {
        const [itemId] = this.tools.selection;
        if (itemId && this.tools.selection.size === 1) this.openCommentsForItem(itemId);
      },
    );
    query(this.root, "[data-selection-section-lock]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.toggleSelectedSectionLock(),
    );
    query(this.root, "[data-selection-group]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.tools.groupSelection(),
    );
    query(this.root, "[data-selection-ungroup]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.tools.ungroupSelection(),
    );
    query(this.root, "[data-selection-clear-votes]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.clearSelectedVotes(),
    );
    this.arrangeButton.addEventListener("click", () => {
      if (this.arrangeButton.disabled) return;
      const opening = this.arrangeMenu.hidden !== false;
      this.setArrangeMenuOpen(opening);
      if (opening) this.arrangeMenu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    });
    this.aiShareButton.addEventListener("click", () => {
      if (this.aiShareButton.hidden) return;
      const opening = this.aiShareMenu.hidden !== false;
      this.setAiShareMenuOpen(opening);
      if (opening) this.aiShareMenu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    });
    for (const button of this.aiShareMenu.querySelectorAll<HTMLButtonElement>(
      "[data-ai-share-action]",
    )) {
      button.addEventListener("click", () => {
        const action = button.dataset.aiShareAction;
        if (action && (ASSIST_ACTIONS as readonly string[]).includes(action)) {
          this.shareBoardWithAi(action as AssistAction);
        }
      });
    }
    this.aiShareMenu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.setAiShareMenuOpen(false);
      this.aiShareButton.focus();
    });
    this.aiAssistButton.addEventListener("click", () => {
      if (this.aiAssistButton.disabled) return;
      const opening = this.aiAssistMenu.hidden !== false;
      this.setAiAssistMenuOpen(opening);
      if (opening) this.aiAssistMenu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    });
    for (const button of this.aiAssistMenu.querySelectorAll<HTMLButtonElement>(
      "[data-ai-action]",
    )) {
      button.addEventListener("click", () => {
        const action = button.dataset.aiAction;
        if (action && (ASSIST_ACTIONS as readonly string[]).includes(action)) {
          this.sendAiAssistRequest(action as AssistAction);
        }
      });
    }
    this.aiAssistMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.setAiAssistMenuOpen(false);
        this.aiAssistButton.focus();
        return;
      }
      if (event.key === "Enter" && event.target === this.aiAssistNote) {
        // Enter in the note picks the first action so keyboard users can send without tabbing back.
        event.preventDefault();
        this.aiAssistMenu.querySelector<HTMLButtonElement>("[data-ai-action]")?.click();
      }
    });
    for (const button of this.arrangeMenu.querySelectorAll<HTMLButtonElement>("[data-arrange]")) {
      button.addEventListener("click", () => {
        void this.arrangeSelection(button.dataset.arrange as ArrangeKind);
      });
    }
    this.arrangeMenu.addEventListener("keydown", (event) => {
      const items = [
        ...this.arrangeMenu.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
      ].filter((button) => !button.disabled);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.setArrangeMenuOpen(false);
        this.arrangeButton.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || items.length === 0) {
        return;
      }
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowUp"
              ? (current - 1 + items.length) % items.length
              : (current + 1) % items.length;
      items[next]?.focus();
    });

    query(this.root, "[data-selection-alt]", HTMLButtonElement).addEventListener("click", () => {
      const [selectedId] = this.tools.selection;
      const selected = selectedId ? this.model.getItem(selectedId) : undefined;
      if (selected?.kind === "image") this.openImageAltEditor(selected);
    });
    this.imageInput.addEventListener("change", () => {
      const image = this.imageInput.files?.[0];
      this.imageInput.value = "";
      if (image) void this.uploadImage(image, this.imagePlacementCenter());
    });
    query(this.root, "[data-video-embed]", HTMLButtonElement).addEventListener("click", () => {
      this.setToolsMenuOpen(false);
      this.openVideoEmbedDialog();
    });
    query(this.videoEmbedDialog, "[data-video-embed-form]", HTMLFormElement).addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.addVideoEmbed();
      },
    );
    query(this.videoEmbedDialog, "[data-video-cancel]", HTMLButtonElement).addEventListener(
      "click",
      () => this.videoEmbedDialog.close(),
    );
    this.videoEmbedDialog.addEventListener("close", () => {
      this.videoEmbedUrl.value = "";
      query(this.videoEmbedDialog, "[data-video-error]", HTMLElement).textContent = "";
    });
    query(this.imageAltDialog, "[data-image-alt-form]", HTMLFormElement).addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.saveImageAlt();
      },
    );
    query(this.imageAltDialog, "[data-image-alt-cancel]", HTMLButtonElement).addEventListener(
      "click",
      () => this.closeImageAltEditor(),
    );
    this.imageAltDialog.addEventListener("cancel", () => {
      this.imageAltEdit = null;
    });
    this.imageAltDialog.addEventListener("close", () => {
      this.imageAltEdit = null;
    });
    this.imageAltInput.addEventListener("input", () => {
      const value = clampImageAlt(this.imageAltInput.value);
      if (value !== this.imageAltInput.value) {
        const cursor = Math.min(value.length, this.imageAltInput.selectionStart);
        this.imageAltInput.value = value;
        this.imageAltInput.setSelectionRange(cursor, cursor);
      }
      query(this.imageAltDialog, "[data-image-alt-count]", HTMLOutputElement).value = String(
        [...value].length,
      );
    });
    this.renderer.svg.addEventListener("dragover", this.onImageDragOver);
    this.renderer.svg.addEventListener("drop", this.onImageDrop);
    document.addEventListener("paste", this.onImagePaste);

    this.webMcpStatus.addEventListener("click", () => {
      this.togglePopover(this.mcpActivityMenu, this.webMcpStatus);
    });
    this.mcpActivityMenu.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.closeMcpActivityMenu();
      this.webMcpStatus.focus();
    });

    this.activitiesButton.addEventListener("click", () => {
      if (this.activitiesButton.disabled) return;
      const opening = this.activitiesMenu.hidden;
      this.togglePopover(this.activitiesMenu, this.activitiesButton);
      if (opening) this.setToolsMenuOpen(false);
      if (opening) {
        void this.loadOrganisationTemplates();
        this.activitiesMenu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
      }
    });
    query(
      this.activitiesMenu,
      "[data-save-organisation-template]",
      HTMLButtonElement,
    ).addEventListener("click", () => this.openOrganisationTemplateDialog());
    query(
      this.organisationTemplateDialog,
      "[data-organisation-template-form]",
      HTMLFormElement,
    ).addEventListener("submit", (event) => {
      event.preventDefault();
      void this.saveOrganisationTemplate();
    });
    query(
      this.organisationTemplateDialog,
      "[data-organisation-template-cancel]",
      HTMLButtonElement,
    ).addEventListener("click", () => this.organisationTemplateDialog.close());
    this.organisationTemplateDialog.addEventListener("cancel", () => {
      this.organisationTemplateItemsToSave = [];
    });
    this.organisationTemplateDialog.addEventListener("close", () => {
      this.organisationTemplateItemsToSave = [];
    });
    this.activitiesMenu.addEventListener("keydown", (event) => {
      const items = [
        ...this.activitiesMenu.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
      ];
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.closeActivitiesMenu();
        this.activitiesButton.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || items.length === 0) {
        return;
      }
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowUp"
              ? (current - 1 + items.length) % items.length
              : (current + 1) % items.length;
      items[next]?.focus();
    });
    this.spotlightToggle.addEventListener("click", () => {
      if (this.broadcastSpotlightId) this.stopBroadcastingSpotlight();
      else this.startBroadcastingSpotlight();
    });
    query(this.spotlightFollowBanner, "[data-stop-spotlight]", HTMLButtonElement).addEventListener(
      "click",
      () => this.stopFollowingSpotlight(),
    );

    this.commentsButton.addEventListener("click", () => {
      if (!this.commentsDrawer.hidden && this.commentsFocusItemId !== null) {
        // The drawer is showing one object's comments; widen it to every comment.
        this.commentsFocusItemId = null;
        this.activeCommentTargetId = null;
        this.renderComments();
        return;
      }
      const opening = this.commentsDrawer.hidden;
      if (opening) {
        this.activeCommentTargetId = null;
        this.commentsFocusItemId = null;
      }
      this.toggleDrawer(this.commentsDrawer, this.commentsButton);
      this.renderComments();
    });
    this.showHiddenCommentsInput.addEventListener("change", () => {
      this.showHiddenComments = this.showHiddenCommentsInput.checked;
      this.renderComments();
    });
    query(this.commentsDrawer, "[data-comment-cancel]", HTMLButtonElement).addEventListener(
      "click",
      () => {
        this.activeCommentTargetId = null;
        this.commentInput.value = "";
        this.clearPendingCommentMedia();
        this.renderComments();
      },
    );
    query(this.commentComposer, "[data-comment-add-image]", HTMLButtonElement).addEventListener(
      "click",
      () => this.pickCommentImage(),
    );
    this.commentImageInput.addEventListener("change", () => {
      const image = this.commentImageInput.files?.[0];
      this.commentImageInput.value = "";
      if (image) void this.attachCommentImage(image);
    });
    query(this.commentComposer, "[data-comment-add-video]", HTMLButtonElement).addEventListener(
      "click",
      () => this.openCommentVideoField(),
    );
    query(
      this.commentVideoField,
      "[data-comment-video-attach]",
      HTMLButtonElement,
    ).addEventListener("click", () => this.attachCommentVideo());
    this.commentVideoUrl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      // The field lives inside the comment form, so Enter would post the comment instead.
      event.preventDefault();
      this.attachCommentVideo();
    });
    query(
      this.commentAttachment,
      "[data-comment-attachment-remove]",
      HTMLButtonElement,
    ).addEventListener("click", () => {
      this.clearPendingCommentMedia();
      this.commentInput.focus();
    });
    query(this.commentsDrawer, "[data-comment-form]", HTMLFormElement).addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.submitComment();
      },
    );
    this.renderer.svg.addEventListener("board-comment-open", (event) => {
      const detail = (event as CustomEvent<{ itemId?: unknown }>).detail;
      if (typeof detail?.itemId === "string") this.openCommentsFocused(detail.itemId);
    });

    query(this.root, "[data-testid='participants-button']", HTMLButtonElement).addEventListener(
      "click",
      (event) => {
        this.toggleDrawer(this.participantDrawer, event.currentTarget as HTMLButtonElement);
        this.renderParticipants();
        if (!this.participantDrawer.hidden) void this.loadParticipantRoles();
      },
    );
    this.accessButton.addEventListener("click", () => {
      this.toggleDrawer(this.accessDrawer, this.accessButton);
      if (!this.accessDrawer.hidden) void this.loadAccessPanel();
    });
    this.settingsButton.addEventListener("click", () => {
      this.toggleDrawer(this.settingsDrawer, this.settingsButton);
      if (!this.settingsDrawer.hidden) void this.loadSettingsPanel();
    });
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-close-drawer]")) {
      button.addEventListener("click", () => this.closeDrawers());
    }

    const attributedExportButton = query(
      this.root,
      "[data-export-attributed-json]",
      HTMLButtonElement,
    );
    attributedExportButton.addEventListener("click", () => {
      void this.downloadAttributedJson(attributedExportButton);
    });
    query(this.root, "[data-local-json]", HTMLButtonElement).addEventListener("click", () =>
      this.downloadLocalJson(),
    );
    query(this.root, "[data-local-svg]", HTMLButtonElement).addEventListener("click", () => {
      void this.downloadLocalSvg();
    });

    query(this.root, "[data-zoom-out]", HTMLButtonElement).addEventListener("click", () =>
      this.zoomBy(0.8),
    );
    query(this.root, "[data-zoom-in]", HTMLButtonElement).addEventListener("click", () =>
      this.zoomBy(1.25),
    );
    query(this.root, "[data-zoom-reset]", HTMLButtonElement).addEventListener("click", () =>
      this.renderer.viewport.reset(),
    );
    query(this.root, "[data-zoom-fit]", HTMLButtonElement).addEventListener("click", () =>
      this.renderer.viewport.fit(this.model.boundsFor(this.model.items.keys())),
    );

    this.titleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.titleInput.blur();
      }
      if (event.key === "Escape") {
        this.titleInput.value = this.bootstrap.board.title;
        this.titleInput.blur();
      }
    });
    this.titleInput.addEventListener("change", () => void this.updateTitle());

    query(this.root, "[data-recovery-download]", HTMLButtonElement).addEventListener("click", () =>
      this.downloadLocalJson(),
    );
    query(this.root, "[data-recovery-discard]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.discardFailedOptimisticEdits(),
    );
    query(this.root, "[data-recovery-dismiss]", HTMLButtonElement).addEventListener("click", () => {
      if (!this.optimisticRecovery) this.recoveryBanner.hidden = true;
    });
    window.addEventListener("keydown", this.onGlobalKeyDown);
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      const shapeButton = query(this.root, "[data-testid='tool-rectangle']", HTMLElement);
      const toolsButton = this.moreToolsButton;
      if (
        !this.shapeMenu.hidden &&
        !this.shapeMenu.contains(target) &&
        !shapeButton.contains(target)
      ) {
        this.setShapeMenuOpen(false);
      }
      if (
        !this.aiAssistMenu.hidden &&
        !this.aiAssistMenu.contains(target) &&
        !this.aiAssistButton.contains(target)
      ) {
        this.setAiAssistMenuOpen(false);
      }
      if (
        !this.aiShareMenu.hidden &&
        !this.aiShareMenu.contains(target) &&
        !this.aiShareButton.contains(target)
      ) {
        this.setAiShareMenuOpen(false);
      }
      if (
        !this.toolsMenu.hidden &&
        !this.toolsMenu.contains(target) &&
        !toolsButton.contains(target)
      ) {
        this.setToolsMenuOpen(false);
      }
      if (
        !this.mcpActivityMenu.hidden &&
        !this.mcpActivityMenu.contains(target) &&
        !this.webMcpStatus.contains(target)
      ) {
        this.closeMcpActivityMenu();
      }
      if (
        !this.stylePopover.hidden &&
        !this.stylePopover.contains(target) &&
        !query(this.root, "[data-testid='style-button']", HTMLElement).contains(target)
      ) {
        this.setStylePopoverOpen(false);
      }
      if (
        !this.activitiesMenu.hidden &&
        !this.activitiesMenu.contains(target) &&
        !this.activitiesButton.contains(target)
      ) {
        this.closeActivitiesMenu();
      }
      if (
        !this.arrangeMenu.hidden &&
        !this.arrangeMenu.contains(target) &&
        !this.arrangeButton.contains(target)
      ) {
        this.setArrangeMenuOpen(false);
      }
      if (
        !this.selectionColourMenu.hidden &&
        !this.selectionColourMenu.contains(target) &&
        !this.selectionColourButton.contains(target)
      ) {
        this.setSelectionColourMenuOpen(false);
      }
    });
  }

  private readonly onImageDragOver = (event: DragEvent): void => {
    if (!dataTransferHasImage(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  private readonly onImageDrop = (event: DragEvent): void => {
    const image = firstImageFile(event.dataTransfer);
    if (!image) return;
    event.preventDefault();
    const point = this.renderer.viewport.clientToBoard(event.clientX, event.clientY);
    void this.uploadImage(image, point);
  };

  private readonly onImagePaste = (event: ClipboardEvent): void => {
    if (isEditingTarget(event.target)) return;
    const image = firstImageFile(event.clipboardData);
    if (!image) return;
    event.preventDefault();
    void this.uploadImage(image, this.imagePlacementCenter());
  };

  private canUploadImages(): boolean {
    return (
      this.bootstrap.board.features.images &&
      this.bootstrap.board.imagesEnabled &&
      !this.imageUploadInFlight &&
      this.canCommit()
    );
  }

  private openImagePicker(): void {
    if (!this.bootstrap.board.features.images || !this.bootstrap.board.imagesEnabled) {
      this.notify("Image cards are disabled by the owner.", "warning");
      return;
    }
    if (!navigator.onLine || this.phase !== "ready") {
      this.notify("Upload when reconnected.", "warning");
      return;
    }
    if (!this.canCommit()) {
      this.notify("Drawing is read only.", "warning");
      return;
    }
    if (this.imageUploadInFlight) {
      this.notify("An image is already uploading.", "info");
      return;
    }
    this.imageInput.click();
  }

  private imagePlacementCenter(): Point {
    const bounds = this.renderer.viewport.viewBounds;
    return [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2];
  }

  private openVideoEmbedDialog(): void {
    if (!this.canCommit()) {
      this.notify("Drawing is read only.", "warning");
      return;
    }
    query(this.videoEmbedDialog, "[data-video-error]", HTMLElement).textContent = "";
    if (!this.videoEmbedDialog.open) this.videoEmbedDialog.showModal();
    this.videoEmbedUrl.focus();
  }

  private async addVideoEmbed(): Promise<void> {
    if (this.videoEmbedPending || !this.canCommit()) return;
    const video = videoEmbedFromText(this.videoEmbedUrl.value);
    const error = query(this.videoEmbedDialog, "[data-video-error]", HTMLElement);
    if (!video) {
      error.textContent = "Use a complete HTTPS YouTube or Vimeo video link.";
      this.videoEmbedUrl.focus();
      return;
    }
    error.textContent = "";
    const submit = query(this.videoEmbedDialog, "[data-video-submit]", HTMLButtonElement);
    this.videoEmbedPending = true;
    submit.disabled = true;
    try {
      const center = this.imagePlacementCenter();
      const itemId = createId();
      const accepted = await this.commit({
        kind: "item.create",
        item: {
          id: itemId,
          kind: "text",
          style: {
            kind: "text",
            color: this.style.color,
            fontSize: this.style.fontSize,
            fontFamily: this.style.fontFamily,
            opacity: this.style.opacity,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: {
            x: center[0] - VIDEO_EMBED_WIDTH / 2,
            y: center[1] - VIDEO_EMBED_HEIGHT / 2 + this.style.fontSize,
            text: video.sourceUrl,
            embed: "video",
          },
        },
      });
      if (!accepted) return;
      this.videoEmbedDialog.close();
      this.tools.setTool("select");
      this.tools.selectOnly([itemId]);
      this.notify("Video embedded.", "info");
    } finally {
      this.videoEmbedPending = false;
      submit.disabled = false;
    }
  }

  private async uploadImage(image: File, center: Point): Promise<void> {
    const issue = imageUploadIssue(image);
    if (issue) {
      this.notify(issue, "warning");
      return;
    }
    if (!this.bootstrap.board.imagesEnabled) {
      this.notify("Image cards are disabled by the owner.", "warning");
      return;
    }
    if (!navigator.onLine || this.phase !== "ready") {
      this.notify("Upload when reconnected.", "warning");
      return;
    }
    if (!this.canCommit()) {
      this.notify("Drawing is read only.", "warning");
      return;
    }
    if (this.imageUploadInFlight) {
      this.notify("An image is already uploading.", "info");
      return;
    }

    this.imageUploadInFlight = true;
    this.updatePermissions();
    try {
      const prepared = await privacySafeImageUpload(image);
      const asset = await this.api.uploadBoardImage(this.bootstrap.board.id, prepared);
      if (!this.bootstrap.board.imagesEnabled || !this.canCommit()) {
        this.notify(
          "The image uploaded, but permission changed before its card could be added.",
          "warning",
        );
        return;
      }
      const itemId = createId();
      const accepted = await this.commit(buildImageCreateOperation(itemId, center, asset));
      if (!accepted) {
        this.notify("The image uploaded, but its card could not be added.", "warning");
        return;
      }
      this.tools.setTool("select");
      this.tools.selectOnly([itemId]);
      this.notify("Image added.", "info");
    } catch (error) {
      if (error instanceof ApiError) this.notify(error.message, "error");
      else if (error instanceof ImagePreparationError) this.notify(error.message, "warning");
      else this.notify("The image could not be uploaded.", "error");
    } finally {
      this.imageUploadInFlight = false;
      this.updatePermissions();
    }
  }

  /**
   * Stores one inline image for a WebMCP write. Reuses the board's own upload path, so the same
   * sanitizing, size limits, and private board bucket apply to an AI-supplied picture as to one
   * a participant drops on the canvas.
   */
  private async storeWebMcpImage(
    imageDataUrl: string,
    signal: AbortSignal,
  ): Promise<ImageAssetMetadata> {
    const [asset] = await this.storeEducationVisualImages(
      [{ format: "inline_image", imageDataUrl }],
      signal,
    );
    if (!asset) throw new Error("The image could not be stored.");
    return asset;
  }

  /**
   * Applies a WebMCP rearrangement. Each note carries its own delta, and the board's own rules
   * then decide what travels with it: a note leaving or entering a Section changes membership,
   * and a grouped note brings its group, so the batch can be larger than the notes named. It
   * goes in as one batch, so a class puts the board back with a single undo.
   */
  private async moveItemsFromWebMcp(moves: readonly StickyMove[]): Promise<void> {
    if (moves.length === 0) return;
    const limit = Math.max(1, Math.min(100, Math.floor(this.bootstrap.limits.maxBatchItems)));
    const items = savedAuthoritativeItems(
      moves.map((move) => move.item.id),
      this.model.items,
      this.model.authoritativeItems,
    );
    if (!items) throw new Error("Wait for every note to finish saving before moving it.");
    if (items.some((item) => !this.canModifyItem(item))) {
      throw new Error("This arrangement includes a note this browser cannot modify.");
    }
    const deltaById = new Map(moves.map((move) => [move.item.id, move.delta]));
    // Validated over every note the call named, the ones asked to stay put included: a note left
    // out here is one the spread below could pick up and move behind the caller's back.
    if (this.bootstrap.board.features.grouping) {
      const conflict = conflictingMoveIssue(items, deltaById, this.model.items.values());
      if (conflict) throw new Error(conflict);
    }
    // Only the notes that actually travel reach the batch. A note staying put is unreachable
    // from any of them now that the check above has passed, so leaving it out cannot move it.
    const directUpdates = items.flatMap((item) => {
      const delta = deltaById.get(item.id) ?? { x: 0, y: 0 };
      if (delta.x === 0 && delta.y === 0) return [];
      return [
        {
          kind: "item.update" as const,
          itemId: item.id,
          expectedVersion: item.version,
          patch: { transform: translateMatrix(item.transform, delta.x, delta.y) },
        },
      ];
    });
    if (directUpdates.length === 0) return;
    let operations: BatchItemOperation[];
    try {
      operations = buildTranslationMembershipOperations(
        directUpdates,
        this.model.items.values(),
        this.bootstrap.board.features.grouping,
        (item) => this.canModifyItem(item),
        limit,
      );
    } catch (error) {
      if (!(error instanceof GroupingError)) throw error;
      throw new Error(error.message);
    }
    const accepted = await this.commitAndWait({ kind: "items.batch", operations });
    if (!accepted) throw new Error("The move could not be queued for saving.");
  }

  /** The topmost saved object covering a board point, or undefined when none is saved there. */
  private savedItemAt(point: Point): BoardItem | undefined {
    const hit = this.model.hitTest(point, 0);
    if (!hit) return undefined;
    const [saved] =
      savedAuthoritativeItems([hit.id], this.model.items, this.model.authoritativeItems) ?? [];
    return saved;
  }

  /** The one saved object selected in this browser, or null when the selection is not exactly one. */
  private singleSavedSelection(): BoardItem | null {
    const selection = [...this.tools.selection];
    if (selection.length !== 1) return null;
    const saved = savedAuthoritativeItems(
      selection,
      this.model.items,
      this.model.authoritativeItems,
    );
    return saved?.[0] ?? null;
  }

  private async storeEducationVisualImages(
    sources: readonly EducationVisualSource[],
    signal: AbortSignal,
  ): Promise<readonly BoardImageAsset[]> {
    if (!this.bootstrap.board.imagesEnabled) {
      throw new Error("Image cards are disabled for this Space.");
    }
    if (!navigator.onLine || this.phase !== "ready") {
      throw new Error("Reconnect before adding generated visuals.");
    }
    if (!this.canCommit()) throw new Error("This drawing is read only.");
    if (this.imageUploadInFlight) throw new Error("Another image is already uploading.");

    this.imageUploadInFlight = true;
    this.updatePermissions();
    try {
      const assets: BoardImageAsset[] = [];
      for (const source of sources) {
        signal.throwIfAborted();
        const image = await educationVisualBlob(source);
        const prepared = await privacySafeImageUpload(image);
        signal.throwIfAborted();
        assets.push(await this.api.uploadBoardImage(this.bootstrap.board.id, prepared));
      }
      return assets;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      if (error instanceof ApiError || error instanceof ImagePreparationError) throw error;
      throw new Error("The generated visual could not be prepared or stored.", {
        cause: error,
      });
    } finally {
      this.imageUploadInFlight = false;
      this.updatePermissions();
    }
  }

  private openImageAltEditor(item: Extract<BoardItem, { kind: "image" }>): void {
    if (!this.canCommit()) {
      this.notify("Drawing is read only.", "warning");
      return;
    }
    if (!this.canModifyItem(item)) {
      this.notify("You can edit only work that you created.", "warning");
      return;
    }
    if (item.version <= 0) {
      this.notify("Wait for the image to finish saving before editing alt text.", "info");
      return;
    }
    void this.closeTableCellEditor(false);
    void this.closeZoneTitleEditor(false);
    this.imageAltEdit = {
      itemId: item.id,
      expectedVersion: item.version,
      geometry: structuredClone(item.geometry),
    };
    this.imageAltInput.value = item.geometry.alt ?? "";
    query(this.imageAltDialog, "[data-image-alt-count]", HTMLOutputElement).value = String(
      [...this.imageAltInput.value].length,
    );
    if (!this.imageAltDialog.open) this.imageAltDialog.showModal();
    this.imageAltInput.focus();
    this.imageAltInput.setSelectionRange(
      this.imageAltInput.value.length,
      this.imageAltInput.value.length,
    );
  }

  private closeImageAltEditor(): void {
    this.imageAltEdit = null;
    if (this.imageAltDialog.open) this.imageAltDialog.close();
  }

  private async saveImageAlt(): Promise<void> {
    const edit = this.imageAltEdit;
    if (!edit || !this.canCommit()) {
      this.closeImageAltEditor();
      return;
    }
    const value = clampImageAlt(this.imageAltInput.value).trim();
    const { alt: _previousAlt, ...geometry } = edit.geometry;
    const submit = query(this.imageAltDialog, "button[type='submit']", HTMLButtonElement);
    submit.disabled = true;
    const accepted = await this.commit({
      kind: "item.update",
      itemId: edit.itemId,
      expectedVersion: edit.expectedVersion,
      patch: { geometry: value ? { ...geometry, alt: value } : geometry },
    });
    submit.disabled = false;
    if (accepted) this.closeImageAltEditor();
  }

  private openTableCellEditor(
    item: Extract<BoardItem, { kind: "table" }>,
    row: number,
    column: number,
    recovery?: TableCellDraftRecovery,
  ): void {
    if (!this.canCommit()) {
      this.notify("Drawing is read only.", "warning");
      return;
    }
    if (!this.canModifyItem(item)) {
      this.notify("You can edit only work that you created.", "warning");
      return;
    }
    if (item.version <= 0) {
      this.notify("Wait for the table to finish saving before editing a cell.", "info");
      return;
    }
    const bounds = tableCellLocalBounds(item.geometry, row, column);
    if (!bounds) return;
    void this.closeTextEditor(false);
    void this.closeZoneTitleEditor(false);
    void this.closeTableCellEditor(false);
    this.tableCellEdit = {
      itemId: item.id,
      expectedVersion: item.version,
      geometry: structuredClone(item.geometry),
      row,
      column,
    };

    const corners: Point[] = [
      [bounds.minX, bounds.minY],
      [bounds.maxX, bounds.minY],
      [bounds.maxX, bounds.maxY],
      [bounds.minX, bounds.maxY],
    ];
    const clientCorners = corners.map((point) =>
      this.renderer.viewport.boardToClient(transformPoint(point, item.transform)),
    );
    const left = Math.min(...clientCorners.map((point) => point[0]));
    const top = Math.min(...clientCorners.map((point) => point[1]));
    const right = Math.max(...clientCorners.map((point) => point[0]));
    const bottom = Math.max(...clientCorners.map((point) => point[1]));
    const width = Math.min(Math.max(160, window.innerWidth - 16), Math.max(160, right - left));
    const height = Math.min(Math.max(88, window.innerHeight - 68), Math.max(72, bottom - top));

    const editor = document.createElement("textarea");
    editor.className = "canvas-table-cell-editor";
    editor.dataset.testid = "table-cell-editor";
    editor.dataset.tableRow = String(row);
    editor.dataset.tableColumn = String(column);
    editor.setAttribute("aria-label", `Edit table cell, row ${row + 1}, column ${column + 1}`);
    editor.maxLength = MAX_TABLE_CELL_TEXT_CODE_POINTS * 2;
    editor.rows = 3;
    editor.value = recovery?.text ?? item.geometry.cells[row]?.[column] ?? "";
    editor.placeholder = "Type in this cell";
    editor.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, left))}px`;
    editor.style.top = `${Math.max(60, Math.min(window.innerHeight - height - 8, top))}px`;
    editor.style.width = `${width}px`;
    editor.style.height = `${height}px`;
    editor.style.fontSize = `${Math.max(14, Math.min(36, item.style.fontSize * this.renderer.viewport.zoom))}px`;
    editor.style.color = item.style.textColor;
    editor.style.fontFamily = textFontStack(item.style.fontFamily ?? "sans");
    editor.style.fontWeight = resolveTextFontWeight(
      item.style.fontWeight,
      item.geometry.headerRow === true && row === 0 ? "700" : "500",
    );
    editor.style.fontStyle = item.style.fontStyle ?? "normal";
    editor.style.textDecoration = item.style.textDecoration ?? "none";
    editor.style.background =
      item.geometry.headerRow === true && row === 0 ? item.style.headerFill : item.style.fill;
    document.body.append(editor);
    this.tableCellEditor = editor;

    editor.addEventListener("input", () => {
      const value = clampTableCellText(editor.value);
      if (value === editor.value) return;
      const cursor = Math.min(value.length, editor.selectionStart);
      editor.value = value;
      editor.setSelectionRange(cursor, cursor);
    });
    this.bindMathField(editor, (save) => void this.closeTableCellEditor(save));
    editor.addEventListener("blur", (event) => {
      // Reaching for the maths keyboard is not leaving the editor; the panel finishes the edit
      // when focus leaves it too.
      if (this.mathFieldPanel?.contains((event as FocusEvent).relatedTarget as Node | null)) return;
      void this.closeTableCellEditor(true);
    });
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void this.closeTableCellEditor(false);
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.closeTableCellEditor(true);
      }
    });
    editor.focus();
    editor.setSelectionRange(
      recovery?.selectionStart ?? editor.value.length,
      recovery?.selectionEnd ?? editor.value.length,
    );
  }

  private async closeTableCellEditor(save: boolean): Promise<void> {
    const editor = this.tableCellEditor;
    const edit = this.tableCellEdit;
    if (!editor) return;
    this.dismissMathField(editor);
    const text = clampTableCellText(editor.value);
    const draft: TableCellDraftRecovery | null = edit
      ? {
          itemId: edit.itemId,
          row: edit.row,
          column: edit.column,
          text,
          selectionStart: editor.selectionStart,
          selectionEnd: editor.selectionEnd,
        }
      : null;
    this.tableCellEditor = null;
    this.tableCellEdit = null;
    editor.remove();
    if (!save || !edit || !draft) {
      this.scheduleRejectedDraftRestore();
      return;
    }
    if (!this.canCommit()) {
      this.recoverTableCellDraft(draft);
      return;
    }
    const geometry = structuredClone(edit.geometry);
    const row = geometry.cells[edit.row];
    if (!row || edit.column < 0 || edit.column >= row.length) return;
    row[edit.column] = text;
    const accepted = await this.commit(
      {
        kind: "item.update",
        itemId: edit.itemId,
        expectedVersion: edit.expectedVersion,
        patch: { geometry },
      },
      createId(),
      { kind: "table-cell", ...draft },
      (commandId) => this.pendingTableCellDrafts.set(commandId, draft),
    );
    if (!accepted) this.recoverTableCellDraft(draft);
    else this.scheduleRejectedDraftRestore();
  }

  private openZoneTitleEditor(
    item: Extract<BoardItem, { kind: "zone" }>,
    recovery?: ZoneTitleDraftRecovery,
  ): void {
    if (!this.canCommit()) {
      this.notify("Drawing is read only.", "warning");
      return;
    }
    if (!this.canModifyItem(item)) {
      this.notify("You can edit only work that you created.", "warning");
      return;
    }
    if (item.version <= 0) {
      this.notify("Wait for the section to finish saving before renaming it.", "info");
      return;
    }
    void this.closeTextEditor(false);
    void this.closeTableCellEditor(false);
    void this.closeZoneTitleEditor(false);
    this.closeImageAltEditor();
    this.zoneTitleEdit = {
      itemId: item.id,
      expectedVersion: item.version,
      geometry: structuredClone(item.geometry),
    };

    const titleHeight = zoneTitleBandHeight(item.style.fontSize);
    const corners: Point[] = [
      [item.geometry.x + ZONE_TITLE_PADDING, item.geometry.y],
      [item.geometry.x + item.geometry.width - ZONE_TITLE_PADDING, item.geometry.y],
      [item.geometry.x + item.geometry.width - ZONE_TITLE_PADDING, item.geometry.y + titleHeight],
      [item.geometry.x + ZONE_TITLE_PADDING, item.geometry.y + titleHeight],
    ];
    const clientCorners = corners.map((point) =>
      this.renderer.viewport.boardToClient(transformPoint(point, item.transform)),
    );
    const left = Math.min(...clientCorners.map((point) => point[0]));
    const top = Math.min(...clientCorners.map((point) => point[1]));
    const right = Math.max(...clientCorners.map((point) => point[0]));
    const width = Math.min(Math.max(180, window.innerWidth - 16), Math.max(180, right - left));
    const height = Math.max(36, Math.min(52, titleHeight * this.renderer.viewport.zoom));

    const editor = document.createElement("input");
    editor.type = "text";
    editor.className = "canvas-zone-title-editor";
    editor.dataset.testid = "zone-title-editor";
    editor.setAttribute("aria-label", "Edit section title");
    editor.maxLength = MAX_ZONE_TITLE_CODE_POINTS * 2;
    editor.value = recovery?.title ?? item.geometry.title;
    editor.placeholder = "Section title";
    editor.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, left))}px`;
    editor.style.top = `${Math.max(60, Math.min(window.innerHeight - height - 8, top))}px`;
    editor.style.width = `${width}px`;
    editor.style.height = `${height}px`;
    editor.style.fontSize = `${Math.max(14, Math.min(32, item.style.fontSize * this.renderer.viewport.zoom))}px`;
    editor.style.color = item.style.textColor;
    editor.style.fontFamily = textFontStack(item.style.fontFamily ?? "sans");
    editor.style.fontWeight = resolveTextFontWeight(item.style.fontWeight, "700");
    editor.style.fontStyle = item.style.fontStyle ?? "normal";
    editor.style.textDecoration = item.style.textDecoration ?? "none";
    document.body.append(editor);
    this.zoneTitleEditor = editor;

    editor.addEventListener("input", () => {
      const value = clampZoneTitle(editor.value.replace(/[\r\n]/gu, " "));
      if (value === editor.value) return;
      const cursor = Math.min(value.length, editor.selectionStart ?? value.length);
      editor.value = value;
      editor.setSelectionRange(cursor, cursor);
    });
    this.bindMathField(editor, (save) => void this.closeZoneTitleEditor(save));
    editor.addEventListener("blur", (event) => {
      // Reaching for the maths keyboard is not leaving the editor; the panel finishes the edit
      // when focus leaves it too.
      if (this.mathFieldPanel?.contains((event as FocusEvent).relatedTarget as Node | null)) return;
      void this.closeZoneTitleEditor(true);
    });
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void this.closeZoneTitleEditor(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        void this.closeZoneTitleEditor(true);
      }
    });
    editor.focus();
    editor.setSelectionRange(
      recovery?.selectionStart ?? 0,
      recovery?.selectionEnd ?? editor.value.length,
    );
  }

  private async closeZoneTitleEditor(save: boolean): Promise<void> {
    const editor = this.zoneTitleEditor;
    const edit = this.zoneTitleEdit;
    if (!editor) return;
    this.dismissMathField(editor);
    const title = clampZoneTitle(editor.value.replace(/[\r\n]/gu, " ")).trim() || "Section";
    const draft: ZoneTitleDraftRecovery | null = edit
      ? {
          itemId: edit.itemId,
          title,
          selectionStart: editor.selectionStart ?? title.length,
          selectionEnd: editor.selectionEnd ?? title.length,
        }
      : null;
    this.zoneTitleEditor = null;
    this.zoneTitleEdit = null;
    editor.remove();
    if (!save || !edit || !draft || title === edit.geometry.title) {
      this.scheduleRejectedDraftRestore();
      return;
    }
    if (!this.canCommit()) {
      this.recoverZoneTitleDraft(draft);
      return;
    }
    const accepted = await this.commit(
      {
        kind: "item.update",
        itemId: edit.itemId,
        expectedVersion: edit.expectedVersion,
        patch: { geometry: { ...edit.geometry, title } },
      },
      createId(),
      { kind: "zone-title", ...draft },
      (commandId) => this.pendingZoneTitleDrafts.set(commandId, draft),
    );
    if (!accepted) this.recoverZoneTitleDraft(draft);
    else this.scheduleRejectedDraftRestore();
  }

  private async restoreOutbox(): Promise<void> {
    try {
      const contents = await this.outbox.contents(this.bootstrap.board.id, this.bootstrap.actor.id);
      this.expiredRecovery = contents.expired;
      for (const entry of contents.active) {
        try {
          const frame = validateClientFrame(entry.command);
          if (frame.t !== "client.commit") throw new Error("Outbox entry is not a commit.");
          this.model.restoreQueued(frame as CommitFrame, this.bootstrap.actor.id);
          this.hydrateOutboxRecovery(frame.commandId, entry.recovery);
        } catch {
          this.expiredRecovery.push(entry);
        }
      }
      this.syncRecoveryBanner();
    } catch {
      this.outboxAvailable = false;
      this.notify(
        "This browser could not open its recovery queue. Editing is disabled for safety.",
        "error",
      );
      this.phase = "stopped";
    }
  }

  private hydrateOutboxRecovery(
    commandId: string,
    recovery: OutboxRecoveryMetadata | undefined,
  ): void {
    if (recovery?.kind === "table-cell") {
      this.pendingTableCellDrafts.set(commandId, structuredClone(recovery));
    } else if (recovery?.kind === "zone-title") {
      this.pendingZoneTitleDrafts.set(commandId, structuredClone(recovery));
    }
  }

  private handleRebaseState(error: Error | null): void {
    const wasRecovering = this.optimisticRecovery;
    this.optimisticRecovery = error !== null;
    this.syncRecoveryBanner();
    this.updatePermissions();
    if (error && !wasRecovering) {
      this.notify(
        "Unsaved edits no longer apply cleanly to the shared board. They remain in this browser’s recovery queue.",
        "error",
      );
      this.socket.resynchronize("Refreshing the board before recovering unsaved edits.");
    }
  }

  private syncRecoveryBanner(): void {
    const title = query(this.recoveryBanner, "[data-recovery-title]", HTMLElement);
    const message = query(this.recoveryBanner, "[data-recovery-message]", HTMLElement);
    const discard = query(this.recoveryBanner, "[data-recovery-discard]", HTMLButtonElement);
    const dismiss = query(this.recoveryBanner, "[data-recovery-dismiss]", HTMLButtonElement);
    if (this.optimisticRecovery) {
      title.textContent = "Unsaved edits need recovery";
      message.textContent =
        "They are still stored locally. Download a copy, or explicitly discard all unsaved edits.";
      discard.hidden = false;
      dismiss.hidden = true;
    } else {
      title.textContent = "Unsaved recovery data";
      message.textContent = "Some commands are too old to resend safely.";
      discard.hidden = true;
      dismiss.hidden = false;
    }
    this.recoveryBanner.hidden = !this.optimisticRecovery && this.expiredRecovery.length === 0;
  }

  private async discardFailedOptimisticEdits(): Promise<void> {
    if (!this.optimisticRecovery) return;
    const commands = this.model.pendingCommands;
    if (commands.length === 0) return;
    if (
      !confirm(
        `Discard all ${commands.length} unsaved edit${commands.length === 1 ? "" : "s"}? Download recovery JSON first if you may need them.`,
      )
    ) {
      return;
    }
    try {
      await this.outbox.removeMany(
        this.bootstrap.board.id,
        this.bootstrap.actor.id,
        commands.map((command) => command.commandId),
      );
      this.model.discardOptimistic();
      for (const command of commands) this.finishWebMcpCommit(command.commandId, false);
      this.notify("Unsaved edits were discarded. The shared board is unchanged.", "info");
    } catch {
      this.notify(
        "The recovery queue could not be cleared, so no unsaved edits were discarded.",
        "error",
      );
    }
  }

  private assignCreatedItemsToSections(operation: DurableOperation): DurableOperation {
    if (!this.bootstrap.board.features.grouping) return operation;
    return decorateCreatedItemsWithSections(operation, this.model.items.values());
  }

  private reconcileRenderedTextSectionMembership(itemId: string, expectedVersion: number): void {
    if (
      !this.bootstrap.board.features.grouping ||
      !this.canCommit() ||
      this.pendingRenderedTextSectionUpdates.has(itemId)
    ) {
      return;
    }
    const operation = this.model.renderedTextSectionMembershipOperation(itemId, expectedVersion);
    if (operation === null) return;
    if (
      !operationAllowedForActor(
        operation,
        this.bootstrap.actor.role,
        this.bootstrap.actor.id,
        this.model.authoritativeItems,
      )
    ) {
      return;
    }
    this.pendingRenderedTextSectionUpdates.add(itemId);
    void this.commit(operation).finally(() => {
      this.pendingRenderedTextSectionUpdates.delete(itemId);
    });
  }

  private async commit(
    operation: DurableOperation,
    actionId = createId(),
    recovery?: OutboxRecoveryMetadata,
    onQueued?: (commandId: string) => void,
  ): Promise<boolean> {
    if (!this.canCommit()) {
      this.notify(
        this.phase === "ready"
          ? "Drawing is read only."
          : "Wait for the board to reconnect before editing.",
        "warning",
      );
      return false;
    }
    const commandId = createId();
    let normalizedOperation: DurableOperation;
    try {
      normalizedOperation = validateDurableOperation(
        this.assignCreatedItemsToSections(operation),
      ) as DurableOperation;
    } catch {
      this.notify("That gesture could not be converted into a valid board edit.", "error");
      return false;
    }
    const denial = operationDenialForActor(
      normalizedOperation,
      this.bootstrap.actor.role,
      this.bootstrap.actor.id,
      this.model.authoritativeItems,
    );
    if (denial !== null) {
      this.notify(
        denial === "section-locked"
          ? "This Section is locked. An owner must unlock it before its contents can change."
          : "You can edit only work that you created. Make a copy to adapt it.",
        "warning",
      );
      return false;
    }
    const command: CommitFrame = {
      v: PROTOCOL_VERSION,
      t: "client.commit",
      commandId,
      actionId,
      baseSeq: this.model.lastAppliedSeq,
      op: normalizedOperation,
    };
    try {
      await this.outbox.put(this.bootstrap.board.id, this.bootstrap.actor.id, command, recovery);
    } catch (error) {
      if (error instanceof OutboxLimitError) {
        this.recoveryBanner.hidden = false;
        this.notify(`${error.message} Download a recovery copy before continuing.`, "error");
      } else {
        this.notify("The edit could not be added to the durable recovery queue.", "error");
      }
      return false;
    }
    onQueued?.(commandId);
    this.model.queue(command, this.bootstrap.actor.id);
    this.updateStatus();
    this.socket.sendCommit(command);
    return true;
  }

  private commitAndWait(operation: DurableOperation): Promise<boolean> {
    return new Promise((resolve) => {
      let queued = false;
      void this.commit(operation, createId(), undefined, (commandId) => {
        queued = true;
        this.pendingWebMcpCommits.track(commandId, resolve, (id) => this.withdrawCommand(id));
      }).then((accepted) => {
        if (!accepted && !queued) resolve(false);
      });
    });
  }

  private finishWebMcpCommit(commandId: string, accepted: boolean): void {
    this.pendingWebMcpCommits.finish(commandId, accepted);
  }

  /**
   * Drops a command that is still queued locally so it cannot be flushed
   * later. Returns false when the model no longer holds it, which means the
   * server already answered it.
   */
  private withdrawCommand(commandId: string): boolean {
    if (!this.model.reject(commandId)) return false;
    void this.outbox.remove(this.bootstrap.board.id, this.bootstrap.actor.id, commandId);
    this.updateStatus();
    return true;
  }

  private handleAction(action: ServerAction, replay: boolean): void {
    this.clearPreviewForGesture(action.actionId);
    if (action.seq <= this.model.lastAppliedSeq) {
      const pending = this.model.pendingCommands.some(
        (command) => command.commandId === action.commandId,
      );
      if (pending) {
        this.pendingStickyDrafts.delete(action.commandId);
        this.pendingTableCellDrafts.delete(action.commandId);
        this.pendingZoneTitleDrafts.delete(action.commandId);
        this.model.reject(action.commandId);
        this.finishWebMcpCommit(action.commandId, false);
        void this.outbox.remove(this.bootstrap.board.id, this.bootstrap.actor.id, action.commandId);
        this.updateStatus();
        return;
      }
      if (this.model.hasSeenAction(action.seq, action.commandId)) return;
      this.socket.resynchronize("A duplicate authoritative sequence did not match local history.");
      return;
    }
    try {
      this.rememberCreators([action.actor, ...(action.creators ?? [])]);
      const result = this.model.applyAction(action);
      try {
        this.webMcp?.recordAuthoritativeAction(action, result.changedIds);
      } catch {
        this.notify("The problem-step watch could not process this saved change.", "warning");
      }
      this.bootstrap.board.latestSeq = action.seq;
      if (result.acknowledged) {
        this.finishWebMcpCommit(action.commandId, true);
        this.pendingStickyDrafts.delete(action.commandId);
        this.pendingTableCellDrafts.delete(action.commandId);
        this.pendingZoneTitleDrafts.delete(action.commandId);
        void this.outbox.remove(this.bootstrap.board.id, this.bootstrap.actor.id, action.commandId);
      }
      if (!replay && action.actor.id !== this.bootstrap.actor.id) {
        this.liveRegion.textContent = `${action.actor.displayName} updated the board.`;
      }
      query(this.root, "[data-canvas-hint]", HTMLElement).hidden = this.model.items.size > 0;
      this.updateStatus();
    } catch (error) {
      if (error instanceof SequenceError) {
        this.socket.resynchronize(error.message);
      } else {
        this.socket.resynchronize("The board could not apply an authoritative action.");
      }
    }
  }

  private handleRejection(frame: ServerFrame): void {
    const commandId = typeof frame.commandId === "string" ? frame.commandId : null;
    const code = typeof frame.code === "string" ? frame.code : "REJECTED";
    let stickyDraft: StickyDraftRecovery | undefined;
    let tableCellDraft: TableCellDraftRecovery | undefined;
    let zoneTitleDraft: ZoneTitleDraftRecovery | undefined;
    if (commandId) {
      const pendingCommand = this.model.pendingCommands.find(
        (command) => command.commandId === commandId,
      );
      stickyDraft =
        this.pendingStickyDrafts.get(commandId) ??
        (pendingCommand ? stickyDraftFromOperation(pendingCommand.op) : undefined);
      tableCellDraft = this.pendingTableCellDrafts.get(commandId);
      zoneTitleDraft = this.pendingZoneTitleDrafts.get(commandId);
      this.pendingStickyDrafts.delete(commandId);
      this.pendingTableCellDrafts.delete(commandId);
      this.pendingZoneTitleDrafts.delete(commandId);
      this.model.reject(commandId);
      this.finishWebMcpCommit(commandId, false);
      void this.outbox.remove(this.bootstrap.board.id, this.bootstrap.actor.id, commandId);
    }
    if (stickyDraft) this.recoverStickyDraft(stickyDraft);
    if (tableCellDraft) this.recoverTableCellDraft(tableCellDraft);
    if (zoneTitleDraft) this.recoverZoneTitleDraft(zoneTitleDraft);
    if (code === "STALE_HISTORY" && typeof frame.historyVersion === "number") {
      this.history = {
        historyVersion: frame.historyVersion,
        canUndo: frame.canUndo === true,
        canRedo: frame.canRedo === true,
      };
      this.updateHistoryControls();
    }
    if (code === "REPLAY_UNAVAILABLE" || code === "STALE_BOARD") {
      this.socket.resynchronize(
        typeof frame.message === "string" ? frame.message : "The board changed; reloading it.",
      );
      return;
    }
    const friendly: Record<string, string> = {
      STALE_ITEM: "That item changed before your edit was saved.",
      UNDO_CONFLICT: "Undo stopped because a collaborator changed that item.",
      UNDO_EMPTY: "There is nothing left to undo.",
      REDO_EMPTY: "There is nothing to redo.",
      RATE_LIMITED: "You’re drawing a little too quickly. Try again in a moment.",
      TEMPORARILY_UNAVAILABLE: "The room is busy, so that edit was not saved.",
      FORBIDDEN: "Your drawing permission changed before that edit was saved.",
    };
    const message =
      friendly[code] ??
      (typeof frame.message === "string" ? frame.message : "The edit was not saved.");
    const retainedDraft = stickyDraft
      ? "sticky draft"
      : tableCellDraft
        ? "table cell draft"
        : zoneTitleDraft
          ? "section title draft"
          : null;
    this.notify(
      retainedDraft
        ? `${message} Your ${retainedDraft} was retained${this.canCommit() ? " and reopened" : " until editing is available"}.`
        : message,
      code === "UNDO_EMPTY" || code === "REDO_EMPTY" ? "info" : "warning",
    );
    this.updateStatus();
  }

  private handleAccessChanged(frame: ServerFrame): void {
    const access = isRecord(frame.access) ? frame.access : frame;
    const organisationTemplatesWereEnabled = this.bootstrap.board.features.organisationTemplates;
    let features: BoardFeatures;
    try {
      features = normalizeBoardFeatures(access.features);
    } catch {
      this.socket.resynchronize("Space feature settings changed; refreshing policy.");
      return;
    }
    if (typeof access.imagesEnabled !== "boolean" || access.imagesEnabled !== features.images) {
      this.socket.resynchronize("Space image permissions changed; refreshing policy.");
      return;
    }
    const affectedActor = actorFromAccessChanged(frame);
    if (affectedActor) this.rememberCreators([affectedActor]);
    if (access.role === "viewer" || access.role === "editor" || access.role === "owner")
      this.bootstrap.actor.role = access.role;
    if (
      access.drawingPolicy === "locked" ||
      access.drawingPolicy === "owner_only" ||
      access.drawingPolicy === "editors_enabled"
    ) {
      this.bootstrap.board.drawingPolicy = access.drawingPolicy;
    }
    this.bootstrap.board.imagesEnabled = access.imagesEnabled;
    this.bootstrap.board.features = features;
    if (access.accessMode === "private" || access.accessMode === "link_view")
      this.bootstrap.board.accessMode = access.accessMode;
    if (typeof access.aclVersion === "number") this.bootstrap.board.aclVersion = access.aclVersion;
    const organisationTemplatesCanManage = organisationTemplateManagementForRole(
      this.organisationId,
      this.bootstrap.actor.role,
    );
    if (organisationTemplatesCanManage !== null) {
      this.organisationTemplatesCanManage = organisationTemplatesCanManage;
    }
    this.renderOrganisationTemplates();
    if (!organisationTemplatesWereEnabled && features.organisationTemplates) {
      void this.loadOrganisationTemplates();
    }
    if (!canRoleDraw(this.bootstrap.actor.role, this.bootstrap.board.drawingPolicy))
      this.tools.setTool("select");
    if (!this.isToolEnabled(this.tools.tool)) this.tools.setTool("select");
    this.updatePermissions();
    this.renderParticipants();
    if (this.bootstrap.actor.role === "owner" && !this.participantDrawer.hidden) {
      void this.loadParticipantRoles();
    }
    if (!this.settingsDrawer.hidden) this.renderSettingsPanel();
  }

  private handleOwnerRecovery(token: string, aclVersion: number): void {
    this.bootstrap.actor.role = "owner";
    this.bootstrap.board.aclVersion = aclVersion;
    this.updatePermissions();
    this.showTransferredOwnerRecovery(token);
  }

  private handlePreview(preview: RemotePreview | null, cancelKey?: string): void {
    if (cancelKey?.startsWith("actor:")) {
      const actorId = cancelKey.slice("actor:".length);
      for (const [key, value] of this.remotePreviews) {
        if (value.actorId === actorId) this.remotePreviews.delete(key);
      }
    } else if (cancelKey) {
      this.remotePreviews.delete(cancelKey);
    }
    if (preview) {
      if (preview.kind === "pencil.start" && Array.isArray(preview.payload.point)) {
        preview.payload = { ...preview.payload, points: [preview.payload.point] };
      }
      const existing = this.remotePreviews.get(preview.key);
      if (existing && preview.kind === "pencil.segment") {
        const previousPoints = Array.isArray(existing.payload.points)
          ? existing.payload.points
          : [];
        const nextPoints = Array.isArray(preview.payload.points) ? preview.payload.points : [];
        preview.payload = {
          ...existing.payload,
          ...preview.payload,
          points: [...previousPoints, ...nextPoints.slice(1)],
        };
      }
      this.remotePreviews.set(preview.key, preview);
    }
    this.renderer.renderRemotePreviews(this.remotePreviews.values());
  }

  private handlePresence(values: Presence[], replace: boolean): void {
    this.rememberCreators(values);
    if (replace) {
      this.presences.clear();
    }
    for (const presence of values) {
      const key = presence.connectionId ?? presence.id;
      if (presence.cursor === null && values.length === 1 && !replace) this.presences.delete(key);
      else this.presences.set(key, presence);
    }
    if (![...this.presences.values()].some((presence) => presence.id === this.bootstrap.actor.id)) {
      this.presences.set(this.bootstrap.actor.id, {
        ...this.bootstrap.actor,
        role: this.bootstrap.actor.role,
        updatedAt: Date.now(),
      });
    }
    this.renderParticipants();
    this.renderer.renderPresence(this.presences.values(), this.bootstrap.actor.id);
  }

  private startBroadcastingSpotlight(): void {
    if (!this.canBroadcastSpotlight()) return;
    if (this.followedSpotlight) this.stopFollowingSpotlight();
    const spotlightId = crypto.randomUUID();
    this.broadcastSpotlightId = spotlightId;
    this.localSpotlightIds.add(spotlightId);
    if (this.localSpotlightIds.size > 32) {
      const oldest = this.localSpotlightIds.values().next().value;
      if (oldest) this.localSpotlightIds.delete(oldest);
    }
    this.sendCurrentSpotlight();
    this.spotlightHeartbeatTimer = window.setInterval(
      () => this.sendCurrentSpotlight(),
      SPOTLIGHT_HEARTBEAT_MS,
    );
    this.renderSpotlightState();
    this.liveRegion.textContent = "Follow me started. Participants can now follow your view.";
  }

  private stopBroadcastingSpotlight(sendStop = true): void {
    const spotlightId = this.broadcastSpotlightId;
    if (this.spotlightHeartbeatTimer !== null) {
      window.clearInterval(this.spotlightHeartbeatTimer);
      this.spotlightHeartbeatTimer = null;
    }
    if (this.spotlightUpdateTimer !== null) {
      window.clearTimeout(this.spotlightUpdateTimer);
      this.spotlightUpdateTimer = null;
    }
    this.broadcastSpotlightId = null;
    if (spotlightId && sendStop) this.socket.sendSpotlight(spotlightId, false);
    this.renderSpotlightState();
  }

  private scheduleSpotlightViewportUpdate(): void {
    if (!this.broadcastSpotlightId || this.phase !== "ready") return;
    const elapsed = performance.now() - this.spotlightLastSentAt;
    if (elapsed >= SPOTLIGHT_UPDATE_THROTTLE_MS) {
      this.sendCurrentSpotlight();
      return;
    }
    if (this.spotlightUpdateTimer !== null) return;
    this.spotlightUpdateTimer = window.setTimeout(() => {
      this.spotlightUpdateTimer = null;
      this.sendCurrentSpotlight();
    }, SPOTLIGHT_UPDATE_THROTTLE_MS - elapsed);
  }

  private sendCurrentSpotlight(): void {
    const spotlightId = this.broadcastSpotlightId;
    if (!spotlightId || this.phase !== "ready") return;
    if (this.socket.sendSpotlight(spotlightId, true, this.renderer.viewport.viewState)) {
      this.spotlightLastSentAt = performance.now();
    }
  }

  private handleSpotlight(frame: SpotlightFrame): void {
    if (!this.bootstrap.board.features.spotlight) {
      this.clearFollowingSpotlight();
      return;
    }
    if (!frame.active) {
      this.localSpotlightIds.delete(frame.spotlightId);
      if (
        this.followedSpotlight?.spotlightId === frame.spotlightId &&
        this.followedSpotlight.actorId === frame.actor.id &&
        this.followedSpotlight.connectionId === frame.connectionId
      ) {
        this.clearFollowingSpotlight();
      }
      return;
    }
    if (this.localSpotlightIds.has(frame.spotlightId)) return;
    if (this.broadcastSpotlightId) return;
    if (this.followedSpotlight) {
      if (
        this.followedSpotlight.spotlightId !== frame.spotlightId ||
        this.followedSpotlight.actorId !== frame.actor.id ||
        this.followedSpotlight.connectionId !== frame.connectionId
      ) {
        return;
      }
      this.followedSpotlight.updatedAt = Date.now();
      this.renderer.viewport.setViewState(frame.viewport);
      this.renderSpotlightState();
      return;
    }
    if (this.ignoredSpotlightIds.has(frame.spotlightId)) return;

    this.followedSpotlight = {
      spotlightId: frame.spotlightId,
      actorId: frame.actor.id,
      connectionId: frame.connectionId,
      displayName: frame.actor.displayName,
      updatedAt: Date.now(),
    };
    this.renderer.viewport.setViewState(frame.viewport);
    this.renderSpotlightState();
  }

  private stopFollowingSpotlight(): void {
    const followed = this.followedSpotlight;
    if (!followed) return;
    this.ignoredSpotlightIds.add(followed.spotlightId);
    if (this.ignoredSpotlightIds.size > 64) {
      const oldest = this.ignoredSpotlightIds.values().next().value;
      if (oldest) this.ignoredSpotlightIds.delete(oldest);
    }
    this.clearFollowingSpotlight();
  }

  private clearFollowingSpotlight(): void {
    this.followedSpotlight = null;
    this.renderSpotlightState();
  }

  private canBroadcastSpotlight(): boolean {
    return (
      this.phase === "ready" &&
      this.bootstrap.board.features.spotlight &&
      (this.bootstrap.actor.role === "owner" || this.bootstrap.actor.role === "editor")
    );
  }

  private renderSpotlightState(): void {
    const broadcasting = this.broadcastSpotlightId !== null;
    const buttonLabel = query(this.spotlightToggle, ".spotlight-toggle-label", HTMLElement);
    this.spotlightToggle.setAttribute("aria-pressed", String(broadcasting));
    this.spotlightToggle.setAttribute(
      "aria-label",
      broadcasting ? "Stop Follow me" : "Start Follow me",
    );
    this.spotlightToggle.title = broadcasting
      ? "Stop sharing your canvas view"
      : "Let participants follow your canvas view";
    buttonLabel.textContent = broadcasting ? "Following" : "Follow me";

    const followed = this.followedSpotlight;
    const followText = followed ? `Following ${followed.displayName} — press Esc to stop` : "";
    this.spotlightFollowBanner.hidden = !followed;
    if (this.spotlightFollowText.textContent !== followText) {
      this.spotlightFollowText.textContent = followText;
    }
  }

  private async resync(reason: string): Promise<void> {
    this.notify(reason, "info");
    const next = await this.api.bootstrap(this.bootstrap.board.id);
    const contents = await this.outbox.contents(next.board.id, next.actor.id);
    const activeEntries: Array<{
      command: CommitFrame;
      recovery?: OutboxRecoveryMetadata;
    }> = [];
    for (const entry of contents.active) {
      try {
        const frame = validateClientFrame(entry.command);
        if (frame.t !== "client.commit") throw new Error("Outbox entry is not a commit.");
        activeEntries.push({ command: frame as CommitFrame, recovery: entry.recovery });
      } catch {
        contents.expired.push(entry);
      }
    }
    this.bootstrap = next;
    this.creatorNames.clear();
    for (const [actorId, displayName] of buildCreatorNameMap(next.creators, next.actor)) {
      this.creatorNames.set(actorId, displayName);
    }
    this.model.load(next.snapshot as BoardSnapshot, true);
    try {
      // A replacement cannot be expressed as individual changes, so active watches
      // re-snapshot and report a resync instead of retaining stale text and sequences.
      this.webMcp?.recordAuthoritativeReload(this.model.lastAppliedSeq);
    } catch {
      this.notify("The problem-step watch could not follow the refreshed board.", "warning");
    }
    for (const entry of activeEntries) {
      this.model.restoreQueued(entry.command, next.actor.id);
      this.hydrateOutboxRecovery(entry.command.commandId, entry.recovery);
    }
    this.expiredRecovery = contents.expired;
    this.syncRecoveryBanner();
    this.history = {
      historyVersion: next.actor.historyVersion,
      canUndo: next.actor.canUndo ?? false,
      canRedo: next.actor.canRedo ?? false,
    };
    this.titleInput.value = next.board.title;
    this.updateAll();
  }

  private rememberCreators(creators: Iterable<Actor>): void {
    const changed = new Set<string>();
    for (const creator of creators) {
      const displayName = creator.displayName.trim();
      if (!displayName || this.creatorNames.get(creator.id) === displayName) continue;
      this.creatorNames.set(creator.id, displayName);
      changed.add(creator.id);
    }
    this.renderer.refreshCreatorAttribution(changed);
  }

  private flushOutbox(): void {
    if (this.optimisticRecovery) {
      this.updateStatus();
      return;
    }
    for (const command of this.model.pendingCommands) this.socket.sendCommit(command);
    this.updateStatus();
  }

  private async undo(): Promise<void> {
    if (!this.history.canUndo || !this.canCommit()) return;
    await this.commit({
      kind: "history.undo",
      expectedHistoryVersion: this.history.historyVersion,
    });
  }

  private async redo(): Promise<void> {
    if (!this.history.canRedo || !this.canCommit()) return;
    await this.commit({
      kind: "history.redo",
      expectedHistoryVersion: this.history.historyVersion,
    });
  }

  private readonly onGlobalKeyDown = (event: KeyboardEvent): void => {
    const shortcut = globalShortcutFor(event, {
      editing: isEditingTarget(event.target),
      toolsMenuOpen: !this.toolsMenu.hidden,
      shapeMenuOpen: !this.shapeMenu.hidden,
      followingSpotlight: this.followedSpotlight !== null,
    });
    if (shortcut === null) return;
    event.preventDefault();
    switch (shortcut) {
      case "close-tools-menu":
        this.setToolsMenuOpen(false);
        this.moreToolsButton.focus();
        break;
      case "close-shape-menu":
        this.setShapeMenuOpen(false);
        query(this.root, "[data-testid='tool-rectangle']", HTMLButtonElement).focus();
        break;
      case "stop-following-spotlight":
        this.stopFollowingSpotlight();
        break;
      case "undo":
        void this.undo();
        break;
      case "redo":
        void this.redo();
        break;
    }
  };

  private openTextEditor(point: Point, item?: BoardItem, recovery?: StickyDraftRecovery): void {
    if (!this.canCommit()) return;
    if (item && !this.canModifyItem(item)) {
      this.notify("You can edit only work that you created.", "warning");
      return;
    }
    void this.closeTableCellEditor(false);
    void this.closeZoneTitleEditor(false);
    void this.closeTextEditor(false);
    const style = this.style;
    const textItem = item?.kind === "text" ? item : undefined;
    const stickyItem = item?.kind === "sticky" ? item : undefined;
    const mode =
      recovery || stickyItem || (!item && this.tools.tool === "sticky") ? "sticky" : "text";
    const editedItem = stickyItem ?? textItem;
    this.textEditorMode = mode;
    this.textEditContext = editedItem
      ? {
          itemId: editedItem.id,
          expectedVersion: editedItem.version,
          geometry: structuredClone(editedItem.geometry),
          item: structuredClone(editedItem),
        }
      : null;
    const textPoint: Point = editedItem ? [editedItem.geometry.x, editedItem.geometry.y] : point;
    const transform = editedItem?.transform ?? [1, 0, 0, 1, 0, 0];
    const transformedPoint: Point = [
      transform[0] * textPoint[0] + transform[2] * textPoint[1] + transform[4],
      transform[1] * textPoint[0] + transform[3] * textPoint[1] + transform[5],
    ];
    const client = this.renderer.viewport.boardToClient(transformedPoint);
    const stickyGeometry = stickyItem?.geometry ?? {
      x: textPoint[0],
      y: textPoint[1],
      width: DEFAULT_STICKY_WIDTH,
      height: DEFAULT_STICKY_HEIGHT,
      text: "",
    };
    const stickyStyle = stickyItem?.style ?? {
      kind: "sticky" as const,
      fill: style.stickyFill,
      textColor: style.stickyTextColor,
      fontSize: style.stickyFontSize,
      opacity: style.stickyOpacity,
    };
    const editor = document.createElement("textarea");
    editor.className =
      mode === "sticky" ? "canvas-text-editor canvas-sticky-editor" : "canvas-text-editor";
    editor.dataset.testid = "canvas-text-editor";
    editor.dataset.editorKind = mode;
    editor.setAttribute(
      "aria-label",
      mode === "sticky"
        ? stickyItem
          ? "Edit sticky note"
          : "Add sticky note"
        : textItem
          ? "Edit text"
          : "Add text",
    );
    editor.maxLength = mode === "sticky" ? MAX_STICKY_TEXT_CODE_POINTS * 2 : 5_000;
    editor.rows = mode === "sticky" ? 6 : 1;
    editor.value = recovery?.text ?? editedItem?.geometry.text ?? "";
    editor.dataset.boardX = String(textPoint[0]);
    editor.dataset.boardY = String(textPoint[1]);
    if (!editedItem) editor.dataset.draftItemId = recovery?.draftItemId ?? createId();
    editor.placeholder = mode === "sticky" ? "Add an idea…" : "Add text";
    if (mode === "text") {
      editor.title = "Enter to add · Ctrl/⌘ Enter for a new line";
      editor.setAttribute("aria-keyshortcuts", "Enter Control+Enter Meta+Enter");
    }
    const zoom = this.renderer.viewport.zoom;
    if (mode === "sticky") {
      const editorWidth = Math.min(
        Math.max(80, window.innerWidth - 16),
        Math.max(160, stickyGeometry.width * zoom),
      );
      const editorHeight = Math.min(
        Math.max(96, window.innerHeight - 72),
        Math.max(120, stickyGeometry.height * zoom),
      );
      editor.style.width = `${editorWidth}px`;
      editor.style.height = `${editorHeight}px`;
      editor.style.left = `${Math.max(8, Math.min(window.innerWidth - editorWidth - 8, client[0]))}px`;
      editor.style.top = `${Math.max(60, Math.min(window.innerHeight - editorHeight - 8, client[1]))}px`;
      editor.style.padding = `${Math.max(10, Math.min(18, STICKY_PADDING * zoom))}px`;
      editor.style.fontSize = `${Math.max(14, Math.min(48, stickyStyle.fontSize * zoom))}px`;
      editor.style.color = stickyStyle.textColor;
      editor.style.fontFamily = textFontStack(stickyStyle.fontFamily ?? "sans");
      editor.style.fontWeight = resolveTextFontWeight(stickyStyle.fontWeight);
      editor.style.fontStyle = stickyStyle.fontStyle ?? "normal";
      editor.style.textDecoration = stickyStyle.textDecoration ?? "none";
      editor.style.background = stickyStyle.fill;
      editor.style.opacity = String(stickyStyle.opacity);
    } else {
      editor.style.left = `${Math.min(window.innerWidth - 170, Math.max(8, client[0]))}px`;
      editor.style.top = `${Math.min(window.innerHeight - 100, Math.max(60, client[1] - (textItem?.style.fontSize ?? style.fontSize)))}px`;
      editor.style.fontSize = `${Math.max(14, Math.min(48, (textItem?.style.fontSize ?? style.fontSize) * zoom))}px`;
      editor.style.color = textItem?.style.color ?? style.color;
      editor.style.fontFamily = textFontStack(textItem?.style.fontFamily ?? style.fontFamily);
      editor.style.fontWeight = resolveTextFontWeight(textItem?.style.fontWeight);
      editor.style.fontStyle = textItem?.style.fontStyle ?? "normal";
      editor.style.textDecoration = textItem?.style.textDecoration ?? "none";
    }
    document.body.append(editor);
    this.textEditor = editor;

    const preview = (): void => {
      if (mode === "sticky") {
        this.renderer.showLocalSticky(
          { ...stickyGeometry, text: clampStickyText(editor.value) },
          stickyStyle,
          stickyItem?.transform,
        );
        return;
      }
      this.renderer.showLocalText(
        textPoint,
        editor.value,
        textItem?.style ?? {
          color: style.color,
          fontSize: style.fontSize,
          fontFamily: style.fontFamily,
          opacity: style.opacity,
        },
        textItem?.transform,
      );
    };
    this.textEditorPreview = preview;
    const schedule = (): void => {
      if (mode === "sticky") {
        const value = clampStickyText(editor.value);
        if (value !== editor.value) {
          const cursor = Math.min(value.length, editor.selectionStart);
          editor.value = value;
          editor.setSelectionRange(cursor, cursor);
        }
        preview();
        return;
      }
      preview();
    };
    editor.addEventListener("input", schedule);
    this.bindMathField(editor, (save) => void this.closeTextEditor(save), schedule);
    editor.addEventListener("blur", (event) => {
      // Reaching for the maths keyboard is not leaving the editor; the panel finishes the edit
      // when focus leaves it too.
      if (this.mathFieldPanel?.contains((event as FocusEvent).relatedTarget as Node | null)) return;
      void this.closeTextEditor(true);
    });
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void this.closeTextEditor(false);
      } else if (event.key === "Enter" && !event.isComposing) {
        if (mode === "text") {
          event.preventDefault();
          if (event.ctrlKey || event.metaKey) {
            editor.setRangeText("\n", editor.selectionStart, editor.selectionEnd, "end");
            schedule();
          } else {
            void this.closeTextEditor(true);
          }
        } else if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          void this.closeTextEditor(true);
        }
      }
    });
    preview();
    editor.focus();
    editor.setSelectionRange(
      recovery?.selectionStart ?? editor.value.length,
      recovery?.selectionEnd ?? editor.value.length,
    );
  }

  private async closeTextEditor(save: boolean): Promise<void> {
    const editor = this.textEditor;
    if (!editor) return;
    this.dismissMathField(editor);
    if (!save) {
      this.discardTextEditor(editor);
      return;
    }
    if (this.textEditorClosing) return;

    const context = this.textEditContext;
    const mode = this.textEditorMode;
    if (mode === null) {
      this.discardTextEditor(editor);
      return;
    }
    const value = mode === "sticky" ? clampStickyText(editor.value) : editor.value;
    if (mode === "text" && !value) {
      this.discardTextEditor(editor);
      return;
    }

    const point: Point = [Number(editor.dataset.boardX), Number(editor.dataset.boardY)];
    const draftItemId = editor.dataset.draftItemId ?? createId();
    const operation: DurableOperation = context
      ? buildCapturedTextUpdate(
          context,
          value,
          this.model.authoritativeItems.values(),
          this.bootstrap.board.features.grouping,
        )
      : mode === "sticky"
        ? buildStickyCreateOperation(draftItemId, point, this.style, value)
        : {
            kind: "item.create",
            item: {
              id: draftItemId,
              kind: "text",
              style: {
                kind: "text",
                color: this.style.color,
                fontSize: this.style.fontSize,
                fontFamily: this.style.fontFamily,
                opacity: this.style.opacity,
              },
              transform: [1, 0, 0, 1, 0, 0],
              geometry: { x: point[0], y: point[1], text: value },
            },
          };
    const attempt = ++this.textEditorCloseAttempt;
    const selectionStart = editor.selectionStart;
    const selectionEnd = editor.selectionEnd;
    const stickyDraft: StickyDraftRecovery | undefined =
      mode === "sticky"
        ? {
            ...(context ? { itemId: context.itemId } : {}),
            draftItemId: createId(),
            point,
            text: value,
            selectionStart,
            selectionEnd,
          }
        : undefined;
    this.textEditorClosing = true;
    editor.readOnly = true;
    editor.setAttribute("aria-busy", "true");

    let accepted = false;
    try {
      accepted = await this.commit(
        operation,
        createId(),
        undefined,
        stickyDraft
          ? (commandId) => this.pendingStickyDrafts.set(commandId, stickyDraft)
          : undefined,
      );
    } catch {
      this.notify("The edit could not be saved. Your draft is still open.", "error");
    }

    if (this.textEditor !== editor || attempt !== this.textEditorCloseAttempt) return;
    this.textEditorClosing = false;
    if (accepted) {
      if ((mode === "sticky" || mode === "text") && context === null) {
        this.tools.setTool("select");
        this.tools.selectOnly([draftItemId]);
      }
      this.discardTextEditor(editor);
      return;
    }

    editor.readOnly = false;
    editor.removeAttribute("aria-busy");
    this.textEditorPreview?.();
    window.requestAnimationFrame(() => {
      if (this.textEditor !== editor || this.textEditorClosing || !editor.isConnected) return;
      editor.focus();
      editor.setSelectionRange(selectionStart, selectionEnd);
    });
  }

  private discardTextEditor(editor: HTMLTextAreaElement): void {
    if (this.textEditor !== editor) return;
    this.textEditorCloseAttempt += 1;
    this.textEditorClosing = false;
    this.textEditor = null;
    this.textEditContext = null;
    this.textEditorMode = null;
    this.textEditorPreview = null;
    editor.remove();
    this.renderer.clearLocalPreview();
    this.scheduleRejectedDraftRestore();
  }

  private recoverStickyDraft(draft: StickyDraftRecovery): void {
    this.rejectedStickyDrafts.push(draft);
    this.scheduleRejectedDraftRestore();
  }

  private restoreNextStickyDraft(): void {
    if (this.textEditor || this.tableCellEditor || !this.canCommit()) return;
    const draft = this.rejectedStickyDrafts.shift();
    if (!draft) return;
    const latest = draft.itemId ? this.model.getItem(draft.itemId) : undefined;
    const sticky = latest?.kind === "sticky" ? latest : undefined;
    const point: Point = sticky ? [sticky.geometry.x, sticky.geometry.y] : draft.point;
    this.openTextEditor(point, sticky, draft);
  }

  private recoverTableCellDraft(draft: TableCellDraftRecovery): void {
    this.rejectedTableCellDrafts.push(draft);
    this.scheduleRejectedDraftRestore();
  }

  private restoreNextTableCellDraft(): void {
    if (this.textEditor || this.tableCellEditor || !this.canCommit()) return;
    const draft = this.rejectedTableCellDrafts[0];
    if (!draft) return;
    const latest = this.model.getItem(draft.itemId);
    if (
      latest?.kind !== "table" ||
      latest.geometry.cells[draft.row]?.[draft.column] === undefined
    ) {
      return;
    }
    this.rejectedTableCellDrafts.shift();
    this.openTableCellEditor(latest, draft.row, draft.column, draft);
  }

  private recoverZoneTitleDraft(draft: ZoneTitleDraftRecovery): void {
    this.rejectedZoneTitleDrafts.push(draft);
    this.scheduleRejectedDraftRestore();
  }

  private restoreNextZoneTitleDraft(): void {
    if (
      this.textEditor ||
      this.tableCellEditor ||
      this.zoneTitleEditor ||
      this.imageAltDialog.open ||
      !this.canCommit()
    ) {
      return;
    }
    const draft = this.rejectedZoneTitleDrafts[0];
    if (!draft) return;
    const latest = this.model.getItem(draft.itemId);
    if (latest?.kind !== "zone" || latest.version <= 0) return;
    this.rejectedZoneTitleDrafts.shift();
    this.openZoneTitleEditor(latest, draft);
  }

  private syncNewZoneTitleEditor(): void {
    if (this.pendingNewZoneTitles.size === 0) return;
    for (const itemId of this.pendingNewZoneTitles) {
      const item = this.model.getItem(itemId);
      if (item?.kind !== "zone") {
        this.pendingNewZoneTitles.delete(itemId);
        continue;
      }
      if (item.version <= 0) continue;
      if (
        this.textEditor ||
        this.tableCellEditor ||
        this.zoneTitleEditor ||
        this.imageAltDialog.open ||
        !this.canCommit()
      ) {
        return;
      }
      this.pendingNewZoneTitles.delete(itemId);
      this.openZoneTitleEditor(item, {
        itemId,
        title: item.geometry.title,
        selectionStart: 0,
        selectionEnd: item.geometry.title.length,
      });
      return;
    }
  }

  private scheduleRejectedDraftRestore(): void {
    if (
      this.rejectedStickyDrafts.length === 0 &&
      this.rejectedTableCellDrafts.length === 0 &&
      this.rejectedZoneTitleDrafts.length === 0 &&
      this.pendingNewZoneTitles.size === 0
    ) {
      return;
    }
    queueMicrotask(() => {
      this.restoreNextStickyDraft();
      this.restoreNextTableCellDraft();
      this.restoreNextZoneTitleDraft();
      this.syncNewZoneTitleEditor();
    });
  }

  private async updateTitle(): Promise<void> {
    if (this.bootstrap.actor.role !== "owner" || this.phase === "archived" || this.archivePending) {
      this.titleInput.value = this.bootstrap.board.title;
      return;
    }
    const title = this.titleInput.value.trim();
    if (!title || title === this.bootstrap.board.title) {
      this.titleInput.value = this.bootstrap.board.title;
      return;
    }
    try {
      const result = await this.api.updateSettings(
        this.bootstrap.board.id,
        { title },
        this.bootstrap.board.aclVersion,
      );
      this.bootstrap.board.title = title;
      this.adoptAclVersion(result);
      document.title = brandedDocumentTitle(title);
    } catch (error) {
      this.titleInput.value = this.bootstrap.board.title;
      this.apiError(error);
    }
  }

  private async loadAccessPanel(): Promise<void> {
    if (this.bootstrap.actor.role !== "owner") {
      this.accessBody.replaceChildren();
      return;
    }
    this.accessBody.replaceChildren(loadingBlock("Loading access…"));
    try {
      this.accessMembers = await this.api.members(this.bootstrap.board.id);
      this.renderAccessPanel();
    } catch (error) {
      this.accessBody.replaceChildren(errorBlock("Access controls could not be loaded."));
      this.apiError(error);
    }
  }

  private async loadParticipantRoles(): Promise<void> {
    if (this.bootstrap.actor.role !== "owner") return;
    try {
      this.accessMembers = await this.api.members(this.bootstrap.board.id);
      if (!this.participantDrawer.hidden) this.renderParticipants();
    } catch (error) {
      this.apiError(error);
    }
  }

  private renderAccessPanel(): void {
    this.accessBody.replaceChildren();

    const inviteSection = document.createElement("section");
    inviteSection.className = "access-section";
    inviteSection.innerHTML = `
      <h3>Invite people</h3>
      <form class="invite-form" data-invite-form>
        <label><span>Role</span><select name="role"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="owner">Co-owner</option></select></label>
        <label><span>Link uses</span><select name="maxUses"><option value="1">One person</option><option value="20">Session link · 20</option><option value="50">Session link · 50</option></select></label>
        <label class="full-field"><span>Label <i>optional</i></span><input name="label" maxlength="80" placeholder="e.g. Design team" /></label>
        <button class="primary-button full-field" type="submit">Create invite link</button>
      </form>
      <div class="one-time-secret" data-invite-result hidden></div>
    `;
    query(inviteSection, "[data-invite-form]", HTMLFormElement).addEventListener(
      "submit",
      (event) => void this.createInvitation(event),
    );
    if (this.managedInvitations.length > 0) {
      const managedHeading = document.createElement("h4");
      managedHeading.textContent = "Created in this browser session";
      managedHeading.className = "subsection-heading";
      const managedList = document.createElement("div");
      managedList.className = "management-list";
      managedList.dataset.managedInvitations = "true";
      for (const invitation of this.managedInvitations) {
        managedList.append(this.invitationRow(invitation));
      }
      inviteSection.append(managedHeading, managedList);
    }
    this.accessBody.append(inviteSection);

    const membersSection = document.createElement("section");
    membersSection.className = "access-section";
    const heading = document.createElement("div");
    heading.className = "section-heading";
    const title = document.createElement("h3");
    title.textContent = "Members";
    const count = document.createElement("span");
    count.textContent = String(this.accessMembers.length);
    heading.append(title, count);
    membersSection.append(heading);
    const list = document.createElement("div");
    list.className = "member-list";
    for (const member of this.accessMembers) list.append(this.memberRow(member));
    membersSection.append(list);
    this.accessBody.append(membersSection);
  }

  private async loadSettingsPanel(): Promise<void> {
    if (this.bootstrap.actor.role !== "owner") {
      this.settingsBody.replaceChildren();
      return;
    }
    this.settingsBody.replaceChildren(loadingBlock("Loading settings…"));
    try {
      const [recoverySnapshots, accessMembers, organisationWebhookSettings] = await Promise.all([
        this.api.snapshots(this.bootstrap.board.id),
        this.api.members(this.bootstrap.board.id),
        this.api.organisationWebhookSettings(this.bootstrap.board.id),
      ]);
      if (this.bootstrap.actor.role !== "owner") {
        this.clearOwnerSettings();
        return;
      }
      this.recoverySnapshots = recoverySnapshots;
      this.accessMembers = accessMembers;
      this.organisationWebhookSettings = organisationWebhookSettings;
      this.renderSettingsPanel();
    } catch (error) {
      if (this.bootstrap.actor.role !== "owner") {
        this.clearOwnerSettings();
        return;
      }
      this.settingsBody.replaceChildren(errorBlock("Space settings could not be loaded."));
      this.apiError(error);
    }
  }

  private renderSettingsPanel(): void {
    if (this.bootstrap.actor.role !== "owner") {
      this.clearOwnerSettings();
      return;
    }
    const permissionsOpen =
      this.settingsBody.querySelector<HTMLDetailsElement>(".settings-collapsible")?.open ?? false;
    this.settingsBody.replaceChildren();
    this.settingsBody.setAttribute(
      "aria-busy",
      String(this.organisationWebhookSavePending || this.organisationWebhookSendPending),
    );

    const boardSection = document.createElement("section");
    boardSection.className = "access-section";
    boardSection.innerHTML = `
      <h3>Space</h3>
      <label class="settings-title-field"><span>Name</span><input data-settings-title maxlength="100" autocomplete="off" /></label>
      <h4>Who can draw now</h4>
      <div class="segmented-control" data-policy-controls aria-label="Drawing policy">
        <button type="button" data-policy="editors_enabled">Editors can draw</button>
        <button type="button" data-policy="owner_only">Lock editors</button>
        <button type="button" data-policy="locked">Lock everyone</button>
      </div>
      <label class="field-row"><span><strong>Space link</strong><small>Choose whether non-members can view</small></span><select data-access-mode aria-label="Space link access"><option value="link_view">Anyone with link can view</option><option value="private">Members only</option></select></label>
    `;
    const settingsTitle = query(boardSection, "[data-settings-title]", HTMLInputElement);
    settingsTitle.value = this.bootstrap.board.title;
    settingsTitle.addEventListener("change", () => {
      this.titleInput.value = settingsTitle.value;
      void this.updateTitle().then(() => this.renderSettingsPanel());
    });
    for (const button of boardSection.querySelectorAll<HTMLButtonElement>("[data-policy]")) {
      const selected = button.dataset.policy === this.bootstrap.board.drawingPolicy;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.addEventListener(
        "click",
        () => void this.setPolicy(button.dataset.policy as DrawingPolicy),
      );
    }
    const accessMode = query(boardSection, "[data-access-mode]", HTMLSelectElement);
    accessMode.value = this.bootstrap.board.accessMode;
    accessMode.addEventListener(
      "change",
      () => void this.setAccessMode(accessMode.value as AccessMode),
    );
    this.settingsBody.append(boardSection);

    const featureSection = document.createElement("section");
    featureSection.className = "access-section settings-permissions-section";
    featureSection.innerHTML = `
      <details class="settings-collapsible">
        <summary><span class="settings-collapsible-label">Tool permissions</span><span class="settings-collapsible-count">${BOARD_FEATURE_KEYS.filter((key) => this.bootstrap.board.features[key]).length}/${BOARD_FEATURE_KEYS.length} enabled</span></summary>
        <div class="settings-collapsible-body">
          <p class="section-note">Changes apply immediately to everyone in this Space. Existing objects remain visible and movable.</p>
          <div class="feature-toggle-grid" data-feature-toggle-grid></div>
        </div>
      </details>
    `;
    query(featureSection, ".settings-collapsible", HTMLDetailsElement).open = permissionsOpen;
    const featureGrid = query(featureSection, "[data-feature-toggle-grid]", HTMLElement);
    for (const key of BOARD_FEATURE_KEYS) {
      const metadata = FEATURE_LABELS[key];
      const row = document.createElement("label");
      row.className = "feature-toggle";
      row.innerHTML = `<span><strong>${metadata.label}</strong><small>${metadata.detail}</small></span>`;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.feature = key;
      input.checked = this.bootstrap.board.features[key];
      input.disabled = key === "partialEraser" && !this.bootstrap.board.features.eraser;
      input.setAttribute("aria-label", `Enable ${metadata.label}`);
      input.addEventListener("change", () => void this.setFeature(key, input.checked));
      row.append(input);
      featureGrid.append(row);
    }
    this.settingsBody.append(featureSection);

    const webhookSettings = this.organisationWebhookSettings;
    if (webhookSettings !== null && webhookSettings.organisationId !== null) {
      const webhookSection = document.createElement("section");
      webhookSection.className = "access-section organisation-webhook-section";
      webhookSection.dataset.testid = "organisation-webhook-settings";
      webhookSection.innerHTML = `
        <h3>Organisation webhook</h3>
        <p class="section-note">Send the current attributed JSON export to your approved partner endpoint. Participant identifiers and board content are included.</p>
        <form class="organisation-webhook-form" data-organisation-webhook-form>
          <label><span>Webhook URL</span><input name="webhookUrl" type="url" inputmode="url" autocomplete="url" maxlength="2048" placeholder="https://hooks.partner.example/spacescale" /></label>
          <div class="organisation-webhook-actions">
            <button class="primary-button" type="submit">Save URL</button>
            <button type="button" data-remove-organisation-webhook>Remove</button>
          </div>
        </form>
        <p class="organisation-webhook-status" data-organisation-webhook-status role="status" aria-live="polite"></p>
        <button type="button" data-send-organisation-webhook>Send this Space now</button>
      `;
      const webhookForm = query(
        webhookSection,
        "[data-organisation-webhook-form]",
        HTMLFormElement,
      );
      const webhookInput = query(webhookForm, "input[name='webhookUrl']", HTMLInputElement);
      webhookInput.value = webhookSettings.webhookUrl ?? "";
      webhookForm.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.updateOrganisationWebhook(webhookInput.value.trim() || null);
      });
      const removeButton = query(
        webhookSection,
        "[data-remove-organisation-webhook]",
        HTMLButtonElement,
      );
      removeButton.disabled =
        webhookSettings.webhookUrl === null ||
        this.organisationWebhookSavePending ||
        this.organisationWebhookSendPending;
      removeButton.addEventListener("click", () => void this.updateOrganisationWebhook(null));
      const saveButton = query(webhookForm, "button[type='submit']", HTMLButtonElement);
      saveButton.disabled =
        this.organisationWebhookSavePending || this.organisationWebhookSendPending;
      saveButton.textContent = this.organisationWebhookSavePending ? "Saving…" : "Save URL";
      const status = query(webhookSection, "[data-organisation-webhook-status]", HTMLElement);
      status.textContent = webhookSettings.webhookUrl
        ? `Configured${webhookSettings.updatedAt === null ? "" : ` · updated ${formatDateTime(webhookSettings.updatedAt)}`}`
        : "No webhook configured.";
      const sendButton = query(
        webhookSection,
        "[data-send-organisation-webhook]",
        HTMLButtonElement,
      );
      sendButton.disabled =
        webhookSettings.webhookUrl === null ||
        this.organisationWebhookSavePending ||
        this.organisationWebhookSendPending;
      sendButton.textContent = this.organisationWebhookSendPending
        ? "Sending export…"
        : "Send this Space now";
      sendButton.addEventListener("click", () => void this.sendOrganisationWebhook());
      this.settingsBody.append(webhookSection);
    }

    const snapshotSection = document.createElement("section");
    snapshotSection.className = "access-section";
    snapshotSection.innerHTML = `
      <div class="section-heading"><h3>Recovery points</h3><span>${this.recoverySnapshots.length}</span></div>
      <p class="section-note">Restore drawing content without changing access, ownership, or feature settings.</p>
      <form class="snapshot-form" data-snapshot-form>
        <label><span>Snapshot name</span><input name="label" maxlength="80" required placeholder="Before workshop" /></label>
        <button class="primary-button" type="submit">Save recovery point</button>
      </form>
    `;
    query(snapshotSection, "[data-snapshot-form]", HTMLFormElement).addEventListener(
      "submit",
      (event) => void this.createNamedSnapshot(event),
    );
    const snapshotList = document.createElement("div");
    snapshotList.className = "management-list snapshot-list";
    if (this.recoverySnapshots.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-management-list";
      empty.textContent = "No recovery points have been stored yet.";
      snapshotList.append(empty);
    } else {
      for (const snapshot of this.recoverySnapshots)
        snapshotList.append(this.snapshotRow(snapshot));
    }
    snapshotSection.append(snapshotList);
    this.settingsBody.append(snapshotSection);

    const safety = document.createElement("section");
    safety.className = "access-section safety-section";
    safety.innerHTML = `
      <h3>Recovery & Space</h3>
      <p>Primary ownership recovery links are shown once and must be stored privately.</p>
      <button type="button" data-rotate-recovery>Rotate recovery link</button>
      <button class="danger-button" type="button" data-clear-board>Clear Space</button>
      <div class="archive-danger-zone">
        <strong>Archive permanently</strong>
        <p>Archiving cannot be undone. The Space becomes read only and existing links stop opening it.</p>
        <button class="danger-button" type="button" data-archive-board>Archive Space</button>
        <small>Available only when connected and every edit is saved.</small>
      </div>
      <div class="one-time-secret" data-recovery-result hidden></div>
    `;
    const rotateRecoveryButton = query(safety, "[data-rotate-recovery]", HTMLButtonElement);
    rotateRecoveryButton.hidden = !this.accessMembers.some(
      (member) => member.id === this.bootstrap.actor.id && member.primaryOwner === true,
    );
    rotateRecoveryButton.addEventListener("click", () => void this.rotateRecovery());
    query(safety, "[data-clear-board]", HTMLButtonElement).addEventListener(
      "click",
      () => void this.clearBoard(),
    );
    const archiveButton = query(safety, "[data-archive-board]", HTMLButtonElement);
    archiveButton.disabled = !this.canArchiveBoard();
    archiveButton.addEventListener("click", () => void this.archiveBoard());
    this.settingsBody.append(safety);
  }

  private memberRow(member: Member): HTMLElement {
    const row = document.createElement("div");
    row.className = "member-row";
    const identity = document.createElement("div");
    identity.className = "member-identity";
    const avatar = document.createElement("span");
    avatar.className = "participant-avatar";
    avatar.textContent = initials(member.displayName);
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const meta = document.createElement("small");
    meta.textContent =
      member.id === this.bootstrap.actor.id ? "You" : member.connected ? "Online" : "Member";
    text.append(name, meta);
    identity.append(avatar, text);
    row.append(identity);

    if (member.primaryOwner === true) {
      const owner = document.createElement("span");
      owner.className = "role-pill";
      owner.textContent = "Primary owner";
      row.append(owner);
      return row;
    }
    const actions = document.createElement("div");
    actions.className = "member-actions";
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Role for ${member.displayName}`);
    select.innerHTML =
      '<option value="owner">Owner</option><option value="editor">Editor</option><option value="viewer">Viewer</option>';
    select.value = member.role;
    select.addEventListener(
      "change",
      () => void this.changeMemberRole(member, select.value as Member["role"]),
    );
    actions.append(select);
    const currentActorIsPrimary = this.accessMembers.some(
      (value) => value.id === this.bootstrap.actor.id && value.primaryOwner === true,
    );
    if (currentActorIsPrimary && (member.role === "editor" || member.role === "owner")) {
      const transfer = document.createElement("button");
      transfer.type = "button";
      transfer.className = "make-owner";
      transfer.setAttribute("aria-label", `Make ${member.displayName} the primary owner`);
      transfer.title = "Transfer primary ownership";
      transfer.textContent = "Make primary";
      transfer.addEventListener("click", () => void this.transferOwnership(member));
      actions.append(transfer);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-member";
    remove.setAttribute("aria-label", `Remove ${member.displayName}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => void this.revokeMember(member));
    actions.append(remove);
    row.append(actions);
    return row;
  }

  private invitationRow(invitation: ManagedInvitation): HTMLElement {
    const row = document.createElement("div");
    row.className = "management-row";
    row.dataset.invitationId = invitation.id;
    const summary = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = invitation.label ?? `${invitation.role} invitation`;
    const metadata = document.createElement("small");
    metadata.textContent = `${invitation.role} · ${invitation.maxUses} use${invitation.maxUses === 1 ? "" : "s"} · expires ${formatDateTime(invitation.expiresAt)}`;
    summary.append(label, metadata);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "danger-text-button";
    revoke.textContent = "Revoke";
    revoke.setAttribute("aria-label", `Revoke ${label.textContent}`);
    revoke.addEventListener("click", () => void this.revokeInvitation(invitation));
    row.append(summary, revoke);
    return row;
  }

  private snapshotRow(snapshot: RecoverySnapshot): HTMLElement {
    const row = document.createElement("div");
    row.className = "management-row";
    row.dataset.snapshotSeq = String(snapshot.seq);
    const summary = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = snapshot.label ?? snapshotKindLabel(snapshot.kind);
    const metadata = document.createElement("small");
    metadata.textContent = `${snapshotKindLabel(snapshot.kind)} · sequence ${snapshot.seq} · ${snapshot.itemCount} item${snapshot.itemCount === 1 ? "" : "s"} · ${formatBytes(snapshot.byteCount)} · ${formatDateTime(snapshot.createdAt)}`;
    summary.append(label, metadata);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Restore";
    restore.setAttribute("aria-label", `Restore ${label.textContent}`);
    restore.addEventListener("click", () => void this.restoreSnapshot(snapshot, restore));
    row.append(summary, restore);
    return row;
  }

  private async setPolicy(policy: DrawingPolicy): Promise<void> {
    try {
      const result = await this.api.updateSettings(
        this.bootstrap.board.id,
        { drawingPolicy: policy },
        this.bootstrap.board.aclVersion,
      );
      this.bootstrap.board.drawingPolicy = policy;
      this.adoptAclVersion(result);
      this.updatePermissions();
      this.renderSettingsPanel();
    } catch (error) {
      this.apiError(error);
    }
  }

  private async setFeature(feature: BoardFeatureKey, enabled: boolean): Promise<void> {
    const previous = this.bootstrap.board.features[feature];
    try {
      const result = await this.api.updateSettings(
        this.bootstrap.board.id,
        { features: { [feature]: enabled } },
        this.bootstrap.board.aclVersion,
      );
      this.bootstrap.board.features[feature] = enabled;
      if (feature === "images") this.bootstrap.board.imagesEnabled = enabled;
      this.adoptAclVersion(result);
      if (!this.isToolEnabled(this.tools.tool)) this.tools.setTool("select");
      this.updatePermissions();
      if (feature === "organisationTemplates") {
        this.renderOrganisationTemplates();
        if (enabled) void this.loadOrganisationTemplates();
      }
      this.renderSettingsPanel();
      this.notify(`${FEATURE_LABELS[feature].label} ${enabled ? "enabled" : "disabled"}.`, "info");
    } catch (error) {
      this.bootstrap.board.features[feature] = previous;
      this.apiError(error);
      this.renderSettingsPanel();
    }
  }

  private async setAccessMode(accessMode: AccessMode): Promise<void> {
    try {
      const result = await this.api.updateSettings(
        this.bootstrap.board.id,
        { accessMode },
        this.bootstrap.board.aclVersion,
      );
      this.bootstrap.board.accessMode = accessMode;
      this.adoptAclVersion(result);
      this.renderSettingsPanel();
      this.notify(
        accessMode === "private"
          ? "Only members can open this board now."
          : "Anyone with the link can view this board.",
        "info",
      );
    } catch (error) {
      this.apiError(error);
      this.renderSettingsPanel();
    }
  }

  private async updateOrganisationWebhook(webhookUrl: string | null): Promise<void> {
    if (
      this.bootstrap.actor.role !== "owner" ||
      this.organisationWebhookSavePending ||
      this.organisationWebhookSendPending ||
      this.organisationWebhookSettings === null
    ) {
      return;
    }
    this.organisationWebhookSavePending = true;
    this.renderSettingsPanel();
    try {
      this.organisationWebhookSettings = await this.api.updateOrganisationWebhookSettings(
        this.bootstrap.board.id,
        webhookUrl,
      );
      this.organisationWebhookIdempotencyKey = null;
      this.notify(
        webhookUrl === null ? "Organisation webhook removed." : "Organisation webhook saved.",
        "info",
      );
    } catch (error) {
      this.apiError(error);
    } finally {
      this.organisationWebhookSavePending = false;
      this.renderSettingsPanel();
      this.settingsBody.querySelector<HTMLInputElement>("input[name='webhookUrl']")?.focus();
    }
  }

  private async sendOrganisationWebhook(): Promise<void> {
    const settings = this.organisationWebhookSettings;
    if (
      this.bootstrap.actor.role !== "owner" ||
      this.organisationWebhookSendPending ||
      this.organisationWebhookSavePending ||
      settings === null ||
      settings.webhookUrl === null
    ) {
      return;
    }
    const destination = new URL(settings.webhookUrl).origin;
    if (
      !window.confirm(
        `Send the current attributed Space export, including participant identifiers, to ${destination}?`,
      )
    ) {
      return;
    }
    const idempotencyKey = this.organisationWebhookIdempotencyKey ?? crypto.randomUUID();
    this.organisationWebhookIdempotencyKey = idempotencyKey;
    this.organisationWebhookSendPending = true;
    this.renderSettingsPanel();
    try {
      const result = await this.api.sendBoardToOrganisationWebhook(
        this.bootstrap.board.id,
        idempotencyKey,
      );
      this.organisationWebhookIdempotencyKey = null;
      this.notify(
        `Space sent to the organisation webhook (HTTP ${result.delivery.responseStatus}).`,
        "info",
      );
    } catch (error) {
      this.apiError(error);
    } finally {
      this.organisationWebhookSendPending = false;
      this.renderSettingsPanel();
      this.settingsBody
        .querySelector<HTMLButtonElement>("[data-send-organisation-webhook]")
        ?.focus();
    }
  }

  private async createInvitation(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (submit) submit.disabled = true;
    try {
      const result = await this.api.createInvitation(this.bootstrap.board.id, {
        role:
          data.get("role") === "viewer"
            ? "viewer"
            : data.get("role") === "owner"
              ? "owner"
              : "editor",
        maxUses: Math.max(1, Math.min(50, Number(data.get("maxUses")) || 1)),
        label: String(data.get("label") ?? "").trim() || undefined,
        expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
      });
      const token = stringValue(result.token);
      const url =
        stringValue(result.url) ??
        (token
          ? `${location.origin}/b/${this.bootstrap.board.id}#invite=${encodeURIComponent(token)}`
          : null);
      this.managedInvitations = [
        result.invitation,
        ...this.managedInvitations.filter((value) => value.id !== result.invitation.id),
      ];
      saveManagedInvitations(this.bootstrap.board.id, this.managedInvitations);
      this.renderAccessPanel();
      const output = query(this.accessBody, "[data-invite-result]", HTMLElement);
      this.renderOneTimeLink(output, url, "Copy this link now. It won’t be shown again.");
      form.reset();
    } catch (error) {
      this.apiError(error);
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  private async revokeInvitation(invitation: ManagedInvitation): Promise<void> {
    if (!confirm(`Revoke ${invitation.label ?? "this invitation"}? Its link will stop working.`)) {
      return;
    }
    try {
      await this.api.revokeInvitation(this.bootstrap.board.id, invitation.id);
      this.managedInvitations = this.managedInvitations.filter(
        (value) => value.id !== invitation.id,
      );
      saveManagedInvitations(this.bootstrap.board.id, this.managedInvitations);
      this.renderAccessPanel();
      this.notify("Invitation revoked.", "info");
    } catch (error) {
      this.apiError(error);
    }
  }

  private async createNamedSnapshot(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const label = String(new FormData(form).get("label") ?? "").trim();
    if (!label) return;
    const submit = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (submit) submit.disabled = true;
    try {
      const snapshot = await this.api.createNamedSnapshot(this.bootstrap.board.id, label);
      this.recoverySnapshots = [
        snapshot,
        ...this.recoverySnapshots.filter((value) => value.seq !== snapshot.seq),
      ].sort((left, right) => right.seq - left.seq);
      this.renderSettingsPanel();
      this.notify(`Recovery point “${label}” saved at sequence ${snapshot.seq}.`, "info");
    } catch (error) {
      this.apiError(error);
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  private async restoreSnapshot(
    snapshot: RecoverySnapshot,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (this.phase !== "ready" || this.model.pendingCount > 0 || this.optimisticRecovery) {
      this.notify("Wait for pending edits to save before restoring a recovery point.", "warning");
      return;
    }
    const label = snapshot.label ?? snapshotKindLabel(snapshot.kind);
    if (
      !confirm(
        `Restore “${label}” from sequence ${snapshot.seq}? Current drawing content will be replaced, and the restore will be recorded as a new action.`,
      )
    ) {
      return;
    }
    button.disabled = true;
    try {
      const result = await this.api.restoreSnapshot(
        this.bootstrap.board.id,
        snapshot.seq,
        this.model.lastAppliedSeq,
      );
      this.closeDrawers();
      this.notify(`Recovery point restored as sequence ${result.seq}.`, "info");
      this.socket.resynchronize("Loading the restored board content.");
    } catch (error) {
      this.apiError(error);
      button.disabled = false;
    }
  }

  private async changeMemberRole(member: Member, role: Member["role"]): Promise<void> {
    try {
      const result = await this.api.updateMember(
        this.bootstrap.board.id,
        member.id,
        role,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      member.role = role;
    } catch (error) {
      this.apiError(error);
      this.renderAccessPanel();
    }
  }

  private async changeParticipantRole(member: Member, role: "viewer" | "editor"): Promise<void> {
    if (member.role === role || this.participantRoleChangesPending.has(member.id)) return;
    this.participantRoleChangesPending.add(member.id);
    this.renderParticipants();
    try {
      const result = await this.api.updateMember(
        this.bootstrap.board.id,
        member.id,
        role,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      this.accessMembers = this.accessMembers.map((value) =>
        value.id === member.id ? { ...value, role } : value,
      );
      for (const [key, presence] of this.presences) {
        if (presence.id === member.id) this.presences.set(key, { ...presence, role });
      }
    } catch (error) {
      this.apiError(error);
    } finally {
      this.participantRoleChangesPending.delete(member.id);
      if (!this.participantDrawer.hidden) this.renderParticipants();
    }
  }

  private async revokeMember(member: Member): Promise<void> {
    if (!confirm(`Remove ${member.displayName} from this board?`)) return;
    try {
      const result = await this.api.revokeMember(
        this.bootstrap.board.id,
        member.id,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      this.accessMembers = this.accessMembers.filter((value) => value.id !== member.id);
      this.renderAccessPanel();
    } catch (error) {
      this.apiError(error);
    }
  }

  private async transferOwnership(member: Member): Promise<void> {
    if (
      !confirm(
        `Make ${member.displayName} the primary owner? They will control ownership recovery, and every previous recovery link will stop working.`,
      )
    )
      return;
    try {
      const result = await this.api.transferOwnership(
        this.bootstrap.board.id,
        member.id,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      const previousOwner = this.accessMembers.find((value) => value.primaryOwner === true);
      if (previousOwner) previousOwner.primaryOwner = false;
      member.role = "owner";
      member.primaryOwner = true;
      this.closeDrawers();
      this.updatePermissions();
      this.renderParticipants();
      this.notify(
        result.recoveryTokenDelivered === true
          ? `Ownership transferred to ${member.displayName}. Their active board session received the new recovery link.`
          : `Ownership transferred to ${member.displayName}. They can rotate a recovery link after opening the board.`,
        "info",
      );
    } catch (error) {
      this.apiError(error);
    }
  }

  private showTransferredOwnerRecovery(token: string): void {
    document.querySelector("[data-testid='transferred-owner-recovery']")?.remove();
    const recoveryUrl = `${location.origin}/b/${encodeURIComponent(this.bootstrap.board.id)}#recovery=${encodeURIComponent(token)}`;
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog created-dialog";
    dialog.dataset.testid = "transferred-owner-recovery";
    dialog.innerHTML = `
      <span class="dialog-mark" aria-hidden="true">✓</span>
      <h1>You’re now the owner</h1>
      <p>Save this new recovery link somewhere private. It is shown only in your active owner session.</p>
      <div class="secret-copy"><span></span><button type="button" data-copy>Copy</button></div>
      <button class="primary-button" type="button" data-continue>I saved it</button>
    `;
    query(dialog, ".secret-copy span", HTMLElement).textContent = recoveryUrl;
    query(dialog, "[data-copy]", HTMLButtonElement).addEventListener("click", async (event) => {
      try {
        await navigator.clipboard.writeText(recoveryUrl);
        (event.currentTarget as HTMLButtonElement).textContent = "Copied";
      } catch {
        this.notify("Select and copy the recovery link manually.", "warning");
      }
    });
    query(dialog, "[data-continue]", HTMLButtonElement).addEventListener("click", () => {
      dialog.close();
    });
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  private async rotateRecovery(): Promise<void> {
    if (
      !confirm("Rotate the owner recovery link? The previous link will stop working immediately.")
    )
      return;
    try {
      const result = await this.api.rotateRecovery(
        this.bootstrap.board.id,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      const token = stringValue(result.ownerRecoveryToken) ?? stringValue(result.token);
      const url =
        stringValue(result.ownerRecoveryUrl) ??
        stringValue(result.url) ??
        (token
          ? `${location.origin}/b/${this.bootstrap.board.id}#recovery=${encodeURIComponent(token)}`
          : null);
      const output = query(this.settingsBody, "[data-recovery-result]", HTMLElement);
      this.renderOneTimeLink(
        output,
        url,
        "Save this recovery link now. Every older link is invalid.",
      );
    } catch (error) {
      this.apiError(error);
    }
  }

  private async clearBoard(): Promise<void> {
    if (!confirm("Clear every item from this board? A recovery snapshot will be created first."))
      return;
    const accepted = await this.commit({
      kind: "board.clear",
      expectedBoardSeq: this.model.lastAppliedSeq,
    });
    if (accepted) this.closeDrawers();
  }

  private async archiveBoard(): Promise<void> {
    if (!this.canArchiveBoard()) {
      this.notify(
        "Wait until the board shows Saved and resolve any local recovery data before archiving.",
        "warning",
      );
      return;
    }

    this.archivePending = true;
    this.updatePermissions();
    try {
      const outbox = await this.outbox.contents(this.bootstrap.board.id, this.bootstrap.actor.id);
      if (
        this.model.pendingCount > 0 ||
        outbox.active.length > 0 ||
        outbox.expired.length > 0 ||
        this.optimisticRecovery
      ) {
        this.notify(
          "Archive cancelled because this browser still has unsaved or recovery edits.",
          "warning",
        );
        return;
      }
      if (
        !confirm(
          `Archive “${this.bootstrap.board.title}” permanently? This cannot be undone. The board will become read only, and existing access and invitation links will stop opening it.`,
        )
      ) {
        return;
      }

      const result = await this.api.archiveBoard(
        this.bootstrap.board.id,
        this.bootstrap.board.aclVersion,
      );
      this.adoptAclVersion(result);
      this.socket.stop(undefined, "archived");
    } catch (error) {
      this.apiError(error);
    } finally {
      this.archivePending = false;
      this.updatePermissions();
    }
  }

  private renderOneTimeLink(container: HTMLElement, url: string | null, message: string): void {
    container.replaceChildren();
    container.hidden = false;
    const note = document.createElement("strong");
    note.textContent = message;
    const value = document.createElement("span");
    value.textContent = url ?? "The server did not return a visible link.";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy link";
    copy.disabled = !url;
    copy.addEventListener("click", async () => {
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = "Copied";
      } catch {
        this.notify("Select and copy the link manually.", "warning");
      }
    });
    container.append(note, value, copy);
  }

  private adoptAclVersion(result: Record<string, unknown>): void {
    const board = isRecord(result.board) ? result.board : result;
    if (typeof board.aclVersion === "number") this.bootstrap.board.aclVersion = board.aclVersion;
    else this.bootstrap.board.aclVersion += 1;
  }

  private canComment(): boolean {
    return canActorComment(
      this.phase,
      this.bootstrap.actor.role,
      this.bootstrap.board.drawingPolicy,
    );
  }

  private async reloadComments(notifyOnError = true): Promise<void> {
    const load = this.comments.beginLoad();
    this.commentsLoading = true;
    this.renderComments();
    try {
      const comments = await this.api.comments(this.bootstrap.board.id);
      if (this.comments.completeLoad(load, comments)) this.applyCommentChange();
    } catch (error) {
      if (notifyOnError) this.apiError(error);
    } finally {
      if (this.comments.isLatestLoad(load)) {
        this.commentsLoading = false;
        this.renderComments();
      }
    }
  }

  private reconcileCommentStates(): void {
    if (this.comments.reconcile()) this.applyCommentChange();
  }

  private applyCommentChange(): void {
    this.renderer.setComments(this.comments.comments);
    this.renderComments();
  }

  private openCommentsForItem(itemId: string): void {
    if (!this.model.getItem(itemId)) return;
    if (this.activeCommentTargetId !== itemId) this.clearPendingCommentMedia();
    this.activeCommentTargetId = itemId;
    this.commentsFocusItemId = null;
    this.closeDrawers();
    this.commentsDrawer.hidden = false;
    this.commentsButton.setAttribute("aria-expanded", "true");
    this.renderComments();
    this.commentInput.focus();
  }

  /**
   * Opens the drawer on one object's comments alone: no composer, no other objects' threads.
   * This is what a comment marker does. Every comment is still a click away in Settings.
   */
  private openCommentsFocused(itemId: string): void {
    if (!this.model.getItem(itemId)) return;
    this.commentsFocusItemId = itemId;
    this.activeCommentTargetId = null;
    this.closeDrawers();
    this.commentsDrawer.hidden = false;
    this.commentsButton.setAttribute("aria-expanded", "true");
    this.renderComments();
    query(this.commentsDrawer, "[data-close-drawer]", HTMLButtonElement).focus();
  }

  private async submitComment(): Promise<void> {
    const itemId = this.activeCommentTargetId;
    const body = this.commentInput.value.trim();
    if (!itemId || !this.model.getItem(itemId) || this.commentSubmitting || !this.canComment())
      return;
    if (this.commentImageUploading) {
      this.notify("The image is still uploading.", "info");
      return;
    }
    if (body.length === 0) {
      this.commentInput.focus();
      return;
    }
    if ([...body].length > 2_000) {
      this.notify("Comments can contain at most 2,000 characters.", "error");
      return;
    }
    const media = this.commentMediaToSend();
    if (
      media?.kind === "image" &&
      media.alt !== undefined &&
      [...media.alt].length > MAX_IMAGE_ALT_CODE_POINTS
    ) {
      this.notify(
        `An image description can contain at most ${MAX_IMAGE_ALT_CODE_POINTS} characters.`,
        "error",
      );
      return;
    }
    this.commentSubmitting = true;
    this.renderComments();
    try {
      const comment = await this.api.createComment(
        this.bootstrap.board.id,
        itemId,
        body,
        undefined,
        media,
      );
      this.comments.upsert(comment);
      this.commentInput.value = "";
      this.clearPendingCommentMedia();
      this.applyCommentChange();
      this.liveRegion.textContent = media ? "Comment with media added." : "Comment added.";
    } catch (error) {
      this.apiError(error);
    } finally {
      this.commentSubmitting = false;
      this.renderComments();
    }
  }

  /** Opens the file picker for a picture the next comment will carry. */
  private pickCommentImage(): void {
    if (this.pendingCommentMedia !== null || this.commentImageUploading) return;
    if (!this.canUploadImages()) {
      this.notify(
        this.bootstrap.board.features.images && this.bootstrap.board.imagesEnabled
          ? "Adding a picture to a comment needs board edit access."
          : "Images are switched off for this Space.",
        "warning",
      );
      return;
    }
    this.commentImageInput.click();
  }

  /**
   * Uploads one picture through the board's own asset path and holds it for the next comment.
   * The comment carries the stored asset, never the bytes, so it is the same private image a
   * card on the canvas would show.
   */
  private async attachCommentImage(image: File): Promise<void> {
    if (this.pendingCommentMedia !== null || this.commentImageUploading) return;
    const issue = imageUploadIssue(image);
    if (issue) {
      this.notify(issue, "warning");
      return;
    }
    if (!this.canUploadImages()) {
      this.notify("Adding a picture to a comment needs board edit access.", "warning");
      return;
    }
    if (!navigator.onLine || this.phase !== "ready") {
      this.notify("Attach the image when reconnected.", "warning");
      return;
    }
    this.commentImageUploading = true;
    this.renderCommentComposerState();
    try {
      const prepared = await privacySafeImageUpload(image);
      const asset = await this.api.uploadBoardImage(this.bootstrap.board.id, prepared);
      this.pendingCommentMedia = {
        kind: "image",
        assetId: asset.assetId,
        mimeType: asset.mimeType,
        intrinsicWidth: asset.intrinsicWidth,
        intrinsicHeight: asset.intrinsicHeight,
      };
      this.commentVideoField.hidden = true;
      this.liveRegion.textContent = "Image attached to this comment.";
    } catch (error) {
      if (error instanceof ApiError) this.notify(error.message, "error");
      else if (error instanceof ImagePreparationError) this.notify(error.message, "warning");
      else this.notify("The image could not be uploaded.", "error");
    } finally {
      this.commentImageUploading = false;
      this.renderCommentComposerState();
      if (this.pendingCommentMedia?.kind === "image") this.commentImageAltInput.focus();
    }
  }

  private openCommentVideoField(): void {
    if (this.pendingCommentMedia !== null) return;
    this.commentVideoField.hidden = false;
    query(this.commentVideoField, "[data-comment-video-error]", HTMLElement).textContent = "";
    this.commentVideoUrl.focus();
  }

  /** Holds a public YouTube or Vimeo link for the next comment, refusing anything else. */
  private attachCommentVideo(): void {
    const error = query(this.commentVideoField, "[data-comment-video-error]", HTMLElement);
    const video = videoEmbedFromText(this.commentVideoUrl.value);
    if (!video) {
      error.textContent = "Use a complete HTTPS YouTube or Vimeo video link.";
      this.commentVideoUrl.focus();
      return;
    }
    error.textContent = "";
    this.pendingCommentMedia = { kind: "video", provider: video.provider, url: video.sourceUrl };
    this.commentVideoUrl.value = "";
    this.commentVideoField.hidden = true;
    this.renderCommentComposerState();
    this.commentInput.focus();
  }

  private clearPendingCommentMedia(): void {
    this.pendingCommentMedia = null;
    this.commentImageAltInput.value = "";
    this.commentVideoUrl.value = "";
    this.commentVideoField.hidden = true;
    query(this.commentVideoField, "[data-comment-video-error]", HTMLElement).textContent = "";
    this.renderCommentComposerState();
  }

  /** What the composer will send with the next comment, with the description the author typed. */
  private commentMediaToSend(): CommentMedia | undefined {
    const media = this.pendingCommentMedia;
    if (media === null) return undefined;
    if (media.kind !== "image") return media;
    const alt = this.commentImageAltInput.value.trim();
    return alt.length === 0 ? media : { ...media, alt };
  }

  /** Reflects the pending attachment and what the composer can still accept. */
  private renderCommentComposerState(): void {
    const media = this.pendingCommentMedia;
    const busy = this.commentSubmitting || this.commentImageUploading;
    this.commentAttachment.hidden = media === null && !this.commentImageUploading;
    query(this.commentAttachment, "[data-comment-image-alt-field]", HTMLElement).hidden =
      media?.kind !== "image";
    this.commentAttachmentLabel.textContent = this.commentImageUploading
      ? "Uploading image…"
      : media?.kind === "image"
        ? "Image attached"
        : media?.kind === "video"
          ? `${videoProviderLabel(media.provider)} video attached`
          : "";
    const remove = query(
      this.commentAttachment,
      "[data-comment-attachment-remove]",
      HTMLButtonElement,
    );
    remove.hidden = media === null;
    remove.disabled = busy;
    query(this.commentComposer, "[data-comment-add-image]", HTMLButtonElement).disabled =
      busy || media !== null || !this.canUploadImages();
    query(this.commentComposer, "[data-comment-add-video]", HTMLButtonElement).disabled =
      busy || media !== null;
    query(this.commentVideoField, "[data-comment-video-attach]", HTMLButtonElement).disabled = busy;
    this.commentImageAltInput.disabled = busy;
    this.commentVideoUrl.disabled = busy;
  }

  /**
   * The picture or video under a comment's text. A picture loads from this board's private
   * bucket; a video stays a link until a participant chooses to play it in the drawer.
   */
  private commentMediaNode(comment: BoardComment): HTMLElement | null {
    const media = comment.media;
    if (media === undefined) return null;
    if (media.kind === "image") return this.commentImageNode(media);
    return this.commentVideoNode(comment.id, media);
  }

  private commentImageNode(media: Extract<CommentMedia, { kind: "image" }>): HTMLElement {
    const figure = document.createElement("figure");
    figure.className = "comment-media comment-media-image";
    figure.dataset.commentMedia = "image";
    const image = document.createElement("img");
    image.alt = media.alt ?? "Image attached to this comment";
    image.loading = "lazy";
    image.dataset.assetId = media.assetId;
    figure.append(image);
    if (media.alt !== undefined) {
      const caption = document.createElement("figcaption");
      caption.textContent = media.alt;
      figure.append(caption);
    }
    void this.loadCommentImage(media.assetId).then(
      (url) => {
        image.src = url;
      },
      () => {
        const failed = document.createElement("p");
        failed.className = "comment-media-error";
        failed.textContent = "This image could not be loaded.";
        image.replaceWith(failed);
      },
    );
    return figure;
  }

  private commentVideoNode(
    commentId: string,
    media: Extract<CommentMedia, { kind: "video" }>,
  ): HTMLElement {
    const card = document.createElement("div");
    card.className = "comment-media comment-media-video";
    card.dataset.commentMedia = "video";
    const video = videoEmbedFromText(media.url);
    const link = document.createElement("a");
    link.className = "comment-media-video-link";
    link.href = media.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    link.textContent = `${video?.title ?? videoProviderLabel(media.provider)} · open in new tab`;
    card.append(link);
    if (!video) return card;

    const play = document.createElement("button");
    play.type = "button";
    play.className = "comment-media-play";
    play.dataset.commentVideoPlay = "true";
    play.textContent = "Play video here";
    const player = document.createElement("div");
    player.className = "comment-media-player";
    const frame = document.createElement("iframe");
    frame.className = "comment-media-frame";
    frame.title = video.title;
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.allow =
      "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share";
    frame.allowFullscreen = true;
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "comment-media-stop";
    stop.dataset.commentVideoStop = "true";
    stop.textContent = "Stop video";
    player.append(frame, stop);
    play.addEventListener("click", () => {
      // Swapped in place: rebuilding the list would reload the player mid-sentence.
      this.playingCommentVideoId = commentId;
      frame.src = video.embedUrl;
      play.replaceWith(player);
    });
    stop.addEventListener("click", () => {
      this.playingCommentVideoId = null;
      frame.removeAttribute("src");
      player.replaceWith(play);
      play.focus();
      if (this.commentsRenderPending) this.renderComments();
    });
    card.append(play);
    return card;
  }

  /**
   * One object URL per comment picture, shared by every card that shows it and revoked when
   * the board tears down. The asset itself is fetched with the participant's own session.
   */
  private loadCommentImage(assetId: string): Promise<string> {
    const existing = this.commentImageUrls.get(assetId);
    if (existing) return existing;
    const pending = this.api
      .boardImage(this.bootstrap.board.id, assetId)
      .then((blob) => URL.createObjectURL(blob))
      .catch((error: unknown) => {
        if (this.commentImageUrls.get(assetId) === pending) this.commentImageUrls.delete(assetId);
        throw error;
      });
    this.commentImageUrls.set(assetId, pending);
    return pending;
  }

  private releaseCommentImages(): void {
    for (const pending of this.commentImageUrls.values()) {
      void pending.then(
        (url) => URL.revokeObjectURL(url),
        () => undefined,
      );
    }
    this.commentImageUrls.clear();
  }

  private async resolveObjectComment(commentId: string): Promise<void> {
    if (this.commentsResolving.has(commentId)) return;
    this.commentsResolving.add(commentId);
    this.renderComments();
    try {
      const comment = await this.api.resolveComment(this.bootstrap.board.id, commentId);
      this.comments.upsert(comment);
      this.applyCommentChange();
      this.liveRegion.textContent = "Comment resolved.";
    } catch (error) {
      this.apiError(error);
    } finally {
      this.commentsResolving.delete(commentId);
      this.renderComments();
    }
  }

  private renderComments(): void {
    const comments = this.comments.comments;
    const openCount = comments.filter((comment) => comment.state === "open").length;
    this.commentsCount.textContent = String(openCount);
    this.commentsCount.hidden = openCount === 0;
    this.commentsButton.setAttribute(
      "aria-label",
      openCount === 0 ? "View all comments" : `View all comments, ${openCount} open`,
    );
    // The card list is rebuilt when the drawer opens, so a hidden drawer only
    // needs the badge.
    if (this.commentsDrawer.hidden) return;
    if (this.playingCommentVideoId !== null) {
      // Rebuilding the list would detach the iframe a participant is watching, reloading the
      // video. Hold the render until they stop it, as the participant list does for its picker.
      this.commentsRenderPending = true;
      return;
    }
    this.commentsRenderPending = false;
    this.showHiddenCommentsInput.checked = this.showHiddenComments;

    const focused = this.commentsFocusItemId
      ? this.model.getItem(this.commentsFocusItemId)
      : undefined;
    if (this.commentsFocusItemId && !focused) this.commentsFocusItemId = null;
    this.commentsDrawer.dataset.focus = focused ? "object" : "all";
    this.commentsEyebrow.textContent = focused ? "Comments on" : "Objects";
    this.commentsHeading.textContent = focused
      ? capitalise(commentObjectLabel(focused))
      : "Comments";
    this.commentsFilter.hidden = focused !== undefined;

    const target =
      this.activeCommentTargetId && !focused
        ? this.model.getItem(this.activeCommentTargetId)
        : undefined;
    if (this.activeCommentTargetId && !target) this.activeCommentTargetId = null;
    this.commentComposer.hidden = target === undefined || !this.canComment();
    if (target) {
      this.commentTargetLabel.textContent = `Comment on ${commentObjectLabel(target)}`;
      this.commentInput.disabled = this.commentSubmitting;
      query(this.commentComposer, "[data-comment-submit]", HTMLButtonElement).disabled =
        this.commentSubmitting || this.commentImageUploading;
    }
    this.renderCommentComposerState();

    const visible = comments
      .filter((comment) => objectCommentVisible(comment.state, this.showHiddenComments))
      .filter((comment) => focused === undefined || comment.itemId === focused.id)
      .sort((left, right) => {
        const leftTarget = left.itemId === this.activeCommentTargetId ? 0 : 1;
        const rightTarget = right.itemId === this.activeCommentTargetId ? 0 : 1;
        if (leftTarget !== rightTarget) return leftTarget - rightTarget;
        const rank = { open: 0, orphaned: 1, resolved: 2 } as const;
        return rank[left.state] - rank[right.state] || right.createdAt - left.createdAt;
      });
    clearTypesetMath(this.commentsList);
    this.commentsList.replaceChildren();
    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.className = "comments-empty";
      empty.textContent = this.commentsLoading
        ? "Loading comments…"
        : focused
          ? "No open comments on this object."
          : this.showHiddenComments
            ? "No comments yet."
            : "No open comments. Select an object to start one.";
      this.commentsList.append(empty);
      return;
    }

    for (const comment of visible) {
      const card = document.createElement("article");
      card.className = "comment-card";
      card.dataset.state = comment.state;
      if (comment.itemId === this.activeCommentTargetId) card.dataset.activeTarget = "true";
      const heading = document.createElement("div");
      heading.className = "comment-card-heading";
      const identity = document.createElement("span");
      const author = document.createElement("strong");
      author.textContent = comment.author.displayName;
      const time = document.createElement("time");
      time.dateTime = new Date(comment.createdAt).toISOString();
      time.textContent = formatCommentTime(comment.createdAt);
      identity.append(author);
      if (comment.assistedBy === "ai") {
        const tag = document.createElement("span");
        tag.className = "assistance-tag";
        tag.dataset.assistedBy = "ai";
        const action = comment.assistance?.action;
        tag.textContent = action ? `AI · ${assistActionLabel(action)}` : "AI";
        tag.title = `Written by the AI assistant${comment.assistance ? ` through ${comment.assistance.tool}` : ""} on behalf of ${comment.author.displayName}`;
        identity.append(tag);
      }
      identity.append(time);
      const state = document.createElement("span");
      state.className = "comment-state";
      state.textContent = comment.state;
      heading.append(identity, state);

      const body = document.createElement("p");
      body.className = "comment-body";
      body.textContent = comment.body;
      typesetMath(body);
      const actions = document.createElement("div");
      actions.className = "comment-card-actions";
      const item = this.model.getItem(comment.itemId);
      if (item) {
        const show = document.createElement("button");
        show.type = "button";
        show.textContent = `Show ${commentObjectLabel(item)}`;
        show.addEventListener("click", () => {
          this.tools.setTool("select");
          this.tools.selectOnly([item.id]);
          const bounds = this.model.getBounds(item.id);
          if (bounds) this.renderer.viewport.fit(bounds, 180);
        });
        actions.append(show);
      } else {
        const orphan = document.createElement("span");
        orphan.className = "comment-orphan-label";
        orphan.textContent = "Deleted object";
        actions.append(orphan);
      }
      if (
        comment.state !== "resolved" &&
        canResolveComment(comment, this.bootstrap.actor.id, this.bootstrap.actor.role)
      ) {
        const resolve = document.createElement("button");
        resolve.type = "button";
        resolve.className = "comment-resolve";
        resolve.textContent = "Resolve";
        resolve.disabled = this.commentsResolving.has(comment.id);
        resolve.addEventListener("click", () => void this.resolveObjectComment(comment.id));
        actions.append(resolve);
      }
      const media = this.commentMediaNode(comment);
      if (media) card.append(heading, body, media, actions);
      else card.append(heading, body, actions);
      this.commentsList.append(card);
    }
  }

  private renderParticipants(): void {
    const active = document.activeElement;
    if (active instanceof HTMLSelectElement && this.participantList.contains(active)) {
      // Rebuilding the rows would close the role picker the owner is using.
      this.participantRenderPending = true;
      return;
    }
    this.participantRenderPending = false;
    this.participantList.replaceChildren();
    const entries = [...this.presences.values()];
    const participantTotal = Math.max(1, entries.length);
    const participantLabel = `${participantTotal} ${participantTotal === 1 ? "person" : "people"} here`;
    this.participantCount.textContent = String(participantTotal);
    this.participantsButton.setAttribute("aria-label", participantLabel);
    this.participantsButton.title = participantLabel;
    for (const participant of entries) {
      const row = document.createElement("div");
      row.className = "participant-row";
      const avatar = document.createElement("span");
      avatar.className = "participant-avatar";
      avatar.textContent = initials(participant.displayName);
      const identity = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = participant.displayName;
      const detail = document.createElement("small");
      const member = this.accessMembers.find((value) => value.id === participant.id);
      const participantRole =
        participant.id === this.bootstrap.actor.id
          ? this.bootstrap.actor.role
          : (member?.role ?? participant.role ?? "participant");
      const role =
        participant.id === this.bootstrap.actor.id ? `${participantRole} · you` : participantRole;
      detail.textContent = participant.activeTool ? `${role} · ${participant.activeTool}` : role;
      identity.append(name, detail);
      const actions = document.createElement("span");
      actions.className = "participant-row-actions";
      if (
        this.bootstrap.actor.role === "owner" &&
        participant.id !== this.bootstrap.actor.id &&
        member !== undefined &&
        (member.role === "viewer" || member.role === "editor")
      ) {
        const select = document.createElement("select");
        select.setAttribute("aria-label", `Role for ${participant.displayName}`);
        select.innerHTML =
          '<option value="editor">Editor</option><option value="viewer">Viewer</option>';
        select.value = member.role;
        select.disabled = this.participantRoleChangesPending.has(member.id);
        select.addEventListener("change", () => {
          if (select.value === "viewer" || select.value === "editor") {
            void this.changeParticipantRole(member, select.value);
          }
        });
        select.addEventListener("blur", () => {
          if (this.participantRenderPending) this.renderParticipants();
        });
        actions.append(select);
      }
      const live = document.createElement("i");
      live.className = "live-dot";
      live.title = "Connected";
      actions.append(live);
      row.append(avatar, identity, actions);
      this.participantList.append(row);
    }
  }

  private expireEphemeralState(): void {
    const now = Date.now();
    if (this.followedSpotlight && now - this.followedSpotlight.updatedAt > SPOTLIGHT_STALE_MS) {
      this.clearFollowingSpotlight();
    }
    let changedPreview = false;
    for (const [key, preview] of this.remotePreviews) {
      if (now - preview.updatedAt > 3_000) {
        this.remotePreviews.delete(key);
        changedPreview = true;
      }
    }
    if (changedPreview) this.renderer.renderRemotePreviews(this.remotePreviews.values());
    let changedPresence = false;
    for (const [key, presence] of this.presences) {
      if (presence.id !== this.bootstrap.actor.id && now - presence.updatedAt > 60_000) {
        this.presences.delete(key);
        changedPresence = true;
      }
    }
    if (changedPresence) this.renderParticipants();
  }

  private clearPreviewForGesture(gestureId: string): void {
    let changed = false;
    for (const [key, preview] of this.remotePreviews) {
      if (preview.gestureId === gestureId) {
        this.remotePreviews.delete(key);
        changed = true;
      }
    }
    if (changed) this.renderer.renderRemotePreviews(this.remotePreviews.values());
  }

  private canCommit(): boolean {
    return (
      this.outboxAvailable &&
      !this.optimisticRecovery &&
      !this.archivePending &&
      this.phase === "ready" &&
      canRoleDraw(this.bootstrap.actor.role, this.bootstrap.board.drawingPolicy)
    );
  }

  private canModifyItem(item: BoardItem): boolean {
    if (lockedSectionIdForItem(item, this.model.items) !== null) return false;
    return (
      this.bootstrap.actor.role === "owner" ||
      (this.bootstrap.actor.role === "editor" && item.createdBy === this.bootstrap.actor.id)
    );
  }

  private canArchiveBoard(): boolean {
    return (
      this.bootstrap.actor.role === "owner" &&
      this.outboxAvailable &&
      !this.optimisticRecovery &&
      !this.archivePending &&
      this.expiredRecovery.length === 0 &&
      this.model.pendingCount === 0 &&
      this.phase === "ready"
    );
  }

  private enterArchivedState(): void {
    this.archivePending = false;
    this.stopBroadcastingSpotlight();
    this.clearFollowingSpotlight();
    void this.closeTextEditor(false);
    void this.closeTableCellEditor(false);
    void this.closeZoneTitleEditor(false);
    this.tools.setTool("select");
    this.remotePreviews.clear();
    this.renderer.renderRemotePreviews(this.remotePreviews.values());
    this.closeDrawers();
    this.archivedBanner.hidden = false;
    query(this.archivedBanner, "span", HTMLElement).textContent =
      this.model.pendingCount > 0 || this.expiredRecovery.length > 0
        ? "This board is permanently read only. Unsaved local edits may still be visible; export a local recovery JSON if you need them."
        : "This board is permanently read only. Existing access and invitation links can no longer open it.";
    this.root.dataset.archived = "true";
    this.liveRegion.textContent = "Board archived. This board is permanently read only.";
  }

  private updateAll(): void {
    this.setActiveToolButton(this.tools.tool);
    this.updateStyleControls();
    this.updatePermissions();
    this.updateHistoryControls();
    this.updateStatus();
    this.renderParticipants();
    this.renderComments();
    query(this.root, "[data-canvas-hint]", HTMLElement).hidden = this.model.items.size > 0;
    document.title = brandedDocumentTitle(this.bootstrap.board.title);
  }

  private updatePermissions(): void {
    const canEdit = this.canCommit();
    if (!canEdit) this.tools.cancelActiveGesture();
    const archived = this.phase === "archived";
    const roleCanBroadcast =
      this.bootstrap.actor.role === "owner" || this.bootstrap.actor.role === "editor";
    const roleCanAddActivities =
      roleCanBroadcast &&
      !archived &&
      (this.bootstrap.board.features.templates ||
        this.bootstrap.board.features.organisationTemplates);
    this.activitiesButton.hidden = !roleCanAddActivities;
    this.activitiesButton.disabled = !canEdit || this.activityInsertPending;
    for (const element of this.activitiesMenu.querySelectorAll<HTMLElement>(
      "[data-built-in-templates]",
    )) {
      element.hidden = !this.bootstrap.board.features.templates;
    }
    for (const button of this.activitiesMenu.querySelectorAll<HTMLButtonElement>(
      "[data-activity-template]",
    )) {
      const template = ACTIVITY_TEMPLATES.find(
        (candidate) => candidate.id === button.dataset.activityTemplate,
      );
      const hidden = template
        ? templateHiddenByVoting(template.id, this.bootstrap.board.features)
        : false;
      const featureIssue = template
        ? templateAvailabilityIssue(template, this.bootstrap.board.features)
        : null;
      button.hidden = hidden;
      button.disabled = !canEdit || this.activityInsertPending || featureIssue !== null;
      button.title = hidden ? "" : (featureIssue ?? "");
    }
    for (const button of this.activitiesMenu.querySelectorAll<HTMLButtonElement>(
      "[data-organisation-template]",
    )) {
      const template = this.organisationTemplates.find(
        (candidate) => candidate.id === button.dataset.organisationTemplate,
      );
      const featureIssue = template
        ? templateFeatureIssue(template.items, this.bootstrap.board.features)
        : null;
      button.disabled =
        !canEdit ||
        this.activityInsertPending ||
        !this.bootstrap.board.features.organisationTemplates ||
        featureIssue !== null;
      button.title = featureIssue ?? "";
    }
    for (const button of this.activitiesMenu.querySelectorAll<HTMLButtonElement>(
      "[data-delete-organisation-template]",
    )) {
      const templateId = button.dataset.deleteOrganisationTemplate;
      button.disabled =
        archived ||
        this.bootstrap.actor.role !== "owner" ||
        !this.bootstrap.board.features.organisationTemplates ||
        !this.organisationTemplatesCanManage ||
        (templateId !== undefined && this.organisationTemplateDeletesPending.has(templateId));
    }
    this.updateOrganisationTemplateSaveButton();
    if (
      !this.bootstrap.board.features.organisationTemplates &&
      this.organisationTemplateDialog.open
    ) {
      this.organisationTemplateDialog.close();
    }
    this.renderer.setVotingEnabled(this.bootstrap.board.features.voting);
    this.renderer.setObjectTransformsEnabled(this.bootstrap.board.features.objectTransforms);
    if (this.activitiesButton.disabled || this.activitiesButton.hidden) {
      this.closeActivitiesMenu();
    }
    if (
      (!roleCanBroadcast || archived || !this.bootstrap.board.features.spotlight) &&
      this.broadcastSpotlightId
    ) {
      this.stopBroadcastingSpotlight();
    }
    if (!this.bootstrap.board.features.spotlight && this.followedSpotlight) {
      this.clearFollowingSpotlight();
    }
    this.spotlightToggle.hidden =
      !roleCanBroadcast || archived || !this.bootstrap.board.features.spotlight;
    this.spotlightToggle.disabled = this.phase !== "ready" || archived;
    this.renderSpotlightState();
    if (!canEdit || !this.isToolEnabled(this.tools.tool)) {
      this.tools.setTool("select");
    } else if (this.landingToolPending) {
      // The first refresh runs before the socket is ready and forces select above; once
      // drawing is possible, land on the pencil so a fresh board starts ready to draw.
      this.landingToolPending = false;
      if (this.tools.tool === "select" && this.isToolEnabled("pencil")) {
        this.tools.setTool("pencil");
      }
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      const name = button.dataset.tool as ToolName;
      const enabled =
        name === "rectangle"
          ? this.isToolEnabled("line") ||
            SHAPE_CHOICES.some((choice) => this.isShapeVariantEnabled(choice.variant))
          : this.isToolEnabled(name);
      button.hidden = !enabled;
      button.disabled =
        DRAW_TOOLS.has(name) &&
        (!canEdit || !enabled || (name === "image" && this.imageUploadInFlight));
    }
    const videoButton = query(this.root, "[data-video-embed]", HTMLButtonElement);
    const videoEnabled = this.bootstrap.board.features.text;
    videoButton.hidden = !videoEnabled;
    videoButton.disabled = !canEdit || !videoEnabled;
    if (videoButton.disabled && this.videoEmbedDialog.open) this.videoEmbedDialog.close();
    this.setShapeMenuOpen(!this.shapeMenu.hidden);
    // Synchronize nested visibility before deciding whether the More trigger itself is useful.
    this.setToolsMenuOpen(!this.toolsMenu.hidden);
    const moreToolsAvailable =
      roleCanBroadcast &&
      !archived &&
      [...this.toolsMenu.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => !button.hidden,
      );
    this.moreToolsButton.hidden = !moreToolsAvailable;
    this.moreToolsButton.disabled = !canEdit;
    if (this.moreToolsButton.hidden) this.setToolsMenuOpen(false);
    window.requestAnimationFrame(() => this.updateToolRailOverflow());
    this.accessButton.hidden = false;
    this.accessButton.disabled = false;
    this.settingsButton.hidden = false;
    this.settingsButton.disabled = false;
    if (this.bootstrap.actor.role !== "owner") this.clearOwnerSettings();
    query(this.root, "[data-export-attributed-json]", HTMLButtonElement).hidden =
      !attributedDataDownloadAllowed(this.bootstrap.actor.role);
    this.titleInput.readOnly = this.bootstrap.actor.role !== "owner" || archived;
    this.titleInput.disabled = archived || this.archivePending;
    this.titleInput.classList.toggle(
      "editable",
      this.bootstrap.actor.role === "owner" && !archived,
    );
    if (archived) {
      for (const control of this.root.querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLSelectElement
      >(
        "[data-access-body] button, [data-access-body] input, [data-access-body] select, [data-settings-body] button, [data-settings-body] input, [data-settings-body] select",
      )) {
        control.disabled = true;
      }
    }
    const archiveButton =
      this.settingsBody.querySelector<HTMLButtonElement>("[data-archive-board]");
    if (archiveButton) archiveButton.disabled = !this.canArchiveBoard();
    this.renderer.svg.setAttribute("aria-readonly", String(!canEdit));
    this.tools.reconcileSelection();
    this.updateHistoryControls();
    this.updateStatus();
    this.imageInput.disabled = !this.canUploadImages();
    if (!canEdit) this.closeImageAltEditor();
    if (!canEdit) void this.closeTableCellEditor(false);
    if (!canEdit) void this.closeZoneTitleEditor(true);
    this.updateSelectionActions(this.tools.selection);
    this.renderComments();
    if (canEdit && !this.textEditor && !this.tableCellEditor) {
      this.scheduleRejectedDraftRestore();
    }
  }

  private updateHistoryControls(): void {
    this.undoButton.disabled = !this.history.canUndo || !this.canCommit();
    this.redoButton.disabled = !this.history.canRedo || !this.canCommit();
  }

  private updateStatus(): void {
    let label: string;
    let state: string;
    if (this.optimisticRecovery) {
      label = "Recovery needed";
      state = "recovery";
    } else if (this.phase === "archived") {
      label = "Board archived";
      state = "archived";
    } else if (this.phase === "reload_required") {
      label = "Reload required";
      state = "reload";
    } else if (
      !this.outboxAvailable ||
      this.phase === "stopped" ||
      !canRoleDraw(this.bootstrap.actor.role, this.bootstrap.board.drawingPolicy)
    ) {
      label = "Read only";
      state = "readonly";
    } else if (this.phase !== "ready") {
      label = "Reconnecting…";
      state = "reconnecting";
    } else if (this.activityInsertPending || this.model.pendingCount > 0) {
      label = "Saving…";
      state = "saving";
    } else {
      label = "Saved";
      state = "saved";
    }
    this.saveStatus.dataset.state = state;
    this.saveStatusText.textContent = label;
    const archiveButton =
      this.settingsBody.querySelector<HTMLButtonElement>("[data-archive-board]");
    if (archiveButton) archiveButton.disabled = !this.canArchiveBoard();
  }

  private updateStyleControls(): void {
    const sticky = this.tools.tool === "sticky";
    const stamp = this.tools.tool === "stamp";
    const line = this.tools.tool === "line";
    const text = this.tools.tool === "text";
    const pencil = this.tools.tool === "pencil";
    const eraser = this.tools.tool === "eraser";
    const activeColor = sticky
      ? this.style.stickyFill
      : stamp
        ? this.style.stampColor
        : this.style.color;
    const activeOpacity = sticky
      ? this.style.stickyOpacity
      : stamp
        ? this.style.stampOpacity
        : this.style.opacity;
    const activeFontSize = sticky ? this.style.stickyFontSize : this.style.fontSize;
    query(this.root, "[data-style-swatch]", HTMLElement).style.background = activeColor;
    query(this.root, "[data-style-width]", HTMLElement).style.height =
      `${Math.min(8, Math.max(2, this.style.width / 3))}px`;
    query(this.root, "[data-style-width]", HTMLElement).hidden = sticky || stamp;
    query(this.root, ".rail-color-dot", HTMLElement).style.background = activeColor;
    query(this.root, "[data-style-color]", HTMLInputElement).value = stamp
      ? this.style.stampColor
      : this.style.color;
    query(this.root, "[data-style-stroke]", HTMLInputElement).value = String(this.style.width);
    query(this.root, "[data-line-arrow]", HTMLInputElement).checked =
      this.style.lineArrowhead === "arrow";
    query(this.root, "[data-style-opacity]", HTMLInputElement).value = String(activeOpacity * 100);
    query(this.root, "[data-style-font]", HTMLInputElement).value = String(activeFontSize);
    query(this.root, "[data-style-font-family]", HTMLSelectElement).value = this.style.fontFamily;
    query(this.root, "[data-width-output]", HTMLOutputElement).value = String(this.style.width);
    query(this.root, "[data-opacity-output]", HTMLOutputElement).value =
      `${Math.round(activeOpacity * 100)}%`;
    query(this.root, "[data-font-output]", HTMLOutputElement).value = String(activeFontSize);
    query(this.root, "[data-color-grid]", HTMLElement).hidden = sticky;
    query(this.root, "[data-sticky-color-grid]", HTMLElement).hidden = !sticky;
    query(this.root, "[data-stamp-fieldset]", HTMLElement).hidden = !stamp;
    query(this.root, "[data-custom-color]", HTMLElement).hidden = sticky;
    query(this.root, "[data-style-stroke-row]", HTMLElement).hidden = sticky || stamp;
    query(this.root, "[data-line-arrow-row]", HTMLElement).hidden = !line;
    query(this.root, "[data-style-opacity-row]", HTMLElement).hidden = sticky;
    query(this.root, "[data-style-font-row]", HTMLElement).hidden = !text;
    query(this.root, "[data-style-font-family-row]", HTMLElement).hidden = !text;
    query(this.root, "[data-testid='quick-style-bar']", HTMLElement).hidden = !(pencil || eraser);
    query(this.root, "[data-quick-style-divider]", HTMLElement).hidden = eraser;
    query(this.root, "[data-quick-colours]", HTMLElement).hidden = eraser;
    query(this.root, "[data-style-color-label]", HTMLElement).textContent = sticky
      ? "Sticky colour"
      : stamp
        ? "Stamp colour"
        : "Colour";
    query(this.root, "[data-style-heading-context]", HTMLElement).textContent = sticky
      ? "New sticky notes"
      : stamp
        ? "New stamps"
        : line
          ? "New lines"
          : "New marks";
    query(this.root, "[data-style-trigger]", HTMLButtonElement).setAttribute(
      "aria-label",
      sticky
        ? "Open sticky note style"
        : stamp
          ? "Open stamp style"
          : line
            ? "Open line style"
            : "Open drawing style",
    );
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.color === activeColor));
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-quick-color]")) {
      button.setAttribute("aria-pressed", String(button.dataset.quickColor === this.style.color));
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-brush-preset]")) {
      const preset = button.dataset.brushPreset as BrushPreset | undefined;
      const values = preset ? BRUSH_PRESETS[preset] : undefined;
      button.setAttribute(
        "aria-pressed",
        String(
          values !== undefined &&
            this.style.width === values.width &&
            this.style.opacity === values.opacity,
        ),
      );
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-sticky-color]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.stickyColor === this.style.stickyFill),
      );
    }
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-stamp-kind]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.stampKind === this.style.stampKind),
      );
    }
  }

  private setActiveToolButton(tool: ToolName): void {
    const shapeActive =
      tool === "line" || tool === "rectangle" || tool === "polygon" || tool === "ellipse";
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      const isShapeTrigger = button.dataset.testid === "tool-rectangle";
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.tool === tool || (isShapeTrigger && shapeActive)),
      );
    }
    for (const button of this.shapeMenu.querySelectorAll<HTMLButtonElement>(
      "[data-shape-variant]",
    )) {
      button.setAttribute(
        "aria-pressed",
        String(tool !== "line" && button.dataset.shapeVariant === this.style.shapeVariant),
      );
    }
    query(this.toolsMenu, "[data-tools-tool='protractor']", HTMLButtonElement).setAttribute(
      "aria-checked",
      String(tool === "protractor"),
    );
    this.moreToolsButton.setAttribute("aria-pressed", String(MORE_TOOL_NAMES.has(tool)));
    this.updateStyleControls();
  }

  private updateSelectionActions(ids: ReadonlySet<string>): void {
    this.selectionActions.hidden = ids.size === 0;
    const label = ids.size === 1 ? "1 selected" : `${ids.size} selected`;
    this.selectionActions.setAttribute("aria-label", label);
    const canEdit = this.canCommit();
    const maxBatchItems = Math.max(
      1,
      Math.min(100, Math.floor(this.bootstrap.limits.maxBatchItems)),
    );
    const selectedIds = [...ids];
    const selectedItems = selectedIds.flatMap((id) => {
      const item = this.model.getItem(id);
      return item ? [item] : [];
    });
    const allSelectedAuthoritative =
      savedAuthoritativeItems(selectedIds, this.model.items, this.model.authoritativeItems) !==
      null;
    const allSelectedUnlocked =
      selectedItems.length === selectedIds.length &&
      selectedItems.every((item) => lockedSectionIdForItem(item, this.model.items) === null);
    const allSelectedOwned =
      selectedItems.length === selectedIds.length &&
      selectedItems.every((item) => this.canModifyItem(item));
    let enabledArrangeActions = 0;
    for (const button of this.arrangeMenu.querySelectorAll<HTMLButtonElement>("[data-arrange]")) {
      const kind = button.dataset.arrange as ArrangeKind;
      const participantIds =
        kind === "tidy-stickies"
          ? selectedIds.filter((id) => this.model.getItem(id)?.kind === "sticky")
          : selectedIds;
      const minimum = kind.startsWith("distribute-") ? 3 : 2;
      const allAuthoritative =
        savedAuthoritativeItems(participantIds, this.model.items, this.model.authoritativeItems) !==
        null;
      const allOwned = participantIds.every((id) => {
        const item = this.model.authoritativeItems.get(id);
        return item !== undefined && this.canModifyItem(item);
      });
      button.disabled =
        !canEdit ||
        participantIds.length < minimum ||
        participantIds.length > maxBatchItems ||
        !allAuthoritative ||
        !allOwned;
      if (!button.disabled) enabledArrangeActions += 1;
    }
    this.arrangeButton.hidden = ids.size < 2;
    this.arrangeButton.disabled = enabledArrangeActions === 0;
    if (this.arrangeButton.hidden || this.arrangeButton.disabled) this.setArrangeMenuOpen(false);
    const mutationReady =
      canEdit && allSelectedAuthoritative && selectedIds.length <= maxBatchItems;
    const comment = query(this.selectionActions, "[data-selection-comment]", HTMLButtonElement);
    comment.disabled = !this.canComment() || selectedIds.length !== 1 || !allSelectedAuthoritative;
    comment.title = allSelectedAuthoritative
      ? ""
      : "Wait for the selected object to finish saving.";
    this.updateAiAssistAction(selectedIds, allSelectedAuthoritative);
    const group = query(this.selectionActions, "[data-selection-group]", HTMLButtonElement);
    const ungroup = query(this.selectionActions, "[data-selection-ungroup]", HTMLButtonElement);
    const selectedGroupIds = new Set(
      selectedItems.flatMap((item) => (item.groupId ? [item.groupId] : [])),
    );
    const selectedGroupId =
      selectedGroupIds.size === 1 && selectedItems.every((item) => item.groupId)
        ? [...selectedGroupIds][0]
        : undefined;
    const completeSingleGroup =
      selectedGroupId !== undefined &&
      [...this.model.items.values()].filter((item) => item.groupId === selectedGroupId).length ===
        selectedItems.length;
    const groupingEnabled = this.bootstrap.board.features.grouping;
    group.hidden = !groupingEnabled || selectedIds.length < 2 || completeSingleGroup;
    ungroup.hidden = !groupingEnabled || !completeSingleGroup;
    group.disabled = !mutationReady || !allSelectedOwned;
    ungroup.disabled = group.disabled;
    const pendingTitle = !allSelectedAuthoritative
      ? "Wait for the selected items to finish saving."
      : !allSelectedUnlocked
        ? "This Section is locked. Unlock it before editing its contents."
        : !allSelectedOwned
          ? "You can edit only work that you created."
          : "";
    group.title = pendingTitle;
    ungroup.title = pendingTitle;

    const colourWrap = query(this.selectionActions, ".selection-colour-wrap", HTMLElement);
    const allFillItems =
      selectedItems.length === selectedIds.length &&
      selectedItems.length > 0 &&
      selectedItems.every(
        (item) => item.kind === "sticky" || item.kind === "table" || item.kind === "zone",
      );
    const allStrokeOrTextItems =
      selectedItems.length === selectedIds.length &&
      selectedItems.length > 0 &&
      selectedItems.every(
        (item) =>
          elementColour(item) !== null &&
          item.kind !== "sticky" &&
          item.kind !== "table" &&
          item.kind !== "zone",
      );
    const selectionPalette = allFillItems ? "sticky" : allStrokeOrTextItems ? "drawing" : null;
    colourWrap.hidden = selectionPalette === null;
    this.selectionColourButton.disabled =
      !mutationReady || !allSelectedOwned || selectionPalette === null;
    this.selectionColourButton.title = pendingTitle;
    if (colourWrap.hidden || this.selectionColourButton.disabled) {
      this.setSelectionColourMenuOpen(false);
    }
    const selectedColours = new Set(
      selectedItems.flatMap((item) => {
        const color = elementColour(item);
        return color ? [color] : [];
      }),
    );
    const selectedColour = selectedColours.size === 1 ? [...selectedColours][0] : undefined;
    const currentColour = query(
      this.selectionActions,
      "[data-selection-current-colour]",
      HTMLElement,
    );
    currentColour.style.background =
      selectedColour ?? "conic-gradient(#f7cf52 0 25%, #ff8c69 0 50%, #6eb6ff 0 75%, #8dd8a4 0)";
    currentColour.classList.toggle("is-mixed", selectedColour === undefined);
    for (const button of this.selectionColourMenu.querySelectorAll<HTMLButtonElement>(
      "[data-selection-colour]",
    )) {
      button.hidden = button.dataset.palette !== selectionPalette;
      button.setAttribute(
        "aria-checked",
        String(selectedColour !== undefined && button.dataset.selectionColour === selectedColour),
      );
    }
    const fontControls = query(
      this.selectionActions,
      "[data-selection-font-controls]",
      HTMLElement,
    );
    const textItems = selectedItems.filter(
      (item) => item.kind !== "sticky" && supportsTextStyling(item),
    );
    const allText =
      selectedItems.length === selectedIds.length &&
      selectedItems.length > 0 &&
      textItems.length === selectedItems.length;
    fontControls.hidden = !allText;
    const fontFamily = query(fontControls, "[data-selection-font-family]", HTMLSelectElement);
    const fontSize = query(fontControls, "[data-selection-font-size]", HTMLSelectElement);
    const formatButtons = [
      query(fontControls, "[data-selection-font-weight]", HTMLButtonElement),
      query(fontControls, "[data-selection-font-style]", HTMLButtonElement),
      query(fontControls, "[data-selection-text-decoration]", HTMLButtonElement),
    ];
    fontFamily.disabled = !mutationReady || !allSelectedOwned || !allText;
    fontSize.disabled = fontFamily.disabled;
    formatButtons.forEach((button) => {
      button.disabled = fontFamily.disabled;
    });
    const selectedFontFamilies = new Set(textItems.map((item) => item.style.fontFamily ?? "sans"));
    const selectedFontSizes = new Set(textItems.map((item) => item.style.fontSize));
    fontFamily.value = selectedFontFamilies.size === 1 ? ([...selectedFontFamilies][0] ?? "") : "";
    const selectedFontSize = selectedFontSizes.size === 1 ? [...selectedFontSizes][0] : undefined;
    fontSize.querySelector<HTMLOptionElement>("[data-current-size]")?.remove();
    if (
      selectedFontSize !== undefined &&
      !fontSize.querySelector(`option[value="${selectedFontSize}"]`)
    ) {
      const option = document.createElement("option");
      option.value = String(selectedFontSize);
      option.textContent = `${selectedFontSize}px`;
      option.dataset.currentSize = "true";
      fontSize.append(option);
    }
    fontSize.value = selectedFontSize === undefined ? "" : String(selectedFontSize);
    formatButtons[0]?.setAttribute(
      "aria-pressed",
      String(
        textItems.length > 0 && textItems.every((item) => effectiveTextFontWeight(item) === "bold"),
      ),
    );
    formatButtons[1]?.setAttribute(
      "aria-pressed",
      String(textItems.length > 0 && textItems.every((item) => item.style.fontStyle === "italic")),
    );
    formatButtons[2]?.setAttribute(
      "aria-pressed",
      String(
        textItems.length > 0 &&
          textItems.every((item) => item.style.textDecoration === "underline"),
      ),
    );
    query(this.selectionActions, "[data-selection-style-divider]", HTMLElement).hidden =
      colourWrap.hidden && fontControls.hidden;
    const alt = query(this.selectionActions, "[data-selection-alt]", HTMLButtonElement);
    const clearVotes = query(
      this.selectionActions,
      "[data-selection-clear-votes]",
      HTMLButtonElement,
    );
    const [selectedId] = ids;
    const selected = selectedId ? this.model.getItem(selectedId) : undefined;
    const sectionLock = query(
      this.selectionActions,
      "[data-selection-section-lock]",
      HTMLButtonElement,
    );
    const selectedSection = ids.size === 1 && selected?.kind === "zone" ? selected : undefined;
    const sectionLocked = selectedSection?.geometry.locked === true;
    sectionLock.hidden = this.bootstrap.actor.role !== "owner" || selectedSection === undefined;
    sectionLock.disabled = !canEdit || !allSelectedAuthoritative || selectedSection === undefined;
    sectionLock.dataset.sectionLocked = String(sectionLocked);
    sectionLock.setAttribute("aria-label", sectionLocked ? "Unlock Section" : "Lock Section");
    sectionLock.setAttribute("aria-pressed", String(sectionLocked));
    sectionLock.title = sectionLock.disabled
      ? "Wait for the Section to finish saving."
      : sectionLocked
        ? "Allow changes within this Section"
        : "Prevent everyone from changing this Section or its contents";
    alt.hidden = ids.size !== 1 || selected?.kind !== "image";
    alt.disabled =
      !canEdit || selected?.version === 0 || !selected || !this.canModifyItem(selected);
    const voteSummary =
      this.bootstrap.board.features.voting && ids.size === 1 && selected
        ? summarizeVotes(selected, this.model.items.values())
        : null;
    const authoritativeTable = selectedId
      ? this.model.authoritativeItems.get(selectedId)
      : undefined;
    const clearableVotes =
      authoritativeTable && isVoteTable(authoritativeTable)
        ? buildClearVoteDeletes(authoritativeTable, this.model.authoritativeItems.values())
        : null;
    const canClearVotes =
      this.bootstrap.board.features.voting && this.bootstrap.actor.role === "owner" && canEdit;
    clearVotes.hidden = !canClearVotes || voteSummary === null;
    clearVotes.disabled = !canClearVotes || (clearableVotes?.operations.length ?? 0) === 0;
    const voteCount = voteSummary?.stampIds.length ?? 0;
    clearVotes.textContent = voteCount > 0 ? `Clear votes (${voteCount})` : "Clear votes";
    clearVotes.setAttribute(
      "aria-label",
      voteCount > 0
        ? `Clear ${voteCount} vote${voteCount === 1 ? "" : "s"} from selected template`
        : "Clear votes from selected template",
    );
    clearVotes.title = voteSummary
      ? voteSummary.options.map((option) => `${option.label}: ${option.count}`).join(" · ")
      : "";
    this.updateOrganisationTemplateSaveButton();
  }

  private zoomBy(factor: number): void {
    const rect = this.renderer.svg.getBoundingClientRect();
    this.renderer.viewport.zoomAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      this.renderer.viewport.zoom * factor,
    );
  }

  private updateToolRailOverflow(): void {
    const shell = query(this.root, "[data-tool-rail-shell]", HTMLElement);
    const rail = query(this.root, "[data-testid='tool-rail']", HTMLElement);
    const back = query(shell, "[data-tool-rail-scroll='-1']", HTMLButtonElement);
    const forward = query(shell, "[data-tool-rail-scroll='1']", HTMLButtonElement);
    const overflow = rail.scrollWidth - rail.clientWidth > 2;
    shell.dataset.overflow = String(overflow);
    back.hidden = !overflow;
    forward.hidden = !overflow;
    if (!overflow) {
      rail.scrollLeft = 0;
      return;
    }
    const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    back.disabled = rail.scrollLeft <= 2;
    forward.disabled = rail.scrollLeft >= maxScrollLeft - 2;
  }

  private activateTool(tool: ToolName): void {
    if (tool === "rectangle") {
      const opening = this.shapeMenu.hidden !== false;
      if (opening) this.tools.setTool("select");
      this.setShapeMenuOpen(opening);
      this.setToolsMenuOpen(false);
      return;
    }
    this.setShapeMenuOpen(false);
    this.setToolsMenuOpen(false);
    if (this.tools.tool === tool) {
      this.reactivateTool(tool);
      return;
    }
    this.tools.setTool(tool);
  }

  private reactivateTool(tool: ToolName): void {
    if (tool === "line" || tool === "rectangle" || tool === "ellipse" || tool === "polygon") {
      this.setShapeMenuOpen(true);
    }
    if (tool === "stamp" || tool === "sticky") this.setStylePopoverOpen(true);
    if (tool === "image") this.openImagePicker();
    if (tool === "table") this.setTablePickerOpen(true);
  }

  private setShapeMenuOpen(open: boolean): void {
    const enabledChoices = SHAPE_CHOICES.filter((choice) =>
      this.isShapeVariantEnabled(choice.variant),
    );
    if (enabledChoices.length === 0 && !this.isToolEnabled("line")) open = false;
    this.shapeMenu.hidden = !open;
    query(this.root, "[data-testid='tool-rectangle']", HTMLButtonElement).setAttribute(
      "aria-expanded",
      String(open),
    );
    for (const button of this.shapeMenu.querySelectorAll<HTMLButtonElement>(
      "[data-shape-variant]",
    )) {
      const variant = button.dataset.shapeVariant as ShapeVariant | undefined;
      button.hidden = !variant || !this.isShapeVariantEnabled(variant);
      button.disabled = !variant || !this.isShapeVariantEnabled(variant) || !this.canCommit();
    }
    if (!open) return;
    this.setToolsMenuOpen(false);
    this.setStylePopoverOpen(false);
    this.closeActivitiesMenu();
  }

  private setToolsMenuOpen(open: boolean): void {
    const protractorEnabled = this.isToolEnabled("protractor");
    const protractor = query(this.toolsMenu, "[data-tools-tool='protractor']", HTMLButtonElement);
    protractor.hidden = !protractorEnabled;
    protractor.disabled = !protractorEnabled || !this.canCommit();
    protractor.setAttribute("aria-checked", String(this.tools.tool === "protractor"));
    const hasAvailableTool = [...this.toolsMenu.querySelectorAll<HTMLButtonElement>("button")].some(
      (button) => !button.hidden,
    );
    if (!hasAvailableTool || this.moreToolsButton.hidden) open = false;
    this.toolsMenu.hidden = !open;
    this.moreToolsButton.setAttribute("aria-expanded", String(open));
    if (!open) return;
    this.setShapeMenuOpen(false);
    this.setStylePopoverOpen(false);
    this.closeActivitiesMenu();
  }

  private isShapeVariantEnabled(variant: ShapeVariant): boolean {
    return this.bootstrap.board.features[variant];
  }

  private isToolEnabled(tool: ToolName): boolean {
    const features = this.bootstrap.board.features;
    switch (tool) {
      case "select":
      case "pan":
        return true;
      case "pencil":
        return features.pencil;
      case "line":
        return features.line;
      case "rectangle":
        return this.isShapeVariantEnabled(
          this.style.shapeVariant === "square" ? "square" : "rectangle",
        );
      case "ellipse":
        return features.circle;
      case "polygon":
        return this.isShapeVariantEnabled(
          this.style.shapeVariant === "triangle" ||
            this.style.shapeVariant === "rhombus" ||
            this.style.shapeVariant === "pentagon" ||
            this.style.shapeVariant === "hexagon"
            ? this.style.shapeVariant
            : "triangle",
        );
      case "text":
        return features.text;
      case "sticky":
        return features.stickyNotes;
      case "stamp":
        return features.stamps;
      case "image":
        return features.images && this.bootstrap.board.imagesEnabled;
      case "table":
        return features.tables;
      case "zone":
        return features.sections;
      case "protractor":
        return features.protractor;
      case "eraser":
        return features.eraser;
    }
  }

  private closeMcpActivityMenu(): void {
    this.mcpActivityMenu.hidden = true;
    this.webMcpStatus.setAttribute("aria-expanded", "false");
  }

  private setTablePickerOpen(open: boolean): void {
    if (open) {
      if (!this.tablePickerDialog.open) this.tablePickerDialog.showModal();
    } else if (this.tablePickerDialog.open) {
      this.tablePickerDialog.close();
    }
  }

  private closeActivitiesMenu(): void {
    this.activitiesMenu.hidden = true;
    this.activitiesButton.setAttribute("aria-expanded", "false");
  }

  private setArrangeMenuOpen(open: boolean): void {
    const next = open && !this.arrangeButton.disabled && !this.arrangeButton.hidden;
    this.arrangeMenu.hidden = !next;
    this.arrangeButton.setAttribute("aria-expanded", String(next));
  }

  private setAiAssistMenuOpen(open: boolean): void {
    const next = open && !this.aiAssistButton.disabled && !this.aiAssistWrap.hidden;
    this.aiAssistMenu.hidden = !next;
    this.aiAssistButton.setAttribute("aria-expanded", String(next));
  }

  /**
   * The AI button exists only while a WebMCP watch is live in this browser, because the
   * watch's pending wait is the page's only channel back to the agent. It sends only steps
   * the watch already covers, so the watch contract never widens from the board side.
   */
  private updateAiAssistAction(selectedIds: readonly string[], allSaved: boolean): void {
    const watching = this.aiWatchState.phase !== "idle";
    const watched = this.aiWatchState.watchedItemIds;
    this.aiAssistWrap.hidden = !watching;
    const unwatched = selectedIds.filter((id) => !watched.has(id));
    const ready = watching && allSaved && unwatched.length === 0 && watched.size > 0;
    this.aiAssistButton.disabled = !ready;
    this.aiAssistButton.title = !watching
      ? ""
      : unwatched.length > 0
        ? "Only steps in the current AI watch can be sent. Ask the assistant to start a new watch to include this item."
        : allSaved
          ? ""
          : "Wait for the selected object to finish saving.";
    const selectionKey = [...selectedIds].sort().join("\u0000");
    if (selectionKey !== this.aiAssistSelectionKey) {
      this.aiAssistSelectionKey = selectionKey;
      this.setAiAssistMenuOpen(false);
    }
    if (this.aiAssistWrap.hidden || this.aiAssistButton.disabled) this.setAiAssistMenuOpen(false);
  }

  /** Renders the compact MCP state and the page-session call history behind it. */
  private renderWebMcpStatus(state: WebMcpRegistryState): void {
    this.webMcpState = state;
    const { activeCallCount, calls, hostPresent, toolCount } = state;
    const activityCalls = calls.filter(isVisibleWebMcpActivityCall);
    const watching = this.aiWatchState.phase !== "idle";
    const visualState = activeCallCount > 0 ? "active" : watching ? "watch" : "ready";
    this.webMcpStatus.dataset.state = visualState;
    this.webMcpStatus.dataset.host = hostPresent ? "linked" : "unlinked";
    this.mcpActivityMenu.dataset.state = visualState;
    this.webMcpStatusText.textContent = "MCP";
    const watchStartedAt =
      watching && this.aiWatchState.expiresAt !== null
        ? this.aiWatchState.expiresAt - PROBLEM_STEP_WATCH_DURATION_MS
        : null;
    const latestActivity = activityCalls.find(
      (call) => watchStartedAt === null || call.startedAt >= watchStartedAt,
    );
    const watchMinutes =
      watching && this.aiWatchState.expiresAt !== null
        ? Math.ceil(Math.max(0, this.aiWatchState.expiresAt - Date.now()) / 60_000)
        : null;
    this.webMcpStatusTime.textContent = latestActivity
      ? new Date(latestActivity.startedAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : watchMinutes !== null
        ? `${watchMinutes} min left`
        : "Ready";

    this.mcpActivitySummary.textContent =
      activeCallCount > 0
        ? `${activeCallCount} ${activeCallCount === 1 ? "call" : "calls"} running`
        : watching
          ? `Watching board · ${toolCount} site ${toolCount === 1 ? "tool" : "tools"}`
          : hostPresent
            ? `${toolCount} site ${toolCount === 1 ? "tool" : "tools"} ready`
            : "Waiting for an MCP-capable browser";
    this.mcpActivityEmpty.hidden = activityCalls.length > 0;
    this.mcpActivityEmpty.textContent =
      calls.length > 0
        ? "Watch activity is hidden for this session."
        : "No MCP calls in this tab yet.";
    this.mcpActivityList.replaceChildren(
      ...activityCalls.map((call) => {
        const row = document.createElement("li");
        row.className = "mcp-activity-row";
        row.dataset.state = call.status;

        const marker = document.createElement("span");
        marker.className = "mcp-call-marker";
        marker.setAttribute("aria-hidden", "true");

        const details = document.createElement("span");
        details.className = "mcp-call-details";
        const name = document.createElement("strong");
        name.textContent = call.toolName;
        const meta = document.createElement("small");
        const statusLabel =
          call.status === "active"
            ? "Running"
            : call.status === "succeeded"
              ? "Completed"
              : "Failed";
        const started = new Date(call.startedAt);
        const timeLabel = started.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        });
        const duration =
          call.completedAt === null
            ? "now"
            : (() => {
                const elapsed = Math.max(0, call.completedAt - call.startedAt);
                return elapsed < 1_000
                  ? `${elapsed} ms`
                  : `${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 1 : 0)} s`;
              })();
        meta.textContent = `${statusLabel} · ${timeLabel} · ${duration}`;
        details.append(name, meta);
        row.append(marker, details);
        return row;
      }),
    );

    const stateDescription =
      visualState === "active"
        ? `${activeCallCount} MCP ${activeCallCount === 1 ? "call is" : "calls are"} active.`
        : visualState === "watch"
          ? "MCP is watching this board."
          : "MCP is ready.";
    const connectionDescription = hostPresent
      ? `${toolCount} site ${toolCount === 1 ? "tool is" : "tools are"} available.`
      : "No MCP host is linked to this browser.";
    const callDescription =
      activityCalls.length === 0
        ? "No calls in this tab yet."
        : `${activityCalls.length} ${activityCalls.length === 1 ? "call" : "calls"} in this tab.`;
    const description = `${stateDescription} ${connectionDescription} ${callDescription} Click to view activity.`;
    this.webMcpStatus.title = description;
    this.webMcpStatus.setAttribute("aria-label", description);
  }

  private setAiShareMenuOpen(open: boolean): void {
    const next = open && !this.aiShareButton.hidden;
    this.aiShareMenu.hidden = !next;
    this.aiShareButton.setAttribute("aria-expanded", String(next));
  }

  /**
   * Hands the whole board to the assistant already watching this browser. The page cannot widen
   * a running watch by itself, so this selects every saved object and asks the host to re-scope
   * its watch to that selection, carrying the task the participant picked.
   */
  private shareBoardWithAi(action: AssistAction): void {
    const itemIds = [...this.model.items.keys()].filter((itemId) =>
      this.model.authoritativeItems.has(itemId),
    );
    if (itemIds.length === 0) {
      this.notify("Add something to the board before sharing it.", "info");
      return;
    }
    const note = this.aiShareNote.value.trim();
    try {
      this.tools.setTool("select");
      this.tools.selectOnly(itemIds);
      const receipt = this.webMcp?.shareEntireBoard({
        action,
        ...(note.length > 0 ? { note } : {}),
        itemCount: itemIds.length,
      });
      if (!receipt) throw new Error("The AI assistant is not available in this browser.");
      this.setAiShareMenuOpen(false);
      this.aiShareNote.value = "";
      this.aiShareButton.focus();
      const label = assistActionLabel(action);
      this.notify(
        receipt.delivered
          ? `Shared all ${itemIds.length} objects with the AI assistant: ${label}.`
          : `Queued the whole board for the AI assistant: ${label}. It will see it on its next check.`,
        "info",
      );
    } catch (error) {
      this.notify(
        error instanceof Error ? error.message : "The board could not be shared.",
        "warning",
      );
    }
  }

  private setAiWatchState(state: WatchState): void {
    this.aiWatchState = state;
    this.renderWebMcpStatus(this.webMcpState);
    const watching = state.phase !== "idle";
    this.aiShareButton.hidden = !watching;
    if (!watching) this.setAiShareMenuOpen(false);
    if (this.webMcpWatchCountdown !== null) {
      window.clearInterval(this.webMcpWatchCountdown);
      this.webMcpWatchCountdown = null;
    }
    if (watching) {
      this.webMcpWatchCountdown = window.setInterval(
        () => this.renderWebMcpStatus(this.webMcpState),
        30_000,
      );
    }
    this.updateSelectionActions(this.tools.selection);
  }

  private sendAiAssistRequest(action: AssistAction): void {
    const label = assistActionLabel(action);
    const note = this.aiAssistNote.value.trim();
    try {
      const receipt = this.webMcp?.requestAssistance({
        itemIds: [...this.tools.selection],
        action,
        ...(note.length > 0 ? { note } : {}),
      });
      if (!receipt) throw new Error("The AI assistant is not available in this browser.");
      this.setAiAssistMenuOpen(false);
      this.aiAssistNote.value = "";
      this.aiAssistButton.focus();
      const steps = `${receipt.stepAliases.length} step${receipt.stepAliases.length === 1 ? "" : "s"}`;
      this.notify(
        receipt.delivered
          ? `Sent to the AI assistant: ${label} (${steps}).`
          : `Queued for the AI assistant: ${label} (${steps}). It will see it on its next check.`,
        "info",
      );
    } catch (error) {
      this.notify(
        error instanceof Error
          ? error.message
          : "The request could not be sent to the AI assistant.",
        "warning",
      );
    }
  }

  /** The comment tool's write path: same three steps as the composer, tagged as AI-written. */
  private async commentFromWebMcp(
    itemId: string,
    body: string,
    assistance: Assistance,
    media?: CommentMedia,
  ): Promise<void> {
    if (!this.model.getItem(itemId)) throw new Error("That step is no longer on the board.");
    if (!this.canComment()) throw new Error("This browser cannot comment on this Space.");
    const comment = await this.api.createComment(
      this.bootstrap.board.id,
      itemId,
      body,
      assistance,
      media,
    );
    this.comments.upsert(comment);
    this.applyCommentChange();
    this.liveRegion.textContent = media ? "AI comment with media added." : "AI comment added.";
  }

  private setSelectionColourMenuOpen(open: boolean): void {
    const next = open && !this.selectionColourButton.disabled && !this.selectionColourButton.hidden;
    this.selectionColourMenu.hidden = !next;
    this.selectionColourButton.setAttribute("aria-expanded", String(next));
  }

  private togglePopover(popover: HTMLElement, trigger: HTMLButtonElement): void {
    const open = popover.hidden;
    this.setStylePopoverOpen(false);
    if (popover !== this.mcpActivityMenu) this.closeMcpActivityMenu();
    if (popover !== this.activitiesMenu) this.closeActivitiesMenu();
    popover.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  }

  private setStylePopoverOpen(open: boolean): void {
    this.stylePopover.hidden = !open;
    query(this.root, "[data-style-trigger]", HTMLButtonElement).setAttribute(
      "aria-expanded",
      String(open),
    );
    query(this.root, "[data-open-style]", HTMLButtonElement).setAttribute(
      "aria-expanded",
      String(open),
    );
    query(this.root, "[data-open-style]", HTMLButtonElement).setAttribute(
      "aria-pressed",
      String(open),
    );
    if (!open) return;
    this.closeMcpActivityMenu();
    this.setShapeMenuOpen(false);
    this.setToolsMenuOpen(false);
    this.closeActivitiesMenu();
  }

  private toggleDrawer(drawer: HTMLElement, trigger: HTMLButtonElement): void {
    const open = drawer.hidden;
    this.closeDrawers();
    drawer.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  }

  private closeDrawers(): void {
    if (this.playingCommentVideoId !== null) {
      // A hidden drawer must not keep playing, and the player cannot survive the next rebuild.
      this.playingCommentVideoId = null;
      clearTypesetMath(this.commentsList);
      this.commentsList.replaceChildren();
      this.commentsRenderPending = true;
    }
    this.commentsDrawer.hidden = true;
    this.participantDrawer.hidden = true;
    this.accessDrawer.hidden = true;
    this.settingsDrawer.hidden = true;
    this.commentsButton.setAttribute("aria-expanded", "false");
    query(this.root, "[data-testid='participants-button']", HTMLButtonElement).setAttribute(
      "aria-expanded",
      "false",
    );
    this.accessButton.setAttribute("aria-expanded", "false");
    this.settingsButton.setAttribute("aria-expanded", "false");
  }
  private clearOwnerSettings(): void {
    this.accessBody.replaceChildren();
    this.organisationWebhookSettings = null;
    this.organisationWebhookIdempotencyKey = null;
    this.settingsBody.removeAttribute("aria-busy");
    this.settingsBody.replaceChildren();
  }

  private downloadLocalJson(): void {
    const data = {
      ...this.model.toSnapshot(this.bootstrap.board.id),
      unsavedCommands: [
        ...this.expiredRecovery.map((entry) => entry.command),
        ...this.model.pendingCommands,
      ],
      recoveryOnly: true,
    };
    downloadBlob(
      `${safeFilename(this.bootstrap.board.title)}-recovery.json`,
      "application/json",
      JSON.stringify(data, null, 2),
    );
    if (this.expiredRecovery.length > 0) {
      const commandIds = this.expiredRecovery.map((entry) => entry.commandId);
      void this.outbox
        .removeMany(this.bootstrap.board.id, this.bootstrap.actor.id, commandIds)
        .then(() => {
          this.expiredRecovery = [];
          this.syncRecoveryBanner();
        })
        .catch(() => {
          this.notify("The downloaded recovery entries could not be cleared locally.", "warning");
        });
    }
  }

  private async downloadAttributedJson(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const data = await this.api.attributedDataExport(this.bootstrap.board.id);
      downloadBlob(
        attributedDataFilename(this.bootstrap.board.title),
        "application/json",
        serializeAttributedData(data),
      );
      this.notify("Attributed data JSON downloaded.");
    } catch (error) {
      this.apiError(error);
    } finally {
      button.disabled = false;
    }
  }

  /**
   * Gives one text editor a maths keyboard. Typing an opening delimiter closes the pair and brings
   * up MathLive's field over the editor, so a participant can build a formula without knowing TeX;
   * the board still stores ordinary delimited TeX, which is what everything else here reads.
   */
  private bindMathField(
    editor: HTMLTextAreaElement | HTMLInputElement,
    finish: (save: boolean) => void,
    onValueChanged: () => void = () => undefined,
  ): void {
    const sync = (): void => this.syncMathField(editor, finish, onValueChanged);
    editor.addEventListener("input", () => {
      this.closeMathDelimiter(editor, onValueChanged);
      sync();
    });
    // The caret can move without the value changing, and that moves in and out of a formula.
    editor.addEventListener("keyup", sync);
    editor.addEventListener("click", sync);
    sync();
  }

  /** Completes a delimiter pair the participant just opened, leaving the caret between the two. */
  private closeMathDelimiter(
    editor: HTMLTextAreaElement | HTMLInputElement,
    onValueChanged: () => void,
  ): void {
    const caret = editor.selectionStart ?? editor.value.length;
    const opening = unclosedOpeningAt(editor.value, caret);
    if (!opening) return;
    editor.value = `${editor.value.slice(0, caret)}${opening.close}${editor.value.slice(caret)}`;
    editor.setSelectionRange(caret, caret);
    onValueChanged();
  }

  private syncMathField(
    editor: HTMLTextAreaElement | HTMLInputElement,
    finish: (save: boolean) => void,
    onValueChanged: () => void,
  ): void {
    const panel = this.mathFieldPanel;
    if (!panel) return;
    const caret = editor.selectionStart ?? editor.value.length;
    const region = mathRegionAtCaret(editor.value, caret);
    if (!region) {
      this.mathFieldTarget = null;
      panel.close();
      return;
    }
    this.mathFieldTarget = { editor, region, onValueChanged, finish };
    void panel.open(
      `${region.delimiter.open}@${region.start}`,
      region,
      editor.value.slice(region.start, region.end),
      editor.getBoundingClientRect(),
    );
  }

  /** Writes the maths field's TeX back into the formula it was opened on. */
  private readonly applyMathField = (tex: string): void => {
    const target = this.mathFieldTarget;
    if (!target) return;
    const next = replaceMathRegion(target.editor.value, target.region, tex);
    target.editor.value = next.value;
    target.region = next.region;
    const caret = next.region.end + next.region.delimiter.close.length;
    target.editor.setSelectionRange(caret, caret);
    target.onValueChanged();
  };

  /** Returns the participant to the text once the formula is written. */
  private readonly finishMathField = (): void => {
    const target = this.mathFieldTarget;
    this.mathFieldPanel?.close();
    this.mathFieldTarget = null;
    target?.editor.focus();
  };

  /**
   * Takes the maths field down with the editor it belongs to. An editor can close without focus
   * ever reaching the panel, when a participant opens a formula and then clicks straight past it,
   * and the panel would otherwise stay on screen writing into an editor that is already gone.
   */
  private dismissMathField(editor: HTMLTextAreaElement | HTMLInputElement): void {
    if (this.mathFieldTarget?.editor !== editor) return;
    this.mathFieldTarget = null;
    this.mathFieldPanel?.close();
  }

  /**
   * Focus left the maths field for something that is not the text it belongs to. The text editor
   * declined to save when focus came to the field, so the edit is finished here instead; without
   * it the editor would stay open and unsaved, and the next click on the canvas would discard it.
   */
  private readonly leaveMathField = (next: Node | null): void => {
    const target = this.mathFieldTarget;
    if (!target) return;
    if (next !== null && (next === target.editor || target.editor.contains(next))) return;
    this.mathFieldPanel?.close();
    this.mathFieldTarget = null;
    target.finish(true);
  };

  private async downloadLocalSvg(): Promise<void> {
    const snapshot = this.model.toSnapshot(this.bootstrap.board.id);
    // A downloaded picture should hold the formulas the board shows, not their source.
    const svg = localSvg(
      snapshot,
      this.bootstrap.board.title,
      await mathExportOptions(snapshot.items),
    );
    downloadBlob(`${safeFilename(this.bootstrap.board.title)}-local.svg`, "image/svg+xml", svg);
  }

  private notify(message: string, kind: "info" | "warning" | "error" = "info"): void {
    const toast = document.createElement("div");
    toast.className = `toast toast-${kind}`;
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    toast.textContent = message;
    this.toastRegion.append(toast);
    window.setTimeout(() => {
      toast.classList.add("leaving");
      window.setTimeout(() => toast.remove(), 220);
    }, 4_500);
  }

  private apiError(error: unknown): void {
    if (error instanceof ApiError) {
      if (error.status === 409) {
        this.notify("Access changed in another tab. Refreshing these controls…", "warning");
        void this.resync("Refreshing current board access.");
      } else {
        this.notify(error.message, "error");
      }
      return;
    }
    this.notify("The request could not be completed.", "error");
  }
}

export function boardIdFromPath(pathname = window.location.pathname): string | null {
  const match = pathname.match(/^\/(?:embed\/)?b\/([^/]+)\/?$/u);
  if (!match?.[1]) return null;
  try {
    const boardId = decodeURIComponent(match[1]);
    return /^b_[A-Za-z0-9_-]{8,}$/.test(boardId) ? boardId : null;
  } catch {
    return null;
  }
}

export async function confirmRecoveryClaim(
  root: HTMLElement,
  claim: FragmentClaim,
): Promise<boolean> {
  if (claim.type !== "recovery") return true;
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog";
    dialog.dataset.testid = "recovery-confirmation";
    dialog.innerHTML = `
      <span class="dialog-mark" aria-hidden="true">↻</span>
      <h1>Recover board ownership?</h1>
      <p>This will make this device the owner and demote the current owner. Continue only if you intended to use this recovery link.</p>
      <div class="dialog-actions"><button type="button" data-cancel>Cancel</button><button class="primary-button" type="button" data-confirm>Recover ownership</button></div>
    `;
    root.replaceChildren(dialog);
    query(dialog, "[data-cancel]", HTMLButtonElement).addEventListener("click", () => {
      dialog.close();
      resolve(false);
    });
    query(dialog, "[data-confirm]", HTMLButtonElement).addEventListener("click", () => {
      dialog.close();
      resolve(true);
    });
    dialog.addEventListener("cancel", () => resolve(false), { once: true });
    dialog.showModal();
  });
}

export async function requestClaimVerification(
  root: HTMLElement,
  turnstile: { enabled: boolean; required: boolean; siteKey: string | null },
  claimType: FragmentClaim["type"],
): Promise<string | undefined> {
  if (!turnstile.enabled || !turnstile.required) return undefined;
  if (!turnstile.siteKey) {
    throw new ApiError(
      "TEMPORARILY_UNAVAILABLE",
      "Browser verification is temporarily unavailable.",
      503,
    );
  }
  return requestTurnstileToken(
    root,
    turnstile.siteKey,
    claimType === "invite" ? "invitation_claim" : "recovery_claim",
  );
}

export async function withAdaptiveTurnstile<T>(
  root: HTMLElement,
  turnstile: { enabled: boolean; required: boolean; siteKey: string | null },
  action: TurnstileAction,
  operation: (token: string | undefined) => Promise<T>,
): Promise<T> {
  let required = turnstile.enabled && turnstile.required;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = required
      ? await requestTurnstileTokenForAction(root, turnstile.siteKey, action)
      : undefined;
    try {
      return await operation(token);
    } catch (error) {
      if (
        attempt === 0 &&
        !required &&
        turnstile.enabled &&
        error instanceof ApiError &&
        error.code === "TURNSTILE_REQUIRED"
      ) {
        required = true;
        turnstile.required = true;
        continue;
      }
      throw error;
    }
  }
  throw new ApiError("TURNSTILE_FAILED", "Browser verification failed.", 403);
}

export async function acknowledgeRecoveredOwnership(
  root: HTMLElement,
  boardId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const token = stringValue(result.ownerRecoveryToken) ?? stringValue(result.token);
  if (!token) return;
  const recoveryUrl = `${location.origin}/b/${encodeURIComponent(boardId)}#recovery=${encodeURIComponent(token)}`;
  await new Promise<void>((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog created-dialog";
    dialog.dataset.testid = "new-recovery-link";
    dialog.innerHTML = `
      <span class="dialog-mark" aria-hidden="true">✓</span>
      <h1>Ownership recovered</h1>
      <p>Your old recovery link is now invalid. Save this replacement somewhere private before opening the board.</p>
      <div class="secret-copy"><span></span><button type="button" data-copy>Copy</button></div>
      <button class="primary-button" type="button" data-continue>Continue to board</button>
    `;
    query(dialog, ".secret-copy span", HTMLElement).textContent = recoveryUrl;
    query(dialog, "[data-copy]", HTMLButtonElement).addEventListener("click", async (event) => {
      try {
        await navigator.clipboard.writeText(recoveryUrl);
        (event.currentTarget as HTMLButtonElement).textContent = "Copied";
      } catch {
        (event.currentTarget as HTMLButtonElement).textContent = "Select link";
      }
    });
    query(dialog, "[data-continue]", HTMLButtonElement).addEventListener("click", () => {
      dialog.close();
      resolve();
    });
    root.replaceChildren(dialog);
    dialog.showModal();
  });
}

export function renderLanding(root: HTMLElement, api: ApiClient): void {
  document.title = brandedDocumentTitle();
  const suggestedBoardName = randomBoardName();
  root.innerHTML = `
    <main class="landing" data-testid="landing-page">
      <div class="landing-glow" aria-hidden="true"></div>
      <header>
        <a class="wordmark landing-wordmark" href="/" aria-label="${PRODUCT_HOME_LABEL}">${BRAND_MARK_HTML}<span>${PRODUCT_NAME}</span></a>
        <span class="landing-badge landing-webmcp-badge"><span aria-hidden="true"></span>WebMCP enabled</span>
      </header>
      <section class="landing-copy">
        <div class="landing-hero-mark" aria-hidden="true">${BRAND_MARK_HTML}</div>
        <span class="eyebrow">A shared canvas for classrooms</span>
        <h1>Learn together,<br /><em>with AI.</em></h1>
        <p>Turn lessons, problems, and group thinking into a live visual workspace. Sketch, explain, organise, and invite AI to help without losing the human conversation.</p>
      </section>
      <form class="create-card" data-create-form>
        <div><span class="card-step">Start a learning board</span><h2>What will you explore?</h2></div>
        <label><span class="sr-only">Board title</span><input name="title" maxlength="100" value="${suggestedBoardName}" required autocomplete="off" /></label>
        <button class="primary-button" type="submit">Open a fresh canvas <span aria-hidden="true">→</span></button>
        <small>No account required · automatic saving · WebMCP-ready</small>
      </form>
      <footer><span>Built for educators, learners & study groups</span><span>People and AI, thinking on one canvas</span></footer>
    </main>
  `;
  const form = query(root, "[data-create-form]", HTMLFormElement);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = query(form, "button[type='submit']", HTMLButtonElement);
    button.disabled = true;
    button.textContent = "Creating your board…";
    const formData = new FormData(form);
    const title = String(formData.get("title") ?? "").trim();
    try {
      const result = await withAdaptiveTurnstile(root, api.turnstile, "board_create", (token) =>
        api.createBoard(title, token),
      );
      showCreatedBoard(root, result.board.url, result.ownerRecoveryUrl);
    } catch (error) {
      button.disabled = false;
      button.textContent = "Open a fresh canvas →";
      const message = error instanceof ApiError ? error.message : "The board could not be created.";
      showInlineError(form, message);
    }
  });
}

export function renderFatal(root: HTMLElement, title: string, message: string, retry = true): void {
  document.title = brandedDocumentTitle(title);
  root.innerHTML = `
    <main class="fatal-screen" data-testid="fatal-screen">
      ${BRAND_MARK_HTML}
      <span class="eyebrow">${PRODUCT_NAME}</span>
      <h1></h1><p></p>
      <div><a class="primary-button" href="/">Start a new board</a>${retry ? '<button type="button" data-retry>Try again</button>' : ""}</div>
    </main>
  `;
  query(root, "h1", HTMLElement).textContent = title;
  query(root, "p", HTMLElement).textContent = message;
  root
    .querySelector<HTMLButtonElement>("[data-retry]")
    ?.addEventListener("click", () => location.reload());
}

function showCreatedBoard(root: HTMLElement, boardUrl: string, recoveryUrl: string): void {
  const dialog = document.createElement("dialog");
  dialog.className = "claim-dialog created-dialog";
  dialog.innerHTML = `
    <span class="dialog-mark" aria-hidden="true">✓</span>
    <h1>Your canvas is ready</h1>
    <p>Save this owner recovery link somewhere private. It is the only way back in if this browser loses its owner session.</p>
    <div class="secret-copy"><span></span><button type="button">Copy</button></div>
    <a class="primary-button" href="">Continue to board</a>
  `;
  query(dialog, ".secret-copy span", HTMLElement).textContent = recoveryUrl;
  query(dialog, ".primary-button", HTMLAnchorElement).href = boardUrl;
  query(dialog, ".secret-copy button", HTMLButtonElement).addEventListener(
    "click",
    async (event) => {
      try {
        await navigator.clipboard.writeText(recoveryUrl);
        (event.currentTarget as HTMLButtonElement).textContent = "Copied";
      } catch {
        (event.currentTarget as HTMLButtonElement).textContent = "Select link";
      }
    },
  );
  root.replaceChildren(dialog);
  dialog.showModal();
}

type TurnstileAction = "board_create" | "invitation_claim" | "recovery_claim";

type TurnstileClient = {
  ready(callback: () => void): void;
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: TurnstileAction;
      execution: "render";
      appearance: "interaction-only";
      callback(token: string): void;
      "error-callback"(code?: string): void;
      "expired-callback"(): void;
    },
  ): string;
  remove(widgetId: string): void;
};

let turnstileClientPromise: Promise<TurnstileClient> | null = null;

async function requestTurnstileTokenForAction(
  root: HTMLElement,
  sessionSiteKey: string | null,
  action: TurnstileAction,
): Promise<string> {
  const key =
    sessionSiteKey ??
    import.meta.env.VITE_TURNSTILE_SITE_KEY ??
    document.querySelector<HTMLMetaElement>('meta[name="turnstile-site-key"]')?.content;
  if (!key) {
    throw new ApiError(
      "TEMPORARILY_UNAVAILABLE",
      "Browser verification is temporarily unavailable.",
      503,
    );
  }
  return requestTurnstileToken(root, key, action);
}

async function requestTurnstileToken(
  root: HTMLElement,
  siteKey: string,
  action: TurnstileAction,
): Promise<string> {
  const container = document.createElement("div");
  container.className = "turnstile-challenge";
  container.dataset.testid = "turnstile-challenge";
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  container.setAttribute("aria-label", "Checking browser security");
  root.append(container);

  let client: TurnstileClient;
  try {
    client = await loadTurnstileClient();
  } catch (error) {
    container.remove();
    throw error;
  }
  let widgetId: string | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (result: { token: string } | { error: ApiError }): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if ("token" in result) resolve(result.token);
        else reject(result.error);
      };
      const timeout = window.setTimeout(
        () =>
          finish({
            error: new ApiError(
              "TEMPORARILY_UNAVAILABLE",
              "Browser verification timed out. Try again.",
              503,
            ),
          }),
        20_000,
      );
      try {
        widgetId = client.render(container, {
          sitekey: siteKey,
          action,
          execution: "render",
          appearance: "interaction-only",
          callback: (token) => {
            if (token.length > 0) finish({ token });
            else
              finish({
                error: new ApiError("TURNSTILE_FAILED", "Browser verification failed.", 403),
              });
          },
          "error-callback": () =>
            finish({
              error: new ApiError("TURNSTILE_FAILED", "Browser verification failed.", 403),
            }),
          "expired-callback": () =>
            finish({
              error: new ApiError("TURNSTILE_FAILED", "Browser verification expired.", 403),
            }),
        });
      } catch {
        finish({
          error: new ApiError(
            "TEMPORARILY_UNAVAILABLE",
            "Browser verification is temporarily unavailable.",
            503,
          ),
        });
      }
    });
  } finally {
    if (widgetId !== undefined) client.remove(widgetId);
    container.remove();
  }
}

function loadTurnstileClient(): Promise<TurnstileClient> {
  const current = (window as Window & { turnstile?: TurnstileClient }).turnstile;
  if (current !== undefined) return turnstileWhenReady(current);
  if (turnstileClientPromise !== null) return turnstileClientPromise;

  const loading = new Promise<TurnstileClient>((resolve, reject) => {
    let settled = false;
    const finish = (client?: TurnstileClient): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (client === undefined) {
        reject(
          new ApiError(
            "TEMPORARILY_UNAVAILABLE",
            "Browser verification is temporarily unavailable.",
            503,
          ),
        );
        return;
      }
      void turnstileWhenReady(client).then(resolve, reject);
    };
    const timeout = window.setTimeout(() => finish(), 15_000);
    const existing = document.querySelector<HTMLScriptElement>("script[data-turnstile-script]");
    const script = existing ?? document.createElement("script");
    script.addEventListener(
      "load",
      () => finish((window as Window & { turnstile?: TurnstileClient }).turnstile),
      { once: true },
    );
    script.addEventListener("error", () => finish(), { once: true });
    if (existing === null) {
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.turnstileScript = "true";
      document.head.append(script);
    }
  });
  turnstileClientPromise = loading;
  void loading.catch(() => {
    if (turnstileClientPromise === loading) turnstileClientPromise = null;
  });
  return loading;
}

function turnstileWhenReady(client: TurnstileClient): Promise<TurnstileClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: number | undefined;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (ready) {
        resolve(client);
        return;
      }
      reject(
        new ApiError(
          "TEMPORARILY_UNAVAILABLE",
          "Browser verification is temporarily unavailable.",
          503,
        ),
      );
    };
    timeout = window.setTimeout(() => finish(false), 15_000);
    try {
      client.ready(() => finish(true));
    } catch {
      finish(false);
    }
  });
}

export function localSvg(
  snapshot: BoardSnapshot,
  title: string,
  options: SvgItemOptions = {},
): string {
  const items = [...snapshot.items]
    .map((item) => normalizeBoardItem(item))
    .sort((a, b) => a.z - b.z);
  const bounds = boundsForSvgItems(items);
  const pad = 32;
  const viewBox = bounds
    ? `${bounds.minX - pad} ${bounds.minY - pad} ${Math.max(1, bounds.maxX - bounds.minX + pad * 2)} ${Math.max(1, bounds.maxY - bounds.minY + pad * 2)}`
    : "0 0 1200 800";
  const content = items.map((item) => renderSvgItem(item, options)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${escapeXml(title)}"><metadata>{&quot;format&quot;:&quot;cf-whiteboard-json&quot;,&quot;seq&quot;:${snapshot.seq}}</metadata><rect x="-1000000" y="-1000000" width="2000000" height="2000000" fill="#ffffff"/>${content}</svg>`;
}

export function attributedDataFilename(boardTitle: string): string {
  return `${safeFilename(boardTitle)}-attributed-data.json`;
}

export function attributedDataDownloadAllowed(role: Role): boolean {
  return role === "owner";
}

export function serializeAttributedData(data: AttributedDataExport): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function clampStickyText(value: string): string {
  return [...value].slice(0, MAX_STICKY_TEXT_CODE_POINTS).join("");
}

function tableCellLocalBounds(
  geometry: TableGeometry,
  row: number,
  column: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const width = geometry.columnWidths[column];
  const height = geometry.rowHeights[row];
  if (width === undefined || height === undefined) return null;
  const x =
    geometry.x + geometry.columnWidths.slice(0, column).reduce((sum, value) => sum + value, 0);
  const y = geometry.y + geometry.rowHeights.slice(0, row).reduce((sum, value) => sum + value, 0);
  return { minX: x, minY: y, maxX: x + width, maxY: y + height };
}

function transformPoint(point: Point, matrix: Matrix): Point {
  return [
    matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
  ];
}

function stickyDraftFromOperation(operation: DurableOperation): StickyDraftRecovery | undefined {
  if (operation.kind === "item.create" && operation.item.kind === "sticky") {
    const { geometry } = operation.item;
    return {
      draftItemId: createId(),
      point: [geometry.x, geometry.y],
      text: geometry.text,
      selectionStart: geometry.text.length,
      selectionEnd: geometry.text.length,
    };
  }
  if (operation.kind !== "item.update") return undefined;
  const geometry = operation.patch.geometry;
  if (!geometry || !("width" in geometry) || !("text" in geometry)) return undefined;
  return {
    itemId: operation.itemId,
    draftItemId: createId(),
    point: [geometry.x, geometry.y],
    text: geometry.text,
    selectionStart: geometry.text.length,
    selectionEnd: geometry.text.length,
  };
}

export function tableCellDraftFromOperation(
  operation: DurableOperation,
  authoritativeItems: ReadonlyMap<string, BoardItem>,
): TableCellDraftRecovery | undefined {
  if (operation.kind !== "item.update") return undefined;
  const geometry = operation.patch.geometry;
  const current = authoritativeItems.get(operation.itemId);
  if (!geometry || !("cells" in geometry) || current?.kind !== "table") return undefined;
  if (
    !numberArraysEqual(geometry.columnWidths, current.geometry.columnWidths) ||
    !numberArraysEqual(geometry.rowHeights, current.geometry.rowHeights)
  ) {
    return undefined;
  }
  const changed: Array<{ row: number; column: number; text: string }> = [];
  geometry.cells.forEach((row, rowIndex) => {
    row.forEach((text, columnIndex) => {
      if (text !== current.geometry.cells[rowIndex]?.[columnIndex]) {
        changed.push({ row: rowIndex, column: columnIndex, text });
      }
    });
  });
  const cell = changed.length === 1 ? changed[0] : undefined;
  if (!cell) return undefined;
  return {
    itemId: operation.itemId,
    row: cell.row,
    column: cell.column,
    text: cell.text,
    selectionStart: cell.text.length,
    selectionEnd: cell.text.length,
  };
}

export function zoneTitleDraftFromOperation(
  operation: DurableOperation,
  authoritativeItems: ReadonlyMap<string, BoardItem>,
): ZoneTitleDraftRecovery | undefined {
  if (operation.kind !== "item.update") return undefined;
  const geometry = operation.patch.geometry;
  const current = authoritativeItems.get(operation.itemId);
  if (!geometry || !("title" in geometry) || current?.kind !== "zone") return undefined;
  if (
    geometry.title === current.geometry.title ||
    geometry.width !== current.geometry.width ||
    geometry.height !== current.geometry.height
  ) {
    return undefined;
  }
  return {
    itemId: operation.itemId,
    title: geometry.title,
    selectionStart: geometry.title.length,
    selectionEnd: geometry.title.length,
  };
}

function numberArraysEqual(first: readonly number[], second: readonly number[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function arrangeSuccessMessage(kind: ArrangeKind): string {
  switch (kind) {
    case "align-left":
      return "Selection aligned left.";
    case "align-top":
      return "Selection aligned to the top.";
    case "align-horizontal-center":
      return "Selection centered horizontally.";
    case "distribute-horizontal":
      return "Selection spaced horizontally.";
    case "distribute-vertical":
      return "Selection spaced vertically.";
    case "tidy-stickies":
      return "Selected stickies tidied into a grid.";
  }
}

function downloadBlob(filename: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function loadingBlock(message: string): HTMLElement {
  const block = document.createElement("div");
  block.className = "drawer-loading";
  block.setAttribute("role", "status");
  block.textContent = message;
  return block;
}

function errorBlock(message: string): HTMLElement {
  const block = document.createElement("p");
  block.className = "drawer-error";
  block.textContent = message;
  return block;
}

function showInlineError(container: HTMLElement, message: string): void {
  container.querySelector(".inline-error")?.remove();
  const error = document.createElement("p");
  error.className = "inline-error";
  error.setAttribute("role", "alert");
  error.textContent = message;
  container.append(error);
}

function query<T extends Element>(
  container: ParentNode,
  selector: string,
  elementType: { new (): T },
): T {
  const element = container.querySelector(selector);
  if (!(element instanceof elementType))
    throw new Error(`Required UI element not found: ${selector}`);
  return element;
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => [...part][0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function managedInvitationStorageKey(boardId: string): string {
  return `spacescale:managed-invitations:${boardId}`;
}

function loadManagedInvitations(boardId: string): ManagedInvitation[] {
  try {
    const serialized = window.sessionStorage.getItem(managedInvitationStorageKey(boardId));
    if (serialized === null) return [];
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) return [];
    return value.flatMap(parseManagedInvitation).slice(0, 50);
  } catch {
    return [];
  }
}

function saveManagedInvitations(boardId: string, invitations: ManagedInvitation[]): void {
  try {
    if (invitations.length === 0) {
      window.sessionStorage.removeItem(managedInvitationStorageKey(boardId));
      return;
    }
    window.sessionStorage.setItem(
      managedInvitationStorageKey(boardId),
      JSON.stringify(invitations.slice(0, 50)),
    );
  } catch {
    // Invitation IDs are only a convenience for this browser session.
  }
}

function parseManagedInvitation(value: unknown): ManagedInvitation[] {
  if (!isRecord(value)) return [];
  if (
    typeof value.id !== "string" ||
    !/^i_[A-Za-z0-9_-]{16,78}$/u.test(value.id) ||
    (value.role !== "viewer" && value.role !== "editor" && value.role !== "owner") ||
    (value.label !== null && typeof value.label !== "string") ||
    !Number.isSafeInteger(value.maxUses) ||
    (value.maxUses as number) < 1 ||
    (value.maxUses as number) > 50 ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    return [];
  }
  return [
    {
      id: value.id,
      role: value.role,
      label: value.label,
      maxUses: value.maxUses as number,
      expiresAt: value.expiresAt as number,
    },
  ];
}

export function objectCommentVisible(
  state: BoardComment["state"],
  showHiddenComments: boolean,
): boolean {
  return showHiddenComments || state === "open";
}

/** How a comment names the service a video it carries comes from. */
function videoProviderLabel(provider: "youtube" | "vimeo"): string {
  return provider === "vimeo" ? "Vimeo" : "YouTube";
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function commentObjectLabel(item: BoardItem): string {
  switch (item.kind) {
    case "sticky":
      return "sticky note";
    case "text":
      return "text object";
    case "image":
      return "image";
    case "table":
      return "table";
    case "zone":
      return "section";
    case "pencil":
      return "drawing";
    default:
      return `${item.kind} object`;
  }
}

function formatCommentTime(value: number): string {
  return formatDateTime(value);
}

function snapshotKindLabel(kind: RecoverySnapshot["kind"]): string {
  if (kind === "pre_clear") return "Before board clear";
  if (kind === "automatic") return "Automatic recovery point";
  return "Named recovery point";
}

function formatDateTime(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return "unknown time";
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${Math.round(value / 1_024)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstImageFile(transfer: DataTransfer | null): File | null {
  if (!transfer) return null;
  for (const file of Array.from(transfer.files)) {
    if (file.type.startsWith("image/")) return file;
  }
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

function dataTransferHasImage(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  return (
    Array.from(transfer.files).some((file) => file.type.startsWith("image/")) ||
    Array.from(transfer.items).some(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    )
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type GlobalShortcut =
  | "close-tools-menu"
  | "close-shape-menu"
  | "stop-following-spotlight"
  | "undo"
  | "redo";

/**
 * Maps a window keydown to a board-wide shortcut. Escape closes transient UI
 * even while a field is focused; every other shortcut stays out of inputs.
 */
export function globalShortcutFor(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey">,
  state: {
    editing: boolean;
    toolsMenuOpen: boolean;
    shapeMenuOpen: boolean;
    followingSpotlight: boolean;
  },
): GlobalShortcut | null {
  if (event.key === "Escape") {
    if (state.toolsMenuOpen) return "close-tools-menu";
    if (state.shapeMenuOpen) return "close-shape-menu";
    if (state.followingSpotlight) return "stop-following-spotlight";
    return null;
  }
  if (state.editing || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.metaKey) return "redo";
  return null;
}

/** Mirrors the server gate: commenting needs a live Space and drawing rights. */
/** Mirrors the server rule: only the comment's author or a board owner may resolve it. */
export function canResolveComment(
  comment: Pick<BoardComment, "author">,
  actorId: string,
  role: Role,
): boolean {
  return role === "owner" || comment.author.id === actorId;
}

export function canActorComment(
  phase: ConnectionPhase,
  role: Role,
  drawingPolicy: DrawingPolicy,
): boolean {
  return (
    phase !== "archived" &&
    phase !== "reload_required" &&
    phase !== "stopped" &&
    canRoleComment(role, drawingPolicy)
  );
}

/**
 * Derives the states shown for server comment snapshots: an open comment whose
 * object is missing locally shows as orphaned, and flips back to open when the
 * object returns (for example after a rejected optimistic delete).
 */
export function deriveCommentStates(
  comments: Iterable<BoardComment>,
  hasItem: (itemId: string) => boolean,
): BoardComment[] {
  const derived: BoardComment[] = [];
  for (const comment of comments) {
    derived.push(
      comment.state === "open" && !hasItem(comment.itemId)
        ? { ...comment, state: "orphaned" }
        : comment,
    );
  }
  return derived;
}

/**
 * Holds the server's comment snapshots and the item-aware copies the UI shows.
 * Every local write supersedes in-flight loads so an older response cannot
 * overwrite fresher state.
 */
export class CommentStore {
  private version = 0;
  private latestLoad = 0;
  private readonly server = new Map<string, BoardComment>();
  private displayed: readonly BoardComment[] = [];

  constructor(private readonly hasItem: (itemId: string) => boolean) {}

  get comments(): readonly BoardComment[] {
    return this.displayed;
  }

  beginLoad(): number {
    this.version += 1;
    this.latestLoad = this.version;
    return this.version;
  }

  /** Whether no newer load has started since this token was issued. */
  isLatestLoad(token: number): boolean {
    return token === this.latestLoad;
  }

  /** Adopts a loaded snapshot unless it was superseded. Returns whether shown states changed. */
  completeLoad(token: number, comments: readonly BoardComment[]): boolean {
    if (token !== this.version) return false;
    this.server.clear();
    for (const comment of comments) this.server.set(comment.id, comment);
    return this.reconcile();
  }

  /** Stores a comment the server just returned for a local write. */
  upsert(comment: BoardComment): void {
    this.version += 1;
    this.server.set(comment.id, comment);
    this.reconcile();
  }

  /** Re-derives shown states from item presence. Returns whether anything changed. */
  reconcile(): boolean {
    const next = deriveCommentStates(this.server.values(), this.hasItem);
    const changed =
      next.length !== this.displayed.length ||
      next.some((comment, index) => {
        const previous = this.displayed[index];
        return (
          previous === undefined ||
          previous.id !== comment.id ||
          previous.state !== comment.state ||
          previous.updatedAt !== comment.updatedAt
        );
      });
    if (changed) this.displayed = next;
    return changed;
  }
}

/**
 * Tracks tool-initiated commits until the server answers them. A commit that
 * receives no answer in time is withdrawn so the reported failure is truthful;
 * one that can no longer be withdrawn was already acknowledged.
 */
export class PendingCommitTracker {
  private readonly pending = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; resolve: (accepted: boolean) => void }
  >();

  constructor(private readonly timeoutMs = 30_000) {}

  track(
    commandId: string,
    resolve: (accepted: boolean) => void,
    withdraw: (commandId: string) => boolean,
  ): void {
    const timer = setTimeout(() => {
      if (!this.pending.has(commandId)) return;
      this.finish(commandId, !withdraw(commandId));
    }, this.timeoutMs);
    this.pending.set(commandId, { timer, resolve });
  }

  finish(commandId: string, accepted: boolean): void {
    const entry = this.pending.get(commandId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.resolve(accepted);
  }

  finishAll(accepted: boolean): void {
    for (const commandId of [...this.pending.keys()]) this.finish(commandId, accepted);
  }
}

function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    // MathLive's field is a custom element, and a key pressed inside it is retargeted to the host.
    // Without it here, undo, redo and Delete would reach the board while a formula is being typed.
    target.closest(
      "input, textarea, select, math-field, [contenteditable]:not([contenteditable='false'])",
    ) !== null
  );
}

function safeFilename(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "whiteboard"
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

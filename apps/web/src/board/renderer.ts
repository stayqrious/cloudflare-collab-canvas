import {
  lineArrowheadPoints,
  type OutlineGeometry,
  polygonPoints,
  textLayoutEstimateSource,
  transformPoint,
  visibleOutlinePaths,
  ZONE_TITLE_PADDING,
  zoneTitleBandHeight,
} from "@collab/geometry";
import { resolveTextFontWeight, textFontStack } from "@collab/protocol";
import { STAMP_SVG_PATHS } from "@collab/svg-export";
import { summarizeBoardVotes, type VoteSummary } from "../activities/voting";
import { clearTypesetMath, containsMathMarkup, splitMathMarkup, typesetMath } from "../mathjax";
import {
  isRotatableObjectItem,
  isScalableObjectItem,
  objectLocalBounds,
  objectLocalCenter,
  objectScaleCorner,
  type RotatableObjectItem,
  type ScalableObjectItem,
} from "../tools/transform";
import type {
  BoardComment,
  BoardItem,
  BoxGeometry,
  ImageGeometry,
  ImageStyle,
  LineGeometry,
  LineStyle,
  Matrix,
  Point,
  PolygonGeometry,
  Presence,
  ProtractorGeometry,
  ProtractorStyle,
  RemotePreview,
  SpotlightViewState,
  StampGeometry,
  StampKind,
  StampStyle,
  StickyGeometry,
  StickyStyle,
  StrokeStyle,
  TableGeometry,
  TableItem,
  TableStyle,
  TextGeometry,
  TextStyle,
  ToolName,
  ZoneGeometry,
  ZoneStyle,
} from "../types";
import {
  tokenizeSafeLinks,
  VIDEO_EMBED_HEIGHT,
  VIDEO_EMBED_WIDTH,
  type VideoEmbed,
  videoEmbedFromText,
} from "./links";
import { type BoardModel, type Bounds, itemBounds as boardItemBounds } from "./model";

const SVG_NS = "http://www.w3.org/2000/svg";
export type ImageAssetLoader = (assetId: string) => Promise<Blob>;

export const STICKY_PADDING = 14;
export const STICKY_CORNER_RADIUS = 12;
export const STICKY_LINE_HEIGHT = 1.2;
export const STICKY_CHARACTER_WIDTH = 0.56;
export const TABLE_CELL_PADDING = 8;
export const TABLE_LINE_HEIGHT = 1.2;
export const TABLE_CHARACTER_WIDTH = 0.56;
export const RESIZE_HANDLE_RADIUS_CSS_PX = 6;
export const RESIZE_HANDLE_HIT_RADIUS_CSS_PX = 22;
export const ROTATE_HANDLE_OFFSET_CSS_PX = 30;
const MAX_MATH_TEXT_WIDTH = 720;

type ResizableCardItem = Extract<BoardItem, { kind: "sticky" | "image" }>;
export type ResizableStructuredItem = Extract<BoardItem, { kind: "table" | "zone" }>;
type ResizableItem = ResizableCardItem | ResizableStructuredItem;
type AttributedItem = Extract<BoardItem, { kind: "sticky" | "image" | "stamp" }>;
export type CreatorNameResolver = (actorId: string) => string | undefined;
export type RenderedTextBoundsChangeHandler = (itemId: string, expectedVersion: number) => void;

export function selectionResizeHandle(
  item: ResizableItem,
  zoom: number,
  translated: { x: number; y: number } = { x: 0, y: 0 },
): SVGGElement {
  const [localX, localY] = itemResizeCorner(item);
  const point = transformedPoint(item, [localX, localY], translated);
  const safeZoom = Math.max(0.1, zoom);
  const group = svgElement("g");
  group.classList.add("selection-resize-handle");
  group.dataset.resizeHandle = "southeast";
  group.dataset.itemId = item.id;
  group.setAttribute("aria-hidden", "true");

  const hitTarget = svgElement("circle");
  hitTarget.classList.add("selection-resize-hit-target");
  hitTarget.setAttribute("cx", String(point[0]));
  hitTarget.setAttribute("cy", String(point[1]));
  hitTarget.setAttribute("r", String(RESIZE_HANDLE_HIT_RADIUS_CSS_PX / safeZoom));

  const knob = svgElement("circle");
  knob.classList.add("selection-resize-knob");
  knob.setAttribute("cx", String(point[0]));
  knob.setAttribute("cy", String(point[1]));
  knob.setAttribute("r", String(RESIZE_HANDLE_RADIUS_CSS_PX / safeZoom));
  group.append(hitTarget, knob);
  return group;
}

export function selectionResizeHandles(
  item: ResizableItem,
  zoom: number,
  translated: { x: number; y: number } = { x: 0, y: 0 },
): SVGGElement[] {
  const handles = item.kind === "table" ? tableDimensionResizeHandles(item, zoom, translated) : [];
  handles.push(selectionResizeHandle(item, zoom, translated));
  return handles;
}

export function selectionProtractorRotateHandle(
  item: Extract<BoardItem, { kind: "protractor" }>,
  zoom: number,
): SVGGElement {
  return selectionObjectRotateHandle(item, zoom);
}

export function selectionObjectScaleHandle(
  item: ScalableObjectItem,
  zoom: number,
  translated: { x: number; y: number } = { x: 0, y: 0 },
): SVGGElement {
  const point = transformPoint(objectScaleCorner(item), item.transform);
  return selectionTransformKnob(
    "scale",
    item.id,
    [point[0] + translated.x, point[1] + translated.y],
    zoom,
  );
}

export function selectionObjectRotateHandle(
  item: RotatableObjectItem,
  zoom: number,
  translated: { x: number; y: number } = { x: 0, y: 0 },
): SVGGElement {
  const safeZoom = Math.max(0.1, zoom);
  const bounds = objectLocalBounds(item);
  const center = transformPoint(objectLocalCenter(item), item.transform);
  const top = transformPoint([(bounds.minX + bounds.maxX) / 2, bounds.minY], item.transform);
  const distance = Math.hypot(top[0] - center[0], top[1] - center[1]);
  const direction: Point =
    distance > 1e-9 ? [(top[0] - center[0]) / distance, (top[1] - center[1]) / distance] : [0, -1];
  const point: Point = [
    top[0] + direction[0] * (ROTATE_HANDLE_OFFSET_CSS_PX / safeZoom) + translated.x,
    top[1] + direction[1] * (ROTATE_HANDLE_OFFSET_CSS_PX / safeZoom) + translated.y,
  ];
  return selectionTransformKnob(
    "rotate",
    item.id,
    point,
    zoom,
    item.kind === "protractor" ? "protractor" : "object",
  );
}

function selectionTransformKnob(
  kind: "scale" | "rotate",
  itemId: string,
  point: Point,
  zoom: number,
  handleValue?: string,
): SVGGElement {
  const safeZoom = Math.max(0.1, zoom);
  const group = svgElement("g");
  group.classList.add(`selection-${kind}-handle`);
  if (kind === "scale") group.dataset.scaleHandle = "southeast";
  else group.dataset.rotateHandle = handleValue ?? "object";
  group.dataset.itemId = itemId;
  group.setAttribute("aria-hidden", "true");
  const hitTarget = svgElement("circle");
  hitTarget.classList.add(`selection-${kind}-hit-target`);
  hitTarget.setAttribute("cx", String(point[0]));
  hitTarget.setAttribute("cy", String(point[1]));
  hitTarget.setAttribute("r", String(RESIZE_HANDLE_HIT_RADIUS_CSS_PX / safeZoom));
  const knob = svgElement("circle");
  knob.classList.add(`selection-${kind}-knob`);
  knob.setAttribute("cx", String(point[0]));
  knob.setAttribute("cy", String(point[1]));
  knob.setAttribute("r", String(RESIZE_HANDLE_RADIUS_CSS_PX / safeZoom));
  group.append(hitTarget, knob);
  return group;
}

export function tableDimensionResizeHandles(
  item: Extract<BoardItem, { kind: "table" }>,
  zoom: number,
  translated: { x: number; y: number } = { x: 0, y: 0 },
): SVGGElement[] {
  const handles: SVGGElement[] = [];
  const geometry = item.geometry;
  let x = geometry.x;
  geometry.columnWidths.forEach((columnWidth, index) => {
    x += columnWidth;
    const nextWidth = geometry.columnWidths[index + 1] ?? columnWidth;
    handles.push(
      selectionAxisResizeHandle(
        item,
        "table-column",
        index,
        [x, geometry.y],
        zoom,
        translated,
        Math.min(columnWidth, nextWidth),
      ),
    );
  });
  let y = geometry.y;
  geometry.rowHeights.forEach((rowHeight, index) => {
    y += rowHeight;
    const nextHeight = geometry.rowHeights[index + 1] ?? rowHeight;
    handles.push(
      selectionAxisResizeHandle(
        item,
        "table-row",
        index,
        [geometry.x, y],
        zoom,
        translated,
        Math.min(rowHeight, nextHeight),
      ),
    );
  });
  return handles;
}

function selectionAxisResizeHandle(
  item: Extract<BoardItem, { kind: "table" }>,
  kind: "table-column" | "table-row",
  index: number,
  localBoundary: Point,
  zoom: number,
  translated: { x: number; y: number },
  availableAxisSize: number,
): SVGGElement {
  const safeZoom = Math.max(0.1, zoom);
  const hitRadiusCssPx = Math.max(
    2,
    Math.min(RESIZE_HANDLE_HIT_RADIUS_CSS_PX, (availableAxisSize * safeZoom - 4) / 2),
  );
  const outsideOffset = (hitRadiusCssPx + 4) / safeZoom;
  const halfGuide = Math.min(10, hitRadiusCssPx * 0.7) / safeZoom;
  const localCenter: Point =
    kind === "table-column"
      ? [localBoundary[0], localBoundary[1] - outsideOffset]
      : [localBoundary[0] - outsideOffset, localBoundary[1]];
  const localGuideStart: Point =
    kind === "table-column"
      ? [localCenter[0], localCenter[1] - halfGuide]
      : [localCenter[0] - halfGuide, localCenter[1]];
  const localGuideEnd: Point =
    kind === "table-column"
      ? [localCenter[0], localCenter[1] + halfGuide]
      : [localCenter[0] + halfGuide, localCenter[1]];
  const center = transformedPoint(item, localCenter, translated);
  const guideStart = transformedPoint(item, localGuideStart, translated);
  const guideEnd = transformedPoint(item, localGuideEnd, translated);
  const group = svgElement("g");
  group.classList.add("selection-resize-handle", "selection-axis-resize-handle");
  group.dataset.resizeHandle = kind;
  group.dataset.resizeIndex = String(index);
  group.dataset.itemId = item.id;
  group.setAttribute("aria-hidden", "true");

  const hitTarget = svgElement("circle");
  hitTarget.classList.add("selection-axis-resize-hit-target");
  hitTarget.setAttribute("cx", String(center[0]));
  hitTarget.setAttribute("cy", String(center[1]));
  hitTarget.setAttribute("r", String(hitRadiusCssPx / safeZoom));

  const guide = svgElement("line");
  guide.classList.add("selection-axis-resize-guide");
  guide.setAttribute("x1", String(guideStart[0]));
  guide.setAttribute("y1", String(guideStart[1]));
  guide.setAttribute("x2", String(guideEnd[0]));
  guide.setAttribute("y2", String(guideEnd[1]));
  guide.setAttribute("stroke-width", String(1.5 / safeZoom));
  group.append(hitTarget, guide);
  return group;
}

function itemResizeCorner(item: ResizableItem): Point {
  if (item.kind === "table") {
    return [
      item.geometry.x + item.geometry.columnWidths.reduce((total, value) => total + value, 0),
      item.geometry.y + item.geometry.rowHeights.reduce((total, value) => total + value, 0),
    ];
  }
  return [item.geometry.x + item.geometry.width, item.geometry.y + item.geometry.height];
}

function transformedPoint(
  item: Pick<BoardItem, "transform">,
  point: Point,
  translated: { x: number; y: number },
): Point {
  return [
    item.transform[0] * point[0] + item.transform[2] * point[1] + item.transform[4] + translated.x,
    item.transform[1] * point[0] + item.transform[3] * point[1] + item.transform[5] + translated.y,
  ];
}

export class BoardRenderer {
  readonly svg: SVGSVGElement;
  readonly viewport: CanvasViewport;

  private readonly drawingArea: SVGGElement;
  private readonly commentLayer: SVGGElement;
  private readonly voteCountLayer: SVGGElement;
  private readonly remoteLayer: SVGGElement;
  private readonly localLayer: SVGGElement;
  private readonly selectionLayer: SVGGElement;
  private readonly cursorLayer: SVGGElement;
  private readonly itemNodes = new Map<string, SVGGraphicsElement>();
  private readonly imageAssets: ImageAssetCache;
  private selectedIds = new Set<string>();
  private resizeHandlesEnabled = true;
  private objectTransformsEnabled = true;
  private votingEnabled = true;
  private comments: readonly BoardComment[] = [];
  private commentRefreshFrame: number | null = null;

  constructor(
    container: HTMLElement,
    private readonly model: BoardModel,
    loadImageAsset: ImageAssetLoader,
    private readonly resolveCreatorName: CreatorNameResolver = () => undefined,
    private readonly onRenderedTextBoundsChange: RenderedTextBoundsChangeHandler = () => undefined,
  ) {
    this.imageAssets = new ImageAssetCache(loadImageAsset);
    this.svg = svgElement("svg");
    this.svg.id = "board-canvas";
    this.svg.classList.add("board-canvas");
    this.svg.tabIndex = 0;
    this.svg.setAttribute("role", "application");
    this.svg.setAttribute("aria-label", "Collaborative drawing canvas");
    this.svg.setAttribute("aria-describedby", "canvas-help");

    const defs = svgElement("defs");
    const pattern = svgElement("pattern");
    pattern.id = "dot-grid";
    pattern.setAttribute("width", "24");
    pattern.setAttribute("height", "24");
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    const dot = svgElement("circle");
    dot.setAttribute("cx", "1");
    dot.setAttribute("cy", "1");
    dot.setAttribute("r", "0.85");
    dot.setAttribute("fill", "#c7c7c7");
    pattern.append(dot);
    defs.append(pattern);

    const background = svgElement("rect");
    background.classList.add("canvas-background");
    background.setAttribute("x", "-1000000");
    background.setAttribute("y", "-1000000");
    background.setAttribute("width", "2000000");
    background.setAttribute("height", "2000000");
    background.setAttribute("fill", "url(#dot-grid)");
    background.setAttribute("pointer-events", "none");

    this.drawingArea = layer("drawing-area", "Authoritative board content");
    this.voteCountLayer = layer("vote-count-layer", "Live voting counts");
    this.commentLayer = layer("comment-layer", "Open object comments");
    this.voteCountLayer.setAttribute("pointer-events", "none");
    this.remoteLayer = layer("remote-preview-layer", "Collaborator previews");
    this.localLayer = layer("local-preview-layer", "Your current gesture");
    this.selectionLayer = layer("selection-layer", "Current selection");
    this.cursorLayer = layer("cursor-layer", "Collaborator cursors");
    this.svg.append(
      defs,
      background,
      this.drawingArea,
      this.voteCountLayer,
      this.commentLayer,
      this.remoteLayer,
      this.localLayer,
      this.selectionLayer,
      this.cursorLayer,
    );
    container.append(this.svg);

    this.viewport = new CanvasViewport(this.svg);
    this.model.subscribe((ids) => this.render(ids));
    this.render(null);
  }

  destroy(): void {
    this.cancelCommentRefresh();
    this.imageAssets.destroy();
    this.viewport.destroy();
    clearTypesetMath(this.svg);
    this.svg.remove();
  }

  setCursor(tool: ToolName, temporaryPan = false): void {
    this.svg.dataset.tool = temporaryPan ? "pan" : tool;
  }

  setResizeHandlesEnabled(enabled: boolean): void {
    this.resizeHandlesEnabled = enabled;
  }

  setObjectTransformsEnabled(enabled: boolean): void {
    if (this.objectTransformsEnabled === enabled) return;
    this.objectTransformsEnabled = enabled;
    this.refreshSelection();
  }

  setVotingEnabled(enabled: boolean): void {
    if (this.votingEnabled === enabled) return;
    this.votingEnabled = enabled;
    this.renderVoteCounts();
  }

  /** Comments are immutable snapshots, so the array is kept as given. */
  setComments(comments: readonly BoardComment[]): void {
    this.comments = comments;
    this.renderCommentMarkers();
  }

  /** Coalesces marker repositioning (for example zoom changes) into one frame. */
  refreshComments(): void {
    if (this.commentRefreshFrame !== null) return;
    this.commentRefreshFrame = requestAnimationFrame(() => {
      this.commentRefreshFrame = null;
      this.renderCommentMarkers();
    });
  }

  private cancelCommentRefresh(): void {
    if (this.commentRefreshFrame === null) return;
    cancelAnimationFrame(this.commentRefreshFrame);
    this.commentRefreshFrame = null;
  }

  setSelection(ids: Iterable<string>, translated?: { x: number; y: number }): void {
    this.selectedIds = new Set(ids);
    const bounds = this.model.boundsFor(this.selectedIds);
    if (!bounds) {
      this.selectionLayer.replaceChildren();
      return;
    }
    const x = translated?.x ?? 0;
    const y = translated?.y ?? 0;
    const selectedItems = [...this.selectedIds].flatMap((id) => {
      const item = this.model.getItem(id);
      return item ? [item] : [];
    });
    const selected = selectedItems.length === 1 ? selectedItems[0] : undefined;
    const selectedSection =
      selected?.sectionId === undefined ? undefined : this.model.getItem(selected.sectionId);
    const selectedLocked =
      selected !== undefined &&
      (selected.kind === "zone" && selected.geometry.locked === true
        ? true
        : selectedSection?.kind === "zone" && selectedSection.geometry.locked === true);
    const resizeHandles =
      selected &&
      !selectedLocked &&
      this.resizeHandlesEnabled &&
      selected.version > 0 &&
      (selected.kind === "sticky" ||
        selected.kind === "table" ||
        selected.kind === "zone" ||
        (selected.kind === "image" && !this.objectTransformsEnabled))
        ? selectionResizeHandles(selected, this.viewport.zoom, { x, y })
        : [];
    const transformHandles =
      selected &&
      !selectedLocked &&
      this.resizeHandlesEnabled &&
      this.objectTransformsEnabled &&
      selected.version > 0
        ? [
            ...(isScalableObjectItem(selected)
              ? [selectionObjectScaleHandle(selected, this.viewport.zoom, { x, y })]
              : []),
            ...(isRotatableObjectItem(selected)
              ? [selectionObjectRotateHandle(selected, this.viewport.zoom, { x, y })]
              : []),
          ]
        : [];
    const handles = [...resizeHandles, ...transformHandles];
    this.renderSelectionBounds(
      {
        minX: bounds.minX + x,
        minY: bounds.minY + y,
        maxX: bounds.maxX + x,
        maxY: bounds.maxY + y,
      },
      handles,
    );
  }

  refreshSelection(): void {
    this.setSelection(this.selectedIds);
  }

  refreshCreatorAttribution(actorIds?: Iterable<string>): void {
    if (actorIds === undefined) {
      this.render(null);
      return;
    }
    const changedActors = new Set(actorIds);
    if (changedActors.size === 0) return;
    const itemIds = new Set(
      [...this.model.items.values()]
        .filter((item) => changedActors.has(item.createdBy))
        .map((item) => item.id),
    );
    if (itemIds.size > 0) this.render(itemIds);
  }

  private renderSelectionBounds(bounds: Bounds, handles: readonly SVGGElement[] = []): void {
    this.selectionLayer.replaceChildren();
    const outline = svgElement("rect");
    outline.classList.add("selection-outline");
    outline.setAttribute("x", String(bounds.minX));
    outline.setAttribute("y", String(bounds.minY));
    outline.setAttribute("width", String(Math.max(1, bounds.maxX - bounds.minX)));
    outline.setAttribute("height", String(Math.max(1, bounds.maxY - bounds.minY)));
    outline.setAttribute("rx", "3");
    this.selectionLayer.append(outline);
    this.selectionLayer.append(...handles);
  }

  showMarquee(bounds: Bounds | null): void {
    this.selectionLayer.replaceChildren();
    if (!bounds) {
      this.setSelection(this.selectedIds);
      return;
    }
    const marquee = svgElement("rect");
    marquee.classList.add("selection-marquee");
    marquee.setAttribute("x", String(bounds.minX));
    marquee.setAttribute("y", String(bounds.minY));
    marquee.setAttribute("width", String(bounds.maxX - bounds.minX));
    marquee.setAttribute("height", String(bounds.maxY - bounds.minY));
    this.selectionLayer.append(marquee);
  }

  showLocalPencil(points: readonly Point[], style: StrokeStyle): void {
    this.clearLocalLayer();
    if (points.length === 0) return;
    const path = svgElement("path");
    path.classList.add("local-preview");
    setStroke(path, style);
    path.setAttribute("d", pencilPath(points));
    this.localLayer.append(path);
  }

  showLocalShape(
    kind: "line" | "rectangle" | "ellipse" | "polygon",
    geometry: LineGeometry | BoxGeometry | PolygonGeometry,
    style: LineStyle | StrokeStyle,
    snapPoints: readonly Point[] = [],
  ): void {
    this.clearLocalLayer();
    const preview = shapeNode(kind, geometry, style);
    preview.classList.add("local-preview");
    this.localLayer.append(preview, ...snapPoints.map((point) => this.snapHalo(point)));
  }

  private snapHalo(point: Point): SVGCircleElement {
    const halo = svgElement("circle");
    halo.classList.add("connector-snap-halo");
    halo.setAttribute("cx", String(point[0]));
    halo.setAttribute("cy", String(point[1]));
    halo.setAttribute("r", String(8 / this.viewport.zoom));
    halo.setAttribute("fill", "none");
    halo.setAttribute("stroke", "currentColor");
    halo.setAttribute("stroke-width", String(2 / this.viewport.zoom));
    halo.setAttribute("pointer-events", "none");
    halo.setAttribute("aria-hidden", "true");
    return halo;
  }

  showLocalText(
    point: Point,
    value: string,
    style: Pick<TextStyle, "color" | "fontSize" | "fontFamily" | "opacity">,
    transform: Matrix = [1, 0, 0, 1, 0, 0],
  ): void {
    this.clearLocalLayer();
    if (!value) return;
    const text = svgElement("text");
    text.classList.add("local-preview", "text-preview");
    text.setAttribute("x", String(point[0]));
    text.setAttribute("y", String(point[1]));
    text.setAttribute("fill", style.color);
    text.setAttribute("fill-opacity", String(style.opacity));
    text.setAttribute("font-size", String(style.fontSize));
    text.setAttribute("font-family", textFontStack(style.fontFamily));
    text.setAttribute("transform", matrixAttribute(transform));
    value.split("\n").forEach((line, index) => {
      const span = svgElement("tspan");
      span.setAttribute("x", String(point[0]));
      if (index > 0) span.setAttribute("dy", "1.2em");
      span.textContent = line || " ";
      text.append(span);
    });
    this.localLayer.append(text);
  }

  showLocalSticky(
    geometry: StickyGeometry,
    style: StickyStyle,
    transform: Matrix = [1, 0, 0, 1, 0, 0],
  ): void {
    this.clearLocalLayer();
    const sticky = stickyNode(geometry, style, true);
    sticky.classList.add("local-preview", "sticky-preview");
    sticky.setAttribute("transform", matrixAttribute(transform));
    this.localLayer.append(sticky);
  }

  showLocalZone(
    geometry: ZoneGeometry,
    style: ZoneStyle,
    transform: Matrix = [1, 0, 0, 1, 0, 0],
  ): void {
    this.clearLocalLayer();
    const zone = zoneNode("local-zone-preview", geometry, style, true);
    zone.classList.add("local-preview", "zone-preview");
    zone.setAttribute("aria-hidden", "true");
    zone.setAttribute("transform", matrixAttribute(transform));
    this.localLayer.append(zone);
  }

  showMovePreview(ids: readonly string[], x: number, y: number, snapPoint?: Point): void {
    this.clearLocalLayer();
    for (const id of ids) {
      const item = this.model.getItem(id);
      if (!item) continue;
      const node = itemNode(item, (assetId) => this.imageAssets.load(assetId), {
        preview: true,
      });
      node.classList.add("local-preview", "move-preview");
      node.setAttribute(
        "transform",
        matrixAttribute([
          item.transform[0],
          item.transform[1],
          item.transform[2],
          item.transform[3],
          item.transform[4] + x,
          item.transform[5] + y,
        ]),
      );
      this.localLayer.append(node);
    }
    if (snapPoint) this.localLayer.append(this.snapHalo(snapPoint));
    this.setSelection(ids, { x, y });
  }

  showRotationPreview(item: RotatableObjectItem, transform: Matrix): void {
    this.showObjectTransformPreview(item, transform, "rotation-preview");
  }

  showObjectScalePreview(item: ScalableObjectItem, transform: Matrix): void {
    this.showObjectTransformPreview(item, transform, "scale-preview");
  }

  private showObjectTransformPreview(
    item: RotatableObjectItem,
    transform: Matrix,
    className: "rotation-preview" | "scale-preview",
  ): void {
    this.clearLocalLayer();
    const preview = { ...item, transform } as RotatableObjectItem;
    const node = itemNode(preview, (assetId) => this.imageAssets.load(assetId), {
      preview: true,
    });
    node.classList.add("local-preview", className);
    this.localLayer.append(node);
    this.renderSelectionBounds(boardItemBounds(preview), [
      ...(isScalableObjectItem(preview)
        ? [selectionObjectScaleHandle(preview, this.viewport.zoom)]
        : []),
      selectionObjectRotateHandle(preview, this.viewport.zoom),
    ]);
  }

  showCardResizePreview(item: ResizableCardItem, geometry: StickyGeometry | ImageGeometry): void {
    this.clearLocalLayer();
    const preview = { ...item, geometry } as ResizableCardItem;
    const renderItem = {
      ...preview,
      id: `${item.id}-resize-preview`,
    } as ResizableCardItem;
    const node = itemNode(renderItem, (assetId) => this.imageAssets.load(assetId), {
      preview: true,
    });
    node.classList.add("local-preview", "resize-preview");
    this.localLayer.append(node);
    this.renderSelectionBounds(
      boardItemBounds(preview),
      selectionResizeHandles(preview, this.viewport.zoom),
    );
  }

  showStructuredResizePreview(
    item: ResizableStructuredItem,
    geometry: TableGeometry | ZoneGeometry,
  ): void {
    this.clearLocalLayer();
    const preview = { ...item, geometry } as ResizableStructuredItem;
    const renderItem = {
      ...preview,
      id: `${item.id}-resize-preview`,
    } as ResizableStructuredItem;
    const node = itemNode(renderItem, (assetId) => this.imageAssets.load(assetId), {
      preview: true,
    });
    node.classList.add("local-preview", "resize-preview");
    this.localLayer.append(node);
    this.renderSelectionBounds(
      boardItemBounds(preview),
      selectionResizeHandles(preview, this.viewport.zoom),
    );
  }

  highlightForErase(ids: Iterable<string>): void {
    const erased = new Set(ids);
    for (const [id, node] of this.itemNodes) node.classList.toggle("erase-target", erased.has(id));
  }

  clearLocalPreview(): void {
    this.clearLocalLayer();
    this.highlightForErase([]);
    this.setSelection(this.selectedIds);
  }

  private clearLocalLayer(): void {
    clearTypesetMath(this.localLayer);
    this.localLayer.replaceChildren();
  }

  renderRemotePreviews(previews: Iterable<RemotePreview>): void {
    clearTypesetMath(this.remoteLayer);
    this.remoteLayer.replaceChildren();
    for (const preview of previews) {
      const group = svgElement("g");
      group.dataset.previewKey = preview.key;
      group.classList.add("remote-preview");
      const color = actorColor(preview.actorId);
      const payload = preview.payload;

      if (preview.kind === "pencil.start" || preview.kind === "pencil.segment") {
        const points = asPoints(payload.points);
        if (points.length >= 1) {
          const path = svgElement("path");
          setStroke(path, previewStyle(payload.style, color));
          path.setAttribute("d", pencilPath(points));
          group.append(path);
        }
      } else if (preview.kind === "shape.geometry") {
        const kind = payload.itemKind ?? payload.shape ?? payload.kind;
        const geometry = payload.geometry;
        if (
          (kind === "line" || kind === "rectangle" || kind === "ellipse" || kind === "polygon") &&
          isRecord(geometry)
        ) {
          group.append(
            shapeNode(
              kind,
              geometry as LineGeometry | BoxGeometry | PolygonGeometry,
              kind === "line"
                ? previewLineStyle(payload.style, color)
                : previewStyle(payload.style, color),
            ),
          );
        }
      } else if (preview.kind === "selection.transform") {
        const ids = Array.isArray(payload.itemIds)
          ? payload.itemIds.filter((id): id is string => typeof id === "string")
          : [];
        const translate = isRecord(payload.translate) ? payload.translate : payload;
        const x = numberOr(translate.x, 0);
        const y = numberOr(translate.y, 0);
        for (const id of ids) {
          const item = this.model.getItem(id);
          if (!item) continue;
          const node = itemNode(item, (assetId) => this.imageAssets.load(assetId), {
            preview: true,
          });
          node.setAttribute("stroke", color);
          node.setAttribute("opacity", "0.45");
          node.setAttribute(
            "transform",
            matrixAttribute([
              item.transform[0],
              item.transform[1],
              item.transform[2],
              item.transform[3],
              item.transform[4] + x,
              item.transform[5] + y,
            ]),
          );
          group.append(node);
        }
      }
      this.remoteLayer.append(group);
    }
  }

  renderPresence(presences: Iterable<Presence>, ownActorId: string): void {
    this.cursorLayer.replaceChildren();
    for (const presence of presences) {
      if (presence.id === ownActorId || !presence.cursor) continue;
      const group = svgElement("g");
      group.classList.add("participant-cursor");
      group.setAttribute("transform", `translate(${presence.cursor.x} ${presence.cursor.y})`);
      group.style.setProperty("--cursor-color", presence.color ?? actorColor(presence.id));

      const pointer = svgElement("path");
      pointer.setAttribute("d", "M 0 0 L 4.5 13 L 7.5 7.5 L 13 5 Z");
      pointer.setAttribute("fill", "var(--cursor-color)");
      pointer.setAttribute("stroke", "#fff");
      pointer.setAttribute("stroke-width", "1.5");
      pointer.setAttribute("vector-effect", "non-scaling-stroke");

      const label = svgElement("text");
      label.setAttribute("x", "11");
      label.setAttribute("y", "20");
      label.setAttribute("fill", "var(--cursor-color)");
      label.setAttribute("paint-order", "stroke");
      label.setAttribute("stroke", "#fff");
      label.setAttribute("stroke-width", "4");
      label.setAttribute("vector-effect", "non-scaling-stroke");
      label.textContent = presence.displayName;
      group.append(pointer, label);
      this.cursorLayer.append(group);
    }
  }

  private render(changedIds: ReadonlySet<string> | null): void {
    const ids = changedIds ?? new Set([...this.itemNodes.keys(), ...this.model.items.keys()]);
    for (const id of ids) {
      const current = this.itemNodes.get(id);
      const item = this.model.getItem(id);
      if (!item) {
        if (current) {
          clearTypesetMath(current);
          current.remove();
        }
        this.itemNodes.delete(id);
        continue;
      }
      if (current && reuseItemNode(current, item)) {
        const z = String(item.z);
        const movedInPaintOrder = current.dataset.z !== z;
        current.dataset.z = z;
        current.setAttribute("transform", matrixAttribute(item.transform));
        // Re-inserting detaches the node, so only reorder when this item's own z changed;
        // siblings that moved are reordered by their own pass through this loop.
        if (movedInPaintOrder) this.insertInPaintOrder(current, item.z);
        continue;
      }
      if (current) clearTypesetMath(current);
      const replacement = itemNode(item, (assetId) => this.imageAssets.load(assetId), {
        creatorName: this.resolveCreatorName(item.createdBy),
        onTextSize: (width, height) => {
          if (this.model.setRenderedTextSize(id, item.version, width, height)) {
            this.refreshSelection();
            this.refreshComments();
          }
          const measured = this.model.getItem(id);
          if (measured?.kind === "text" && measured.version === item.version) {
            this.onRenderedTextBoundsChange(id, item.version);
          }
        },
      });
      if (current) {
        current.replaceWith(replacement);
      }
      this.itemNodes.set(id, replacement);
      this.insertInPaintOrder(replacement, item.z);
    }
    this.renderVoteCounts();
    this.renderCommentMarkers();
    this.imageAssets.retain(
      new Set(
        [...this.model.items.values()].flatMap((item) =>
          item.kind === "image" ? [item.geometry.assetId] : [],
        ),
      ),
    );
    this.setSelection([...this.selectedIds].filter((id) => this.model.getItem(id)));
  }

  private renderCommentMarkers(): void {
    this.cancelCommentRefresh();
    const counts = new Map<string, number>();
    for (const comment of this.comments) {
      if (comment.state !== "open" || !this.model.getItem(comment.itemId)) continue;
      counts.set(comment.itemId, (counts.get(comment.itemId) ?? 0) + 1);
    }
    const nodes = [...counts.entries()].flatMap(([itemId, count]) => {
      const bounds = this.model.getBounds(itemId);
      return bounds ? [commentMarkerNode(itemId, count, bounds, this.viewport.zoom)] : [];
    });
    this.commentLayer.replaceChildren(...nodes);
  }

  private renderVoteCounts(): void {
    if (!this.votingEnabled) {
      this.voteCountLayer.replaceChildren();
      return;
    }
    renderVoteCounts(this.voteCountLayer, this.model.items.values());
  }

  private insertInPaintOrder(node: SVGGraphicsElement, z: number): void {
    let before: ChildNode | null = null;
    for (const child of this.drawingArea.children) {
      if (child === node) continue;
      const childZ = Number((child as SVGGraphicsElement).dataset.z ?? 0);
      if (childZ > z) {
        before = child;
        break;
      }
    }
    this.drawingArea.insertBefore(node, before);
  }
}

export function commentMarkerNode(
  itemId: string,
  count: number,
  bounds: Bounds,
  zoom: number,
): SVGGElement {
  const safeZoom = Math.max(0.1, zoom);
  const radius = 13 / safeZoom;
  const centerX = bounds.maxX + 8 / safeZoom;
  const centerY = bounds.minY - 8 / safeZoom;
  const marker = svgElement("g");
  marker.classList.add("comment-marker");
  marker.dataset.commentItemId = itemId;
  marker.setAttribute("role", "button");
  marker.setAttribute("tabindex", "0");
  marker.setAttribute(
    "aria-label",
    `${count} open ${count === 1 ? "comment" : "comments"} on this object`,
  );

  const bubble = svgElement("circle");
  bubble.setAttribute("cx", String(centerX));
  bubble.setAttribute("cy", String(centerY));
  bubble.setAttribute("r", String(radius));
  bubble.setAttribute("vector-effect", "non-scaling-stroke");

  const label = svgElement("text");
  label.setAttribute("x", String(centerX));
  label.setAttribute("y", String(centerY + 4 / safeZoom));
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("font-size", String(11 / safeZoom));
  label.setAttribute("font-weight", "750");
  label.setAttribute("pointer-events", "none");
  label.textContent = String(count);
  marker.append(bubble, label);

  marker.addEventListener("pointerdown", (event) => event.stopPropagation());
  marker.addEventListener("click", (event) => {
    event.stopPropagation();
    marker.dispatchEvent(
      new CustomEvent("board-comment-open", { bubbles: true, detail: { itemId } }),
    );
  });
  marker.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    marker.dispatchEvent(
      new CustomEvent("board-comment-open", { bubbles: true, detail: { itemId } }),
    );
  });
  return marker;
}

export function renderVoteCounts(layer: SVGGElement, items: Iterable<BoardItem>): void {
  const nodes = summarizeBoardVotes(items).map((summary) => voteCountNode(summary.table, summary));
  layer.replaceChildren(...nodes);
}

export function voteCountNode(table: TableItem, summary: VoteSummary): SVGGElement {
  const node = svgElement("g");
  node.classList.add("vote-counts");
  node.dataset.voteTableId = table.id;
  node.setAttribute("transform", matrixAttribute(table.transform));
  node.setAttribute("pointer-events", "none");
  node.setAttribute("role", "group");
  node.setAttribute(
    "aria-label",
    `Vote counts: ${summary.options
      .map(({ count, label }) => `${label}, ${count} ${count === 1 ? "vote" : "votes"}`)
      .join("; ")}`,
  );

  const headerHeight = table.geometry.rowHeights[0] ?? 0;
  let x = table.geometry.x;
  for (const option of summary.options) {
    const columnWidth = table.geometry.columnWidths[option.column] ?? 0;
    const label = String(option.count);
    const badgeWidth = Math.max(24, label.length * 8 + 14);
    const badgeHeight = 20;
    const right = x + columnWidth - 7;
    const top = table.geometry.y + Math.max(4, (headerHeight - badgeHeight) / 2);
    const badge = svgElement("g");
    badge.classList.add("vote-count-badge");
    badge.dataset.voteOption = String(option.column);
    badge.dataset.voteCount = label;
    badge.setAttribute(
      "aria-label",
      `${option.label}: ${option.count} ${option.count === 1 ? "vote" : "votes"}`,
    );

    const background = svgElement("rect");
    background.setAttribute("x", String(right - badgeWidth));
    background.setAttribute("y", String(top));
    background.setAttribute("width", String(badgeWidth));
    background.setAttribute("height", String(badgeHeight));
    background.setAttribute("rx", "10");
    background.setAttribute("fill", "#ffffff");
    background.setAttribute("fill-opacity", "0.94");
    background.setAttribute("stroke", "#a8a59d");
    background.setAttribute("stroke-width", "1");
    background.setAttribute("vector-effect", "non-scaling-stroke");

    const count = svgElement("text");
    count.setAttribute("x", String(right - badgeWidth / 2));
    count.setAttribute("y", String(top + 14));
    count.setAttribute("text-anchor", "middle");
    count.setAttribute("fill", "#20201e");
    count.setAttribute("font-size", "12");
    count.setAttribute(
      "font-family",
      "Rubik Variable, Rubik, ui-sans-serif, system-ui, sans-serif",
    );
    count.setAttribute("font-weight", "750");
    count.textContent = label;
    badge.append(background, count);
    node.append(badge);
    x += columnWidth;
  }
  return node;
}

type ImageAssetEntry = {
  active: boolean;
  url: string | null;
  promise: Promise<string>;
};

class ImageAssetCache {
  private readonly entries = new Map<string, ImageAssetEntry>();
  private destroyed = false;

  constructor(private readonly loader: ImageAssetLoader) {}

  load(assetId: string): Promise<string> {
    const existing = this.entries.get(assetId);
    if (existing) return existing.promise;

    const entry: ImageAssetEntry = {
      active: true,
      url: null,
      promise: Promise.resolve(""),
    };
    entry.promise = this.loader(assetId)
      .then((blob) => staticDisplayBlob(blob))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        if (this.destroyed || !entry.active) {
          URL.revokeObjectURL(url);
          throw new Error("Image asset is no longer in use.");
        }
        entry.url = url;
        return url;
      })
      .catch((error: unknown) => {
        if (this.entries.get(assetId) === entry) this.entries.delete(assetId);
        throw error;
      });
    this.entries.set(assetId, entry);
    return entry.promise;
  }

  retain(assetIds: ReadonlySet<string>): void {
    for (const [assetId, entry] of this.entries) {
      if (assetIds.has(assetId)) continue;
      entry.active = false;
      this.entries.delete(assetId);
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.retain(new Set());
  }
}

async function staticDisplayBlob(blob: Blob): Promise<Blob> {
  if (blob.type !== "image/gif" || typeof createImageBitmap !== "function") return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) return blob;
      context.drawImage(bitmap, 0, 0);
      return (
        (await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))) ?? blob
      );
    } finally {
      bitmap.close();
    }
  } catch {
    return blob;
  }
}

export class CanvasViewport {
  private x = 0;
  private y = 0;
  private width = 1;
  private height = 1;
  private zoomValue = 1;
  private readonly resizeObserver: ResizeObserver;
  private readonly listeners = new Set<(zoom: number) => void>();
  private readonly viewListeners = new Set<(state: SpotlightViewState) => void>();

  constructor(private readonly svg: SVGSVGElement) {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(svg);
    this.resize();
  }

  get zoom(): number {
    return this.zoomValue;
  }

  get viewState(): SpotlightViewState {
    return {
      center: {
        x: this.x + this.width / this.zoomValue / 2,
        y: this.y + this.height / this.zoomValue / 2,
      },
      zoom: this.zoomValue,
    };
  }

  get viewBounds(): Bounds {
    return {
      minX: this.x,
      minY: this.y,
      maxX: this.x + this.width / this.zoomValue,
      maxY: this.y + this.height / this.zoomValue,
    };
  }

  subscribe(listener: (zoom: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeView(listener: (state: SpotlightViewState) => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  setViewState(state: SpotlightViewState): void {
    const { x, y } = state.center;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(state.zoom)) {
      throw new RangeError("Viewport center and zoom must be finite.");
    }
    this.zoomValue = Math.max(0.1, Math.min(8, state.zoom));
    this.x = x - this.width / this.zoomValue / 2;
    this.y = y - this.height / this.zoomValue / 2;
    this.update();
    this.notifyZoom();
    this.notifyView();
  }

  clientToBoard(clientX: number, clientY: number): Point {
    const rect = this.svg.getBoundingClientRect();
    return [
      this.x + (clientX - rect.left) / this.zoomValue,
      this.y + (clientY - rect.top) / this.zoomValue,
    ];
  }

  boardToClient(point: Point): Point {
    const rect = this.svg.getBoundingClientRect();
    return [
      rect.left + (point[0] - this.x) * this.zoomValue,
      rect.top + (point[1] - this.y) * this.zoomValue,
    ];
  }

  panByPixels(deltaX: number, deltaY: number): void {
    this.x -= deltaX / this.zoomValue;
    this.y -= deltaY / this.zoomValue;
    this.update();
    this.notifyView();
  }

  zoomAt(clientX: number, clientY: number, zoom: number): void {
    const anchorBefore = this.clientToBoard(clientX, clientY);
    this.zoomValue = Math.max(0.1, Math.min(8, zoom));
    const anchorAfter = this.clientToBoard(clientX, clientY);
    this.x += anchorBefore[0] - anchorAfter[0];
    this.y += anchorBefore[1] - anchorAfter[1];
    this.update();
    this.notifyZoom();
    this.notifyView();
  }

  reset(): void {
    this.x = 0;
    this.y = 0;
    this.zoomValue = 1;
    this.update();
    this.notifyZoom();
    this.notifyView();
  }

  fit(bounds: Bounds | undefined, padding = 80): void {
    if (!bounds) {
      this.reset();
      return;
    }
    const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
    const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
    this.zoomValue = Math.max(
      0.1,
      Math.min(
        4,
        Math.min(
          (this.width - padding * 2) / contentWidth,
          (this.height - padding * 2) / contentHeight,
        ),
      ),
    );
    this.x = (bounds.minX + bounds.maxX) / 2 - this.width / this.zoomValue / 2;
    this.y = (bounds.minY + bounds.maxY) / 2 - this.height / this.zoomValue / 2;
    this.update();
    this.notifyZoom();
    this.notifyView();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.listeners.clear();
    this.viewListeners.clear();
  }

  private resize(): void {
    const rect = this.svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const oldCenterX = this.x + this.width / this.zoomValue / 2;
    const oldCenterY = this.y + this.height / this.zoomValue / 2;
    this.width = rect.width;
    this.height = rect.height;
    if (this.svg.dataset.ready === "true") {
      this.x = oldCenterX - this.width / this.zoomValue / 2;
      this.y = oldCenterY - this.height / this.zoomValue / 2;
    }
    this.svg.dataset.ready = "true";
    this.update();
  }

  private update(): void {
    this.svg.setAttribute(
      "viewBox",
      `${this.x} ${this.y} ${this.width / this.zoomValue} ${this.height / this.zoomValue}`,
    );
    this.svg.style.setProperty("--board-zoom", String(this.zoomValue));
  }

  private notifyZoom(): void {
    for (const listener of this.listeners) listener(this.zoomValue);
  }

  private notifyView(): void {
    const state = this.viewState;
    for (const listener of this.viewListeners) listener(state);
  }
}

type ItemNodeOptions = {
  creatorName?: string;
  onTextSize?: (width: number, height: number) => void;
  preview?: boolean;
};

/**
 * Updates an authoritative node in place when only its placement changed. Video cards hold a
 * live iframe, so rebuilding them on every board update would reload the player.
 */
function reuseItemNode(node: SVGGraphicsElement, item: BoardItem): boolean {
  if (item.kind !== "text" || item.geometry.embed !== "video") return false;
  const video = videoEmbedFromText(item.geometry.text);
  if (!video) return false;
  return updateVideoEmbedNode(node, item.geometry, item.style, video, false);
}

function itemNode(
  item: BoardItem,
  loadImageAsset: (assetId: string) => Promise<string>,
  options: ItemNodeOptions = {},
): SVGGraphicsElement {
  const preview = options.preview === true;
  const creatorName = options.creatorName?.trim() ?? "";
  const badged =
    creatorName !== "" &&
    (item.kind === "sticky" || item.kind === "image" || item.kind === "stamp");
  // Previews echo a gesture in progress, so only authoritative nodes carry the AI mark; a
  // badged item shows it inside the creator badge instead of as a standalone pill.
  const marked = item.assistedBy === "ai" && !preview && !badged;
  let mark: SVGGElement | undefined;
  const onTextSize = marked
    ? (width: number, height: number) => {
        // Typeset math reports its real width, so keep the mark on the measured corner.
        if (mark && item.kind === "text") {
          positionAssistanceMark(mark, textAssistanceMarkAnchor(item.geometry, item.style, width));
        }
        options.onTextSize?.(width, height);
      }
    : options.onTextSize;
  let node: SVGGraphicsElement;
  // Leaf elements (path, rect, text…) cannot hold the mark, so those get a wrapping group.
  let leaf = false;
  switch (item.kind) {
    case "pencil": {
      const path = svgElement("path");
      path.setAttribute("d", outlinePath(visibleOutlinePaths("pencil", item.geometry)));
      setStroke(path, item.style);
      node = path;
      leaf = true;
      break;
    }
    case "line":
      node = shapeNode(item.kind, item.geometry, item.style);
      break;
    case "rectangle":
    case "ellipse":
    case "polygon":
      node = shapeNode(item.kind, item.geometry, item.style);
      leaf = true;
      break;
    case "protractor":
      node = protractorNode(item.geometry, item.style);
      break;
    case "text": {
      const video = item.geometry.embed === "video" ? videoEmbedFromText(item.geometry.text) : null;
      const math = containsMathMarkup(item.geometry.text);
      node = video
        ? videoEmbedNode(item.geometry, item.style, video, preview)
        : math
          ? preview
            ? mathTextPreviewNode(item.geometry, item.style)
            : mathTextNode(item.geometry, item.style, onTextSize)
          : textNode(item.geometry, item.style);
      leaf = !video && (!math || preview);
      break;
    }
    case "sticky":
      node = stickyNode(item.geometry, item.style, preview);
      break;
    case "stamp":
      node = stampNode(item.geometry, item.style);
      break;
    case "image":
      node = imageNode(item.id, item.geometry, item.style, loadImageAsset);
      break;
    case "table":
      node = tableNode(item.id, item.geometry, item.style, preview);
      break;
    case "zone":
      node = zoneNode(item.id, item.geometry, item.style, preview);
      break;
  }
  if (marked && leaf) {
    const group = svgElement("g");
    group.append(node);
    node = group;
  }
  node.dataset.itemId = item.id;
  node.dataset.z = String(item.z);
  node.classList.add("board-item", `board-item-${item.kind}`);
  node.setAttribute("transform", matrixAttribute(item.transform));
  if (badged) {
    appendCreatorAttribution(node, item, creatorName);
  } else if (marked) {
    mark = assistanceMark(item);
    node.append(mark);
    node.dataset.assistedBy = "ai";
    node.setAttribute("aria-description", assistanceLabel(creatorName));
    // A moved video card is laid out in place rather than rebuilt, so it must move its mark.
    const videoParts = videoEmbedParts.get(node);
    if (videoParts) videoParts.assistanceMark = mark;
  }
  return node;
}

type TextBearingStyle = Pick<
  TextStyle | StickyStyle | TableStyle | ZoneStyle,
  "fontFamily" | "fontWeight" | "fontStyle" | "textDecoration"
>;

function applyTypography(
  text: SVGTextElement,
  style: TextBearingStyle,
  defaultWeight = "normal",
): void {
  text.setAttribute("font-family", textFontStack(style.fontFamily ?? "sans"));
  text.setAttribute("font-weight", resolveTextFontWeight(style.fontWeight, defaultWeight));
  text.setAttribute("font-style", style.fontStyle ?? "normal");
  text.setAttribute("text-decoration", style.textDecoration ?? "none");
}

function appendLinkifiedLine(text: SVGTextElement, line: string, x: number, dy?: string): void {
  const tokens = tokenizeSafeLinks(line);
  if (tokens.length === 0) tokens.push({ kind: "text", text: " " });
  tokens.forEach((token, index) => {
    const span = svgElement("tspan");
    if (index === 0) {
      span.setAttribute("x", String(x));
      if (dy) span.setAttribute("dy", dy);
    }
    span.textContent = token.text || " ";
    if (token.kind === "link") {
      text.classList.add("has-board-text-link");
      const anchor = svgElement("a");
      anchor.classList.add("board-text-link");
      anchor.dataset.boardLink = "true";
      anchor.setAttribute("href", token.href);
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noopener noreferrer");
      anchor.setAttribute("referrerpolicy", "no-referrer");
      anchor.append(span);
      text.append(anchor);
    } else {
      text.append(span);
    }
  });
}

export function textNode(geometry: TextGeometry, style: TextStyle): SVGTextElement {
  const text = svgElement("text");
  text.setAttribute("x", String(geometry.x));
  text.setAttribute("y", String(geometry.y));
  text.setAttribute("fill", style.color);
  text.setAttribute("fill-opacity", String(style.opacity));
  text.setAttribute("font-size", String(style.fontSize));
  applyTypography(text, style);
  text.setAttribute("xml:space", "preserve");
  const lines = geometry.text.split("\n");
  lines.forEach((line, index) => {
    appendLinkifiedLine(text, line, geometry.x, index > 0 ? "1.2em" : undefined);
  });
  return text;
}

function mathTextPreviewNode(geometry: TextGeometry, style: TextStyle): SVGTextElement {
  const preview = textNode(geometry, style);
  preview.classList.add("board-math-preview");
  preview.setAttribute("aria-hidden", "true");
  return preview;
}

function mathTextNode(
  geometry: TextGeometry,
  style: TextStyle,
  onSize?: (width: number, height: number) => void,
): SVGGElement {
  const lines = geometry.text.split("\n");
  const estimatedWidth =
    Math.max(1, ...lines.map((line) => [...line].length)) * style.fontSize * 0.7;
  const width = Math.max(180, Math.min(MAX_MATH_TEXT_WIDTH, estimatedWidth));
  const height = Math.max(style.fontSize * 2.2, lines.length * style.fontSize * 1.5);
  const node = svgElement("g");
  node.classList.add("board-math-text");
  node.append(
    mathForeignObject(
      geometry.x,
      geometry.y - style.fontSize,
      width,
      height,
      geometry.text,
      style,
      "board-math-content",
      { fitContent: true, opacity: style.opacity, onSize },
    ),
  );
  return node;
}

/**
 * Positioned parts of a rendered video card, kept so a moved or remotely updated item can be
 * repositioned in place. Rebuilding or re-inserting the node would detach its iframe, which
 * reloads the player and restarts playback at the beginning for everyone watching.
 */
type VideoEmbedParts = {
  video: VideoEmbed;
  preview: boolean;
  foreign: SVGForeignObjectElement;
  dragFrame?: SVGRectElement;
  border: SVGRectElement;
  handleSurface?: SVGRectElement;
  handleGrip?: SVGTextElement;
  assistanceMark?: SVGGElement;
};

const videoEmbedParts = new WeakMap<Element, VideoEmbedParts>();

function layoutVideoEmbedNode(
  node: SVGGElement,
  parts: VideoEmbedParts,
  geometry: TextGeometry,
  style: TextStyle,
): void {
  const x = geometry.x;
  const y = geometry.y - style.fontSize;
  node.setAttribute("opacity", String(style.opacity));
  for (const box of [parts.foreign, parts.dragFrame, parts.border]) {
    if (!box) continue;
    box.setAttribute("x", String(x));
    box.setAttribute("y", String(y));
  }
  const handleX = x + VIDEO_EMBED_WIDTH - 34;
  const handleY = y + 4;
  parts.handleSurface?.setAttribute("x", String(handleX));
  parts.handleSurface?.setAttribute("y", String(handleY));
  parts.handleGrip?.setAttribute("x", String(handleX + 15));
  parts.handleGrip?.setAttribute("y", String(handleY + 15));
  if (parts.assistanceMark) {
    positionAssistanceMark(parts.assistanceMark, videoAssistanceMarkAnchor(geometry, style));
  }
}

/**
 * Repositions an already rendered video card when it still shows the same video, so the live
 * player keeps playing. Returns false when the node must be rebuilt instead.
 */
function updateVideoEmbedNode(
  node: SVGGraphicsElement,
  geometry: TextGeometry,
  style: TextStyle,
  video: VideoEmbed,
  preview: boolean,
): boolean {
  const parts = videoEmbedParts.get(node);
  if (
    parts === undefined ||
    parts.preview !== preview ||
    parts.video.provider !== video.provider ||
    parts.video.embedUrl !== video.embedUrl ||
    parts.video.sourceUrl !== video.sourceUrl ||
    parts.video.title !== video.title
  ) {
    return false;
  }
  layoutVideoEmbedNode(node as SVGGElement, parts, geometry, style);
  return true;
}

function videoEmbedNode(
  geometry: TextGeometry,
  style: TextStyle,
  video: VideoEmbed,
  preview: boolean,
): SVGGElement {
  const node = svgElement("g");
  node.classList.add("video-embed-item");
  if (preview) node.classList.add("video-embed-preview-item");
  node.dataset.videoProvider = video.provider;
  node.setAttribute("role", "group");
  node.setAttribute("aria-label", video.title);

  const foreign = svgElement("foreignObject");
  foreign.setAttribute("width", String(VIDEO_EMBED_WIDTH));
  foreign.setAttribute("height", String(VIDEO_EMBED_HEIGHT));

  const card = document.createElement("div");
  card.className = "video-embed-card";
  if (preview) {
    const heading = document.createElement("div");
    heading.className = "video-embed-heading";
    heading.textContent = video.title;
    const placeholder = document.createElement("div");
    placeholder.className = "video-embed-preview";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.textContent = "Video preview";
    card.append(heading, placeholder);
  } else {
    const heading = document.createElement("a");
    heading.className = "video-embed-heading";
    heading.dataset.boardLink = "true";
    heading.href = video.sourceUrl;
    heading.target = "_blank";
    heading.rel = "noopener noreferrer";
    heading.referrerPolicy = "no-referrer";
    heading.textContent = `${video.title} · open in new tab`;
    const frame = document.createElement("iframe");
    frame.className = "video-embed-frame";
    frame.src = video.embedUrl;
    frame.title = video.title;
    frame.loading = "lazy";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.allow =
      "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share";
    frame.allowFullscreen = true;
    card.append(heading, frame);
  }
  foreign.append(card);

  const border = svgElement("rect");
  border.classList.add("video-embed-border");
  border.setAttribute("width", String(VIDEO_EMBED_WIDTH));
  border.setAttribute("height", String(VIDEO_EMBED_HEIGHT));
  border.setAttribute("rx", "12");
  border.setAttribute("pointer-events", "none");
  const dragFrame = preview ? undefined : svgElement("rect");
  if (dragFrame) {
    dragFrame.classList.add("video-embed-drag-frame");
    dragFrame.dataset.videoDragFrame = "true";
    dragFrame.setAttribute("width", String(VIDEO_EMBED_WIDTH));
    dragFrame.setAttribute("height", String(VIDEO_EMBED_HEIGHT));
    dragFrame.setAttribute("rx", "12");
  }
  node.append(foreign, ...(dragFrame ? [dragFrame] : []), border);
  const handle = preview ? undefined : videoDragHandleNode();
  if (handle) node.append(handle.node);
  const parts: VideoEmbedParts = {
    video,
    preview,
    foreign,
    ...(dragFrame ? { dragFrame } : {}),
    border,
    ...(handle ? { handleSurface: handle.surface, handleGrip: handle.grip } : {}),
  };
  videoEmbedParts.set(node, parts);
  layoutVideoEmbedNode(node, parts, geometry, style);
  return node;
}

function videoDragHandleNode(): {
  node: SVGGElement;
  surface: SVGRectElement;
  grip: SVGTextElement;
} {
  const handle = svgElement("g");
  handle.classList.add("video-embed-drag-handle");
  handle.dataset.videoDragHandle = "true";

  const surface = svgElement("rect");
  surface.classList.add("video-embed-drag-surface");
  surface.setAttribute("width", "30");
  surface.setAttribute("height", "22");
  surface.setAttribute("rx", "7");

  const grip = svgElement("text");
  grip.classList.add("video-embed-drag-grip");
  grip.setAttribute("text-anchor", "middle");
  grip.setAttribute("pointer-events", "none");
  grip.textContent = "⠿";
  handle.append(surface, grip);
  return { node: handle, surface, grip };
}

type MathForeignObjectOptions = {
  defaultWeight?: string;
  fitContent?: boolean;
  opacity?: number;
  onSize?: (width: number, height: number) => void;
};

function appendLinkifiedHtml(container: HTMLElement, value: string): void {
  for (const segment of splitMathMarkup(value)) {
    if (segment.kind === "math") {
      container.append(segment.text);
      continue;
    }
    for (const token of tokenizeSafeLinks(segment.text)) {
      if (token.kind === "text") {
        container.append(token.text);
        continue;
      }
      container.classList.add("has-board-text-link");
      const anchor = document.createElement("a");
      anchor.classList.add("board-text-link");
      anchor.dataset.boardLink = "true";
      anchor.href = token.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.referrerPolicy = "no-referrer";
      anchor.textContent = token.text;
      container.append(anchor);
    }
  }
}

/**
 * Slack added to a measured formula box. Layout widths come back as whole pixels, and italic math
 * overhangs its own advance width, so a box measured exactly cuts the last glyph.
 */
const MATH_FIT_PADDING = 3;

/**
 * How far the content sits below the top of its box, in board units. Both rectangles come back in
 * screen pixels, so they are converted through the element's own scale rather than by asking the
 * viewport, which keeps this correct at any zoom.
 */
function verticalOffsetWithin(box: SVGForeignObjectElement, content: HTMLElement): number {
  const contentRect = content.getBoundingClientRect();
  const scale = contentRect.height > 0 ? contentRect.height / Math.max(1, content.offsetHeight) : 0;
  if (!(scale > 0)) return 0;
  return Math.max(0, (contentRect.top - box.getBoundingClientRect().top) / scale);
}

function mathForeignObject(
  x: number,
  y: number,
  width: number,
  height: number,
  value: string,
  style: TextStyle | StickyStyle | TableStyle | ZoneStyle,
  className: string,
  options: MathForeignObjectOptions = {},
): SVGForeignObjectElement {
  const foreign = svgElement("foreignObject");
  foreign.setAttribute("x", String(x));
  foreign.setAttribute("y", String(y));
  foreign.setAttribute("width", String(Math.max(1, width)));
  foreign.setAttribute("height", String(Math.max(1, height)));
  const content = document.createElement("div");
  content.className = className;
  appendLinkifiedHtml(content, value);
  if (options.opacity !== undefined) content.style.opacity = String(options.opacity);
  content.style.color = "color" in style ? style.color : style.textColor;
  content.style.fontSize = `${style.fontSize}px`;
  content.style.fontFamily = textFontStack(style.fontFamily ?? "sans");
  content.style.fontWeight = resolveTextFontWeight(style.fontWeight, options.defaultWeight);
  content.style.fontStyle = style.fontStyle ?? "normal";
  content.style.textDecoration = style.textDecoration ?? "none";
  if (options.fitContent) {
    content.style.width = "max-content";
    content.style.maxWidth = `${MAX_MATH_TEXT_WIDTH}px`;
    content.style.minHeight = "0";
  }
  foreign.append(content);
  const fitToTypesetMath = (): void => {
    if (!options.fitContent || !foreign.isConnected) return;
    // Measure at full width. The box was sized from an estimate of the source text, and a formula
    // typesets wider than its source, so measuring inside the old box would report the width the
    // foreignObject had already clipped it to and keep that clip forever.
    foreign.setAttribute("width", String(MAX_MATH_TEXT_WIDTH));
    const measured = Math.max(1, content.scrollWidth) + MATH_FIT_PADDING;
    const renderedWidth = Math.ceil(Math.min(MAX_MATH_TEXT_WIDTH, measured));
    // scrollHeight is the content's own height and says nothing about where the content sits. A
    // margin on the typeset maths shifts it down inside the box, and a box sized from that height
    // alone ends below the glyphs, which is what sliced them. Measure the offset too.
    const renderedHeight = Math.ceil(
      Math.max(1, content.scrollHeight) + verticalOffsetWithin(foreign, content),
    );
    foreign.setAttribute("width", String(renderedWidth));
    foreign.setAttribute("height", String(renderedHeight));
    options.onSize?.(renderedWidth, renderedHeight);
  };

  typesetMath(content, {
    onReady: () => {
      fitToTypesetMath();
      // MathJax sizes its output in ex units, which resolve against the font actually in use, so
      // a box measured before the maths font is ready comes out short and clips the last glyph.
      // Measuring again once the fonts have settled is what makes the fit final.
      const remeasure = (): void => {
        requestAnimationFrame(() => fitToTypesetMath());
      };
      if (typeof document !== "undefined" && document.fonts?.ready) {
        void document.fonts.ready.then(remeasure, remeasure);
      } else {
        remeasure();
      }
    },
    // Falling back to plain text would flatten the safe-link anchors, so rebuild them.
    restore: (target) => {
      target.replaceChildren();
      appendLinkifiedHtml(target, value);
    },
  });
  return foreign;
}

export function creatorInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...(words[0] ?? "")][0] ?? "?";
  if (words.length === 1) return [...(words[0] ?? "")].slice(0, 2).join("").toLocaleUpperCase();
  const last = [...(words.at(-1) ?? "")][0] ?? "";
  return `${first}${last}`.toLocaleUpperCase();
}

const BADGE_FONT_FAMILY = "Rubik Variable, Rubik, ui-sans-serif, system-ui, sans-serif";
const ASSISTANCE_MARK_FILL = "#2d2240";
const ASSISTANCE_MARK_WIDTH = 14;
const ASSISTANCE_MARK_HEIGHT = 10;

function assistanceLabel(displayName: string): string {
  return displayName
    ? `Created by ${displayName} with AI assistance`
    : "Created with AI assistance";
}

function appendCreatorAttribution(
  node: SVGGraphicsElement,
  item: AttributedItem,
  displayName: string,
): void {
  const assisted = item.assistedBy === "ai";
  const label = assisted ? assistanceLabel(displayName) : `Created by ${displayName}`;
  const title = svgElement("title");
  title.textContent = label;
  node.prepend(title);
  node.setAttribute("aria-description", label);
  node.dataset.creatorInitials = creatorInitials(displayName);
  if (assisted) node.dataset.assistedBy = "ai";
  node.classList.add("has-creator-badge");
  node.append(creatorBadge(item, displayName));
}

export function creatorBadge(item: AttributedItem, displayName: string): SVGGElement {
  let x: number;
  let y: number;
  let radius: number;
  if (item.kind === "sticky") {
    radius = 9;
    x = item.geometry.width - radius - 4;
    y = item.geometry.height - radius - 4;
  } else if (item.kind === "image") {
    radius = 9;
    x = item.geometry.x + item.geometry.width - radius - 4;
    y = item.geometry.y + item.geometry.height - radius - 4;
  } else {
    radius = Math.max(6, Math.min(8, item.geometry.size * 0.2));
    x = item.geometry.x + item.geometry.size / 2 - radius - 1;
    y = item.geometry.y + item.geometry.size / 2 - radius - 1;
  }

  const badge = svgElement("g");
  badge.classList.add("creator-badge");
  badge.setAttribute("aria-hidden", "true");
  badge.setAttribute("pointer-events", "none");

  const background = svgElement("circle");
  background.setAttribute("cx", String(x));
  background.setAttribute("cy", String(y));
  background.setAttribute("r", String(radius));
  background.setAttribute("fill", actorColor(item.createdBy));
  background.setAttribute("stroke", "#ffffff");
  background.setAttribute("stroke-width", "1.5");
  background.setAttribute("vector-effect", "non-scaling-stroke");

  const text = svgElement("text");
  text.setAttribute("x", String(x));
  text.setAttribute("y", String(y + radius * 0.34));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", "#ffffff");
  text.setAttribute("font-size", String(Math.max(7, radius * 0.92)));
  text.setAttribute("font-family", BADGE_FONT_FAMILY);
  text.setAttribute("font-weight", "800");
  text.textContent = creatorInitials(displayName);
  badge.append(background, text);

  if (item.assistedBy === "ai") {
    // The responsible participant keeps their initials; a smaller "AI" disc overlaps the
    // top-left so a reader can tell tool-written content from typed content at a glance.
    badge.classList.add("creator-badge-ai");
    const markRadius = Math.max(5, radius * 0.6);
    const markX = x - radius * 0.9;
    const markY = y - radius * 0.9;
    const markBackground = svgElement("circle");
    markBackground.setAttribute("cx", String(markX));
    markBackground.setAttribute("cy", String(markY));
    markBackground.setAttribute("r", String(markRadius));
    markBackground.setAttribute("fill", ASSISTANCE_MARK_FILL);
    markBackground.setAttribute("stroke", "#ffffff");
    markBackground.setAttribute("stroke-width", "1.5");
    markBackground.setAttribute("vector-effect", "non-scaling-stroke");
    const markText = svgElement("text");
    markText.setAttribute("x", String(markX));
    markText.setAttribute("y", String(markY + markRadius * 0.34));
    markText.setAttribute("text-anchor", "middle");
    markText.setAttribute("fill", "#ffffff");
    markText.setAttribute("font-size", String(Math.max(6, radius * 0.6)));
    markText.setAttribute("font-family", BADGE_FONT_FAMILY);
    markText.setAttribute("font-weight", "800");
    markText.textContent = "AI";
    badge.append(markBackground, markText);
  }
  return badge;
}

/** Top-right corner, in the node's local coordinates, that the assistance mark hangs from. */
function assistanceMarkAnchor(item: BoardItem): Point {
  const width = ASSISTANCE_MARK_WIDTH;
  const height = ASSISTANCE_MARK_HEIGHT;
  switch (item.kind) {
    case "pencil":
      return outlineAssistanceMarkAnchor(
        visibleOutlinePaths("pencil", item.geometry),
        item.geometry.points,
      );
    case "line":
      return outlineAssistanceMarkAnchor(visibleOutlinePaths("line", item.geometry), [
        [item.geometry.x1, item.geometry.y1],
        [item.geometry.x2, item.geometry.y2],
      ]);
    case "rectangle":
    case "ellipse":
    case "polygon":
    case "image":
      return [item.geometry.x + item.geometry.width - width - 4, item.geometry.y + 4];
    case "protractor":
      return [item.geometry.radius - width, -item.geometry.radius];
    case "text":
      if (item.geometry.embed === "video" && videoEmbedFromText(item.geometry.text)) {
        return videoAssistanceMarkAnchor(item.geometry, item.style);
      }
      return textAssistanceMarkAnchor(
        item.geometry,
        item.style,
        estimatedTextWidth(item.geometry, item.style),
      );
    case "sticky":
      // Sticky content lives in a nested <svg>, so its local origin is the card's corner.
      return [item.geometry.width - width - 4, 4];
    case "stamp":
      return [
        item.geometry.x + item.geometry.size / 2 - width,
        item.geometry.y - item.geometry.size / 2,
      ];
    case "table":
      return [
        item.geometry.x +
          item.geometry.columnWidths.reduce((total, column) => total + column, 0) -
          width -
          3,
        item.geometry.y + 3,
      ];
    case "zone": {
      const band = Math.min(item.geometry.height, zoneTitleBandHeight(item.style.fontSize));
      // The lock badge owns the title bar's right end on locked sections.
      const inset = item.geometry.locked === true ? 32 : ZONE_TITLE_PADDING;
      return [
        item.geometry.x + item.geometry.width - inset - width,
        item.geometry.y + Math.max(2, (band - height) / 2),
      ];
    }
  }
}

function outlineAssistanceMarkAnchor(
  paths: readonly (readonly Point[])[],
  fallback: readonly Point[],
): Point {
  const visible = paths.flat();
  const points = visible.length > 0 ? visible : fallback;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const [x, y] of points) {
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
  }
  if (!Number.isFinite(maxX) || !Number.isFinite(minY)) return [0, -ASSISTANCE_MARK_HEIGHT];
  // Strokes have no interior to sit in, so the mark hangs just outside their top-right point.
  return [maxX + 2, minY - ASSISTANCE_MARK_HEIGHT - 2];
}

function estimatedTextWidth(geometry: TextGeometry, style: TextStyle): number {
  const lines = textLayoutEstimateSource(geometry.text, style.fontSize).split("\n");
  return Math.max(1, ...lines.map((line) => [...line].length)) * style.fontSize * 0.61;
}

function textAssistanceMarkAnchor(geometry: TextGeometry, style: TextStyle, width: number): Point {
  // Above the first line's right end, so the mark never covers glyphs.
  return [
    geometry.x + width - ASSISTANCE_MARK_WIDTH,
    geometry.y - style.fontSize - ASSISTANCE_MARK_HEIGHT - 2,
  ];
}

function videoAssistanceMarkAnchor(geometry: TextGeometry, style: TextStyle): Point {
  // Left of the drag handle, which owns the card's top-right corner.
  return [
    geometry.x + VIDEO_EMBED_WIDTH - 34 - 4 - ASSISTANCE_MARK_WIDTH,
    geometry.y - style.fontSize + 4,
  ];
}

function positionAssistanceMark(mark: SVGGElement, anchor: Point): void {
  mark.setAttribute("transform", `translate(${anchor[0]} ${anchor[1]})`);
}

/**
 * The standalone "AI" pill for kinds that carry no creator badge. Decorative only: the
 * accessible sentence lives in the item's aria-description.
 */
export function assistanceMark(item: BoardItem): SVGGElement {
  const mark = svgElement("g");
  mark.classList.add("assistance-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("pointer-events", "none");
  positionAssistanceMark(mark, assistanceMarkAnchor(item));

  const background = svgElement("rect");
  background.setAttribute("x", "0");
  background.setAttribute("y", "0");
  background.setAttribute("width", String(ASSISTANCE_MARK_WIDTH));
  background.setAttribute("height", String(ASSISTANCE_MARK_HEIGHT));
  background.setAttribute("rx", "3");
  background.setAttribute("fill", ASSISTANCE_MARK_FILL);
  background.setAttribute("stroke", "#ffffff");
  background.setAttribute("stroke-width", "1");
  background.setAttribute("vector-effect", "non-scaling-stroke");

  const text = svgElement("text");
  text.setAttribute("x", String(ASSISTANCE_MARK_WIDTH / 2));
  text.setAttribute("y", String(ASSISTANCE_MARK_HEIGHT * 0.78));
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", "#ffffff");
  text.setAttribute("font-size", "7");
  text.setAttribute("font-family", BADGE_FONT_FAMILY);
  text.setAttribute("font-weight", "800");
  text.textContent = "AI";
  mark.append(background, text);
  return mark;
}

export function zoneNode(
  itemId: string,
  geometry: ZoneGeometry,
  style: ZoneStyle,
  preview = false,
): SVGGElement {
  const node = svgElement("g");
  node.classList.add("zone-item");
  node.dataset.zoneTitle = geometry.title;
  const locked = geometry.locked === true;
  if (locked) node.dataset.sectionLocked = "true";
  node.setAttribute("role", "group");
  node.setAttribute(
    "aria-label",
    locked ? `Locked Section: ${geometry.title}` : `Section: ${geometry.title}`,
  );

  const safeId = itemId.replace(/[^A-Za-z0-9_-]/gu, "-");
  const titleClipId = `zone-title-clip-${safeId}`;
  const titleBandHeight = Math.min(geometry.height, zoneTitleBandHeight(style.fontSize));
  const accessibleTitle = svgElement("title");
  accessibleTitle.textContent = geometry.title;
  const definitions = svgElement("defs");
  const clip = svgElement("clipPath");
  clip.id = titleClipId;
  const clipRect = svgElement("rect");
  clipRect.setAttribute("x", String(geometry.x + ZONE_TITLE_PADDING));
  clipRect.setAttribute("y", String(geometry.y));
  clipRect.setAttribute("width", String(Math.max(0, geometry.width - ZONE_TITLE_PADDING * 2)));
  clipRect.setAttribute("height", String(Math.max(0, titleBandHeight - ZONE_TITLE_PADDING)));
  clip.append(clipRect);
  definitions.append(clip);

  const fill = svgElement("rect");
  fill.classList.add("zone-fill");
  fill.setAttribute("x", String(geometry.x));
  fill.setAttribute("y", String(geometry.y));
  fill.setAttribute("width", String(geometry.width));
  fill.setAttribute("height", String(geometry.height));
  fill.setAttribute("rx", "12");
  fill.setAttribute("fill", style.fill);
  fill.setAttribute("fill-opacity", String(style.opacity));

  const border = svgElement("rect");
  border.classList.add("zone-border");
  border.setAttribute("x", String(geometry.x));
  border.setAttribute("y", String(geometry.y));
  border.setAttribute("width", String(geometry.width));
  border.setAttribute("height", String(geometry.height));
  border.setAttribute("rx", "12");
  border.setAttribute("fill", "none");
  border.setAttribute("stroke", style.borderColor);
  border.setAttribute("stroke-width", "1.5");
  border.setAttribute("vector-effect", "non-scaling-stroke");

  const normalizedTitle = geometry.title.replace(/\r\n?|\n/gu, " ");
  const mathTitle = containsMathMarkup(normalizedTitle);
  const typesetMathTitle = mathTitle && !preview;
  const title = typesetMathTitle
    ? mathForeignObject(
        geometry.x + ZONE_TITLE_PADDING,
        geometry.y + ZONE_TITLE_PADDING,
        geometry.width - ZONE_TITLE_PADDING * 2,
        titleBandHeight - ZONE_TITLE_PADDING,
        normalizedTitle,
        style,
        "zone-math-content",
        { defaultWeight: "700" },
      )
    : svgElement("text");
  title.classList.add("zone-title");
  if (!typesetMathTitle) {
    const plainTitle = title as SVGTextElement;
    if (mathTitle) {
      plainTitle.classList.add("zone-math-preview");
      plainTitle.setAttribute("aria-hidden", "true");
    }
    plainTitle.setAttribute("x", String(geometry.x + ZONE_TITLE_PADDING));
    plainTitle.setAttribute("y", String(geometry.y + ZONE_TITLE_PADDING + style.fontSize));
    plainTitle.setAttribute("fill", style.textColor);
    plainTitle.setAttribute("font-size", String(style.fontSize));
    applyTypography(plainTitle, style, "700");
    plainTitle.setAttribute("clip-path", `url(#${titleClipId})`);
    plainTitle.setAttribute("xml:space", "preserve");
    appendLinkifiedLine(plainTitle, normalizedTitle, geometry.x + ZONE_TITLE_PADDING);
  }

  const lockBadge = svgElement("g");
  lockBadge.classList.add("zone-lock-badge");
  lockBadge.setAttribute("aria-hidden", "true");
  lockBadge.setAttribute("pointer-events", "none");
  if (locked) {
    const badgeX = geometry.x + geometry.width - 28;
    const badgeY = geometry.y + 10;
    const background = svgElement("circle");
    background.setAttribute("cx", String(badgeX + 9));
    background.setAttribute("cy", String(badgeY + 9));
    background.setAttribute("r", "9");
    background.setAttribute("fill", style.borderColor);
    background.setAttribute("fill-opacity", "0.14");
    const shackle = svgElement("path");
    shackle.setAttribute(
      "d",
      [
        "M ",
        badgeX + 6,
        " ",
        badgeY + 9,
        " V ",
        badgeY + 6,
        " A 3 3 0 0 1 ",
        badgeX + 12,
        " ",
        badgeY + 6,
        " V ",
        badgeY + 9,
      ].join(""),
    );
    shackle.setAttribute("fill", "none");
    shackle.setAttribute("stroke", style.textColor);
    shackle.setAttribute("stroke-width", "1.6");
    shackle.setAttribute("stroke-linecap", "round");
    const body = svgElement("rect");
    body.setAttribute("x", String(badgeX + 4.5));
    body.setAttribute("y", String(badgeY + 8));
    body.setAttribute("width", "9");
    body.setAttribute("height", "7");
    body.setAttribute("rx", "1.5");
    body.setAttribute("fill", style.textColor);
    lockBadge.append(background, shackle, body);
  }

  node.append(accessibleTitle, definitions, fill, border, title, lockBadge);
  return node;
}

export function tableNode(
  itemId: string,
  geometry: TableGeometry,
  style: TableStyle,
  preview = false,
): SVGGElement {
  const node = svgElement("g");
  const rowCount = geometry.rowHeights.length;
  const columnCount = geometry.columnWidths.length;
  node.setAttribute("role", "table");
  node.setAttribute(
    "aria-label",
    `Table, ${rowCount} ${rowCount === 1 ? "row" : "rows"} by ${columnCount} ${columnCount === 1 ? "column" : "columns"}`,
  );
  node.setAttribute("aria-rowcount", String(rowCount));
  node.setAttribute("aria-colcount", String(columnCount));
  node.setAttribute("opacity", String(style.opacity));
  node.dataset.tableRows = String(rowCount);
  node.dataset.tableColumns = String(columnCount);

  const definitions = svgElement("defs");
  node.append(definitions);
  const safeId = itemId.replace(/[^A-Za-z0-9_-]/gu, "-");
  let y = geometry.y;
  for (let row = 0; row < rowCount; row += 1) {
    const rowHeight = geometry.rowHeights[row] ?? 0;
    const rowGroup = svgElement("g");
    rowGroup.classList.add("table-row");
    rowGroup.setAttribute("role", "row");
    rowGroup.dataset.tableRow = String(row);
    let x = geometry.x;
    for (let column = 0; column < columnCount; column += 1) {
      const columnWidth = geometry.columnWidths[column] ?? 0;
      const value = geometry.cells[row]?.[column] ?? "";
      const isHeader = geometry.headerRow === true && row === 0;
      const clipId = `table-cell-${safeId}-${row}-${column}`;
      const clip = svgElement("clipPath");
      clip.id = clipId;
      const clipRect = svgElement("rect");
      clipRect.setAttribute("x", String(x + 1));
      clipRect.setAttribute("y", String(y + 1));
      clipRect.setAttribute("width", String(Math.max(0, columnWidth - 2)));
      clipRect.setAttribute("height", String(Math.max(0, rowHeight - 2)));
      clip.append(clipRect);
      definitions.append(clip);

      const cell = svgElement("g");
      cell.classList.add("table-cell");
      cell.dataset.tableCell = "true";
      cell.dataset.tableRow = String(row);
      cell.dataset.tableColumn = String(column);
      cell.setAttribute("role", isHeader ? "columnheader" : "cell");
      cell.setAttribute("aria-rowindex", String(row + 1));
      cell.setAttribute("aria-colindex", String(column + 1));
      cell.setAttribute(
        "aria-label",
        `${isHeader ? "Header" : "Cell"} row ${row + 1}, column ${column + 1}${value ? `: ${value}` : ", empty"}`,
      );

      const background = svgElement("rect");
      background.classList.add("table-cell-background");
      background.setAttribute("x", String(x));
      background.setAttribute("y", String(y));
      background.setAttribute("width", String(columnWidth));
      background.setAttribute("height", String(rowHeight));
      background.setAttribute("fill", isHeader ? style.headerFill : style.fill);
      background.setAttribute("stroke", style.borderColor);
      background.setAttribute("stroke-width", "1");
      background.setAttribute("vector-effect", "non-scaling-stroke");
      cell.append(background);

      const lines = wrapTableCellText(value, columnWidth, rowHeight, style.fontSize);
      const mathValue = value.length > 0 && containsMathMarkup(value);
      if (mathValue && !preview) {
        const math = mathForeignObject(
          x + TABLE_CELL_PADDING,
          y + TABLE_CELL_PADDING,
          columnWidth - TABLE_CELL_PADDING * 2,
          rowHeight - TABLE_CELL_PADDING * 2,
          value,
          style,
          "table-math-content",
          { defaultWeight: isHeader ? "700" : "500" },
        );
        math.setAttribute("clip-path", `url(#${clipId})`);
        cell.append(math);
      } else if (lines.length > 0) {
        const text = svgElement("text");
        text.classList.add("table-cell-text");
        if (mathValue) {
          text.classList.add("table-math-preview");
          text.setAttribute("aria-hidden", "true");
        }
        text.setAttribute("x", String(x + TABLE_CELL_PADDING));
        text.setAttribute("y", String(y + TABLE_CELL_PADDING + style.fontSize));
        text.setAttribute("fill", style.textColor);
        text.setAttribute("font-size", String(style.fontSize));
        applyTypography(text, style, isHeader ? "700" : "500");
        text.setAttribute("clip-path", `url(#${clipId})`);
        text.setAttribute("xml:space", "preserve");
        lines.forEach((line, index) => {
          appendLinkifiedLine(
            text,
            line,
            x + TABLE_CELL_PADDING,
            index > 0 ? `${TABLE_LINE_HEIGHT}em` : undefined,
          );
        });
        cell.append(text);
      }
      rowGroup.append(cell);
      x += columnWidth;
    }
    node.append(rowGroup);
    y += rowHeight;
  }
  return node;
}

export function wrapTableCellText(
  value: string,
  width: number,
  height: number,
  fontSize: number,
): string[] {
  if (!value) return [];
  const maxCharacters = Math.max(
    1,
    Math.floor(
      Math.max(1, width - TABLE_CELL_PADDING * 2) / Math.max(1, fontSize * TABLE_CHARACTER_WIDTH),
    ),
  );
  const maxLines = Math.max(
    1,
    Math.floor(
      Math.max(1, height - TABLE_CELL_PADDING * 2) / Math.max(1, fontSize * TABLE_LINE_HEIGHT),
    ),
  );
  const lines: string[] = [];
  for (const paragraph of value.split(/\r\n?|\n/u)) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/u).filter(Boolean);
    let current = "";
    for (const word of words) {
      const points = [...word];
      const chunks: string[] = /^https?:\/\/\S+$/iu.test(word) ? [word] : [];
      if (chunks.length === 0) {
        for (let index = 0; index < points.length; index += maxCharacters) {
          chunks.push(points.slice(index, index + maxCharacters).join(""));
        }
      }
      for (const chunk of chunks) {
        const candidate = current ? `${current} ${chunk}` : chunk;
        if ([...candidate].length <= maxCharacters) current = candidate;
        else {
          if (current) lines.push(current);
          current = chunk;
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines.slice(0, maxLines);
}

function imageNode(
  itemId: string,
  geometry: ImageGeometry,
  style: ImageStyle,
  loadImageAsset: (assetId: string) => Promise<string>,
): SVGGElement {
  const node = svgElement("g");
  const label = geometry.alt?.trim() || "Board image";
  const clipId = `image-clip-${itemId.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", label);
  node.setAttribute("opacity", String(style.opacity));
  node.dataset.assetId = geometry.assetId;
  node.dataset.imageState = "loading";

  const definitions = svgElement("defs");
  const clip = svgElement("clipPath");
  clip.id = clipId;
  const clipRect = svgElement("rect");
  clipRect.setAttribute("x", String(geometry.x));
  clipRect.setAttribute("y", String(geometry.y));
  clipRect.setAttribute("width", String(geometry.width));
  clipRect.setAttribute("height", String(geometry.height));
  clipRect.setAttribute(
    "rx",
    String(Math.min(style.radius, geometry.width / 2, geometry.height / 2)),
  );
  clip.append(clipRect);
  definitions.append(clip);

  const background = svgElement("rect");
  background.classList.add("image-card-background");
  background.setAttribute("x", String(geometry.x));
  background.setAttribute("y", String(geometry.y));
  background.setAttribute("width", String(geometry.width));
  background.setAttribute("height", String(geometry.height));
  background.setAttribute(
    "rx",
    String(Math.min(style.radius, geometry.width / 2, geometry.height / 2)),
  );

  const image = svgElement("image");
  image.classList.add("image-card-content");
  image.setAttribute("x", String(geometry.x));
  image.setAttribute("y", String(geometry.y));
  image.setAttribute("width", String(geometry.width));
  image.setAttribute("height", String(geometry.height));
  image.setAttribute("preserveAspectRatio", "xMidYMid meet");
  image.setAttribute("clip-path", `url(#${clipId})`);
  image.setAttribute("visibility", "hidden");
  image.setAttribute("aria-hidden", "true");

  const fallback = svgElement("g");
  fallback.classList.add("image-card-fallback");
  fallback.dataset.imageFallback = "true";
  fallback.setAttribute("aria-hidden", "true");
  const fallbackMark = svgElement("path");
  const centerX = geometry.x + geometry.width / 2;
  const centerY = geometry.y + geometry.height / 2;
  const markSize = Math.max(8, Math.min(24, geometry.width / 6, geometry.height / 6));
  fallbackMark.setAttribute(
    "d",
    `M ${centerX - markSize} ${centerY + markSize / 2} l ${markSize * 0.65} -${markSize * 0.75} l ${markSize * 0.45} ${markSize * 0.45} l ${markSize * 0.5} -${markSize * 0.65} l ${markSize * 0.75} ${markSize} Z`,
  );
  const fallbackText = svgElement("text");
  fallbackText.setAttribute("x", String(centerX));
  fallbackText.setAttribute("y", String(centerY + markSize * 1.45));
  fallbackText.setAttribute("text-anchor", "middle");
  fallbackText.textContent = "Loading image…";
  fallback.append(fallbackMark, fallbackText);

  const border = svgElement("rect");
  border.classList.add("image-card-border");
  border.setAttribute("x", String(geometry.x));
  border.setAttribute("y", String(geometry.y));
  border.setAttribute("width", String(geometry.width));
  border.setAttribute("height", String(geometry.height));
  border.setAttribute(
    "rx",
    String(Math.min(style.radius, geometry.width / 2, geometry.height / 2)),
  );
  border.setAttribute("pointer-events", "none");

  node.append(definitions, background, image, fallback, border);
  void loadImageAsset(geometry.assetId)
    .then((url) => {
      if (!node.isConnected) return;
      image.setAttribute("href", url);
      image.setAttribute("visibility", "visible");
      fallback.setAttribute("display", "none");
      node.dataset.imageState = "ready";
    })
    .catch(() => {
      if (!node.isConnected) return;
      image.removeAttribute("href");
      image.setAttribute("visibility", "hidden");
      fallback.removeAttribute("display");
      fallbackText.textContent = "Image unavailable";
      node.dataset.imageState = "error";
    });
  return node;
}

function stickyNode(geometry: StickyGeometry, style: StickyStyle, preview = false): SVGSVGElement {
  const node = svgElement("svg");
  node.setAttribute("x", String(geometry.x));
  node.setAttribute("y", String(geometry.y));
  node.setAttribute("width", String(geometry.width));
  node.setAttribute("height", String(geometry.height));
  node.setAttribute("viewBox", `0 0 ${geometry.width} ${geometry.height}`);
  node.setAttribute("overflow", "hidden");

  const background = svgElement("rect");
  background.classList.add("sticky-background");
  background.setAttribute("x", "0");
  background.setAttribute("y", "0");
  background.setAttribute("width", String(geometry.width));
  background.setAttribute("height", String(geometry.height));
  background.setAttribute("rx", String(STICKY_CORNER_RADIUS));
  background.setAttribute("fill", style.fill);

  const mathText = containsMathMarkup(geometry.text);
  const typesetMathText = mathText && !preview;
  const text = typesetMathText
    ? mathForeignObject(
        STICKY_PADDING,
        STICKY_PADDING,
        geometry.width - STICKY_PADDING * 2,
        geometry.height - STICKY_PADDING * 2,
        geometry.text,
        style,
        "sticky-text sticky-math-content",
      )
    : svgElement("text");
  text.classList.add("sticky-text");
  if (!typesetMathText) {
    const plainText = text as SVGTextElement;
    if (mathText) {
      plainText.classList.add("sticky-math-preview");
      plainText.setAttribute("aria-hidden", "true");
    }
    plainText.setAttribute("x", String(STICKY_PADDING));
    plainText.setAttribute("y", String(STICKY_PADDING + style.fontSize));
    plainText.setAttribute("fill", style.textColor);
    plainText.setAttribute("font-size", String(style.fontSize));
    applyTypography(plainText, style);
    plainText.setAttribute("xml:space", "preserve");
    for (const [index, line] of wrapStickyText(
      geometry.text,
      geometry.width,
      geometry.height,
      style.fontSize,
    ).entries()) {
      appendLinkifiedLine(
        plainText,
        line,
        STICKY_PADDING,
        index > 0 ? `${STICKY_LINE_HEIGHT}em` : undefined,
      );
    }
  }
  node.setAttribute("opacity", String(style.opacity));
  node.append(background, text);
  return node;
}

export function stampNode(geometry: StampGeometry, style: StampStyle): SVGGElement {
  const node = svgElement("g");
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", `${stampLabel(geometry.stamp)} stamp`);
  node.setAttribute("opacity", String(style.opacity));

  const art = svgElement("g");
  const scale = geometry.size / 24;
  art.classList.add("stamp-art", `stamp-art-${geometry.stamp}`);
  art.setAttribute(
    "transform",
    `translate(${geometry.x - geometry.size / 2} ${geometry.y - geometry.size / 2}) scale(${scale})`,
  );

  if (geometry.stamp === "star") {
    art.append(filledStampPath(STAMP_SVG_PATHS.star, style.color));
  } else if (geometry.stamp === "heart") {
    art.append(filledStampPath(STAMP_SVG_PATHS.heart, style.color));
  } else if (geometry.stamp === "check") {
    art.append(strokedStampPath(STAMP_SVG_PATHS.check, style.color, "2.8"));
  } else if (geometry.stamp === "question") {
    art.append(strokedStampPath(STAMP_SVG_PATHS.question, style.color, "2.4"));
    const dot = svgElement("circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "17.6");
    dot.setAttribute("r", "1.2");
    dot.setAttribute("fill", style.color);
    art.append(dot);
  } else if (geometry.stamp === "smile") {
    const face = svgElement("circle");
    face.setAttribute("cx", "12");
    face.setAttribute("cy", "12");
    face.setAttribute("r", "9");
    face.setAttribute("fill", "none");
    face.setAttribute("stroke", style.color);
    face.setAttribute("stroke-width", "2");
    const leftEye = svgElement("circle");
    leftEye.setAttribute("cx", "8.5");
    leftEye.setAttribute("cy", "10");
    leftEye.setAttribute("r", "1.2");
    leftEye.setAttribute("fill", style.color);
    const rightEye = svgElement("circle");
    rightEye.setAttribute("cx", "15.5");
    rightEye.setAttribute("cy", "10");
    rightEye.setAttribute("r", "1.2");
    rightEye.setAttribute("fill", style.color);
    art.append(
      face,
      leftEye,
      rightEye,
      strokedStampPath(STAMP_SVG_PATHS.smileMouth, style.color, "2"),
    );
  } else {
    art.append(filledStampPath(STAMP_SVG_PATHS.sparkle, style.color));
  }

  node.append(art);
  return node;
}

function filledStampPath(data: string, color: string): SVGPathElement {
  const path = svgElement("path");
  path.setAttribute("d", data);
  path.setAttribute("fill", color);
  return path;
}

function strokedStampPath(data: string, color: string, width: string): SVGPathElement {
  const path = svgElement("path");
  path.setAttribute("d", data);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", color);
  path.setAttribute("stroke-width", width);
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  return path;
}

function stampLabel(stamp: StampKind): string {
  const labels: Record<StampKind, string> = {
    star: "Star",
    check: "Check",
    heart: "Heart",
    question: "Question mark",
    smile: "Smile",
    sparkle: "Sparkle",
  };
  return labels[stamp];
}

export function wrapStickyText(
  value: string,
  width: number,
  height: number,
  fontSize: number,
): string[] {
  const maxCharacters = Math.max(
    1,
    Math.floor(
      Math.max(1, width - STICKY_PADDING * 2) / Math.max(1, fontSize * STICKY_CHARACTER_WIDTH),
    ),
  );
  const maxLines = Math.max(
    1,
    Math.floor(
      Math.max(1, height - STICKY_PADDING * 2) / Math.max(1, fontSize * STICKY_LINE_HEIGHT),
    ),
  );
  const lines: string[] = [];
  for (const paragraph of value.split(/\r\n?|\n/u)) {
    const words = paragraph.trim().split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const codePoints = [...word];
      const chunks: string[] = /^https?:\/\/\S+$/iu.test(word) ? [word] : [];
      if (chunks.length === 0) {
        for (let index = 0; index < codePoints.length; index += maxCharacters) {
          chunks.push(codePoints.slice(index, index + maxCharacters).join(""));
        }
      }
      for (const chunk of chunks) {
        const candidate = current ? `${current} ${chunk}` : chunk;
        if ([...candidate].length <= maxCharacters) {
          current = candidate;
        } else {
          if (current) lines.push(current);
          current = chunk;
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines.slice(0, maxLines);
}

function shapeNode(
  kind: "line" | "rectangle" | "ellipse" | "polygon",
  geometry: LineGeometry | BoxGeometry | PolygonGeometry,
  style: LineStyle | StrokeStyle,
): SVGGraphicsElement {
  if (kind !== "line" && "visiblePaths" in geometry && geometry.visiblePaths !== undefined) {
    const path = svgElement("path");
    path.setAttribute("d", outlinePath(visibleOutlinePaths(kind, geometry as OutlineGeometry)));
    setStroke(path, style);
    return path;
  }
  let node: SVGGraphicsElement;
  if (kind === "line") {
    node = lineNode(geometry as LineGeometry, style as LineStyle);
  } else if (kind === "rectangle") {
    const rect = svgElement("rect");
    const value = geometry as BoxGeometry;
    rect.setAttribute("x", String(value.x));
    rect.setAttribute("y", String(value.y));
    rect.setAttribute("width", String(value.width));
    rect.setAttribute("height", String(value.height));
    rect.setAttribute("rx", "2");
    node = rect;
  } else if (kind === "ellipse") {
    const ellipse = svgElement("ellipse");
    const value = geometry as BoxGeometry;
    ellipse.setAttribute("cx", String(value.x + value.width / 2));
    ellipse.setAttribute("cy", String(value.y + value.height / 2));
    ellipse.setAttribute("rx", String(value.width / 2));
    ellipse.setAttribute("ry", String(value.height / 2));
    node = ellipse;
  } else {
    const polygon = svgElement("polygon");
    polygon.setAttribute(
      "points",
      polygonPoints(geometry as PolygonGeometry)
        .map((point) => point.join(","))
        .join(" "),
    );
    node = polygon;
  }
  setStroke(node, style);
  return node;
}

export function lineNode(geometry: LineGeometry, style: LineStyle): SVGGElement {
  const group = svgElement("g");
  let shaft: SVGGraphicsElement;
  if (geometry.visiblePaths) {
    const path = svgElement("path");
    path.setAttribute("d", outlinePath(visibleOutlinePaths("line", geometry)));
    shaft = path;
  } else {
    const line = svgElement("line");
    line.setAttribute("x1", String(geometry.x1));
    line.setAttribute("y1", String(geometry.y1));
    line.setAttribute("x2", String(geometry.x2));
    line.setAttribute("y2", String(geometry.y2));
    shaft = line;
  }
  shaft.classList.add("connector-shaft");
  setStroke(shaft, style);
  group.append(shaft);

  const terminalVisible =
    geometry.visiblePaths === undefined ||
    geometry.visiblePaths.some((path) => {
      const endpoint = path.at(-1);
      return endpoint?.[0] === geometry.x2 && endpoint[1] === geometry.y2;
    });
  if (style.arrowhead === "arrow" && terminalVisible) {
    const points = lineArrowheadPoints(geometry, style.width);
    if (points) {
      const [left, tip, right] = points;
      const arrowhead = svgElement("path");
      arrowhead.classList.add("connector-arrowhead");
      arrowhead.setAttribute(
        "d",
        `M ${left[0]} ${left[1]} L ${tip[0]} ${tip[1]} L ${right[0]} ${right[1]}`,
      );
      setStroke(arrowhead, style);
      group.append(arrowhead);
    }
  }
  return group;
}

export function protractorNode(geometry: ProtractorGeometry, style: ProtractorStyle): SVGGElement {
  const group = svgElement("g");
  group.classList.add("digital-protractor");
  group.setAttribute("role", "img");
  group.setAttribute("aria-label", "180 degree protractor");
  const radius = geometry.radius;

  const body = svgElement("path");
  body.classList.add("protractor-body");
  body.setAttribute("d", `M ${-radius} 0 A ${radius} ${radius} 0 0 1 ${radius} 0 L ${-radius} 0 Z`);
  body.setAttribute("fill", style.color);
  body.setAttribute("fill-opacity", String(Math.min(0.16, style.opacity * 0.16)));
  body.setAttribute("stroke", style.color);
  body.setAttribute("stroke-opacity", String(style.opacity));
  body.setAttribute("stroke-width", "2");
  body.setAttribute("vector-effect", "non-scaling-stroke");

  const tickPath = svgElement("path");
  tickPath.classList.add("protractor-ticks");
  const ticks: string[] = [];
  for (let degrees = 0; degrees <= 180; degrees += 5) {
    const radians = (degrees * Math.PI) / 180;
    const tickLength = degrees % 10 === 0 ? 15 : 8;
    const outer: Point = [Math.cos(radians) * radius, -Math.sin(radians) * radius];
    const inner: Point = [
      Math.cos(radians) * (radius - tickLength),
      -Math.sin(radians) * (radius - tickLength),
    ];
    ticks.push(`M ${outer[0]} ${outer[1]} L ${inner[0]} ${inner[1]}`);
  }
  tickPath.setAttribute("d", ticks.join(" "));
  tickPath.setAttribute("fill", "none");
  tickPath.setAttribute("stroke", style.color);
  tickPath.setAttribute("stroke-opacity", String(style.opacity));
  tickPath.setAttribute("stroke-width", "1");
  tickPath.setAttribute("vector-effect", "non-scaling-stroke");

  const center = svgElement("circle");
  center.classList.add("protractor-center");
  center.setAttribute("cx", "0");
  center.setAttribute("cy", "0");
  center.setAttribute("r", "5");
  center.setAttribute("fill", "none");
  center.setAttribute("stroke", style.color);
  center.setAttribute("stroke-width", "2");
  center.setAttribute("vector-effect", "non-scaling-stroke");
  group.append(body, tickPath, center);

  for (let degrees = 10; degrees < 180; degrees += 10) {
    const radians = (degrees * Math.PI) / 180;
    const text = svgElement("text");
    text.classList.add("protractor-label");
    text.setAttribute("x", String(Math.cos(radians) * (radius - 27)));
    text.setAttribute("y", String(-Math.sin(radians) * (radius - 27) + 3));
    text.setAttribute("fill", style.color);
    text.setAttribute("fill-opacity", String(style.opacity));
    text.setAttribute("font-size", "9");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("pointer-events", "none");
    text.textContent = String(degrees);
    group.append(text);
  }
  return group;
}

function setStroke(node: SVGGraphicsElement, style: StrokeStyle | LineStyle): void {
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", style.color);
  node.setAttribute("stroke-width", String(style.width));
  node.setAttribute("stroke-opacity", String(style.opacity));
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
}

function pencilPath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const point = points[0] as Point;
    return `M ${point[0]} ${point[1]} l 0.01 0`;
  }
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${point[1]}`)
    .join(" ");
}

function outlinePath(paths: readonly (readonly Point[])[]): string {
  return paths
    .map((points) => pencilPath(points))
    .filter(Boolean)
    .join(" ");
}

function matrixAttribute(matrix: Matrix): string {
  return `matrix(${matrix.join(" ")})`;
}

function layer(id: string, label: string): SVGGElement {
  const group = svgElement("g");
  group.id = id;
  group.setAttribute("aria-label", label);
  return group;
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, name);
}

function actorColor(actorId: string): string {
  const palette = ["#e5484d", "#8e4ec6", "#3e63dd", "#0d9488", "#ca8a04", "#d946ef", "#ea580c"];
  let hash = 0;
  for (const char of actorId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] ?? (palette[0] as string);
}

function previewStyle(value: unknown, fallback: string): StrokeStyle {
  if (isRecord(value)) {
    return {
      kind: "stroke",
      color: typeof value.color === "string" ? value.color : fallback,
      width: numberOr(value.width, 3),
      opacity: numberOr(value.opacity, 0.7),
    };
  }
  return { kind: "stroke", color: fallback, width: 3, opacity: 0.7 };
}

function previewLineStyle(value: unknown, fallback: string): LineStyle {
  const stroke = previewStyle(value, fallback);
  return {
    kind: "line",
    color: stroke.color,
    width: stroke.width,
    opacity: stroke.opacity,
    arrowhead: isRecord(value) && value.arrowhead === "arrow" ? "arrow" : "none",
  };
}

function asPoints(value: unknown): Point[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point) => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      typeof point[0] !== "number" ||
      typeof point[1] !== "number"
    )
      return [];
    return [[point[0], point[1]] as Point];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

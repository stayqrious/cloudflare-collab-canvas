import {
  type CanonicalSnapshot,
  createCanonicalSnapshot,
  serializeCanonicalSnapshot,
} from "@collab/board-core";
import { MAX_CANONICAL_EXPORT_BYTES } from "@collab/protocol";

import { BoardModel } from "../board/model";
import { BoardRenderer, type ImageAssetLoader } from "../board/renderer";

const VIEWER_STYLE_ID = "spacescale-read-only-viewer-styles";
const EXPORT_TOO_LARGE_MESSAGE = `The Space export is larger than ${Math.ceil(
  MAX_CANONICAL_EXPORT_BYTES / (1024 * 1024),
)} MiB.`;
const ZOOM_FACTOR = 1.2;

export const SPACE_VIEWER_CSS = `
.space-viewer {
  --viewer-ink: #20201e;
  --viewer-muted: #6f6d66;
  --viewer-line: #dedbd2;
  --viewer-surface: rgba(255, 255, 255, 0.94);
  --viewer-canvas: #fbfaf7;
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: 100%;
  min-width: 0;
  min-height: 360px;
  height: 100%;
  overflow: hidden;
  color: var(--viewer-ink);
  background: var(--viewer-canvas);
  font: 14px/1.4 "Rubik Variable", Rubik, ui-sans-serif, system-ui, sans-serif;
}

.space-viewer__header {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 54px;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--viewer-line);
  background: var(--viewer-surface);
  backdrop-filter: blur(16px);
}

.space-viewer__identity {
  min-width: 0;
}

.space-viewer__identity strong,
.space-viewer__identity span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.space-viewer__identity strong {
  font-size: 14px;
  font-weight: 760;
}

.space-viewer__identity span {
  color: var(--viewer-muted);
  font-size: 11px;
}

.space-viewer__controls {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.space-viewer__controls button {
  display: inline-grid;
  place-items: center;
  min-width: 34px;
  height: 34px;
  padding: 0 9px;
  border: 1px solid var(--viewer-line);
  border-radius: 9px;
  color: var(--viewer-ink);
  background: #fff;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}

.space-viewer__controls button:hover {
  background: #f3f1eb;
}

.space-viewer__zoom {
  min-width: 52px;
  color: var(--viewer-muted);
  text-align: center;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.space-viewer__body {
  position: relative;
  z-index: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
}

.space-viewer--manual .space-viewer__body {
  grid-template-columns: minmax(230px, 300px) minmax(0, 1fr);
}

.space-viewer__source {
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-height: 0;
  padding: 14px;
  border-right: 1px solid var(--viewer-line);
  background: #fff;
}

.space-viewer__source label {
  font-size: 12px;
  font-weight: 750;
}

.space-viewer__source textarea {
  min-height: 140px;
  flex: 1 1 auto;
  resize: vertical;
  padding: 10px;
  border: 1px solid var(--viewer-line);
  border-radius: 9px;
  color: var(--viewer-ink);
  background: #fbfaf7;
  font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.space-viewer__source-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.space-viewer__source-actions button,
.space-viewer__file-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 11px;
  border: 1px solid var(--viewer-line);
  border-radius: 9px;
  color: var(--viewer-ink);
  background: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.space-viewer__source-actions button {
  border-color: #20201e;
  color: #fff;
  background: #20201e;
}

.space-viewer__file-label input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

.space-viewer__source-status {
  min-height: 18px;
  margin: 0;
  color: var(--viewer-muted);
  font-size: 11px;
}

.space-viewer__source-status[data-error="true"] {
  color: #b42318;
}

.space-viewer__canvas-host {
  position: relative;
  z-index: 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--viewer-canvas);
}

.space-viewer__canvas-host .board-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  background: var(--viewer-canvas);
  cursor: grab;
}

.space-viewer__canvas-host .board-canvas[data-panning="true"] {
  cursor: grabbing;
}

.space-viewer__canvas-host .canvas-background {
  opacity: 0.62;
}

.space-viewer__canvas-host .board-item {
  pointer-events: visiblePainted;
}

.space-viewer__canvas-host .board-item-sticky .sticky-background {
  filter: drop-shadow(0 2px 2px rgb(66 52 25 / 14%));
}

.space-viewer__canvas-host .board-item-zone .zone-fill {
  filter: drop-shadow(0 2px 3px rgb(62 72 106 / 7%));
}

.space-viewer__canvas-host .board-item-stamp .stamp-art {
  filter: drop-shadow(0 2px 1.5px rgb(32 32 30 / 18%));
}

.space-viewer__canvas-host :is(
  .board-item-text,
  .board-item-sticky .sticky-text,
  .board-item-table .table-cell-text,
  .board-item-zone .zone-title
) {
  pointer-events: auto !important;
  cursor: text;
  user-select: text !important;
  -webkit-user-select: text !important;
}

.space-viewer__canvas-host .creator-badge,
.space-viewer__canvas-host .selection-layer,
.space-viewer__canvas-host .remote-preview-layer,
.space-viewer__canvas-host .local-preview-layer,
.space-viewer__canvas-host .cursor-layer {
  pointer-events: none;
}

.space-viewer__empty {
  position: absolute;
  inset: 50% auto auto 50%;
  width: min(320px, calc(100% - 48px));
  transform: translate(-50%, -50%);
  color: var(--viewer-muted);
  text-align: center;
  pointer-events: none;
}

.space-viewer__empty strong {
  display: block;
  margin-bottom: 5px;
  color: var(--viewer-ink);
}

.space-viewer__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 700px) {
  .space-viewer--manual .space-viewer__body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(300px, 1fr);
    overflow: auto;
  }

  .space-viewer__source {
    max-height: 250px;
    border-right: 0;
    border-bottom: 1px solid var(--viewer-line);
  }

  .space-viewer__source textarea {
    min-height: 90px;
  }

  .space-viewer__header {
    gap: 8px;
    padding-left: 12px;
  }

  .space-viewer__identity span {
    display: none;
  }
}
`;

export class SpaceViewerExportError extends Error {
  override readonly name = "SpaceViewerExportError";
}

export const VIEWER_ASSET_TOKEN_HEADER = "X-SpaceScale-Viewer-Asset-Token";

/** Reads the short-lived image capability returned by a successful signed viewer exchange. */
export function viewerAssetTokenFromSessionResponse(response: Pick<Response, "headers">): string {
  const token = response.headers.get(VIEWER_ASSET_TOKEN_HEADER);
  if (token === null || !/^vas1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
    throw new SpaceViewerExportError("The signed viewer image session is missing or invalid.");
  }
  return token;
}

/**
 * Creates a memory-only loader for private R2 images. The viewer capability is
 * sent in an Authorization header and cannot authenticate any editing route.
 */
export function createSignedViewerImageAssetLoader(
  token: string,
  fetcher: typeof fetch = globalThis.fetch,
): ImageAssetLoader {
  if (!/^vas1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
    throw new SpaceViewerExportError("The signed viewer image session is invalid.");
  }
  return async (assetId) => {
    if (!/^asset_[A-Za-z0-9_-]{43}$/u.test(assetId)) {
      throw new SpaceViewerExportError("The Space image identifier is invalid.");
    }
    const response = await fetcher(`/api/v1/viewer/assets/${encodeURIComponent(assetId)}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "image/*", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new SpaceViewerExportError(
        `The Space image request failed with HTTP ${response.status}.`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new SpaceViewerExportError("The Space image response is invalid.");
    }
    return response.blob();
  };
}

export interface ReadOnlySpaceViewerOptions {
  /** A canonical `cf-whiteboard-json` export to render immediately. */
  export?: unknown;
  /** Show local textarea and file controls for a user-provided export. */
  manualInput?: boolean;
  /** Resolves board image assets. Omit it to show the renderer's image placeholder. */
  loadImageAsset?: ImageAssetLoader;
  /** Optional display-name lookup for creator badges. */
  resolveCreatorName?: (actorId: string) => string | undefined;
  /** Fit all content after each successful load. Defaults to true. */
  fitOnLoad?: boolean;
}

/**
 * Strictly validates and canonicalises the authoritative JSON export consumed by the viewer.
 * Both a parsed object and the raw JSON string returned by the export API are accepted.
 */
export function parseCanonicalSpaceExport(input: unknown): CanonicalSnapshot {
  let candidate = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > MAX_CANONICAL_EXPORT_BYTES) {
      throw new SpaceViewerExportError(EXPORT_TOO_LARGE_MESSAGE);
    }
    try {
      candidate = JSON.parse(input) as unknown;
    } catch (error) {
      throw new SpaceViewerExportError("The Space export is not valid JSON.", { cause: error });
    }
  }

  if (!isRecord(candidate)) {
    throw new SpaceViewerExportError("The Space export must be a JSON object.");
  }
  if (candidate.format !== "cf-whiteboard-json" || candidate.version !== 1) {
    throw new SpaceViewerExportError(
      'Expected a version 1 canonical export with format "cf-whiteboard-json".',
    );
  }

  try {
    const canonical = createCanonicalSnapshot({
      boardId: candidate.boardId as string,
      seq: candidate.seq as number,
      createdAt: candidate.createdAt as number,
      settings: candidate.settings as { title: string },
      items: candidate.items as CanonicalSnapshot["items"],
    });
    // The serializer applies the same byte ceiling as the export endpoint and
    // gives callers a detached, canonical object rather than retaining input references.
    return JSON.parse(serializeCanonicalSnapshot(canonical)) as CanonicalSnapshot;
  } catch (error) {
    if (error instanceof SpaceViewerExportError) throw error;
    throw new SpaceViewerExportError("The Space export does not match the canonical schema.", {
      cause: error,
    });
  }
}

/** Collects all human-readable board content in paint/table order for explicit copying. */
export function copyableTextFromCanonicalSpace(snapshot: CanonicalSnapshot): string {
  const text: string[] = [];
  for (const item of snapshot.items) {
    if (item.kind === "text" || item.kind === "sticky") {
      text.push(item.geometry.text);
    } else if (item.kind === "zone") {
      text.push(item.geometry.title);
    } else if (item.kind === "table") {
      for (const row of item.geometry.cells) text.push(...row);
    } else if (item.kind === "image" && item.geometry.alt !== undefined) {
      text.push(item.geometry.alt);
    }
  }
  return text
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n");
}

/**
 * Consumes an already-fetched canonical export response. This helper performs no network request;
 * integration code remains responsible for applying the signed bearer assertion to its fetch.
 */
export async function readCanonicalSpaceExportResponse(
  response: Pick<Response, "ok" | "status" | "headers" | "text">,
): Promise<CanonicalSnapshot> {
  if (!response.ok) {
    throw new SpaceViewerExportError(
      `The Space export request failed with HTTP ${response.status}.`,
    );
  }
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CANONICAL_EXPORT_BYTES) {
    throw new SpaceViewerExportError(EXPORT_TOO_LARGE_MESSAGE);
  }
  return parseCanonicalSpaceExport(await response.text());
}

/** Reads a canonical export from a local file without uploading it anywhere. */
export async function readCanonicalSpaceExportFile(
  file: Pick<Blob, "size" | "text">,
): Promise<CanonicalSnapshot> {
  if (file.size > MAX_CANONICAL_EXPORT_BYTES) {
    throw new SpaceViewerExportError(EXPORT_TOO_LARGE_MESSAGE);
  }
  return parseCanonicalSpaceExport(await file.text());
}

export function installReadOnlySpaceViewerStyles(target: Document = document): void {
  if (target.getElementById(VIEWER_STYLE_ID)) return;
  const style = target.createElement("style");
  style.id = VIEWER_STYLE_ID;
  style.textContent = SPACE_VIEWER_CSS;
  target.head.append(style);
}

export function zoomFromWheel(currentZoom: number, deltaY: number): number {
  if (!Number.isFinite(currentZoom) || !Number.isFinite(deltaY)) return currentZoom;
  return currentZoom * Math.exp(-deltaY * 0.0015);
}

export function pointerStartsViewerPan(input: {
  button: number;
  pointerType: string;
  target: EventTarget | null;
  spacePressed: boolean;
}): boolean {
  if (input.button === 1) return true;
  if (input.button !== 0) return false;
  if (input.pointerType === "touch" || input.spacePressed) return true;
  return !isSelectableTextTarget(input.target);
}

/**
 * A local-only viewer for a canonical export. It deliberately has no mutation,
 * persistence, websocket, participant, or board-management dependencies.
 */
export class ReadOnlySpaceViewer {
  readonly root: HTMLElement;
  readonly model = new BoardModel();
  readonly renderer: BoardRenderer;

  private readonly title: HTMLElement;
  private readonly metadata: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly emptyState: HTMLElement;
  private readonly sourceStatus: HTMLElement | null;
  private readonly jsonInput: HTMLTextAreaElement | null;
  private readonly fitOnLoad: boolean;
  private readonly cleanups: Array<() => void> = [];
  private currentExport: CanonicalSnapshot | null = null;
  private activePointerId: number | null = null;
  private previousPointer: { x: number; y: number } | null = null;
  private spacePressed = false;

  constructor(container: HTMLElement, options: ReadOnlySpaceViewerOptions = {}) {
    this.fitOnLoad = options.fitOnLoad !== false;

    this.root = container.ownerDocument.createElement("section");
    this.root.className = `space-viewer${options.manualInput ? " space-viewer--manual" : ""}`;
    this.root.dataset.testid = "read-only-space-viewer";
    this.root.innerHTML = viewerMarkup(Boolean(options.manualInput));
    container.replaceChildren(this.root);

    this.title = required(this.root, "[data-viewer-title]", HTMLElement);
    this.metadata = required(this.root, "[data-viewer-metadata]", HTMLElement);
    this.zoomLabel = required(this.root, "[data-viewer-zoom]", HTMLElement);
    this.copyButton = required(this.root, "[data-viewer-copy-text]", HTMLButtonElement);
    this.emptyState = required(this.root, "[data-viewer-empty]", HTMLElement);
    this.sourceStatus = this.root.querySelector<HTMLElement>("[data-viewer-source-status]");
    this.jsonInput = this.root.querySelector<HTMLTextAreaElement>("[data-viewer-json]");

    const canvasHost = required(this.root, "[data-viewer-canvas]", HTMLElement);
    this.renderer = new BoardRenderer(
      canvasHost,
      this.model,
      options.loadImageAsset ?? unavailableImageAsset,
      options.resolveCreatorName,
    );
    this.renderer.setSelection([]);
    this.renderer.svg.classList.add("space-viewer-canvas");
    this.renderer.svg.dataset.tool = "pan";
    this.renderer.svg.setAttribute("aria-readonly", "true");
    this.renderer.svg.setAttribute("role", "region");
    this.renderer.svg.setAttribute(
      "aria-label",
      "Read-only Space. Drag blank areas to pan, use the zoom controls, or use Copy text.",
    );
    this.renderer.svg.removeAttribute("aria-describedby");

    this.bindViewerControls();
    this.bindViewportGestures();
    this.cleanups.push(
      this.renderer.viewport.subscribe((zoom) => {
        this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      }),
    );

    if (options.export !== undefined) this.loadExport(options.export);
  }

  get snapshot(): CanonicalSnapshot | null {
    return this.currentExport === null ? null : structuredClone(this.currentExport);
  }

  loadExport(input: unknown): CanonicalSnapshot {
    const snapshot = parseCanonicalSpaceExport(input);
    this.model.load({
      format: "cf-whiteboard-json",
      version: 1,
      boardId: snapshot.boardId,
      seq: snapshot.seq,
      createdAt: snapshot.createdAt,
      items: snapshot.items,
    });
    this.currentExport = snapshot;
    this.title.textContent = snapshot.settings.title || "Untitled Space";
    this.metadata.textContent = `${snapshot.items.length} ${snapshot.items.length === 1 ? "object" : "objects"} · read only`;
    this.emptyState.hidden = snapshot.items.length > 0;
    this.copyButton.disabled = copyableTextFromCanonicalSpace(snapshot).length === 0;
    this.copyButton.textContent = "Copy text";
    this.copyButton.setAttribute("aria-label", "Copy all Space text");
    this.setSourceStatus("Loaded successfully", false);
    if (this.jsonInput) this.jsonInput.value = JSON.stringify(snapshot, null, 2);
    if (this.fitOnLoad) this.fitSoon();
    return structuredClone(snapshot);
  }

  async loadApiResponse(
    response: Pick<Response, "ok" | "status" | "headers" | "text">,
  ): Promise<CanonicalSnapshot> {
    return this.loadExport(await readCanonicalSpaceExportResponse(response));
  }

  async loadFile(file: Pick<Blob, "size" | "text">): Promise<CanonicalSnapshot> {
    return this.loadExport(await readCanonicalSpaceExportFile(file));
  }

  fitView(): void {
    this.renderer.viewport.fit(this.model.boundsFor(this.model.items.keys()));
  }

  zoomIn(): void {
    this.zoomBy(ZOOM_FACTOR);
  }

  zoomOut(): void {
    this.zoomBy(1 / ZOOM_FACTOR);
  }
  async copyText(): Promise<boolean> {
    if (this.currentExport === null) return false;
    const text = copyableTextFromCanonicalSpace(this.currentExport);
    if (text.length === 0) return false;
    return copyTextWithFallback(this.root.ownerDocument, text);
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.renderer.destroy();
    this.root.remove();
  }

  private bindViewerControls(): void {
    const zoomIn = required(this.root, "[data-viewer-zoom-in]", HTMLButtonElement);
    const zoomOut = required(this.root, "[data-viewer-zoom-out]", HTMLButtonElement);
    const fit = required(this.root, "[data-viewer-fit]", HTMLButtonElement);
    this.listen(zoomIn, "click", () => this.zoomIn());
    this.listen(zoomOut, "click", () => this.zoomOut());
    this.listen(fit, "click", () => this.fitView());
    this.listen(this.copyButton, "click", () => {
      this.copyButton.disabled = true;
      void this.copyText()
        .then((copied) => {
          this.copyButton.textContent = copied ? "Copied" : "Copy unavailable";
        })
        .finally(() => {
          this.copyButton.disabled =
            this.currentExport === null ||
            copyableTextFromCanonicalSpace(this.currentExport).length === 0;
        });
    });

    const loadButton = this.root.querySelector<HTMLButtonElement>("[data-viewer-load-json]");
    if (loadButton && this.jsonInput) {
      this.listen(loadButton, "click", () => {
        try {
          this.loadExport(this.jsonInput?.value ?? "");
        } catch (error) {
          this.setSourceStatus(exportErrorMessage(error), true);
        }
      });
    }

    const fileInput = this.root.querySelector<HTMLInputElement>("[data-viewer-file]");
    if (fileInput) {
      this.listen(fileInput, "change", () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        void this.loadFile(file).catch((error: unknown) => {
          this.setSourceStatus(exportErrorMessage(error), true);
        });
      });
    }
  }

  private bindViewportGestures(): void {
    const svg = this.renderer.svg;
    this.listen(
      svg,
      "wheel",
      (rawEvent) => {
        const event = rawEvent as WheelEvent;
        event.preventDefault();
        this.renderer.viewport.zoomAt(
          event.clientX,
          event.clientY,
          zoomFromWheel(this.renderer.viewport.zoom, event.deltaY),
        );
      },
      { passive: false },
    );

    this.listen(svg, "pointerdown", (rawEvent) => {
      const event = rawEvent as PointerEvent;
      if (
        !pointerStartsViewerPan({
          button: event.button,
          pointerType: event.pointerType,
          target: event.target,
          spacePressed: this.spacePressed,
        })
      ) {
        return;
      }
      event.preventDefault();
      this.activePointerId = event.pointerId;
      this.previousPointer = { x: event.clientX, y: event.clientY };
      svg.dataset.panning = "true";
      svg.setPointerCapture(event.pointerId);
    });

    this.listen(svg, "pointermove", (rawEvent) => {
      const event = rawEvent as PointerEvent;
      if (event.pointerId !== this.activePointerId || this.previousPointer === null) return;
      this.renderer.viewport.panByPixels(
        event.clientX - this.previousPointer.x,
        event.clientY - this.previousPointer.y,
      );
      this.previousPointer = { x: event.clientX, y: event.clientY };
    });

    const endPointer = (rawEvent: Event): void => {
      const event = rawEvent as PointerEvent;
      if (event.pointerId !== this.activePointerId) return;
      if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
      this.activePointerId = null;
      this.previousPointer = null;
      delete svg.dataset.panning;
    };
    this.listen(svg, "pointerup", endPointer);
    this.listen(svg, "pointercancel", endPointer);

    this.listen(svg, "keydown", (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === " ") {
        this.spacePressed = true;
        event.preventDefault();
      } else if (event.key === "+" || event.key === "=") {
        this.zoomIn();
        event.preventDefault();
      } else if (event.key === "-") {
        this.zoomOut();
        event.preventDefault();
      } else if (event.key === "0") {
        this.fitView();
        event.preventDefault();
      }
    });
    this.listen(svg, "keyup", (rawEvent) => {
      if ((rawEvent as KeyboardEvent).key === " ") this.spacePressed = false;
    });
    this.listen(svg, "blur", () => {
      this.spacePressed = false;
    });
  }

  private zoomBy(factor: number): void {
    const rect = this.renderer.svg.getBoundingClientRect();
    this.renderer.viewport.zoomAt(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      this.renderer.viewport.zoom * factor,
    );
  }

  private fitSoon(): void {
    const schedule =
      globalThis.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => {
        callback(0);
        return 0;
      });
    schedule(() => this.fitView());
  }

  private setSourceStatus(message: string, error: boolean): void {
    if (!this.sourceStatus) return;
    this.sourceStatus.textContent = message;
    this.sourceStatus.dataset.error = String(error);
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener, options);
    this.cleanups.push(() => target.removeEventListener(type, listener, options));
  }
}

async function copyTextWithFallback(documentValue: Document, text: string): Promise<boolean> {
  const clipboard = documentValue.defaultView?.navigator.clipboard;
  if (clipboard?.writeText !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Browser policy may deny Clipboard API access; use the local selection fallback.
    }
  }

  const textarea = documentValue.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  documentValue.body.append(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = documentValue.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }
  return copied;
}

export function createReadOnlySpaceViewer(
  container: HTMLElement,
  options: ReadOnlySpaceViewerOptions = {},
): ReadOnlySpaceViewer {
  return new ReadOnlySpaceViewer(container, options);
}

function viewerMarkup(manualInput: boolean): string {
  return `
    <header class="space-viewer__header">
      <div class="space-viewer__identity">
        <strong data-viewer-title>Read-only Space</strong>
        <span data-viewer-metadata>No export loaded · read only</span>
      </div>
      <div class="space-viewer__controls" aria-label="View controls">
        <button type="button" data-viewer-zoom-out aria-label="Zoom out">−</button>
        <span class="space-viewer__zoom" data-viewer-zoom aria-live="polite">100%</span>
        <button type="button" data-viewer-zoom-in aria-label="Zoom in">+</button>
        <button type="button" data-viewer-fit>Fit</button>
        <button type="button" data-viewer-copy-text disabled>Copy text</button>
      </div>
    </header>
    <div class="space-viewer__body">
      ${manualInput ? manualInputMarkup() : ""}
      <div class="space-viewer__canvas-host" data-viewer-canvas>
        <div class="space-viewer__empty" data-viewer-empty>
          <strong>No Space loaded</strong>
          ${manualInput ? "Paste or choose a canonical JSON export to view it." : "Waiting for a canonical JSON export."}
        </div>
      </div>
    </div>
  `;
}

function manualInputMarkup(): string {
  return `
    <section class="space-viewer__source" aria-label="Open a Space export">
      <label for="space-viewer-json">Canonical Space JSON</label>
      <textarea id="space-viewer-json" data-viewer-json spellcheck="false" placeholder='{"format":"cf-whiteboard-json",...}'></textarea>
      <div class="space-viewer__source-actions">
        <button type="button" data-viewer-load-json>View JSON</button>
        <label class="space-viewer__file-label">
          Choose file
          <input type="file" accept=".json,application/json" data-viewer-file>
        </label>
      </div>
      <p class="space-viewer__source-status" data-viewer-source-status aria-live="polite"></p>
      <p class="space-viewer__sr-only">The file remains in this browser and is not uploaded.</p>
    </section>
  `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSelectableTextTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return (
    target.closest(
      ".board-item-text, .board-item-sticky .sticky-text, .board-item-table .table-cell-text, .board-item-zone .zone-title",
    ) !== null
  );
}

function exportErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Space export could not be loaded.";
}

async function unavailableImageAsset(): Promise<Blob> {
  throw new SpaceViewerExportError("No image asset loader is configured for this viewer.");
}

function required<T extends Element>(
  root: ParentNode,
  selector: string,
  elementType: { new (): T },
): T {
  const value = root.querySelector(selector);
  if (!(value instanceof elementType)) throw new Error(`Missing viewer element: ${selector}`);
  return value;
}

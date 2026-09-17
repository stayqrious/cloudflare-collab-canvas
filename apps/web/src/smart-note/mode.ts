import type { BoardRenderer } from "../board/renderer";
import type { ToolController } from "../tools/controller";
import type { Point, SpotlightViewState, ToolName } from "../types";
import {
  A5_CORNERS,
  A5_PAGE,
  type Calibration,
  CORNER_NAMES,
  calibrate,
  pageTransform,
  toClient,
  toPage,
  validateCorner,
  type WritingArea,
} from "./calibration";

const SVG_NS = "http://www.w3.org/2000/svg";

export class SmartNoteMode {
  private readonly dialog = document.createElement("dialog");
  private readonly stage: HTMLElement;
  private readonly status: HTMLElement;
  private readonly originalParent: HTMLElement;
  private readonly originalNext: ChildNode | null;
  private savedView: SpotlightViewState | null = null;
  private savedTool: ToolName = "pencil";
  private corners: Point[] = [];
  private pendingTap: { id: number; point: Point } | null = null;
  private environment = "";
  private timer: number | null = null;
  private ownsFullscreen = false;

  constructor(
    private readonly renderer: BoardRenderer,
    private readonly tools: ToolController,
    undo: () => void,
    disableForEveryone: () => void,
  ) {
    this.originalParent = renderer.svg.parentElement as HTMLElement;
    this.originalNext = renderer.svg.nextSibling;
    this.dialog.className = "smart-note-dialog";
    this.dialog.setAttribute("aria-labelledby", "smart-note-title");
    this.dialog.innerHTML = `
      <div class="smart-note-stage" data-testid="smart-note-stage"></div>
      <aside class="smart-note-guide">
        <span class="smart-note-eyebrow">SHARED A5 PAGE · 148 × 210 mm</span>
        <h2 id="smart-note-title">Calibrate your paper</h2>
        <p class="smart-note-status" role="status" aria-live="polite"></p>
        <svg class="smart-note-illustration" viewBox="0 0 220 300" role="img" aria-label="A5 paper with four corners. Tap top-left, top-right, bottom-right, then bottom-left on your physical paper.">
          <rect x="22" y="15" width="176" height="255" rx="4" fill="#e3e9db"/>
          <rect x="28" y="20" width="164" height="244" fill="white" stroke="#8a9980"/>
          <path d="M48 66H170 M48 92H170 M48 118H170 M48 144H170 M48 170H170 M48 196H170 M48 222H170" stroke="#e3e9db" stroke-width="2"/>
          <text x="110" y="48" text-anchor="middle" fill="#647157" font-size="12">Your A5 paper</text>
          <g data-guide-corner="0"><circle cx="28" cy="20" r="8"/><text x="45" y="38">1</text></g>
          <g data-guide-corner="1"><circle cx="192" cy="20" r="8"/><text x="166" y="38">2</text></g>
          <g data-guide-corner="2"><circle cx="192" cy="264" r="8"/><text x="166" y="250">3</text></g>
          <g data-guide-corner="3"><circle cx="28" cy="264" r="8"/><text x="45" y="250">4</text></g>
          <text x="110" y="290" text-anchor="middle" fill="#647157" font-size="11">Tap the paper, not this picture</text>
        </svg>
        <p class="smart-note-help">Use full screen if your pen maps to the whole display. Every corner must land inside this window. Your four ink dots will stay on the shared page.</p>
      </aside>
      <section class="smart-note-controls" aria-label="Smart Note controls" data-note-controls>
        <div class="smart-note-save"><strong>Smart Note · shared A5</strong><span data-note-save></span></div>
        <nav aria-label="Smart Note tools">
          <button type="button" data-note-pen data-note-active disabled>Pen</button>
          <button type="button" data-note-undo data-note-active disabled>Undo</button>
          <button type="button" data-note-calibrate>Restart calibration</button>
          <button type="button" data-note-fullscreen>Use full screen</button>
          <button type="button" data-note-disable hidden>Turn off for everyone</button>
        </nav>
      </section>`;
    this.stage = this.element<HTMLElement>(".smart-note-stage");
    this.status = this.element<HTMLElement>(".smart-note-status");
    this.element("[data-note-disable]").addEventListener("click", disableForEveryone);
    this.element("[data-note-calibrate]").addEventListener("click", () => this.startCalibration());
    this.element("[data-note-fullscreen]").addEventListener("click", () => void this.fullscreen());
    this.element("[data-note-pen]").addEventListener("click", () => this.setTool("pencil"));
    this.element("[data-note-undo]").addEventListener("click", undo);
    this.dialog.addEventListener("pointerdown", this.onTapDown, true);
    this.dialog.addEventListener("pointerup", this.onTapUp, true);
    this.dialog.addEventListener(
      "click",
      (event) => {
        // A pen tap outside the page must not activate a toolbar button either.
        if (event instanceof PointerEvent && event.pointerType === "pen") {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    this.dialog.addEventListener(
      "pointercancel",
      (event) => {
        if (this.pendingTap?.id === event.pointerId) this.pendingTap = null;
        this.routePen(event);
      },
      true,
    );
    this.dialog.addEventListener(
      "pointermove",
      (event) => {
        this.checkEnvironment();
        // A hovering pen can write through the floating mouse controls, including the top edge.
        this.dialog.dataset.pen = String(event.pointerType === "pen");
        this.routePen(event);
      },
      true,
    );
    this.dialog.addEventListener("focusin", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-note-controls]"))
        this.dialog.dataset.pen = "false";
    });
    this.dialog.addEventListener("keydown", (event) => {
      if (
        this.dialog.dataset.state === "calibrating" &&
        (event.ctrlKey || event.metaKey) &&
        ["z", "y"].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault(); // A participant cannot bypass the shared mode with Escape.
    });
    this.dialog.addEventListener("close", () => this.restore());
    document.body.append(this.dialog);
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.dialog.querySelector<T>(selector);
    if (!element) throw new Error(`Missing Smart Note control: ${selector}`);
    return element;
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  sync(enabled: boolean, canManage: boolean): void {
    this.element("[data-note-disable]").hidden = !canManage;
    if (enabled) this.open();
    else if (this.isOpen) this.close();
  }

  open(): void {
    if (this.isOpen) return;
    this.savedView = this.renderer.viewport.viewState;
    this.savedTool = this.tools.tool;
    this.dialog.showModal();
    this.startCalibration();
    this.timer = window.setInterval(() => this.checkEnvironment(), 300);
  }

  updateSaveStatus(label: string): void {
    this.element("[data-note-save]").textContent = label;
  }
  notify(message: string): void {
    if (this.isOpen && this.dialog.dataset.state === "active")
      this.element("[data-note-save]").textContent = message;
  }

  close(): void {
    this.restore();
    this.dialog.close();
    if (this.ownsFullscreen && document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    this.ownsFullscreen = false;
  }
  destroy(): void {
    this.close();
    this.dialog.remove();
  }

  private async fullscreen(): Promise<void> {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        this.ownsFullscreen = true;
      }
      if (this.isOpen) this.startCalibration();
    } catch {
      this.status.textContent =
        "Full screen is unavailable here. Use your browser’s full-screen command, or map your tablet inside this window, then restart calibration.";
    }
  }

  private available(): WritingArea {
    const rect = this.stage.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  private fingerprint(): string {
    return JSON.stringify([
      innerWidth,
      innerHeight,
      window.screenX,
      window.screenY,
      devicePixelRatio,
      screen.width,
      screen.height,
      screen.orientation?.angle,
      window.visualViewport?.scale,
      window.visualViewport?.offsetLeft,
      window.visualViewport?.offsetTop,
      this.available(),
    ]);
  }

  private checkEnvironment(): boolean {
    if (!this.isOpen || this.environment === this.fingerprint()) return false;
    this.startCalibration();
    return true;
  }

  private restoreCanvas(): void {
    this.tools.cancelActiveGesture();
    this.renderer.svg.querySelector("[data-page-corners]")?.remove();
    this.renderer.svg.removeAttribute("data-smart-note");
    for (const property of ["left", "top", "width", "height", "transform"])
      this.renderer.svg.style.removeProperty(property);
    this.originalParent.insertBefore(this.renderer.svg, this.originalNext);
    this.renderer.viewport.setFixedPage(null);
  }

  private restore(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.pendingTap = null;
    if (!this.savedView) return;
    this.restoreCanvas();
    this.renderer.viewport.setViewState(this.savedView);
    this.tools.setTool(this.savedTool);
    this.savedView = null;
  }

  private startCalibration(): void {
    this.restoreCanvas();
    this.stage.replaceChildren();
    this.corners = [];
    this.pendingTap = null;
    this.dialog.dataset.state = "calibrating";
    this.dialog.dataset.pen = "false";
    this.setActiveControls(false);
    this.environment = this.fingerprint();
    this.showStep();
  }

  private showStep(): void {
    this.dialog.dataset.invalid = "false";
    this.status.textContent = `Step ${this.corners.length + 1} of 4: Tap the ${CORNER_NAMES[this.corners.length]} corner on your paper. Lift the pen after each dot.`;
    for (const dot of this.dialog.querySelectorAll<SVGGElement>("[data-guide-corner]")) {
      const index = Number(dot.dataset.guideCorner);
      dot.dataset.current = String(index === this.corners.length);
      dot.dataset.done = String(index < this.corners.length);
    }
  }

  private rejectMark(message: string): void {
    this.dialog.dataset.invalid = "true";
    this.status.textContent = `${message} Tap the ${CORNER_NAMES[this.corners.length]} corner on your physical paper. The red dot shows which corner to mark.`;
  }

  private routePen(event: PointerEvent): boolean {
    if (this.dialog.dataset.state !== "active" || event.pointerType !== "pen") return false;
    // Use the original trusted event even when contact starts on a floating control,
    // without relying on the driver delivering a hover to change hit testing first.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.tools.handleFixedPagePen(event);
    return true;
  }

  private readonly onTapDown = (event: PointerEvent): void => {
    if (this.checkEnvironment()) {
      event.stopImmediatePropagation();
      return;
    }
    if (this.routePen(event) || this.dialog.dataset.state !== "calibrating") return;
    if (event.button !== 0 || event.pointerType === "touch" || this.pendingTap) return;
    if (
      event.pointerType !== "pen" &&
      event.target instanceof Element &&
      event.target.closest("[data-note-controls]")
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.pendingTap = { id: event.pointerId, point: [event.clientX, event.clientY] };
    this.dialog.setPointerCapture(event.pointerId);
  };

  private readonly onTapUp = (event: PointerEvent): void => {
    if (this.checkEnvironment()) {
      event.stopImmediatePropagation();
      return;
    }
    if (this.routePen(event)) return;
    const tap = this.pendingTap;
    if (!tap || tap.id !== event.pointerId || this.dialog.dataset.state !== "calibrating") return;
    this.pendingTap = null;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.dialog.hasPointerCapture(event.pointerId))
      this.dialog.releasePointerCapture(event.pointerId);
    const error = validateCorner(this.corners, tap.point, this.available());
    if (error) {
      this.rejectMark(error);
      return;
    }
    const calibration =
      this.corners.length === 3 ? calibrate([...this.corners, tap.point], this.available()) : null;
    if (this.corners.length === 3 && !calibration) {
      this.rejectMark("Those marks do not form a full A5 page.");
      return;
    }
    this.corners.push(tap.point);
    const marker = document.createElement("span");
    marker.className = "smart-note-marker";
    marker.dataset.measuredCorner = String(this.corners.length - 1);
    const rect = this.available();
    marker.style.left = `${tap.point[0] - rect.left}px`;
    marker.style.top = `${tap.point[1] - rect.top}px`;
    this.stage.append(marker);
    if (this.corners.length < 4) {
      this.showStep();
      return;
    }
    if (calibration) this.activate(calibration);
  };

  private activate(calibration: Calibration): void {
    this.tools.cancelActiveGesture();
    this.tools.selectOnly([]);
    this.dialog.dataset.state = "active";
    this.dialog.dataset.invalid = "false";
    const { svg } = this.renderer;
    this.stage.replaceChildren(svg);
    svg.dataset.smartNote = "true";
    // The stage covers the entire viewport. No toolbar height or browser-chrome guess is added.
    const rect = this.available();
    svg.style.left = `${-rect.left}px`;
    svg.style.top = `${-rect.top}px`;
    svg.style.width = `${A5_PAGE.width}px`;
    svg.style.height = `${A5_PAGE.height}px`;
    svg.style.transform = pageTransform(calibration);
    this.renderer.viewport.setFixedPage(A5_PAGE, {
      toBoard: (x, y) => toPage(calibration, x, y),
      toClient: (point) => toClient(calibration, point),
    });
    const marks = document.createElementNS(SVG_NS, "g");
    marks.dataset.pageCorners = "true";
    marks.setAttribute("aria-label", "Four inked paper corners");
    marks.setAttribute("pointer-events", "none");
    for (const [index, [x, y]] of A5_CORNERS.entries()) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.dataset.pageCorner = String(index);
      dot.setAttribute("cx", String(x));
      dot.setAttribute("cy", String(y));
      dot.setAttribute("r", "6");
      dot.setAttribute("fill", "#26351b");
      marks.append(dot);
    }
    svg.append(marks);
    this.setTool("pencil");
    this.setActiveControls(true);
    this.element("[data-note-calibrate]").textContent = "Recalibrate";
    svg.focus({ preventScroll: true });
  }

  private setTool(tool: "pencil"): void {
    this.tools.setTool(tool);
    this.element("[data-note-pen]").setAttribute(
      "aria-pressed",
      String(this.tools.tool === "pencil"),
    );
  }

  private setActiveControls(active: boolean): void {
    for (const element of this.dialog.querySelectorAll<HTMLButtonElement>("[data-note-active]"))
      element.disabled = !active;
    this.element("[data-note-calibrate]").textContent = active
      ? "Recalibrate"
      : "Restart calibration";
  }
}

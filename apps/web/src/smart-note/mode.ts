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
const pointerPosition = (event: PointerEvent) => ({
  client: [event.clientX, event.clientY],
  screen: [event.screenX, event.screenY],
  pointerType: event.pointerType,
});
type PointerPosition = ReturnType<typeof pointerPosition>;

export class SmartNoteMode {
  private readonly dialog = document.createElement("div");
  private readonly stage: HTMLElement;
  private readonly status: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly paper = document.createElement("div");
  private enabled = false;
  private calibration: Calibration | null = null;
  private pendingMouse: PointerEvent | null = null;
  private suppressMouseClick = false;
  private warnedOutsidePage = false;
  private savedView: SpotlightViewState | null = null;
  private savedTool: ToolName = "pencil";
  private corners: Point[] = [];
  private pendingTap: {
    id: number;
    point: Point;
    down: PointerPosition;
    lastMove?: PointerPosition;
  } | null = null;
  private environment = "";
  private timer: number | null = null;
  private ownsFullscreen = false;
  private verificationRound = 0;
  private readonly measurements: { phase: string; corners: Point[]; maximumShift?: number }[] = [];
  private readonly contacts: {
    phase: string;
    down: PointerPosition;
    lastMove?: PointerPosition;
    up: PointerPosition;
  }[] = [];
  private renderedCorners: Point[] = [];

  constructor(
    private readonly renderer: BoardRenderer,
    private readonly tools: ToolController,
    disableForEveryone: () => void,
    private readonly onStateChanged: () => void,
    private readonly notify: (message: string) => void,
  ) {
    this.workspace = renderer.svg.closest<HTMLElement>(".workspace") as HTMLElement;
    this.paper.className = "smart-note-paper";
    this.paper.hidden = true;
    renderer.svg.before(this.paper);
    this.dialog.className = "smart-note-dialog";
    this.dialog.hidden = true;
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-labelledby", "smart-note-title");
    this.dialog.innerHTML = `
      <div class="smart-note-stage" data-testid="smart-note-stage"></div>
      <aside class="smart-note-guide">
        <span class="smart-note-eyebrow">SHARED A5 PAGE · 148 × 210 mm</span>
        <h2 id="smart-note-title">Calibrate your paper</h2>
        <p class="smart-note-status" role="status" aria-live="polite"></p>
      <div class="smart-note-calibration-actions" data-note-controls>
        <button class="primary-button" type="button" data-note-fullscreen>Use full screen</button>
        <button type="button" data-note-calibrate>Restart calibration</button>
        <button type="button" data-note-details>Copy calibration details</button>
        <button type="button" data-note-disable hidden>Turn off for everyone</button>
      </div>
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
      </aside>`;
    this.stage = this.element<HTMLElement>(".smart-note-stage");
    this.status = this.element<HTMLElement>(".smart-note-status");
    this.element("[data-note-disable]").addEventListener("click", disableForEveryone);
    this.element("[data-note-calibrate]").addEventListener("click", () => this.startCalibration());
    this.element("[data-note-fullscreen]").addEventListener("click", () => void this.fullscreen());
    this.element("[data-note-details]").addEventListener("click", () => {
      void navigator.clipboard
        .writeText(
          JSON.stringify(
            {
              environment: JSON.parse(this.fingerprint()),
              measurements: this.measurements,
              contacts: this.contacts,
              renderedCorners: this.renderedCorners,
              corners: this.calibration?.corners,
            },
            null,
            2,
          ),
        )
        .then(
          () => this.notify("Calibration details copied."),
          () => this.notify("Could not copy calibration details. Check clipboard permission."),
        );
    });
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
      window.addEventListener(type, this.onDrawingPointer, true);
    window.addEventListener("click", this.onPenClick, true);
    window.addEventListener("keydown", this.onCalibrationKeyDown, true);
    document.body.append(this.dialog);
  }

  private element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.dialog.querySelector<T>(selector);
    if (!element) throw new Error(`Missing Smart Note control: ${selector}`);
    return element;
  }

  get isOpen(): boolean {
    return this.enabled;
  }

  sync(enabled: boolean, canManage: boolean): void {
    this.element("[data-note-disable]").hidden = !canManage;
    if (enabled && !this.enabled) this.open();
    else if (!enabled && this.enabled) this.close();
  }

  open(): void {
    if (!this.enabled) {
      this.savedView = this.renderer.viewport.viewState;
      this.savedTool = this.tools.tool;
      this.enabled = true;
      this.timer = window.setInterval(() => this.checkEnvironment(), 300);
    }
    this.startCalibration();
  }

  close(): void {
    this.enabled = false;
    this.restore();
    this.dialog.hidden = true;
    delete this.workspace.dataset.smartNote;
    if (this.ownsFullscreen && document.fullscreenElement)
      void document.exitFullscreen().catch(() => {});
    this.ownsFullscreen = false;
  }
  destroy(): void {
    this.close();
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"])
      window.removeEventListener(type, this.onDrawingPointer, true);
    window.removeEventListener("click", this.onPenClick, true);
    window.removeEventListener("keydown", this.onCalibrationKeyDown, true);
    this.dialog.remove();
    this.paper.remove();
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
        "Full screen is unavailable. You can still calibrate inside this window if all four paper corners are reachable.";
    }
  }

  private available(): WritingArea {
    return { left: 0, top: 0, width: innerWidth, height: innerHeight };
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
      Boolean(document.fullscreenElement),
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
    this.calibration = null;
    this.pendingMouse = null;
    this.suppressMouseClick = false;
    this.warnedOutsidePage = false;
    this.paper.hidden = true;
    for (const property of ["left", "top", "width", "height", "transform"])
      this.renderer.svg.style.removeProperty(property);
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
    this.verificationRound = 0;
    // This overlay never takes or restores focus. Verification and writing keep
    // the rendered page, its focus, and the pointer capture target unchanged.
    this.dialog.hidden = false;
    this.dialog.dataset.state = "calibrating";
    this.workspace.dataset.smartNote = this.dialog.dataset.state;
    this.element("[data-note-fullscreen]").hidden = Boolean(document.fullscreenElement);

    this.environment = this.fingerprint();
    this.showStep();
    this.onStateChanged();
  }

  private showStep(): void {
    this.dialog.dataset.invalid = "false";
    const verifying = this.dialog.dataset.state === "verifying";
    this.element("#smart-note-title").textContent = verifying
      ? "Check the paper alignment"
      : "Calibrate your paper";
    this.status.textContent = verifying
      ? `${this.verificationRound > 1 ? "The pen positions shifted, so the page has been remapped. " : "The page is now in writing mode. "}Check ${this.corners.length + 1} of 4: Tap the same ${CORNER_NAMES[this.corners.length]} ink dot on your paper again. Do not aim for the screen corner.`
      : `Step ${this.corners.length + 1} of 4: Tap the ${CORNER_NAMES[this.corners.length]} corner on your paper. Lift the pen after each dot.`;
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

  private readonly onCalibrationKeyDown = (event: KeyboardEvent): void => {
    if (this.dialog.hidden) return;
    // Focus stays on the canvas during verification; board shortcuts must not
    // mutate drawings while the guide is up. Preserve setup-button activation,
    // keyboard navigation, and browser shortcuts such as F11/reload.
    event.stopImmediatePropagation();
    const control = event.target instanceof Element && event.target.closest("[data-note-controls]");
    if (
      ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) ||
      (!control &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !["Tab", "F11"].includes(event.key))
    )
      event.preventDefault();
  };

  private readonly onPenClick = (event: MouseEvent): void => {
    if (this.suppressMouseClick) {
      this.suppressMouseClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!this.enabled) return;
    if (this.dialog.hidden && (!(event instanceof PointerEvent) || event.pointerType !== "pen"))
      return;
    if (
      !this.dialog.hidden &&
      event.target instanceof Element &&
      event.target.closest("[data-note-controls]")
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onDrawingPointer = (event: Event): void => {
    if (!(event instanceof PointerEvent) || !this.enabled) return;
    if (!this.dialog.hidden) {
      if (event.type === "pointerdown") this.onTapDown(event);
      else if (event.type === "pointerup") this.onTapUp(event);
      else if (event.type === "pointercancel" && this.pendingTap?.id === event.pointerId) {
        this.pendingTap = null;
        if (document.documentElement.hasPointerCapture(event.pointerId))
          document.documentElement.releasePointerCapture(event.pointerId);
      }
      // No ink, selection, or panning can start behind the calibration guide.
      if (event.type === "pointermove") {
        if (this.pendingTap?.id === event.pointerId)
          this.pendingTap.lastMove = pointerPosition(event);
        event.stopImmediatePropagation();
      }
      return;
    }
    if (!this.calibration || this.checkEnvironment()) return;
    if (
      event.type === "pointerdown" &&
      event.pointerType === "pen" &&
      event.button === 0 &&
      !this.warnedOutsidePage
    ) {
      const [x, y] = toPage(this.calibration, event.clientX, event.clientY);
      if (x < 0 || y < 0 || x > A5_PAGE.width || y > A5_PAGE.height) {
        this.warnedOutsidePage = true;
        this.notify(
          "That pen mark is outside the calibrated A5 page and was not saved. Use Recalibrate and tap the four existing ink dots on your paper.",
        );
      }
    }
    const target = event.target;
    if (event.pointerType === "touch") return;
    const control =
      target instanceof Element &&
      target.closest(
        "button, input, select, textarea, a, [role='dialog'], .drawer, .floating-menu",
      );
    // Mouse-emulating tablet drivers must also reach the top edge. Defer a mouse
    // contact on a control until it moves: a click remains a normal UI action,
    // while a drag becomes ink starting at the original pen-down coordinate.
    if (event.pointerType !== "pen") {
      if (event.type === "pointerdown") {
        this.suppressMouseClick = false;
        this.pendingMouse = null;
        if (control && event.button === 0) {
          const [x, y] = toPage(this.calibration, event.clientX, event.clientY);
          if (x >= 0 && y >= 0 && x <= A5_PAGE.width && y <= A5_PAGE.height)
            this.pendingMouse = event;
          return;
        }
      }
      if (this.pendingMouse?.pointerId === event.pointerId) {
        const down = this.pendingMouse;
        if (event.type === "pointerup" || event.type === "pointercancel") {
          this.pendingMouse = null;
          return;
        }
        if (
          event.type !== "pointermove" ||
          !(event.buttons & 1) ||
          Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < 3
        )
          return;
        this.pendingMouse = null;
        this.suppressMouseClick = true;
        this.tools.handleFixedPageInput(down);
      }
      if (control && !document.documentElement.hasPointerCapture(event.pointerId)) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.tools.handleFixedPageInput(event);
  };

  private readonly onTapDown = (event: PointerEvent): void => {
    if (this.checkEnvironment()) {
      event.stopImmediatePropagation();
      return;
    }
    if (this.dialog.hidden) return;
    if (event.button !== 0 || event.pointerType === "touch" || this.pendingTap) return;
    if (
      event.pointerType !== "pen" &&
      event.target instanceof Element &&
      event.target.closest("[data-note-controls]")
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.renderer.svg.focus({ preventScroll: true });
    this.pendingTap = {
      id: event.pointerId,
      point: [event.clientX, event.clientY],
      down: pointerPosition(event),
    };
    document.documentElement.setPointerCapture(event.pointerId);
  };

  private readonly onTapUp = (event: PointerEvent): void => {
    if (this.checkEnvironment()) {
      event.stopImmediatePropagation();
      return;
    }
    const tap = this.pendingTap;
    if (!tap || tap.id !== event.pointerId || this.dialog.hidden) return;
    this.pendingTap = null;
    this.contacts.push({
      phase: this.dialog.dataset.state ?? "",
      down: tap.down,
      lastMove: tap.lastMove,
      up: pointerPosition(event),
    });
    if (this.contacts.length > 48) this.contacts.shift();
    event.preventDefault();
    event.stopImmediatePropagation();
    if (document.documentElement.hasPointerCapture(event.pointerId))
      document.documentElement.releasePointerCapture(event.pointerId);
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
    if (!calibration) return;
    const previous = this.calibration;
    const maximumShift = previous
      ? Math.max(
          ...calibration.corners.map(([x, y], index) => {
            const point = previous.corners[index] as Point;
            return Math.hypot(x - point[0], y - point[1]);
          }),
        )
      : undefined;
    this.measurements.push({
      phase: this.dialog.dataset.state ?? "",
      corners: calibration.corners,
      maximumShift,
    });
    if (this.measurements.length > 12) this.measurements.shift();
    // Four independently repeated marks must agree with the displayed page.
    // Do not trim input against unverified bounds or guess a toolbar offset.
    if (maximumShift !== undefined && maximumShift <= 6) {
      this.dialog.hidden = true;
      this.dialog.dataset.state = "complete";
      this.workspace.dataset.smartNote = "active";
      this.onStateChanged();
      return;
    }
    this.activate(calibration);
    this.verificationRound++;
    this.corners = [];
    this.stage.replaceChildren();
    this.dialog.dataset.state = "verifying";
    this.showStep();
  };

  private activate(calibration: Calibration): void {
    this.tools.cancelActiveGesture();
    this.tools.selectOnly([]);
    this.workspace.dataset.smartNote = "verifying";
    this.calibration = calibration;
    this.dialog.dataset.invalid = "false";
    const { svg } = this.renderer;
    svg.dataset.smartNote = "true";
    // The stage covers the entire viewport. No toolbar height or browser-chrome guess is added.
    svg.style.left = "0px";
    svg.style.top = "0px";
    svg.style.width = `${A5_PAGE.width}px`;
    svg.style.height = `${A5_PAGE.height}px`;
    svg.style.transform = pageTransform(calibration);
    this.paper.style.transform = pageTransform(calibration);
    this.paper.hidden = false;
    this.renderer.viewport.setFixedPage(A5_PAGE, {
      toBoard: (x, y) => toPage(calibration, x, y),
      toClient: (point) => toClient(calibration, point),
    });
    svg.querySelector("[data-page-corners]")?.remove();
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
    this.renderedCorners = [...marks.children].map((dot) => {
      const rect = dot.getBoundingClientRect();
      return [rect.x + rect.width / 2, rect.y + rect.height / 2];
    });
    this.tools.setTool("pencil");
    this.onStateChanged();
    svg.focus({ preventScroll: true });
  }
}

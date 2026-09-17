import type { BoardRenderer } from "../board/renderer";
import type { ToolController } from "../tools/controller";
import type { Point, SpotlightViewState, ToolName } from "../types";
import {
  A5_PAGE,
  CALIBRATION_KEY,
  type Calibration,
  calibrate,
  parseCalibration,
  type WritingArea,
} from "./calibration";

export class SmartNoteMode {
  private readonly dialog = document.createElement("dialog");
  private readonly stage: HTMLElement;
  private readonly status: HTMLElement;
  private readonly reuse: HTMLButtonElement;
  private readonly marker: HTMLElement;
  private readonly originalParent: HTMLElement;
  private readonly originalNext: ChildNode | null;
  private savedView: SpotlightViewState | null = null;
  private savedTool: ToolName = "pencil";
  private first: Point | null = null;
  private calibration: Calibration | null = null;
  private environment = "";
  private timer: number | null = null;

  constructor(
    private readonly renderer: BoardRenderer,
    private readonly tools: ToolController,
    undo: () => void,
  ) {
    this.originalParent = renderer.svg.parentElement as HTMLElement;
    this.originalNext = renderer.svg.nextSibling;
    this.dialog.className = "smart-note-dialog";
    this.dialog.setAttribute("aria-labelledby", "smart-note-title");
    this.dialog.innerHTML = `
      <header class="smart-note-header">
        <div><strong id="smart-note-title">Smart Note</strong><span>A5 · 148 × 210 mm · shared page · <small data-note-save></small></span></div>
        <nav aria-label="Smart Note controls">
          <button type="button" data-note-pen data-note-active disabled>Pen</button>
          <button type="button" data-note-eraser data-note-active disabled>Eraser</button>
          <button type="button" data-note-undo data-note-active disabled>Undo</button>
          <button type="button" data-note-reuse disabled>Use saved calibration</button>
          <button type="button" data-note-calibrate>Recalibrate</button>
          <button type="button" data-note-exit>Exit Smart Note</button>
        </nav>
      </header>
      <p class="smart-note-status" role="status" aria-live="polite"></p>
      <div class="smart-note-stage" data-testid="smart-note-stage">
        <div class="smart-note-guide"><strong>Write on paper. See it here.</strong>
          <p>Set your Huion driver to absolute pen mode and portrait orientation. Map the full A5 paper into the area below this message, then tap the paper corners with your pen.</p>
          <p>If a corner lands outside this window, adjust the driver’s working area. Two corners cannot correct a rotated or cropped paper area.</p>
        </div>
        <span class="smart-note-marker" hidden aria-hidden="true"></span>
      </div>`;
    this.stage = this.element<HTMLElement>(".smart-note-stage");
    this.status = this.element<HTMLElement>(".smart-note-status");
    this.reuse = this.element<HTMLButtonElement>("[data-note-reuse]");
    this.marker = this.element<HTMLElement>(".smart-note-marker");
    this.element<HTMLElement>("[data-note-exit]").addEventListener("click", () => this.close());
    this.element<HTMLElement>("[data-note-calibrate]").addEventListener("click", () =>
      this.startCalibration(),
    );
    this.element<HTMLElement>("[data-note-pen]").addEventListener("click", () =>
      this.setTool("pencil"),
    );
    this.element<HTMLElement>("[data-note-eraser]").addEventListener("click", () =>
      this.setTool("eraser"),
    );
    this.element<HTMLElement>("[data-note-undo]").addEventListener("click", undo);
    this.reuse.addEventListener("click", () => {
      if (this.calibration) this.activate(this.calibration);
    });
    this.stage.addEventListener("pointerup", this.markCorner);
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      this.stage.addEventListener(
        type,
        (event) => {
          if (this.dialog.dataset.state === "active" && this.environment !== this.fingerprint()) {
            event.stopImmediatePropagation();
            this.startCalibration();
            this.status.textContent =
              "Window or display changed. Tap the top-left paper corner again.";
          }
        },
        true,
      );
    }
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener("close", () => this.restore());
    document.body.append(this.dialog);
  }

  private element<T extends HTMLElement>(selector: string): T {
    const element = this.dialog.querySelector<T>(selector);
    if (!element) throw new Error(`Missing Smart Note control: ${selector}`);
    return element;
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    if (this.isOpen) return;
    this.savedView = this.renderer.viewport.viewState;
    this.savedTool = this.tools.tool;
    this.dialog.showModal();
    this.startCalibration();
    this.timer = window.setInterval(() => {
      if (this.environment !== this.fingerprint()) {
        this.startCalibration();
        this.status.textContent =
          "Window or display changed. Tap the top-left paper corner again to recalibrate.";
      }
    }, 300);
  }

  updateSaveStatus(label: string): void {
    this.element<HTMLElement>("[data-note-save]").textContent = label;
  }

  notify(message: string): void {
    if (this.isOpen) this.status.textContent = message;
  }

  close(): void {
    this.restore();
    this.dialog.close();
  }
  destroy(): void {
    this.close();
    this.dialog.remove();
  }

  private available(): WritingArea {
    const rect = this.stage.getBoundingClientRect();
    return {
      left: rect.left + 12,
      top: rect.top + 12,
      width: rect.width - 24,
      height: rect.height - 24,
    };
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

  private restoreCanvas(): void {
    this.tools.cancelActiveGesture();
    this.renderer.svg.removeAttribute("data-smart-note");
    for (const property of ["left", "top", "width", "height"])
      this.renderer.svg.style.removeProperty(property);
    this.originalParent.insertBefore(this.renderer.svg, this.originalNext);
    this.renderer.viewport.setFixedPage(null);
  }

  private restore(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (!this.savedView) return;
    this.restoreCanvas();
    this.renderer.viewport.setViewState(this.savedView);
    this.tools.setTool(this.savedTool);
    this.savedView = null;
  }

  private startCalibration(): void {
    this.restoreCanvas();
    this.first = null;
    this.marker.hidden = true;
    this.dialog.dataset.state = "calibrating";
    this.setActiveControls(false);
    this.environment = this.fingerprint();
    this.status.textContent =
      "Step 1 of 2: Tap the top-left corner of your A5 paper with the pen (or click its mapped screen position).";
    try {
      this.calibration = parseCalibration(
        localStorage.getItem(CALIBRATION_KEY),
        this.environment,
        this.available(),
      );
    } catch {
      this.calibration = null;
    }
    this.reuse.disabled = !this.calibration;
  }

  private readonly markCorner = (event: PointerEvent): void => {
    if (
      this.dialog.dataset.state !== "calibrating" ||
      event.button !== 0 ||
      event.pointerType === "touch"
    )
      return;
    if (this.environment !== this.fingerprint()) {
      this.startCalibration();
      return;
    }
    const point: Point = [event.clientX, event.clientY];
    if (!this.first) {
      this.first = point;
      const rect = this.stage.getBoundingClientRect();
      this.marker.style.left = `${point[0] - rect.left}px`;
      this.marker.style.top = `${point[1] - rect.top}px`;
      this.marker.hidden = false;
      this.reuse.disabled = true;
      this.status.textContent =
        "Step 2 of 2: Lift the pen, then tap the bottom-right corner of the same paper.";
      return;
    }
    const area = calibrate(this.first, point, this.available());
    if (!area) {
      this.first = null;
      this.marker.hidden = true;
      this.status.textContent =
        "Corners must be inside the writing area, top-left first, and at least 80 pixels apart on each axis. Try the top-left again.";
      return;
    }
    this.activate({ version: 1, area, environment: this.environment });
  };

  private activate(calibration: Calibration): void {
    if (calibration.environment !== this.fingerprint()) {
      this.startCalibration();
      return;
    }
    this.calibration = calibration;
    this.tools.cancelActiveGesture();
    this.tools.selectOnly([]);
    this.dialog.dataset.state = "active";
    this.marker.hidden = true;
    this.reuse.disabled = true;
    const rect = this.stage.getBoundingClientRect();
    const { area } = calibration;
    const { svg } = this.renderer;
    this.stage.append(svg);
    svg.dataset.smartNote = "true";
    svg.style.left = `${area.left - rect.left}px`;
    svg.style.top = `${area.top - rect.top}px`;
    svg.style.width = `${area.width}px`;
    svg.style.height = `${area.height}px`;
    this.renderer.viewport.setFixedPage(A5_PAGE);
    this.setTool("pencil");
    this.setActiveControls(true);
    this.status.textContent =
      "Ready. Write inside the marked paper edges. Pan and zoom are locked. Recalibrate if you change the driver mapping.";
    try {
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
    } catch {
      this.status.textContent += " Calibration could not be saved in this browser.";
    }
    svg.focus({ preventScroll: true });
  }

  private setTool(tool: "pencil" | "eraser"): void {
    this.tools.setTool(tool);
    this.element<HTMLElement>("[data-note-pen]").setAttribute(
      "aria-pressed",
      String(this.tools.tool === "pencil"),
    );
    this.element<HTMLElement>("[data-note-eraser]").setAttribute(
      "aria-pressed",
      String(this.tools.tool === "eraser"),
    );
  }

  private setActiveControls(active: boolean): void {
    for (const element of this.dialog.querySelectorAll<HTMLElement>("[data-note-active]"))
      (element as HTMLButtonElement).disabled = !active;
  }
}

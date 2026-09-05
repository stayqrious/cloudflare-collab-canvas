import type { MathRegion } from "./math-region";

/**
 * MathLive's `<math-field>`, opened over a text editor when the caret enters a formula. It is the
 * whole reason a participant does not have to know TeX: they get a maths input with its own
 * on-screen keyboard, and the board still stores ordinary delimited TeX.
 *
 * The library is large, so it loads only when a formula is first edited, the way MathJax does.
 */
type MathfieldLike = HTMLElement & {
  value: string;
  focus: () => void;
  executeCommand: (command: string) => void;
};

type MathLiveModule = {
  MathfieldElement: {
    new (): MathfieldLike;
    fontsDirectory: string | null;
    soundsDirectory: string | null;
  };
};

let mathLiveReady: Promise<MathLiveModule> | null = null;

async function loadMathLive(): Promise<MathLiveModule> {
  if (mathLiveReady) return mathLiveReady;
  mathLiveReady = (async () => {
    const module = (await import("mathlive")) as unknown as MathLiveModule;
    // The fonts and styles ship with the page bundle, served from this origin, so the library must
    // not fetch its own: the board's content security policy allows neither.
    module.MathfieldElement.fontsDirectory = null;
    module.MathfieldElement.soundsDirectory = null;
    return module;
  })();
  return mathLiveReady;
}

export type MathFieldOptions = {
  root: HTMLElement;
  /** Called on every edit with the formula's TeX, so the caller can write it back. */
  onChange: (tex: string) => void;
  /** Called when the participant is finished, so the caller can return focus to the text. */
  onDone: () => void;
  /**
   * Called when focus leaves the panel for something that is not the text being edited. The text
   * editor already declined to save when focus came here, so somebody has to finish the edit.
   */
  onFocusLeft: (next: Node | null) => void;
};

/** The top edge of MathLive's on-screen keyboard, or null when it is closed. */
function virtualKeyboardTop(): number | null {
  const keyboard = (window as unknown as { mathVirtualKeyboard?: { boundingRect?: DOMRect } })
    .mathVirtualKeyboard;
  const rect = keyboard?.boundingRect;
  return rect && rect.height > 0 ? rect.top : null;
}

export class MathFieldPanel {
  private readonly element: HTMLElement;
  private field: MathfieldLike | null = null;
  private destroyed = false;
  private openKey: string | null = null;
  private anchor: DOMRect | null = null;
  private stopWatchingKeyboard: (() => void) | null = null;

  constructor(private readonly options: MathFieldOptions) {
    this.element = document.createElement("div");
    this.element.className = "math-field-panel";
    this.element.dataset.testid = "math-field-panel";
    this.element.hidden = true;
    this.element.innerHTML = `
      <div class="math-field-heading">
        <span class="eyebrow">Formula</span>
        <button class="math-field-done" type="button" data-math-field-done>Done</button>
      </div>
      <div class="math-field-surface" data-math-field-surface></div>
      <p class="math-field-hint">Type or use the keyboard. The board stores it as TeX.</p>
    `;
    this.element.addEventListener("pointerdown", this.keepFocus);
    this.element.addEventListener("focusout", this.handleFocusOut);
    this.element
      .querySelector("[data-math-field-done]")
      ?.addEventListener("click", () => this.options.onDone());
    options.root.append(this.element);
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** True when focus moving here should not be treated as leaving the text editor. */
  contains(node: Node | null): boolean {
    return node !== null && this.element.contains(node);
  }

  destroy(): void {
    this.destroyed = true;
    this.element.removeEventListener("pointerdown", this.keepFocus);
    this.element.removeEventListener("focusout", this.handleFocusOut);
    this.stopWatchingKeyboard?.();
    this.stopWatchingKeyboard = null;
    this.element.remove();
  }

  /**
   * Shows the field for one formula. Reopening for the same formula only updates the value, so a
   * keystroke in the text editor does not tear the field down and lose the participant's place.
   */
  async open(key: string, region: MathRegion, tex: string, anchor: DOMRect): Promise<void> {
    if (this.destroyed) return;
    this.anchor = anchor;
    this.position();
    this.element.hidden = false;
    const field = await this.ensureField();
    if (this.destroyed || !field) return;
    if (this.openKey !== key) {
      this.openKey = key;
      field.value = tex;
    } else if (field.value !== tex && document.activeElement !== field) {
      field.value = tex;
    }
    this.watchVirtualKeyboard();
    // The panel has real dimensions only once the field is in it, so place it again now.
    this.position();
    this.element.dataset.mathDisplay = region.delimiter.display ? "display" : "inline";
  }

  close(): void {
    this.element.hidden = true;
    this.openKey = null;
    this.anchor = null;
  }

  /** Moves focus into the maths field, so the on-screen keyboard applies to it. */
  focusField(): void {
    this.field?.focus();
  }

  /**
   * Sits above the text being edited. MathLive's on-screen keyboard docks to the bottom of the
   * window, so above is the side that stays clear of it, and a participant can always see the
   * formula they are typing. It drops below only when there is no room above.
   */
  private position(): void {
    const anchor = this.anchor;
    if (!anchor) return;
    const margin = 8;
    const width = Math.max(280, Math.min(520, anchor.width));
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    const height = this.element.offsetHeight || 150;
    const above = anchor.top - height - margin;
    const floor = virtualKeyboardTop() ?? window.innerHeight;
    const top =
      above >= margin
        ? above
        : Math.max(margin, Math.min(anchor.bottom + margin, floor - height - margin));
    this.element.style.width = `${width}px`;
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  /**
   * Follows the on-screen keyboard, which the participant opens and closes. The keyboard object is
   * created lazily by the library, so this is retried on each open until it exists.
   */
  private watchVirtualKeyboard(): void {
    if (this.stopWatchingKeyboard) return;
    const keyboard = (window as unknown as { mathVirtualKeyboard?: EventTarget })
      .mathVirtualKeyboard;
    if (!keyboard?.addEventListener) return;
    const reposition = (): void => {
      // The keyboard reports its new size before painting, so wait a frame for the real geometry.
      requestAnimationFrame(() => this.position());
    };
    keyboard.addEventListener("geometrychange", reposition);
    keyboard.addEventListener("virtual-keyboard-toggle", reposition);
    this.stopWatchingKeyboard = () => {
      keyboard.removeEventListener("geometrychange", reposition);
      keyboard.removeEventListener("virtual-keyboard-toggle", reposition);
    };
  }

  private async ensureField(): Promise<MathfieldLike | null> {
    if (this.field) return this.field;
    const surface = this.element.querySelector("[data-math-field-surface]");
    if (!surface) return null;
    let module: MathLiveModule;
    try {
      module = await loadMathLive();
    } catch {
      this.element.hidden = true;
      return null;
    }
    if (this.destroyed) return null;
    const field = new module.MathfieldElement();
    field.addEventListener("input", () => this.options.onChange(field.value));
    field.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Escape" || key === "Enter") {
        event.preventDefault();
        this.options.onDone();
      }
    });
    surface.replaceChildren(field);
    this.field = field;
    this.watchVirtualKeyboard();
    return field;
  }

  /**
   * Focus leaving the panel ends the edit. The text editor's own blur declined to save when focus
   * came here, so without this a participant who clicks away keeps an open, unsaved editor, and
   * the next click on the canvas discards the draft.
   */
  private readonly handleFocusOut = (event: Event): void => {
    if (this.element.hidden) return;
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next !== null && this.element.contains(next)) return;
    this.options.onFocusLeft(next);
  };

  /** Pressing a key must not blur the text editor, which would save and close it. */
  private readonly keepFocus = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    // The maths field itself needs the focus; only the surrounding chrome refuses it.
    if (target && this.field && (target === this.field || this.field.contains(target))) return;
    event.preventDefault();
  };
}

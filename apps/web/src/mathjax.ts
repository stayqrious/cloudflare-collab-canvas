import { splitTexSegments } from "@collab/geometry";

type MathJaxApi = {
  startup?: { promise?: Promise<void> };
  typesetClear?: (elements: HTMLElement[]) => void;
  typesetPromise?: (elements: HTMLElement[]) => Promise<void>;
};

declare global {
  interface Window {
    MathJax?: MathJaxApi | Record<string, unknown>;
  }
}

const UNAMBIGUOUS_MATH_MARKUP = /\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\$\$[\s\S]+?\$\$/u;

let mathJaxReady: Promise<MathJaxApi> | null = null;
let mathJaxWork: Promise<void> = Promise.resolve();

export function containsMathMarkup(value: string): boolean {
  return UNAMBIGUOUS_MATH_MARKUP.test(value);
}

export function splitMathMarkup(value: string): Array<{ kind: "math" | "text"; text: string }> {
  return splitTexSegments(value).map(({ kind, text }) => ({ kind, text }));
}

function mathExpressionSource(markup: string): string {
  if (
    (markup.startsWith("\\(") && markup.endsWith("\\)")) ||
    (markup.startsWith("\\[") && markup.endsWith("\\]"))
  ) {
    return markup.slice(2, -2);
  }
  if (markup.startsWith("$$") && markup.endsWith("$$")) return markup.slice(2, -2);
  return markup;
}

function labelRenderedMath(container: HTMLElement, source: string): void {
  const formulae = splitMathMarkup(source)
    .filter((segment) => segment.kind === "math")
    .map((segment) => mathExpressionSource(segment.text));
  container.querySelectorAll<HTMLElement>("mjx-container").forEach((rendered, index) => {
    const formula = formulae[index];
    if (formula === undefined) return;
    rendered.setAttribute("role", "math");
    rendered.setAttribute("aria-label", `Formula: ${formula}`);
  });
}

async function loadMathJax(): Promise<MathJaxApi> {
  if (mathJaxReady) return mathJaxReady;
  mathJaxReady = (async () => {
    window.MathJax = {
      options: {
        enableBraille: false,
        enableExplorer: false,
        enableMenu: false,
        enableSpeech: false,
        menuOptions: {
          settings: { assistiveMml: false, braille: false, enrich: false, speech: false },
        },
        renderActions: { attachSpeech: [], enrich: [], explorable: [] },
      },
      startup: { typeset: false },
      svg: { fontCache: "local" },
      tex: {
        processEscapes: true,
        packages: { "[-]": ["autoload", "require"] },
      },
    };
    await import("mathjax/tex-svg.js");
    const mathJax = window.MathJax as MathJaxApi | undefined;
    await mathJax?.startup?.promise;
    if (typeof mathJax?.typesetPromise !== "function") {
      throw new Error("MathJax did not expose its browser typesetting API.");
    }
    return mathJax;
  })();
  return mathJaxReady;
}

function enqueueMathJax<T>(operation: (mathJax: MathJaxApi) => T | Promise<T>): Promise<T> {
  const work = mathJaxWork.then(async () => operation(await loadMathJax()));
  mathJaxWork = work.then(
    () => undefined,
    () => undefined,
  );
  return work;
}

export type TypesetMathOptions = {
  /** Runs once the container holds typeset math. Its failures never discard that math. */
  onReady?: () => void;
  /** Rebuilds the plain-text container when MathJax cannot render it. */
  restore?: (container: HTMLElement) => void;
};

/** Lazily typesets one plain-text container and preserves the source on failure. */
export function typesetMath(container: HTMLElement, options: TypesetMathOptions = {}): void {
  const source = container.textContent ?? "";
  if (!containsMathMarkup(source)) return;
  container.dataset.mathState = "loading";
  void enqueueMathJax(async (mathJax) => {
    if (!container.isConnected) return false;
    mathJax.typesetClear?.([container]);
    await mathJax.typesetPromise?.([container]);
    if (!container.isConnected) return false;
    labelRenderedMath(container, source);
    container.dataset.mathState = "ready";
    return true;
  })
    .catch(() => {
      if (!container.isConnected) return false;
      // Rebuilding from the caller keeps anchors and other markup that plain text would flatten.
      if (options.restore) options.restore(container);
      else container.textContent = source;
      container.title = "Math could not be rendered.";
      container.dataset.mathState = "error";
      return false;
    })
    // onReady runs outside the operation so a caller's failure cannot be mistaken for a
    // MathJax failure, which would replace correctly typeset math with its raw source and
    // swallow the real error.
    .then((typeset) => {
      if (typeset) reportMathReady(options.onReady);
    });
}

function reportMathReady(onReady?: () => void): void {
  if (!onReady) return;
  try {
    onReady();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/** Releases MathJax's references before rendered DOM is replaced or removed. */
export function clearTypesetMath(root: ParentNode): void {
  const element = root as ParentNode & {
    dataset?: DOMStringMap;
    querySelectorAll?: ParentNode["querySelectorAll"];
  };
  const containers: HTMLElement[] = [];
  if (element.dataset?.mathState !== undefined) containers.push(element as HTMLElement);
  if (typeof element.querySelectorAll === "function") {
    containers.push(...element.querySelectorAll<HTMLElement>("[data-math-state]"));
  }
  if (containers.length === 0) return;
  void enqueueMathJax((mathJax) => mathJax.typesetClear?.(containers)).catch(() => undefined);
}

type MathJaxSvgApi = MathJaxApi & {
  tex2svgPromise?: (tex: string, options?: { display?: boolean }) => Promise<HTMLElement>;
};

/** Cache key for one expression at one size. The same formula at two sizes is two pictures. */
function mathKey(tex: string, fontSize: number, display: boolean): string {
  return `${display ? "d" : "i"}:${fontSize}:${tex}`;
}

/**
 * A formula typeset once as a standalone SVG element, measured in the board units of the text it
 * sits in. `baseline` is the drop from the top of the box to the surrounding text's baseline, so
 * a caller can place the picture on the line it belongs on.
 */
export type TypesetMathSvg = {
  svg: string;
  width: number;
  height: number;
  baseline: number;
};

/**
 * The picture exporters draw synchronously, and MathJax typesets asynchronously, so every formula
 * on a board is typeset up front and handed over as a lookup. Rendering into a detached host and
 * measuring the result is what makes the sizes exact: nothing here guesses at font metrics.
 */
export async function typesetMathSvg(
  expressions: Iterable<{ tex: string; fontSize: number; display: boolean }>,
): Promise<Map<string, TypesetMathSvg>> {
  const wanted = new Map<string, { tex: string; fontSize: number; display: boolean }>();
  for (const expression of expressions) {
    if (expression.tex.trim().length === 0 || !(expression.fontSize > 0)) continue;
    wanted.set(mathKey(expression.tex, expression.fontSize, expression.display), expression);
  }
  const rendered = new Map<string, TypesetMathSvg>();
  if (wanted.size === 0 || typeof document === "undefined") return rendered;

  return enqueueMathJax(async (mathJax) => {
    const typeset = (mathJax as MathJaxSvgApi).tex2svgPromise;
    if (typeof typeset !== "function") return rendered;
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;";
    document.body.append(host);
    try {
      for (const [key, expression] of wanted) {
        host.style.fontSize = `${expression.fontSize}px`;
        let container: HTMLElement;
        try {
          container = await typeset(expression.tex, { display: expression.display });
        } catch {
          continue;
        }
        host.replaceChildren(container);
        const svg = container.querySelector("svg");
        if (!svg) continue;
        const measured = measureTypesetSvg(svg);
        if (measured) rendered.set(key, measured);
      }
    } finally {
      host.remove();
    }
    return rendered;
  }).catch(() => rendered);
}

/**
 * Reads the rendered box from the live layout, and the baseline from MathJax's own viewBox, whose
 * negative minimum Y is exactly the height above the baseline.
 */
function measureTypesetSvg(svg: SVGSVGElement): TypesetMathSvg | null {
  const box = svg.getBoundingClientRect();
  const width = box.width;
  const height = box.height;
  if (!(width > 0) || !(height > 0)) return null;
  const viewBox = (svg.getAttribute("viewBox") ?? "").split(/\s+/u).map(Number);
  const [, minY, , viewHeight] = viewBox;
  const baseline =
    viewBox.length === 4 &&
    Number.isFinite(minY) &&
    Number.isFinite(viewHeight) &&
    (viewHeight ?? 0) > 0
      ? (height * -(minY ?? 0)) / (viewHeight ?? 1)
      : height;
  const element = svg.cloneNode(true) as SVGSVGElement;
  element.removeAttribute("style");
  element.setAttribute("width", String(round(width)));
  element.setAttribute("height", String(round(height)));
  element.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return {
    svg: new XMLSerializer().serializeToString(element),
    width: round(width),
    height: round(height),
    baseline: round(Math.min(Math.max(baseline, 0), height)),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Every expression a set of board items holds, ready for typesetMathSvg. */
export function mathExpressionsIn(
  surfaces: Iterable<{ text: string; fontSize: number }>,
): Array<{ tex: string; fontSize: number; display: boolean }> {
  const expressions: Array<{ tex: string; fontSize: number; display: boolean }> = [];
  for (const { text, fontSize } of surfaces) {
    for (const segment of splitTexSegments(text)) {
      if (segment.kind !== "math") continue;
      expressions.push({ tex: segment.tex, fontSize, display: segment.display });
    }
  }
  return expressions;
}

/** Wraps a typeset lookup as the renderer the SVG exporter accepts. */
export function mathSvgRenderer(
  rendered: ReadonlyMap<string, TypesetMathSvg>,
): (tex: string, fontSize: number, display: boolean) => TypesetMathSvg | undefined {
  return (tex, fontSize, display) => rendered.get(mathKey(tex, fontSize, display));
}

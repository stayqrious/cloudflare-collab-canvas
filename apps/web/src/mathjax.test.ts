import { describe, expect, it, vi } from "vitest";
import { containsMathMarkup, splitMathMarkup, typesetMath } from "./mathjax";

describe("containsMathMarkup", () => {
  it("recognizes MathJax's own delimiters", () => {
    expect(containsMathMarkup("Area: \\(\\pi r^2\\)")).toBe(true);
    expect(containsMathMarkup("\\[x = \\frac{-b}{2a}\\]")).toBe(true);
    expect(containsMathMarkup("$$a^2+b^2=c^2$$")).toBe(true);
  });

  it("leaves a lone dollar sign as a dollar sign", () => {
    // A classroom board carries prices far more often than inline math, and no reading of a
    // single $ can tell "$5 to $12" apart from a formula. $$ is the delimiter instead.
    expect(containsMathMarkup("Energy: $E=mc^2$")).toBe(false);
    expect(containsMathMarkup("Prices changed from $100 to $50.")).toBe(false);
    expect(containsMathMarkup("Budget: $100 materials, $50 travel")).toBe(false);
    expect(containsMathMarkup("The total is $ 12.00 today.")).toBe(false);
    expect(containsMathMarkup("The total is \\$12.00 today.")).toBe(false);
    expect(containsMathMarkup("It cost $5-$10 per kit.")).toBe(false);
    expect(containsMathMarkup("No formula here")).toBe(false);
  });

  it("segments math out before surrounding prose is linkified", () => {
    expect(
      splitMathMarkup(
        "Read \\(\\text{https://inside.example }\\) then https://outside.example and $$x=1$$.",
      ),
    ).toEqual([
      { kind: "text", text: "Read " },
      { kind: "math", text: "\\(\\text{https://inside.example }\\)" },
      { kind: "text", text: " then https://outside.example and " },
      { kind: "math", text: "$$x=1$$" },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps a price beside a formula out of the formula", () => {
    expect(splitMathMarkup("Kits cost $12 each, so $$c = 12n$$.")).toEqual([
      { kind: "text", text: "Kits cost $12 each, so " },
      { kind: "math", text: "$$c = 12n$$" },
      { kind: "text", text: "." },
    ]);
  });
});

describe("typesetMath", () => {
  /** MathJax cannot load in this environment, so every typeset attempt takes the failure path. */
  function failingContainer(text: string) {
    return {
      childNodes: [] as Node[],
      dataset: {} as Record<string, string>,
      isConnected: true,
      textContent: text,
      title: "",
    };
  }

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("rebuilds the container through the caller's hook instead of flattening it to text", async () => {
    const container = failingContainer("Energy: $$E=mc^2$$");
    const restore = vi.fn();
    const onReady = vi.fn();

    typesetMath(container as unknown as HTMLElement, { restore, onReady });
    await settle();

    // Assigning textContent would destroy the safe-link anchors the caller built.
    expect(restore).toHaveBeenCalledWith(container);
    expect(container.textContent).toBe("Energy: $$E=mc^2$$");
    expect(container.dataset.mathState).toBe("error");
    expect(container.title).toBe("Math could not be rendered.");
    expect(onReady).not.toHaveBeenCalled();
  });

  it("still falls back to plain source when the caller supplies no hook", async () => {
    const container = failingContainer("Energy: $$E=mc^2$$");

    typesetMath(container as unknown as HTMLElement);
    await settle();

    expect(container.dataset.mathState).toBe("error");
    expect(container.textContent).toBe("Energy: $$E=mc^2$$");
  });
});

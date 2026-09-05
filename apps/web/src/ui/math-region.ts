/** The delimiter pairs the board accepts, longest opening first so `$$` wins over `$`. */
const DELIMITERS = [
  { open: "$$", close: "$$", display: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
] as const;

export type MathDelimiter = (typeof DELIMITERS)[number];

/** One formula inside a text value, addressed by the bounds of its TeX. */
export type MathRegion = {
  /** First index of the TeX, just past the opening delimiter. */
  start: number;
  /** Index just past the TeX, where the closing delimiter begins or the value ends. */
  end: number;
  delimiter: MathDelimiter;
  /** False when nothing closes the opening delimiter yet. */
  closed: boolean;
};

function escaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let back = index - 1; back >= 0 && value[back] === "\\"; back -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** Where `token` next appears at or after `from`, ignoring an escaped one. */
function indexOfToken(value: string, token: string, from: number): number {
  for (
    let index = value.indexOf(token, from);
    index >= 0;
    index = value.indexOf(token, index + 1)
  ) {
    // A delimiter that begins with a backslash carries its own; only `$$` can be escaped away.
    if (token.startsWith("\\") || !escaped(value, index)) return index;
  }
  return -1;
}

function openingAt(value: string, index: number): MathDelimiter | undefined {
  return DELIMITERS.find(
    (delimiter) =>
      value.startsWith(delimiter.open, index) &&
      (delimiter.open.startsWith("\\") || !escaped(value, index)),
  );
}

/**
 * The formula the caret sits inside, or null when it does not. Delimiters pair left to right, so
 * an opening with nothing to close it is a formula still being written, which is exactly the
 * moment the maths keyboard should appear.
 */
export function mathRegionAtCaret(value: string, caret: number): MathRegion | null {
  let cursor = 0;
  while (cursor < value.length) {
    const delimiter = openingAt(value, cursor);
    if (!delimiter) {
      cursor += 1;
      continue;
    }
    const start = cursor + delimiter.open.length;
    const closing = indexOfToken(value, delimiter.close, start);
    if (closing < 0) {
      return caret >= start ? { start, end: value.length, delimiter, closed: false } : null;
    }
    if (caret >= start && caret <= closing) {
      return { start, end: closing, delimiter, closed: true };
    }
    cursor = closing + delimiter.close.length;
  }
  return null;
}

/**
 * The delimiter this input event just opened with nothing to close it, so the editor can add the
 * closing half and leave the caret between the two.
 */
export function unclosedOpeningAt(value: string, caret: number): MathDelimiter | null {
  const delimiter = DELIMITERS.find(
    (candidate) =>
      caret >= candidate.open.length &&
      value.slice(caret - candidate.open.length, caret) === candidate.open,
  );
  if (!delimiter) return null;
  const region = mathRegionAtCaret(value, caret);
  return region && !region.closed && region.start === caret ? delimiter : null;
}

/** The value with this region's TeX replaced, and where the formula now ends. */
export function replaceMathRegion(
  value: string,
  region: MathRegion,
  tex: string,
): { value: string; region: MathRegion } {
  const closing = region.closed ? region.delimiter.close : "";
  const next = value.slice(0, region.start) + tex + closing + value.slice(regionEnd(value, region));
  return {
    value: next,
    region: { ...region, end: region.start + tex.length },
  };
}

/** Where the region's text ends in the value, past its closing delimiter when it has one. */
function regionEnd(value: string, region: MathRegion): number {
  return region.closed
    ? Math.min(value.length, region.end + region.delimiter.close.length)
    : value.length;
}

/** The delimited form of a formula, ready to sit in a text value. */
export function wrapMath(tex: string, delimiter: MathDelimiter): string {
  return `${delimiter.open}${tex}${delimiter.close}`;
}

import { DRAWING_COLOR_VALUES } from "../palette";
import type { ActivityTemplateItem } from "./template-items";
import { pencil, seeded } from "./template-items";

/**
 * Synthetic handwriting for demo boards: digits and arithmetic symbols drawn as pencil
 * strokes, one board object per pen stroke, with the wobble of a real hand. Glyphs live in a
 * 10 × 14 box with the baseline at 14. A glyph that needs a pen lift costs a stroke per lift,
 * which is why a template rations how much of its working is drawn this way.
 */
type Stroke = readonly (readonly [number, number])[];

const GLYPHS: Readonly<Record<string, readonly Stroke[]>> = {
  "0": [
    [
      [3, 0],
      [7, 0],
      [9, 3],
      [9, 11],
      [7, 14],
      [3, 14],
      [1, 11],
      [1, 3],
      [3, 0],
    ],
  ],
  "1": [
    [
      [3, 3],
      [5, 0],
      [5, 14],
    ],
  ],
  "2": [
    [
      [1, 3],
      [3, 0],
      [7, 0],
      [9, 3],
      [8, 6],
      [1, 14],
      [9, 14],
    ],
  ],
  "3": [
    [
      [1, 1],
      [5, 0],
      [8, 2],
      [7, 6],
      [4, 7],
      [8, 8],
      [8, 12],
      [5, 14],
      [1, 12],
    ],
  ],
  // Drawn in one stroke: down the stem, back to the bar, across it, and up the diagonal.
  "4": [
    [
      [7, 0],
      [7, 14],
      [7, 9],
      [10, 9],
      [1, 9],
      [7, 0],
    ],
  ],
  "5": [
    [
      [9, 0],
      [2, 0],
      [1, 7],
      [5, 6],
      [8, 8],
      [8, 12],
      [5, 14],
      [1, 12],
    ],
  ],
  "6": [
    [
      [8, 1],
      [4, 0],
      [1, 5],
      [1, 11],
      [4, 14],
      [8, 12],
      [8, 8],
      [4, 7],
      [1, 9],
    ],
  ],
  "7": [
    [
      [1, 0],
      [9, 0],
      [4, 14],
    ],
  ],
  "8": [
    [
      [5, 7],
      [8, 4],
      [7, 0],
      [3, 0],
      [2, 4],
      [5, 7],
      [8, 10],
      [7, 14],
      [3, 14],
      [2, 10],
      [5, 7],
    ],
  ],
  "9": [
    [
      [8, 5],
      [5, 7],
      [2, 5],
      [2, 1],
      [5, 0],
      [8, 2],
      [8, 8],
      [6, 14],
      [2, 14],
    ],
  ],
  // The vertical first, back to the middle, then the bar: one stroke, one plus.
  "+": [
    [
      [5, 2],
      [5, 12],
      [5, 7],
      [0, 7],
      [10, 7],
    ],
  ],
  "-": [
    [
      [1, 7],
      [9, 7],
    ],
  ],
  "−": [
    [
      [1, 7],
      [9, 7],
    ],
  ],
  "×": [
    [
      [1, 3],
      [9, 11],
      [5, 7],
      [9, 3],
      [1, 11],
    ],
  ],
  "÷": [
    [
      [1, 7],
      [9, 7],
    ],
    [
      [5, 3],
      [5.4, 3.4],
    ],
    [
      [5, 11],
      [5.4, 11.4],
    ],
  ],
  "=": [
    [
      [1, 5],
      [9, 5],
    ],
    [
      [1, 9],
      [9, 9],
    ],
  ],
  "(": [
    [
      [6, 0],
      [3, 4],
      [3, 10],
      [6, 14],
    ],
  ],
  ")": [
    [
      [4, 0],
      [7, 4],
      [7, 10],
      [4, 14],
    ],
  ],
  "?": [
    [
      [2, 3],
      [4, 0],
      [7, 0],
      [8, 3],
      [5, 7],
      [5, 10],
    ],
    [
      [5, 13],
      [5.4, 13.4],
    ],
  ],
};

const SUPERSCRIPT_TWO = "²";
const ADVANCE: Readonly<Record<string, number>> = {
  " ": 5,
  "1": 8,
  "-": 8,
  "−": 8,
  "(": 7,
  ")": 7,
  [SUPERSCRIPT_TWO]: 7,
};

export type HandwritingOptions = {
  /** Seed for the wobble, so the same text lands the same way every time. */
  seed: number;
  color?: string;
  /** Board units per glyph unit; 1.6 gives a glyph about 22 units tall. */
  unit?: number;
  /** Rightward lean, as a fraction of height. */
  slant?: number;
  width?: number;
  lineHeight?: number;
};

/**
 * Write `content` starting at (x, baselineY), one pencil stroke per pen stroke. Lines are
 * separated by `\n`. Characters without a glyph advance the pen and draw nothing.
 */
export function handwriting(
  x: number,
  baselineY: number,
  content: string,
  options: HandwritingOptions,
): ActivityTemplateItem[] {
  const random = seeded(options.seed);
  const unit = options.unit ?? 1.6;
  const slant = options.slant ?? 0.12;
  const color = options.color ?? DRAWING_COLOR_VALUES.blue;
  const width = options.width ?? 3;
  const lineHeight = options.lineHeight ?? 32;
  const items: ActivityTemplateItem[] = [];
  const jitter = (amount: number): number => (random() - 0.5) * amount;

  content.split("\n").forEach((line, lineIndex) => {
    let cursor = x + jitter(6);
    const baseline = baselineY + lineIndex * lineHeight + jitter(4);
    for (const character of line) {
      const glyphKey = character === SUPERSCRIPT_TWO ? "2" : character;
      const strokes = GLYPHS[glyphKey];
      const glyphScale = (character === SUPERSCRIPT_TWO ? 0.55 : 1) * (0.94 + random() * 0.12);
      const raise = character === SUPERSCRIPT_TWO ? 9 * unit : 0;
      const advance = (ADVANCE[character] ?? 11) * unit * glyphScale + jitter(2);
      if (strokes) {
        const glyphBaseline = baseline - raise + jitter(2);
        const glyphLeft = cursor + jitter(1.5);
        for (const stroke of strokes) {
          const points: [number, number][] = [];
          for (let index = 0; index < stroke.length; index += 1) {
            const [gx, gy] = stroke[index] as readonly [number, number];
            const place = (px: number, py: number, wobble: number): [number, number] => {
              const rise = 14 - py;
              return [
                Math.round(
                  (glyphLeft + (px + rise * slant) * unit * glyphScale + jitter(wobble)) * 10,
                ) / 10,
                Math.round((glyphBaseline - rise * unit * glyphScale + jitter(wobble)) * 10) / 10,
              ];
            };
            if (index > 0) {
              const [prevX, prevY] = stroke[index - 1] as readonly [number, number];
              points.push(place((prevX + gx) / 2, (prevY + gy) / 2, 1.6));
            }
            points.push(place(gx, gy, 1.1));
          }
          items.push(pencil(points, color, width));
        }
      }
      cursor += advance;
    }
  });
  return items;
}

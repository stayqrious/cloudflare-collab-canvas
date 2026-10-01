import { PARTICIPANT_COLORS, participantColor } from "@collab/protocol";
import { describe, expect, it } from "vitest";
import { DRAWING_COLORS, STICKY_COLORS, UI_COLORS } from "./palette";

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722;
}

describe("participant palette", () => {
  it("offers ten distinct coordinated ink and note colours, without red or green swatches", () => {
    expect(PARTICIPANT_COLORS).toHaveLength(10);
    expect(new Set(DRAWING_COLORS.map(({ value }) => value)).size).toBe(10);
    expect(new Set(STICKY_COLORS.map(({ value }) => value)).size).toBe(10);
    expect(DRAWING_COLORS.map(({ name }) => name)).toEqual(STICKY_COLORS.map(({ name }) => name));
    for (const entry of PARTICIPANT_COLORS) {
      expect(entry.name).not.toMatch(/red|green|mint|coral/iu);
      expect(DRAWING_COLORS).toContainEqual({ name: entry.name, value: entry.color });
      expect(STICKY_COLORS).toContainEqual({ name: entry.name, value: entry.stickyColor });
    }
  });

  it("uses readable ink on the canvas and dark text on pastel sticky notes", () => {
    for (const entry of PARTICIPANT_COLORS) {
      expect(
        (luminance(UI_COLORS.canvas) + 0.05) / (luminance(entry.color) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        (luminance(entry.stickyColor) + 0.05) / (luminance(UI_COLORS.ink) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("cycles only after all ten colours have been assigned", () => {
    expect(Array.from({ length: 10 }, (_, index) => participantColor(index))).toEqual(
      PARTICIPANT_COLORS,
    );
    expect(participantColor(10)).toEqual(participantColor(0));
    expect(participantColor(21)).toEqual(participantColor(1));
  });
});

import type { Point } from "../types";

// Five board units per millimetre. Every participant uses this same page at (0, 0).
export const A5_PAGE = { width: 740, height: 1050 } as const;
export const CALIBRATION_KEY = "collab.smart-note.calibration.v1";
export type WritingArea = { left: number; top: number; width: number; height: number };
export type Calibration = { version: 1; area: WritingArea; environment: string };

export function containsPoint(area: WritingArea, x: number, y: number): boolean {
  return (
    x >= area.left && y >= area.top && x <= area.left + area.width && y <= area.top + area.height
  );
}

export function calibrate(
  topLeft: Point,
  bottomRight: Point,
  available: WritingArea,
): WritingArea | null {
  const area = {
    left: topLeft[0],
    top: topLeft[1],
    width: bottomRight[0] - topLeft[0],
    height: bottomRight[1] - topLeft[1],
  };
  if (
    ![...topLeft, ...bottomRight].every(Number.isFinite) ||
    area.width < 80 ||
    area.height < 80 ||
    !containsPoint(available, ...topLeft) ||
    !containsPoint(available, ...bottomRight)
  )
    return null;
  return area;
}

export function toPage(area: WritingArea, x: number, y: number): Point {
  return [
    ((x - area.left) / area.width) * A5_PAGE.width,
    ((y - area.top) / area.height) * A5_PAGE.height,
  ];
}

export function parseCalibration(
  raw: string | null,
  environment: string,
  available: WritingArea,
): Calibration | null {
  try {
    const value = JSON.parse(raw ?? "null") as Calibration | null;
    if (value?.version !== 1 || value.environment !== environment || !value.area) return null;
    const { left, top, width, height } = value.area;
    if (
      ![left, top, width, height].every(
        (entry) => typeof entry === "number" && Number.isFinite(entry),
      )
    )
      return null;
    const area = calibrate([left, top], [left + width, top + height], available);
    return area ? { version: 1, area, environment } : null;
  } catch {
    return null;
  }
}

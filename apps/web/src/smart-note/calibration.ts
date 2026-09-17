import type { Point } from "../types";

// One shared portrait A5 page, at five board units per millimetre.
export const A5_PAGE = { width: 740, height: 1050 } as const;
export const A5_CORNERS: readonly Point[] = [
  [0, 0],
  [740, 0],
  [740, 1050],
  [0, 1050],
];
export const CORNER_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;
export type WritingArea = { left: number; top: number; width: number; height: number };
type Homography = [number, number, number, number, number, number, number, number, number];
export type Calibration = { corners: Point[]; pageToClient: Homography; clientToPage: Homography };

export function containsPoint(area: WritingArea, x: number, y: number): boolean {
  return (
    x >= area.left && y >= area.top && x <= area.left + area.width && y <= area.top + area.height
  );
}

/** Maps the four *measured* client positions to the same four logical page corners. */
export function calibrate(corners: readonly Point[], available: WritingArea): Calibration | null {
  if (
    corners.length !== 4 ||
    corners.some(
      ([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || !containsPoint(available, x, y),
    )
  )
    return null;
  const [p0, p1, p2, p3] = corners as [Point, Point, Point, Point];
  if (p1[0] - p0[0] < 80 || p2[0] - p3[0] < 80 || p3[1] - p0[1] < 80 || p2[1] - p1[1] < 80)
    return null;
  for (let index = 0; index < 4; index++) {
    const a = corners[index] as Point;
    const b = corners[(index + 1) % 4] as Point;
    const c = corners[(index + 2) % 4] as Point;
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return null;
  }
  const dx1 = p1[0] - p2[0],
    dx2 = p3[0] - p2[0],
    dx3 = p0[0] - p1[0] + p2[0] - p3[0];
  const dy1 = p1[1] - p2[1],
    dy2 = p3[1] - p2[1],
    dy3 = p0[1] - p1[1] + p2[1] - p3[1];
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 1e-8) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  const matrix: Homography = [
    (p1[0] - p0[0] + g * p1[0]) / A5_PAGE.width,
    (p3[0] - p0[0] + h * p3[0]) / A5_PAGE.height,
    p0[0],
    (p1[1] - p0[1] + g * p1[1]) / A5_PAGE.width,
    (p3[1] - p0[1] + h * p3[1]) / A5_PAGE.height,
    p0[1],
    g / A5_PAGE.width,
    h / A5_PAGE.height,
    1,
  ];
  const inverse = invert(matrix);
  return inverse
    ? { corners: corners.map(([x, y]) => [x, y]), pageToClient: matrix, clientToPage: inverse }
    : null;
}

function invert(m: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const adjugate: Homography = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
  const determinant = a * adjugate[0] + b * adjugate[3] + c * adjugate[6];
  if (Math.abs(determinant) < 1e-8) return null;
  return adjugate.map((value) => value / determinant) as Homography;
}

function project(m: Homography, x: number, y: number): Point {
  const divisor = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / divisor, (m[3] * x + m[4] * y + m[5]) / divisor];
}

export function toPage(calibration: Calibration, x: number, y: number): Point {
  // Floating-point inversion must not put a measured edge microscopically outside the page.
  const [px, py] = project(calibration.clientToPage, x, y);
  const snap = (value: number, maximum: number): number => {
    if (Math.abs(value) < 1e-7) return 0;
    return Math.abs(value - maximum) < 1e-7 ? maximum : value;
  };
  return [snap(px, A5_PAGE.width), snap(py, A5_PAGE.height)];
}

export function toClient(calibration: Calibration, point: Point): Point {
  return project(calibration.pageToClient, ...point);
}

export function pageTransform(calibration: Calibration): string {
  const [a, b, c, d, e, f, g, h, i] = calibration.pageToClient;
  return `matrix3d(${a},${d},0,${g},${b},${e},0,${h},0,0,1,0,${c},${f},0,${i})`;
}

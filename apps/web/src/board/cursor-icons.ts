export const POINTER_CURSOR_PATH = "M0 0 4.5 13 7.5 7.5 13 5Z";
// The pen's nib is at (0, 0), so the visible tip stays on the drawing point.
export const PEN_CURSOR_PATH = "M0 0 2-8 18-24Q20-26 22-24L24-22Q26-20 24-18L8-2Z";
export const PEN_CURSOR_DETAIL = "M2-8 8-2M16-22 22-16";
export const VIEWER_LOCK_PATH = "M20 4V1a3 3 0 0 1 6 0v3M19 4h8v7h-8ZM23 7v2";

function cursorUrl(content: string, x: number, y: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${content}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}`;
}

export const PEN_CURSOR = cursorUrl(
  `<g transform="translate(3 28)" stroke-linejoin="round"><path d="${PEN_CURSOR_PATH}" fill="#20242b" stroke="white" stroke-width="2.5"/><path d="${PEN_CURSOR_DETAIL}" fill="none" stroke="white" stroke-width="1.5"/></g>`,
  3,
  28,
);

export const VIEWER_CURSOR = cursorUrl(
  `<g transform="translate(1 3)" stroke-linejoin="round"><path d="${POINTER_CURSOR_PATH}" fill="#20242b" stroke="white" stroke-width="1.5"/><rect x="15" y="-3" width="16" height="16" rx="8" fill="white" stroke="#20242b" stroke-width="1"/><path d="${VIEWER_LOCK_PATH}" fill="none" stroke="#20242b" stroke-width="1.4"/></g>`,
  1,
  3,
);

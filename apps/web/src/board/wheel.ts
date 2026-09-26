/**
 * Converts a wheel event into the pixel distance the board should scroll. Mouse wheels and
 * two-finger trackpad scrolling pan the view; Shift turns vertical wheel motion horizontal.
 */
export function wheelScrollPixels(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "shiftKey">,
  page: { width: number; height: number },
): [number, number] {
  // deltaMode 1 reports lines and 2 reports pages; 0 is already in pixels.
  const [scaleX, scaleY] =
    event.deltaMode === 1 ? [16, 16] : event.deltaMode === 2 ? [page.width, page.height] : [1, 1];
  let deltaX = event.deltaX * scaleX;
  let deltaY = event.deltaY * scaleY;
  if (event.shiftKey && deltaX === 0) {
    deltaX = deltaY;
    deltaY = 0;
  }
  return [Number.isFinite(deltaX) ? deltaX : 0, Number.isFinite(deltaY) ? deltaY : 0];
}

# Smart Note prototype

Use **Smart Note** in the board header. Calibrate the top-left and bottom-right
corners by tapping them on the physical paper with the tablet pen. Mouse clicks
are also accepted for testing or manually marking known mapped screen positions.
Use Pen, Eraser and Undo in the mode’s toolbar; Exit Smart Note (or Escape) returns
to the previous board view and tool. Drawing permissions and board tool settings
still apply. Pen style comes from the normal board toolbar.

## Driver discovery

Huion’s [working area documentation](https://www.huion.com/manual/huion-note/678)
provides full-area, screen-ratio and custom mapping modes. Its default screen-ratio
mode can limit the active hardware area. Configure absolute pen input, the full
paper area, and portrait rotation before calibrating. Map that paper into the
browser’s visible calibration area. Both corners must reach the browser; websites
cannot receive pen taps delivered to the desktop or another application.

The standard [Pointer Events API](https://www.w3.org/TR/pointerevents3/) exposes
mapped pointer positions and pen information, but no API for reading Huion’s
driver working-area configuration. This prototype therefore uses calibration.
Automatic discovery would need separate investigation of a supported Huion SDK
or native integration; no undocumented device access is assumed here.

## Shared coordinates and local calibration

The shared page is portrait A5, 148 × 210 mm, represented by **740 × 1050 board
units at origin (0, 0)**. Five board units represent one nominal millimetre; these
are logical units, not physical screen millimetres. Existing content in that
region remains visible. This is a local writing mode over the existing board,
not a new server-side page type. Participants outside the mode can still edit
the ordinary infinite board. All participants in the mode use this same page.

For each local writing rectangle `(left, top, width, height)` in CSS pixels:

```
pageX = (clientX - left) / width * 740
pageY = (clientY - top) / height * 1050
```

The inverse transformation renders the shared page exactly between the marked
edges. X and Y scale independently; this reverses an axis-aligned driver mapping
even if the screen rectangle has a different aspect ratio. The same fractional
paper position produces identical saved coordinates on every participant’s
screen. Device pixel ratio is not multiplied into event coordinates.

To keep direct pen-to-cursor alignment, the on-screen page fills the calibrated
rectangle, which may appear stretched when its proportions differ from A5. For
an undistorted on-screen page, configure the driver’s screen rectangle in A5
proportions before calibration. Uniform letterboxing would break exact mapping
to both marked edges; a separate undistorted preview is a possible later feature.

The existing operation, preview, persistence, permissions and collaboration
paths are reused. There is no protocol or storage-schema migration. SVG clipping
limits visible content to the page. Out-of-bounds pointer samples end a stroke
at its last in-bounds sample, so outside movement and re-entry do not draw a
connecting line or smear points along the edge. Lift and touch down to resume.
Strokes can have paint extending beyond their centerline; the SVG clips that
paint locally. Ordinary exports retain normal board-wide export behavior.

## Calibration lifetime

Calibration is local to this browser profile, not synchronized with the board.
It is saved with a version and an environment fingerprint: viewport size,
window position, screen size, device pixel ratio, orientation, visual viewport,
and calibration surface bounds. Reopening offers **Use saved calibration** only
when the saved configuration matches. Storage denial does not block drawing.

Pan, wheel zoom, pinch, and Follow me viewport changes cannot move the writing
area. Touch drawing is ignored to reduce palm interference. A detected window,
zoom or display change cancels the current gesture and returns to calibration;
the environment is checked before pointer input and periodically while open.
Driver configuration changes cannot be detected, so the user must explicitly
recalibrate after changing the driver, device or physical paper placement.
Two-corner calibration assumes an axis-aligned, non-mirrored portrait mapping;
it cannot correct rotation, skew or cropped hardware coverage.

## Validation and limits

Unit tests cover mapping across resolutions, malformed saved data, invalid
corners, and locking/restoring the viewport. Playwright coverage exercises two
participants, different calibration rectangles, shared strokes, reload/reuse,
resize invalidation, touch rejection, bounds, undo, and mobile calibration UI.

Hardware validation with the actual Huion Note is still required. In particular,
verify paper orientation, whether the full physical A5 area produces distinct
pointer coordinates, whether the driver reports pen or mouse input, display
scaling and multi-monitor mappings. The prototype supports one portrait page;
landscape, page selection, multiple device profiles, and automatic driver
integration remain future work.

# Smart Note mode

The owner enables **Space settings → Features → Enable Smart Note**. The setting
is persisted as `features.smartNote` (also accepted by the board settings API and
organisation launch configuration), and defaults to off for new and older boards.

Enabling it immediately puts **every connected participant** into the shared A5
mode. Participants joining later enter that mode automatically too. Each person
must calibrate their own device before writing. Reloading, rejoining, or changing
the window/display requires all four corners again. There is no saved-calibration
bypass and Escape cannot return a participant to the infinite canvas. The owner
can disable **Enable Smart Note** in the regular settings, or use **Turn off for
everyone** during calibration, to restore the infinite canvas.
Existing drawings are preserved when the mode changes.

## Visual calibration

A centered paper illustration highlights a blinking corner in this order:

1. Top-left
2. Top-right
3. Bottom-right
4. Bottom-left

Tap each corner on the **physical A5 paper**, lifting the pen between dots. The
illustration is an instruction, not an onscreen click target. The app records the
initial pen-down location, not the location where the pen is lifted. Each captured
dot appears immediately at its measured screen location. All four dots remain
as fixed page marks after calibration, including through drawing and undo. These
are shared page decorations at canonical A5 corners, not duplicate ink operations
from each participant; ordinary board exports do not currently include them.

The calibration surface covers the entire browser client viewport. Instructions
and tools float over it; they do not reserve any strip at the top or change the
paper origin. The calibration guide is a normal document overlay, not a top-layer
modal. It closes after the fourth mark. The canvas
stays in its original board container, with the regular header, drawing toolbar,
colour controls, undo and save status. Other drawing tools and zoom controls are
visible but disabled; the normal Pencil tool is selected. The header’s
**Recalibrate** button restarts calibration.

Calibration and writing use the same viewport coordinates. The calibrated SVG
is fixed to the viewport rather than offset by the board header or its canvas
container. Its ink layer paints above the header so the top strip is visible too;
the white paper background stays behind the regular UI. Both calibration and
handwriting are captured on the same untransformed document root. Neither the
calibration guide nor the perspective-transformed SVG becomes the pointer-capture
target. Input is handled at the window before SVG hit testing, so the transformed SVG or a toolbar cannot exclude
part of the calibrated page. Native pen input writes through the regular header
and controls without requiring a hover event. Mouse-emulating drivers can also
start handwriting there: a drag becomes ink from the original down position,
while an ordinary click still operates the UI. Use the mouse or keyboard for
controls when using a native pen. Touch input is ignored for calibration
and drawing to reduce palm interference.

Use **Use full screen** before marking if the driver maps the tablet to the whole
display. Fullscreen entry or exit resets calibration. Browsers cannot receive pen
events aimed at their address bar, the OS desktop, or another application. If
fullscreen is unavailable (for example in an embed without fullscreen permission),
use the browser’s fullscreen command or adjust the driver’s screen mapping so all
four physical corners fall within the page. Do not guess a browser-toolbar height
or add it to pointer coordinates.

## Exact shared page mapping

Every participant uses the same portrait A5 page at `(0, 0)`, measuring **740 × 1050
board units**, equivalent to 148 × 210 mm at five logical units per millimetre.
These are not physical screen millimetres. Existing board content in this region
remains visible. The mode does not create a separate document or change the board’s
operation, preview, persistence, permissions or collaboration paths.

Four measured CSS-pixel positions are mapped to the four canonical A5 corners by
a projective transform (homography). The same transform renders the SVG page; its
inverse maps input and presence coordinates back into the shared page. This pins
all four corners to the actual marks, including skewed quadrilaterals, rather than
approximating them with a bounding rectangle. CSS client coordinates are used
without adding browser chrome offsets or multiplying by device pixel ratio.

Corners must describe a non-folded clockwise portrait page, in the prompted order,
with distinct corners at least 80 CSS pixels apart (or 12% of the shorter viewport
side, whichever is larger). Each new mark is validated immediately. Near-duplicate
marks, wrong directions, nonfinite values and inaccessible corners are rejected
without advancing or discarding accepted marks. The current corner blinks red and
the centered instructions ask for that corner again. A valid retry clears the error.

The sides must approximate a portrait A5 rectangle: width/height is allowed within
30% of 148/210, with modest edge tilt and up to 25% variation between opposite
sides. This tolerates ordinary calibration error but rejects flat, narrow or folded
pages. The accepted points are never snapped to a guessed rectangle; the mapping
still passes through all four measured marks. Two-corner calibration can be
considered later; it is not available now.

After calibration, **Pen is the only drawing tool**. Eraser, selection, shape tools
and tool-switching shortcuts cannot replace it. Undo remains available as an action.
Mouse input can also draw for drivers that expose the tablet as a mouse.

The SVG is clipped to the page. Out-of-bounds pointer samples end a stroke at its
last in-bounds sample; outside movement and re-entry do not draw a connecting line
or smear points along an edge. Lift and touch down to resume. Pan, wheel zoom,
pinch, and Follow me cannot change the writing area. A pen-down outside the page
shows a warning once per calibration, explaining that the mark was not saved and
asking the writer to recalibrate using the existing corner dots.

The environment fingerprint includes viewport bounds, window position, screen
size, device pixel ratio, orientation, and the visual viewport. It is checked
before pointer input and periodically while open. A change cancels the current
gesture and starts calibration again. Driver configuration or physical paper
movement cannot be detected; use **Recalibrate** after either changes.

## Driver and hardware limits

Huion’s [working-area documentation](https://www.huion.com/manual/huion-note/678)
provides full-area, screen-ratio and custom mapping. Configure absolute pen input,
the full paper area, and portrait orientation first. Its screen-ratio mode may
crop the active hardware area. Four-corner calibration cannot recover hardware
positions the driver never reports distinctly.

The standard [Pointer Events API](https://www.w3.org/TR/pointerevents3/) reports
mapped coordinates, but not Huion’s working-area configuration. No native driver
integration is assumed. Physical Huion testing is still needed for driver mode,
full-paper coverage, ink nib input, display scaling, and multi-monitor behavior.

Tests cover corner/interior mappings, top-edge positioning, pen-down capture,
invalid polygons, automatic entry for all participants, mandatory recalibration,
different viewport sizes and pixel densities, shared drawing, retained page dots,
bounds, undo, immediate invalid-mark feedback, centered instructions, pen-only
tool selection, regular toolbar access, mouse-emulated handwriting over the header,
and trusted browser pen input at the top edge, within the header strip and at the
bottom of the page. Fullscreen is optional and changes require recalibration.

The skewed-page browser regression checks seven rasterized upper-page rows, not
just DOM bounds, and asserts the same capture target during calibration and ink.
These browser checks do not substitute for physical tablet validation.

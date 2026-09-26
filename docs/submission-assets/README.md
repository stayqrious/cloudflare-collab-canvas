# Devpost screenshot assets

These synthetic-data screenshots are prepared for the SpaceScale WebMCP
Challenge submission. Upload them to Devpost in this order:

1. `ai-feedback-correction.png` — lead screenshot: the student's incorrect
   `-3`/`-1` intercept claim and hand-drawn graph beside a real WebMCP-generated
   counterexample asking them to plot `(-4, -2)` (1280 × 720).
2. `homepage.png` — public landing page and WebMCP positioning (1280 × 720).
3. `media-math-canvas.png` — shared video, MathJax, and canvas tools
   (840 × 640).

`handwriting-visual-review.png` is optional technical evidence showing the same
quadratic and hand-drawn parabola in the selected visual inspection surface.

Generate the product screenshots with the focused Chromium scenarios:

```sh
npx playwright test tests/playwright/submission-ai-feedback.spec.ts tests/playwright/webmcp-board-visual.spec.ts tests/playwright/media-math-responsive.spec.ts --config tests/playwright/playwright.config.ts --project=chromium
```

The homepage is a capture of the public URL. Before upload, confirm the live page
still matches `homepage.png`. Do not include invitation fragments, owner recovery
links, email addresses, secrets, or real student work in replacement images.

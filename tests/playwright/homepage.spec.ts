import { expect, test } from "@playwright/test";

test("presents an AI-enabled learning canvas with a fresh suggested name", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The homepage smoke runs in Chromium.");

  await page.addInitScript(() => {
    const load = Number(window.name || "0");
    window.name = String(load + 1);
    Math.random = () => (load === 0 ? 0 : 0.9999);
  });

  await page.goto("/");

  await expect(page).toHaveTitle("SpaceScale — AI-enabled collaborative learning");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Learn together,with AI.");
  await expect(page.getByText("WebMCP enabled", { exact: true })).toBeVisible();
  await expect(page.getByText("Cloudflare-native", { exact: true })).toHaveCount(0);
  await expect(page.locator(".landing-hero-mark .brand-mark")).toHaveCSS("width", "82px");

  const boardTitle = page.getByRole("textbox", { name: "Board title" });
  await expect(boardTitle).toHaveValue("Bright Algebra Academy 1000");

  await page.reload();
  await expect(boardTitle).toHaveValue("Wondering Vector Workshop 9999");

  await boardTitle.fill("Biology revision");
  await expect(boardTitle).toHaveValue("Biology revision");
});

test("keeps the landing hero and its form usable on agent-browser viewports", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The homepage layout smoke runs in Chromium.");

  // Widths and heights typical of ChatGPT and other agent browsers, plus both sides of
  // the two-column breakpoint, where the hero used to grow as the viewport narrowed.
  const viewports = [
    { label: "small laptop", width: 1024, height: 768 },
    { label: "agent short", width: 900, height: 700 },
    { label: "agent tall", width: 880, height: 870 },
    { label: "above breakpoint", width: 801, height: 900 },
    { label: "at breakpoint", width: 800, height: 900 },
    { label: "agent smallest", width: 800, height: 600 },
  ];

  const heroFontSizes = new Map<string, number>();
  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open a fresh canvas" })).toBeVisible();

    const measured = await page.evaluate(() => {
      const heading = document.querySelector(".landing-copy h1") as HTMLElement;
      const submit = document.querySelector(".create-card .primary-button") as HTMLElement;
      return {
        horizontalOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        headingOverflow: heading.scrollWidth - heading.clientWidth,
        submitBottom: submit.getBoundingClientRect().bottom,
        heroFontSize: Number.parseFloat(getComputedStyle(heading).fontSize),
        viewportHeight: window.innerHeight,
      };
    });

    const where = `${viewport.label} (${viewport.width}x${viewport.height})`;
    expect(measured.horizontalOverflow, `horizontal overflow at ${where}`).toBeLessThanOrEqual(0);
    expect(measured.headingOverflow, `clipped heading at ${where}`).toBeLessThanOrEqual(1);
    // The board-name form is the page's only action, so it must not need scrolling.
    expect(measured.submitBottom, `form below the fold at ${where}`).toBeLessThanOrEqual(
      measured.viewportHeight,
    );
    heroFontSizes.set(viewport.label, measured.heroFontSize);
  }

  const above = heroFontSizes.get("above breakpoint") ?? 0;
  const at = heroFontSizes.get("at breakpoint") ?? 0;
  expect(at).toBeGreaterThan(0);
  expect(
    at,
    "narrowing past the two-column breakpoint must not enlarge the hero",
  ).toBeLessThanOrEqual(above);
});

test("scrolls the landing when it is taller than a short viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "The homepage layout smoke runs in Chromium.");

  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto("/");
  await expect(page.getByTestId("landing-page")).toBeVisible();

  const measured = await page.evaluate(async () => {
    const landing = document.querySelector(".landing") as HTMLElement;
    const footer = document.querySelector(".landing > footer") as HTMLElement;
    const overflowing = landing.scrollHeight > landing.clientHeight + 1;
    landing.scrollTop = landing.scrollHeight;
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null));
    });
    return {
      overflowing,
      scrolledBy: landing.scrollTop,
      footerBottom: footer.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    };
  });

  // #app is overflow:hidden, so the landing has to scroll itself. When it does not, the
  // content past the fold is clipped with no way to reach it.
  expect(measured.overflowing, "expected the landing to overflow a 390x500 viewport").toBe(true);
  expect(measured.scrolledBy, "the landing did not scroll").toBeGreaterThan(0);
  expect(
    measured.footerBottom,
    "the footer stayed out of reach after scrolling",
  ).toBeLessThanOrEqual(measured.viewportHeight + 1);
});

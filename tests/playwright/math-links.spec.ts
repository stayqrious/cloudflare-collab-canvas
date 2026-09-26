import { expect, test } from "@playwright/test";
import { canvasPoint, createBoard } from "./helpers";

const FORMULA = String.raw`Sources \(\href{https://example.com/source}{\text{source}}\ \mmlToken{mi}[href="javascript:alert(1)"]{X}\ \mmlToken{mi}[style="position:fixed;top:0;left:0;width:9999px;height:9999px;background:red"]{Y}\ \mmlToken{mi}[class="toast"]{Z}\ \href{//evil.example/x}{E}\)`;

test("formulas keep https source links and drop script links and injected styles", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Math link safety runs in Chromium.");

  await page
    .context()
    .route("https://example.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<title>Source</title>" }),
    );
  await createBoard(page, "Math links");
  await page.getByTestId("tool-text").click();
  const point = await canvasPoint(page, 0.3, 0.3);
  await page.mouse.click(point.x, point.y);
  const editor = page.getByTestId("canvas-text-editor");
  await editor.fill(FORMULA);
  await editor.press("Control+Enter");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  const math = page.locator("#drawing-area .board-math-content").first();
  await expect(math).toHaveAttribute("data-math-state", "ready");
  const links = await math.evaluate((root) =>
    [...root.querySelectorAll("a")].map((anchor) => ({
      href: anchor.getAttribute("href"),
      xlink: anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
      target: anchor.getAttribute("target"),
      rel: anchor.getAttribute("rel"),
    })),
  );
  expect(links.filter((link) => link.href !== null || link.xlink !== null)).toEqual([
    {
      href: "https://example.com/source",
      xlink: null,
      target: "_blank",
      rel: "noopener noreferrer",
    },
  ]);
  const injected = await math.evaluate((root) => ({
    styles: [...root.querySelectorAll("[style]")]
      .map((node) => node.getAttribute("style") ?? "")
      .filter((style) => /position|9999px/u.test(style)),
    classes: root.querySelectorAll(".toast").length,
  }));
  expect(injected).toEqual({ styles: [], classes: 0 });

  // Following the link opens a new tab rather than navigating the board's frame.
  const popup = page.waitForEvent("popup");
  await math.locator("a[href='https://example.com/source']").click();
  expect((await popup).url()).toBe("https://example.com/source");
  await expect(page.getByTestId("board-shell")).toBeVisible();
});

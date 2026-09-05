import { describe, expect, it } from "vitest";
import {
  BRAND_MARK_HTML,
  BRAND_MARK_URL,
  brandedDocumentTitle,
  DEFAULT_DOCUMENT_TITLE,
  PRODUCT_HOME_LABEL,
  PRODUCT_NAME,
} from "./branding";

describe("SpaceScale branding", () => {
  it("provides consistent product, home, and document-title labels", () => {
    expect(PRODUCT_NAME).toBe("SpaceScale");
    expect(PRODUCT_HOME_LABEL).toBe("SpaceScale home");
    expect(DEFAULT_DOCUMENT_TITLE).toBe("SpaceScale — AI-enabled collaborative learning");
    expect(brandedDocumentTitle("  Fractions workshop  ")).toBe("Fractions workshop — SpaceScale");
    expect(brandedDocumentTitle("   ")).toBe(DEFAULT_DOCUMENT_TITLE);
  });

  it("uses the native decorative SVG mark without duplicating accessible text", () => {
    expect(BRAND_MARK_URL).toBe("/spacescale-mark.svg");
    expect(BRAND_MARK_HTML).toContain(`src="${BRAND_MARK_URL}"`);
    expect(BRAND_MARK_HTML).toContain('alt=""');
    expect(BRAND_MARK_HTML).toContain('aria-hidden="true"');
  });
});

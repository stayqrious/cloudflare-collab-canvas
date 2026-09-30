import {
  boardItem,
  FIXTURE_IDS,
  FIXTURE_TIME,
  newStickyItem,
  newTextItem,
} from "@collab/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  copyableTextFromCanonicalSpace,
  createSignedViewerImageAssetLoader,
  parseCanonicalSpaceExport,
  pointerStartsViewerPan,
  readCanonicalSpaceExportFile,
  readCanonicalSpaceExportResponse,
  SPACE_VIEWER_CSS,
  SpaceViewerExportError,
  viewerAssetTokenFromSessionResponse,
  zoomFromWheel,
} from "./viewer";

const BOARD_ID = `b_${"A".repeat(22)}`;

function canonicalExport() {
  return {
    format: "cf-whiteboard-json" as const,
    version: 1 as const,
    boardId: BOARD_ID,
    seq: 4,
    createdAt: FIXTURE_TIME,
    settings: { title: "Questions and feedback" },
    items: [
      boardItem(newStickyItem(), { z: 2, version: 4 }),
      boardItem(newTextItem(), { z: 1, version: 3 }),
    ],
  };
}

describe("canonical read-only Space exports", () => {
  it("accepts the canonical API export, detaches it, and preserves rendered content", () => {
    const input = canonicalExport();
    const parsed = parseCanonicalSpaceExport(input);

    expect(parsed).toMatchObject({
      format: "cf-whiteboard-json",
      version: 1,
      boardId: BOARD_ID,
      seq: 4,
      settings: { title: "Questions and feedback" },
    });
    expect(parsed.items.map((item) => item.id)).toEqual([FIXTURE_IDS.text, FIXTURE_IDS.sticky]);
    expect(parsed.items.map((item) => item.geometry)).toEqual([
      expect.objectContaining({ text: "Fixture text" }),
      expect.objectContaining({ text: "Fixture sticky" }),
    ]);

    input.settings.title = "Changed after parsing";
    expect(parsed.settings.title).toBe("Questions and feedback");
  });

  it("collects explicit copy text in canonical paint order", () => {
    expect(copyableTextFromCanonicalSpace(parseCanonicalSpaceExport(canonicalExport()))).toBe(
      "Fixture text\nFixture sticky",
    );
  });

  it("loads private images with the memory-only signed viewer capability", async () => {
    const token = `vas1.${"A".repeat(32)}.${"B".repeat(43)}`;
    const session = new Response(null, {
      headers: { "X-SpaceScale-Viewer-Asset-Token": token },
    });
    expect(viewerAssetTokenFromSessionResponse(session)).toBe(token);

    const fetcher = vi.fn(
      async () =>
        new Response(new Uint8Array([71, 73, 70]), {
          headers: { "Content-Type": "image/gif" },
        }),
    );
    const assetId = `asset_${"C".repeat(43)}`;
    const image = await createSignedViewerImageAssetLoader(token, fetcher)(assetId);
    expect(image.type).toBe("image/gif");
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/viewer/assets/${assetId}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "image/*", Authorization: `Bearer ${token}` },
    });

    expect(() => viewerAssetTokenFromSessionResponse(new Response())).toThrow(
      "image session is missing",
    );
    await expect(
      createSignedViewerImageAssetLoader(
        token,
        async () => new Response("No", { status: 401 }),
      )(assetId),
    ).rejects.toThrow("HTTP 401");
  });

  it("accepts both raw downloaded JSON and an already-fetched API response", async () => {
    const raw = JSON.stringify(canonicalExport());
    expect(parseCanonicalSpaceExport(raw).items).toHaveLength(2);

    const response = new Response(raw, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    await expect(readCanonicalSpaceExportResponse(response)).resolves.toMatchObject({
      boardId: BOARD_ID,
      seq: 4,
    });
  });

  it("reads local files without a network dependency", async () => {
    const raw = JSON.stringify(canonicalExport());
    const file = { size: raw.length, text: async () => raw };
    await expect(readCanonicalSpaceExportFile(file)).resolves.toMatchObject({ boardId: BOARD_ID });
  });

  it("rejects malformed, attributed, failed, and oversized sources", async () => {
    expect(() => parseCanonicalSpaceExport("not json")).toThrow("not valid JSON");
    expect(() =>
      parseCanonicalSpaceExport({ format: "cf-whiteboard-attributed-json", version: 1 }),
    ).toThrow('format "cf-whiteboard-json"');

    const invalid = canonicalExport();
    const duplicatePaintOrder = invalid.items[1];
    if (!duplicatePaintOrder) throw new Error("Missing test fixture");
    invalid.items[1] = { ...duplicatePaintOrder, z: 2 };
    expect(() => parseCanonicalSpaceExport(invalid)).toThrow(SpaceViewerExportError);

    await expect(
      readCanonicalSpaceExportResponse(new Response("No", { status: 403 })),
    ).rejects.toThrow("HTTP 403");
    await expect(
      readCanonicalSpaceExportFile({ size: 27 * 1_024 * 1_024, text: async () => "" }),
    ).rejects.toThrow("larger than 27 MiB");
  });
});

describe("read-only viewport behavior", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps wheel motion to renderer zoom direction", () => {
    expect(zoomFromWheel(1, -100)).toBeGreaterThan(1);
    expect(zoomFromWheel(1, 100)).toBeLessThan(1);
    expect(zoomFromWheel(2, Number.NaN)).toBe(2);
  });

  it("pans blank/shaped content but leaves board text available for native selection", () => {
    expect(
      pointerStartsViewerPan({
        button: 0,
        pointerType: "mouse",
        target: null,
        spacePressed: false,
      }),
    ).toBe(true);

    class FakeElement {
      constructor(private readonly matchesText: boolean) {}

      closest(): FakeElement | null {
        return this.matchesText ? this : null;
      }
    }
    vi.stubGlobal("Element", FakeElement);
    const text = new FakeElement(true) as unknown as EventTarget;

    expect(
      pointerStartsViewerPan({
        button: 0,
        pointerType: "mouse",
        target: text,
        spacePressed: false,
      }),
    ).toBe(false);
    expect(
      pointerStartsViewerPan({ button: 0, pointerType: "mouse", target: text, spacePressed: true }),
    ).toBe(true);
    expect(
      pointerStartsViewerPan({
        button: 1,
        pointerType: "mouse",
        target: text,
        spacePressed: false,
      }),
    ).toBe(true);
  });

  it("makes rendered content text selectable while exposing only view controls", () => {
    expect(SPACE_VIEWER_CSS).toContain("user-select: text !important");
    expect(SPACE_VIEWER_CSS).not.toContain("selection-resize-handle");
    expect(SPACE_VIEWER_CSS).not.toContain("tool-palette");
  });
});

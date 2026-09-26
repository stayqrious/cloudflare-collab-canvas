import type { Bounds } from "@collab/geometry";
import { describe, expect, it } from "vitest";

import { buildCollectiveInquiryMap, type InquiryTheme } from "./collective-inquiry";

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function themes(count: number): InquiryTheme[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `theme_${index + 1}`,
    label: `Theme ${index + 1}`,
    summary: "A summary that is long enough to describe the theme for the class.",
    ideaAliases: [`idea_${index + 1}`],
  }));
}

function overlaps(left: Box, right: Box): boolean {
  return (
    left.minX < right.maxX &&
    right.minX < left.maxX &&
    left.minY < right.maxY &&
    right.minY < left.maxY
  );
}

function within(box: Box, bounds: Bounds): boolean {
  return (
    box.minX >= bounds.minX &&
    box.minY >= bounds.minY &&
    box.maxX <= bounds.maxX &&
    box.maxY <= bounds.maxY
  );
}

describe("collective inquiry map", () => {
  it("builds connections, themes, bridges, and a productive tension as one valid batch", () => {
    let nextId = 1;
    const batch = buildCollectiveInquiryMap(
      {
        selectionToken: "selection-token",
        mapTitle: "Reducing cafeteria waste",
        themes: [
          {
            id: "habits",
            label: "Everyday habits",
            summary: "Small defaults can make low-waste choices easier for everyone.",
            ideaAliases: ["idea_1"],
          },
          {
            id: "systems",
            label: "School systems",
            summary: "Collection and purchasing rules determine which habits can scale.",
            ideaAliases: ["idea_2"],
          },
        ],
        bridges: [
          {
            fromThemeId: "habits",
            toThemeId: "systems",
            insight: "Visible feedback can connect personal choices to school-wide purchasing.",
          },
        ],
        tension: {
          statement: "Convenience can conflict with reducing disposable packaging.",
          nextQuestion: "Which low-waste default could we pilot without slowing lunch service?",
        },
      },
      [
        {
          alias: "idea_1",
          bounds: { minX: 0, minY: 20, maxX: 180, maxY: 160 },
        },
        {
          alias: "idea_2",
          bounds: { minX: 220, minY: 20, maxX: 400, maxY: 160 },
        },
      ],
      () => `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`,
    );

    expect(batch.operation.kind).toBe("items.batch");
    expect(batch.operation.operations).toHaveLength(12);
    expect(batch.itemIds).toHaveLength(12);
    expect(batch.mapBounds.minX).toBeGreaterThan(400);

    const created = batch.operation.operations.flatMap((operation) =>
      operation.kind === "item.create" ? [operation.item] : [],
    );
    expect(created.every((item) => item.assistedBy === "ai")).toBe(true);
    expect(created.filter((item) => item.kind === "line")).toHaveLength(3);
    expect(
      created.some(
        (item) => item.kind === "text" && item.geometry.text === "Reducing cafeteria waste",
      ),
    ).toBe(true);
    expect(
      created.some(
        (item) => item.kind === "sticky" && item.geometry.text.includes("Productive tension"),
      ),
    ).toBe(true);
  });

  for (const themeCount of [2, 3, 4]) {
    it(`lays out ${themeCount} themes without overlapping footers and inside the map bounds`, () => {
      const batch = buildCollectiveInquiryMap(
        {
          selectionToken: "selection-token",
          mapTitle: "Layout check",
          themes: themes(themeCount),
          bridges: [
            {
              fromThemeId: "theme_1",
              toThemeId: "theme_2",
              insight: "The first two themes share a testable assumption.",
            },
          ],
          tension: {
            statement: "Speed and thoroughness pull in different directions.",
            nextQuestion: "Which trade-off should the class test first?",
          },
        },
        Array.from({ length: themeCount }, (_, index) => ({
          alias: `idea_${index + 1}`,
          bounds: { minX: index * 200, minY: 20, maxX: index * 200 + 180, maxY: 160 },
        })),
      );

      const created = batch.operation.operations.flatMap((operation) =>
        operation.kind === "item.create" ? [operation.item] : [],
      );
      const boxes: Box[] = created.flatMap((item) =>
        item.kind === "sticky" || item.kind === "rectangle"
          ? [
              {
                minX: item.geometry.x,
                minY: item.geometry.y,
                maxX: item.geometry.x + item.geometry.width,
                maxY: item.geometry.y + item.geometry.height,
              },
            ]
          : item.kind === "text"
            ? [
                {
                  minX: item.geometry.x,
                  minY: item.geometry.y,
                  maxX: item.geometry.x,
                  maxY: item.geometry.y,
                },
              ]
            : [],
      );
      expect(boxes.length).toBe(themeCount * 3 + 3);
      expect(boxes.every((box) => within(box, batch.mapBounds))).toBe(true);

      const footers = created.flatMap((item) =>
        item.kind === "sticky" &&
        (item.geometry.text.startsWith("Bridges") ||
          item.geometry.text.startsWith("Productive tension"))
          ? [
              {
                minX: item.geometry.x,
                minY: item.geometry.y,
                maxX: item.geometry.x + item.geometry.width,
                maxY: item.geometry.y + item.geometry.height,
              },
            ]
          : [],
      );
      expect(footers).toHaveLength(2);
      const [bridges, tension] = footers as [Box, Box];
      expect(overlaps(bridges, tension)).toBe(false);
      expect(bridges.maxX).toBeLessThanOrEqual(tension.minX);
    });
  }
});

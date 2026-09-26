import { describe, expect, it } from "vitest";

import {
  buildEducationMove,
  buildEducationVisuals,
  buildGroupDecisionScaffold,
  COLLECTIVE_REASONING_MODES,
  CROSS_GROUP_MODES,
  type EducationMoveFamily,
  type EducationSource,
  GROUP_DECISION_MODES,
  IDEA_SENSEMAKING_MODES,
  LEARNING_ACTION_MODES,
  SECTION_INTEGRATION_MODES,
  THINKING_EXPANSION_MODES,
} from "./education-partner";

const SOURCES: EducationSource[] = [
  {
    alias: "idea_1",
    bounds: { minX: 0, minY: 0, maxX: 180, maxY: 140 },
  },
  {
    alias: "idea_2",
    bounds: { minX: 240, minY: 0, maxX: 420, maxY: 140 },
  },
];

function ids(): () => string {
  let next = 1;
  return () => `018f0000-0000-7000-8000-${String(next++).padStart(12, "0")}`;
}

describe("education partner board compiler", () => {
  const families: Array<{ family: EducationMoveFamily; modes: readonly string[] }> = [
    { family: "thinking_expansion", modes: THINKING_EXPANSION_MODES },
    { family: "cross_group_sensemaking", modes: CROSS_GROUP_MODES },
    { family: "collective_reasoning", modes: COLLECTIVE_REASONING_MODES },
    { family: "learning_action", modes: LEARNING_ACTION_MODES },
  ];

  for (const { family, modes } of families) {
    for (const mode of modes) {
      it(`builds source-linked, question-first ${mode}`, () => {
        const batch = buildEducationMove(
          {
            family,
            mode,
            title: "Class inquiry",
            cards: [
              {
                id: "first_move",
                heading: "First possibility",
                body: "A bounded contribution grounded in the selected discussion.",
                sourceAliases: ["idea_1"],
                question: "What evidence would make this possibility stronger?",
                role: "working hypothesis",
              },
              {
                id: "second_move",
                heading: "Second possibility",
                body: "A contrasting contribution the group can improve or reject.",
                sourceAliases: ["idea_2"],
                question: "Where might this possibility fail?",
                role: "counterpoint",
              },
            ],
            connections: [
              { fromCardId: "first_move", toCardId: "second_move", label: "test against" },
            ],
          },
          SOURCES,
          ids(),
        );

        const created = batch.operation.operations.flatMap((operation) =>
          operation.kind === "item.create" ? [operation.item] : [],
        );
        const stickies = created.filter((item) => item.kind === "sticky");
        expect(batch.operation.kind).toBe("items.batch");
        expect(batch.sourceLinkCount).toBe(2);
        expect(created.every((item) => item.assistedBy === "ai")).toBe(true);
        expect(stickies).toHaveLength(2);
        expect(
          stickies.every(
            (item) =>
              item.geometry.text.includes("SOURCE · idea_") &&
              item.geometry.text.includes("TESTABLE QUESTION") &&
              item.geometry.text.trim().endsWith("?"),
          ),
        ).toBe(true);
        expect(created.filter((item) => item.kind === "line")).toHaveLength(3);
      });
    }
  }

  for (const mode of GROUP_DECISION_MODES) {
    it(`keeps student-owned fields blank for ${mode}`, () => {
      const batch = buildGroupDecisionScaffold(
        {
          mode,
          title: "Class decision",
          entries: [
            {
              id: "option_one",
              heading: "Reusable containers",
              body: "Students proposed a return station.",
              sourceAliases: ["idea_1"],
              question: "What evidence could reopen this option?",
            },
            {
              id: "option_two",
              heading: "Smaller portions",
              body: "Students proposed portion choice.",
              sourceAliases: ["idea_2"],
              question: "What evidence could reopen this option?",
            },
          ],
          criteria: ["Access", "Impact"],
        },
        SOURCES,
        ids(),
      );
      const created = batch.operation.operations.flatMap((operation) =>
        operation.kind === "item.create" ? [operation.item] : [],
      );
      const table = created.find((item) => item.kind === "table");
      const guidance = created.find((item) => item.kind === "sticky");

      expect(created.every((item) => item.assistedBy === "ai")).toBe(true);
      expect(table?.kind).toBe("table");
      expect(guidance?.kind === "sticky" ? guidance.geometry.text : "").toMatch(
        /STUDENTS|CLASS|VOTE|DISSENT/iu,
      );
      if (table?.kind !== "table") throw new Error("Expected a decision table.");
      if (mode === "criteria_co_designer") {
        expect(table.geometry.cells.slice(1).every((row) => row[2] === "")).toBe(true);
      }
      if (mode === "tradeoff_visualizer") {
        expect(
          table.geometry.cells.slice(1).every((row) => row.slice(1).every((cell) => cell === "")),
        ).toBe(true);
      }
      if (mode === "assumption_auction") {
        expect(table.geometry.cells.slice(1).every((row) => row[3] === "")).toBe(true);
      }
      if (mode === "consensus_with_dissent") {
        expect(
          table.geometry.cells.slice(1).every((row) => row.slice(1).every((cell) => cell === "")),
        ).toBe(true);
      }
      if (mode === "decision_record") {
        expect(table.geometry.cells[1]).toEqual(["Class choice (students fill)", "", ""]);
      }
    });
  }

  const VISUAL_ASSET = {
    assetId: `asset_${"A".repeat(43)}`,
    mimeType: "image/png" as const,
    intrinsicWidth: 1_200,
    intrinsicHeight: 675,
  };

  it("uses explicit alt text on the visual image when it is supplied", () => {
    const batch = buildEducationVisuals(
      {
        title: "Lunchroom plot twist",
        visuals: [
          {
            id: "queue_meme",
            format: "meme_card",
            title: "When both ideas click",
            caption: "The joke connects packaging waste with queue flow.",
            altText: "A bright meme card with a recycling emoji and two lines of text.",
            sourceAliases: ["idea_1", "idea_2"],
            discussionPrompt: "What does the meme oversimplify?",
          },
        ],
      },
      SOURCES,
      [VISUAL_ASSET],
      ids(),
    );
    const image = batch.operation.operations
      .flatMap((operation) => (operation.kind === "item.create" ? [operation.item] : []))
      .find((item) => item.kind === "image");
    if (image?.kind !== "image") throw new Error("Expected an image item.");
    expect(image.geometry.alt).toBe(
      "A bright meme card with a recycling emoji and two lines of text.",
    );
  });

  it("falls back to the visual title as image alt text when alt text is omitted", () => {
    const batch = buildEducationVisuals(
      {
        title: "Lunchroom plot twist",
        visuals: [
          {
            id: "queue_meme",
            format: "meme_card",
            title: "When both ideas click",
            caption: "The joke connects packaging waste with queue flow.",
            sourceAliases: ["idea_1", "idea_2"],
            discussionPrompt: "What does the meme oversimplify?",
          },
        ],
      },
      SOURCES,
      [VISUAL_ASSET],
      ids(),
    );
    const image = batch.operation.operations
      .flatMap((operation) => (operation.kind === "item.create" ? [operation.item] : []))
      .find((item) => item.kind === "image");
    if (image?.kind !== "image") throw new Error("Expected an image item.");
    expect(image.geometry.alt).toBe("When both ideas click");
    expect(batch.sourceLinkCount).toBe(2);
  });

  it("covers every collaboration mode named in the hackathon objective", () => {
    expect([
      ...THINKING_EXPANSION_MODES,
      ...CROSS_GROUP_MODES,
      ...COLLECTIVE_REASONING_MODES,
      ...GROUP_DECISION_MODES,
      ...LEARNING_ACTION_MODES,
    ]).toHaveLength(28);
    expect([
      ...THINKING_EXPANSION_MODES,
      ...IDEA_SENSEMAKING_MODES,
      ...COLLECTIVE_REASONING_MODES,
      ...GROUP_DECISION_MODES,
      ...LEARNING_ACTION_MODES,
    ]).toHaveLength(27);
    expect(SECTION_INTEGRATION_MODES).toEqual(["cross_group_jigsaw"]);
  });
});

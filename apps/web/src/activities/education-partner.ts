import type { Bounds } from "@collab/geometry";

import type { BatchItemOperation, ImageGeometry } from "../types";
import { createId, roundBoard } from "../types";
import {
  boundsCenter,
  createItem,
  finalizeBatch,
  type ItemsBatchOperation,
  combinedBounds as unionSourceBounds,
} from "./batch";

export const THINKING_EXPANSION_MODES = [
  "gap_finder",
  "perspective_carousel",
  "idea_mashup",
  "constraint_shaker",
  "analogy_broker",
] as const;

export const SECTION_INTEGRATION_MODES = ["cross_group_jigsaw"] as const;

export const IDEA_SENSEMAKING_MODES = [
  "bridge_builder",
  "shared_glossary",
  "alternative_clusterer",
  "outlier_champion",
] as const;

export const CROSS_GROUP_MODES = [...SECTION_INTEGRATION_MODES, ...IDEA_SENSEMAKING_MODES] as const;

export const COLLECTIVE_REASONING_MODES = [
  "evidence_assumption_mapper",
  "productive_tension_mapper",
  "counterexample_challenge",
  "uncertainty_annotator",
  "ethics_consequences_map",
  "debate_cartographer",
] as const;

export const GROUP_DECISION_MODES = [
  "criteria_co_designer",
  "tradeoff_visualizer",
  "assumption_auction",
  "consensus_with_dissent",
  "minority_report",
  "decision_record",
] as const;

export const LEARNING_ACTION_MODES = [
  "idea_to_experiment",
  "project_decomposer",
  "peer_review_conductor",
  "teach_back_listener",
  "thinking_evolution_mirror",
  "process_replay",
] as const;

export type EducationMoveFamily =
  | "thinking_expansion"
  | "cross_group_sensemaking"
  | "collective_reasoning"
  | "learning_action";

export type EducationSource = {
  alias: string;
  bounds: Bounds;
};

export type EducationCard = {
  id: string;
  heading: string;
  body: string;
  sourceAliases: string[];
  question: string;
  role?: string;
};

export type EducationConnection = {
  fromCardId: string;
  toCardId: string;
  label: string;
};

export type EducationMoveProposal = {
  family: EducationMoveFamily;
  mode: string;
  title: string;
  cards: EducationCard[];
  connections: EducationConnection[];
};

export type GroupDecisionProposal = {
  mode: (typeof GROUP_DECISION_MODES)[number];
  title: string;
  entries: EducationCard[];
  criteria: string[];
};

export type EducationBatch = {
  operation: ItemsBatchOperation;
  itemIds: string[];
  sourceLinkCount: number;
};

export type EducationVisual = {
  id: string;
  format: "meme_card" | "inline_image";
  title: string;
  caption: string;
  altText?: string;
  sourceAliases: string[];
  discussionPrompt: string;
};

export type EducationVisualAsset = Pick<
  ImageGeometry,
  "assetId" | "mimeType" | "intrinsicWidth" | "intrinsicHeight"
>;

export type EducationVisualProposal = {
  title: string;
  visuals: EducationVisual[];
};

const CARD_WIDTH = 320;
const CARD_HEIGHT = 300;
const CARD_GAP = 42;
const MAP_GAP = 150;
const VISUAL_WIDTH = 420;
const VISUAL_HEIGHT = 320;
const VISUAL_COLUMN_GAP = 48;
const VISUAL_ROW_GAP = 48;
const VISUAL_CAPTION_HEIGHT = 200;

const FAMILY_STYLE: Record<
  EducationMoveFamily,
  { fill: string; textColor: string; line: string; title: string }
> = {
  thinking_expansion: {
    fill: "#fff0c7",
    textColor: "#493719",
    line: "#b07921",
    title: "#6c4811",
  },
  cross_group_sensemaking: {
    fill: "#dff2ff",
    textColor: "#274353",
    line: "#2d789f",
    title: "#235d79",
  },
  collective_reasoning: {
    fill: "#eee5ff",
    textColor: "#38284f",
    line: "#6840a8",
    title: "#4b2c82",
  },
  learning_action: {
    fill: "#e5f5df",
    textColor: "#29452c",
    line: "#47864c",
    title: "#315f35",
  },
};

export function buildEducationMove(
  proposal: EducationMoveProposal,
  sources: readonly EducationSource[],
  idFactory: () => string = createId,
  placementBounds?: Bounds,
): EducationBatch {
  const sourceBounds = combinedBounds(sources);
  const originX = roundBoard((placementBounds ?? sourceBounds).maxX + MAP_GAP);
  const originY = roundBoard((placementBounds ?? sourceBounds).minY);
  const style = FAMILY_STYLE[proposal.family];
  const columns = proposal.cards.length === 1 ? 1 : 2;
  const operations: BatchItemOperation[] = [];
  const itemIds: string[] = [];
  const cardsById = new Map<string, { x: number; y: number }>();
  const sourcesByAlias = new Map(sources.map((source) => [source.alias, source]));
  let sourceLinkCount = 0;

  proposal.cards.forEach((card, index) => {
    const x = originX + (index % columns) * (CARD_WIDTH + CARD_GAP);
    const y = originY + 70 + Math.floor(index / columns) * (CARD_HEIGHT + CARD_GAP);
    cardsById.set(card.id, { x, y });
    for (const alias of card.sourceAliases) {
      const source = sourcesByAlias.get(alias);
      if (!source) continue;
      const start = boundsCenter(source.bounds);
      operations.push(
        createItem(
          {
            id: idFactory(),
            kind: "line",
            style: {
              kind: "line",
              color: style.line,
              width: 2,
              opacity: 0.48,
              arrowhead: "arrow",
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: {
              x1: start[0],
              y1: start[1],
              x2: x,
              y2: y + CARD_HEIGHT / 2,
            },
          },
          itemIds,
        ),
      );
      sourceLinkCount += 1;
    }
  });

  for (const connection of proposal.connections) {
    const from = cardsById.get(connection.fromCardId);
    const to = cardsById.get(connection.toCardId);
    if (!from || !to) continue;
    const startX = from.x + CARD_WIDTH / 2;
    const startY = from.y + CARD_HEIGHT / 2;
    const endX = to.x + CARD_WIDTH / 2;
    const endY = to.y + CARD_HEIGHT / 2;
    operations.push(
      createItem(
        {
          id: idFactory(),
          kind: "line",
          style: {
            kind: "line",
            color: style.line,
            width: 3,
            opacity: 0.72,
            arrowhead: "arrow",
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x1: startX, y1: startY, x2: endX, y2: endY },
        },
        itemIds,
      ),
      createItem(
        {
          id: idFactory(),
          kind: "text",
          style: {
            kind: "text",
            color: style.title,
            fontSize: 14,
            fontFamily: "sans",
            opacity: 1,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: {
            x: roundBoard((startX + endX) / 2),
            y: roundBoard((startY + endY) / 2 - 8),
            text: connection.label,
          },
        },
        itemIds,
      ),
    );
  }

  operations.push(
    createItem(
      {
        id: idFactory(),
        kind: "text",
        style: {
          kind: "text",
          color: style.title,
          fontSize: 28,
          fontFamily: "serif",
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: originX,
          y: originY + 34,
          text: `${modeLabel(proposal.mode)} · ${proposal.title}`,
        },
      },
      itemIds,
    ),
  );

  proposal.cards.forEach((card) => {
    const position = cardsById.get(card.id);
    if (!position) return;
    operations.push(
      createItem(
        {
          id: idFactory(),
          kind: "sticky",
          style: {
            kind: "sticky",
            fill: style.fill,
            textColor: style.textColor,
            fontSize: 15,
            opacity: 1,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: {
            x: position.x,
            y: position.y,
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            text: cardText(card),
          },
        },
        itemIds,
      ),
    );
  });

  return validatedBatch(operations, itemIds, sourceLinkCount);
}

export function buildGroupDecisionScaffold(
  proposal: GroupDecisionProposal,
  sources: readonly EducationSource[],
  idFactory: () => string = createId,
  placementBounds?: Bounds,
): EducationBatch {
  const sourceBounds = combinedBounds(sources);
  const originX = roundBoard((placementBounds ?? sourceBounds).maxX + MAP_GAP);
  const originY = roundBoard((placementBounds ?? sourceBounds).minY);
  const operations: BatchItemOperation[] = [];
  const itemIds: string[] = [];
  const sourceAliases = [...new Set(proposal.entries.flatMap((entry) => entry.sourceAliases))];
  const sourcesByAlias = new Map(sources.map((source) => [source.alias, source]));
  let sourceLinkCount = 0;

  for (const alias of sourceAliases) {
    const source = sourcesByAlias.get(alias);
    if (!source) continue;
    const start = boundsCenter(source.bounds);
    operations.push(
      createItem(
        {
          id: idFactory(),
          kind: "line",
          style: {
            kind: "line",
            color: "#8d5b17",
            width: 2,
            opacity: 0.48,
            arrowhead: "arrow",
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x1: start[0], y1: start[1], x2: originX, y2: originY + 260 },
        },
        itemIds,
      ),
    );
    sourceLinkCount += 1;
  }

  const table = decisionTable(proposal);
  operations.push(
    createItem(
      {
        id: idFactory(),
        kind: "text",
        style: {
          kind: "text",
          color: "#6c4811",
          fontSize: 28,
          fontFamily: "serif",
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: originX,
          y: originY + 34,
          text: `${modeLabel(proposal.mode)} · ${proposal.title}`,
        },
      },
      itemIds,
    ),
    createItem(
      {
        id: idFactory(),
        kind: "sticky",
        style: {
          kind: "sticky",
          fill: "#fff0c7",
          textColor: "#493719",
          fontSize: 15,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: originX,
          y: originY + 68,
          width: 650,
          height: 160,
          text: decisionGuidance(proposal.mode),
        },
      },
      itemIds,
    ),
    createItem(
      {
        id: idFactory(),
        kind: "table",
        style: {
          kind: "table",
          borderColor: "#b07921",
          fill: "#ffffff",
          headerFill: "#fff0c7",
          textColor: "#493719",
          fontSize: 14,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: originX,
          y: originY + 260,
          columnWidths: table.widths,
          rowHeights: Array.from({ length: table.cells.length }, () => 54),
          cells: table.cells,
          headerRow: true,
        },
      },
      itemIds,
    ),
  );

  return validatedBatch(operations, itemIds, sourceLinkCount);
}

export function buildEducationVisuals(
  proposal: EducationVisualProposal,
  sources: readonly EducationSource[],
  assets: readonly EducationVisualAsset[],
  idFactory: () => string = createId,
  placementBounds?: Bounds,
): EducationBatch {
  if (proposal.visuals.length === 0 || proposal.visuals.length !== assets.length) {
    throw new Error("Each class visual needs one stored image asset.");
  }
  const sourceBounds = combinedBounds(sources);
  const originX = roundBoard((placementBounds ?? sourceBounds).maxX + MAP_GAP);
  const originY = roundBoard((placementBounds ?? sourceBounds).minY);
  const operations: BatchItemOperation[] = [];
  const itemIds: string[] = [];
  const sourcesByAlias = new Map(sources.map((source) => [source.alias, source]));
  let sourceLinkCount = 0;

  operations.push(
    createItem(
      {
        id: idFactory(),
        kind: "text",
        style: {
          kind: "text",
          color: "#6d2a64",
          fontSize: 28,
          fontFamily: "serif",
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: originX,
          y: originY + 34,
          text: `Class visual response · ${proposal.title}`,
        },
      },
      itemIds,
    ),
  );

  proposal.visuals.forEach((visual, index) => {
    const asset = assets[index];
    if (!asset) throw new Error("A stored image asset is missing.");
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = originX + column * (VISUAL_WIDTH + VISUAL_COLUMN_GAP);
    const y = originY + 72 + row * (VISUAL_HEIGHT + VISUAL_CAPTION_HEIGHT + VISUAL_ROW_GAP);
    const imageSize = fitVisual(asset.intrinsicWidth, asset.intrinsicHeight);
    const imageX = roundBoard(x + (VISUAL_WIDTH - imageSize.width) / 2);
    const imageY = roundBoard(y + (VISUAL_HEIGHT - imageSize.height) / 2);

    for (const alias of visual.sourceAliases) {
      const source = sourcesByAlias.get(alias);
      if (!source) continue;
      const start = boundsCenter(source.bounds);
      operations.push(
        createItem(
          {
            id: idFactory(),
            kind: "line",
            style: {
              kind: "line",
              color: "#a14691",
              width: 2,
              opacity: 0.48,
              arrowhead: "arrow",
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: {
              x1: start[0],
              y1: start[1],
              x2: imageX,
              y2: roundBoard(imageY + imageSize.height / 2),
            },
          },
          itemIds,
        ),
      );
      sourceLinkCount += 1;
    }

    operations.push(
      createItem(
        {
          id: idFactory(),
          kind: "image",
          style: { kind: "image", opacity: 1, radius: 12 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: {
            x: imageX,
            y: imageY,
            width: imageSize.width,
            height: imageSize.height,
            assetId: asset.assetId,
            mimeType: asset.mimeType,
            intrinsicWidth: asset.intrinsicWidth,
            intrinsicHeight: asset.intrinsicHeight,
            alt: visual.altText ?? visual.title,
          },
        },
        itemIds,
      ),
      createItem(
        {
          id: idFactory(),
          kind: "sticky",
          style: {
            kind: "sticky",
            fill: "#ffe2f7",
            textColor: "#53204c",
            fontSize: 15,
            opacity: 1,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: {
            x,
            y: y + VISUAL_HEIGHT + 16,
            width: VISUAL_WIDTH,
            height: VISUAL_CAPTION_HEIGHT,
            text: visualCaption(visual),
          },
        },
        itemIds,
      ),
    );
  });

  return validatedBatch(operations, itemIds, sourceLinkCount);
}

function decisionTable(proposal: GroupDecisionProposal): {
  widths: number[];
  cells: string[][];
} {
  const rows = proposal.entries.map((entry) => [
    entry.heading,
    entry.body,
    entry.sourceAliases.join(", "),
  ]);
  switch (proposal.mode) {
    case "criteria_co_designer":
      return {
        widths: [220, 300, 140],
        cells: [
          ["Possible criterion", "Working definition", "Class weight"],
          ...proposal.entries.map((entry) => [entry.heading, entry.body, ""]),
        ],
      };
    case "tradeoff_visualizer":
      return {
        widths: [220, ...proposal.criteria.map(() => 150), 180],
        cells: [
          ["Option", ...proposal.criteria, "Evidence / comments"],
          ...proposal.entries.map((entry) => [
            entry.heading,
            ...proposal.criteria.map(() => ""),
            "",
          ]),
        ],
      };
    case "assumption_auction":
      return {
        widths: [220, 280, 140, 120],
        cells: [
          ["Testable assumption", "Why it matters", "Source", "Class votes"],
          ...rows.map(([heading, body, source]) => [heading ?? "", body ?? "", source ?? "", ""]),
        ],
      };
    case "consensus_with_dissent":
      return {
        widths: [220, 110, 130, 110, 110],
        cells: [
          ["Option", "Agree", "Can live with", "Concern", "Abstain"],
          ...proposal.entries.map((entry) => [entry.heading, "", "", "", ""]),
        ],
      };
    case "minority_report":
      return {
        widths: [240, 280, 300],
        cells: [
          ["Expressed concern", "Why it matters", "What evidence or change could address it?"],
          ...proposal.entries.map((entry) => [entry.heading, entry.body, entry.question]),
        ],
      };
    case "decision_record":
      return {
        widths: [230, 280, 300],
        cells: [
          [
            "Class decision / alternative",
            "Why the class considered it",
            "Evidence that could reopen it",
          ],
          ["Class choice (students fill)", "", ""],
          ...proposal.entries.map((entry) => [entry.heading, entry.body, entry.question]),
        ],
      };
  }
}

function decisionGuidance(mode: GroupDecisionProposal["mode"]): string {
  const guidance: Record<GroupDecisionProposal["mode"], string> = {
    criteria_co_designer:
      "STUDENTS ASSIGN THE PRIORITY\n\nPossible criteria were drafted from the selected discussion. The class edits the wording and fills the weights.",
    tradeoff_visualizer:
      "STUDENTS MAKE THE TRADE-OFFS\n\nOptions were structured against class-selected criteria. The class fills every rating and evidence cell.",
    assumption_auction:
      "VOTE ON WHAT TO INVESTIGATE\n\nThese are testable assumptions, not facts. Students place the votes and choose what to test first.",
    consensus_with_dissent:
      "RECORD EXPLICIT RESPONSES\n\nStudents fill agree, can live with, concern, or abstain. Silence is never counted as consensus.",
    minority_report:
      "PRESERVE EXPRESSED DISSENT\n\nKeep concerns in the class's words and record what evidence or change could address them.",
    decision_record:
      "THE CLASS MAKES THE DECISION\n\nRecord the explicit choice, alternatives, reasons, and evidence that could reopen it. Do not infer consensus from silence.",
  };
  return guidance[mode];
}

function cardText(card: EducationCard): string {
  return [
    card.role ? card.role.toLocaleUpperCase() : "COLLABORATION MOVE",
    card.heading,
    "",
    card.body,
    "",
    `SOURCE · ${card.sourceAliases.join(" · ")}`,
    "",
    "TESTABLE QUESTION",
    card.question,
  ].join("\n");
}

function visualCaption(visual: EducationVisual): string {
  return [
    visual.format === "meme_card" ? "CLASS MEME" : "CLASS ILLUSTRATION",
    visual.title,
    "",
    visual.caption,
    "",
    `SOURCE · ${visual.sourceAliases.join(" · ")}`,
    "",
    "DISCUSS TOGETHER",
    visual.discussionPrompt,
  ].join("\n");
}

function fitVisual(
  intrinsicWidth: number,
  intrinsicHeight: number,
): { width: number; height: number } {
  const scale = Math.min(VISUAL_WIDTH / intrinsicWidth, VISUAL_HEIGHT / intrinsicHeight);
  return {
    width: Math.max(1, roundBoard(intrinsicWidth * scale)),
    height: Math.max(1, roundBoard(intrinsicHeight * scale)),
  };
}

function validatedBatch(
  operations: BatchItemOperation[],
  itemIds: string[],
  sourceLinkCount: number,
): EducationBatch {
  return {
    operation: finalizeBatch(
      operations,
      "This collaboration move is too large for one shared update.",
      { rejectEmpty: true },
    ),
    itemIds,
    sourceLinkCount,
  };
}

function combinedBounds(sources: readonly EducationSource[]): Bounds {
  if (sources.length === 0) throw new Error("At least one source contribution is required.");
  const bounds = unionSourceBounds(sources);
  if (!bounds) throw new Error("The source contributions have no layout bounds.");
  return bounds;
}

export function modeLabel(mode: string): string {
  return mode
    .split("_")
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

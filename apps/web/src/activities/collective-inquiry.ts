import type { Bounds } from "@collab/geometry";

import type { BatchItemOperation, Point } from "../types";
import { createId, roundBoard } from "../types";
import {
  boundsCenter,
  combinedBounds,
  createItem,
  finalizeBatch,
  type ItemsBatchOperation,
} from "./batch";

export type InquiryTheme = {
  id: string;
  label: string;
  summary: string;
  ideaAliases: string[];
};

export type InquiryBridge = {
  fromThemeId: string;
  toThemeId: string;
  insight: string;
};

export type CollectiveInquiryProposal = {
  selectionToken: string;
  mapTitle: string;
  themes: InquiryTheme[];
  bridges: InquiryBridge[];
  tension: {
    statement: string;
    nextQuestion: string;
  };
};

export type InquirySource = {
  alias: string;
  bounds: Bounds;
};

export type CollectiveInquiryBatch = {
  operation: ItemsBatchOperation;
  itemIds: string[];
  mapBounds: Bounds;
};

const MAP_GAP = 150;
const CLUSTER_WIDTH = 340;
const CLUSTER_HEIGHT = 230;
const CLUSTER_GAP = 36;
const HEADER_HEIGHT = 64;
const SUMMARY_WIDTH = 300;
const SUMMARY_HEIGHT = 132;
const FOOTER_GAP = 24;
const FOOTER_MIN_WIDTH = 320;
const FOOTER_HEIGHT = 190;

const THEME_FILLS = ["#eee5ff", "#dff2ff", "#ffe7dd", "#e5f5df"] as const;

export class CollectiveInquiryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectiveInquiryError";
  }
}

export function buildCollectiveInquiryMap(
  proposal: CollectiveInquiryProposal,
  sources: readonly InquirySource[],
  idFactory: () => string = createId,
): CollectiveInquiryBatch {
  if (proposal.themes.length < 2 || proposal.themes.length > 4) {
    throw new CollectiveInquiryError("An inquiry map needs two to four themes.");
  }
  if (sources.length === 0) {
    throw new CollectiveInquiryError("The selected ideas are no longer available.");
  }

  const sourceBounds = combinedBounds(sources);
  if (!sourceBounds) throw new CollectiveInquiryError("The selected ideas have no layout bounds.");

  const columns = proposal.themes.length === 2 ? 1 : 2;
  const rows = Math.ceil(proposal.themes.length / columns);
  const clusterRowWidth = columns * CLUSTER_WIDTH + (columns - 1) * CLUSTER_GAP;
  // The bridges and tension stickies sit side by side under the clusters; a
  // single-column map is narrower than that pair, so the map grows to fit them.
  const footerWidth = Math.max(FOOTER_MIN_WIDTH, (clusterRowWidth - FOOTER_GAP) / 2);
  const mapWidth = Math.max(clusterRowWidth, footerWidth * 2 + FOOTER_GAP);
  const mapHeight = HEADER_HEIGHT + rows * CLUSTER_HEIGHT + (rows - 1) * CLUSTER_GAP + 250;
  const originX = roundBoard(sourceBounds.maxX + MAP_GAP);
  const originY = roundBoard(sourceBounds.minY);
  const mapBounds: Bounds = {
    minX: originX,
    minY: originY,
    maxX: originX + mapWidth,
    maxY: originY + mapHeight,
  };

  const itemIds: string[] = [];
  const operations: BatchItemOperation[] = [];
  const themeCenters = new Map<string, Point>();
  const themesById = new Map(proposal.themes.map((theme) => [theme.id, theme]));

  proposal.themes.forEach((theme, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = originX + column * (CLUSTER_WIDTH + CLUSTER_GAP);
    const y = originY + HEADER_HEIGHT + row * (CLUSTER_HEIGHT + CLUSTER_GAP);
    themeCenters.set(theme.id, [x + CLUSTER_WIDTH / 2, y + 132]);
  });

  // Connectors are created first so the semantic cards remain visually dominant.
  for (const theme of proposal.themes) {
    const target = themeCenters.get(theme.id);
    if (!target) continue;
    for (const alias of theme.ideaAliases) {
      const source = sources.find((candidate) => candidate.alias === alias);
      if (!source) continue;
      const start = boundsCenter(source.bounds);
      operations.push(
        createItem(
          {
            id: idFactory(),
            kind: "line",
            style: {
              kind: "line",
              color: "#8b75ad",
              width: 2,
              opacity: 0.42,
              arrowhead: "arrow",
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: {
              x1: start[0],
              y1: start[1],
              x2: target[0],
              y2: target[1],
            },
          },
          itemIds,
        ),
      );
    }
  }

  const bridgeY = originY + HEADER_HEIGHT + rows * CLUSTER_HEIGHT + (rows - 1) * CLUSTER_GAP + 30;
  for (const bridge of proposal.bridges) {
    const start = themeCenters.get(bridge.fromThemeId);
    const end = themeCenters.get(bridge.toThemeId);
    if (
      !start ||
      !end ||
      !themesById.has(bridge.fromThemeId) ||
      !themesById.has(bridge.toThemeId)
    ) {
      continue;
    }
    operations.push(
      createItem(
        {
          id: idFactory(),
          kind: "line",
          style: {
            kind: "line",
            color: "#6840a8",
            width: 4,
            opacity: 0.82,
            arrowhead: "arrow",
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x1: start[0], y1: start[1], x2: end[0], y2: end[1] },
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
          color: "#4b2c82",
          fontSize: 30,
          fontFamily: "serif",
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: originX,
          y: originY + 36,
          text: proposal.mapTitle,
        },
      },
      itemIds,
    ),
  );

  proposal.themes.forEach((theme, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = originX + column * (CLUSTER_WIDTH + CLUSTER_GAP);
    const y = originY + HEADER_HEIGHT + row * (CLUSTER_HEIGHT + CLUSTER_GAP);
    operations.push(
      createItem(
        {
          id: idFactory(),
          kind: "rectangle",
          style: { kind: "stroke", color: "#7956ae", width: 3, opacity: 0.9 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: {
            x,
            y,
            width: CLUSTER_WIDTH,
            height: CLUSTER_HEIGHT,
            shape: "rectangle",
          },
        },
        itemIds,
      ),
      createItem(
        {
          id: idFactory(),
          kind: "text",
          style: {
            kind: "text",
            color: "#4b2c82",
            fontSize: 22,
            fontFamily: "sans",
            opacity: 1,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: x + 18, y: y + 34, text: theme.label },
        },
        itemIds,
      ),
      createItem(
        {
          id: idFactory(),
          kind: "sticky",
          style: {
            kind: "sticky",
            fill: THEME_FILLS[index % THEME_FILLS.length] ?? THEME_FILLS[0],
            textColor: "#2e2934",
            fontSize: 16,
            opacity: 1,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: {
            x: x + 20,
            y: y + 58,
            width: SUMMARY_WIDTH,
            height: SUMMARY_HEIGHT,
            text: `Synthesis\n\n${theme.summary}`,
          },
        },
        itemIds,
      ),
    );
  });

  const bridgeText = proposal.bridges
    .map((bridge) => {
      const from = themesById.get(bridge.fromThemeId)?.label ?? bridge.fromThemeId;
      const to = themesById.get(bridge.toThemeId)?.label ?? bridge.toThemeId;
      return `${from} ↔ ${to}: ${bridge.insight}`;
    })
    .join("\n");
  operations.push(
    createItem(
      {
        id: idFactory(),
        kind: "sticky",
        style: {
          kind: "sticky",
          fill: "#eee5ff",
          textColor: "#38284f",
          fontSize: 16,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: originX,
          y: bridgeY,
          width: footerWidth,
          height: FOOTER_HEIGHT,
          text: `Bridges\n\n${bridgeText || "Look for a bridge the class wants to test."}`,
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
          fill: "#ffe7dd",
          textColor: "#4b2d29",
          fontSize: 16,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: originX + footerWidth + FOOTER_GAP,
          y: bridgeY,
          width: footerWidth,
          height: FOOTER_HEIGHT,
          text: `Productive tension\n\n${proposal.tension.statement}\n\nNEXT QUESTION\n${proposal.tension.nextQuestion}`,
        },
      },
      itemIds,
    ),
  );

  const operation = finalizeBatch(
    operations,
    "This inquiry map is too large for one shared update.",
    { errorType: CollectiveInquiryError },
  );
  return { operation, itemIds, mapBounds };
}

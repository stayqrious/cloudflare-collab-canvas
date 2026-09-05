import { MAX_BATCH_OPERATIONS } from "@collab/protocol";

import { DRAWING_COLOR_VALUES, STICKY_COLOR_VALUES } from "../palette";
import type { BatchItemOperation, DurableOperation, Matrix, NewBoardItem, Point } from "../types";
import { createId, roundBoard } from "../types";
import { DEMO_BOARDS } from "./demo-boards";
import type { ActivityTemplateItem } from "./template-items";
import { MUTED, outline, pencil, stamp, sticky, table, text, zone } from "./template-items";
import { VOTE_TABLE_STYLE } from "./voting";

export type { ActivityTemplateItem } from "./template-items";

export type ActivityTemplateId =
  | "exit-ticket"
  | "kwl"
  | "sort-it"
  | "pair-share"
  | "collective-inquiry-demo"
  | "vote-with-stamps"
  | "graph-check"
  | "student-questions"
  | "brainstorm-school-traffic"
  | "problem-set-six-students"
  | "debate-school-start"
  | "tasks-four-projects"
  | "marketing-ad-ideas";

export type ActivityTemplate = {
  id: ActivityTemplateId;
  label: string;
  description: string;
  items: readonly ActivityTemplateItem[];
};

export type ActivityBatch = {
  operation: Extract<DurableOperation, { kind: "items.batch" }>;
  itemIds: string[];
};

export const ACTIVITY_TEMPLATES: readonly ActivityTemplate[] = [
  ...DEMO_BOARDS,
  {
    id: "graph-check",
    label: "Graph check: one student's working",
    description: "One student's handwritten graph, with the roots marked in the wrong place.",
    items: [
      zone(-430, -196, 530, 400, "Priya's working"),
      // Typeset math is wider than its source, so the title carries the formula and nothing else.
      text(-430, -304, "Sketch \\(y = x^2 + 7x + 10\\)", 28),
      text(-430, -252, "Mark where the curve crosses the x-axis.", 19),
      text(
        -430,
        -222,
        "Synthetic student work for a demo. Nothing here belongs to a real student.",
        16,
        MUTED,
      ),
      pencil(
        [
          [-389.0, 59.2],
          [-360.1, 61.1],
          [-333.8, 59.1],
          [-306.2, 60.0],
          [-277.4, 58.6],
          [-250.4, 61.6],
          [-220.7, 58.3],
          [-193.9, 61.6],
          [-165.8, 61.6],
          [-136.0, 59.1],
          [-107.8, 61.0],
          [-81.6, 59.5],
          [-51.8, 60.4],
          [-24.4, 61.3],
          [2.1, 59.4],
          [31.8, 58.8],
          [59.1, 59.0],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [-161.7, -171.1],
          [-159.3, -149.0],
          [-159.1, -125.6],
          [-159.0, -101.4],
          [-160.1, -81.9],
          [-159.7, -57.6],
          [-160.5, -34.6],
          [-159.6, -15.4],
          [-159.6, 8.7],
          [-161.3, 32.0],
          [-160.6, 52.5],
          [-158.3, 75.6],
          [-159.6, 97.1],
          [-160.0, 118.5],
        ],
        DRAWING_COLOR_VALUES.ink,
        3,
      ),
      pencil(
        [
          [-328.2, -93.4],
          [-320.6, -58.6],
          [-313.3, -30.7],
          [-303.5, -0.7],
          [-294.9, 23.1],
          [-287.9, 41.8],
          [-281.8, 60.9],
          [-271.6, 73.1],
          [-266.0, 85.0],
          [-256.6, 95.4],
          [-246.8, 99.7],
          [-239.2, 100.8],
          [-233.4, 99.1],
          [-223.0, 93.0],
          [-216.3, 85.5],
          [-206.8, 72.6],
          [-201.8, 59.8],
          [-192.6, 42.9],
          [-183.7, 21.1],
          [-175.9, -2.9],
          [-167.1, -28.2],
          [-159.3, -61.5],
          [-151.4, -95.1],
        ],
        DRAWING_COLOR_VALUES.blue,
        4,
      ),
      pencil(
        [
          [-279.4, 50.0],
          [-279.1, 54.0],
          [-279.2, 60.6],
          [-280.9, 64.7],
          [-279.7, 70.1],
        ],
        DRAWING_COLOR_VALUES.red,
        4,
      ),
      pencil(
        [
          [-199.2, 50.0],
          [-200.0, 55.9],
          [-200.6, 59.7],
          [-201.1, 64.7],
          [-199.4, 69.0],
        ],
        DRAWING_COLOR_VALUES.red,
        4,
      ),
      text(-292, 96, "-3", 20, DRAWING_COLOR_VALUES.red),
      text(-212, 96, "-1", 20, DRAWING_COLOR_VALUES.red),
      sticky(
        150,
        -220,
        240,
        150,
        "I think the roots are \\(x=-3\\) and \\(x=-1\\).",
        STICKY_COLOR_VALUES.yellow,
      ),
      sticky(
        150,
        -50,
        240,
        150,
        "I checked \\(x=-3\\): \\(9-21+10=-2\\), not zero.",
        STICKY_COLOR_VALUES.sky,
      ),
    ],
  },
  {
    id: "collective-inquiry-demo",
    label: "Collective inquiry demo",
    description: "Seed a full class collaboration story in one click.",
    items: [
      text(-650, -360, "How might our school reduce cafeteria waste?", 32),
      text(
        -650,
        -315,
        "Eight students have contributed. Select their ideas and build on them together.",
        18,
        MUTED,
      ),
      sticky(
        -650,
        -250,
        180,
        140,
        "Offer smaller portions first, with free seconds.",
        STICKY_COLOR_VALUES.yellow,
      ),
      sticky(
        -450,
        -250,
        180,
        140,
        "Create a reusable container return station.",
        STICKY_COLOR_VALUES.sky,
      ),
      sticky(
        -250,
        -250,
        180,
        140,
        "Let students pre-order lunch so kitchens know demand.",
        STICKY_COLOR_VALUES.mint,
      ),
      sticky(
        -50,
        -250,
        180,
        140,
        "Show each day’s food waste on a public dashboard.",
        STICKY_COLOR_VALUES.lavender,
      ),
      sticky(
        -650,
        -90,
        180,
        140,
        "Compost scraps with the school garden.",
        STICKY_COLOR_VALUES.coral,
      ),
      sticky(
        -450,
        -90,
        180,
        140,
        "Ask why unopened food cannot be shared safely.",
        STICKY_COLOR_VALUES.slate,
      ),
      sticky(
        -250,
        -90,
        180,
        140,
        "Run a taste-test before adding unfamiliar meals.",
        STICKY_COLOR_VALUES.yellow,
      ),
      sticky(
        -50,
        -90,
        180,
        140,
        "Packaging matters, but long lunch queues matter too.",
        STICKY_COLOR_VALUES.sky,
      ),
      text(-650, 105, "After the inquiry map: students respond, then vote with stamps.", 18, MUTED),
      text(-650, 155, "Which idea should the class pilot first?", 22),
      table(
        -650,
        185,
        [200, 200, 200],
        [52, 190],
        [
          ["Container return", "Smaller portions", "Waste dashboard"],
          ["", "", ""],
        ],
        { ...VOTE_TABLE_STYLE },
      ),
    ],
  },
  {
    id: "exit-ticket",
    label: "Exit ticket",
    description: "Collect learning, questions, and requests for help.",
    items: [
      text(-350, -235, "Exit ticket", 32),
      outline(-350, -190, 220, 330),
      outline(-110, -190, 220, 330),
      outline(130, -190, 220, 330),
      sticky(-330, -170, 180, 90, "I learned…", STICKY_COLOR_VALUES.yellow),
      sticky(-90, -170, 180, 90, "I wonder…", STICKY_COLOR_VALUES.sky),
      sticky(150, -170, 180, 90, "I need help with…", STICKY_COLOR_VALUES.coral),
    ],
  },
  {
    id: "kwl",
    label: "K-W-L",
    description: "Capture what students know, wonder, and learned.",
    items: [
      text(-345, -205, "K-W-L", 32),
      table(
        -345,
        -165,
        [230, 230, 230],
        [52, 92, 92, 92],
        [
          ["What I know", "What I want to know", "What I learned"],
          ["", "", ""],
          ["", "", ""],
          ["", "", ""],
        ],
      ),
    ],
  },
  {
    id: "sort-it",
    label: "Sort it",
    description: "Move starter stickies into two labelled groups.",
    items: [
      text(-370, -245, "Sort it", 32),
      text(-370, -210, "Move each sticky into the best group.", 18, MUTED),
      outline(-370, -170, 340, 280),
      outline(30, -170, 340, 280),
      text(-345, -135, "Group A", 24),
      text(55, -135, "Group B", 24),
      sticky(-345, 145, 150, 110, "Item 1", STICKY_COLOR_VALUES.yellow),
      sticky(-180, 145, 150, 110, "Item 2", STICKY_COLOR_VALUES.sky),
      sticky(-15, 145, 150, 110, "Item 3", STICKY_COLOR_VALUES.mint),
      sticky(150, 145, 150, 110, "Item 4", STICKY_COLOR_VALUES.lavender),
      sticky(-97.5, 270, 150, 110, "Item 5", STICKY_COLOR_VALUES.slate),
      sticky(67.5, 270, 150, 110, "Item 6", STICKY_COLOR_VALUES.coral),
    ],
  },
  {
    id: "pair-share",
    label: "Pair share",
    description: "Give two partners a clear side-by-side work area.",
    items: [
      text(-390, -235, "Pair share", 32),
      outline(-390, -190, 370, 330),
      outline(20, -190, 370, 330),
      text(-365, -150, "Partner A", 24),
      text(45, -150, "Partner B", 24),
      sticky(-350, -100, 180, 140, "Add your thinking…", STICKY_COLOR_VALUES.yellow),
      sticky(60, -100, 180, 140, "Add your thinking…", STICKY_COLOR_VALUES.sky),
    ],
  },
  {
    id: "vote-with-stamps",
    label: "Vote with stamps",
    description: "Ask a question and count stamps in each option.",
    items: [
      text(-300, -210, "Vote with stamps", 32),
      text(-300, -165, "Question: …", 22),
      table(
        -300,
        -125,
        [200, 200, 200],
        [52, 190],
        [
          ["Option A", "Option B", "Option C"],
          ["", "", ""],
        ],
        { ...VOTE_TABLE_STYLE },
      ),
      stamp(-280, 175),
    ],
  },
] as const;

export function getActivityTemplate(templateId: ActivityTemplateId): ActivityTemplate {
  const template = ACTIVITY_TEMPLATES.find(({ id }) => id === templateId);
  if (!template) throw new RangeError(`Unknown activity template: ${templateId}`);
  return template;
}

export function buildActivityBatch(
  templateId: ActivityTemplateId,
  center: Point,
  idFactory: () => string = createId,
): ActivityBatch {
  const template = getActivityTemplate(templateId);
  if (template.items.length < 1 || template.items.length > MAX_BATCH_OPERATIONS) {
    throw new RangeError(`Activity templates must contain 1 to ${MAX_BATCH_OPERATIONS} items.`);
  }
  const transform: Matrix = [1, 0, 0, 1, roundBoard(center[0]), roundBoard(center[1])];
  const itemIds: string[] = [];
  const operations: BatchItemOperation[] = template.items.map((source) => {
    const id = idFactory();
    itemIds.push(id);
    const item = {
      ...structuredClone(source),
      id,
      transform: [...transform] as Matrix,
    } as NewBoardItem;
    return { kind: "item.create", item };
  });
  return { operation: { kind: "items.batch", operations }, itemIds };
}

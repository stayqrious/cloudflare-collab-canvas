import { DRAWING_COLOR_VALUES, STICKY_COLOR_VALUES } from "../palette";
import { handwriting } from "./handwriting";
import type { ActivityTemplateItem } from "./template-items";
import { MUTED, seeded, stamp, sticky, text, zone } from "./template-items";

/**
 * Demo boards that look like a real room mid-lesson. The mess is in the content, not the
 * drawing: one student writes five cards and another one, one side of a debate outnumbers the
 * other, one student finishes every problem and another stops at two, and not everyone agrees
 * with the question. That is what a person finds hard to take in at once and an assistant does
 * not. Every student, task, and idea is synthetic.
 */
export type DemoTemplate = {
  id:
    | "student-questions"
    | "brainstorm-school-traffic"
    | "problem-set-six-students"
    | "debate-school-start"
    | "tasks-four-projects"
    | "marketing-ad-ideas";
  label: string;
  description: string;
  items: readonly ActivityTemplateItem[];
};

type Rect = readonly [x: number, y: number, width: number, height: number];

const STICKY_FILLS = Object.values(STICKY_COLOR_VALUES);

/** A sticky note tall enough for its text at this width, so nothing is cut off. */
function note(
  x: number,
  y: number,
  width: number,
  value: string,
  fill: string,
  fontSize = 16,
): ActivityTemplateItem {
  const perLine = Math.max(8, Math.floor((width - 32) / (fontSize * 0.62)));
  const lines = value
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  const height = Math.round(30 + lines * fontSize * 1.25);
  return sticky(x, y, width, height, value, fill, fontSize);
}

/** Scatter notes down a Section: each takes its own row, but drifts sideways and resizes. */
function scatter(
  [zx, zy, zw, zh]: Rect,
  notes: readonly string[],
  fill: string,
  random: () => number,
  widths: readonly [min: number, max: number] = [240, 340],
): ActivityTemplateItem[] {
  const rowHeight = (zh - 56) / Math.max(1, notes.length);
  return notes.map((value, index) => {
    const width = Math.round(Math.min(zw - 24, widths[0] + random() * (widths[1] - widths[0])));
    const x = Math.round(zx + 12 + random() * Math.max(0, zw - width - 24));
    const y = Math.round(zy + 50 + index * rowHeight + random() * Math.max(0, rowHeight - 92));
    return note(x, y, width, value, fill);
  });
}

type StudentCards = readonly [name: string, rect: Rect, fill: string, cards: readonly string[]];

function studentBoard(
  random: () => number,
  students: readonly StudentCards[],
): ActivityTemplateItem[] {
  const items: ActivityTemplateItem[] = [];
  for (const [name, rect, fill, cards] of students) {
    items.push(zone(...rect, name));
    items.push(...scatter(rect, cards, fill, random));
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Need to know: eclipses. Four questions from one student, one from another.
// ---------------------------------------------------------------------------------------------

function eclipseBoard(): DemoTemplate {
  const random = seeded(31);
  const items: ActivityTemplateItem[] = [
    text(-640, -282, "Need to know: eclipses", 30),
    text(
      -640,
      -244,
      "Before we start, each student writes what they want to find out. Synthetic work.",
      17,
      MUTED,
    ),
    ...studentBoard(random, [
      [
        "Aarav",
        [-640, -190, 400, 456],
        STICKY_COLOR_VALUES.yellow,
        [
          "Why is there not a solar eclipse every month?",
          "Does everyone on Earth see the same eclipse?",
          "How fast does the shadow move across us?",
          "Is it dangerous to be outside during one?",
        ],
      ],
      [
        "Meera",
        [-200, -220, 360, 256],
        STICKY_COLOR_VALUES.sky,
        [
          "How can the Moon cover something as big as the Sun?",
          "How long does totality actually last?",
        ],
      ],
      [
        "Rohan",
        [200, -200, 420, 556],
        STICKY_COLOR_VALUES.mint,
        [
          "What is the difference between a lunar and a solar eclipse?",
          "Why does the Moon turn red in a lunar eclipse?",
          "Do the planets have eclipses too?",
          "What would we see standing on the Moon?",
          "Can we make one in class with a torch and a ball?",
        ],
      ],
      [
        "Zoya",
        [-640, 310, 330, 156],
        STICKY_COLOR_VALUES.lavender,
        ["Why do we need to learn this?"],
      ],
      [
        "Kabir",
        [-220, 80, 400, 356],
        STICKY_COLOR_VALUES.coral,
        [
          "How do people predict the date years ahead?",
          "Where is the next one visible from here?",
          "Did anyone predict them before telescopes?",
        ],
      ],
      [
        "Isha",
        [200, 400, 380, 356],
        STICKY_COLOR_VALUES.slate,
        [
          "What is the dark middle of the shadow called?",
          "Why is the shadow so small when the Sun is so big?",
          "How often does one happen anywhere on Earth?",
        ],
      ],
    ]),
    // One question landed outside everybody's Section.
    note(
      -200,
      470,
      300,
      "Can animals tell that an eclipse is happening?",
      STICKY_COLOR_VALUES.yellow,
    ),
  ];
  return {
    id: "student-questions",
    label: "Need to know: eclipses",
    description: "Six students, one Section each, with the questions they want answered.",
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// Brainstorm: traffic near school. Five ideas from one student, one from another, and two who
// question whether the problem is worth solving.
// ---------------------------------------------------------------------------------------------

function trafficBoard(): DemoTemplate {
  const random = seeded(47);
  const items: ActivityTemplateItem[] = [
    text(-640, -282, "How could we cut the traffic outside school?", 30),
    text(
      -640,
      -244,
      "Every idea welcome. One Section each, so nobody's thinking gets lost. Synthetic work.",
      17,
      MUTED,
    ),
    ...studentBoard(random, [
      [
        "Aarav",
        [-640, -190, 400, 556],
        STICKY_COLOR_VALUES.yellow,
        [
          "Stagger the end of the day by year group.",
          "Ask families to park a street away and walk the last bit.",
          "Would the shops mind us parking there?",
          "Honestly it is ten bad minutes. Is it worth all this?",
          "My dad says the council will never agree to anything.",
        ],
      ],
      [
        "Meera",
        [-200, -220, 360, 256],
        STICKY_COLOR_VALUES.sky,
        [
          "Count the cars for a week before we decide anything.",
          "Ask the council for the accident record near the gate.",
        ],
      ],
      [
        "Rohan",
        [200, -200, 400, 456],
        STICKY_COLOR_VALUES.mint,
        [
          "Make the gate road one way at drop-off and pick-up.",
          "Who would actually enforce it, though?",
          "Paint a clear crossing where everyone already crosses.",
          "A lollipop person at the junction, not just the gate.",
        ],
      ],
      [
        "Zoya",
        [-640, 410, 330, 156],
        STICKY_COLOR_VALUES.lavender,
        ["Safe cycle racks so more of us ride in."],
      ],
      [
        "Kabir",
        [-220, 80, 400, 356],
        STICKY_COLOR_VALUES.coral,
        [
          "Move the bus stop nearer the side gate.",
          "A drop-off loop so nobody has to turn around in the road.",
          "Later start on Wednesdays, and measure the difference.",
        ],
      ],
      [
        "Isha",
        [220, 300, 380, 456],
        STICKY_COLOR_VALUES.slate,
        [
          "Survey families on what would really change their trip.",
          "Most of the traffic is in ten minutes, so spread those ten.",
          "Prizes for the class that walks or cycles most.",
          "Cost? Who pays for any of this?",
        ],
      ],
    ]),
    // Two ideas nobody claimed, dropped in the gaps between Sections.
    note(-200, 480, 280, "e-scooters?? for the older ones", STICKY_COLOR_VALUES.yellow),
    sticky(620, -60, 150, 90, "PARKING", STICKY_COLOR_VALUES.coral, 26),
  ];
  return {
    id: "brainstorm-school-traffic",
    label: "Brainstorm: traffic near school",
    description: "Six students, one Section each, brainstorming a real school problem.",
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// Problem set: six students, with working. One has every answer right, one has two wrong, two
// stopped at the second problem, and the working is a mix of typed and drawn.
// ---------------------------------------------------------------------------------------------

const PROBLEMS = [
  "1.   3 + 4 × 2 =",
  "2.   12 − 5 + 3 =",
  "3.   (8 − 3)² =",
  "4.   −4 + 9 =",
  "5.   20 ÷ 4 × 5 =",
] as const;
const QUESTION_FONT = 17;
const PROBLEM_BLOCK = 105;

type Student = {
  name: string;
  zone: Rect;
  seed: number;
  ink: string;
  /** Working typed in a handwriting face, by problem index. */
  typed?: Readonly<Record<number, string>>;
  /** Working drawn stroke by stroke, by problem index. */
  drawn?: Readonly<Record<number, string>>;
};

const STUDENTS: readonly Student[] = [
  {
    name: "Aarav",
    zone: [-640, -200, 440, 600],
    seed: 11,
    ink: DRAWING_COLOR_VALUES.blue,
    typed: {
      0: "4×2 = 8\n3 + 8 = 11",
      1: "5 + 3 = 8\n12 − 8 = 4",
      2: "8 − 3 = 5\n5² = 25",
      3: "−4 + 9 = 5",
      4: "4 × 5 = 20\n20 ÷ 20 = 1",
    },
  },
  {
    name: "Meera",
    zone: [-170, -236, 430, 612],
    seed: 13,
    ink: DRAWING_COLOR_VALUES.ink,
    typed: {
      0: "4×2 = 8, 3 + 8 = 11",
      1: "12 − 5 = 7\n7 + 3 = 10",
      2: "(5)² = 25",
      3: "9 − 4 = 5",
      4: "20 ÷ 4 = 5\n5 × 5 = 25",
    },
  },
  {
    name: "Rohan",
    zone: [300, -190, 450, 590],
    seed: 17,
    ink: DRAWING_COLOR_VALUES.blue,
    typed: { 0: "3 + 8 = 11", 1: "7 + 3 = 10", 2: "5² = 25" },
    drawn: { 3: "-4+9=-5" },
  },
  {
    name: "Zoya",
    zone: [-660, 436, 440, 600],
    seed: 19,
    ink: DRAWING_COLOR_VALUES.ink,
    typed: { 0: "3 + 4 = 7\n7 × 2 = 14", 1: "12 − 5 = 7\n7 + 3 = 10" },
  },
  {
    name: "Kabir",
    zone: [-186, 420, 440, 600],
    seed: 23,
    ink: DRAWING_COLOR_VALUES.blue,
    typed: {
      0: "8 + 3 = 11",
      1: "7 + 3 = 10",
      2: "8 − 3 = 5\n5 × 2 = 10",
      3: "−4 + 9 = 5",
      4: "20 ÷ 4 = 5\n5 × 5 = 25",
    },
  },
  {
    name: "Isha",
    zone: [296, 452, 450, 620],
    seed: 29,
    ink: DRAWING_COLOR_VALUES.blue,
    drawn: { 0: "4×2=8\n3+8=11", 1: "12-5=7\n7+3=10" },
  },
];

function problemSetBoard(): DemoTemplate {
  const random = seeded(59);
  const items: ActivityTemplateItem[] = [
    text(-640, -300, "Order of operations: five problems each", 30),
    text(
      -640,
      -262,
      "Aarav to Isha are working the same set, some typed, some by hand. Synthetic work, mistakes and all.",
      17,
      MUTED,
    ),
  ];
  for (const student of STUDENTS) {
    const [zx, zy] = student.zone;
    items.push(zone(...student.zone, student.name));
    const questionTop = zy + 64;
    for (let index = 0; index < PROBLEMS.length; index += 1) {
      const baseline = questionTop + index * PROBLEM_BLOCK;
      items.push(text(zx + 18, baseline, PROBLEMS[index] ?? "", QUESTION_FONT));
      const typed = student.typed?.[index];
      if (typed !== undefined) {
        items.push(
          text(
            zx + 180 + Math.round(random() * 40),
            baseline + 30,
            typed,
            19,
            student.ink,
            "handwritten",
          ),
        );
      }
      const drawn = student.drawn?.[index];
      if (drawn !== undefined) {
        items.push(
          ...handwriting(zx + 180, baseline + 50, drawn, {
            seed: student.seed * 7 + index,
            color: student.ink,
          }),
        );
      }
    }
  }
  items.push(
    note(230, -300, 190, "done ✓  what now?", STICKY_COLOR_VALUES.mint, 17),
    note(-330, 1000, 170, "stuck on 3 ??", STICKY_COLOR_VALUES.coral, 17),
  );
  return {
    id: "problem-set-six-students",
    label: "Problem set: six students",
    description:
      "Six students, five problems each, working shown by hand. Two have finished, two are half way.",
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// Debate: a 9 am start. Five claims on one side, two on the other, and one that takes neither.
// ---------------------------------------------------------------------------------------------

function debateBoard(): DemoTemplate {
  const random = seeded(71);
  const forZone: Rect = [-600, -180, 560, 556];
  const againstZone: Rect = [20, -160, 520, 256];
  const items: ActivityTemplateItem[] = [
    text(-600, -262, "This school should start at 9 am instead of 8 am", 30),
    text(-600, -224, "Each side writes its claims in its own Section. Synthetic work.", 17, MUTED),
    zone(...forZone, "For a 9 am start"),
    zone(...againstZone, "Against a 9 am start"),
    ...scatter(
      forZone,
      [
        "We would be less tired, so we would learn more in the first lesson.",
        "Doctors say teenage body clocks run late, so 8 am is fighting biology.",
        "Late marks would drop, because the bus would stop being the problem.",
        "Other countries start later and do fine.",
        "Teachers would be less grumpy too.",
      ],
      STICKY_COLOR_VALUES.mint,
      random,
      [340, 440],
    ),
    ...scatter(
      againstZone,
      [
        "Most parents leave for work at 8, so we would be dropped off early anyway.",
        "The buses are timetabled around 8. The company will not change for one school.",
      ],
      STICKY_COLOR_VALUES.coral,
      random,
      [340, 440],
    ),
    // One claim that takes neither side, left between the Sections.
    note(
      60,
      150,
      340,
      "Keep 8 am but make the first period a quiet study hour.",
      STICKY_COLOR_VALUES.lavender,
    ),
    stamp(-90, -110, "heart"),
    stamp(470, -100, "question", DRAWING_COLOR_VALUES.blue),
  ];
  return {
    id: "debate-school-start",
    label: "Debate: a 9 am start",
    description: "Two sides, one Section each, arguing whether school should start an hour later.",
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// Tasks: four projects, scattered
// ---------------------------------------------------------------------------------------------

const TASKS: readonly string[] = [
  "WEB-142\nLogin redirect loop on Safari\nP1 · blocked by API-88",
  "API-88\nSession cookie SameSite fix\nP1 · in review",
  "MOB-31\nCrash on photo upload, Android 14\nP0 · Priya",
  "OPS-12\nRotate signing keys before Oct 1\nP1",
  "WEB-150\nPricing page copy refresh\nP3",
  "API-91\nRate limit per organisation\nP2 · needs OPS-12 first",
  "MOB-40\nOffline queue for uploads\nP2 · blocked by API-91",
  "OPS-15\nStaging DB out of disk\nP0 !!",
  "WEB-149\nSafari sends you back to /signin after login\nP2",
  "API-95\nWebhook retries with backoff\nP2",
  "MOB-33\nDark mode icons\nP3 · owner?",
  "OPS-18\nCI flaky on webkit\nP2",
  "API-80\nCursor pagination\nDone ✓",
  "WEB-151\nFooter links 404\nP2 · no owner",
  "MOB-42\nPush notification opt-in copy\nP3 · waits on WEB-150 wording",
  "OPS-20\nCost alert: R2 egress doubled\nP2",
  "API-97\nExport endpoint timing out\nP1 · due Sep 1",
  "MOB-45\nUpgrade React Native\nP2 · needed for MOB-31?",
  "WEB-155\nCookie banner covers nav on mobile\nP2",
  "OPS-22\nOn-call rota for October\nP3",
  "API-99\nAudit log for org admins\nP2 · asked by sales",
  "MOB-47\nApp store screenshots\nP3",
  "someone should fix the footer",
  "who owns MOB-33?",
  "demo on Thursday!!",
  "WEB-158\nAdd status page link\nP3",
];

function tasksBoard(): DemoTemplate {
  const random = seeded(83);
  const items: ActivityTemplateItem[] = [
    text(-700, -280, "Sprint 14: everything we know", 30),
    text(
      -700,
      -242,
      "Pulled from Linear by four people on four different days. Nothing is grouped. Synthetic.",
      17,
      MUTED,
    ),
  ];
  TASKS.forEach((task, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const x = Math.round(-700 + column * 275 + random() * 70 - 20);
    const y = Math.round(-170 + row * 175 + random() * 50 - 15);
    const width = Math.round(200 + random() * 55);
    const fill =
      STICKY_FILLS[Math.floor(random() * STICKY_FILLS.length)] ?? STICKY_COLOR_VALUES.yellow;
    items.push(note(x, y, width, task, fill, 14));
  });
  items.push(stamp(600, -120, "sparkle"));
  return {
    id: "tasks-four-projects",
    label: "Tasks: four projects, scattered",
    description:
      "Twenty-six tasks from four projects dropped on one board with no grouping, some blocked on each other.",
    items,
  };
}

// ---------------------------------------------------------------------------------------------
// Ad ideas: spring launch. Five people with very different numbers of ideas and very different
// instincts: Dev wants video and volume, Sana wants proof, Leo wants it cheap, Mei wants feeling,
// Tomas is not sure any of it works.
// ---------------------------------------------------------------------------------------------

const AD_IDEAS: readonly string[] = [
  "Dev: TikTok duets with real teachers reacting to homework",
  "Dev: a quiz ad: 'can you still do Year 7 maths?'",
  "Dev: bus wraps on the school routes",
  "Dev: retarget anyone who watched half the demo",
  "Dev: make it a meme, let the kids spread it",
  "Dev: six-second ad. That is all anyone watches.",
  "Sana: billboard right outside the three biggest schools",
  "Sana: WhatsApp status ads, parents live there",
  "Sana: before/after: a real student's working, month 1 vs month 3",
  "Sana: a teacher's testimonial, filmed in her classroom",
  "Leo: referral code, one free month for both families",
  "Leo: pre-roll on maths revision videos",
  "Leo: compare us to private tutoring cost per hour",
  "Mei: sponsor a parenting podcast, read by the host",
  "Mei: three mums with big followings, honest reviews",
  "Mei: an ad with no words, just a kid's face when it clicks",
  "Mei: Instagram carousel: 5 mistakes every Year 7 makes",
  "Mei: ask the kids what they would want to see",
  "Tomas: flyers in tuition centres (cheeky?)",
  "Tomas: print in the local paper, grandparents read it",
  "too expensive",
  "we tried this in 2024, didn't work",
  "which audience?? parents or kids?",
  "love this",
  "BUDGET IS SMALL",
  "can we test two and see?",
];

function marketingBoard(): DemoTemplate {
  const random = seeded(97);
  const items: ActivityTemplateItem[] = [
    text(-700, -280, "Spring launch: ad ideas", 30),
    text(
      -700,
      -242,
      "Five people, one hour, no rules. Every idea and every reaction is synthetic.",
      17,
      MUTED,
    ),
  ];
  AD_IDEAS.forEach((idea, index) => {
    const column = index % 5;
    const row = Math.floor(index / 5);
    const x = Math.round(-700 + column * 285 + random() * 40 - 10);
    const y = Math.round(-180 + row * 170 + random() * 50 - 15);
    const short = idea.length < 30;
    const width = short ? Math.round(170 + random() * 40) : Math.round(210 + random() * 30);
    const fill =
      STICKY_FILLS[Math.floor(random() * STICKY_FILLS.length)] ?? STICKY_COLOR_VALUES.yellow;
    items.push(note(x, y, width, idea, fill, short ? 18 : 15));
  });
  const reactions = [
    "heart",
    "star",
    "heart",
    "question",
    "sparkle",
    "heart",
    "check",
    "question",
  ] as const;
  reactions.forEach((kind, index) => {
    items.push(
      stamp(
        Math.round(-640 + random() * 1300),
        Math.round(-150 + random() * 800),
        kind,
        index % 3 === 0 ? DRAWING_COLOR_VALUES.blue : DRAWING_COLOR_VALUES.red,
      ),
    );
  });
  return {
    id: "marketing-ad-ideas",
    label: "Ad ideas: spring launch",
    description: "Five people's ad ideas and reactions, dropped wherever they landed.",
    items,
  };
}

export const DEMO_BOARDS: readonly DemoTemplate[] = [
  problemSetBoard(),
  trafficBoard(),
  eclipseBoard(),
  debateBoard(),
  tasksBoard(),
  marketingBoard(),
];

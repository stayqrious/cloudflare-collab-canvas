import {
  buildEducationMove,
  buildEducationVisuals,
  buildGroupDecisionScaffold,
  COLLECTIVE_REASONING_MODES,
  type EducationBatch,
  type EducationCard,
  type EducationConnection,
  type EducationMoveFamily,
  type EducationMoveProposal,
  type EducationSource,
  type EducationVisual,
  type EducationVisualAsset,
  type EducationVisualProposal,
  GROUP_DECISION_MODES,
  type GroupDecisionProposal,
  IDEA_SENSEMAKING_MODES,
  LEARNING_ACTION_MODES,
  modeLabel,
  SECTION_INTEGRATION_MODES,
  THINKING_EXPANSION_MODES,
} from "../activities/education-partner";
import type { Bounds } from "../board/model";
import type { DurableOperation } from "../types";
import type { CollectiveInquirySnapshot } from "./collective-inquiry";
import { MAX_SHARED_VISUAL_ITEMS } from "./collective-inquiry";
import {
  MAX_WATCHED_ITEMS,
  PROBLEM_STEP_WATCH_DURATION_MS,
  PROBLEM_STEP_WATCH_MAX_WAIT_MS,
  PROBLEM_STEP_WATCH_MISSED_PINGS,
  PROBLEM_STEP_WATCH_PING_INTERVAL_MS,
  PROBLEM_STEP_WATCH_TOOL,
} from "./problem-step-watch";
import {
  enumValue,
  isRecord,
  optionalText,
  registerWebMcpTool,
  requiredText,
  textArray,
  WEBMCP_MATHJAX_GUIDANCE,
  WEBMCP_TEXT_RENDERING_CAPABILITY,
} from "./shared";

type CardToolConfiguration = {
  name: string;
  family: EducationMoveFamily;
  modes: readonly CardMode[];
  minCards: number;
  maxCards: number;
  description: string;
};

type CardMode =
  | (typeof THINKING_EXPANSION_MODES)[number]
  | (typeof IDEA_SENSEMAKING_MODES)[number]
  | (typeof COLLECTIVE_REASONING_MODES)[number]
  | (typeof LEARNING_ACTION_MODES)[number];

type DecisionMode = (typeof GROUP_DECISION_MODES)[number];
type SectionMode = (typeof SECTION_INTEGRATION_MODES)[number];
type LiveCollaborationMode = CardMode | DecisionMode;
type CollaborationMode = LiveCollaborationMode | SectionMode;

/** A parsed proposal ready to be laid out, queued, and reported. */
type StagedAddition = {
  batch: EducationBatch;
  queueFailure: string;
  notice: string;
  result: Record<string, unknown>;
};

export const EDUCATION_VISUAL_PALETTES = [
  "sunset",
  "ocean",
  "lime",
  "violet",
  "chalkboard",
  "confetti",
] as const;

export type EducationVisualSource =
  | {
      format: "meme_card";
      headline: string;
      punchline: string;
      emoji: string;
      palette: (typeof EDUCATION_VISUAL_PALETTES)[number];
    }
  | {
      format: "inline_image";
      imageDataUrl: string;
    };

type ParsedEducationVisuals = {
  selectionToken: string;
  proposal: EducationVisualProposal;
  imageSources: EducationVisualSource[];
};

const VISUAL_SAFETY_CONFIRMATION = "classroom_safe_no_student_likeness_or_targeting";
const MAX_INLINE_IMAGE_DATA_URL_LENGTH = 7_100_000;

export type CrossGroupJigsawSnapshot = {
  token: string;
  capturedAt: string;
  groups: Array<{
    alias: string;
    sourceAliases: string[];
  }>;
  sources: Array<{
    alias: string;
    itemId: string;
    version: number;
    kind: "sticky";
    text: string;
    groupAlias: string;
  }>;
};

export type CrossGroupJigsawSectionContext = {
  readToolName: string;
  getSnapshot: (token: string) => CrossGroupJigsawSnapshot | undefined;
};

type RequiredRoleGroup = {
  label: string;
  acceptedRoles: readonly string[];
};

type CollaborationModeContract = {
  purpose: string;
  requirements: readonly string[];
  minimumEntries: number;
  maximumEntries: number;
  connectionRequired?: true;
  rolesRequiredOnEveryEntry?: true;
  minimumDistinctRoles?: number;
  allowedRoles?: readonly string[];
  requiredRoleGroups?: readonly RequiredRoleGroup[];
  exactSourcesPerEntry?: number;
  minimumSourcesPerEntry?: number;
  minimumCriteria?: number;
  maximumCriteria?: number;
};

const CARD_TOOL_CONFIGURATIONS: CardToolConfiguration[] = [
  {
    name: "add_thinking_expansion",
    family: "thinking_expansion",
    modes: THINKING_EXPANSION_MODES,
    minCards: 2,
    maxCards: 3,
    description:
      "Add exactly two or three source-linked prompts that expand the selected class's thinking without overwhelming it. Modes: gap_finder, perspective_carousel, idea_mashup, constraint_shaker, analogy_broker. Every addition must end in a testable question for students to examine, improve, or reject.",
  },
  {
    name: "add_idea_sensemaking",
    family: "cross_group_sensemaking",
    modes: IDEA_SENSEMAKING_MODES,
    minCards: 1,
    maxCards: 4,
    description:
      "Connect and reorganize selected ideas on the shared canvas. Modes: bridge_builder, shared_glossary, alternative_clusterer, outlier_champion. Bridge cards must cite at least two selected ideas; Alternative Clusterer always offers exactly two plausible organizations. Never erase outliers or claim one correct classification.",
  },
  {
    name: "add_collective_reasoning",
    family: "collective_reasoning",
    modes: COLLECTIVE_REASONING_MODES,
    minCards: 2,
    maxCards: 6,
    description:
      "Add a source-linked reasoning map for the class. Modes: evidence_assumption_mapper, productive_tension_mapper, counterexample_challenge, uncertainty_annotator, ethics_consequences_map, debate_cartographer. Connections may link claims, evidence, assumptions, counterclaims, rebuttals, stakeholders, or consequences. Frame critiques as testable questions, never authoritative judgments.",
  },
  {
    name: "add_learning_action_plan",
    family: "learning_action",
    modes: LEARNING_ACTION_MODES,
    minCards: 2,
    maxCards: 6,
    description:
      "Turn selected class ideas into shared learning or action structures. Modes: idea_to_experiment, project_decomposer, peer_review_conductor, teach_back_listener, thinking_evolution_mirror, process_replay. Link every prediction, milestone, risk, clarification, changed belief, or reasoning step back to selected class contributions.",
  },
];

const MODE_CONTRACTS = {
  gap_finder: {
    purpose:
      "Surface important questions, evidence gaps, or affected voices the selected ideas omit.",
    requirements: [
      "Add only two or three distinct gaps.",
      "Label every card as missing question, missing perspective, evidence gap, missing voice, or missing stakeholder.",
    ],
    minimumEntries: 2,
    maximumEntries: 3,
    rolesRequiredOnEveryEntry: true,
    minimumDistinctRoles: 2,
    allowedRoles: [
      "missing question",
      "missing perspective",
      "evidence gap",
      "missing voice",
      "missing stakeholder",
    ],
  },
  perspective_carousel: {
    purpose:
      "Offer two or three clearly named stakeholder or disciplinary lenses without pretending to speak for people.",
    requirements: [
      "Add only two or three lenses chosen or requested by the class.",
      "Give every card a distinct role naming its lens; frame it as a perspective to test, not a claim about a group.",
    ],
    minimumEntries: 2,
    maximumEntries: 3,
    rolesRequiredOnEveryEntry: true,
    minimumDistinctRoles: 2,
  },
  idea_mashup: {
    purpose: "Combine exactly two selected contributions into each new possibility.",
    requirements: [
      "Add only two or three hybrid possibilities.",
      "Every card must cite exactly two selected idea aliases.",
    ],
    minimumEntries: 2,
    maximumEntries: 3,
    exactSourcesPerEntry: 2,
  },
  constraint_shaker: {
    purpose:
      "Change one meaningful constraint at a time so the class can test how its ideas respond.",
    requirements: [
      "Add only two or three changed conditions.",
      "Name the changed condition in each card's role and vary only one condition per card.",
    ],
    minimumEntries: 2,
    maximumEntries: 3,
    rolesRequiredOnEveryEntry: true,
    minimumDistinctRoles: 2,
  },
  analogy_broker: {
    purpose:
      "Offer a bounded analogy and make its useful correspondence and breaking point examinable.",
    requirements: [
      "Add only two or three cross-subject analogies.",
      "Name the source subject or system in each card's role and ask where the analogy works or fails.",
    ],
    minimumEntries: 2,
    maximumEntries: 3,
    rolesRequiredOnEveryEntry: true,
    minimumDistinctRoles: 2,
  },
  bridge_builder: {
    purpose: "Create explicit bridges whose cards each cite at least two selected contributions.",
    requirements: [
      "Every bridge card must cite at least two selected ideas.",
      "Explain a relationship the class can inspect rather than merely summarizing both sources.",
    ],
    minimumEntries: 1,
    maximumEntries: 4,
    minimumSourcesPerEntry: 2,
  },
  shared_glossary: {
    purpose:
      "Draft working definitions for ambiguous terms and leave the wording open for class revision.",
    requirements: [
      "Use the role working definition on every term card.",
      "Ask the class what the definition includes, excludes, or changes between sources.",
    ],
    minimumEntries: 1,
    maximumEntries: 4,
    rolesRequiredOnEveryEntry: true,
    allowedRoles: ["working definition"],
  },
  alternative_clusterer: {
    purpose:
      "Offer exactly two plausible organizations of selected ideas and a question that compares what each reveals.",
    requirements: [
      "Create exactly two alternative organizations of the same selected material.",
      "Do not call either organization correct; ask what each reveals or hides.",
    ],
    minimumEntries: 2,
    maximumEntries: 2,
  },
  outlier_champion: {
    purpose:
      "Protect a contribution that does not fit the dominant organization and show what it may reveal.",
    requirements: [
      "Use the role outlier on every preserved contribution.",
      "Ask whether the outlier exposes a missing assumption, stakeholder, or possibility instead of treating it as noise.",
    ],
    minimumEntries: 1,
    maximumEntries: 3,
    rolesRequiredOnEveryEntry: true,
    allowedRoles: ["outlier"],
  },
  cross_group_jigsaw: {
    purpose:
      "Compare contributions from authoritative class sections and identify agreements, tensions, and complementary ideas.",
    requirements: [
      "Include agreement, tension, and complementary idea as explicit roles.",
      "Every card must cite at least two selected sources belonging to at least two different authoritative group aliases.",
      "Visibly connect the comparison and ask the class to test, refine, or resolve it.",
    ],
    minimumEntries: 3,
    maximumEntries: 6,
    connectionRequired: true,
    rolesRequiredOnEveryEntry: true,
    minimumDistinctRoles: 3,
    allowedRoles: ["agreement", "tension", "complementary idea"],
    minimumSourcesPerEntry: 2,
  },
  evidence_assumption_mapper: {
    purpose:
      "Separate observations, claims, evidence, assumptions, and unanswered questions into a map the class can test.",
    requirements: [
      "Create at least three cards using the role vocabulary observation, claim, evidence, assumption, or unanswered question.",
      "Use at least three distinct roles and visibly connect related cards.",
    ],
    minimumEntries: 3,
    maximumEntries: 6,
    connectionRequired: true,
    rolesRequiredOnEveryEntry: true,
    minimumDistinctRoles: 3,
    allowedRoles: ["observation", "claim", "evidence", "assumption", "unanswered question"],
  },
  productive_tension_mapper: {
    purpose:
      "Represent incompatible assumptions and ask what evidence could resolve them without forcing premature agreement.",
    requirements: [
      "Include an assumption, a conflicting assumption, and resolving evidence as explicit roles.",
      "Visibly connect the tension and phrase the resolution as an evidence question.",
    ],
    minimumEntries: 3,
    maximumEntries: 6,
    connectionRequired: true,
    requiredRoleGroups: [
      { label: "assumption", acceptedRoles: ["assumption"] },
      { label: "conflicting assumption", acceptedRoles: ["conflicting assumption"] },
      { label: "resolving evidence", acceptedRoles: ["resolving evidence", "evidence question"] },
    ],
  },
  counterexample_challenge: {
    purpose:
      "Stress-test selected claims with plausible counterexamples phrased as questions, not verdicts.",
    requirements: [
      "Include a claim and a counterexample as explicit roles.",
      "Connect the counterexample to the claim and ask when the claim might fail.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    connectionRequired: true,
    requiredRoleGroups: [
      { label: "claim", acceptedRoles: ["claim"] },
      { label: "counterexample", acceptedRoles: ["counterexample"] },
    ],
  },
  uncertainty_annotator: {
    purpose:
      "Make known, inferred, disputed, and unknown parts visible without inventing confidence scores.",
    requirements: [
      "Label every card known, inferred, disputed, or unknown.",
      "Use at least two distinct uncertainty states and ask what evidence could change them.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    rolesRequiredOnEveryEntry: true,
    minimumDistinctRoles: 2,
    allowedRoles: ["known", "inferred", "disputed", "unknown"],
  },
  ethics_consequences_map: {
    purpose:
      "Map intended benefits, possible side effects, affected stakeholders, and consequences.",
    requirements: [
      "Include an intended benefit, a risk or side effect, and an affected stakeholder as explicit roles.",
      "Visibly connect consequences and ask who benefits, who bears costs, and what may happen next.",
    ],
    minimumEntries: 3,
    maximumEntries: 6,
    connectionRequired: true,
    requiredRoleGroups: [
      { label: "intended benefit", acceptedRoles: ["intended benefit", "benefit"] },
      { label: "risk or side effect", acceptedRoles: ["risk", "side effect"] },
      { label: "affected stakeholder", acceptedRoles: ["affected stakeholder", "stakeholder"] },
    ],
  },
  debate_cartographer: {
    purpose:
      "Connect claims, counterclaims, supporting evidence, and rebuttals without declaring a winner.",
    requirements: [
      "Include claim, counterclaim, supporting evidence, and rebuttal as explicit roles.",
      "Visibly connect the debate and phrase challenges as questions rather than judgments.",
    ],
    minimumEntries: 4,
    maximumEntries: 6,
    connectionRequired: true,
    requiredRoleGroups: [
      { label: "claim", acceptedRoles: ["claim"] },
      { label: "counterclaim", acceptedRoles: ["counterclaim"] },
      { label: "supporting evidence", acceptedRoles: ["supporting evidence", "evidence"] },
      { label: "rebuttal", acceptedRoles: ["rebuttal", "rebuttal question"] },
    ],
  },
  criteria_co_designer: {
    purpose: "Draft possible decision criteria while leaving every class priority or weight blank.",
    requirements: [
      "Use entries for possible criteria and pass an empty criteria array.",
      "Students edit the wording and fill every class weight; no priorities are assigned.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    minimumCriteria: 0,
    maximumCriteria: 0,
  },
  tradeoff_visualizer: {
    purpose:
      "Lay out options against class-selected criteria while leaving ratings and evidence cells blank.",
    requirements: [
      "Use entries for options and provide two to four criteria selected or requested by the class.",
      "Students fill every rating and evidence cell; options are not scored.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    minimumCriteria: 2,
    maximumCriteria: 4,
  },
  assumption_auction: {
    purpose:
      "Turn important assumptions into testable candidates while leaving prioritization votes to students.",
    requirements: [
      "Use entries for testable assumptions and pass an empty criteria array.",
      "Students cast every vote; assumptions are not ranked.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    minimumCriteria: 0,
    maximumCriteria: 0,
  },
  consensus_with_dissent: {
    purpose:
      "Provide explicit response fields for agree, can live with, concern, and abstain; silence never counts.",
    requirements: [
      "Use entries for options and pass an empty criteria array.",
      "All response cells remain blank for explicit student input; never infer consensus.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    minimumCriteria: 0,
    maximumCriteria: 0,
  },
  minority_report: {
    purpose:
      "Preserve explicitly expressed unresolved concerns and ask what evidence or change could address them.",
    requirements: [
      "Use entries only for concerns present in the browser-selected sources and pass an empty criteria array.",
      "Do not invent dissent or identify dissenters; preserve the concern alongside any majority choice.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    minimumCriteria: 0,
    maximumCriteria: 0,
  },
  decision_record: {
    purpose:
      "Record alternatives and reopening evidence while leaving the final class choice blank.",
    requirements: [
      "Use entries for alternatives considered and pass an empty criteria array.",
      "Students fill the final choice; each entry asks what evidence could reopen the decision.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    minimumCriteria: 0,
    maximumCriteria: 0,
  },
  idea_to_experiment: {
    purpose:
      "Turn a selected hypothesis into a prediction, evidence need, and small reversible test.",
    requirements: [
      "Include prediction, evidence need, and proposed test as explicit roles.",
      "Visibly connect the three cards and keep the proposed test small and reversible.",
    ],
    minimumEntries: 3,
    maximumEntries: 6,
    connectionRequired: true,
    requiredRoleGroups: [
      { label: "prediction", acceptedRoles: ["prediction"] },
      { label: "evidence need", acceptedRoles: ["evidence need", "evidence"] },
      { label: "proposed test", acceptedRoles: ["proposed test", "test"] },
    ],
  },
  project_decomposer: {
    purpose:
      "Connect milestones, dependencies, risks, and open questions into an inspectable project path.",
    requirements: [
      "Include milestone, dependency, risk, and open question as explicit roles.",
      "Visibly connect dependencies; the suggestions remain editable by the class.",
    ],
    minimumEntries: 4,
    maximumEntries: 6,
    connectionRequired: true,
    requiredRoleGroups: [
      { label: "milestone", acceptedRoles: ["milestone"] },
      { label: "dependency", acceptedRoles: ["dependency"] },
      { label: "risk", acceptedRoles: ["risk"] },
      { label: "open question", acceptedRoles: ["open question"] },
    ],
  },
  peer_review_conductor: {
    purpose:
      "Set up feedback stations and synthesis prompts without grading, ranking, or assigning ability.",
    requirements: [
      "Include at least one feedback station and one synthesis prompt as explicit roles.",
      "Ask about the work, evidence, or explanation; never grade, rank, or profile a student.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    requiredRoleGroups: [
      { label: "feedback station", acceptedRoles: ["feedback station"] },
      { label: "synthesis prompt", acceptedRoles: ["synthesis prompt", "synthesis"] },
    ],
  },
  teach_back_listener: {
    purpose:
      "Reflect what a group explanation makes clear and identify where a new learner may need clarification.",
    requirements: [
      "Include a clear point and a clarification as explicit roles.",
      "Describe the explanation, not the student's ability, and phrase every gap as a question.",
    ],
    minimumEntries: 2,
    maximumEntries: 6,
    requiredRoleGroups: [
      { label: "clear point", acceptedRoles: ["clear point", "summary"] },
      { label: "clarification", acceptedRoles: ["clarification", "clarification question"] },
    ],
  },
  thinking_evolution_mirror: {
    purpose:
      "Produce we first thought, we now think, and what changed us from explicitly selected artifacts.",
    requirements: [
      "Create exactly three cards using first thought, now think, and what changed as explicit roles.",
      "Ground changes in selected artifacts and never infer private beliefs or unexpressed learning.",
    ],
    minimumEntries: 3,
    maximumEntries: 3,
    requiredRoleGroups: [
      { label: "first thought", acceptedRoles: ["first thought", "we first thought"] },
      { label: "now think", acceptedRoles: ["now think", "we now think"] },
      { label: "what changed", acceptedRoles: ["what changed", "what changed us"] },
    ],
  },
  process_replay: {
    purpose:
      "Connect selected reasoning artifacts into a sequence of reasoning, decisions, and turning points.",
    requirements: [
      "Include reasoning step, decision point, and turning point as explicit roles.",
      "Visibly connect the sequence and explain changes, not merely the final answer.",
    ],
    minimumEntries: 3,
    maximumEntries: 6,
    connectionRequired: true,
    requiredRoleGroups: [
      { label: "reasoning step", acceptedRoles: ["reasoning step"] },
      { label: "decision point", acceptedRoles: ["decision point"] },
      { label: "turning point", acceptedRoles: ["turning point"] },
    ],
  },
} as const satisfies Record<CollaborationMode, CollaborationModeContract>;

export type EducationPartnerWebMcpOptions = {
  canWrite: () => boolean;
  getSnapshot: (token: string) => CollectiveInquirySnapshot | undefined;
  sectionContext?: CrossGroupJigsawSectionContext;
  getItemVersion: (itemId: string) => number | undefined;
  getItemBounds: (itemId: string) => Bounds | undefined;
  getPlacementBounds: () => Bounds | undefined;
  imagesEnabled: () => boolean;
  storeVisualImages: (
    sources: readonly EducationVisualSource[],
    signal: AbortSignal,
  ) => Promise<readonly EducationVisualAsset[]>;
  commit: (operation: DurableOperation) => Promise<boolean>;
  selectItems: (itemIds: readonly string[]) => void;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

export class EducationPartnerWebMcp {
  private readonly registration = new AbortController();

  constructor(private readonly options: EducationPartnerWebMcpOptions) {
    void this.register();
  }

  destroy(): void {
    this.registration.abort();
  }

  private async register(): Promise<void> {
    const modelContext = document.modelContext;
    if (typeof modelContext?.registerTool !== "function") return;
    try {
      await registerWebMcpTool(
        modelContext,
        {
          name: "list_class_collaboration_modes",
          description: `List the live SpaceScale education collaboration modes, their matching write tools, output limits, human-control rules, and supported text rendering. Call this when choosing how to help a class before reading or changing the canvas. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true },
          execute: async (_input, { signal }) => this.listCapabilities(signal),
        },
        { signal: this.registration.signal },
      );
      for (const configuration of CARD_TOOL_CONFIGURATIONS) {
        await registerWebMcpTool(
          modelContext,
          {
            name: configuration.name,
            description: `${configuration.description} First call read_selected_class_ideas and pass its selectionToken. The caller's WebMCP permission is the approval; this tool adds one normal realtime batch directly, with ordinary undo and internal origin metadata. ${WEBMCP_MATHJAX_GUIDANCE}`,
            inputSchema: cardToolSchema(configuration),
            annotations: { readOnlyHint: false },
            execute: async (input, { signal }) => this.addCardMove(input, configuration, signal),
          },
          { signal: this.registration.signal },
        );
      }
      await registerWebMcpTool(
        modelContext,
        {
          name: "add_content_visuals",
          description: `Add one to three playful, content-grounded visuals beside browser-selected class ideas. Use meme_card for a reliable locally rendered classroom meme, or inline_image for an LLM-generated PNG, JPEG, WebP, or GIF supplied as a data URL. Every visual must cite selected idea aliases, include a discussion question, avoid real student likenesses or targeting individuals, and help the class discuss rather than merely decorate. Alt text is optional; the title is used when it is omitted. First call read_selected_class_ideas and pass its selectionToken. External image URLs are never fetched or embedded; SpaceScale sanitizes and privately stores every image in the board bucket. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: contentVisualsToolSchema(),
          annotations: { readOnlyHint: false },
          execute: async (input, { signal }) => this.addContentVisuals(input, signal),
        },
        { signal: this.registration.signal },
      );
      if (this.options.sectionContext) {
        const sectionContext = this.options.sectionContext;
        if (!/^[a-z][a-z0-9_]{0,63}$/u.test(sectionContext.readToolName)) {
          throw new Error("The authoritative section reader must use a valid WebMCP tool name.");
        }
        await registerWebMcpTool(
          modelContext,
          {
            name: "add_cross_group_jigsaw",
            description: `Compare selected contributions from different authoritative class sections. Include agreement, tension, and complementary idea cards; every card must cite sources from at least two section aliases and end with a testable class question. First call ${sectionContext.readToolName} and pass its sectionToken. This tool never infers group membership from coordinates.`,
            inputSchema: jigsawToolSchema(sectionContext.readToolName),
            annotations: { readOnlyHint: false },
            execute: async (input, { signal }) => this.addCrossGroupJigsaw(input, signal),
          },
          { signal: this.registration.signal },
        );
      }
      await registerWebMcpTool(
        modelContext,
        {
          name: "add_group_decision_scaffold",
          description: `Add a source-linked scaffold that students complete for criteria_co_designer, tradeoff_visualizer, assumption_auction, consensus_with_dissent, minority_report, or decision_record. The tool may structure criteria, options, expressed concerns, and questions, but every weight, rating, response count, vote, and final class choice stays blank for students. Never infer consensus from silence or note similarity. First call read_selected_class_ideas and pass its selectionToken. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: decisionToolSchema(),
          annotations: { readOnlyHint: false },
          execute: async (input, { signal }) => this.addDecisionScaffold(input, signal),
        },
        { signal: this.registration.signal },
      );
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The extended education tools could not be registered.", "warning");
    }
  }

  private async listCapabilities(signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const families: Array<{
      tool: string;
      family: string;
      additions: { minimum: number; maximum: number };
      modes: Array<ReturnType<typeof modeCapability>>;
    }> = CARD_TOOL_CONFIGURATIONS.map((configuration) => ({
      tool: configuration.name,
      family: configuration.family,
      additions: { minimum: configuration.minCards, maximum: configuration.maxCards },
      modes: configuration.modes.map(modeCapability),
    }));
    families.push({
      tool: "add_group_decision_scaffold",
      family: "group_decision",
      additions: { minimum: 2, maximum: 6 },
      modes: GROUP_DECISION_MODES.map(modeCapability),
    });
    if (this.options.sectionContext) {
      families.push({
        tool: "add_cross_group_jigsaw",
        family: "cross_group_sensemaking",
        additions: { minimum: 3, maximum: 6 },
        modes: SECTION_INTEGRATION_MODES.map(modeCapability),
      });
    }
    const sectionIntegration = this.options.sectionContext
      ? {
          live: true,
          mode: "cross_group_jigsaw",
          readTool: this.options.sectionContext.readToolName,
          writeTool: "add_cross_group_jigsaw",
          sourceOfGroupMembership: "authoritative_section_snapshot",
        }
      : {
          live: false,
          reservedMode: "cross_group_jigsaw",
          reason:
            "Waiting for the tested section-context integration so group membership comes from authoritative sections rather than inferred geometry.",
        };
    const workflow = this.options.sectionContext
      ? [
          "Choose one mode that fits the participant's request.",
          "For Cross-Group Jigsaw, call the authoritative section reader named in sectionIntegration.readTool and use its sectionToken.",
          "For every other mode, call read_selected_class_ideas and use its selectionToken.",
          "Ground every proposed card in the aliases returned by the matching selection reader.",
          "Call the matching write tool; its WebMCP permission is the caller's approval.",
        ]
      : [
          "Choose one mode that fits the participant's request.",
          "Call read_selected_class_ideas for the current browser selection.",
          "Ground every proposed card in the returned idea aliases.",
          "Call the matching write tool; its WebMCP permission is the caller's approval.",
        ];
    return {
      availableModeCount: families.reduce((total, family) => total + family.modes.length, 0),
      workflow,
      families,
      visualReader: {
        tool: "inspect_selected_board_visual",
        purpose: "handwriting_sketch_and_spatial_analysis",
        maximumItems: MAX_SHARED_VISUAL_ITEMS,
        result: "isolated_live_page_preview",
        unselectedBoardMasked: true,
        stableItemIdentifiersReturned: false,
        participantIdentifiersReturned: true,
        privateImages: "placeholder_only",
      },
      visualTool: {
        tool: "add_content_visuals",
        additions: { minimum: 1, maximum: 3 },
        formats: ["meme_card", "inline_image"],
        sourceReader: "read_selected_class_ideas",
        acceptedInlineImageMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        preferredGeneratedImageMimeType: "image/png",
        svgAccepted: false,
        externalImageUrlsAccepted: false,
        requiresAltText: false,
        requiresDiscussionPrompt: true,
      },
      problemStepWatch: {
        tool: PROBLEM_STEP_WATCH_TOOL,
        scope: "entire_board",
        durationSeconds: PROBLEM_STEP_WATCH_DURATION_MS / 1_000,
        maximumWaitMs: PROBLEM_STEP_WATCH_MAX_WAIT_MS,
        keepAlivePingMs: PROBLEM_STEP_WATCH_PING_INTERVAL_MS,
        missedPingsBeforeStop: PROBLEM_STEP_WATCH_MISSED_PINGS,
        maximumObjects: MAX_WATCHED_ITEMS,
        reports: "authoritative_saved_changes",
        watchesEveryObjectKind: true,
        drawnWorkReportedAs: "description_and_board_png",
        unsavedKeystrokesIncluded: false,
        stableItemIdentifiersReturned: false,
      },
      textRendering: WEBMCP_TEXT_RENDERING_CAPABILITY,
      guardrails: {
        boundedAdditions: true,
        sourceLinked: true,
        questionFirstCritique: true,
        aiAttributed: true,
        oneBatchUndo: true,
        studentDecisionsRemainBlank: true,
        inferredConsensus: false,
        gradingOrProfiling: false,
      },
      sectionIntegration,
    };
  }

  /**
   * Shared write pipeline: guard the write, let `stage` parse and lay out the
   * addition, then queue it as one batch, select it, and report the result.
   */
  private async addStructure(
    signal: AbortSignal,
    stage: () => StagedAddition | Promise<StagedAddition>,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    this.assertCanWrite();
    const staged = await stage();
    signal.throwIfAborted();
    const accepted = await this.options.commit(staged.batch.operation);
    if (!accepted) throw new Error(staged.queueFailure);
    this.options.selectItems(staged.batch.itemIds);
    this.options.notify(staged.notice, "info");
    return staged.result;
  }

  private addCardMove(
    input: unknown,
    configuration: CardToolConfiguration,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.addStructure(signal, () => {
      const parsed = parseCardMove(input, configuration);
      const snapshot = this.snapshot(parsed.token);
      const batch = this.buildMove(
        parsed.proposal,
        this.resolveSources(snapshot, parsed.proposal.cards),
      );
      return {
        batch,
        queueFailure: "The collaboration move could not be queued for saving.",
        notice: `${modeLabel(parsed.proposal.mode)} added for the class to test and extend.`,
        result: {
          status: "participant_requested_and_added",
          changedCanvas: true,
          mode: parsed.proposal.mode,
          createdItemCount: batch.itemIds.length,
          additionCount: parsed.proposal.cards.length,
          sourceLinkCount: batch.sourceLinkCount,
          testableQuestionCount: parsed.proposal.cards.length,
          aiAttributed: true,
          undoable: true,
          message:
            "Added as one acknowledged realtime batch. The cards are prompts for collective inquiry, not judgments or grades.",
        },
      };
    });
  }

  private addContentVisuals(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.addStructure(signal, async () => {
      if (!this.options.imagesEnabled()) {
        throw new Error("Image cards are disabled for this Space.");
      }
      const parsed = parseContentVisuals(input);
      const snapshot = this.snapshot(parsed.selectionToken);
      const sources = this.resolveSources(snapshot, parsed.proposal.visuals);
      const assets = await this.options.storeVisualImages(parsed.imageSources, signal);
      signal.throwIfAborted();
      if (!this.options.imagesEnabled()) {
        throw new Error("Image cards were disabled before the visual could be added.");
      }
      this.snapshot(parsed.selectionToken);
      const batch = buildEducationVisuals(
        parsed.proposal,
        sources,
        assets,
        undefined,
        this.options.getPlacementBounds(),
      );
      const visualCount = parsed.proposal.visuals.length;
      return {
        batch,
        queueFailure: "The class visuals could not be queued for saving.",
        notice: `${visualCount} class visual${visualCount === 1 ? "" : "s"} added for discussion.`,
        result: {
          status: "participant_requested_and_added",
          changedCanvas: true,
          visualCount,
          formats: parsed.proposal.visuals.map((visual) => visual.format),
          createdItemCount: batch.itemIds.length,
          sourceLinkCount: batch.sourceLinkCount,
          discussionPromptCount: visualCount,
          privatelyStored: true,
          externalImageUrlsEmbedded: false,
          aiAttributed: true,
          undoable: true,
          message:
            "Added as one acknowledged realtime board batch. The visuals are source-linked invitations for class discussion, not depictions or judgments of students.",
        },
      };
    });
  }

  private addCrossGroupJigsaw(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.addStructure(signal, () => {
      const parsed = parseCrossGroupJigsaw(input);
      const snapshot = this.sectionSnapshot(parsed.token);
      validateJigsawSnapshot(snapshot);
      validateJigsawSources(snapshot, parsed.proposal.cards);
      const batch = this.buildMove(
        parsed.proposal,
        this.resolveSources(snapshot, parsed.proposal.cards),
      );
      const groupsBySource = new Map(
        snapshot.sources.map((source) => [source.alias, source.groupAlias]),
      );
      const comparedGroupCount = new Set(
        parsed.proposal.cards
          .flatMap((card) => card.sourceAliases)
          .map((alias) => groupsBySource.get(alias))
          .filter((group): group is string => group !== undefined),
      ).size;
      return {
        batch,
        queueFailure: "The Cross-Group Jigsaw could not be queued for saving.",
        notice: "Cross-Group Jigsaw added for the class to compare, challenge, and extend.",
        result: {
          status: "participant_requested_and_added",
          changedCanvas: true,
          mode: parsed.proposal.mode,
          createdItemCount: batch.itemIds.length,
          additionCount: parsed.proposal.cards.length,
          sourceLinkCount: batch.sourceLinkCount,
          comparedGroupCount,
          testableQuestionCount: parsed.proposal.cards.length,
          authoritativeGroupContext: true,
          groupMembershipInferred: false,
          aiAttributed: true,
          undoable: true,
          message:
            "Added from authoritative selected-section context as one acknowledged realtime batch.",
        },
      };
    });
  }

  private addDecisionScaffold(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.addStructure(signal, () => {
      const parsed = parseDecisionScaffold(input);
      const snapshot = this.snapshot(parsed.selectionToken);
      const batch = buildGroupDecisionScaffold(
        parsed.proposal,
        this.resolveSources(snapshot, parsed.proposal.entries),
        undefined,
        this.options.getPlacementBounds(),
      );
      return {
        batch,
        queueFailure: "The group-decision scaffold could not be queued for saving.",
        notice: `${modeLabel(parsed.proposal.mode)} scaffold added. Students still make and record the decision.`,
        result: {
          status: "participant_requested_and_added",
          changedCanvas: true,
          mode: parsed.proposal.mode,
          createdItemCount: batch.itemIds.length,
          sourceLinkCount: batch.sourceLinkCount,
          aiAttributed: true,
          undoable: true,
          studentOwnedFields: ["weights", "ratings", "votes", "responses", "final choice"],
          consensusInferred: false,
          message:
            "The class decision space was structured; all prioritization and explicit responses remain for students.",
        },
      };
    });
  }

  private buildMove(
    proposal: EducationMoveProposal,
    sources: readonly EducationSource[],
  ): EducationBatch {
    return buildEducationMove(proposal, sources, undefined, this.options.getPlacementBounds());
  }

  private assertCanWrite(): void {
    if (!this.options.canWrite()) {
      throw new Error("This browser needs board edit access to add collaboration structures.");
    }
  }

  private snapshot(token: string): CollectiveInquirySnapshot {
    const snapshot = this.options.getSnapshot(token);
    if (!snapshot) {
      throw new Error(
        "That selection token has expired. Read the current browser selection again.",
      );
    }
    for (const source of snapshot.sources) {
      if (this.options.getItemVersion(source.itemId) !== source.version) {
        throw new Error(
          "The selected class contributions changed after sharing. Read the selection again before adding a collaboration move.",
        );
      }
    }
    return snapshot;
  }

  private sectionSnapshot(token: string): CrossGroupJigsawSnapshot {
    const snapshot = this.options.sectionContext?.getSnapshot(token);
    if (!snapshot || snapshot.token !== token) {
      throw new Error("That section token has expired. Read the current selected sections again.");
    }
    for (const source of snapshot.sources) {
      if (this.options.getItemVersion(source.itemId) !== source.version) {
        throw new Error(
          "A contribution in the approved sections changed after sharing. Read the sections again before adding a Jigsaw.",
        );
      }
    }
    return snapshot;
  }

  private resolveSources(
    snapshot:
      | Pick<CollectiveInquirySnapshot, "sources">
      | Pick<CrossGroupJigsawSnapshot, "sources">,
    cards: readonly { sourceAliases: readonly string[] }[],
  ): EducationSource[] {
    const byAlias = new Map(snapshot.sources.map((source) => [source.alias, source]));
    const aliases = [...new Set(cards.flatMap((card) => card.sourceAliases))];
    return aliases.map((alias) => {
      const source = byAlias.get(alias);
      if (!source) throw new Error(`${alias} is not part of the browser selection.`);
      const bounds = this.options.getItemBounds(source.itemId);
      if (!bounds) throw new Error(`${alias} is no longer present on the shared canvas.`);
      return {
        alias,
        bounds,
      };
    });
  }
}

function contentVisualsToolSchema(): Record<string, unknown> {
  const commonProperties = {
    id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
    title: { type: "string", minLength: 1, maxLength: 60 },
    caption: {
      type: "string",
      minLength: 1,
      maxLength: 220,
      description: "Explain how the visual connects to the selected class discussion.",
    },
    altText: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description:
        "Optional. Describe meaningful visual content and visible words; if omitted the title is used.",
    },
    sourceAliases: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: { type: "string", pattern: "^idea_[1-9][0-9]*$" },
    },
    discussionPrompt: {
      type: "string",
      minLength: 5,
      maxLength: 160,
      pattern: "\\?$",
      description: "A question students can discuss, improve, or reject together.",
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["selectionToken", "title", "visuals", "safetyConfirmation"],
    properties: {
      selectionToken: {
        type: "string",
        description: "Opaque token returned by read_selected_class_ideas.",
      },
      title: {
        type: "string",
        minLength: 3,
        maxLength: 100,
        description: "A neutral class-facing title for this small set of visuals.",
      },
      safetyConfirmation: {
        type: "string",
        const: VISUAL_SAFETY_CONFIRMATION,
        description:
          "Confirm the visuals are classroom-safe, depict no real student, and do not ridicule or target an individual.",
      },
      visuals: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        description:
          "A bounded set of source-linked visuals. Prefer meme_card unless a generated inline image materially helps the class reason together.",
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: [
                "id",
                "format",
                "title",
                "caption",
                "sourceAliases",
                "discussionPrompt",
                "headline",
                "punchline",
                "emoji",
                "palette",
              ],
              properties: {
                ...commonProperties,
                format: { type: "string", const: "meme_card" },
                headline: { type: "string", minLength: 1, maxLength: 80 },
                punchline: { type: "string", minLength: 1, maxLength: 120 },
                emoji: { type: "string", minLength: 1, maxLength: 16 },
                palette: { type: "string", enum: EDUCATION_VISUAL_PALETTES },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: [
                "id",
                "format",
                "title",
                "caption",
                "sourceAliases",
                "discussionPrompt",
                "imageDataUrl",
              ],
              properties: {
                ...commonProperties,
                format: { type: "string", const: "inline_image" },
                imageDataUrl: {
                  type: "string",
                  minLength: 32,
                  maxLength: MAX_INLINE_IMAGE_DATA_URL_LENGTH,
                  pattern: "^data:image/(png|jpeg|webp|gif);base64,",
                  description:
                    "Inline image bytes only. HTTPS URLs and SVG are intentionally unsupported.",
                },
              },
            },
          ],
        },
      },
    },
  };
}

function jigsawToolSchema(readToolName: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["sectionToken", "title", "cards", "connections"],
    properties: {
      sectionToken: {
        type: "string",
        description: `Opaque token returned by ${readToolName}.`,
      },
      title: {
        type: "string",
        minLength: 3,
        maxLength: 100,
        description: "A neutral class-facing title for comparing the approved groups.",
      },
      cards: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        description:
          "Include agreement, tension, and complementary idea cards. Each card must cite sources from at least two authoritative group aliases.",
        items: cardSchema(),
      },
      connections: connectionsSchema(
        "Visible semantic relationships among the cross-group comparison cards.",
        1,
      ),
    },
  };
}

function cardToolSchema(configuration: CardToolConfiguration): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["selectionToken", "mode", "title", "cards", "connections"],
    properties: {
      selectionToken: {
        type: "string",
        description: "Opaque token returned by read_selected_class_ideas.",
      },
      mode: {
        type: "string",
        enum: configuration.modes,
        description:
          "Call list_class_collaboration_modes first and follow the selected mode's exact contract.",
      },
      title: {
        type: "string",
        minLength: 3,
        maxLength: 100,
        description: "A neutral class-facing title that does not claim a verdict or consensus.",
      },
      cards: {
        type: "array",
        minItems: configuration.minCards,
        maxItems: configuration.maxCards,
        description:
          "Source-linked prompts. Follow the selected mode's entry count and role vocabulary from list_class_collaboration_modes.",
        items: cardSchema(),
      },
      connections: connectionsSchema(
        "Visible semantic links between proposed cards. Required when the selected mode contract says so.",
      ),
    },
  };
}

function connectionsSchema(description: string, minItems?: number): Record<string, unknown> {
  return {
    type: "array",
    ...(minItems === undefined ? {} : { minItems }),
    maxItems: 8,
    description,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["fromCardId", "toCardId", "label"],
      properties: {
        fromCardId: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
        toCardId: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
        label: { type: "string", minLength: 1, maxLength: 80 },
      },
    },
  };
}

function decisionToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["selectionToken", "mode", "title", "entries", "criteria"],
    properties: {
      selectionToken: {
        type: "string",
        description: "Opaque token returned by read_selected_class_ideas.",
      },
      mode: {
        type: "string",
        enum: GROUP_DECISION_MODES,
        description:
          "Call list_class_collaboration_modes first and follow the selected mode's exact contract.",
      },
      title: {
        type: "string",
        minLength: 3,
        maxLength: 100,
        description: "A neutral title for a scaffold the class will complete.",
      },
      entries: {
        type: "array",
        minItems: 2,
        maxItems: 6,
        description:
          "Drafted options, criteria, assumptions, expressed concerns, or alternatives. Student-owned values stay out of these entries.",
        items: cardSchema(),
      },
      criteria: {
        type: "array",
        maxItems: 4,
        uniqueItems: true,
        description:
          "Use only for tradeoff_visualizer (two to four class-selected criteria); pass [] for every other decision mode.",
        items: { type: "string", minLength: 1, maxLength: 60 },
      },
    },
  };
}

function cardSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "heading", "body", "sourceAliases", "question"],
    properties: {
      id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
      heading: { type: "string", minLength: 1, maxLength: 60 },
      body: { type: "string", minLength: 1, maxLength: 220 },
      sourceAliases: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
        items: { type: "string", pattern: "^idea_[1-9][0-9]*$" },
      },
      question: { type: "string", minLength: 5, maxLength: 160, pattern: "\\?$" },
      role: {
        type: "string",
        maxLength: 32,
        description:
          "A semantic role for this card. Use the selected mode's exact role vocabulary when its contract publishes allowed or required roles.",
      },
    },
  };
}

type CardProposalShape = {
  label: string;
  tokenField: "selectionToken" | "sectionToken";
  family: EducationMoveFamily;
  /** Either a fixed mode or the modes the caller may choose from. */
  mode: CardMode | SectionMode | { oneOf: readonly CardMode[] };
};

function parseCardProposal(
  input: unknown,
  shape: CardProposalShape,
): { token: string; proposal: EducationMoveProposal } {
  if (!isRecord(input)) throw new Error(`${shape.label} must be an object.`);
  const token = requiredText(input[shape.tokenField], shape.tokenField, 100);
  const mode =
    typeof shape.mode === "string" ? shape.mode : enumValue(input.mode, shape.mode.oneOf, "mode");
  const title = requiredText(input.title, "title", 100);
  const contract = modeContract(mode);
  const cards = parseCards(input.cards, contract.minimumEntries, contract.maximumEntries, "cards");
  const connections = parseConnections(input.connections, new Set(cards.map((card) => card.id)));
  validateCardMode(mode, cards, connections);
  return { token, proposal: { family: shape.family, mode, title, cards, connections } };
}

function parseCardMove(
  input: unknown,
  configuration: CardToolConfiguration,
): { token: string; proposal: EducationMoveProposal } {
  return parseCardProposal(input, {
    label: "The collaboration move",
    tokenField: "selectionToken",
    family: configuration.family,
    mode: { oneOf: configuration.modes },
  });
}

function parseCrossGroupJigsaw(input: unknown): { token: string; proposal: EducationMoveProposal } {
  return parseCardProposal(input, {
    label: "The Cross-Group Jigsaw",
    tokenField: "sectionToken",
    family: "cross_group_sensemaking",
    mode: "cross_group_jigsaw",
  });
}

function parseContentVisuals(input: unknown): ParsedEducationVisuals {
  if (!isRecord(input)) throw new Error("The content visuals request must be an object.");
  if (input.safetyConfirmation !== VISUAL_SAFETY_CONFIRMATION) {
    throw new Error(
      "Confirm that the visuals are classroom-safe, depict no real student, and target no individual.",
    );
  }
  const selectionToken = requiredText(input.selectionToken, "selectionToken", 100);
  const title = requiredText(input.title, "title", 100);
  if (!Array.isArray(input.visuals) || input.visuals.length < 1 || input.visuals.length > 3) {
    throw new Error("visuals must contain 1-3 entries.");
  }
  const imageSources: EducationVisualSource[] = [];
  const visuals: EducationVisual[] = input.visuals.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`visuals[${index}] must be an object.`);
    const id = requiredText(entry.id, `visuals[${index}].id`, 32);
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(id)) {
      throw new Error(`visuals[${index}].id must be a short lowercase identifier.`);
    }
    const format = enumValue(entry.format, ["meme_card", "inline_image"] as const, "format");
    const discussionPrompt = requiredText(
      entry.discussionPrompt,
      `visuals[${index}].discussionPrompt`,
      160,
    );
    if (!discussionPrompt.endsWith("?")) {
      throw new Error(`visuals[${index}].discussionPrompt must be framed as a question.`);
    }
    const sourceAliases = textArray(
      entry.sourceAliases,
      `visuals[${index}].sourceAliases`,
      1,
      5,
      30,
    );
    if (new Set(sourceAliases).size !== sourceAliases.length) {
      throw new Error(`visuals[${index}].sourceAliases must be unique.`);
    }
    if (format === "meme_card") {
      imageSources.push({
        format,
        headline: requiredText(entry.headline, `visuals[${index}].headline`, 80),
        punchline: requiredText(entry.punchline, `visuals[${index}].punchline`, 120),
        emoji: requiredText(entry.emoji, `visuals[${index}].emoji`, 16),
        palette: enumValue(entry.palette, EDUCATION_VISUAL_PALETTES, `visuals[${index}].palette`),
      });
    } else {
      const imageDataUrl = requiredText(
        entry.imageDataUrl,
        `visuals[${index}].imageDataUrl`,
        MAX_INLINE_IMAGE_DATA_URL_LENGTH,
      );
      if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u.test(imageDataUrl)) {
        throw new Error(
          `visuals[${index}].imageDataUrl must be an inline PNG, JPEG, WebP, or GIF data URL.`,
        );
      }
      imageSources.push({ format, imageDataUrl });
    }
    return {
      id,
      format,
      title: requiredText(entry.title, `visuals[${index}].title`, 60),
      caption: requiredText(entry.caption, `visuals[${index}].caption`, 220),
      altText: optionalText(entry.altText, `visuals[${index}].altText`, 500),
      sourceAliases,
      discussionPrompt,
    };
  });
  if (new Set(visuals.map((visual) => visual.id)).size !== visuals.length) {
    throw new Error("visuals must use unique ids.");
  }
  return { selectionToken, proposal: { title, visuals }, imageSources };
}

function parseDecisionScaffold(input: unknown): {
  selectionToken: string;
  proposal: GroupDecisionProposal;
} {
  if (!isRecord(input)) throw new Error("The group decision scaffold must be an object.");
  const selectionToken = requiredText(input.selectionToken, "selectionToken", 100);
  const mode = enumValue(input.mode, GROUP_DECISION_MODES, "mode");
  const title = requiredText(input.title, "title", 100);
  const contract = modeContract(mode);
  const entries = parseCards(
    input.entries,
    contract.minimumEntries,
    contract.maximumEntries,
    "entries",
  );
  const criteria = textArray(
    input.criteria,
    "criteria",
    contract.minimumCriteria ?? 0,
    contract.maximumCriteria ?? 0,
    60,
  );
  if (new Set(criteria).size !== criteria.length) {
    throw new Error("criteria must be unique.");
  }
  return { selectionToken, proposal: { mode, title, entries, criteria } };
}

function validateCardMode(
  mode: CardMode | SectionMode,
  cards: readonly EducationCard[],
  connections: readonly EducationConnection[],
): void {
  const contract = modeContract(mode);
  const label = modeLabel(mode);
  if (
    contract.exactSourcesPerEntry !== undefined &&
    cards.some((card) => card.sourceAliases.length !== contract.exactSourcesPerEntry)
  ) {
    throw new Error(
      `Every ${label} card must cite exactly ${contract.exactSourcesPerEntry} selected sources.`,
    );
  }
  const minimumSourcesPerEntry = contract.minimumSourcesPerEntry;
  if (
    minimumSourcesPerEntry !== undefined &&
    cards.some((card) => card.sourceAliases.length < minimumSourcesPerEntry)
  ) {
    throw new Error(
      `Every ${label} card must connect at least ${minimumSourcesPerEntry} selected sources.`,
    );
  }

  const roles = cards.map((card) => (card.role ? normalizeRole(card.role) : undefined));
  if (contract.rolesRequiredOnEveryEntry && roles.some((role) => role === undefined)) {
    throw new Error(`${label} requires a role on every card.`);
  }
  const allowedRoles = contract.allowedRoles;
  if (allowedRoles && roles.some((role) => role === undefined || !allowedRoles.includes(role))) {
    throw new Error(`${label} roles must be one of: ${allowedRoles.join(", ")}.`);
  }
  if (
    contract.minimumDistinctRoles !== undefined &&
    new Set(roles.filter((role): role is string => role !== undefined)).size <
      contract.minimumDistinctRoles
  ) {
    throw new Error(
      `${label} requires at least ${contract.minimumDistinctRoles} distinct card roles.`,
    );
  }
  if (contract.requiredRoleGroups) {
    const presentRoles = new Set(roles.filter((role): role is string => role !== undefined));
    const missing = contract.requiredRoleGroups.filter(
      (group) => !group.acceptedRoles.some((role) => presentRoles.has(normalizeRole(role))),
    );
    if (missing.length > 0) {
      throw new Error(
        `${label} is missing required roles: ${missing.map((group) => group.label).join(", ")}.`,
      );
    }
  }
  if (contract.connectionRequired && connections.length === 0) {
    throw new Error(`${label} needs at least one visible connection between cards.`);
  }
}

function validateJigsawSnapshot(snapshot: CrossGroupJigsawSnapshot): void {
  if (snapshot.groups.length < 2) {
    throw new Error("Cross-Group Jigsaw needs at least two authoritative class sections.");
  }
  const groupAliases = snapshot.groups.map((group) => group.alias);
  if (
    new Set(groupAliases).size !== groupAliases.length ||
    groupAliases.some((alias) => !/^group_[1-9][0-9]*$/u.test(alias))
  ) {
    throw new Error("The section snapshot must use unique ephemeral group aliases.");
  }
  const sourceAliases = snapshot.sources.map((source) => source.alias);
  if (
    new Set(sourceAliases).size !== sourceAliases.length ||
    sourceAliases.some((alias) => !/^idea_[1-9][0-9]*$/u.test(alias))
  ) {
    throw new Error("The section snapshot must use unique ephemeral idea aliases.");
  }
  const sourcesByAlias = new Map(snapshot.sources.map((source) => [source.alias, source]));
  const declaredGroups = new Set(groupAliases);
  for (const group of snapshot.groups) {
    if (
      group.sourceAliases.length === 0 ||
      new Set(group.sourceAliases).size !== group.sourceAliases.length
    ) {
      throw new Error(`${group.alias} must contain one or more unique idea aliases.`);
    }
    for (const alias of group.sourceAliases) {
      const source = sourcesByAlias.get(alias);
      if (!source || source.groupAlias !== group.alias) {
        throw new Error(`${alias} does not belong to the declared ${group.alias} section.`);
      }
    }
  }
  for (const source of snapshot.sources) {
    if (
      !declaredGroups.has(source.groupAlias) ||
      !snapshot.groups
        .find((group) => group.alias === source.groupAlias)
        ?.sourceAliases.includes(source.alias)
    ) {
      throw new Error(`${source.alias} has no authoritative section membership.`);
    }
  }
}

function validateJigsawSources(
  snapshot: CrossGroupJigsawSnapshot,
  cards: readonly EducationCard[],
): void {
  const sourceGroups = new Map(snapshot.sources.map((source) => [source.alias, source.groupAlias]));
  for (const card of cards) {
    const groups = new Set(
      card.sourceAliases.map((alias) => {
        const group = sourceGroups.get(alias);
        if (!group) throw new Error(`${alias} is not in the approved section snapshot.`);
        return group;
      }),
    );
    if (groups.size < 2) {
      throw new Error(
        `Every Cross-Group Jigsaw card must cite sources from at least two authoritative groups; ${card.id} does not.`,
      );
    }
  }
}

function parseCards(value: unknown, min: number, max: number, field: string): EducationCard[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${field} must contain ${min}-${max} entries.`);
  }
  const cards = value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${field}[${index}] must be an object.`);
    const id = requiredText(entry.id, `${field}[${index}].id`, 32);
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(id)) {
      throw new Error(`${field}[${index}].id must be a short lowercase identifier.`);
    }
    const question = requiredText(entry.question, `${field}[${index}].question`, 160);
    if (!question.endsWith("?")) {
      throw new Error(`${field}[${index}].question must be framed as a question.`);
    }
    const sourceAliases = textArray(
      entry.sourceAliases,
      `${field}[${index}].sourceAliases`,
      1,
      5,
      30,
    );
    if (new Set(sourceAliases).size !== sourceAliases.length) {
      throw new Error(`${field}[${index}].sourceAliases must be unique.`);
    }
    const role = optionalText(entry.role, `${field}[${index}].role`, 32);
    return {
      id,
      heading: requiredText(entry.heading, `${field}[${index}].heading`, 60),
      body: requiredText(entry.body, `${field}[${index}].body`, 220),
      sourceAliases,
      question,
      ...(role ? { role } : {}),
    };
  });
  if (new Set(cards.map((card) => card.id)).size !== cards.length) {
    throw new Error(`${field} must use unique ids.`);
  }
  return cards;
}

function parseConnections(value: unknown, cardIds: ReadonlySet<string>): EducationConnection[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("connections must be an array with at most eight entries.");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`connections[${index}] must be an object.`);
    const fromCardId = requiredText(entry.fromCardId, `connections[${index}].fromCardId`, 32);
    const toCardId = requiredText(entry.toCardId, `connections[${index}].toCardId`, 32);
    if (!cardIds.has(fromCardId) || !cardIds.has(toCardId) || fromCardId === toCardId) {
      throw new Error(`connections[${index}] must link two different proposed cards.`);
    }
    return {
      fromCardId,
      toCardId,
      label: requiredText(entry.label, `connections[${index}].label`, 80),
    };
  });
}

function normalizeRole(role: string): string {
  return role.trim().toLocaleLowerCase().replace(/[_-]+/gu, " ").replace(/\s+/gu, " ");
}

function modeContract(mode: CollaborationMode): CollaborationModeContract {
  return MODE_CONTRACTS[mode];
}

function modeCapability(mode: CollaborationMode): {
  id: CollaborationMode;
  label: string;
  purpose: string;
  requirements: readonly string[];
  inputContract: Record<string, unknown>;
} {
  const contract = modeContract(mode);
  const sourceAliasesPerEntry =
    contract.exactSourcesPerEntry !== undefined
      ? { exact: contract.exactSourcesPerEntry }
      : { minimum: contract.minimumSourcesPerEntry ?? 1, maximum: 5 };
  return {
    id: mode,
    label: modeLabel(mode),
    purpose: contract.purpose,
    requirements: contract.requirements,
    inputContract: {
      entryCount: {
        minimum: contract.minimumEntries,
        maximum: contract.maximumEntries,
      },
      sourceAliasesPerEntry,
      connectionRequired: contract.connectionRequired ?? false,
      roles: {
        requiredOnEveryEntry: contract.rolesRequiredOnEveryEntry ?? false,
        minimumDistinct: contract.minimumDistinctRoles ?? 0,
        allowed: contract.allowedRoles ?? [],
        requiredGroups:
          contract.requiredRoleGroups?.map((group) => ({
            label: group.label,
            acceptedRoles: group.acceptedRoles,
          })) ?? [],
      },
      ...(contract.minimumCriteria !== undefined
        ? {
            criteriaCount: {
              minimum: contract.minimumCriteria,
              maximum: contract.maximumCriteria ?? contract.minimumCriteria,
            },
          }
        : {}),
    },
  };
}

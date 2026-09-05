import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COLLECTIVE_REASONING_MODES,
  GROUP_DECISION_MODES,
  IDEA_SENSEMAKING_MODES,
  LEARNING_ACTION_MODES,
  THINKING_EXPANSION_MODES,
} from "../activities/education-partner";
import type { DurableOperation } from "../types";
import { EducationPartnerWebMcp } from "./education-partner";
import { webMcpToolDefinitions } from "./shared";
import type { WebMcpRegisterToolOptions, WebMcpToolDefinition } from "./types";

const storedVisualAssets = async (sources: readonly unknown[]) =>
  sources.map(() => ({
    assetId: `asset_${"A".repeat(43)}`,
    mimeType: "image/png" as const,
    intrinsicWidth: 1_200,
    intrinsicHeight: 675,
  }));

/**
 * Every tool this module defines. None of them is in ENABLED_WEBMCP_TOOLS, so a host never sees
 * one; the definitions stay reachable through the catalogue so the code behind them keeps its
 * coverage while it is withheld.
 */
const EDUCATION_TOOLS = [
  "list_class_collaboration_modes",
  "add_thinking_expansion",
  "add_idea_sensemaking",
  "add_collective_reasoning",
  "add_learning_action_plan",
  "add_content_visuals",
  "add_group_decision_scaffold",
] as const;

const JIGSAW_TOOL = "add_cross_group_jigsaw";

/** Stubs a linked host that would accept tools, and hands back the definition catalogue. */
function educationHarness(): ReadonlyMap<string, WebMcpToolDefinition> {
  vi.stubGlobal("document", {
    modelContext: {
      registerTool: (_tool: WebMcpToolDefinition, _options?: WebMcpRegisterToolOptions) =>
        undefined,
    },
  });
  return webMcpToolDefinitions();
}

function allDefined(
  tools: ReadonlyMap<string, WebMcpToolDefinition>,
  names: readonly string[],
): boolean {
  return names.every((name) => tools.has(name));
}

describe("education partner WebMCP contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("describes and adds a source-linked non-section sensemaking move", async () => {
    const tools = educationHarness();
    const committed: DurableOperation[] = [];
    let selected: readonly string[] = [];
    const storeVisualImages = vi.fn(storedVisualAssets);
    const partner = new EducationPartnerWebMcp({
      canWrite: () => true,
      getSnapshot: (token) =>
        token === "selected-ideas"
          ? {
              token,
              capturedAt: "2026-09-01T00:00:00.000Z",
              sources: [
                {
                  alias: "idea_1",
                  itemId: "source-one",
                  version: 3,
                  kind: "sticky",
                  text: "Reduce packaging",
                },
                {
                  alias: "idea_2",
                  itemId: "source-two",
                  version: 5,
                  kind: "sticky",
                  text: "Shorten the queue",
                },
              ],
            }
          : undefined,
      getItemVersion: (itemId) => (itemId === "source-one" ? 3 : 5),
      getItemBounds: (itemId) =>
        itemId === "source-one"
          ? { minX: 0, minY: 0, maxX: 180, maxY: 140 }
          : { minX: 240, minY: 0, maxX: 420, maxY: 140 },
      getPlacementBounds: () => ({ minX: 0, minY: 0, maxX: 420, maxY: 140 }),
      imagesEnabled: () => true,
      storeVisualImages,
      commit: async (operation) => {
        committed.push(operation);
        return true;
      },
      selectItems: (itemIds) => {
        selected = itemIds;
      },
      notify: vi.fn(),
    });

    await vi.waitFor(() => expect(allDefined(tools, EDUCATION_TOOLS)).toBe(true));
    const capabilityTool = tools.get("list_class_collaboration_modes");
    if (!capabilityTool) throw new Error("Capability tool did not register.");
    const capabilities = (await capabilityTool.execute(
      {},
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(capabilities).toMatchObject({
      availableModeCount: 27,
      visualTool: {
        tool: "add_content_visuals",
        additions: { minimum: 1, maximum: 3 },
        formats: ["meme_card", "inline_image"],
        acceptedInlineImageMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        preferredGeneratedImageMimeType: "image/png",
        svgAccepted: false,
        externalImageUrlsAccepted: false,
      },
      guardrails: {
        sourceLinked: true,
        studentDecisionsRemainBlank: true,
        inferredConsensus: false,
      },
    });

    const tool = tools.get("add_idea_sensemaking");
    if (!tool) throw new Error("Idea-sensemaking tool did not register.");
    expect(JSON.stringify(tool.inputSchema)).not.toContain("cross_group_jigsaw");
    const result = (await tool.execute(
      {
        selectionToken: "selected-ideas",
        mode: "bridge_builder",
        title: "How the two ideas can help each other",
        cards: [
          {
            id: "agreement",
            heading: "Shared concern",
            body: "Both ideas want a lunch system that is practical as well as lower waste.",
            sourceAliases: ["idea_1", "idea_2"],
            question: "Where do the two ideas already reinforce one another?",
          },
          {
            id: "tension",
            heading: "Complementary tension",
            body: "One idea emphasizes packaging while the other emphasizes time and flow.",
            sourceAliases: ["idea_1", "idea_2"],
            question: "How could each concern improve the other proposal?",
          },
        ],
        connections: [{ fromCardId: "agreement", toCardId: "tension", label: "complicates" }],
      },
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "participant_requested_and_added",
      mode: "bridge_builder",
      additionCount: 2,
      sourceLinkCount: 4,
      undoable: true,
    });
    expect(committed).toHaveLength(1);
    expect(committed[0]?.kind).toBe("items.batch");
    expect(selected.length).toBe(result.createdItemCount);

    const visualTool = tools.get("add_content_visuals");
    if (!visualTool) throw new Error("Content-visual tool did not register.");
    expect(JSON.stringify(visualTool.inputSchema)).not.toContain("imageUrl");
    const visualResult = (await visualTool.execute(
      {
        selectionToken: "selected-ideas",
        title: "Lunchroom plot twist",
        safetyConfirmation: "classroom_safe_no_student_likeness_or_targeting",
        visuals: [
          {
            id: "queue_meme",
            format: "meme_card",
            title: "When both ideas click",
            caption:
              "The joke connects packaging waste with queue flow instead of treating them as separate problems.",
            altText:
              "A bright meme card with a recycling emoji and the words: Less packaging enters. Faster lunch line appears.",
            sourceAliases: ["idea_1", "idea_2"],
            discussionPrompt:
              "What part of this connection is useful, and what does the meme oversimplify?",
            headline: "Less packaging enters",
            punchline: "Faster lunch line appears",
            emoji: "♻️",
            palette: "confetti",
          },
        ],
      },
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;

    expect(visualResult).toMatchObject({
      status: "participant_requested_and_added",
      visualCount: 1,
      formats: ["meme_card"],
      sourceLinkCount: 2,
      privatelyStored: true,
      externalImageUrlsEmbedded: false,
      aiAttributed: true,
      undoable: true,
    });
    expect(committed).toHaveLength(2);
    const visualBatch = committed[1];
    if (visualBatch?.kind !== "items.batch") throw new Error("Expected a visual batch.");
    const visualItems = visualBatch.operations.flatMap((operation) =>
      operation.kind === "item.create" ? [operation.item] : [],
    );
    expect(visualItems.every((item) => item.assistedBy === "ai")).toBe(true);
    const image = visualItems.find((item) => item.kind === "image");
    expect(image?.kind === "image" ? image.geometry.alt : "").toContain("recycling emoji");
    const caption = visualItems.find((item) => item.kind === "sticky");
    expect(caption?.kind === "sticky" ? caption.geometry.text : "").toContain("DISCUSS TOGETHER");
    expect(selected.length).toBe(visualResult.createdItemCount);
    expect(storeVisualImages).toHaveBeenCalledTimes(1);

    const untitledAltResult = (await visualTool.execute(
      {
        selectionToken: "selected-ideas",
        title: "Alt text left to the title",
        safetyConfirmation: "classroom_safe_no_student_likeness_or_targeting",
        visuals: [
          {
            id: "queue_meme_no_alt",
            format: "meme_card",
            title: "When both ideas click",
            caption: "The joke connects packaging waste with queue flow.",
            sourceAliases: ["idea_1"],
            discussionPrompt: "What does the meme oversimplify?",
            headline: "Less packaging enters",
            punchline: "Faster lunch line appears",
            emoji: "♻️",
            palette: "confetti",
          },
        ],
      },
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(untitledAltResult).toMatchObject({
      status: "participant_requested_and_added",
      visualCount: 1,
    });
    expect(committed).toHaveLength(3);
    const noAltBatch = committed[2];
    if (noAltBatch?.kind !== "items.batch") throw new Error("Expected a visual batch.");
    const noAltImage = noAltBatch.operations
      .flatMap((operation) => (operation.kind === "item.create" ? [operation.item] : []))
      .find((item) => item.kind === "image");
    expect(noAltImage?.kind === "image" ? noAltImage.geometry.alt : "").toBe(
      "When both ideas click",
    );
    expect(storeVisualImages).toHaveBeenCalledTimes(2);

    await expect(
      visualTool.execute(
        {
          selectionToken: "selected-ideas",
          title: "Unsafe remote embed",
          safetyConfirmation: "classroom_safe_no_student_likeness_or_targeting",
          visuals: [
            {
              id: "remote_image",
              format: "inline_image",
              title: "Remote image",
              caption: "This should never reach storage.",
              altText: "Remote image",
              sourceAliases: ["idea_1"],
              discussionPrompt: "Why should this be rejected?",
              imageDataUrl: "https://images.example/student.png",
            },
          ],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("inline PNG, JPEG, WebP, or GIF data URL");
    expect(storeVisualImages).toHaveBeenCalledTimes(2);
    expect(committed).toHaveLength(3);

    partner.destroy();
    expect(EDUCATION_TOOLS.some((name) => tools.has(name))).toBe(false);
  });

  it("publishes and accepts a complete structural contract for every live mode", async () => {
    const tools = educationHarness();
    const committed: DurableOperation[] = [];
    const partner = new EducationPartnerWebMcp({
      canWrite: () => true,
      getSnapshot: (token) =>
        token === "selected-ideas"
          ? {
              token,
              capturedAt: "2026-09-01T00:00:00.000Z",
              sources: [
                {
                  alias: "idea_1",
                  itemId: "source-one",
                  version: 3,
                  kind: "sticky",
                  text: "Reduce packaging",
                },
                {
                  alias: "idea_2",
                  itemId: "source-two",
                  version: 5,
                  kind: "sticky",
                  text: "Shorten the queue",
                },
              ],
            }
          : undefined,
      getItemVersion: (itemId) => (itemId === "source-one" ? 3 : 5),
      getItemBounds: (itemId) =>
        itemId === "source-one"
          ? { minX: 0, minY: 0, maxX: 180, maxY: 140 }
          : { minX: 240, minY: 0, maxX: 420, maxY: 140 },
      getPlacementBounds: () => ({ minX: 0, minY: 0, maxX: 420, maxY: 140 }),
      imagesEnabled: () => true,
      storeVisualImages: storedVisualAssets,
      commit: async (operation) => {
        committed.push(operation);
        return true;
      },
      selectItems: vi.fn(),
      notify: vi.fn(),
    });

    await vi.waitFor(() => expect(allDefined(tools, EDUCATION_TOOLS)).toBe(true));
    const capabilityTool = tools.get("list_class_collaboration_modes");
    if (!capabilityTool) throw new Error("Capability tool did not register.");
    const capabilities = (await capabilityTool.execute(
      {},
      { signal: new AbortController().signal },
    )) as {
      availableModeCount: number;
      families: Array<{
        tool: string;
        modes: Array<{
          id: string;
          requirements: string[];
          inputContract: {
            entryCount: { minimum: number; maximum: number };
            sourceAliasesPerEntry: { minimum?: number; maximum?: number; exact?: number };
            connectionRequired: boolean;
            roles: {
              requiredOnEveryEntry: boolean;
              minimumDistinct: number;
              allowed: string[];
              requiredGroups: Array<{ label: string; acceptedRoles: string[] }>;
            };
            criteriaCount?: { minimum: number; maximum: number };
          };
        }>;
      }>;
      sectionIntegration: { live: boolean; reservedMode: string };
      visualTool: { requiresAltText: boolean; requiresDiscussionPrompt: boolean };
    };
    expect(capabilities.visualTool).toMatchObject({
      requiresAltText: false,
      requiresDiscussionPrompt: true,
    });
    const publishedModes = capabilities.families.flatMap((family) => family.modes);
    expect(capabilities.availableModeCount).toBe(27);
    expect(publishedModes).toHaveLength(27);
    expect(new Set(publishedModes.map((mode) => mode.id)).size).toBe(27);
    expect(
      publishedModes.every(
        (mode) =>
          mode.requirements.length >= 2 &&
          mode.inputContract.entryCount.minimum >= 1 &&
          mode.inputContract.sourceAliasesPerEntry !== undefined,
      ),
    ).toBe(true);
    expect(
      publishedModes.find((mode) => mode.id === "gap_finder")?.inputContract.entryCount,
    ).toEqual({ minimum: 2, maximum: 3 });
    expect(
      publishedModes.find((mode) => mode.id === "outlier_champion")?.inputContract.entryCount,
    ).toEqual({ minimum: 1, maximum: 3 });
    expect(capabilities.sectionIntegration).toEqual({
      live: false,
      reservedMode: "cross_group_jigsaw",
      reason:
        "Waiting for the tested section-context integration so group membership comes from authoritative sections rather than inferred geometry.",
    });

    const roleFixtures: Record<string, string[]> = {
      gap_finder: ["missing question", "evidence gap"],
      perspective_carousel: ["feasibility", "accessibility"],
      constraint_shaker: ["half budget", "less time"],
      analogy_broker: ["ecosystem", "feedback loop"],
      shared_glossary: ["working definition", "working definition"],
      outlier_champion: ["outlier", "outlier"],
      evidence_assumption_mapper: ["observation", "claim", "assumption"],
      productive_tension_mapper: ["assumption", "conflicting assumption", "resolving evidence"],
      counterexample_challenge: ["claim", "counterexample"],
      uncertainty_annotator: ["known", "unknown"],
      ethics_consequences_map: ["intended benefit", "risk", "affected stakeholder"],
      debate_cartographer: ["claim", "counterclaim", "supporting evidence", "rebuttal"],
      idea_to_experiment: ["prediction", "evidence need", "proposed test"],
      project_decomposer: ["milestone", "dependency", "risk", "open question"],
      peer_review_conductor: ["feedback station", "synthesis prompt"],
      teach_back_listener: ["clear point", "clarification"],
      thinking_evolution_mirror: ["first thought", "now think", "what changed"],
      process_replay: ["reasoning step", "decision point", "turning point"],
    };
    const connectedModes = new Set([
      "evidence_assumption_mapper",
      "productive_tension_mapper",
      "counterexample_challenge",
      "ethics_consequences_map",
      "debate_cartographer",
      "idea_to_experiment",
      "project_decomposer",
      "process_replay",
    ]);
    const doubleSourceModes = new Set(["idea_mashup", "bridge_builder"]);
    const toolByMode = new Map(
      capabilities.families.flatMap((family) =>
        family.modes.map((mode) => [mode.id, family.tool] as const),
      ),
    );
    const cardModes = [
      ...THINKING_EXPANSION_MODES,
      ...IDEA_SENSEMAKING_MODES,
      ...COLLECTIVE_REASONING_MODES,
      ...LEARNING_ACTION_MODES,
    ];
    for (const mode of cardModes) {
      const roles = roleFixtures[mode];
      const cardCount = roles?.length ?? 2;
      const cards = Array.from({ length: cardCount }, (_, index) => ({
        id: `card_${index + 1}`,
        heading: `Contribution ${index + 1}`,
        body: "A bounded interpretation grounded in the selected class discussion.",
        sourceAliases: doubleSourceModes.has(mode) ? ["idea_1", "idea_2"] : ["idea_1"],
        question: "What evidence or class response would help us test this?",
        ...(roles?.[index] ? { role: roles[index] } : {}),
      }));
      const toolName = toolByMode.get(mode);
      const tool = toolName ? tools.get(toolName) : undefined;
      if (!tool) throw new Error(`No registered tool for ${mode}.`);
      const result = (await tool.execute(
        {
          selectionToken: "selected-ideas",
          mode,
          title: `Contract test for ${mode}`,
          cards,
          connections: connectedModes.has(mode)
            ? [{ fromCardId: "card_1", toCardId: "card_2", label: "tests" }]
            : [],
        },
        { signal: new AbortController().signal },
      )) as Record<string, unknown>;
      expect(result).toMatchObject({
        status: "participant_requested_and_added",
        mode,
        additionCount: cardCount,
        aiAttributed: true,
        undoable: true,
      });
    }

    const decisionTool = tools.get("add_group_decision_scaffold");
    if (!decisionTool) throw new Error("Decision tool did not register.");
    for (const mode of GROUP_DECISION_MODES) {
      const result = (await decisionTool.execute(
        {
          selectionToken: "selected-ideas",
          mode,
          title: `Contract test for ${mode}`,
          entries: [
            {
              id: "entry_one",
              heading: "First class contribution",
              body: "A source-linked possibility or concern.",
              sourceAliases: ["idea_1"],
              question: "What evidence could change how the class treats this entry?",
            },
            {
              id: "entry_two",
              heading: "Second class contribution",
              body: "Another source-linked possibility or concern.",
              sourceAliases: ["idea_2"],
              question: "What evidence could reopen this part of the decision?",
            },
          ],
          criteria: mode === "tradeoff_visualizer" ? ["Access", "Impact"] : [],
        },
        { signal: new AbortController().signal },
      )) as Record<string, unknown>;
      expect(result).toMatchObject({
        status: "participant_requested_and_added",
        mode,
        aiAttributed: true,
        consensusInferred: false,
      });
    }

    const reasoningTool = tools.get("add_collective_reasoning");
    if (!reasoningTool) throw new Error("Reasoning tool did not register.");
    await expect(
      reasoningTool.execute(
        {
          selectionToken: "selected-ideas",
          mode: "uncertainty_annotator",
          title: "Invalid uncertainty map",
          cards: [
            {
              id: "one",
              heading: "One",
              body: "First statement.",
              sourceAliases: ["idea_1"],
              question: "What evidence would change this?",
              role: "known",
            },
            {
              id: "two",
              heading: "Two",
              body: "Second statement.",
              sourceAliases: ["idea_2"],
              question: "What evidence would change this?",
              role: "known",
            },
          ],
          connections: [],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("at least 2 distinct card roles");
    expect(committed).toHaveLength(27);
    expect(committed.every((operation) => operation.kind === "items.batch")).toBe(true);

    partner.destroy();
    expect(EDUCATION_TOOLS.some((name) => tools.has(name))).toBe(false);
  });

  it("rejects duplicate trade-off criteria even when they differ only by whitespace", async () => {
    const tools = educationHarness();
    const committed: DurableOperation[] = [];
    const partner = new EducationPartnerWebMcp({
      canWrite: () => true,
      getSnapshot: (token) =>
        token === "selected-ideas"
          ? {
              token,
              capturedAt: "2026-09-01T00:00:00.000Z",
              sources: [
                { alias: "idea_1", itemId: "source-one", version: 3, kind: "sticky", text: "A" },
                { alias: "idea_2", itemId: "source-two", version: 5, kind: "sticky", text: "B" },
              ],
            }
          : undefined,
      getItemVersion: (itemId) => (itemId === "source-one" ? 3 : 5),
      getItemBounds: () => ({ minX: 0, minY: 0, maxX: 180, maxY: 140 }),
      getPlacementBounds: () => undefined,
      imagesEnabled: () => true,
      storeVisualImages: storedVisualAssets,
      commit: async (operation) => {
        committed.push(operation);
        return true;
      },
      selectItems: vi.fn(),
      notify: vi.fn(),
    });

    await vi.waitFor(() => expect(allDefined(tools, EDUCATION_TOOLS)).toBe(true));
    const decisionTool = tools.get("add_group_decision_scaffold");
    if (!decisionTool) throw new Error("Decision tool did not register.");
    const scaffold = (criteria: string[]) => ({
      selectionToken: "selected-ideas",
      mode: "tradeoff_visualizer",
      title: "Which option should the class test?",
      entries: [
        {
          id: "entry_one",
          heading: "Reusable containers",
          body: "A return station at one lunch line.",
          sourceAliases: ["idea_1"],
          question: "What evidence could reopen this option?",
        },
        {
          id: "entry_two",
          heading: "Smaller portions",
          body: "Portion choice at the counter.",
          sourceAliases: ["idea_2"],
          question: "What evidence could reopen this option?",
        },
      ],
      criteria,
    });

    await expect(
      decisionTool.execute(scaffold(["Access", " Access "]), {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("criteria must be unique.");
    expect(committed).toHaveLength(0);

    await expect(
      decisionTool.execute(scaffold(["Access", "Impact"]), {
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "participant_requested_and_added" });
    expect(committed).toHaveLength(1);

    partner.destroy();
  });

  it("enables Cross-Group Jigsaw only with authoritative section context", async () => {
    const tools = educationHarness();
    const versions = new Map([
      ["source-one", 1],
      ["source-two", 2],
      ["source-three", 3],
      ["source-four", 4],
    ]);
    const snapshot = {
      token: "approved-sections",
      capturedAt: "2026-09-01T00:00:00.000Z",
      groups: [
        { alias: "group_1", sourceAliases: ["idea_1", "idea_2"] },
        { alias: "group_2", sourceAliases: ["idea_3", "idea_4"] },
      ],
      sources: [
        {
          alias: "idea_1",
          itemId: "source-one",
          version: 1,
          kind: "sticky" as const,
          text: "Reduce packaging",
          groupAlias: "group_1",
        },
        {
          alias: "idea_2",
          itemId: "source-two",
          version: 2,
          kind: "sticky" as const,
          text: "Reuse containers",
          groupAlias: "group_1",
        },
        {
          alias: "idea_3",
          itemId: "source-three",
          version: 3,
          kind: "sticky" as const,
          text: "Shorten the queue",
          groupAlias: "group_2",
        },
        {
          alias: "idea_4",
          itemId: "source-four",
          version: 4,
          kind: "sticky" as const,
          text: "Offer portion choice",
          groupAlias: "group_2",
        },
      ],
    };
    const committed: DurableOperation[] = [];
    const partner = new EducationPartnerWebMcp({
      canWrite: () => true,
      getSnapshot: () => undefined,
      sectionContext: {
        readToolName: "read_selected_class_sections",
        getSnapshot: (token) => (token === snapshot.token ? snapshot : undefined),
      },
      getItemVersion: (itemId) => versions.get(itemId),
      getItemBounds: (itemId) => {
        const index = [...versions.keys()].indexOf(itemId);
        return index < 0
          ? undefined
          : { minX: index * 220, minY: 0, maxX: index * 220 + 180, maxY: 140 };
      },
      getPlacementBounds: () => ({ minX: 0, minY: 0, maxX: 840, maxY: 140 }),
      imagesEnabled: () => true,
      storeVisualImages: storedVisualAssets,
      commit: async (operation) => {
        committed.push(operation);
        return true;
      },
      selectItems: vi.fn(),
      notify: vi.fn(),
    });

    await vi.waitFor(() => expect(allDefined(tools, [...EDUCATION_TOOLS, JIGSAW_TOOL])).toBe(true));
    const capabilityTool = tools.get("list_class_collaboration_modes");
    if (!capabilityTool) throw new Error("Capability tool did not register.");
    const capabilities = (await capabilityTool.execute(
      {},
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(capabilities).toMatchObject({
      availableModeCount: 28,
      sectionIntegration: {
        live: true,
        mode: "cross_group_jigsaw",
        readTool: "read_selected_class_sections",
        writeTool: "add_cross_group_jigsaw",
        sourceOfGroupMembership: "authoritative_section_snapshot",
      },
    });

    const jigsawTool = tools.get("add_cross_group_jigsaw");
    if (!jigsawTool) throw new Error("Jigsaw tool did not register.");
    expect(JSON.stringify(jigsawTool.inputSchema)).toContain("read_selected_class_sections");
    const cards = [
      {
        id: "agreement",
        heading: "Shared goal",
        body: "Both groups want lunch changes that reduce waste without creating more friction.",
        sourceAliases: ["idea_1", "idea_3"],
        question: "What common success measure could both groups use?",
        role: "agreement",
      },
      {
        id: "tension",
        heading: "Different trade-off",
        body: "One group prioritizes material reuse while the other prioritizes speed and choice.",
        sourceAliases: ["idea_2", "idea_4"],
        question: "What evidence would help the class resolve this trade-off?",
        role: "tension",
      },
      {
        id: "complement",
        heading: "Ideas that can work together",
        body: "Packaging reduction and portion choice may address different parts of total waste.",
        sourceAliases: ["idea_1", "idea_4"],
        question: "How could the groups combine these ideas in one small test?",
        role: "complementary idea",
      },
    ];
    const connections = [
      { fromCardId: "agreement", toCardId: "tension", label: "complicated by" },
      { fromCardId: "tension", toCardId: "complement", label: "could be resolved by" },
    ];
    const result = (await jigsawTool.execute(
      {
        sectionToken: snapshot.token,
        title: "What the groups can learn from one another",
        cards,
        connections,
      },
      { signal: new AbortController().signal },
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: "participant_requested_and_added",
      mode: "cross_group_jigsaw",
      additionCount: 3,
      sourceLinkCount: 6,
      comparedGroupCount: 2,
      authoritativeGroupContext: true,
      groupMembershipInferred: false,
      aiAttributed: true,
      undoable: true,
    });
    expect(committed).toHaveLength(1);

    await expect(
      jigsawTool.execute(
        {
          sectionToken: snapshot.token,
          title: "Invalid same-group comparison",
          cards: cards.map((card) => ({
            ...card,
            sourceAliases: ["idea_1", "idea_2"],
          })),
          connections,
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("at least two authoritative groups");
    expect(committed).toHaveLength(1);

    partner.destroy();
    expect(EDUCATION_TOOLS.some((name) => tools.has(name))).toBe(false);
  });

  it("registers tools for every board browser while preserving write permissions", async () => {
    const tools = educationHarness();
    const commit = vi.fn(async () => true);
    const partner = new EducationPartnerWebMcp({
      canWrite: () => false,
      getSnapshot: () => undefined,
      getItemVersion: () => undefined,
      getItemBounds: () => undefined,
      getPlacementBounds: () => undefined,
      imagesEnabled: () => true,
      storeVisualImages: storedVisualAssets,
      commit,
      selectItems: vi.fn(),
      notify: vi.fn(),
    });

    await vi.waitFor(() => expect(allDefined(tools, EDUCATION_TOOLS)).toBe(true));
    const capabilityTool = tools.get("list_class_collaboration_modes");
    if (!capabilityTool) throw new Error("Capability tool did not register.");
    await expect(
      capabilityTool.execute({}, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ availableModeCount: 27 });

    const writeTool = tools.get("add_thinking_expansion");
    if (!writeTool) throw new Error("Write tool did not register.");
    await expect(writeTool.execute({}, { signal: new AbortController().signal })).rejects.toThrow(
      "needs board edit access",
    );
    expect(commit).not.toHaveBeenCalled();

    partner.destroy();
    expect(EDUCATION_TOOLS.some((name) => tools.has(name))).toBe(false);
  });
});

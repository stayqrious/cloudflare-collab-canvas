import {
  MAX_STICKY_TEXT_CODE_POINTS,
  MAX_TABLE_CELL_TEXT_CODE_POINTS,
  MAX_TEXT_CODE_POINTS,
  MAX_ZONE_TITLE_CODE_POINTS,
} from "@collab/protocol";

import { createItem, finalizeBatch } from "../activities/batch";
import {
  ACTIVITY_TEMPLATES,
  type ActivityTemplate,
  type ActivityTemplateId,
  type ActivityTemplateItem,
  buildActivityBatch,
} from "../activities/templates";
import type {
  BatchItemOperation,
  BoardItem,
  DurableOperation,
  NewBoardItem,
  Point,
} from "../types";
import { createId } from "../types";
import { type BoardImage, captureBoardImage, hasVisualContent } from "./board-image";
import {
  isRecord,
  registerWebMcpTool,
  requiredText,
  WEBMCP_MATHJAX_GUIDANCE,
  WEBMCP_TEXT_RENDERING_CAPABILITY,
  webMcpToolEnabled,
} from "./shared";

export const READ_TEMPLATES_TOOL = "read_templates";
export const INSERT_FILLED_TEMPLATE_TOOL = "insert_filled_template";

/** One filled template per call, so a mistake is one ordinary undo. */
const MAX_FILLS = 120;
/**
 * Pictures are the expensive part of a catalogue read. A whole-catalogue read stops rendering
 * them once it has spent this many encoded characters, in list order, so one tool result stays
 * inside what a host will read. Reading a single template always renders its picture.
 */
export const MAX_CATALOGUE_PREVIEW_CHARACTERS = 2_000_000;

/**
 * Where a template's text lives, the longest fill the board will accept there, and whether the
 * board accepts an empty one. A sticky note or a table cell may stand empty for a student to
 * complete; a canvas text object or a Section title may not, because an empty one would be an
 * object nobody can see or select. The board rejects those, so this tool refuses them first with
 * an answer a host can act on.
 */
const SLOT_RULES = {
  text: { maxLength: MAX_TEXT_CODE_POINTS, allowsEmpty: false },
  sticky: { maxLength: MAX_STICKY_TEXT_CODE_POINTS, allowsEmpty: true },
  table_cell: { maxLength: MAX_TABLE_CELL_TEXT_CODE_POINTS, allowsEmpty: true },
  zone_title: { maxLength: MAX_ZONE_TITLE_CODE_POINTS, allowsEmpty: false },
} as const;

export type TemplateSlotTarget = keyof typeof SLOT_RULES;

export type TemplateSlot = {
  /** Stable within one template definition: slot_1, slot_2, ... in template order. */
  slot: string;
  target: TemplateSlotTarget;
  /** Index into the template's items, which is also the created object's index. */
  itemIndex: number;
  /** Set only for table_cell slots. */
  row?: number;
  column?: number;
  /** The placeholder the template ships with. Empty when the slot is blank for students. */
  current: string;
  maxLength: number;
  /** Whether an empty fill is accepted here, clearing the slot for a student to complete. */
  allowsEmpty: boolean;
};

export type ActivityTemplateWebMcpOptions = {
  canWrite: () => boolean;
  /** Whether this board's features allow the template, and why not when they do not. */
  templateIssue: (template: ActivityTemplate) => string | null;
  /** Board coordinates the template should be centred on, normally the viewport centre. */
  getPlacementCenter: () => Point;
  commit: (operation: DurableOperation) => Promise<boolean>;
  /** Selects and reveals what was just inserted, as the activities menu does. */
  revealItems: (itemIds: readonly string[]) => void;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

/**
 * Exposes the board's activity templates to a WebMCP host: what is available here, where each
 * one takes text, and one write that inserts a template with that text already filled in.
 */
export class ActivityTemplateWebMcp {
  private readonly registration = new AbortController();

  constructor(private readonly options: ActivityTemplateWebMcpOptions) {
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
          name: READ_TEMPLATES_TOOL,
          description: `List the activity templates this board can insert, with the text slots each one takes. Templates are whole-board scaffolds such as an exit ticket, a K-W-L table, a sort, a pair share, or a stamp vote; they do not use the browser selection. Each template reports its templateId, label, description, the objects it creates, and its slots. A slot is one place the template holds text: a canvas text object, a sticky note, a table cell, or a Section title. Every slot carries a slot alias, its current placeholder, the longest fill the board accepts there, and whether it accepts an empty fill. A sticky note or table cell may be cleared for a student to complete; a canvas text object or Section title may not. When a template draws shapes, stamps or images, the result also carries preview, a PNG of the template as it would appear, so you can see the layout rather than infer it from the object list. Pass templateId to read one template and always get its picture.${templateWriteGuidance()} Board IDs, item IDs, coordinates, presence, and existing board content are not returned. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            properties: {
              templateId: {
                type: "string",
                enum: ACTIVITY_TEMPLATES.map((template) => template.id),
                description:
                  "Read only this template, and always render its picture. Omit for the whole catalogue.",
              },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
          execute: async (input, { signal }) => this.readTemplates(input, signal),
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: INSERT_FILLED_TEMPLATE_TOOL,
          description: `Insert one activity template on this board with its text slots already filled in. First call ${READ_TEMPLATES_TOOL} to choose a template and read its slot aliases, then pass templateId and a fills list of slot and text pairs. Unlisted slots keep the placeholder the template ships with, so pass only what you mean to write; pass an empty string to clear a slot whose allowsEmpty is true, leaving it for students to complete. The template lands at the centre of this participant's view as one normal realtime batch, tagged as written by AI, with ordinary undo. The caller's WebMCP permission is the approval. Fill the prompts, questions, headings and categories that frame the work; leave the students' own answers, votes, ratings and choices blank. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            properties: {
              templateId: {
                type: "string",
                enum: ACTIVITY_TEMPLATES.map((template) => template.id),
                description: `The template to insert, from ${READ_TEMPLATES_TOOL}.`,
              },
              fills: {
                type: "array",
                minItems: 0,
                maxItems: MAX_FILLS,
                description: "The slots to write. Omitted slots keep their placeholder.",
                items: {
                  type: "object",
                  properties: {
                    slot: {
                      type: "string",
                      pattern: "^slot_[1-9][0-9]{0,2}$",
                      description: `A slot alias from ${READ_TEMPLATES_TOOL}.`,
                    },
                    text: {
                      type: "string",
                      maxLength: MAX_TEXT_CODE_POINTS,
                      description:
                        "The text to place there. Plain text with optional TeX; no HTML. Empty clears a slot whose allowsEmpty is true.",
                    },
                  },
                  required: ["slot", "text"],
                  additionalProperties: false,
                },
              },
            },
            required: ["templateId"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: async (input, { signal }) => this.insertFilledTemplate(input, signal),
        },
        { signal: this.registration.signal },
      );
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The activity template tools could not be registered.", "warning");
    }
  }

  private async readTemplates(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (input !== undefined && !isRecord(input)) {
      throw new Error("Template read input must be an object.");
    }
    const requested =
      isRecord(input) && input.templateId !== undefined
        ? this.requireAvailable(templateIdValue(input.templateId))
        : undefined;
    const templates = requested
      ? [requested]
      : ACTIVITY_TEMPLATES.filter((template) => this.options.templateIssue(template) === null);
    if (templates.length === 0) {
      throw new Error("This board has no activity templates enabled.");
    }

    let spentCharacters = 0;
    let previewsOmitted = 0;
    const described: Array<Record<string, unknown>> = [];
    for (const template of templates) {
      const draws = hasVisualContent(previewItems(template));
      const wantsPreview = requested !== undefined || draws;
      const rendered = wantsPreview ? await this.renderPreview(template) : undefined;
      // Reading one template by name always shows it. In a catalogue the picture is only kept if
      // it fits what is left of the budget, since one dense render can be larger than the whole
      // of it; measuring after rendering is the only way to know.
      const affordable =
        requested !== undefined ||
        (rendered !== undefined &&
          spentCharacters + rendered.pngDataUrl.length <= MAX_CATALOGUE_PREVIEW_CHARACTERS);
      const preview = affordable ? rendered : undefined;
      if (preview) spentCharacters += preview.pngDataUrl.length;
      else if (wantsPreview && draws) previewsOmitted += 1;
      signal.throwIfAborted();
      described.push(describeTemplate(template, preview));
    }

    return {
      capturedAt: new Date().toISOString(),
      scope: "board_activity_templates",
      templateCount: described.length,
      templates: described,
      ...(previewsOmitted === 0
        ? {}
        : {
            previewsOmitted,
            previewNote: `${previewsOmitted} template${previewsOmitted === 1 ? "" : "s"} that draw could not fit a picture in this result. Read one by templateId to see it.`,
          }),
      ...(webMcpToolEnabled(INSERT_FILLED_TEMPLATE_TOOL)
        ? {
            writeTool: INSERT_FILLED_TEMPLATE_TOOL,
            fillGuidance: {
              action:
                "Fill the prompts, questions, headings and category labels that frame the activity. Keep the wording short enough to read on a card.",
              leaveForStudents:
                "Leave answer cells, votes, ratings, rankings and the class's own conclusions blank.",
              omittedSlots: "A slot you do not list keeps the placeholder the template ships with.",
            },
          }
        : {
            writeTool: null,
            writeNote:
              "This build exposes no template writer, so this catalogue is for choosing and describing an activity, not for inserting one. A participant inserts a template from the board's own activities menu.",
          }),
      textRendering: WEBMCP_TEXT_RENDERING_CAPABILITY,
      privacy:
        "Only the board's template definitions are shared. Board and item IDs, coordinates, existing board content, participants, presence, history, and authentication data are not.",
    };
  }

  private async insertFilledTemplate(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!this.options.canWrite()) {
      throw new Error("This browser needs board edit access to insert a template.");
    }
    if (!isRecord(input)) throw new Error("Template insert input must be an object.");
    const template = this.requireAvailable(templateIdValue(input.templateId));
    const fills = parseFills(input.fills, templateSlots(template));

    const activity = buildActivityBatch(template.id, this.options.getPlacementCenter(), createId);
    const creates = activity.operation.operations.filter(isCreateOperation).map(({ item }) => item);
    if (creates.length !== template.items.length) {
      throw new Error("The template could not be prepared for insertion.");
    }
    for (const fill of fills) applyFill(creates, fill);

    const itemIds: string[] = [];
    const operation = finalizeBatch(
      creates.map((item) => createItem(item, itemIds)),
      "The filled template is too large to insert as one batch.",
      { rejectEmpty: true },
    );
    signal.throwIfAborted();
    const accepted = await this.options.commit(operation);
    if (!accepted) throw new Error("The filled template could not be queued for saving.");
    this.options.revealItems(itemIds);
    this.options.notify(
      fills.length === 0
        ? `${template.label} added.`
        : `${template.label} added with ${fills.length} filled slot${fills.length === 1 ? "" : "s"}.`,
      "info",
    );

    return {
      status: "inserted",
      templateId: template.id,
      label: template.label,
      createdItemCount: itemIds.length,
      filledSlotCount: fills.length,
      filledSlots: fills.map(({ slot }) => slot.slot),
      changedCanvas: true,
      aiAttributed: true,
      undoable: true,
      placement: "centred_on_this_participant_view",
      message:
        "Added as one acknowledged realtime batch, tagged as written by AI. The template frames the activity; the class fills in its own answers.",
      privacy:
        "Only the text you supplied was written to the board. No board, item, or participant identifiers were returned.",
    };
  }

  private requireAvailable(templateId: ActivityTemplateId): ActivityTemplate {
    const template = ACTIVITY_TEMPLATES.find(({ id }) => id === templateId);
    if (!template) throw new Error(`Unknown template: ${templateId}.`);
    const issue = this.options.templateIssue(template);
    if (issue) throw new Error(issue);
    return template;
  }

  private async renderPreview(template: ActivityTemplate): Promise<BoardImage | undefined> {
    try {
      return await captureBoardImage(previewItems(template));
    } catch {
      return undefined;
    }
  }
}

/**
 * Names the writer only when this build exposes it. A read that tells a host to call a tool the
 * allowlist withholds sends it to a call that cannot succeed, so the two are read from one place.
 */
function templateWriteGuidance(): string {
  return webMcpToolEnabled(INSERT_FILLED_TEMPLATE_TOOL)
    ? ` Use this before ${INSERT_FILLED_TEMPLATE_TOOL} to choose a template and learn its slot aliases.`
    : " This board exposes no template writer, so use this to describe an activity or help a participant choose one from the board's activities menu; there is no tool call to follow it with.";
}

/**
 * Materializes a template definition as board objects purely so it can be drawn. The renderer
 * validates what it is given, so the throwaway objects carry real ids; the serializer replaces
 * them with visual aliases before anything leaves the page.
 */
function previewItems(template: ActivityTemplate): BoardItem[] {
  const author = createId();
  return template.items.map(
    (source, index) =>
      ({
        ...structuredClone(source),
        id: createId(),
        transform: [1, 0, 0, 1, 0, 0],
        z: index,
        version: 1,
        createdBy: author,
      }) as BoardItem,
  );
}

/** Every place a template holds text, aliased in template order. */
export function templateSlots(template: ActivityTemplate): TemplateSlot[] {
  const slots: TemplateSlot[] = [];
  const push = (slot: Omit<TemplateSlot, "slot" | "maxLength" | "allowsEmpty">): void => {
    slots.push({
      ...slot,
      ...SLOT_RULES[slot.target],
      slot: `slot_${slots.length + 1}`,
    });
  };
  template.items.forEach((item, itemIndex) => {
    if (item.kind === "text") {
      push({ target: "text", itemIndex, current: item.geometry.text });
    } else if (item.kind === "sticky") {
      push({ target: "sticky", itemIndex, current: item.geometry.text });
    } else if (item.kind === "zone") {
      push({ target: "zone_title", itemIndex, current: item.geometry.title });
    } else if (item.kind === "table") {
      item.geometry.cells.forEach((row, rowIndex) => {
        row.forEach((cell, columnIndex) => {
          push({
            target: "table_cell",
            itemIndex,
            row: rowIndex,
            column: columnIndex,
            current: cell,
          });
        });
      });
    }
  });
  return slots;
}

function describeTemplate(
  template: ActivityTemplate,
  preview: BoardImage | undefined,
): Record<string, unknown> {
  const objectKinds: Partial<Record<ActivityTemplateItem["kind"], number>> = {};
  for (const item of template.items) {
    objectKinds[item.kind] = (objectKinds[item.kind] ?? 0) + 1;
  }
  return {
    templateId: template.id,
    label: template.label,
    description: template.description,
    objectCount: template.items.length,
    objectKinds,
    slots: templateSlots(template).map(
      ({ slot, target, current, maxLength, allowsEmpty, row, column }) => ({
        slot,
        target,
        current,
        maxLength,
        allowsEmpty,
        ...(row === undefined ? {} : { row, column }),
      }),
    ),
    ...(preview === undefined
      ? {}
      : {
          preview: {
            ...preview,
            note: "A picture of the template as it would land on the board, before any fills.",
          },
        }),
  };
}

type ParsedFill = { slot: TemplateSlot; text: string };

function parseFills(value: unknown, slots: readonly TemplateSlot[]): ParsedFill[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FILLS) {
    throw new Error(`fills must be a list of at most ${MAX_FILLS} entries.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`fills[${index}] must be an object.`);
    const alias = requiredText(entry.slot, `fills[${index}].slot`, 16);
    const slot = slots.find((candidate) => candidate.slot === alias);
    if (!slot) {
      throw new Error(
        `fills[${index}].slot ${alias} is not a slot of this template. Read the template again.`,
      );
    }
    if (seen.has(alias)) throw new Error(`fills lists ${alias} more than once.`);
    seen.add(alias);
    if (typeof entry.text !== "string") throw new Error(`fills[${index}].text must be text.`);
    const text = entry.text.trim();
    if (text.length === 0 && !slot.allowsEmpty) {
      throw new Error(
        `${alias} is a ${slot.target === "text" ? "canvas text object" : "Section title"} and cannot be left empty. Write it, or omit it to keep its placeholder.`,
      );
    }
    if ([...text].length > slot.maxLength) {
      throw new Error(
        `fills[${index}].text holds more than the ${slot.maxLength} characters ${alias} accepts.`,
      );
    }
    return { slot, text };
  });
}

function applyFill(items: readonly NewBoardItem[], { slot, text }: ParsedFill): void {
  const item = items[slot.itemIndex];
  if (!item) throw new Error(`${slot.slot} is missing from the prepared template.`);
  if (slot.target === "text" && item.kind === "text") {
    item.geometry.text = text;
    return;
  }
  if (slot.target === "sticky" && item.kind === "sticky") {
    item.geometry.text = text;
    return;
  }
  if (slot.target === "zone_title" && item.kind === "zone") {
    item.geometry.title = text;
    return;
  }
  if (slot.target === "table_cell" && item.kind === "table") {
    const row = item.geometry.cells[slot.row ?? -1];
    if (!row || slot.column === undefined || slot.column >= row.length) {
      throw new Error(`${slot.slot} is missing from the prepared template.`);
    }
    row[slot.column] = text;
    return;
  }
  throw new Error(`${slot.slot} no longer matches this template.`);
}

function isCreateOperation(
  operation: BatchItemOperation,
): operation is Extract<BatchItemOperation, { kind: "item.create" }> {
  return operation.kind === "item.create";
}

function templateIdValue(value: unknown): ActivityTemplateId {
  const ids = ACTIVITY_TEMPLATES.map(({ id }) => id);
  if (typeof value !== "string" || !ids.includes(value as ActivityTemplateId)) {
    throw new Error(`templateId must be one of: ${ids.join(", ")}.`);
  }
  return value as ActivityTemplateId;
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVITY_TEMPLATES, type ActivityTemplate } from "../activities/templates";
import type { BoardItem, DurableOperation, NewBoardItem } from "../types";
import {
  ActivityTemplateWebMcp,
  MAX_CATALOGUE_PREVIEW_CHARACTERS,
  templateSlots,
} from "./activity-templates";
import { hasVisualContent } from "./board-image";
import { webMcpToolDefinitions } from "./shared";
import type { WebMcpRegisterToolOptions, WebMcpToolDefinition } from "./types";

type CreatedItem = NewBoardItem & { assistedBy?: "ai" };

/** Enough of a canvas for captureBoardImage to produce a data URL in the node test env. */
function stubCanvas(): void {
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:template-preview",
    revokeObjectURL: () => undefined,
  });
  vi.stubGlobal("Blob", class {});
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode(): Promise<void> {
        return Promise.resolve();
      }
    },
  );
}

function fakeCanvas(dataUrl: string): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      fillRect: () => undefined,
      drawImage: () => undefined,
    }),
    toDataURL: () => dataUrl,
  } as unknown as HTMLCanvasElement;
}

function harness(
  options: {
    canWrite?: boolean;
    canvas?: boolean;
    /** Encoded size of each rendered picture, for exercising the catalogue budget. */
    pngCharacters?: number;
    templateIssue?: (template: ActivityTemplate) => string | null;
  } = {},
) {
  const exposed = new Map<string, WebMcpToolDefinition>();
  const tools = webMcpToolDefinitions();
  if (options.canvas) stubCanvas();
  const dataUrl = `data:image/png;base64,${"r".repeat(Math.max(1, options.pngCharacters ?? 8))}`;
  vi.stubGlobal("document", {
    createElement: () => fakeCanvas(dataUrl),
    modelContext: {
      registerTool(tool: WebMcpToolDefinition, registration?: WebMcpRegisterToolOptions) {
        exposed.set(tool.name, tool);
        registration?.signal?.addEventListener("abort", () => exposed.delete(tool.name), {
          once: true,
        });
      },
    },
  });
  const committed: DurableOperation[] = [];
  const revealed: string[][] = [];
  const notices: string[] = [];
  const templates = new ActivityTemplateWebMcp({
    canWrite: () => options.canWrite ?? true,
    templateIssue: options.templateIssue ?? (() => null),
    getPlacementCenter: () => [120, 80],
    commit: async (operation) => {
      committed.push(operation);
      return true;
    },
    revealItems: (itemIds) => revealed.push([...itemIds]),
    notify: (message) => notices.push(message),
  });
  const call = async (name: string, input: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`${name} is not registered.`);
    return (await tool.execute(input, { signal: new AbortController().signal })) as Record<
      string,
      unknown
    >;
  };
  return { templates, tools, exposed, committed, revealed, notices, call };
}

function createdItems(operation: DurableOperation | undefined): CreatedItem[] {
  if (operation?.kind !== "items.batch") throw new Error("Expected an items batch.");
  return operation.operations.flatMap((entry) =>
    entry.kind === "item.create" ? [entry.item as CreatedItem] : [],
  );
}

async function ready() {
  const context = harness();
  await vi.waitFor(() => expect(context.tools.has("insert_filled_template")).toBe(true));
  return context;
}

/**
 * The templates read_templates should render, in catalogue order. Asks the same predicate the
 * tool does, so the expectation cannot drift from what counts as drawn work.
 */
function drawingTemplateIds(): string[] {
  return ACTIVITY_TEMPLATES.filter((template) =>
    hasVisualContent(template.items as unknown as BoardItem[]),
  ).map(({ id }) => id);
}

describe("templateSlots", () => {
  it("aliases every text place in template order, including each table cell", () => {
    const kwl = ACTIVITY_TEMPLATES.find(({ id }) => id === "kwl");
    if (!kwl) throw new Error("The K-W-L template is missing.");
    const slots = templateSlots(kwl);

    expect(slots[0]).toMatchObject({
      slot: "slot_1",
      target: "text",
      current: "K-W-L",
      // A canvas text object the board can never save empty.
      allowsEmpty: false,
    });
    expect(slots[1]).toMatchObject({
      slot: "slot_2",
      target: "table_cell",
      row: 0,
      column: 0,
      current: "What I know",
      maxLength: 500,
      allowsEmpty: true,
    });
    // One title plus a 3-column, 4-row table.
    expect(slots).toHaveLength(1 + 12);
    expect(slots.map(({ slot }) => slot)).toEqual(slots.map((_, index) => `slot_${index + 1}`));
  });

  it("gives sticky and canvas text their own board limits", () => {
    const exit = ACTIVITY_TEMPLATES.find(({ id }) => id === "exit-ticket");
    if (!exit) throw new Error("The exit ticket template is missing.");
    const slots = templateSlots(exit);
    expect(slots.find(({ target }) => target === "text")?.maxLength).toBe(5_000);
    expect(slots.find(({ target }) => target === "sticky")).toMatchObject({
      maxLength: 1_000,
      current: "I learned…",
      // A sticky may stand empty, waiting for a student.
      allowsEmpty: true,
    });
  });
});

describe("read_templates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the board's templates with their slots and never leaks board content", async () => {
    const { templates, call } = await ready();
    const result = await call("read_templates", {});

    expect(result).toMatchObject({
      scope: "board_activity_templates",
      templateCount: ACTIVITY_TEMPLATES.length,
      // The read is the first half of the fill flow, so it names the writer it hands off to.
      writeTool: "insert_filled_template",
    });
    expect(result.fillGuidance).toMatchObject({
      leaveForStudents: expect.stringContaining("blank"),
    });
    const listed = result.templates as Array<Record<string, unknown>>;
    const kwl = listed.find((entry) => entry.templateId === "kwl");
    expect(kwl).toMatchObject({ label: "K-W-L", objectCount: 2 });
    expect(kwl?.objectKinds).toEqual({ text: 1, table: 1 });
    expect(kwl?.slots as unknown[]).toHaveLength(13);
    templates.destroy();
  });

  it("hides templates this board cannot insert, and refuses one asked for by name", async () => {
    const context = harness({
      templateIssue: (template) =>
        template.id === "kwl" ? "Enable tables to use this template." : null,
    });
    await vi.waitFor(() => expect(context.tools.has("read_templates")).toBe(true));
    const result = await context.call("read_templates", {});
    const ids = (result.templates as Array<Record<string, unknown>>).map(
      ({ templateId }) => templateId,
    );

    expect(ids).not.toContain("kwl");
    await expect(context.call("read_templates", { templateId: "kwl" })).rejects.toThrow(
      "Enable tables",
    );
    context.templates.destroy();
  });

  it("attaches a picture only to templates that draw, and caps how many it renders", async () => {
    const context = harness({ canvas: true });
    await vi.waitFor(() => expect(context.tools.has("read_templates")).toBe(true));

    const catalogue = await context.call("read_templates", {});
    const listed = catalogue.templates as Array<Record<string, unknown>>;
    const withPreview = listed.filter((entry) => entry.preview !== undefined);

    // Exactly the templates that draw shapes, stamps or strokes get a picture.
    expect(withPreview.map(({ templateId }) => templateId)).toEqual(drawingTemplateIds());
    expect(catalogue.previewsOmitted).toBeUndefined();
    // K-W-L is a title and a table, so it is fully described by its slots.
    expect(listed.find((entry) => entry.templateId === "kwl")?.preview).toBeUndefined();

    // Naming a text-only template still renders it, so a host can see the layout.
    const single = await context.call("read_templates", { templateId: "kwl" });
    const only = (single.templates as Array<Record<string, unknown>>)[0];
    expect(single.templateCount).toBe(1);
    expect(only?.preview).toBeDefined();
    context.templates.destroy();
  });

  it("drops a single picture that would not fit the catalogue budget on its own", async () => {
    // One dense render can be larger than the whole budget, so a first picture is not free.
    const context = harness({
      canvas: true,
      pngCharacters: MAX_CATALOGUE_PREVIEW_CHARACTERS + 1,
    });
    await vi.waitFor(() => expect(context.tools.has("read_templates")).toBe(true));

    const catalogue = await context.call("read_templates", {});
    const listed = catalogue.templates as Array<Record<string, unknown>>;
    expect(listed.filter((entry) => entry.preview !== undefined)).toHaveLength(0);
    // Every template that draws is named instead of shown.
    expect(catalogue).toMatchObject({ previewsOmitted: drawingTemplateIds().length });

    // Reading one template by name still shows it, however large.
    const single = await context.call("read_templates", { templateId: "exit-ticket" });
    expect((single.templates as Array<Record<string, unknown>>)[0]?.preview).toBeDefined();
    context.templates.destroy();
  });

  it("stops rendering pictures once a catalogue read has spent its budget", async () => {
    const context = harness({
      canvas: true,
      // Two of these fit the budget and a third does not.
      pngCharacters: Math.floor(MAX_CATALOGUE_PREVIEW_CHARACTERS / 2) - 100,
    });
    await vi.waitFor(() => expect(context.tools.has("read_templates")).toBe(true));

    const catalogue = await context.call("read_templates", {});
    const listed = catalogue.templates as Array<Record<string, unknown>>;
    const withPreview = listed.filter((entry) => entry.preview !== undefined);

    // Two pictures spend the budget; every later drawn template is named instead.
    const drawing = drawingTemplateIds();
    expect(withPreview.map(({ templateId }) => templateId)).toEqual(drawing.slice(0, 2));
    expect(catalogue).toMatchObject({ previewsOmitted: drawing.length - 2 });
    expect(String(catalogue.previewNote)).toContain("Read one by templateId");

    // A single-template read is never held back by the catalogue budget.
    const single = await context.call("read_templates", { templateId: "pair-share" });
    expect((single.templates as Array<Record<string, unknown>>)[0]?.preview).toBeDefined();
    context.templates.destroy();
  });

  it("sends a host on to the writer in the contract it reads", async () => {
    const { templates, exposed } = await ready();
    const read = exposed.get("read_templates");
    if (!read) throw new Error("read_templates was not offered to the host.");
    expect(read.description).toContain("Use this before insert_filled_template");
    expect(read.description).not.toContain("no template writer");
    templates.destroy();
  });

  it("rejects a template id it does not know", async () => {
    const { templates, call } = await ready();
    await expect(call("read_templates", { templateId: "made-up" })).rejects.toThrow(
      "templateId must be one of",
    );
    templates.destroy();
  });
});

describe("insert_filled_template", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the named slots, leaves the rest, and tags the batch as AI written", async () => {
    const { templates, committed, revealed, notices, call } = await ready();
    const result = await call("insert_filled_template", {
      templateId: "kwl",
      fills: [
        { slot: "slot_1", text: "Photosynthesis" },
        { slot: "slot_2", text: "  What we already know  " },
      ],
    });

    expect(result).toMatchObject({
      status: "inserted",
      templateId: "kwl",
      createdItemCount: 2,
      filledSlotCount: 2,
      filledSlots: ["slot_1", "slot_2"],
      aiAttributed: true,
      undoable: true,
    });
    const items = createdItems(committed[0]);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.assistedBy === "ai")).toBe(true);
    const [title, table] = items;
    if (title?.kind !== "text" || table?.kind !== "table") throw new Error("Unexpected template.");
    expect(title.geometry.text).toBe("Photosynthesis");
    expect(table.geometry.cells[0]?.[0]).toBe("What we already know");
    expect(table.geometry.cells[0]?.[1]).toBe("What I want to know");
    expect(title.transform).toEqual([1, 0, 0, 1, 120, 80]);
    expect(revealed[0]).toEqual(items.map(({ id }) => id));
    expect(notices.at(-1)).toBe("K-W-L added with 2 filled slots.");
    templates.destroy();
  });

  it("inserts an unfilled template and leaves every placeholder alone", async () => {
    const { templates, committed, notices, call } = await ready();
    const result = await call("insert_filled_template", { templateId: "exit-ticket" });

    expect(result).toMatchObject({ filledSlotCount: 0, filledSlots: [] });
    const sticky = createdItems(committed[0]).find((item) => item.kind === "sticky");
    if (sticky?.kind !== "sticky") throw new Error("The exit ticket lost its stickies.");
    expect(sticky.geometry.text).toBe("I learned…");
    expect(notices.at(-1)).toBe("Exit ticket added.");
    templates.destroy();
  });

  it("clears a slot the board lets stand empty, and refuses one it does not", async () => {
    const { templates, committed, call } = await ready();
    await call("insert_filled_template", {
      templateId: "kwl",
      fills: [{ slot: "slot_2", text: "" }],
    });
    const table = createdItems(committed[0]).find((item) => item.kind === "table");
    if (table?.kind !== "table") throw new Error("The K-W-L lost its table.");
    expect(table.geometry.cells[0]?.[0]).toBe("");

    // The board rejects an empty canvas text object, so the tool says so instead of failing
    // validation halfway through a batch.
    await expect(
      call("insert_filled_template", {
        templateId: "kwl",
        fills: [{ slot: "slot_1", text: "   " }],
      }),
    ).rejects.toThrow("cannot be left empty");
    // The refused call changed nothing.
    expect(committed).toHaveLength(1);
    templates.destroy();
  });

  it("never offers a fill the board would reject when it commits", async () => {
    // Every slot the tool reports as clearable must survive a real insert of that template.
    const { templates, committed, call } = await ready();
    const catalogue = await call("read_templates", {});
    for (const entry of catalogue.templates as Array<Record<string, unknown>>) {
      const slots = entry.slots as Array<Record<string, unknown>>;
      const clearable = slots.filter((slot) => slot.allowsEmpty === true);
      if (clearable.length === 0) continue;
      await call("insert_filled_template", {
        templateId: entry.templateId,
        fills: clearable.map((slot) => ({ slot: slot.slot, text: "" })),
      });
    }
    expect(committed.length).toBeGreaterThan(0);
    templates.destroy();
  });

  it("rejects unknown, repeated, and oversized fills", async () => {
    const { templates, committed, call } = await ready();
    await expect(
      call("insert_filled_template", {
        templateId: "kwl",
        fills: [{ slot: "slot_99", text: "Nope" }],
      }),
    ).rejects.toThrow("not a slot of this template");
    await expect(
      call("insert_filled_template", {
        templateId: "kwl",
        fills: [
          { slot: "slot_1", text: "One" },
          { slot: "slot_1", text: "Two" },
        ],
      }),
    ).rejects.toThrow("more than once");
    await expect(
      call("insert_filled_template", {
        templateId: "kwl",
        fills: [{ slot: "slot_2", text: "x".repeat(501) }],
      }),
    ).rejects.toThrow("500 characters");
    expect(committed).toHaveLength(0);
    templates.destroy();
  });

  it("refuses to write without board edit access or when the board disables the template", async () => {
    const readOnly = harness({ canWrite: false });
    await vi.waitFor(() => expect(readOnly.tools.has("insert_filled_template")).toBe(true));
    await expect(readOnly.call("insert_filled_template", { templateId: "kwl" })).rejects.toThrow(
      "needs board edit access",
    );
    readOnly.templates.destroy();

    const gated = harness({ templateIssue: () => "Enable templates to use this template." });
    await vi.waitFor(() => expect(gated.tools.has("insert_filled_template")).toBe(true));
    await expect(gated.call("insert_filled_template", { templateId: "kwl" })).rejects.toThrow(
      "Enable templates",
    );
    expect(gated.committed).toHaveLength(0);
    gated.templates.destroy();
  });

  it("reports a commit the board would not queue", async () => {
    const tools = webMcpToolDefinitions();
    vi.stubGlobal("document", {
      modelContext: { registerTool: () => undefined },
    });
    const templates = new ActivityTemplateWebMcp({
      canWrite: () => true,
      templateIssue: () => null,
      getPlacementCenter: () => [0, 0],
      commit: async () => false,
      revealItems: () => undefined,
      notify: () => undefined,
    });
    await vi.waitFor(() => expect(tools.has("insert_filled_template")).toBe(true));
    const tool = tools.get("insert_filled_template");
    if (!tool) throw new Error("insert_filled_template is not registered.");
    await expect(
      tool.execute({ templateId: "kwl" }, { signal: new AbortController().signal }),
    ).rejects.toThrow("could not be queued");
    templates.destroy();
  });

  it("exposes both halves of the fill flow and withdraws them on teardown", async () => {
    const { templates, tools, exposed } = await ready();
    expect(tools.has("read_templates")).toBe(true);
    expect(exposed.has("read_templates")).toBe(true);
    expect(exposed.has("insert_filled_template")).toBe(true);
    templates.destroy();
    expect(tools.has("read_templates")).toBe(false);
    expect(tools.has("insert_filled_template")).toBe(false);
    expect(exposed.size).toBe(0);
  });
});

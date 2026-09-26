import "./inquiry-map.css";

import {
  buildCollectiveInquiryMap,
  type CollectiveInquiryBatch,
  CollectiveInquiryError,
  type CollectiveInquiryProposal,
  type InquirySource,
} from "../activities/collective-inquiry";
import type { Bounds } from "../board/model";
import type { DurableOperation } from "../types";
import type { CollectiveInquirySnapshot } from "./collective-inquiry";
import {
  awaitDialogDecision,
  isRecord,
  registerWebMcpTool,
  requiredText,
  WEBMCP_MATHJAX_GUIDANCE,
} from "./shared";

const STAGE_INQUIRY_TOOL = "stage_collective_inquiry";

export type InquiryMapWebMcpOptions = {
  root: HTMLElement;
  canWrite: () => boolean;
  getSnapshot: (token: string) => CollectiveInquirySnapshot | undefined;
  getItemVersion: (itemId: string) => number | undefined;
  getItemBounds: (itemId: string) => Bounds | undefined;
  commit: (operation: DurableOperation) => Promise<boolean>;
  selectItems: (itemIds: readonly string[]) => void;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

export class InquiryMapWebMcp {
  private readonly previewDialog: HTMLDialogElement;
  private readonly registration = new AbortController();

  constructor(private readonly options: InquiryMapWebMcpOptions) {
    this.previewDialog = this.buildPreviewDialog();
    options.root.append(this.previewDialog);
    void this.register();
  }

  destroy(): void {
    this.registration.abort();
    if (this.previewDialog.open) this.previewDialog.close("cancel");
    this.previewDialog.remove();
  }

  private async register(): Promise<void> {
    const modelContext = document.modelContext;
    if (typeof modelContext?.registerTool !== "function") return;
    try {
      await registerWebMcpTool(
        modelContext,
        {
          name: STAGE_INQUIRY_TOOL,
          description: `Stage a visual collective-inquiry map from a SpaceScale selection read in this browser. Connect the selected contribution aliases into 2-4 themes, identify bridges across themes, and name one productive tension plus a next question. SpaceScale computes the canvas layout and shows a preview; nothing is added unless the participant approves inside the app. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["selectionToken", "mapTitle", "themes", "bridges", "tension"],
            properties: {
              selectionToken: {
                type: "string",
                description: "Opaque token returned by read_selected_class_ideas.",
              },
              mapTitle: { type: "string", minLength: 3, maxLength: 100 },
              themes: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label", "summary", "ideaAliases"],
                  properties: {
                    id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
                    label: { type: "string", minLength: 2, maxLength: 60 },
                    summary: { type: "string", minLength: 10, maxLength: 400 },
                    ideaAliases: {
                      type: "array",
                      minItems: 1,
                      maxItems: 30,
                      uniqueItems: true,
                      items: { type: "string", pattern: "^(idea|context)_[1-9][0-9]*$" },
                    },
                  },
                },
              },
              bridges: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["fromThemeId", "toThemeId", "insight"],
                  properties: {
                    fromThemeId: { type: "string" },
                    toThemeId: { type: "string" },
                    insight: { type: "string", minLength: 10, maxLength: 260 },
                  },
                },
              },
              tension: {
                type: "object",
                additionalProperties: false,
                required: ["statement", "nextQuestion"],
                properties: {
                  statement: { type: "string", minLength: 10, maxLength: 320 },
                  nextQuestion: { type: "string", minLength: 10, maxLength: 240 },
                },
              },
            },
          },
          annotations: {
            readOnlyHint: false,
          },
          execute: async (input, { signal }) => this.stage(input, signal),
        },
        { signal: this.registration.signal },
      );
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The inquiry-map tool could not be registered.", "warning");
    }
  }

  private async stage(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!this.options.canWrite())
      throw new Error("This browser needs board edit access to stage an inquiry map.");
    const proposal = parseProposal(input);
    const snapshot = this.options.getSnapshot(proposal.selectionToken);
    if (!snapshot) {
      throw new Error(
        "That selection token has expired. Read the currently selected ideas again before staging a map.",
      );
    }
    const knownAliases = new Set(snapshot.sources.map((source) => source.alias));
    const assignedAliases = new Set<string>();
    for (const theme of proposal.themes) {
      for (const alias of theme.ideaAliases) {
        if (!knownAliases.has(alias)) {
          throw new Error(`${alias} is not part of the browser selection.`);
        }
        if (assignedAliases.has(alias)) {
          throw new Error(`${alias} was assigned to more than one theme.`);
        }
        assignedAliases.add(alias);
      }
    }
    const previewBatch = buildBatch(proposal, this.liveSources(snapshot));

    const approved = await this.confirmPreview(
      proposal,
      assignedAliases.size,
      previewBatch.itemIds.length,
      signal,
    );
    if (!approved) {
      return {
        status: "participant_declined",
        changedCanvas: false,
        message: "The participant reviewed the proposal and kept the shared canvas unchanged.",
      };
    }
    signal.throwIfAborted();
    // The ideas may have been edited or moved while the preview was open, so
    // re-validate them and lay the map out again from their current bounds.
    const batch = buildBatch(proposal, this.liveSources(snapshot));
    const accepted = await this.options.commit(batch.operation);
    if (!accepted)
      throw new Error("The inquiry map was approved but could not be queued for saving.");
    this.options.selectItems(batch.itemIds);
    this.options.notify("Inquiry map added. The class can now challenge and extend it.", "info");
    return {
      status: "participant_approved_and_added",
      changedCanvas: true,
      createdItemCount: batch.itemIds.length,
      connectedContributionCount: assignedAliases.size,
      themeCount: proposal.themes.length,
      message:
        "The map was added as one normal SpaceScale batch. It is visible to collaborators and can be undone.",
    };
  }

  /** Throws unless every snapshot idea is unchanged; returns their current bounds. */
  private liveSources(snapshot: CollectiveInquirySnapshot): InquirySource[] {
    for (const source of snapshot.sources) {
      if (this.options.getItemVersion(source.itemId) !== source.version) {
        throw new Error(
          "The selected class ideas changed after they were shared. Read the selection again before staging a map.",
        );
      }
    }
    return snapshot.sources.map((source) => {
      const bounds = this.options.getItemBounds(source.itemId);
      if (!bounds) throw new Error("One of the selected class ideas is no longer on the canvas.");
      return { alias: source.alias, bounds };
    });
  }

  private confirmPreview(
    proposal: CollectiveInquiryProposal,
    contributionCount: number,
    itemCount: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    return awaitDialogDecision(this.previewDialog, signal, () =>
      this.renderPreview(proposal, contributionCount, itemCount),
    );
  }

  private renderPreview(
    proposal: CollectiveInquiryProposal,
    contributionCount: number,
    itemCount: number,
  ): void {
    const title = this.previewDialog.querySelector<HTMLElement>("[data-inquiry-preview-title]");
    if (title) title.textContent = proposal.mapTitle;
    const meta = this.previewDialog.querySelector<HTMLElement>("[data-inquiry-preview-meta]");
    if (meta) {
      meta.textContent = `${proposal.themes.length} themes · ${contributionCount} selected contributions · ${itemCount} new canvas objects`;
    }
    const themes = this.previewDialog.querySelector<HTMLElement>("[data-inquiry-preview-themes]");
    if (themes) {
      themes.replaceChildren(
        ...proposal.themes.map((theme, index) => {
          const card = document.createElement("article");
          card.className = "inquiry-preview-theme";
          card.dataset.colour = String(index + 1);
          const heading = document.createElement("h3");
          heading.textContent = theme.label;
          const summary = document.createElement("p");
          summary.textContent = theme.summary;
          const aliases = document.createElement("small");
          aliases.textContent = theme.ideaAliases.join(" · ").replaceAll("_", " ");
          card.append(heading, summary, aliases);
          return card;
        }),
      );
    }
    const bridges = this.previewDialog.querySelector<HTMLElement>("[data-inquiry-preview-bridges]");
    if (bridges) {
      bridges.replaceChildren(
        ...proposal.bridges.map((bridge) => {
          const row = document.createElement("li");
          const from = proposal.themes.find((theme) => theme.id === bridge.fromThemeId)?.label;
          const to = proposal.themes.find((theme) => theme.id === bridge.toThemeId)?.label;
          row.textContent = `${from ?? bridge.fromThemeId} ↔ ${to ?? bridge.toThemeId}: ${bridge.insight}`;
          return row;
        }),
      );
    }
    const tension = this.previewDialog.querySelector<HTMLElement>("[data-inquiry-preview-tension]");
    if (tension) {
      tension.textContent = `${proposal.tension.statement} Next question: ${proposal.tension.nextQuestion}`;
    }
  }

  private buildPreviewDialog(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog webmcp-dialog inquiry-preview-dialog";
    dialog.dataset.testid = "inquiry-preview-dialog";
    dialog.setAttribute("aria-labelledby", "inquiry-preview-heading");
    dialog.innerHTML = `
      <form method="dialog">
        <div class="inquiry-preview-topline"><span class="webmcp-dialog-mark" aria-hidden="true">↗</span><span class="inquiry-preview-state">Proposal · no changes yet</span></div>
        <span class="eyebrow">Review before adding</span>
        <h2 id="inquiry-preview-heading">Add this map to the class canvas?</h2>
        <div class="inquiry-preview-title" data-inquiry-preview-title></div>
        <p class="inquiry-preview-meta" data-inquiry-preview-meta></p>
        <div class="inquiry-preview-themes" data-inquiry-preview-themes></div>
        <section class="inquiry-preview-section"><strong>Bridges across the class</strong><ul data-inquiry-preview-bridges></ul></section>
        <section class="inquiry-preview-tension"><strong>Productive tension</strong><p data-inquiry-preview-tension></p></section>
        <div class="webmcp-privacy-note"><span aria-hidden="true">↶</span><span>Approval adds ordinary board objects in one shared update. You can undo the whole map.</span></div>
        <div class="dialog-actions">
          <button type="submit" value="cancel">Keep canvas unchanged</button>
          <button class="primary-button webmcp-primary-button" type="submit" value="apply">Add map for the class</button>
        </div>
      </form>
    `;
    return dialog;
  }
}

function buildBatch(
  proposal: CollectiveInquiryProposal,
  sources: readonly InquirySource[],
): CollectiveInquiryBatch {
  try {
    return buildCollectiveInquiryMap(proposal, sources);
  } catch (error) {
    if (error instanceof CollectiveInquiryError) throw error;
    throw new Error("SpaceScale could not lay out that inquiry map safely.");
  }
}

function parseProposal(input: unknown): CollectiveInquiryProposal {
  if (!isRecord(input)) throw new Error("The inquiry proposal must be an object.");
  const selectionToken = requiredText(input.selectionToken, "selectionToken", 100);
  const mapTitle = requiredText(input.mapTitle, "mapTitle", 100);
  if (!Array.isArray(input.themes) || input.themes.length < 2 || input.themes.length > 4) {
    throw new Error("themes must contain two to four entries.");
  }
  const themes = input.themes.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`themes[${index}] must be an object.`);
    const id = requiredText(entry.id, `themes[${index}].id`, 32);
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(id)) {
      throw new Error(`themes[${index}].id must be a short lowercase identifier.`);
    }
    if (!Array.isArray(entry.ideaAliases) || entry.ideaAliases.length === 0) {
      throw new Error(`themes[${index}].ideaAliases must name at least one selected contribution.`);
    }
    const ideaAliases = entry.ideaAliases.map((alias, aliasIndex) =>
      requiredText(alias, `themes[${index}].ideaAliases[${aliasIndex}]`, 30),
    );
    return {
      id,
      label: requiredText(entry.label, `themes[${index}].label`, 60),
      summary: requiredText(entry.summary, `themes[${index}].summary`, 400),
      ideaAliases,
    };
  });
  const themeIds = new Set(themes.map((theme) => theme.id));
  if (themeIds.size !== themes.length) throw new Error("Every theme must have a unique id.");
  if (!Array.isArray(input.bridges) || input.bridges.length > 3) {
    throw new Error("bridges must be an array with at most three entries.");
  }
  const bridges = input.bridges.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`bridges[${index}] must be an object.`);
    const fromThemeId = requiredText(entry.fromThemeId, `bridges[${index}].fromThemeId`, 32);
    const toThemeId = requiredText(entry.toThemeId, `bridges[${index}].toThemeId`, 32);
    if (!themeIds.has(fromThemeId) || !themeIds.has(toThemeId) || fromThemeId === toThemeId) {
      throw new Error(`bridges[${index}] must connect two different proposed themes.`);
    }
    return {
      fromThemeId,
      toThemeId,
      insight: requiredText(entry.insight, `bridges[${index}].insight`, 260),
    };
  });
  if (!isRecord(input.tension)) throw new Error("tension must be an object.");
  return {
    selectionToken,
    mapTitle,
    themes,
    bridges,
    tension: {
      statement: requiredText(input.tension.statement, "tension.statement", 320),
      nextQuestion: requiredText(input.tension.nextQuestion, "tension.nextQuestion", 240),
    },
  };
}

import "./class-decision.css";

import {
  buildClassDecision,
  type ClassDecisionProposal,
  type DecisionVoteOption,
} from "../activities/class-decision";
import { isVoteTable, summarizeVotes } from "../activities/voting";
import type { Bounds } from "../board/model";
import type { BoardItem, DurableOperation } from "../types";
import {
  awaitDialogDecision,
  isRecord,
  registerWebMcpTool,
  requiredText,
  trimSnapshots,
  WEBMCP_MATHJAX_GUIDANCE,
} from "./shared";

const READ_VOTE_TOOL = "read_live_class_vote";
const STAGE_DECISION_TOOL = "stage_class_decision";
const MAX_VOTE_SNAPSHOTS = 10;

type VoteSnapshot = {
  token: string;
  tableId: string;
  options: DecisionVoteOption[];
  totalVotes: number;
  capturedAt: string;
};

export type ClassDecisionWebMcpOptions = {
  root: HTMLElement;
  canWrite: () => boolean;
  getSelectedItems: () => BoardItem[] | null;
  getItem: (itemId: string) => BoardItem | undefined;
  getItems: () => Iterable<BoardItem>;
  getItemBounds: (itemId: string) => Bounds | undefined;
  commit: (operation: DurableOperation) => Promise<boolean>;
  selectItems: (itemIds: readonly string[]) => void;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

export class ClassDecisionWebMcp {
  private readonly previewDialog: HTMLDialogElement;
  private readonly snapshots = new Map<string, VoteSnapshot>();
  private readonly registration = new AbortController();

  constructor(private readonly options: ClassDecisionWebMcpOptions) {
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
          name: READ_VOTE_TOOL,
          description:
            "Read the aggregate live result from the one saved SpaceScale vote table selected in this browser. Returns option labels and counts only—never voter identities, stamp IDs, student names, or inferred consensus. Use after the class has responded to an inquiry map.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
          },
          execute: async (_input, { signal }) => {
            signal.throwIfAborted();
            return this.readVote();
          },
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: STAGE_DECISION_TOOL,
          description: `Stage a class decision from a live SpaceScale vote result. Propose a chosen direction, rationale, small pilot, success measure, an explicit minority concern that must remain visible, and the next open question. SpaceScale shows a preview and changes nothing until the participant approves in the app. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: [
              "voteToken",
              "decisionTitle",
              "chosenOption",
              "rationale",
              "minorityConcern",
              "pilotAction",
              "successMeasure",
              "nextQuestion",
            ],
            properties: {
              voteToken: { type: "string" },
              decisionTitle: { type: "string", minLength: 3, maxLength: 100 },
              chosenOption: { type: "string", minLength: 1, maxLength: 500 },
              rationale: { type: "string", minLength: 10, maxLength: 450 },
              minorityConcern: { type: "string", minLength: 10, maxLength: 400 },
              pilotAction: { type: "string", minLength: 10, maxLength: 400 },
              successMeasure: { type: "string", minLength: 5, maxLength: 280 },
              nextQuestion: { type: "string", minLength: 10, maxLength: 280 },
            },
          },
          annotations: {
            readOnlyHint: false,
          },
          execute: async (input, { signal }) => this.stageDecision(input, signal),
        },
        { signal: this.registration.signal },
      );
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The class-decision tools could not be registered.", "warning");
    }
  }

  private readVote(): Record<string, unknown> {
    const selected = this.options.getSelectedItems();
    if (selected === null) throw new Error("Wait for the selected vote table to finish saving.");
    if (selected.length !== 1 || !selected[0] || !isVoteTable(selected[0])) {
      throw new Error("Select exactly one saved ‘Vote with stamps’ table first.");
    }
    const summary = summarizeVotes(selected[0], this.options.getItems());
    if (!summary) throw new Error("The selected table is not a live SpaceScale vote.");
    const options = summary.options.map(({ label, count }) => ({ label, count }));
    const totalVotes = options.reduce((total, option) => total + option.count, 0);
    const highest = Math.max(0, ...options.map((option) => option.count));
    const leadingOptions = options
      .filter((option) => option.count === highest && highest > 0)
      .map((option) => option.label);
    const token = crypto.randomUUID();
    const snapshot: VoteSnapshot = {
      token,
      tableId: selected[0].id,
      options,
      totalVotes,
      capturedAt: new Date().toISOString(),
    };
    this.snapshots.set(token, snapshot);
    trimSnapshots(this.snapshots, MAX_VOTE_SNAPSHOTS);
    this.options.notify(
      `Shared aggregate class response: ${totalVotes} current vote${totalVotes === 1 ? "" : "s"}, no identities.`,
      "info",
    );
    return {
      voteToken: token,
      capturedAt: snapshot.capturedAt,
      options,
      totalVotes,
      leadingOptions,
      tie: leadingOptions.length > 1,
      guidance:
        "Treat the vote as input to a class decision, not proof of consensus. Preserve a concrete minority concern and keep the next question open.",
      privacy:
        "Aggregate counts only. No voter names, actor IDs, stamp IDs, or holdout identities.",
    };
  }

  private async stageDecision(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!this.options.canWrite())
      throw new Error("This browser needs board edit access to stage a class decision.");
    const parsed = parseDecision(input);
    const snapshot = this.snapshots.get(parsed.voteToken);
    if (!snapshot)
      throw new Error("That vote token has expired. Read the selected live vote again.");
    if (!snapshot.options.some((option) => option.label === parsed.proposal.chosenOption)) {
      throw new Error("chosenOption must exactly match an option in the live class vote.");
    }
    this.liveVoteBounds(snapshot);
    const approved = await this.confirmPreview(parsed.proposal, snapshot, signal);
    if (!approved) {
      return {
        status: "participant_declined",
        changedCanvas: false,
        message: "The participant kept the shared class canvas unchanged.",
      };
    }
    signal.throwIfAborted();
    // The vote may have moved while the preview was open; only commit a
    // decision built from the counts the participant actually approved.
    const bounds = this.liveVoteBounds(snapshot);
    const batch = buildClassDecision(parsed.proposal, snapshot.options, bounds);
    const accepted = await this.options.commit(batch.operation);
    if (!accepted) throw new Error("The class decision was approved but could not be queued.");
    this.options.selectItems(batch.itemIds);
    this.options.notify(
      "Class decision added with the minority concern and next question intact.",
      "info",
    );
    return {
      status: "participant_approved_and_added",
      changedCanvas: true,
      createdItemCount: batch.itemIds.length,
      totalVotes: snapshot.totalVotes,
      chosenOption: parsed.proposal.chosenOption,
      dissentPreserved: true,
      message: "The decision record was added as one normal SpaceScale batch and remains undoable.",
    };
  }

  /** Throws unless the live vote still matches the snapshot; returns the table bounds. */
  private liveVoteBounds(snapshot: VoteSnapshot): Bounds {
    const table = this.options.getItem(snapshot.tableId);
    const current = table ? summarizeVotes(table, this.options.getItems()) : null;
    if (!current || !sameCounts(snapshot.options, current.options)) {
      throw new Error(
        "The class vote changed. Read the live result again before staging a decision.",
      );
    }
    const bounds = this.options.getItemBounds(snapshot.tableId);
    if (!bounds) throw new Error("The selected vote table is no longer on the canvas.");
    return bounds;
  }

  private confirmPreview(
    proposal: ClassDecisionProposal,
    snapshot: VoteSnapshot,
    signal: AbortSignal,
  ): Promise<boolean> {
    return awaitDialogDecision(this.previewDialog, signal, () =>
      this.renderPreview(proposal, snapshot),
    );
  }

  private renderPreview(proposal: ClassDecisionProposal, snapshot: VoteSnapshot): void {
    setText(this.previewDialog, "[data-decision-title]", proposal.decisionTitle);
    setText(this.previewDialog, "[data-decision-choice]", proposal.chosenOption);
    setText(this.previewDialog, "[data-decision-rationale]", proposal.rationale);
    setText(this.previewDialog, "[data-decision-minority]", proposal.minorityConcern);
    setText(this.previewDialog, "[data-decision-pilot]", proposal.pilotAction);
    setText(this.previewDialog, "[data-decision-measure]", proposal.successMeasure);
    setText(this.previewDialog, "[data-decision-question]", proposal.nextQuestion);
    const voteBars = this.previewDialog.querySelector<HTMLElement>("[data-decision-votes]");
    if (voteBars) {
      const max = Math.max(1, ...snapshot.options.map((option) => option.count));
      voteBars.replaceChildren(
        ...snapshot.options.map((option) => {
          const row = document.createElement("div");
          row.className = "decision-vote-row";
          const label = document.createElement("span");
          label.textContent = option.label;
          const track = document.createElement("i");
          const fill = document.createElement("b");
          fill.style.width = `${Math.round((option.count / max) * 100)}%`;
          track.append(fill);
          const count = document.createElement("strong");
          count.textContent = String(option.count);
          row.append(label, track, count);
          return row;
        }),
      );
    }
  }

  private buildPreviewDialog(): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "claim-dialog webmcp-dialog decision-preview-dialog";
    dialog.dataset.testid = "decision-preview-dialog";
    dialog.setAttribute("aria-labelledby", "decision-preview-heading");
    dialog.innerHTML = `
      <form method="dialog">
        <div class="inquiry-preview-topline"><span class="webmcp-dialog-mark" aria-hidden="true">↗</span><span class="inquiry-preview-state">Proposal · no changes yet</span></div>
        <span class="eyebrow">Second collaboration loop · review</span>
        <h2 id="decision-preview-heading">Turn the class response into a decision?</h2>
        <div class="inquiry-preview-title" data-decision-title></div>
        <div class="decision-votes" data-decision-votes></div>
        <div class="decision-preview-grid">
          <section class="decision-card decision-card-choice"><strong>Class choice</strong><h3 data-decision-choice></h3><p data-decision-rationale></p></section>
          <section class="decision-card decision-card-minority"><strong>Dissent we will not erase</strong><p data-decision-minority></p></section>
          <section class="decision-card decision-card-pilot"><strong>Small pilot</strong><p data-decision-pilot></p><small>We will look for</small><p data-decision-measure></p></section>
          <section class="decision-card decision-card-question"><strong>Keep the inquiry open</strong><p data-decision-question></p></section>
        </div>
        <div class="webmcp-privacy-note"><span aria-hidden="true">◎</span><span>The vote informs this proposal; it does not erase disagreement or claim unanimous consensus.</span></div>
        <div class="dialog-actions">
          <button type="submit" value="cancel">Keep canvas unchanged</button>
          <button class="primary-button webmcp-primary-button" type="submit" value="apply">Add decision for the class</button>
        </div>
      </form>
    `;
    return dialog;
  }
}

function parseDecision(input: unknown): { voteToken: string; proposal: ClassDecisionProposal } {
  if (!isRecord(input)) throw new Error("The class decision must be an object.");
  return {
    voteToken: requiredText(input.voteToken, "voteToken", 100),
    proposal: {
      decisionTitle: requiredText(input.decisionTitle, "decisionTitle", 100),
      chosenOption: requiredText(input.chosenOption, "chosenOption", 500),
      rationale: requiredText(input.rationale, "rationale", 450),
      minorityConcern: requiredText(input.minorityConcern, "minorityConcern", 400),
      pilotAction: requiredText(input.pilotAction, "pilotAction", 400),
      successMeasure: requiredText(input.successMeasure, "successMeasure", 280),
      nextQuestion: requiredText(input.nextQuestion, "nextQuestion", 280),
    },
  };
}

function sameCounts(
  saved: readonly DecisionVoteOption[],
  current: readonly DecisionVoteOption[],
): boolean {
  return (
    saved.length === current.length &&
    saved.every(
      (option, index) =>
        option.label === current[index]?.label && option.count === current[index]?.count,
    )
  );
}

function setText(root: ParentNode, selector: string, value: string): void {
  const element = root.querySelector<HTMLElement>(selector);
  if (element) element.textContent = value;
}

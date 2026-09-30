import { COORDINATE_LIMIT } from "@collab/geometry";
import {
  ASSIST_ACTIONS,
  type AssistAction,
  type Assistance,
  type CommentMedia,
  MAX_BATCH_OPERATIONS,
  MAX_IMAGE_ALT_CODE_POINTS,
  MAX_STICKY_TEXT_CODE_POINTS,
} from "@collab/protocol";
import { VIDEO_EMBED_HEIGHT, VIDEO_EMBED_WIDTH, videoEmbedFromText } from "../board/links";
import { itemBounds } from "../board/model";
import {
  buildImageCreateOperation,
  buildStickyCreateOperation,
  type ImageAssetMetadata,
} from "../tools/controller";
import type {
  BatchItemOperation,
  BoardItem,
  DurableOperation,
  NewBoardItem,
  Point,
  TextFontFamily,
} from "../types";
import { createId, roundBoard } from "../types";
import {
  enumValue,
  isRecord,
  registerWebMcpTool,
  requiredText,
  WEBMCP_MATHJAX_GUIDANCE,
} from "./shared";

export const INSERT_COMMENT_TOOL = "insert_comment";
export const INSERT_STICKY_TOOL = "insert_sticky";
export const INSERT_IMAGE_TOOL = "insert_image";
export const INSERT_VIDEO_TOOL = "insert_video";
export const MOVE_STICKIES_TOOL = "move_stickies";

/** Matches the edge's comment limit, counted in code points like the server does. */
const MAX_COMMENT_CODE_POINTS = 2_000;
/**
 * How many comments this page will write outside a watch before it refuses.
 *
 * A watch-targeted comment is already bounded by the watch's own cap, which the target
 * resolution enforces. The location and selection forms have no such anchor, and the board
 * itself only stops at 10,000 comments, so a host that loops or retries could bury a class's
 * work. This is deliberately generous for a lesson and finite for a runaway caller.
 */
const MAX_UNWATCHED_COMMENTS = 50;
/**
 * A generated PNG, JPEG, WebP or GIF arrives as a data URL rather than a link: SpaceScale never
 * fetches an external image. Base64 costs a third over the bytes, and the board's own upload
 * ceiling is 5 MiB, so this bounds the string a host may send before any decoding happens.
 */
const MAX_INLINE_IMAGE_DATA_URL_LENGTH = 7_100_000;

/**
 * Notes one move call may carry. A rearrangement lands as one batch so the class can undo it in
 * one step, and the board refuses a batch larger than this, so the schema says so up front
 * rather than letting a host build a layout the commit will reject.
 */
const MAX_STICKY_MOVES = MAX_BATCH_OPERATIONS;

/** The sticky palette a host may pick from, named rather than given as free-form hex. */
export const STICKY_FILLS = {
  yellow: "#ffe299",
  coral: "#ffafa3",
  lavender: "#d3bdff",
  mint: "#b3efbd",
  sky: "#a8daff",
  slate: "#afbccf",
} as const;

export type StickyFillName = keyof typeof STICKY_FILLS;

/** The board styles a write inherits from this participant when the call does not override them. */
export type BoardWriteStyle = {
  stickyFill: string;
  stickyTextColor: string;
  stickyFontSize: number;
  stickyOpacity: number;
  textColor: string;
  textFontSize: number;
  textFontFamily: TextFontFamily;
  textOpacity: number;
};

/**
 * A step of a live board watch, resolved to something a comment can attach to. The watch
 * deliberately returns no coordinates, so this is how a reply plan names its target without one.
 */
export type WatchedStepTarget = {
  itemId: string;
  action?: AssistAction;
  /** Must be called exactly once; `posted` counts the comment against the watch's cap. */
  release: (posted: boolean) => void;
};

/** One note the board has been asked to move, with how far it should travel. */
export type StickyMove = {
  item: BoardItem;
  delta: { x: number; y: number };
};

export type BoardWriteWebMcpOptions = {
  /** Whether this browser's participant may add objects to the board. */
  canWrite: () => boolean;
  /** Whether this browser's participant may post object comments. */
  canComment: () => boolean;
  /** Whether this Space allows image cards at all. */
  imagesEnabled: () => boolean;
  /** Why this Space cannot take an object of this kind, or null when it can. */
  featureIssue: (kind: "sticky" | "image" | "video") => string | null;
  /** The board styles this participant is currently drawing with. */
  getStyle: () => BoardWriteStyle;
  /** Board coordinates a write lands on when the call names no location. */
  getPlacementCenter: () => Point;
  /** The topmost saved object covering a board point, for a comment that names a location. */
  itemAt: (point: Point) => BoardItem | undefined;
  /** The one saved object selected in this browser, when exactly one is. */
  getSelectedItem: () => BoardItem | null;
  /** Resolves a live watch's step alias to a comment target, or throws saying why it cannot. */
  resolveWatchedStep?: (
    watchToken: string,
    stepAlias: string,
    action?: AssistAction,
  ) => WatchedStepTarget;
  /**
   * Resolves a live watch's step aliases to the saved objects behind them, keyed by alias, or
   * throws saying why it cannot. A watch reports no coordinates, so this is how a rearrangement
   * names the notes it moves.
   */
  resolveWatchedStickies?: (
    watchToken: string,
    stepAliases: readonly string[],
  ) => Map<string, BoardItem>;
  /**
   * Translates saved objects as one AI-attributed batch, or throws saying why it cannot. The
   * board owns Section membership and grouping, so this hands over the notes and their deltas
   * rather than the operations themselves.
   */
  moveItems?: (moves: readonly StickyMove[]) => Promise<void>;
  commit: (operation: DurableOperation) => Promise<boolean>;
  /** Posts a comment as this browser's participant, tagged with the writing tool. */
  createComment: (
    itemId: string,
    body: string,
    assistance: Assistance,
    media?: CommentMedia,
  ) => Promise<void>;
  /** Sanitizes and privately stores one inline image, returning what an image card needs. */
  storeImage: (imageDataUrl: string, signal: AbortSignal) => Promise<ImageAssetMetadata>;
  /** Selects what was just written, as the board's own insert paths do. */
  revealItems: (itemIds: readonly string[]) => void;
  notify: (message: string, kind: "info" | "warning" | "error") => void;
};

const LOCATION_SCHEMA = {
  type: "object",
  description:
    "Where on the board to write, in board coordinates. Omit to land at the centre of this participant's current view.",
  properties: {
    x: { type: "number", minimum: -COORDINATE_LIMIT, maximum: COORDINATE_LIMIT },
    y: { type: "number", minimum: -COORDINATE_LIMIT, maximum: COORDINATE_LIMIT },
  },
  required: ["x", "y"],
  additionalProperties: false,
} as const;

/**
 * The board's generic write surface: one object of one kind per call, placed where the caller
 * asks. Each write goes in as one ordinary realtime command, tagged as written by AI, with the
 * same undo, section membership, and permission checks a participant's own insert gets. The
 * caller's WebMCP permission is the approval; there is no separate preview to accept.
 */
export class BoardWriteWebMcp {
  private readonly registration = new AbortController();
  /** Comments written through the location and selection forms in this page's lifetime. */
  private unwatchedComments = 0;
  /** One comment at a time, so concurrent calls cannot race past the cap together. */
  private commentInFlight = false;

  constructor(private readonly options: BoardWriteWebMcpOptions) {
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
          name: INSERT_COMMENT_TOOL,
          description: `Post one comment on a saved object on this board. Name the object in one of three ways: pass watchToken and stepAlias to comment on a step of a live board watch, which is what a watch's reply plan asks for and the only way to answer a request the watch delivered; or pass location, a board coordinate the object covers; or pass neither, which comments on the one object selected in this browser. A comment may also carry one picture or one video, the same material insert_image and insert_video place on the canvas: pass imageDataUrl with alt for a picture, or videoUrl for a public YouTube or Vimeo link, never both. Use a comment when the material belongs to the work someone is already looking at, and insert_image or insert_video when it belongs on the canvas itself. The comment is attributed to this browser's participant, carries a small AI tag, renders MathJax, is limited to ${MAX_COMMENT_CODE_POINTS} characters, and can be resolved by the class like any other comment. A comment on a watched step counts against that watch's own cap; the location and selection forms are limited to ${MAX_UNWATCHED_COMMENTS} per page, and each result reports how many are left. Never grade, label, rank, or profile a participant. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            properties: {
              watchToken: {
                type: "string",
                maxLength: 128,
                description:
                  "Opaque token from watch_board, to comment on a step that watch reported. Pass stepAlias with it.",
              },
              stepAlias: {
                type: "string",
                pattern: "^step_(?:[1-9][0-9]{0,3}|10000)$",
                description: "The step_N alias of the watched step to comment on.",
              },
              action: {
                type: "string",
                enum: [...ASSIST_ACTIONS],
                description:
                  "The participant action this comment answers, copied from the reply plan. Omit for feedback on a changed step. Pass it whenever the plan names one: another request may have queued on the step since, and only this tells the board which one is being answered.",
              },
              location: LOCATION_SCHEMA,
              body: {
                type: "string",
                minLength: 1,
                maxLength: MAX_COMMENT_CODE_POINTS,
                description: "The comment. Plain text with optional TeX; no HTML.",
              },
              imageDataUrl: {
                type: "string",
                maxLength: MAX_INLINE_IMAGE_DATA_URL_LENGTH,
                description:
                  "A picture to show under the comment, as a PNG, JPEG, WebP or GIF data URL. External URLs are refused, and the picture is sanitized and stored in this board's own bucket. Pass alt with it. Needs board edit access, like an image card.",
              },
              alt: {
                type: "string",
                minLength: 1,
                maxLength: MAX_IMAGE_ALT_CODE_POINTS,
                description:
                  "What the picture shows, for participants who cannot see it. Required with imageDataUrl.",
              },
              videoUrl: {
                type: "string",
                maxLength: 2_048,
                description:
                  "A complete HTTPS YouTube or Vimeo link to show under the comment, played through a privacy-conscious embed when a participant chooses to.",
              },
            },
            required: ["body"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: (input, { signal }) => this.insertComment(input, signal),
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: INSERT_STICKY_TOOL,
          description: `Add one sticky note to this board at a location you choose. Pass the note's text and, optionally, a fill colour from the board's sticky palette. Text is limited to ${MAX_STICKY_TEXT_CODE_POINTS} characters and may be left empty for a participant to complete. The note lands as one ordinary realtime command, tagged as written by AI, with ordinary undo. ${WEBMCP_MATHJAX_GUIDANCE}`,
          inputSchema: {
            type: "object",
            properties: {
              location: LOCATION_SCHEMA,
              text: {
                type: "string",
                maxLength: MAX_STICKY_TEXT_CODE_POINTS,
                description:
                  "The note's text. Plain text with optional TeX; no HTML. Empty leaves the note blank for a participant to fill in.",
              },
              fill: {
                type: "string",
                enum: Object.keys(STICKY_FILLS),
                description:
                  "A colour from the board's sticky palette. Omit to use this participant's current sticky colour.",
              },
            },
            required: ["text"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: (input, { signal }) => this.insertSticky(input, signal),
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: INSERT_IMAGE_TOOL,
          description:
            "Add one image card to this board at a location you choose. Supply the picture itself as a PNG, JPEG, WebP or GIF data URL; SpaceScale never fetches an external image URL, and sanitizes and privately stores what you send in this board's own bucket. Give alt text describing what the picture shows. The card lands as one ordinary realtime command, tagged as written by AI, with ordinary undo. Never depict a real participant or target an individual.",
          inputSchema: {
            type: "object",
            properties: {
              location: LOCATION_SCHEMA,
              imageDataUrl: {
                type: "string",
                maxLength: MAX_INLINE_IMAGE_DATA_URL_LENGTH,
                description:
                  "The picture as a data URL, for example data:image/png;base64,.... External URLs are refused.",
              },
              alt: {
                type: "string",
                minLength: 1,
                maxLength: MAX_IMAGE_ALT_CODE_POINTS,
                description: "What the picture shows, for participants who cannot see it.",
              },
            },
            required: ["imageDataUrl", "alt"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: (input, { signal }) => this.insertImage(input, signal),
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: INSERT_VIDEO_TOOL,
          description:
            "Embed one YouTube or Vimeo video on this board at a location you choose. Pass the complete HTTPS video link; SpaceScale plays it through a privacy-conscious embed. Only link a video you are confident exists and is appropriate for the class. The embed lands as one ordinary realtime command, tagged as written by AI, with ordinary undo.",
          inputSchema: {
            type: "object",
            properties: {
              location: LOCATION_SCHEMA,
              url: {
                type: "string",
                maxLength: 2_048,
                description: "A complete HTTPS YouTube or Vimeo video link.",
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: (input, { signal }) => this.insertVideo(input, signal),
        },
        { signal: this.registration.signal },
      );
      await registerWebMcpTool(
        modelContext,
        {
          name: MOVE_STICKIES_TOOL,
          description: `Move sticky notes that are already on this board, so notes carrying the same idea can be gathered together. Pass one entry per note in moves, up to ${MAX_STICKY_MOVES} at a time. Name each note either by stepAlias, an alias a live board watch reported, alongside that watch's watchToken; or by at, a board coordinate the note covers. Then say where it goes: to, the board coordinate its centre should land on, or by, how far to shift it in board pixels. The whole rearrangement lands as one realtime batch, so the class can put the board back with a single undo. Moving a note does not change whose note it is, and does not mark it as AI-written: this is the same edit a participant makes by dragging it. Only sticky notes move. A note that lands inside a Section joins it and one that leaves loses it, and a note grouped with other objects carries its group along, which can make the batch larger than the notes you named. Notes the board moves as one unit — grouped together, or sitting in a Section another named note carries — must be given the same shift, and a note asked to stay put counts as a different shift; sending them to different places is refused rather than pulling that unit apart. Name one of them and let the rest follow, or give them all the same shift. The result reports where each note started and where it now sits; nothing else on this board reports coordinates, so build an absolute layout in a region you choose rather than assuming what already occupies it. Never arrange notes so as to rank, grade, or single out a participant.`,
          inputSchema: {
            type: "object",
            properties: {
              watchToken: {
                type: "string",
                maxLength: 128,
                description:
                  "Opaque token from watch_board, required when any entry names its note by stepAlias.",
              },
              moves: {
                type: "array",
                minItems: 1,
                maxItems: MAX_STICKY_MOVES,
                description: "One entry per sticky note to move.",
                items: {
                  type: "object",
                  properties: {
                    stepAlias: {
                      type: "string",
                      pattern: "^step_(?:[1-9][0-9]{0,3}|10000)$",
                      description:
                        "The step_N alias of the note to move, from the watch named by watchToken. Give this or at, not both.",
                    },
                    at: {
                      ...LOCATION_SCHEMA,
                      description:
                        "A board coordinate the note covers, for naming a note without a watch. Give this or stepAlias, not both.",
                    },
                    to: {
                      ...LOCATION_SCHEMA,
                      description:
                        "Where the note's centre should land, in board coordinates. Give this or by, not both.",
                    },
                    by: {
                      ...LOCATION_SCHEMA,
                      description:
                        "How far to shift the note, in board pixels: x is rightwards and y is downwards. Give this or to, not both.",
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
            required: ["moves"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: (input, { signal }) => this.moveStickies(input, signal),
        },
        { signal: this.registration.signal },
      );
    } catch {
      if (this.registration.signal.aborted) return;
      this.options.notify("The board write tools could not be registered.", "warning");
    }
  }

  private async insertComment(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Comment input must be an object.");
    if (typeof input.body !== "string") throw new Error("body must be text.");
    const body = input.body.trim();
    const characters = [...body].length;
    if (characters === 0 || characters > MAX_COMMENT_CODE_POINTS) {
      throw new Error(`body must contain 1-${MAX_COMMENT_CODE_POINTS} characters.`);
    }
    if (!this.options.canComment()) {
      throw new Error("This browser cannot comment on this Space.");
    }
    if (this.commentInFlight) {
      throw new Error("Wait for the previous comment to finish before writing another.");
    }
    // Resolved before a watch step is claimed, so a refused or slow picture cannot hold a
    // reservation the caller never gets to use.
    const media = await this.commentMedia(input, signal);
    signal.throwIfAborted();
    const watched = this.watchedTarget(input);
    signal.throwIfAborted();
    if (watched) {
      // The watch counts this against its own comment cap either way, so release exactly once.
      this.commentInFlight = true;
      try {
        await this.options.createComment(
          watched.target.itemId,
          body,
          {
            tool: INSERT_COMMENT_TOOL,
            ...(watched.target.action === undefined ? {} : { action: watched.target.action }),
          },
          media ?? undefined,
        );
      } catch (error) {
        watched.target.release(false);
        throw error;
      } finally {
        this.commentInFlight = false;
      }
      watched.target.release(true);
      this.options.notify(`The AI assistant commented on ${watched.stepAlias}.`, "info");
      return this.commentResult({
        stepAlias: watched.stepAlias,
        characters,
        ...(media === null ? {} : { media: media.kind }),
      });
    }
    if (this.commentInFlight) {
      throw new Error("Wait for the previous comment to finish before writing another.");
    }
    if (this.unwatchedComments >= MAX_UNWATCHED_COMMENTS) {
      throw new Error(
        `This page has written its limit of ${MAX_UNWATCHED_COMMENTS} AI comments outside a board watch. Comment on a watched step, or ask a participant to reload.`,
      );
    }
    const target = this.commentTarget(input.location);
    this.commentInFlight = true;
    try {
      await this.options.createComment(
        target.id,
        body,
        { tool: INSERT_COMMENT_TOOL },
        media ?? undefined,
      );
    } finally {
      this.commentInFlight = false;
    }
    // Only a comment the board accepted counts, so a refusal cannot spend the budget.
    this.unwatchedComments += 1;
    this.options.notify("The AI assistant added a comment.", "info");
    return this.commentResult({
      objectKind: target.kind,
      characters,
      ...(media === null ? {} : { media: media.kind }),
      remainingUnwatchedComments: MAX_UNWATCHED_COMMENTS - this.unwatchedComments,
    });
  }

  /**
   * The one picture or video this comment will carry, or null when it carries neither. A
   * picture takes the same route an image card's does: never fetched from a URL, sanitized and
   * stored in this board's private bucket, and refused when the Space has images switched off.
   */
  private async commentMedia(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CommentMedia | null> {
    const hasImage = input.imageDataUrl !== undefined;
    const hasVideo = input.videoUrl !== undefined;
    if (hasImage && hasVideo) {
      throw new Error("A comment carries one picture or one video, not both.");
    }
    if (!hasImage && input.alt !== undefined) {
      throw new Error("alt describes imageDataUrl, so pass them together.");
    }
    if (hasVideo) {
      if (typeof input.videoUrl !== "string") throw new Error("videoUrl must be text.");
      const video = videoEmbedFromText(input.videoUrl);
      if (!video) {
        throw new Error("videoUrl must be a complete HTTPS YouTube or Vimeo video link.");
      }
      return { kind: "video", provider: video.provider, url: video.sourceUrl };
    }
    if (!hasImage) return null;
    // A picture is stored on the board itself, so it needs the same access a card does.
    this.requireWritable("image");
    if (!this.options.imagesEnabled()) throw new Error("Images are disabled for this Space.");
    const imageDataUrl = requiredImageDataUrl(input.imageDataUrl);
    const alt = requiredImageAlt(input.alt);
    const asset = await this.options.storeImage(imageDataUrl, signal);
    signal.throwIfAborted();
    // Permission can change while the upload is in flight; the comment is what needs the check.
    this.requireWritable("image");
    if (!this.options.imagesEnabled()) {
      throw new Error("The image was stored, but images were disabled before it could be shown.");
    }
    return {
      kind: "image",
      assetId: asset.assetId,
      mimeType: asset.mimeType,
      intrinsicWidth: asset.intrinsicWidth,
      intrinsicHeight: asset.intrinsicHeight,
      alt,
    };
  }

  private commentResult(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      status: "commented",
      ...extra,
      writtenBy: "ai",
      attribution:
        "The comment shows this browser's participant as its author with a small AI tag, like every AI-written object on the board.",
      privacy:
        "Only the comment text left the conversation. No board, item, or participant identifiers were returned.",
    };
  }

  /**
   * Resolves the watch-step form of a comment target, or undefined when the call does not use
   * it. A watch reports steps by alias and returns no coordinates, so this is the only way to
   * answer a request about a step the participant did not leave selected.
   */
  private watchedTarget(
    input: Record<string, unknown>,
  ): { target: WatchedStepTarget; stepAlias: string } | undefined {
    if (input.watchToken === undefined && input.stepAlias === undefined) return undefined;
    const watchToken = requiredText(input.watchToken, "watchToken", 128);
    const stepAlias = requiredText(input.stepAlias, "stepAlias", 16);
    if (!/^step_(?:[1-9][0-9]{0,3}|10000)$/u.test(stepAlias)) {
      throw new Error("stepAlias must look like step_1.");
    }
    const action =
      input.action === undefined ? undefined : enumValue(input.action, ASSIST_ACTIONS, "action");
    const resolve = this.options.resolveWatchedStep;
    if (!resolve) throw new Error("This browser cannot comment on a watched step.");
    return { target: resolve(watchToken, stepAlias, action), stepAlias };
  }

  /** The object a comment attaches to: the one under the given point, else the lone selection. */
  private commentTarget(location: unknown): BoardItem {
    if (location !== undefined) {
      const point = boardPoint(location);
      const hit = this.options.itemAt(point);
      if (!hit) {
        throw new Error(
          `No saved object covers ${point[0]}, ${point[1]}. Comments attach to an object, so name a location on one.`,
        );
      }
      return hit;
    }
    const selected = this.options.getSelectedItem();
    if (!selected) {
      throw new Error(
        "Name the object to comment on: pass watchToken and stepAlias for a watched step, or a location on it, or select exactly one saved object in this browser first.",
      );
    }
    return selected;
  }

  private async insertSticky(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Sticky input must be an object.");
    this.requireWritable("sticky");
    if (typeof input.text !== "string") throw new Error("text must be text.");
    const text = input.text.trim();
    if ([...text].length > MAX_STICKY_TEXT_CODE_POINTS) {
      throw new Error(`text must contain at most ${MAX_STICKY_TEXT_CODE_POINTS} characters.`);
    }
    const fill = stickyFill(input.fill);
    const style = this.options.getStyle();
    const point = this.placement(input.location);
    const itemId = createId();
    const created = createdItem(
      buildStickyCreateOperation(
        itemId,
        point,
        {
          stickyFill: fill ?? style.stickyFill,
          stickyTextColor: style.stickyTextColor,
          stickyFontSize: style.stickyFontSize,
          stickyOpacity: style.stickyOpacity,
        },
        text,
      ),
      "sticky note",
    );
    await this.write(created, signal, "The sticky note could not be queued for saving.");
    this.options.revealItems([itemId]);
    this.options.notify("Sticky note added.", "info");
    return this.writeResult("sticky", point, { characters: [...text].length });
  }

  private async insertImage(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Image input must be an object.");
    this.requireWritable("image");
    if (!this.options.imagesEnabled()) throw new Error("Image cards are disabled for this Space.");
    const imageDataUrl = requiredImageDataUrl(input.imageDataUrl);
    const alt = requiredImageAlt(input.alt);
    const altCharacters = [...alt].length;
    const point = this.placement(input.location);

    const asset = await this.options.storeImage(imageDataUrl, signal);
    signal.throwIfAborted();
    // Permission can change while the upload is in flight; the card is what needs the check.
    this.requireWritable("image");
    if (!this.options.imagesEnabled()) {
      throw new Error("The image was stored, but image cards were disabled before it could land.");
    }
    const itemId = createId();
    const created = createdItem(buildImageCreateOperation(itemId, point, asset), "image card");
    if (created.kind !== "image") throw new Error("The image card could not be prepared.");
    created.geometry = { ...created.geometry, alt };
    await this.write(created, signal, "The image was stored, but its card could not be queued.");
    this.options.revealItems([itemId]);
    this.options.notify("Image added.", "info");
    return this.writeResult("image", point, { altCharacters });
  }

  private async insertVideo(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Video input must be an object.");
    this.requireWritable("video");
    if (typeof input.url !== "string") throw new Error("url must be text.");
    const video = videoEmbedFromText(input.url);
    if (!video) throw new Error("url must be a complete HTTPS YouTube or Vimeo video link.");
    const style = this.options.getStyle();
    const point = this.placement(input.location);
    const itemId = createId();
    await this.write(
      {
        id: itemId,
        kind: "text",
        style: {
          kind: "text",
          color: style.textColor,
          fontSize: style.textFontSize,
          fontFamily: style.textFontFamily,
          opacity: style.textOpacity,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: roundBoard(point[0] - VIDEO_EMBED_WIDTH / 2),
          y: roundBoard(point[1] - VIDEO_EMBED_HEIGHT / 2 + style.textFontSize),
          text: video.sourceUrl,
          embed: "video",
        },
      },
      signal,
      "The video embed could not be queued for saving.",
    );
    this.options.revealItems([itemId]);
    this.options.notify("Video embedded.", "info");
    return this.writeResult("video", point, { provider: video.provider });
  }

  private async moveStickies(
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (!isRecord(input)) throw new Error("Move input must be an object.");
    this.requireWritable("sticky");
    const apply = this.options.moveItems;
    if (!apply) throw new Error("This browser cannot move objects on this Space.");
    const requests = moveRequests(input.moves);
    const notes = this.moveTargets(input.watchToken, requests);
    signal.throwIfAborted();

    const moves: StickyMove[] = [];
    const report: Array<Record<string, unknown>> = [];
    for (const [index, request] of requests.entries()) {
      const note = notes[index];
      if (!note) throw new Error(`moves[${index}] names no note.`);
      const bounds = itemBounds(note);
      const from = {
        x: roundBoard((bounds.minX + bounds.maxX) / 2),
        y: roundBoard((bounds.minY + bounds.maxY) / 2),
      };
      const delta =
        request.by === undefined
          ? { x: roundBoard(request.to[0] - from.x), y: roundBoard(request.to[1] - from.y) }
          : { x: request.by[0], y: request.by[1] };
      moves.push({ item: note, delta });
      report.push({
        ...(request.stepAlias === undefined ? {} : { stepAlias: request.stepAlias }),
        from,
        to: { x: roundBoard(from.x + delta.x), y: roundBoard(from.y + delta.y) },
        by: { x: delta.x, y: delta.y },
      });
    }

    const moved = moves.filter((move) => move.delta.x !== 0 || move.delta.y !== 0);
    if (moved.length === 0) {
      return {
        status: "unchanged",
        movedCount: 0,
        notes: report,
        changedCanvas: false,
        message: "Every note named is already where the move asked for, so nothing was written.",
      };
    }
    // Cancellation is checked before the batch is sent, never after the board acknowledged it:
    // reporting a failure the board accepted would have a caller retry a relative shift and move
    // every note a second time.
    signal.throwIfAborted();
    // The whole list goes over, the notes asked to stay put included. The board carries grouped
    // objects and a Section's members along with a move, so a note left out of this call is one
    // it could pick up and move despite this result saying it did not budge.
    await apply(moves);
    this.options.revealItems(moved.map((move) => move.item.id));
    this.options.notify(
      moved.length === 1 ? "Sticky note moved." : `${moved.length} sticky notes moved.`,
      "info",
    );
    return {
      status: "moved",
      movedCount: moved.length,
      notes: report,
      changedCanvas: true,
      undoable: true,
      message:
        "Moved as one acknowledged realtime batch, reversed by a single undo from any participant. The notes keep their own authors and are not marked as AI-written; only their positions changed.",
      privacy:
        "Only the aliases you supplied and the coordinates the notes now hold were returned. No board, item, or participant identifiers were returned.",
    };
  }

  /**
   * The notes each move entry names, in the order they were asked for. Aliases resolve through
   * the watch in one call so a partly-valid list fails before anything is written, and a note
   * named twice is refused rather than moved twice over.
   */
  private moveTargets(watchToken: unknown, requests: readonly MoveRequest[]): BoardItem[] {
    const aliases = requests.flatMap((request) =>
      request.stepAlias === undefined ? [] : [request.stepAlias],
    );
    let watched = new Map<string, BoardItem>();
    if (aliases.length > 0) {
      // The caller's own mistake is reported before a capability it cannot do anything about.
      const token = requiredText(watchToken, "watchToken", 128);
      const resolve = this.options.resolveWatchedStickies;
      if (!resolve) throw new Error("This browser cannot move a watched note.");
      watched = resolve(token, [...new Set(aliases)]);
    } else if (watchToken !== undefined) {
      throw new Error("watchToken names the watch a stepAlias came from, so pass them together.");
    }

    const notes: BoardItem[] = [];
    const seen = new Map<string, number>();
    for (const [index, request] of requests.entries()) {
      const note =
        request.stepAlias === undefined
          ? this.options.itemAt(request.at)
          : watched.get(request.stepAlias);
      if (!note) {
        throw new Error(
          request.stepAlias === undefined
            ? `No saved object covers ${request.at[0]}, ${request.at[1]}. Name a point on the note you want to move.`
            : `${request.stepAlias} is not part of this watch.`,
        );
      }
      if (note.kind !== "sticky") {
        throw new Error(
          `moves[${index}] names a ${note.kind}, and this tool moves sticky notes only.`,
        );
      }
      const first = seen.get(note.id);
      if (first !== undefined) {
        throw new Error(
          `moves[${index}] names the same note as moves[${first}]. Give each note one destination.`,
        );
      }
      seen.set(note.id, index);
      notes.push(note);
    }
    return notes;
  }

  private requireWritable(kind: "sticky" | "image" | "video"): void {
    if (!this.options.canWrite()) {
      throw new Error("This browser needs board edit access to write to this Space.");
    }
    const issue = this.options.featureIssue(kind);
    if (issue) throw new Error(issue);
  }

  /** Sends one create as an AI-attributed command and waits for the board to acknowledge it. */
  private async write(item: NewBoardItem, signal: AbortSignal, failure: string): Promise<void> {
    signal.throwIfAborted();
    const accepted = await this.options.commit({
      kind: "item.create",
      item: { ...item, assistedBy: "ai" } as NewBoardItem,
    });
    if (!accepted) throw new Error(failure);
  }

  private placement(location: unknown): Point {
    if (location === undefined) {
      const [x, y] = this.options.getPlacementCenter();
      return [roundBoard(x), roundBoard(y)];
    }
    return boardPoint(location);
  }

  private writeResult(
    objectKind: string,
    point: Point,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      status: "inserted",
      objectKind,
      location: { x: point[0], y: point[1] },
      ...extra,
      changedCanvas: true,
      aiAttributed: true,
      undoable: true,
      message:
        "Added as one acknowledged realtime command, tagged as written by AI, and undoable by any participant.",
      privacy:
        "Only what you supplied was written to the board. No board, item, or participant identifiers were returned.",
    };
  }
}

/** The inline picture a write may carry: an image data URL this board is willing to store. */
function requiredImageDataUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("imageDataUrl must be text.");
  const imageDataUrl = value.trim();
  if (!imageDataUrl.startsWith("data:image/")) {
    throw new Error(
      "imageDataUrl must be an inline data URL such as data:image/png;base64,.... SpaceScale never fetches an external image.",
    );
  }
  if (imageDataUrl.length > MAX_INLINE_IMAGE_DATA_URL_LENGTH) {
    throw new Error("That image is larger than this board accepts. Send a smaller one.");
  }
  return imageDataUrl;
}

function requiredImageAlt(value: unknown): string {
  if (typeof value !== "string") throw new Error("alt must be text.");
  const alt = value.trim();
  const characters = [...alt].length;
  if (characters === 0 || characters > MAX_IMAGE_ALT_CODE_POINTS) {
    throw new Error(`alt must contain 1-${MAX_IMAGE_ALT_CODE_POINTS} characters.`);
  }
  return alt;
}

function stickyFill(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(value in STICKY_FILLS)) {
    throw new Error(`fill must be one of: ${Object.keys(STICKY_FILLS).join(", ")}.`);
  }
  return STICKY_FILLS[value as StickyFillName];
}

/** One validated entry of a move call: which note, and where it goes. */
type MoveRequest = ({ stepAlias: string; at?: undefined } | { at: Point; stepAlias?: undefined }) &
  ({ to: Point; by?: undefined } | { by: Point; to?: undefined });

function moveRequests(value: unknown): MoveRequest[] {
  if (!Array.isArray(value)) throw new Error("moves must be an array of notes to move.");
  if (value.length === 0) throw new Error("moves must name at least one note.");
  if (value.length > MAX_STICKY_MOVES) {
    throw new Error(`Move ${MAX_STICKY_MOVES} notes or fewer at a time.`);
  }
  return value.map((entry, index) => moveRequest(entry, index));
}

function moveRequest(value: unknown, index: number): MoveRequest {
  if (!isRecord(value)) throw new Error(`moves[${index}] must be an object.`);
  const named = value.stepAlias !== undefined;
  const located = value.at !== undefined;
  if (named === located) {
    throw new Error(
      `moves[${index}] must name its note either by stepAlias or by at, and not by both.`,
    );
  }
  const absolute = value.to !== undefined;
  const relative = value.by !== undefined;
  if (absolute === relative) {
    throw new Error(
      `moves[${index}] must give either to, a destination, or by, a shift, and not both.`,
    );
  }
  const destination = absolute
    ? { to: boardPoint(value.to, `moves[${index}].to`) }
    : { by: boardPoint(value.by, `moves[${index}].by`) };
  if (named) {
    const stepAlias = requiredText(value.stepAlias, `moves[${index}].stepAlias`, 16);
    if (!/^step_(?:[1-9][0-9]{0,3}|10000)$/u.test(stepAlias)) {
      throw new Error(`moves[${index}].stepAlias must look like step_1.`);
    }
    return { stepAlias, ...destination } as MoveRequest;
  }
  return { at: boardPoint(value.at, `moves[${index}].at`), ...destination } as MoveRequest;
}

function boardPoint(value: unknown, field = "location"): Point {
  if (!isRecord(value)) throw new Error(`${field} must be an object with x and y.`);
  return [boardCoordinate(value.x, `${field}.x`), boardCoordinate(value.y, `${field}.y`)];
}

function boardCoordinate(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  if (Math.abs(value) > COORDINATE_LIMIT) {
    throw new Error(`${field} must be between -${COORDINATE_LIMIT} and ${COORDINATE_LIMIT}.`);
  }
  return roundBoard(value);
}

/** Unwraps a create the board's own insert helpers built, so the item can be adjusted and tagged. */
function createdItem(operation: BatchItemOperation, label: string): NewBoardItem {
  if (operation.kind !== "item.create") throw new Error(`The ${label} could not be prepared.`);
  return operation.item;
}

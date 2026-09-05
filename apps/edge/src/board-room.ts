import { DurableObject } from "cloudflare:workers";
import {
  canonicalSnapshotByteLengthFromParts,
  canonicalSnapshotItemByteLength,
  findMoveCopyClosureLimitViolation,
} from "@collab/board-core";
import {
  ASSIST_ACTIONS,
  ASSISTANCE_TOOL_PATTERN,
  type AssistAction,
  type Assistance,
  BOARD_FEATURE_KEYS,
  type BoardFeatures,
  type ClientFrame,
  type CommentImageMedia,
  type CommentMedia,
  CommentMediaError,
  canonicalRequestHashInput,
  DEFAULT_BOARD_FEATURES,
  MAX_BATCH_OPERATIONS,
  MAX_COMMENT_MEDIA_JSON_LENGTH,
  MAX_SNAPSHOT_BYTES,
  normalizeBoardFeatures,
  normalizeCommentMedia,
  type BoardItem as ProtocolBoardItem,
  ProtocolValidationError,
  parseClientFrame,
} from "@collab/protocol";
import { appendSectionExportSummaries, buildSectionExportSummaries } from "./board-export";
import { normalizePersistedBoardFeatures } from "./board-features";
import { decodeClassroomBoardImport, MAX_CLASSROOM_IMPORT_ENCODED_CHARS } from "./classroom-import";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  hmacSha256,
  randomOpaqueId,
  randomToken,
  sha256,
  sha256Base64Url,
  stableStringify,
  utf8,
} from "./crypto";
import {
  affectedIds,
  BoardDomainError,
  type ItemRecord,
  itemWriteFromState,
  MAX_ACTION_PAYLOAD_BYTES,
  MAX_PUBLIC_RESULT_BYTES,
  type ParsedCommit,
  parseCommitFrame,
} from "./domain";
import { assertExactKeys, isRecord, readBoundedBytes, readJsonBody } from "./http/body";
import { errorResponse, HttpError } from "./http/errors";
import {
  INTERNAL_ACTOR_HEADER,
  INTERNAL_EXPIRY_HEADER,
  INTERNAL_REQUEST_ID_HEADER,
} from "./http/security";
import {
  type ImageAssetMimeType,
  MAX_IMAGE_ASSET_BYTES,
  MAX_IMAGE_ASSET_BYTES_PER_BOARD,
  MAX_IMAGE_ASSETS_PER_BOARD,
  parseImageAsset,
  requireImageAssetMimeType,
} from "./image-assets";
import {
  assertGroupMembershipOwnership,
  assertItemsOutsideLockedSections,
  assertItemsOwnedByActor,
  type ItemOwnershipContext,
  prepareOwnedItemOperation,
  sectionRecordIdsForItems,
  sectionRecordIdsForMutation,
} from "./item-ownership";
import { safeLog } from "./logging";
import { applyMigrations } from "./migrations";
import { OrganisationAuthService } from "./organisation-auth";
import {
  MAX_ORGANISATION_TEMPLATE_BYTES,
  normalizeOrganisationWebhookUrl,
  ORGANISATION_ID_PATTERN,
  type OrganisationRoom,
  type OrganisationWebhookSettings,
} from "./organisation-room";
import { TokenBucket } from "./rate-limit";
import {
  backfillSnapshotAccounting,
  captureSnapshot,
  type ItemSqlRow,
  itemRecordFromRow,
  parseStoredSnapshot,
  readAllItemRecords,
  readBoard,
  readItem,
  readItems,
  readLiveItems,
  resolveAccess,
  serializeSnapshot,
  snapshotAccountingForItems,
  snapshotCreatedAt,
  utcUsageDay,
  writeItem,
  writeLogicalState,
} from "./storage";
import {
  getR2Object,
  mapSqliteFullError,
  putImmutableR2Object,
  readR2ObjectBytes,
} from "./storage-boundaries";
import { serializeAuthoritativeSvg } from "./svg";
import { type DurableObjectTelemetryContext, durableObjectTelemetryContext } from "./telemetry";
import type {
  BoardItem,
  BoardRole,
  BoardRow,
  CanonicalSnapshot,
  DrawingPolicy,
  Env,
  InternalActorContext,
  ItemAttributionEffect,
  ItemAttributionState,
  ItemEffect,
  ServerAction,
  SocketAttachment,
  StoredActionPayload,
} from "./types";
import {
  ACTOR_ID_PATTERN,
  BOARD_ID_PATTERN,
  containsDisallowedControlCharacter,
  fallbackDisplayName,
  OPAQUE_ID_PATTERN,
  optionalTitle,
  requireActorId,
  requireDisplayName,
  requireOpaqueId,
  requireSafeInteger,
  validateUnicodeText,
} from "./validation";
import { deliverOrganisationWebhook } from "./webhook-delivery";

const LIMITS = {
  maxConnections: 50,
  maxItems: 10_000,
  maxBatchItems: 100,
  maxStrokePoints: 10_000,
  previewHz: 12,
} as const;
const MAX_COMMENTS = 10_000;
const MAX_COMMENT_CODE_POINTS = 2_000;
// Keeps `IN (?, ...)` lists well inside SQLite's bound-parameter limit.
const COMMENT_UPDATE_CHUNK_SIZE = 100;
const MAX_CONNECTIONS_PER_ACTOR = 5;
const MAX_REPLAY_ACTIONS = 100;
const SNAPSHOT_ACTION_INTERVAL = 250;
const SNAPSHOT_TIME_MS = 60_000;
// `actions` is a rowid table with two secondary indexes; its insert trigger
// also appends one index-free activity row. Keep this invariant covered by the
// focused action-accounting test.
const ACTION_INSERT_BILLED_ROWS = 4;
const MAX_CATCH_UP_ROUNDS = 5;
const MAX_ITEM_IDENTITIES = 50_000;
const ACTION_COMPACTION_TRIGGER = 20_000;
const ACTION_COMPACTION_TARGET = 19_000;
// R2 is a recovery/checkpoint dependency, not the SQLite authority. During a
// prolonged R2 outage, continue writes in a bounded degraded mode instead of
// violating the availability contract at the normal compaction trigger.
const MAX_UNCOMPACTED_ACTIONS = 100_000;
const MIN_REPLAY_RETENTION_ACTIONS = 1_000;
const ACTION_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1_000;
// Keep enough headroom for the largest bounded board rewrite, SQLite/WAL
// overhead, and operator recovery before Cloudflare's 1 GB/object ceiling.
export const BOARD_DATABASE_WRITE_LIMIT_BYTES = 700 * 1_024 * 1_024;
const MAX_HTTP_RECEIPTS = 25_000;
const MAX_INVITATIONS = 10_000;
const MAX_MEMBERS = 10_000;
const HTTP_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PRE_CLEAR_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RETAINED_AUTOMATIC_SNAPSHOTS = 20;
const MAX_RETENTION_DELETES_PER_ALARM = 20;
const INTERNAL_INIT_PATH = "/__internal/initialize";
const INTERNAL_CLASSROOM_LAUNCH_PATH = "/__internal/classroom-launch";
const INTERNAL_ORGANISATION_LAUNCH_PATH = "/__internal/organisation-launch";
const INTERNAL_ORGANISATION_EXPORT_PATH = "/__internal/organisation-export";
const INTERNAL_ORGANISATION_DELETE_PATH = "/__internal/organisation-delete";
const INTERNAL_ORGANISATION_ASSET_ROUTE =
  /^\/__internal\/organisation-assets\/(asset_[A-Za-z0-9_-]{43})$/u;
const WEBHOOK_TIMEOUT_MS = 10_000;
const TELEMETRY_AGGREGATE_INTERVAL_MS = 60_000;
// Start graceful shedding before the hard 200 frame/s room ceiling so a
// 20-drawer burst cannot monopolize the Durable Object input queue. The
// expected five-drawer workload is only about 60 frame/s.
const PREVIEW_SHED_TRIGGER_PER_SECOND = 100;
// Once the room-wide preview budget is exceeded, preserve a low-rate preview
// from every actor while reserving the event loop for durable commands. The
// normal five-drawer workload never enters this shedding path.
const OVERLOADED_PREVIEW_HZ_PER_ACTOR = 1;

type CommentState = "open" | "resolved" | "orphaned";

type CommentRow = {
  [key: string]: SqlStorageValue;
  comment_id: string;
  target_item_id: string;
  body: string;
  state: CommentState;
  created_by: string;
  created_at_ms: number;
  resolved_by: string | null;
  resolved_at_ms: number | null;
  updated_at_ms: number;
  assisted_by: string | null;
  assistance_tool: string | null;
  assistance_action: string | null;
  media_kind: string | null;
  media_json: string | null;
  author_name: string;
  resolver_name: string | null;
};

type BoardComment = {
  id: string;
  itemId: string;
  body: string;
  state: CommentState;
  author: { id: string; displayName: string };
  createdAt: number;
  updatedAt: number;
  resolvedBy?: { id: string; displayName: string };
  resolvedAt?: number;
  assistedBy?: "ai";
  assistance?: Assistance;
  /** The one picture or video this comment carries beside its text, when it carries one. */
  media?: CommentMedia;
};

type ActionRow = {
  [key: string]: SqlStorageValue;
  seq: number;
  action_id: string;
  command_id: string;
  request_hash: string;
  actor_id: string;
  kind: string;
  payload_json: string;
  affected_item_ids_json: string;
  undoable: number;
  target_action_seq: number | null;
  accepted_at_ms: number;
};

type HistoryEntryRow = {
  [key: string]: SqlStorageValue;
  normal_action_seq: number;
  actor_id: string;
  state: "active" | "undone" | "invalidated";
  last_transition_seq: number;
  action_id: string;
  payload_json: string;
};

type ActionReceiptRow = {
  [key: string]: SqlStorageValue;
  actor_id: string;
  request_hash: string;
  payload_json: string;
};

type UsageDelta = {
  incomingFrames: number;
  rowsReadEstimate: number;
  rowsWrittenEstimate: number;
  r2Reads: number;
  r2Writes: number;
  r2Bytes: number;
  actions: number;
  snapshots: number;
};

type UsageInput = Partial<Omit<UsageDelta, "incomingFrames">>;

type ReplayMetrics = { actions: number; bytes: number };
type CommitMetrics = {
  actionKind: string;
  seq: number;
  sqliteDurationMs: number;
  sqliteRowsRead: number;
  sqliteRowsWritten: number;
};
type CommitExecution = { transactionStarted: boolean };

type BoardAssetRow = {
  [key: string]: SqlStorageValue;
  asset_id: string;
  sha256: string;
  r2_key: string;
  mime_type: ImageAssetMimeType;
  intrinsic_width: number;
  intrinsic_height: number;
  byte_count: number;
  state: "pending" | "committed";
  created_at_ms: number;
  committed_at_ms: number | null;
};

type ExportActor = {
  id: string;
  displayName: string;
  participantHash: string;
  participantId?: string | null;
};
type SnapshotAttributionEntry = { itemId: string; attribution: ItemAttributionState };

export class BoardRoom extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #buckets = new TokenBucket();
  #telemetry: DurableObjectTelemetryContext;
  #pendingFrameCount = 0;
  #previewOverloadedUntil = 0;
  #trafficWindowStartedAt = Date.now();
  #previewFrames = 0;
  #commitFrames = 0;
  #lastBoardMetricsAt = 0;
  #lastBoardMetricsSignature = "";
  readonly #pendingQuotaDays = new Set<string>();
  #quotaEmissionScheduled = false;
  #assetUploadTail = Promise.resolve();
  #webhookDeliveryTail = Promise.resolve();
  #boardDeletion: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    const workerVersionId = env.WORKER_VERSION?.id || "unknown";
    this.#telemetry = {
      environment: env.ENVIRONMENT || "unknown",
      workerVersionId,
      durableObjectVersion: workerVersionId,
    };
    void ctx.blockConcurrencyWhile(async () => {
      applyMigrations(ctx.storage, this.#telemetry);
      backfillSnapshotAccounting(ctx.storage);
      const board = readBoard(this.#sql);
      if (board !== null) {
        this.#telemetry = await durableObjectTelemetryContext(this.env, board.public_id);
      }
      // Constructor work is local and bounded so a hibernation wake remains
      // cheap; the input gate delays events until migrations finish.
    });
  }

  async fetch(request: Request): Promise<Response> {
    const requestId = request.headers.get(INTERNAL_REQUEST_ID_HEADER) || crypto.randomUUID();
    const startedAt = performance.now();
    let response: Response;
    let internalError = false;
    try {
      response = await this.route(request, requestId);
      if (
        response.ok &&
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        new URL(request.url).pathname !== INTERNAL_ORGANISATION_DELETE_PATH
      ) {
        try {
          await this.syncOrganisationAdminSummary(new URL(request.url).origin, requestId);
        } catch (error) {
          this.log("warn", "organisation.admin_summary_sync_failed", {
            requestId,
            code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
          });
        }
      }
    } catch (error) {
      const mapped = mapRoomError(error);
      internalError = mapped.code === "INTERNAL_ERROR";
      this.log(mapped.status >= 500 ? "error" : "warn", "room.http_rejected", {
        requestId,
        code: mapped.code,
        durationMs: Math.round(performance.now() - startedAt),
      });
      response = errorResponse(mapped, requestId);
    }
    this.log("info", "room.http_completed", {
      requestId,
      executionComponent: "BoardRoom",
      status: response.status,
      internalError,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return response;
  }

  private async route(request: Request, requestId: string): Promise<Response> {
    const url = new URL(request.url);
    const actor = readInternalActor(request, requestId);

    if (url.pathname === INTERNAL_INIT_PATH) {
      requireMethod(request, "POST");
      return this.initialize(request, actor);
    }

    if (url.pathname === INTERNAL_CLASSROOM_LAUNCH_PATH) {
      requireMethod(request, "POST");
      return this.classroomLaunch(request, actor);
    }

    if (url.pathname === INTERNAL_ORGANISATION_LAUNCH_PATH) {
      requireMethod(request, "POST");
      return this.classroomLaunch(request, actor, true);
    }

    if (url.pathname === INTERNAL_ORGANISATION_EXPORT_PATH) {
      requireMethod(request, "POST");
      return this.exportForOrganisation(request);
    }

    if (url.pathname === INTERNAL_ORGANISATION_DELETE_PATH) {
      requireMethod(request, "DELETE");
      return this.deleteForOrganisation(request);
    }

    const organisationAsset = INTERNAL_ORGANISATION_ASSET_ROUTE.exec(url.pathname);
    if (organisationAsset !== null) {
      requireMethod(request, "GET");
      const assetId = organisationAsset[1];
      const organisationId = url.searchParams.get("organisationId");
      if (assetId === undefined || organisationId === null) throw boardNotFoundError();
      return this.getOrganisationImageAsset(organisationId, assetId);
    }

    const board = this.requireBoard();
    const prefix = `/api/v1/boards/${board.public_id}`;
    if (!url.pathname.startsWith(`${prefix}/`))
      throw new HttpError(404, "NOT_FOUND", "Board not found.");
    const suffix = url.pathname.slice(prefix.length);

    // Authorized callers get one stable terminal response for every archived
    // board route. Preserve private-board indistinguishability for anyone who
    // could not view the board before it was archived.
    if (board.archived_at_ms !== null) {
      if (!resolveAccess(this.#sql, board, actor.actorId).canView) throw boardNotFoundError();
      this.ensureBoardActive(board);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      this.ensureDatabaseWriteCapacity();
    }

    if (suffix === "/bootstrap") {
      requireMethod(request, "GET");
      return this.bootstrap(actor, board);
    }
    if (suffix === "/claims") {
      requireMethod(request, "POST");
      return this.claim(request, actor);
    }
    if (suffix === "/comments") {
      if (request.method === "GET") return this.listComments(actor, board);
      if (request.method === "POST") return this.createComment(request, actor, board);
      return methodNotAllowed("GET, POST");
    }
    const commentMatch = /^\/comments\/(c_[A-Za-z0-9_-]{22})$/u.exec(suffix);
    if (commentMatch !== null) {
      const commentId = commentMatch[1];
      if (commentId === undefined) throw new HttpError(404, "NOT_FOUND", "Comment not found.");
      if (request.method === "PATCH") return this.resolveComment(request, actor, board, commentId);
      return methodNotAllowed("PATCH");
    }
    if (suffix === "/members") {
      requireMethod(request, "GET");
      return this.listMembers(actor, board);
    }
    if (suffix === "/activity") {
      requireMethod(request, "GET");
      return this.listActivity(request, actor, board);
    }
    if (suffix === "/organisation/templates") {
      if (request.method === "GET") {
        return this.listOrganisationTemplates(actor, board, url.origin);
      }
      if (request.method === "POST") {
        return this.createOrganisationTemplate(request, actor, board, url.origin);
      }
      return methodNotAllowed("GET, POST");
    }
    if (suffix === "/organisation/settings") {
      if (request.method === "GET") {
        return this.getOrganisationSettings(actor, board, url.origin);
      }
      if (request.method === "PATCH") {
        return this.patchOrganisationSettings(request, actor, board, url.origin);
      }
      return methodNotAllowed("GET, PATCH");
    }
    if (suffix === "/organisation/webhook") {
      requireMethod(request, "POST");
      return this.sendOrganisationWebhook(request, actor, board, url.origin);
    }
    const organisationTemplateMatch = /^\/organisation\/templates\/(tpl_[A-Za-z0-9_-]{22})$/u.exec(
      suffix,
    );
    if (organisationTemplateMatch !== null) {
      const templateId = organisationTemplateMatch[1];
      if (templateId === undefined) {
        throw new HttpError(404, "NOT_FOUND", "Template not found.");
      }
      if (request.method === "PATCH") {
        return this.patchOrganisationTemplate(request, actor, board, url.origin, templateId);
      }
      if (request.method === "DELETE") {
        return this.deleteOrganisationTemplate(actor, board, url.origin, templateId);
      }
      return methodNotAllowed("PATCH, DELETE");
    }
    const memberMatch = /^\/members\/(a_[A-Za-z0-9_-]{22})$/u.exec(suffix);
    if (memberMatch !== null) {
      const targetActorId = memberMatch[1];
      if (targetActorId === undefined) throw new HttpError(404, "NOT_FOUND", "Member not found.");
      if (request.method === "PATCH") return this.patchMember(request, actor, targetActorId);
      if (request.method === "DELETE") return this.revokeMember(request, actor, targetActorId);
      return methodNotAllowed("PATCH, DELETE");
    }
    if (suffix === "/ownership-transfer") {
      requireMethod(request, "POST");
      return this.transferOwnership(request, actor);
    }
    if (suffix === "/owner-recovery/rotate") {
      requireMethod(request, "POST");
      return this.rotateRecovery(request, actor);
    }
    if (suffix === "/invitations") {
      requireMethod(request, "POST");
      return this.createInvitation(request, actor, url.origin);
    }
    const invitationMatch = /^\/invitations\/([A-Za-z0-9_-]{16,80})$/u.exec(suffix);
    if (invitationMatch !== null) {
      requireMethod(request, "DELETE");
      const invitationId = invitationMatch[1];
      if (invitationId === undefined)
        throw new HttpError(404, "NOT_FOUND", "Invitation not found.");
      return this.revokeInvitation(request, actor, invitationId);
    }
    if (suffix === "/settings") {
      requireMethod(request, "PATCH");
      return this.patchSettings(request, actor);
    }
    if (suffix === "/assets") {
      requireMethod(request, "POST");
      return this.uploadImageAsset(request, actor, board);
    }
    const assetMatch = /^\/assets\/(asset_[A-Za-z0-9_-]{43})$/u.exec(suffix);
    if (assetMatch !== null) {
      requireMethod(request, "GET");
      const assetId = assetMatch[1];
      if (assetId === undefined) {
        throw new HttpError(404, "NOT_FOUND", "Image asset not found.");
      }
      return this.getImageAsset(actor, board, assetId);
    }
    if (suffix === "/archive") {
      requireMethod(request, "POST");
      return this.archiveBoard(request, actor);
    }
    if (suffix === "/snapshots") {
      if (request.method === "GET") return this.listSnapshots(actor, board);
      if (request.method === "POST") return this.createNamedSnapshot(request, actor);
      return methodNotAllowed("GET, POST");
    }
    const restoreMatch = /^\/restore\/(\d+)$/u.exec(suffix);
    if (restoreMatch !== null) {
      requireMethod(request, "POST");
      return this.restoreSnapshot(request, actor, Number(restoreMatch[1]));
    }
    if (suffix === "/export.json") {
      requireMethod(request, "GET");
      return this.exportJson(actor, board);
    }
    if (suffix === "/export.attributed.json") {
      requireMethod(request, "GET");
      return this.exportAttributedJson(actor, board);
    }
    if (suffix === "/export.svg") {
      requireMethod(request, "GET");
      return this.exportSvg(actor, board);
    }
    if (suffix === "/socket") {
      requireMethod(request, "GET");
      return this.upgradeWebSocket(request, actor, board);
    }
    throw new HttpError(404, "NOT_FOUND", "The requested endpoint does not exist.");
  }

  private listComments(actor: InternalActorContext, capturedBoard: BoardRow): Response {
    const board = readBoard(this.#sql) ?? capturedBoard;
    this.requireView(board, actor.actorId);
    return Response.json(
      { comments: this.readComments() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  private async createComment(
    request: Request,
    actor: InternalActorContext,
    capturedBoard: BoardRow,
  ): Promise<Response> {
    const body = await readJsonBody(request, 16 * 1_024);
    assertExactKeys(
      body,
      ["itemId", "body", "assistedBy", "assistance", "media"],
      ["itemId", "body"],
    );
    const itemId = requireOpaqueId(body.itemId, "comment target");
    const text = requireCommentBody(body.body);
    const assistance = requireCommentAssistance(body);
    const media = requireCommentMedia(body);
    const commentId = randomOpaqueId("c_");
    const now = Date.now();
    let comment!: BoardComment;
    this.ctx.storage.transactionSync(() => {
      const board = readBoard(this.#sql) ?? capturedBoard;
      const access = this.requireView(board, actor.actorId);
      if (!canComment(board.drawing_policy, access.role)) {
        throw new BoardDomainError("FORBIDDEN", "Commenting is not allowed for your role.");
      }
      const target = readItem(this.#sql, itemId);
      if (target === undefined || target.deleted) {
        throw new HttpError(404, "NOT_FOUND", "The comment target no longer exists.");
      }
      // A picture rides on the same private board asset a participant's own upload produces,
      // so the comment may only name one this board already holds.
      if (media?.kind === "image") this.requireCommentImageMedia(board, media);
      const count = this.#sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM comments")
        .one().count;
      if (count >= MAX_COMMENTS) {
        throw new HttpError(
          409,
          "BOARD_LIMIT_REACHED",
          "This Space has reached its comment limit.",
        );
      }
      this.#sql.exec(
        `INSERT INTO comments(
          comment_id, target_item_id, body, state, created_by,
          created_at_ms, resolved_by, resolved_at_ms, updated_at_ms,
          assisted_by, assistance_tool, assistance_action, media_kind, media_json
        ) VALUES (?, ?, ?, 'open', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
        commentId,
        itemId,
        text,
        actor.actorId,
        now,
        now,
        assistance === null ? null : "ai",
        assistance?.tool ?? null,
        assistance?.action ?? null,
        media?.kind ?? null,
        media === null ? null : JSON.stringify(media),
      );
      comment = this.readComment(commentId) as BoardComment;
    });
    this.broadcastCommentsRefresh();
    return Response.json(comment, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  }

  private async resolveComment(
    request: Request,
    actor: InternalActorContext,
    capturedBoard: BoardRow,
    commentId: string,
  ): Promise<Response> {
    const body = await readJsonBody(request, 4 * 1_024);
    assertExactKeys(body, ["state"], ["state"]);
    if (body.state !== "resolved") {
      throw new HttpError(400, "BAD_REQUEST", "A comment can only transition to resolved.");
    }
    const now = Date.now();
    let comment!: BoardComment;
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      const board = readBoard(this.#sql) ?? capturedBoard;
      const access = this.requireView(board, actor.actorId);
      const existing = this.readComment(commentId);
      if (existing === null) throw new HttpError(404, "NOT_FOUND", "Comment not found.");
      if (existing.author.id !== actor.actorId && access.role !== "owner") {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "Only the comment author or a board owner can resolve a comment.",
        );
      }
      if (existing.state !== "resolved") {
        this.#sql.exec(
          `UPDATE comments
           SET state = 'resolved', resolved_by = ?, resolved_at_ms = ?, updated_at_ms = ?
           WHERE comment_id = ? AND state != 'resolved'`,
          actor.actorId,
          now,
          now,
          commentId,
        );
        changed = true;
      }
      comment = this.readComment(commentId) as BoardComment;
    });
    if (changed) this.broadcastCommentsRefresh();
    return Response.json(comment, { headers: { "Cache-Control": "no-store" } });
  }

  private readComments(): BoardComment[] {
    return this.queryComments("ORDER BY c.created_at_ms ASC, c.comment_id ASC");
  }

  private readComment(commentId: string): BoardComment | null {
    return this.queryComments("WHERE c.comment_id = ?", [commentId])[0] ?? null;
  }

  private queryComments(clause: string, params: SqlStorageValue[] = []): BoardComment[] {
    return this.#sql
      .exec<CommentRow>(
        `SELECT c.comment_id, c.target_item_id, c.body, c.state, c.created_by,
          c.created_at_ms, c.resolved_by, c.resolved_at_ms, c.updated_at_ms,
          c.assisted_by, c.assistance_tool, c.assistance_action, c.media_kind, c.media_json,
          author.display_name AS author_name, resolver.display_name AS resolver_name
         FROM comments c
         LEFT JOIN members author ON author.actor_id = c.created_by
         LEFT JOIN members resolver ON resolver.actor_id = c.resolved_by
         ${clause}`,
        ...params,
      )
      .toArray()
      .map(commentFromRow);
  }

  /** Marks open comments on removed items as orphaned. Returns rows written. */
  private orphanOpenComments(itemIds: Iterable<string>, updatedAt: number): number {
    return this.transitionCommentsForItems(itemIds, "open", "orphaned", updatedAt);
  }

  /** Reopens orphaned comments on items brought back by undo, redo, or restore. */
  private restoreOrphanedComments(itemIds: Iterable<string>, updatedAt: number): number {
    return this.transitionCommentsForItems(itemIds, "orphaned", "open", updatedAt);
  }

  private transitionCommentsForItems(
    itemIds: Iterable<string>,
    from: CommentState,
    to: CommentState,
    updatedAt: number,
  ): number {
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) return 0;
    const hasCandidates =
      this.#sql
        .exec<{ found: number }>(
          "SELECT EXISTS(SELECT 1 FROM comments WHERE state = ?) AS found",
          from,
        )
        .one().found === 1;
    if (!hasCandidates) return 0;
    let rowsWritten = 0;
    for (let start = 0; start < ids.length; start += COMMENT_UPDATE_CHUNK_SIZE) {
      const chunk = ids.slice(start, start + COMMENT_UPDATE_CHUNK_SIZE);
      rowsWritten += this.#sql.exec(
        `UPDATE comments
         SET state = ?, updated_at_ms = ?
         WHERE state = ? AND target_item_id IN (${chunk.map(() => "?").join(", ")})`,
        to,
        updatedAt,
        from,
        ...chunk,
      ).rowsWritten;
    }
    return rowsWritten;
  }

  private broadcastCommentsRefresh(): void {
    this.broadcastFrame({ v: 1, t: "server.comments.refresh" }, undefined, true);
  }

  private async initialize(request: Request, actor: InternalActorContext): Promise<Response> {
    const body = await readJsonBody(request, 16 * 1_024);
    assertExactKeys(
      body,
      [
        "publicId",
        "title",
        "accessMode",
        "ownerActorId",
        "ownerDisplayName",
        "ownerRecoveryHash",
        "features",
      ],
      ["publicId", "title", "accessMode", "ownerActorId", "ownerDisplayName", "ownerRecoveryHash"],
    );
    if (typeof body.publicId !== "string" || !/^b_[A-Za-z0-9_-]{22}$/u.test(body.publicId)) {
      throw new HttpError(400, "BAD_REQUEST", "The board ID is invalid.");
    }
    const title = optionalTitle(body.title);
    if (body.accessMode !== "private" && body.accessMode !== "link_view") {
      throw new HttpError(400, "BAD_REQUEST", "The access mode is invalid.");
    }
    const ownerActorId = requireActorId(body.ownerActorId);
    if (ownerActorId !== actor.actorId)
      throw new HttpError(403, "FORBIDDEN", "The creator identity is invalid.");
    const displayName = requireDisplayName(body.ownerDisplayName);
    const recoveryHash =
      typeof body.ownerRecoveryHash === "string" ? base64UrlToBytes(body.ownerRecoveryHash) : null;
    if (recoveryHash === null || recoveryHash.byteLength !== 32) {
      throw new HttpError(400, "BAD_REQUEST", "The recovery capability is invalid.");
    }
    const features = initialBoardFeatures(body.features);
    const now = Date.now();
    let created = false;
    this.ctx.storage.transactionSync(() => {
      const existing = readBoard(this.#sql);
      if (existing !== null) {
        if (existing.public_id !== body.publicId || existing.owner_actor_id !== ownerActorId) {
          throw new HttpError(409, "CONFLICT", "The board was already initialized.");
        }
        return;
      }
      this.#sql.exec(
        `INSERT INTO board(
           singleton, public_id, title, access_mode, drawing_policy,
           owner_actor_id, owner_recovery_hash, images_enabled, features_json,
           snapshot_live_item_count,
           snapshot_live_item_bytes, created_at_ms, updated_at_ms
         ) VALUES (1, ?, ?, ?, 'editors_enabled', ?, ?, ?, ?, 0, 0, ?, ?)`,
        body.publicId,
        title,
        body.accessMode,
        ownerActorId,
        recoveryHash,
        features.images ? 1 : 0,
        JSON.stringify(features),
        now,
        now,
      );
      this.#sql.exec(
        `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
         VALUES (?, 'owner', ?, ?, ?)`,
        ownerActorId,
        displayName,
        now,
        now,
      );
      this.#sql.exec(
        "INSERT INTO history_state(actor_id, history_version, updated_at_ms) VALUES (?, 0, ?)",
        ownerActorId,
        now,
      );
      created = true;
    });
    this.#telemetry = await durableObjectTelemetryContext(this.env, body.publicId);
    return Response.json({ initialized: true, created }, { status: created ? 201 : 200 });
  }

  private async classroomLaunch(
    request: Request,
    actor: InternalActorContext,
    requireOrganisation = false,
  ): Promise<Response> {
    const body = await readJsonBody(request, MAX_CLASSROOM_IMPORT_ENCODED_CHARS + 16 * 1_024);
    assertExactKeys(
      body,
      [
        "publicId",
        "title",
        "role",
        "displayName",
        "launchIssuedAtMs",
        "placeholderOwnerActorId",
        "ownerRecoveryHash",
        "importSnapshot",
        "organisationId",
        "spaceId",
        "participantId",
        "features",
      ],
      [
        "publicId",
        "title",
        "role",
        "displayName",
        "launchIssuedAtMs",
        "placeholderOwnerActorId",
        "ownerRecoveryHash",
      ],
    );
    if (typeof body.publicId !== "string" || !/^b_[A-Za-z0-9_-]{22}$/u.test(body.publicId)) {
      throw new HttpError(400, "BAD_REQUEST", "The board ID is invalid.");
    }
    const launchTitle = optionalTitle(body.title);
    if (body.role !== "viewer" && body.role !== "editor" && body.role !== "owner") {
      throw new HttpError(400, "BAD_REQUEST", "The Space role is invalid.");
    }
    const role = body.role;
    const displayName = requireDisplayName(body.displayName);
    const launchIssuedAtMs = requireSafeInteger(
      body.launchIssuedAtMs,
      "launchIssuedAtMs",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const placeholderOwnerActorId = requireActorId(body.placeholderOwnerActorId);
    if (
      body.organisationId !== undefined &&
      (typeof body.organisationId !== "string" ||
        !ORGANISATION_ID_PATTERN.test(body.organisationId))
    ) {
      throw new HttpError(400, "BAD_REQUEST", "The organisation ID is invalid.");
    }
    if (requireOrganisation && body.organisationId === undefined) {
      throw new HttpError(400, "BAD_REQUEST", "The organisation ID is required.");
    }
    const organisationId = typeof body.organisationId === "string" ? body.organisationId : null;
    const organisationSpaceId =
      organisationId === null
        ? null
        : typeof body.spaceId === "string" &&
            body.spaceId === body.spaceId.normalize("NFC").trim() &&
            [...body.spaceId].length >= 1 &&
            [...body.spaceId].length <= 120 &&
            !/[\p{Cc}\p{Cs}]/u.test(body.spaceId)
          ? body.spaceId
          : null;
    if (requireOrganisation && organisationSpaceId === null) {
      throw new HttpError(400, "BAD_REQUEST", "The Organisation Space ID is required.");
    }
    const participantId = optionalExternalParticipantId(body.participantId);
    if (requireOrganisation && participantId === null) {
      throw new HttpError(400, "BAD_REQUEST", "The organisation participant ID is required.");
    }
    const recoveryHash =
      typeof body.ownerRecoveryHash === "string" ? base64UrlToBytes(body.ownerRecoveryHash) : null;
    if (recoveryHash === null || recoveryHash.byteLength !== 32) {
      throw new HttpError(400, "BAD_REQUEST", "The recovery capability is invalid.");
    }
    // Fragment import and launch features are initial state only. Once a board
    // row exists, do not inspect either value: relaunches preserve board state.
    const boardBeforeLaunch = readBoard(this.#sql);
    const importedBoard =
      boardBeforeLaunch === null && role === "owner" && body.importSnapshot !== undefined
        ? decodeClassroomBoardImport(body.importSnapshot)
        : null;
    if (importedBoard !== null) this.assertMoveCopyClosureTarget(importedBoard.items);
    const importedAccounting =
      importedBoard === null ? null : snapshotAccountingForItems(importedBoard.items);
    const title = importedBoard?.title ?? launchTitle;

    const now = Date.now();
    let created = false;
    let launchApplied = false;
    let primaryOwner = false;
    let aclVersion = 1;
    this.ctx.storage.transactionSync(() => {
      let board = readBoard(this.#sql);
      if (board === null) {
        const launchFeatures = initialBoardFeatures(body.features);
        const importedItems = importedBoard?.items ?? [];
        this.#sql.exec(
          `INSERT INTO board(
             singleton, public_id, title, access_mode, drawing_policy,
             owner_actor_id, owner_recovery_hash, latest_seq, next_z, min_replay_seq,
             snapshot_live_item_count,
             snapshot_live_item_bytes, images_enabled, features_json,
             classroom_mode, organisation_mode,
             organisation_id, organisation_space_id, created_at_ms, updated_at_ms
           ) VALUES (1, ?, ?, 'private', 'editors_enabled', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          body.publicId,
          title,
          placeholderOwnerActorId,
          recoveryHash,
          importedBoard === null ? 0 : 1,
          importedItems.length + 1,
          importedBoard === null ? 0 : 1,
          importedAccounting?.itemCount ?? 0,
          importedAccounting?.itemBytes ?? 0,
          launchFeatures.images ? 1 : 0,
          JSON.stringify(launchFeatures),
          organisationId === null ? 0 : 1,
          organisationId,
          organisationSpaceId,
          now,
          now,
        );
        for (const item of importedItems) {
          writeItem(this.#sql, itemWriteFromState(item, false, crypto.randomUUID()));
        }
        if (importedItems.length > 0) {
          this.replaceCurrentAttribution(importedItems, null, 1, now);
        }
        board = this.requireBoard();
        created = true;
      } else if (
        board.public_id !== body.publicId ||
        board.classroom_mode !== 1 ||
        board.organisation_mode !== (organisationId === null ? 0 : 1) ||
        board.organisation_id !== organisationId ||
        (board.organisation_space_id !== null &&
          board.organisation_space_id !== organisationSpaceId)
      ) {
        throw new HttpError(409, "CONFLICT", "The board was already initialized.");
      }
      // Primary custody must move through the explicit ownership-transfer path.
      if (organisationSpaceId !== null && board.organisation_space_id === null) {
        this.#sql.exec(
          "UPDATE board SET organisation_space_id = ?, updated_at_ms = ? WHERE singleton = 1",
          organisationSpaceId,
          now,
        );
        board = this.requireBoard();
        launchApplied = true;
      }
      // A signed launch may update this actor's name, but cannot strand custody.
      const effectiveRole: BoardRole = actor.actorId === board.owner_actor_id ? "owner" : role;

      const member = this.#sql
        .exec<{
          role: BoardRole;
          display_name: string;
          updated_at_ms: number;
          revoked_at_ms: number | null;
        }>(
          `SELECT role, display_name, updated_at_ms, revoked_at_ms
           FROM members WHERE actor_id = ?`,
          actor.actorId,
        )
        .toArray()[0];
      if (member === undefined || launchIssuedAtMs > member.updated_at_ms) {
        if (member === undefined) this.ensureMemberCapacity();
        this.#sql.exec(
          `INSERT INTO members(
             actor_id, role, display_name, external_participant_id,
             created_at_ms, updated_at_ms, revoked_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(actor_id) DO UPDATE SET
             role = excluded.role,
             display_name = excluded.display_name,
             external_participant_id = excluded.external_participant_id,
             updated_at_ms = excluded.updated_at_ms,
             revoked_at_ms = NULL`,
          actor.actorId,
          effectiveRole,
          displayName,
          participantId,
          now,
          launchIssuedAtMs,
        );
        this.#sql.exec(
          `INSERT INTO history_state(actor_id, history_version, updated_at_ms)
           VALUES (?, 0, ?) ON CONFLICT(actor_id) DO NOTHING`,
          actor.actorId,
          now,
        );
        launchApplied = true;
      }

      const activeMember = this.#sql
        .exec<{ role: BoardRole; revoked_at_ms: number | null }>(
          "SELECT role, revoked_at_ms FROM members WHERE actor_id = ?",
          actor.actorId,
        )
        .one();
      const currentPrimary = this.#sql
        .exec<{ role: BoardRole; revoked_at_ms: number | null }>(
          "SELECT role, revoked_at_ms FROM members WHERE actor_id = ?",
          board.owner_actor_id,
        )
        .toArray()[0];
      const needsPrimaryOwner =
        currentPrimary === undefined ||
        currentPrimary.revoked_at_ms !== null ||
        currentPrimary.role !== "owner";
      if (
        activeMember.revoked_at_ms === null &&
        activeMember.role === "owner" &&
        needsPrimaryOwner
      ) {
        this.#sql.exec("UPDATE board SET owner_actor_id = ? WHERE singleton = 1", actor.actorId);
        launchApplied = true;
      }

      if (created) {
        aclVersion = 1;
        this.#sql.exec("UPDATE board SET updated_at_ms = ? WHERE singleton = 1", now);
      } else if (launchApplied) {
        aclVersion = board.acl_version + 1;
        this.#sql.exec(
          `UPDATE board SET acl_version = ?, updated_at_ms = ? WHERE singleton = 1`,
          aclVersion,
          now,
        );
      } else {
        aclVersion = board.acl_version;
      }
      primaryOwner = this.requireBoard().owner_actor_id === actor.actorId;
    });

    this.#telemetry = await durableObjectTelemetryContext(this.env, body.publicId);
    if (!created && launchApplied) this.broadcastAccessChanged(actor.actorId);
    const board = this.requireBoard();
    const features = featuresForBoard(board);
    const access = this.requireView(board, actor.actorId);
    return Response.json(
      {
        board: {
          id: board.public_id,
          title: board.title,
          accessMode: board.access_mode,
          drawingPolicy: board.drawing_policy,
          imagesEnabled: features.images,
          features,
          aclVersion,
        },
        actor: { id: actor.actorId, role: access.role, displayName: access.displayName },
        created,
        launchApplied,
        primaryOwner,
      },
      { status: created ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  private async listOrganisationTemplates(
    actor: InternalActorContext,
    board: BoardRow,
    origin: string,
  ): Promise<Response> {
    const access = this.requireView(board, actor.actorId);
    this.requireFeature(board, "organisationTemplates");
    const organisationId = this.organisationIdForBoard(board);
    if (organisationId === null) {
      return Response.json({ organisationId: null, canManage: false, templates: [] });
    }
    const response = await this.organisationRoomFetch(
      organisationId,
      new Request(`${origin}/__internal/organisations/${organisationId}/templates`, {
        method: "GET",
        headers: { [INTERNAL_REQUEST_ID_HEADER]: actor.requestId },
      }),
    );
    if (!response.ok) return response;
    const templates: unknown = await response.json();
    if (!Array.isArray(templates)) {
      throw new HttpError(500, "INTERNAL_ERROR", "The organisation template response is invalid.");
    }
    return Response.json({
      organisationId,
      canManage: access.role === "owner",
      templates,
    });
  }

  private async createOrganisationTemplate(
    request: Request,
    actor: InternalActorContext,
    board: BoardRow,
    origin: string,
  ): Promise<Response> {
    this.requireOwner(board, actor.actorId);
    this.requireFeature(board, "organisationTemplates");
    const organisationId = this.organisationIdForBoard(board);
    if (organisationId === null) {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Organisation templates are not available for this board.",
      );
    }
    const body = await readJsonBody(request, MAX_ORGANISATION_TEMPLATE_BYTES + 32 * 1_024);
    assertExactKeys(body, ["name", "description", "items"], ["name", "items"]);
    return this.organisationRoomFetch(
      organisationId,
      new Request(`${origin}/__internal/organisations/${organisationId}/templates`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [INTERNAL_REQUEST_ID_HEADER]: actor.requestId,
        },
        body: JSON.stringify({ ...body, createdBy: actor.actorId }),
      }),
    );
  }

  private async patchOrganisationTemplate(
    request: Request,
    actor: InternalActorContext,
    board: BoardRow,
    origin: string,
    templateId: string,
  ): Promise<Response> {
    this.requireOwner(board, actor.actorId);
    this.requireFeature(board, "organisationTemplates");
    const organisationId = this.organisationIdForBoard(board);
    if (organisationId === null) {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Organisation templates are not available for this board.",
      );
    }
    const body = await readJsonBody(request, MAX_ORGANISATION_TEMPLATE_BYTES + 32 * 1_024);
    assertExactKeys(body, ["name", "description", "items"]);
    if (Object.keys(body).length === 0) {
      throw new HttpError(400, "BAD_REQUEST", "At least one template field is required.");
    }
    return this.organisationRoomFetch(
      organisationId,
      new Request(`${origin}/__internal/organisations/${organisationId}/templates/${templateId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [INTERNAL_REQUEST_ID_HEADER]: actor.requestId,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  private async deleteOrganisationTemplate(
    actor: InternalActorContext,
    board: BoardRow,
    origin: string,
    templateId: string,
  ): Promise<Response> {
    this.requireOwner(board, actor.actorId);
    this.requireFeature(board, "organisationTemplates");
    const organisationId = this.organisationIdForBoard(board);
    if (organisationId === null) {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Organisation templates are not available for this board.",
      );
    }
    return this.organisationRoomFetch(
      organisationId,
      new Request(`${origin}/__internal/organisations/${organisationId}/templates/${templateId}`, {
        method: "DELETE",
        headers: { [INTERNAL_REQUEST_ID_HEADER]: actor.requestId },
      }),
    );
  }

  private async getOrganisationSettings(
    actor: InternalActorContext,
    board: BoardRow,
    origin: string,
  ): Promise<Response> {
    this.requireOwner(board, actor.actorId);
    const organisationId = this.organisationIdForBoard(board);
    if (organisationId === null) {
      return Response.json({
        organisationId: null,
        webhookUrl: null,
        updatedBy: null,
        updatedAt: null,
      });
    }
    const settings = await this.readOrganisationWebhookSettings(
      organisationId,
      origin,
      actor.requestId,
    );
    return Response.json({ organisationId, ...settings });
  }

  private async patchOrganisationSettings(
    request: Request,
    actor: InternalActorContext,
    board: BoardRow,
    origin: string,
  ): Promise<Response> {
    this.requireOwner(board, actor.actorId);
    const organisationId = this.organisationIdForBoard(board);
    if (organisationId === null) {
      throw new HttpError(403, "FORBIDDEN", "This board is not attached to an organisation.");
    }
    const body = await readJsonBody(request, 8 * 1_024);
    assertExactKeys(body, ["webhookUrl"], ["webhookUrl"]);
    const webhookUrl = normalizeOrganisationWebhookUrl(body.webhookUrl);
    const response = await this.organisationRoomFetch(
      organisationId,
      new Request(`${origin}/__internal/organisations/${organisationId}/settings`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          [INTERNAL_REQUEST_ID_HEADER]: actor.requestId,
        },
        body: JSON.stringify({ webhookUrl, updatedBy: actor.actorId }),
      }),
    );
    if (!response.ok) return response;
    return Response.json({
      organisationId,
      ...parseOrganisationWebhookSettings(await response.json()),
    });
  }

  private async readOrganisationWebhookSettings(
    organisationId: string,
    origin: string,
    requestId: string,
  ): Promise<OrganisationWebhookSettings> {
    const response = await this.organisationRoomFetch(
      organisationId,
      new Request(`${origin}/__internal/organisations/${organisationId}/settings`, {
        method: "GET",
        headers: { [INTERNAL_REQUEST_ID_HEADER]: requestId },
      }),
    );
    if (!response.ok) {
      throw new HttpError(
        response.status >= 500 ? 503 : response.status,
        response.status >= 500 ? "TEMPORARILY_UNAVAILABLE" : "BAD_REQUEST",
        "Organisation webhook settings are temporarily unavailable.",
      );
    }
    return parseOrganisationWebhookSettings(await response.json());
  }

  private async sendOrganisationWebhook(
    request: Request,
    actor: InternalActorContext,
    board: BoardRow,
    origin: string,
  ): Promise<Response> {
    this.requireOwner(board, actor.actorId);
    const idempotencyKey = requireIdempotencyKey(request);
    const organisationId = this.organisationIdForBoard(board);
    if (organisationId === null) {
      throw new HttpError(403, "FORBIDDEN", "This board is not attached to an organisation.");
    }
    return this.withWebhookDeliveryLock(async () => {
      const requestHash = await sha256Base64Url(
        `organisation-webhook:v1:${organisationId}:${board.public_id}`,
      );
      const existing = this.readHttpReceipt(
        actor.actorId,
        idempotencyKey,
        "organisation.webhook.send",
      );
      if (existing !== null) {
        this.checkReceiptHash(existing.request_hash, requestHash);
        const delivery = parseWebhookDeliveryReceipt(JSON.parse(existing.response_json));
        return Response.json({ delivery, idempotentReplay: true });
      }

      const settings = await this.readOrganisationWebhookSettings(
        organisationId,
        origin,
        actor.requestId,
      );
      const webhookUrl = normalizeOrganisationWebhookUrl(settings.webhookUrl);
      if (webhookUrl === null) {
        throw new HttpError(
          409,
          "WEBHOOK_NOT_CONFIGURED",
          "The organisation webhook URL is not configured.",
        );
      }
      const currentBoard = readBoard(this.#sql) ?? board;
      const snapshot = captureSnapshot(this.#sql, currentBoard);
      const attributedExport = this.attributedExportObject(currentBoard, snapshot, true);
      const deliveryId = `whd_${bytesToBase64Url(
        (
          await hmacSha256(
            this.env.SESSION_SIGNING_KEY_CURRENT,
            `organisation-webhook-delivery:v1:${organisationId}:${currentBoard.public_id}:${actor.actorId}:${idempotencyKey}`,
          )
        ).slice(0, 16),
      )}`;
      const createdAt = Date.now();
      const event = "board.exported" as const;
      const payload = JSON.stringify({
        event,
        version: 1,
        deliveryId,
        createdAt,
        organisation: { id: organisationId },
        board: { id: currentBoard.public_id, title: currentBoard.title, seq: snapshot.seq },
        export: attributedExport,
      });
      const timestampSeconds = Math.floor(createdAt / 1_000);
      const signature = await new OrganisationAuthService(this.env).signWebhookPayload(
        organisationId,
        timestampSeconds,
        payload,
      );
      const responseStatus = await deliverOrganisationWebhook({
        url: webhookUrl,
        body: payload,
        timeoutMs: WEBHOOK_TIMEOUT_MS,
        allowedOrigins: this.env.WEBHOOK_ALLOWED_ORIGINS,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "user-agent": "SpaceScale-Webhook/1.0",
          "x-spacescale-webhook-id": deliveryId,
          "x-spacescale-webhook-timestamp": String(timestampSeconds),
          "x-spacescale-webhook-key-id": signature.keyId,
          "x-spacescale-webhook-signature": `v1=${signature.signature}`,
        },
      });
      const delivery = { id: deliveryId, event, createdAt, responseStatus };
      this.writeHttpReceipt(
        actor.actorId,
        idempotencyKey,
        "organisation.webhook.send",
        requestHash,
        delivery,
        200,
      );
      return Response.json({ delivery, idempotentReplay: false });
    });
  }

  private async syncOrganisationAdminSummary(origin: string, requestId: string): Promise<void> {
    const board = readBoard(this.#sql);
    if (board === null) return;
    const organisationId = this.organisationIdForBoard(board);
    if (organisationId === null || board.organisation_space_id === null) return;

    const members = this.#sql
      .exec<{
        actor_id: string;
        display_name: string;
        role: BoardRole;
      }>(
        `SELECT actor_id, display_name, role FROM members
         WHERE revoked_at_ms IS NULL ORDER BY role DESC, actor_id`,
      )
      .toArray()
      .map((member) => ({
        id: member.actor_id,
        displayName: member.display_name,
        role: member.role,
      }));

    const response = await this.organisationRoomFetch(
      organisationId,
      new Request(
        `${origin}/__internal/organisations/${organisationId}/spaces/${board.public_id}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            [INTERNAL_REQUEST_ID_HEADER]: requestId,
          },
          body: JSON.stringify({
            spaceId: board.organisation_space_id,
            title: board.title,
            archived: board.archived_at_ms !== null,
            members,
            settings: {
              accessMode: board.access_mode,
              drawingPolicy: board.drawing_policy,
              features: featuresForBoard(board),
              aclVersion: board.acl_version,
            },
          }),
        },
      ),
    );
    if (!response.ok) {
      throw new HttpError(
        503,
        "TEMPORARILY_UNAVAILABLE",
        "The Organisation admin summary could not be synchronized.",
      );
    }
  }

  private async deleteForOrganisation(request: Request): Promise<Response> {
    const body = await readJsonBody(request, 4 * 1_024);
    assertExactKeys(body, ["organisationId", "boardId"], ["organisationId", "boardId"]);
    if (
      typeof body.organisationId !== "string" ||
      !ORGANISATION_ID_PATTERN.test(body.organisationId) ||
      typeof body.boardId !== "string" ||
      !BOARD_ID_PATTERN.test(body.boardId)
    ) {
      throw boardNotFoundError();
    }

    const organisationId = body.organisationId;
    const boardId = body.boardId;
    const board = readBoard(this.#sql);
    if (
      board !== null &&
      (board.public_id !== boardId ||
        board.organisation_mode !== 1 ||
        board.organisation_id !== organisationId)
    ) {
      throw boardNotFoundError();
    }

    const deletion =
      this.#boardDeletion ??
      Promise.resolve()
        .then(() => this.performBoardDeletion(boardId))
        .finally(() => {
          this.#boardDeletion = null;
        });
    this.#boardDeletion = deletion;
    await deletion;
    return new Response(null, { status: 204 });
  }

  private async performBoardDeletion(boardId: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(4012, "Board deleted");
    }

    try {
      await Promise.all([
        deleteR2Prefix(this.env.BOARD_SNAPSHOTS, `boards/${boardId}/snapshots/`),
        deleteR2Prefix(this.env.BOARD_ASSETS, `boards/${boardId}/assets/`),
      ]);
    } catch {
      throw new HttpError(
        503,
        "TEMPORARILY_UNAVAILABLE",
        "Board deletion is temporarily unavailable.",
      );
    }

    await this.ctx.storage.deleteAll();
    applyMigrations(this.ctx.storage, this.#telemetry);
    backfillSnapshotAccounting(this.ctx.storage);
  }

  private organisationIdForBoard(board: BoardRow): string | null {
    if (board.organisation_mode === 0 && board.organisation_id === null) return null;
    if (
      board.organisation_mode === 1 &&
      typeof board.organisation_id === "string" &&
      ORGANISATION_ID_PATTERN.test(board.organisation_id)
    ) {
      return board.organisation_id;
    }
    throw new HttpError(500, "INTERNAL_ERROR", "The board organisation scope is invalid.");
  }

  private organisationRoomFetch(organisationId: string, request: Request): Promise<Response> {
    const namespace = (
      this.env as Env & {
        ORGANISATION_ROOMS?: DurableObjectNamespace<OrganisationRoom>;
      }
    ).ORGANISATION_ROOMS;
    if (namespace === undefined) {
      throw new HttpError(
        503,
        "TEMPORARILY_UNAVAILABLE",
        "Organisation services are temporarily unavailable.",
      );
    }
    return namespace.getByName(organisationId).fetch(request);
  }

  private bootstrap(actor: InternalActorContext, capturedBoard: BoardRow): Response {
    const board = readBoard(this.#sql) ?? capturedBoard;
    const features = featuresForBoard(board);
    const access = this.requireView(board, actor.actorId);
    const snapshot = captureSnapshot(this.#sql, board);
    const history = this.historyState(actor.actorId);
    const creatorIds = new Set(snapshot.items.map((item) => item.createdBy));
    const creators = this.actorDirectory(creatorIds);
    return Response.json(
      {
        protocolVersion: 1,
        board: {
          id: board.public_id,
          title: board.title,
          accessMode: board.access_mode,
          drawingPolicy: board.drawing_policy,
          imagesEnabled: features.images,
          features,
          aclVersion: board.acl_version,
          latestSeq: board.latest_seq,
          snapshotSeq: snapshot.seq,
        },
        actor: {
          id: actor.actorId,
          displayName: access.displayName,
          role: access.role,
          historyVersion: history.historyVersion,
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          sessionExpiresAt: actor.sessionExpiresAt,
        },
        creators,
        limits: LIMITS,
        snapshot,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  private actorDirectory(
    actorIds: ReadonlySet<string>,
  ): Array<{ id: string; displayName: string }> {
    if (actorIds.size === 0) return [];
    return this.#sql
      .exec<{ actor_id: string; display_name: string }>(
        "SELECT actor_id, display_name FROM members ORDER BY actor_id",
      )
      .toArray()
      .flatMap((member) =>
        actorIds.has(member.actor_id)
          ? [{ id: member.actor_id, displayName: member.display_name }]
          : [],
      );
  }

  private exportActorDirectory(actorIds: ReadonlySet<string>): Map<string, ExportActor> {
    const directory = new Map<string, ExportActor>();
    for (const actorId of actorIds) {
      directory.set(actorId, {
        id: actorId,
        displayName: fallbackDisplayName(actorId),
        participantHash: actorId,
      });
    }
    for (const member of this.#sql
      .exec<{ actor_id: string; display_name: string }>(
        "SELECT actor_id, display_name FROM members ORDER BY actor_id",
      )
      .toArray()) {
      if (actorIds.has(member.actor_id)) {
        directory.set(member.actor_id, {
          id: member.actor_id,
          displayName: member.display_name,
          participantHash: member.actor_id,
        });
      }
    }
    return directory;
  }

  private readItemAttribution(item: BoardItem): ItemAttributionState {
    const row = this.#sql
      .exec<{ data_json: string }>(
        "SELECT data_json FROM item_attribution WHERE item_id = ?",
        item.id,
      )
      .toArray()[0];
    if (row === undefined) return this.fallbackItemAttribution(item);
    return parseItemAttributionState(row.data_json, item.id);
  }

  private readItemAttributionMap(items: readonly BoardItem[]): Map<string, ItemAttributionState> {
    const wantedIds = new Set(items.map((item) => item.id));
    const result = new Map<string, ItemAttributionState>();
    for (const row of this.#sql
      .exec<{ item_id: string; data_json: string }>(
        "SELECT item_id, data_json FROM item_attribution ORDER BY item_id",
      )
      .toArray()) {
      if (wantedIds.has(row.item_id)) {
        result.set(row.item_id, parseItemAttributionState(row.data_json, row.item_id));
      }
    }
    for (const item of items) {
      if (!result.has(item.id)) result.set(item.id, this.fallbackItemAttribution(item));
    }
    return result;
  }

  private fallbackItemAttribution(item: BoardItem): ItemAttributionState {
    const acceptedAt =
      this.#sql
        .exec<{ accepted_at_ms: number }>(
          "SELECT accepted_at_ms FROM activity_log WHERE seq = ?",
          item.version,
        )
        .toArray()[0]?.accepted_at_ms ?? this.requireBoard().created_at_ms;
    return initialItemAttribution(item, item.createdBy, item.version, acceptedAt);
  }

  private deriveAttributionEffects(
    effects: readonly ItemEffect[],
    actorId: string,
    seq: number,
    acceptedAt: number,
  ): ItemAttributionEffect[] {
    return effects.map((effect) => {
      const before = effect.before.exists ? this.readItemAttribution(effect.before.item) : null;
      const after = effect.after.exists
        ? deriveItemAttribution(
            effect.before.exists ? effect.before.item : null,
            effect.after.item,
            before,
            actorId,
            seq,
            acceptedAt,
          )
        : null;
      return { itemId: effect.itemId, before, after };
    });
  }

  private deriveHistoryAttributionEffect(
    effect: ItemEffect,
    current: ItemRecord | undefined,
    targetSide: "before" | "after",
    actorId: string,
    seq: number,
    acceptedAt: number,
  ): ItemAttributionEffect {
    const currentItem = current === undefined || current.deleted ? null : current.item;
    const currentAttribution = currentItem === null ? null : this.readItemAttribution(currentItem);
    const target = effect[targetSide];
    const targetAttribution = target.exists
      ? deriveItemAttribution(
          currentItem,
          target.item,
          currentAttribution,
          actorId,
          seq,
          acceptedAt,
        )
      : null;
    return targetSide === "before"
      ? { itemId: effect.itemId, before: targetAttribution, after: currentAttribution }
      : { itemId: effect.itemId, before: currentAttribution, after: targetAttribution };
  }

  private applyAttributionEffects(
    effects: readonly ItemAttributionEffect[],
    side: "before" | "after",
  ): number {
    let rowsWritten = 0;
    for (const effect of effects) {
      const attribution = effect[side];
      if (attribution === null) {
        rowsWritten += this.#sql.exec(
          "DELETE FROM item_attribution WHERE item_id = ?",
          effect.itemId,
        ).rowsWritten;
        continue;
      }
      rowsWritten += this.#sql.exec(
        `INSERT INTO item_attribution(item_id, data_json) VALUES (?, ?)
         ON CONFLICT(item_id) DO UPDATE SET data_json = excluded.data_json`,
        effect.itemId,
        JSON.stringify(attribution),
      ).rowsWritten;
    }
    return rowsWritten;
  }

  private captureSnapshotAttribution(items: readonly BoardItem[]): SnapshotAttributionEntry[] {
    const attribution = this.readItemAttributionMap(items);
    return items.map((item) => ({
      itemId: item.id,
      attribution: attribution.get(item.id) ?? this.fallbackItemAttribution(item),
    }));
  }

  private writeSnapshotAttribution(
    seq: number,
    attribution: readonly SnapshotAttributionEntry[],
  ): number {
    const dataJson = JSON.stringify(attribution);
    if (utf8(dataJson).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new BoardDomainError(
        "MESSAGE_TOO_LARGE",
        "The snapshot attribution sidecar exceeds 20 MiB.",
      );
    }
    return this.#sql.exec(
      `INSERT INTO snapshot_attribution(seq, data_json) VALUES (?, ?)
       ON CONFLICT(seq) DO UPDATE SET data_json = excluded.data_json`,
      seq,
      dataJson,
    ).rowsWritten;
  }

  private readSnapshotAttribution(seq: number): Map<string, ItemAttributionState> | null {
    const row = this.#sql
      .exec<{ data_json: string }>("SELECT data_json FROM snapshot_attribution WHERE seq = ?", seq)
      .toArray()[0];
    if (row === undefined) return null;
    return parseSnapshotAttribution(row.data_json);
  }

  private replaceCurrentAttribution(
    items: readonly BoardItem[],
    snapshotAttribution: ReadonlyMap<string, ItemAttributionState> | null,
    fallbackSeq: number,
    fallbackAt: number,
  ): number {
    let rowsWritten = this.#sql.exec("DELETE FROM item_attribution").rowsWritten;
    for (const item of items) {
      const attribution =
        snapshotAttribution?.get(item.id) ??
        initialItemAttribution(item, item.createdBy, fallbackSeq, fallbackAt);
      rowsWritten += this.#sql.exec(
        "INSERT INTO item_attribution(item_id, data_json) VALUES (?, ?)",
        item.id,
        JSON.stringify(attribution),
      ).rowsWritten;
    }
    return rowsWritten;
  }

  private restoredItemCreators(
    items: Iterable<BoardItem>,
    actionActorId: string,
  ): Array<{ id: string; displayName: string }> {
    const actorIds = new Set<string>();
    for (const item of items) {
      if (item.createdBy !== actionActorId) actorIds.add(item.createdBy);
    }
    return this.actorDirectory(actorIds);
  }

  private listMembers(actor: InternalActorContext, board: BoardRow): Response {
    this.requireOwner(board, actor.actorId);
    const members = this.#sql
      .exec<{
        actor_id: string;
        role: BoardRole;
        display_name: string;
        created_at_ms: number;
        updated_at_ms: number;
        revoked_at_ms: number | null;
      }>(
        `SELECT actor_id, role, display_name, created_at_ms, updated_at_ms, revoked_at_ms
         FROM members ORDER BY role = 'owner' DESC, created_at_ms, actor_id`,
      )
      .toArray()
      .map((member) => ({
        actorId: member.actor_id,
        role: member.role,
        displayName: member.display_name,
        createdAt: member.created_at_ms,
        updatedAt: member.updated_at_ms,
        revokedAt: member.revoked_at_ms,
        primaryOwner: member.actor_id === board.owner_actor_id,
      }));
    return Response.json(
      { aclVersion: board.acl_version, members },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  private listActivity(request: Request, actor: InternalActorContext, board: BoardRow): Response {
    this.requireOwner(board, actor.actorId);
    const url = new URL(request.url);
    const allowedParameters = new Set(["afterSeq", "limit"]);
    if ([...url.searchParams.keys()].some((key) => !allowedParameters.has(key))) {
      throw new HttpError(400, "BAD_REQUEST", "The activity query is invalid.");
    }
    if (
      url.searchParams.getAll("afterSeq").length > 1 ||
      url.searchParams.getAll("limit").length > 1
    ) {
      throw new HttpError(400, "BAD_REQUEST", "The activity query is invalid.");
    }
    const parseParameter = (
      name: "afterSeq" | "limit",
      fallback: number,
      minimum: number,
      maximum: number,
    ): number => {
      const raw = url.searchParams.get(name);
      if (raw === null) return fallback;
      if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
        throw new HttpError(400, "BAD_REQUEST", "The activity query is invalid.");
      }
      return requireSafeInteger(Number(raw), name, minimum, maximum);
    };
    const afterSeq = parseParameter("afterSeq", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = parseParameter("limit", 100, 1, 500);
    const rows = this.#sql
      .exec<{
        seq: number;
        action_id: string;
        actor_id: string;
        display_name: string;
        kind: string;
        affected_item_ids_json: string;
        accepted_at_ms: number;
      }>(
        `SELECT seq, action_id, actor_id, display_name, kind,
          affected_item_ids_json, accepted_at_ms
         FROM activity_log WHERE seq > ? ORDER BY seq LIMIT ?`,
        afterSeq,
        limit + 1,
      )
      .toArray();
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => {
      let itemIds: unknown;
      try {
        itemIds = JSON.parse(row.affected_item_ids_json);
      } catch {
        throw new HttpError(500, "INTERNAL_ERROR", "Stored activity data is invalid.");
      }
      if (!Array.isArray(itemIds) || itemIds.some((itemId) => typeof itemId !== "string")) {
        throw new HttpError(500, "INTERNAL_ERROR", "Stored activity data is invalid.");
      }
      return {
        seq: row.seq,
        actionId: row.action_id,
        actor: { id: row.actor_id, displayName: row.display_name },
        kind: row.kind,
        itemIds,
        acceptedAt: row.accepted_at_ms,
      };
    });
    return Response.json(
      {
        events,
        nextAfterSeq: events.at(-1)?.seq ?? afterSeq,
        hasMore,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  private async patchMember(
    request: Request,
    actor: InternalActorContext,
    targetActorId: string,
  ): Promise<Response> {
    const body = await readJsonBody(request, 8 * 1_024);
    assertExactKeys(body, ["role", "displayName", "expectedAclVersion"], ["expectedAclVersion"]);
    const expected = requireSafeInteger(
      body.expectedAclVersion,
      "expectedAclVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const role = body.role;
    if (role !== undefined && role !== "viewer" && role !== "editor" && role !== "owner") {
      throw new HttpError(400, "BAD_REQUEST", "The member role is invalid.");
    }
    const displayName =
      body.displayName === undefined ? undefined : requireDisplayName(body.displayName);
    if (role === undefined && displayName === undefined) {
      throw new HttpError(400, "BAD_REQUEST", "No member change was supplied.");
    }
    let aclVersion = expected;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      this.requireOwner(board, actor.actorId);
      this.checkAcl(board, expected);
      const member = this.#sql
        .exec<{
          role: BoardRole;
          display_name: string;
          updated_at_ms: number;
          revoked_at_ms: number | null;
        }>(
          "SELECT role, display_name, updated_at_ms, revoked_at_ms FROM members WHERE actor_id = ?",
          targetActorId,
        )
        .toArray()[0];
      if (member === undefined || member.revoked_at_ms !== null) {
        throw new HttpError(404, "NOT_FOUND", "Member not found.");
      }
      if (targetActorId === board.owner_actor_id && role !== undefined && role !== "owner") {
        throw new HttpError(409, "CONFLICT", "Transfer primary ownership before demoting it.");
      }
      aclVersion = board.acl_version + 1;
      const now = Math.max(Date.now(), member.updated_at_ms + 1);
      this.#sql.exec(
        "UPDATE members SET role = ?, display_name = ?, updated_at_ms = ? WHERE actor_id = ?",
        role ?? member.role,
        displayName ?? member.display_name,
        now,
        targetActorId,
      );
      this.#sql.exec(
        "UPDATE board SET acl_version = ?, updated_at_ms = ? WHERE singleton = 1",
        aclVersion,
        now,
      );
    });
    this.broadcastAccessChanged(targetActorId);
    this.log("info", "membership.changed", { requestId: actor.requestId, result: "updated" });
    return Response.json({ actorId: targetActorId, aclVersion });
  }

  private async revokeMember(
    request: Request,
    actor: InternalActorContext,
    targetActorId: string,
  ): Promise<Response> {
    const body = await readJsonBody(request, 4 * 1_024);
    assertExactKeys(body, ["expectedAclVersion"], ["expectedAclVersion"]);
    const expected = requireSafeInteger(
      body.expectedAclVersion,
      "expectedAclVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    let aclVersion = expected;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      this.requireOwner(board, actor.actorId);
      this.checkAcl(board, expected);
      const member = this.#sql
        .exec<{ role: BoardRole; updated_at_ms: number; revoked_at_ms: number | null }>(
          "SELECT role, updated_at_ms, revoked_at_ms FROM members WHERE actor_id = ?",
          targetActorId,
        )
        .toArray()[0];
      if (member === undefined || member.revoked_at_ms !== null) {
        throw new HttpError(404, "NOT_FOUND", "Member not found.");
      }
      if (targetActorId === board.owner_actor_id) {
        throw new HttpError(409, "CONFLICT", "The primary owner cannot be revoked.");
      }
      const now = Math.max(Date.now(), member.updated_at_ms + 1);
      aclVersion = board.acl_version + 1;
      this.#sql.exec(
        "UPDATE members SET revoked_at_ms = ?, updated_at_ms = ? WHERE actor_id = ?",
        now,
        now,
        targetActorId,
      );
      this.#sql.exec(
        "UPDATE board SET acl_version = ?, updated_at_ms = ? WHERE singleton = 1",
        aclVersion,
        now,
      );
    });
    this.broadcastAccessChanged(targetActorId);
    this.log("info", "membership.changed", { requestId: actor.requestId, result: "revoked" });
    return Response.json({ actorId: targetActorId, revoked: true, aclVersion });
  }

  private async patchSettings(request: Request, actor: InternalActorContext): Promise<Response> {
    const body = await readJsonBody(request, 8 * 1_024);
    assertExactKeys(
      body,
      ["title", "accessMode", "drawingPolicy", "imagesEnabled", "features", "expectedAclVersion"],
      ["expectedAclVersion"],
    );
    const expected = requireSafeInteger(
      body.expectedAclVersion,
      "expectedAclVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const title = body.title === undefined ? undefined : optionalTitle(body.title);
    const accessMode = body.accessMode;
    if (accessMode !== undefined && accessMode !== "private" && accessMode !== "link_view") {
      throw new HttpError(400, "BAD_REQUEST", "The access mode is invalid.");
    }
    const drawingPolicy = body.drawingPolicy;
    if (
      drawingPolicy !== undefined &&
      drawingPolicy !== "editors_enabled" &&
      drawingPolicy !== "owner_only" &&
      drawingPolicy !== "locked"
    ) {
      throw new HttpError(400, "BAD_REQUEST", "The drawing policy is invalid.");
    }
    const imagesEnabled = body.imagesEnabled;
    if (imagesEnabled !== undefined && typeof imagesEnabled !== "boolean") {
      throw new HttpError(400, "BAD_REQUEST", "The image upload setting is invalid.");
    }
    let featurePatch = body.features === undefined ? undefined : requireFeaturePatch(body.features);
    if (
      imagesEnabled !== undefined &&
      featurePatch?.images !== undefined &&
      featurePatch.images !== imagesEnabled
    ) {
      throw new HttpError(400, "BAD_REQUEST", "The image feature settings conflict.");
    }
    if (imagesEnabled !== undefined) {
      featurePatch = { ...(featurePatch ?? {}), images: imagesEnabled };
    }
    if (
      title === undefined &&
      accessMode === undefined &&
      drawingPolicy === undefined &&
      featurePatch === undefined
    ) {
      throw new HttpError(400, "BAD_REQUEST", "No setting change was supplied.");
    }
    let updated!: BoardRow;
    let updatedFeatures!: BoardFeatures;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      this.requireOwner(board, actor.actorId);
      this.checkAcl(board, expected);
      const currentFeatures = featuresForBoard(board);
      updatedFeatures = normalizeBoardFeatures({ ...currentFeatures, ...(featurePatch ?? {}) });
      if (title !== undefined && title !== board.title) {
        this.assertProspectiveSnapshotFits(
          board,
          {
            itemCount: board.snapshot_live_item_count,
            itemBytes: board.snapshot_live_item_bytes,
          },
          {
            seq: board.latest_seq,
            createdAt: snapshotCreatedAt(this.#sql, board),
            title,
          },
        );
      }
      const now = Date.now();
      this.#sql.exec(
        `UPDATE board SET title = ?, access_mode = ?, drawing_policy = ?, images_enabled = ?,
          features_json = ?,
          acl_version = acl_version + 1, updated_at_ms = ? WHERE singleton = 1`,
        title ?? board.title,
        accessMode ?? board.access_mode,
        drawingPolicy ?? board.drawing_policy,
        updatedFeatures.images ? 1 : 0,
        JSON.stringify(updatedFeatures),
        now,
      );
      updated = this.requireBoard();
    });
    this.broadcastAccessChanged();
    return Response.json({
      board: {
        title: updated.title,
        accessMode: updated.access_mode,
        drawingPolicy: updated.drawing_policy,
        imagesEnabled: updatedFeatures.images,
        features: updatedFeatures,
        aclVersion: updated.acl_version,
      },
    });
  }

  private async uploadImageAsset(
    request: Request,
    actor: InternalActorContext,
    capturedBoard: BoardRow,
  ): Promise<Response> {
    this.requireImageUploadAllowed(capturedBoard, actor.actorId);
    const contentEncoding = (request.headers.get("content-encoding") ?? "identity")
      .trim()
      .toLowerCase();
    if (request.headers.has("content-range") || contentEncoding !== "identity") {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "Encoded or partial image uploads are not supported.",
      );
    }
    const declaredMimeType = requireImageAssetMimeType(request.headers.get("content-type"));
    const bytes = await readBoundedBytes(request, MAX_IMAGE_ASSET_BYTES);
    if (bytes.byteLength === 0) {
      throw new HttpError(400, "BAD_REQUEST", "The image upload is empty.");
    }
    const parsed = parseImageAsset(bytes, declaredMimeType);
    const digest = await sha256Base64Url(bytes);
    const assetId = `asset_${digest}`;

    const status = await this.withAssetUploadLock(async () => {
      const now = Date.now();
      let wasCommitted = false;
      let r2Key = "";

      this.ctx.storage.transactionSync(() => {
        const board = this.requireBoard();
        this.requireImageUploadAllowed(board, actor.actorId);
        this.#sql.exec(
          "DELETE FROM board_assets WHERE state = 'pending' AND created_at_ms < ?",
          now - 15 * 60 * 1_000,
        );

        let row = this.readBoardAsset(assetId);
        if (row === null) {
          const usage = this.#sql
            .exec<{ asset_count: number; byte_count: number }>(
              "SELECT COUNT(*) AS asset_count, COALESCE(SUM(byte_count), 0) AS byte_count FROM board_assets",
            )
            .one();
          if (
            usage.asset_count >= MAX_IMAGE_ASSETS_PER_BOARD ||
            usage.byte_count + bytes.byteLength > MAX_IMAGE_ASSET_BYTES_PER_BOARD
          ) {
            throw new HttpError(
              413,
              "BOARD_LIMIT_REACHED",
              "This board has reached its private image storage limit.",
            );
          }
          r2Key = `boards/${board.public_id}/assets/${assetId}`;
          this.#sql.exec(
            "INSERT INTO board_assets(asset_id, sha256, r2_key, mime_type, intrinsic_width, intrinsic_height, byte_count, state, created_by, created_at_ms, committed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)",
            assetId,
            digest,
            r2Key,
            parsed.mimeType,
            parsed.intrinsicWidth,
            parsed.intrinsicHeight,
            bytes.byteLength,
            actor.actorId,
            now,
          );
          row = this.readBoardAsset(assetId);
        }
        if (row === null) {
          throw assetStorageUnavailable();
        }
        this.assertBoardAssetMatches(row, {
          assetId,
          digest,
          r2Key: `boards/${board.public_id}/assets/${assetId}`,
          mimeType: parsed.mimeType,
          intrinsicWidth: parsed.intrinsicWidth,
          intrinsicHeight: parsed.intrinsicHeight,
          byteCount: bytes.byteLength,
        });
        r2Key = row.r2_key;
        wasCommitted = row.state === "committed";
      });

      try {
        await putImmutableR2Object(this.env.BOARD_ASSETS, r2Key, bytes, {
          sha256: digest,
          httpMetadata: { contentType: parsed.mimeType },
        });
        this.ctx.storage.transactionSync(() => {
          const board = this.requireBoard();
          this.requireImageUploadAllowed(board, actor.actorId);
          const row = this.readBoardAsset(assetId);
          if (row === null) throw assetStorageUnavailable();
          this.assertBoardAssetMatches(row, {
            assetId,
            digest,
            r2Key,
            mimeType: parsed.mimeType,
            intrinsicWidth: parsed.intrinsicWidth,
            intrinsicHeight: parsed.intrinsicHeight,
            byteCount: bytes.byteLength,
          });
          if (row.state === "pending") {
            this.#sql.exec(
              "UPDATE board_assets SET state = 'committed', committed_at_ms = ? WHERE asset_id = ? AND state = 'pending'",
              Date.now(),
              assetId,
            );
          }
        });
      } catch (error) {
        if (!wasCommitted) {
          this.#sql.exec(
            "DELETE FROM board_assets WHERE asset_id = ? AND state = 'pending'",
            assetId,
          );
        }
        throw error;
      }

      return wasCommitted ? 200 : 201;
    });

    return Response.json(
      {
        assetId,
        mimeType: parsed.mimeType,
        intrinsicWidth: parsed.intrinsicWidth,
        intrinsicHeight: parsed.intrinsicHeight,
        sizeBytes: bytes.byteLength,
      },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  private async getImageAsset(
    actor: InternalActorContext,
    capturedBoard: BoardRow,
    assetId: string,
  ): Promise<Response> {
    const board = readBoard(this.#sql) ?? capturedBoard;
    this.requireView(board, actor.actorId);
    return this.streamImageAsset(board, assetId);
  }

  private async getOrganisationImageAsset(
    organisationId: string,
    assetId: string,
  ): Promise<Response> {
    if (!/^o_[A-Za-z0-9_-]{22}$/u.test(organisationId)) throw boardNotFoundError();
    const board = this.requireBoard();
    if (
      board.organisation_mode !== 1 ||
      board.organisation_id === null ||
      board.organisation_id !== organisationId
    ) {
      throw boardNotFoundError();
    }
    return this.streamImageAsset(board, assetId);
  }

  private async streamImageAsset(board: BoardRow, assetId: string): Promise<Response> {
    const row = this.readBoardAsset(assetId);
    if (row === null || row.state !== "committed") {
      throw new HttpError(404, "NOT_FOUND", "Image asset not found.");
    }
    const expectedKey = `boards/${board.public_id}/assets/${assetId}`;
    if (
      row.asset_id !== assetId ||
      row.sha256 !== assetId.slice("asset_".length) ||
      row.r2_key !== expectedKey
    ) {
      throw assetStorageUnavailable();
    }

    const object = await getR2Object(this.env.BOARD_ASSETS, expectedKey);
    if (object === null) throw assetStorageUnavailable();
    if (
      object.size !== row.byte_count ||
      object.customMetadata?.sha256 !== row.sha256 ||
      object.httpMetadata?.contentType !== row.mime_type
    ) {
      throw assetStorageUnavailable();
    }

    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": "inline",
        "Content-Length": String(row.byte_count),
        "Content-Type": row.mime_type,
        "Cross-Origin-Resource-Policy": "same-origin",
        Vary: "Cookie, Authorization",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  private readBoardAsset(assetId: string): BoardAssetRow | null {
    return (
      this.#sql
        .exec<BoardAssetRow>(
          "SELECT asset_id, sha256, r2_key, mime_type, intrinsic_width, intrinsic_height, byte_count, state, created_at_ms, committed_at_ms FROM board_assets WHERE asset_id = ?",
          assetId,
        )
        .toArray()[0] ?? null
    );
  }

  private assertBoardAssetMatches(
    row: BoardAssetRow,
    expected: {
      assetId: string;
      digest: string;
      r2Key: string;
      mimeType: ImageAssetMimeType;
      intrinsicWidth: number;
      intrinsicHeight: number;
      byteCount: number;
    },
  ): void {
    if (
      row.asset_id !== expected.assetId ||
      row.sha256 !== expected.digest ||
      row.r2_key !== expected.r2Key ||
      row.mime_type !== expected.mimeType ||
      row.intrinsic_width !== expected.intrinsicWidth ||
      row.intrinsic_height !== expected.intrinsicHeight ||
      row.byte_count !== expected.byteCount
    ) {
      throw assetStorageUnavailable();
    }
  }

  private async withAssetUploadLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#assetUploadTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#assetUploadTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async withWebhookDeliveryLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#webhookDeliveryTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#webhookDeliveryTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async archiveBoard(request: Request, actor: InternalActorContext): Promise<Response> {
    const body = await readJsonBody(request, 4 * 1_024);
    assertExactKeys(body, ["expectedAclVersion"], ["expectedAclVersion"]);
    const expected = requireSafeInteger(
      body.expectedAclVersion,
      "expectedAclVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const archivedAt = Date.now();
    let archived!: BoardRow;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      this.requireOwner(board, actor.actorId);
      this.checkAcl(board, expected);
      this.#sql.exec(
        `UPDATE board SET archived_at_ms = ?, acl_version = acl_version + 1,
         updated_at_ms = ? WHERE singleton = 1`,
        archivedAt,
        archivedAt,
      );
      archived = this.requireBoard();
    });

    // Closing happens only after the transaction has committed. A peer whose
    // attachment/session is no longer valid receives its ordinary terminal
    // close instead of being represented as a current archived participant.
    this.closeSocketsForArchive(archived);
    return Response.json({
      archived: true,
      archivedAt,
      aclVersion: archived.acl_version,
    });
  }

  private async claim(request: Request, actor: InternalActorContext): Promise<Response> {
    const body = await readJsonBody(request, 8 * 1_024);
    assertExactKeys(
      body,
      ["type", "token", "displayName", "confirmOwnershipTransfer"],
      ["type", "token"],
    );
    if (body.type !== "invite" && body.type !== "recovery") {
      throw new HttpError(400, "BAD_REQUEST", "The claim type is invalid.");
    }
    if (typeof body.token !== "string" || body.token.length < 32 || body.token.length > 256) {
      throw new HttpError(400, "BAD_REQUEST", "The claim token is invalid.");
    }
    const tokenHash = await sha256(body.token);
    const displayName =
      body.displayName === undefined
        ? fallbackDisplayName(actor.actorId)
        : requireDisplayName(body.displayName);
    const now = Date.now();

    if (body.type === "invite") {
      let role!: BoardRole;
      let aclVersion = 0;
      this.ctx.storage.transactionSync(() => {
        const board = this.requireBoard();
        const currentMember = this.#sql
          .exec<{ role: BoardRole; updated_at_ms: number; revoked_at_ms: number | null }>(
            "SELECT role, updated_at_ms, revoked_at_ms FROM members WHERE actor_id = ?",
            actor.actorId,
          )
          .toArray()[0];
        if (
          board.owner_actor_id === actor.actorId ||
          (currentMember?.role === "owner" && currentMember.revoked_at_ms === null)
        ) {
          throw new HttpError(
            409,
            "CONFLICT",
            "The active owner cannot claim a member invitation.",
          );
        }
        const invitation = this.#sql
          .exec<{
            invitation_id: string;
            role: BoardRole;
            max_uses: number;
            use_count: number;
            expires_at_ms: number;
            revoked_at_ms: number | null;
          }>(
            `SELECT invitation_id, role, max_uses, use_count, expires_at_ms, revoked_at_ms
             FROM invitations WHERE token_hash = ?`,
            tokenHash,
          )
          .toArray()[0];
        if (
          invitation === undefined ||
          invitation.revoked_at_ms !== null ||
          invitation.expires_at_ms <= now ||
          invitation.use_count >= invitation.max_uses
        ) {
          throw boardNotFoundError();
        }
        this.ensureBoardActive(board);
        if (currentMember === undefined) this.ensureMemberCapacity();
        role = invitation.role;
        const memberMutationAt = Math.max(now, (currentMember?.updated_at_ms ?? -1) + 1);

        this.#sql.exec(
          "UPDATE invitations SET use_count = use_count + 1 WHERE invitation_id = ?",
          invitation.invitation_id,
        );
        this.#sql.exec(
          `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms, revoked_at_ms)
           VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT(actor_id) DO UPDATE SET
             role = excluded.role,
             display_name = excluded.display_name,
             updated_at_ms = excluded.updated_at_ms,
             revoked_at_ms = NULL`,
          actor.actorId,
          role,
          displayName,
          now,
          memberMutationAt,
        );
        this.#sql.exec(
          `INSERT INTO history_state(actor_id, history_version, updated_at_ms)
           VALUES (?, 0, ?) ON CONFLICT(actor_id) DO NOTHING`,
          actor.actorId,
          now,
        );
        aclVersion = board.acl_version + 1;
        this.#sql.exec(
          "UPDATE board SET acl_version = ?, updated_at_ms = ? WHERE singleton = 1",
          aclVersion,
          memberMutationAt,
        );
      });
      this.broadcastAccessChanged(actor.actorId);
      return Response.json({ actor: { id: actor.actorId, role, displayName }, aclVersion });
    }

    if (body.confirmOwnershipTransfer !== true) {
      throw new HttpError(
        409,
        "CONFLICT",
        "Confirm ownership recovery before claiming this token.",
      );
    }
    const replacementToken = randomToken(32);
    const replacementHash = await sha256(replacementToken);
    let aclVersion = 0;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoardWithRecoveryHash();
      if (!constantTimeEqual(tokenHash, blobBytes(board.owner_recovery_hash))) {
        throw boardNotFoundError();
      }
      this.ensureBoardActive(board);
      const currentOwner = board.owner_actor_id;
      const recoveringMember = this.#sql
        .exec<{ updated_at_ms: number }>(
          "SELECT updated_at_ms FROM members WHERE actor_id = ?",
          actor.actorId,
        )
        .toArray()[0];
      const currentOwnerMember = this.#sql
        .exec<{ updated_at_ms: number }>(
          "SELECT updated_at_ms FROM members WHERE actor_id = ?",
          currentOwner,
        )
        .toArray()[0];
      const membershipChangedAt = Math.max(
        now,
        (recoveringMember?.updated_at_ms ?? -1) + 1,
        (currentOwnerMember?.updated_at_ms ?? -1) + 1,
      );
      if (recoveringMember === undefined) this.ensureMemberCapacity();
      if (currentOwner !== actor.actorId) {
        this.#sql.exec(
          "UPDATE members SET role = 'editor', updated_at_ms = ? WHERE actor_id = ? AND revoked_at_ms IS NULL",
          membershipChangedAt,
          currentOwner,
        );
      }
      this.#sql.exec(
        `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms, revoked_at_ms)
         VALUES (?, 'owner', ?, ?, ?, NULL)
         ON CONFLICT(actor_id) DO UPDATE SET
           role = 'owner', display_name = excluded.display_name,
           updated_at_ms = excluded.updated_at_ms, revoked_at_ms = NULL`,
        actor.actorId,
        displayName,
        now,
        membershipChangedAt,
      );
      aclVersion = board.acl_version + 1;
      this.#sql.exec(
        `UPDATE board SET owner_actor_id = ?, owner_recovery_hash = ?,
         acl_version = ?, updated_at_ms = ? WHERE singleton = 1`,
        actor.actorId,
        replacementHash,
        aclVersion,
        membershipChangedAt,
      );
    });
    this.broadcastAccessChanged();
    return Response.json({
      actor: { id: actor.actorId, role: "owner", displayName },
      aclVersion,
      ownerRecoveryToken: replacementToken,
    });
  }

  private async transferOwnership(
    request: Request,
    actor: InternalActorContext,
  ): Promise<Response> {
    const body = await readJsonBody(request, 8 * 1_024);
    assertExactKeys(
      body,
      ["targetActorId", "expectedAclVersion"],
      ["targetActorId", "expectedAclVersion"],
    );
    const targetActorId = requireActorId(body.targetActorId);
    const expected = requireSafeInteger(
      body.expectedAclVersion,
      "expectedAclVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (targetActorId === actor.actorId)
      throw new HttpError(409, "CONFLICT", "Choose another editor.");
    const initialBoard = this.requireBoard();
    this.requirePrimaryOwner(initialBoard, actor.actorId);
    this.checkAcl(initialBoard, expected);
    const recoveryToken = randomToken(32);
    const recoveryHash = await sha256(recoveryToken);
    const recoverySocket = this.findLiveActorSocket(targetActorId);
    if (recoverySocket === null) {
      throw new HttpError(
        409,
        "CONFLICT",
        "The target editor must be online to receive ownership recovery.",
      );
    }
    const now = Date.now();
    let aclVersion = expected;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      this.requirePrimaryOwner(board, actor.actorId);
      this.checkAcl(board, expected);
      const target = this.#sql
        .exec<{ role: BoardRole; updated_at_ms: number; revoked_at_ms: number | null }>(
          "SELECT role, updated_at_ms, revoked_at_ms FROM members WHERE actor_id = ?",
          targetActorId,
        )
        .toArray()[0];
      const eligibleRole =
        target?.role === "editor" || (board.classroom_mode === 1 && target?.role === "owner");
      if (target === undefined || target.revoked_at_ms !== null || !eligibleRole) {
        throw new HttpError(
          409,
          "CONFLICT",
          board.classroom_mode === 1
            ? "Primary ownership can only be transferred to an active editor or owner."
            : "Ownership can only be transferred to an active editor.",
        );
      }
      const currentPrimary = this.#sql
        .exec<{ updated_at_ms: number }>(
          "SELECT updated_at_ms FROM members WHERE actor_id = ?",
          actor.actorId,
        )
        .one();
      const membershipChangedAt = Math.max(
        now,
        target.updated_at_ms + 1,
        currentPrimary.updated_at_ms + 1,
      );
      if (board.classroom_mode !== 1) {
        this.#sql.exec(
          "UPDATE members SET role = 'editor', updated_at_ms = ? WHERE actor_id = ?",
          membershipChangedAt,
          actor.actorId,
        );
      }
      this.#sql.exec(
        "UPDATE members SET role = 'owner', updated_at_ms = ? WHERE actor_id = ?",
        membershipChangedAt,
        targetActorId,
      );
      aclVersion = board.acl_version + 1;
      this.#sql.exec(
        `UPDATE board SET owner_actor_id = ?, owner_recovery_hash = ?,
         acl_version = ?, updated_at_ms = ? WHERE singleton = 1`,
        targetActorId,
        recoveryHash,
        aclVersion,
        membershipChangedAt,
      );
    });
    this.broadcastAccessChanged();
    const recoveryTokenDelivered = this.sendOwnerRecoveryToken(
      recoverySocket,
      targetActorId,
      recoveryToken,
    );
    return Response.json({
      ownerActorId: targetActorId,
      aclVersion,
      recoveryTokenDelivered,
    });
  }

  private async rotateRecovery(request: Request, actor: InternalActorContext): Promise<Response> {
    const body = await readJsonBody(request, 4 * 1_024);
    assertExactKeys(body, ["expectedAclVersion"], ["expectedAclVersion"]);
    const expected = requireSafeInteger(
      body.expectedAclVersion,
      "expectedAclVersion",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const recoveryToken = randomToken(32);
    const recoveryHash = await sha256(recoveryToken);
    let aclVersion = expected;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      this.requirePrimaryOwner(board, actor.actorId);
      this.checkAcl(board, expected);
      aclVersion = board.acl_version + 1;
      this.#sql.exec(
        "UPDATE board SET owner_recovery_hash = ?, acl_version = ?, updated_at_ms = ? WHERE singleton = 1",
        recoveryHash,
        aclVersion,
        now,
      );
    });
    this.broadcastAccessChanged(actor.actorId);
    return Response.json({ ownerRecoveryToken: recoveryToken, aclVersion });
  }

  private async createInvitation(
    request: Request,
    actor: InternalActorContext,
    origin: string,
  ): Promise<Response> {
    const body = await readJsonBody(request, 8 * 1_024);
    assertExactKeys(
      body,
      ["role", "label", "maxUses", "expiresAtMs"],
      ["role", "maxUses", "expiresAtMs"],
    );
    if (body.role !== "viewer" && body.role !== "editor" && body.role !== "owner") {
      throw new HttpError(400, "BAD_REQUEST", "The invitation role is invalid.");
    }
    const label = parseOptionalLabel(body.label);
    const maxUses = requireSafeInteger(body.maxUses, "maxUses", 1, 50);
    const now = Date.now();
    const expiresAt = requireSafeInteger(
      body.expiresAtMs,
      "expiresAtMs",
      now + 1_000,
      now + 30 * 24 * 60 * 60 * 1_000,
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const requestHash = await sha256Base64Url(stableStringify(body));
    const board = this.requireBoard();
    this.requireOwner(board, actor.actorId);

    const existing = this.#sql
      .exec<{ request_hash: string; response_json: string }>(
        `SELECT request_hash, response_json FROM http_receipts
         WHERE actor_id = ? AND idempotency_key = ? AND operation = 'invitation.create'`,
        actor.actorId,
        idempotencyKey,
      )
      .toArray()[0];
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash) {
        throw new HttpError(
          409,
          "CONFLICT",
          "The idempotency key was reused with different input.",
        );
      }
      const metadata = JSON.parse(existing.response_json) as InvitationMetadata;
      const token = await this.rederiveInvitationToken(
        board.public_id,
        actor.actorId,
        idempotencyKey,
        requestHash,
        metadata.id,
      );
      return invitationResponse(origin, board.public_id, metadata, token, true);
    }

    const invitationId = randomOpaqueId("i_");
    const tokenBytes = await hmacSha256(
      this.env.SESSION_SIGNING_KEY_CURRENT,
      `invite:v1:${board.public_id}:${actor.actorId}:${idempotencyKey}:${requestHash}:${invitationId}`,
    );
    const token = bytesToBase64Url(tokenBytes);
    const tokenHash = await sha256(token);
    const metadata: InvitationMetadata = {
      id: invitationId,
      role: body.role,
      label,
      maxUses,
      expiresAt,
    };
    let finalMetadata = metadata;
    let inserted = false;
    this.ctx.storage.transactionSync(() => {
      const current = this.requireBoard();
      this.requireOwner(current, actor.actorId);
      const raced = this.#sql
        .exec<{ request_hash: string; response_json: string }>(
          `SELECT request_hash, response_json FROM http_receipts
           WHERE actor_id = ? AND idempotency_key = ? AND operation = 'invitation.create'`,
          actor.actorId,
          idempotencyKey,
        )
        .toArray()[0];
      if (raced !== undefined) {
        if (raced.request_hash !== requestHash) {
          throw new HttpError(
            409,
            "CONFLICT",
            "The idempotency key was reused with different input.",
          );
        }
        finalMetadata = JSON.parse(raced.response_json) as InvitationMetadata;
        return;
      }
      this.ensureInvitationCapacity();
      this.#sql.exec(
        `INSERT INTO invitations(
           invitation_id, token_hash, role, label, max_uses, expires_at_ms, created_by, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        invitationId,
        tokenHash,
        body.role,
        label,
        maxUses,
        expiresAt,
        actor.actorId,
        now,
      );
      this.writeHttpReceipt(
        actor.actorId,
        idempotencyKey,
        "invitation.create",
        requestHash,
        metadata,
        201,
      );
      inserted = true;
    });
    if (!inserted) {
      const racedToken = await this.rederiveInvitationToken(
        board.public_id,
        actor.actorId,
        idempotencyKey,
        requestHash,
        finalMetadata.id,
      );
      return invitationResponse(origin, board.public_id, finalMetadata, racedToken, true);
    }
    return invitationResponse(origin, board.public_id, finalMetadata, token, false);
  }

  private async rederiveInvitationToken(
    boardId: string,
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
    invitationId: string,
  ): Promise<string> {
    const invitation = this.#sql
      .exec<{ token_hash: ArrayBuffer }>(
        "SELECT token_hash FROM invitations WHERE invitation_id = ?",
        invitationId,
      )
      .toArray()[0];
    if (invitation === undefined)
      throw new HttpError(409, "CONFLICT", "The invitation receipt is unavailable.");
    const input = `invite:v1:${boardId}:${actorId}:${idempotencyKey}:${requestHash}:${invitationId}`;
    const keys = [
      this.env.SESSION_SIGNING_KEY_CURRENT,
      this.env.SESSION_SIGNING_KEY_PREVIOUS,
    ].filter((key): key is string => Boolean(key));
    for (const key of keys) {
      const candidate = bytesToBase64Url(await hmacSha256(key, input));
      if (constantTimeEqual(await sha256(candidate), blobBytes(invitation.token_hash)))
        return candidate;
    }
    throw new HttpError(409, "CONFLICT", "The invitation retry window has expired.");
  }

  private async revokeInvitation(
    _request: Request,
    actor: InternalActorContext,
    invitationId: string,
  ): Promise<Response> {
    const board = this.requireBoard();
    this.requireOwner(board, actor.actorId);
    const result = this.#sql.exec(
      "UPDATE invitations SET revoked_at_ms = ? WHERE invitation_id = ? AND revoked_at_ms IS NULL",
      Date.now(),
      invitationId,
    );
    if (result.rowsWritten === 0) throw new HttpError(404, "NOT_FOUND", "Invitation not found.");
    return Response.json({ invitationId, revoked: true });
  }

  private listSnapshots(actor: InternalActorContext, board: BoardRow): Response {
    this.requireOwner(board, actor.actorId);
    const snapshots = this.#sql
      .exec<{
        seq: number;
        sha256: string;
        item_count: number;
        byte_count: number;
        kind: "automatic" | "named" | "pre_clear";
        label: string | null;
        created_by: string | null;
        created_at_ms: number;
      }>(
        `SELECT seq, sha256, item_count, byte_count, kind, label, created_by, created_at_ms
         FROM snapshots ORDER BY seq DESC LIMIT 200`,
      )
      .toArray()
      .map((snapshot) => ({
        seq: snapshot.seq,
        sha256: snapshot.sha256,
        itemCount: snapshot.item_count,
        byteCount: snapshot.byte_count,
        kind: snapshot.kind,
        label: snapshot.label,
        createdBy: snapshot.created_by,
        createdAt: snapshot.created_at_ms,
      }));
    return Response.json({ snapshots }, { headers: { "Cache-Control": "no-store" } });
  }

  private async createNamedSnapshot(
    request: Request,
    actor: InternalActorContext,
  ): Promise<Response> {
    const body = await readJsonBody(request, 4 * 1_024);
    assertExactKeys(body, ["label"], ["label"]);
    const label = parseRequiredLabel(body.label);
    const idempotencyKey = requireIdempotencyKey(request);
    const requestHash = await sha256Base64Url(stableStringify(body));
    const initialBoard = this.requireBoard();
    this.requireOwner(initialBoard, actor.actorId);

    const prior = this.readHttpReceipt(actor.actorId, idempotencyKey, "snapshot.named");
    if (prior !== null) {
      this.checkReceiptHash(prior.request_hash, requestHash);
      return Response.json(JSON.parse(prior.response_json), { status: prior.status });
    }

    const snapshot = captureSnapshot(this.#sql, initialBoard);
    const snapshotAttribution = this.captureSnapshotAttribution(snapshot.items);
    const snapshotStartedAt = performance.now();
    let stored: Awaited<ReturnType<BoardRoom["persistSnapshotObject"]>>;
    try {
      stored = await this.persistSnapshotObject(snapshot);
    } catch (error) {
      this.log("error", "snapshot.failed", {
        requestId: actor.requestId,
        result: "failed",
        code: mapRoomError(error).code,
        seq: snapshot.seq,
        durationMs: Math.round(performance.now() - snapshotStartedAt),
        r2BytesWritten: 0,
      });
      throw error;
    }
    const responseBody: Record<string, unknown> = {
      snapshot: {
        seq: snapshot.seq,
        kind: "named",
        label,
        sha256: stored.sha256,
        itemCount: snapshot.items.length,
        byteCount: stored.bytes.byteLength,
        createdAt: snapshot.createdAt,
      },
    };
    let finalResponse = responseBody;
    let inserted = false;
    let recordedFrames = 0;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      this.requireOwner(board, actor.actorId);
      const raced = this.readHttpReceipt(actor.actorId, idempotencyKey, "snapshot.named");
      if (raced !== null) {
        this.checkReceiptHash(raced.request_hash, requestHash);
        finalResponse = JSON.parse(raced.response_json) as Record<string, unknown>;
        return;
      }
      const snapshotRowsWritten = this.#sql.exec(
        `INSERT INTO snapshots(
          seq, r2_json_key, sha256, item_count, byte_count, kind, label, created_by, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'named', ?, ?, ?)
        ON CONFLICT(seq) DO UPDATE SET
          kind = 'named',
          label = excluded.label,
          created_by = excluded.created_by`,
        snapshot.seq,
        stored.key,
        stored.sha256,
        snapshot.items.length,
        stored.bytes.byteLength,
        label,
        actor.actorId,
        snapshot.createdAt,
      ).rowsWritten;
      const snapshotAttributionRowsWritten = this.writeSnapshotAttribution(
        snapshot.seq,
        snapshotAttribution,
      );
      const receiptRowsWritten = this.writeHttpReceipt(
        actor.actorId,
        idempotencyKey,
        "snapshot.named",
        requestHash,
        responseBody,
        201,
      );
      recordedFrames = this.#pendingFrameCount;
      const boardRowsWritten = this.#sql.exec(
        `UPDATE board SET usage_checkpoint_seq = MAX(usage_checkpoint_seq, ?)
         WHERE singleton = 1`,
        snapshot.seq,
      ).rowsWritten;
      this.checkpointUsage(
        board.usage_checkpoint_seq,
        snapshot.seq,
        {
          incomingFrames: recordedFrames,
          rowsReadEstimate: snapshot.items.length + 5,
          rowsWrittenEstimate:
            stored.sqliteRowsWritten +
            snapshotRowsWritten +
            snapshotAttributionRowsWritten +
            receiptRowsWritten +
            boardRowsWritten,
          r2Reads: stored.r2Reads,
          r2Writes: stored.r2Writes,
          r2Bytes: stored.r2Bytes,
          snapshots: 1,
        },
        snapshot.createdAt,
      );
      inserted = true;
    });
    if (inserted) {
      this.#pendingFrameCount = Math.max(0, this.#pendingFrameCount - recordedFrames);
      this.log("info", "snapshot.completed", {
        requestId: actor.requestId,
        seq: snapshot.seq,
        itemCount: snapshot.items.length,
        result: "completed",
        code: "OK",
        durationMs: Math.round(performance.now() - snapshotStartedAt),
        r2BytesWritten: stored.r2Bytes,
      });
      this.emitBoardMetrics();
    }
    return Response.json(finalResponse, { status: 201 });
  }

  private async restoreSnapshot(
    request: Request,
    actor: InternalActorContext,
    snapshotSeq: number,
  ): Promise<Response> {
    if (!Number.isSafeInteger(snapshotSeq) || snapshotSeq < 0) {
      throw new HttpError(404, "NOT_FOUND", "Snapshot not found.");
    }
    const body = await readJsonBody(request, 4 * 1_024);
    assertExactKeys(body, ["expectedBoardSeq"], ["expectedBoardSeq"]);
    const expectedBoardSeq = requireSafeInteger(
      body.expectedBoardSeq,
      "expectedBoardSeq",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const requestHash = await sha256Base64Url(stableStringify({ snapshotSeq, ...body }));
    const initialBoard = this.requireBoard();
    this.requireOwner(initialBoard, actor.actorId);
    this.requireContentMutationAllowed(initialBoard, "owner");

    const prior = this.readHttpReceipt(actor.actorId, idempotencyKey, "snapshot.restore");
    if (prior !== null) {
      this.checkReceiptHash(prior.request_hash, requestHash);
      return Response.json(JSON.parse(prior.response_json), { status: prior.status });
    }
    if (initialBoard.latest_seq !== expectedBoardSeq) {
      throw new HttpError(409, "STALE_BOARD", "The board changed before restore.", {
        latestSeq: initialBoard.latest_seq,
      });
    }
    const metadata = this.#sql
      .exec<{ r2_json_key: string; sha256: string }>(
        "SELECT r2_json_key, sha256 FROM snapshots WHERE seq = ?",
        snapshotSeq,
      )
      .toArray()[0];
    if (metadata === undefined) throw new HttpError(404, "NOT_FOUND", "Snapshot not found.");
    const object = await getR2Object(this.env.BOARD_SNAPSHOTS, metadata.r2_json_key);
    if (object === null)
      throw new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Snapshot recovery data is unavailable.");
    if (object.size > MAX_SNAPSHOT_BYTES) {
      throw new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Snapshot recovery data is invalid.");
    }
    const bytes = await readR2ObjectBytes(object);
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Snapshot recovery data is invalid.");
    }
    const objectSha256 = await sha256Base64Url(bytes);
    if (
      objectSha256 !== metadata.sha256 ||
      (object.customMetadata?.sha256 !== undefined && object.customMetadata.sha256 !== objectSha256)
    ) {
      throw new HttpError(
        503,
        "TEMPORARILY_UNAVAILABLE",
        "Snapshot recovery data failed integrity verification.",
      );
    }
    let rawSnapshot: unknown;
    try {
      rawSnapshot = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      );
    } catch {
      throw new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Snapshot recovery data is invalid.");
    }
    const snapshot = parseStoredSnapshot(rawSnapshot, initialBoard.public_id);
    this.assertMoveCopyClosureTarget(snapshot.items);
    const snapshotAttribution = this.readSnapshotAttribution(snapshotSeq);
    const acceptedAt = Date.now();
    const commandId = crypto.randomUUID();
    const actionId = crypto.randomUUID();
    let action!: ServerAction;
    let responseBody!: Record<string, unknown>;
    let requiresResync = false;
    let snapshotScheduleRowsWritten = 0;
    let recordedFrames = 0;
    let commentsChanged = false;

    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      this.requireOwner(board, actor.actorId);
      this.requireContentMutationAllowed(board, "owner");
      const raced = this.readHttpReceipt(actor.actorId, idempotencyKey, "snapshot.restore");
      if (raced !== null) {
        this.checkReceiptHash(raced.request_hash, requestHash);
        responseBody = JSON.parse(raced.response_json) as Record<string, unknown>;
        return;
      }
      if (board.latest_seq !== expectedBoardSeq) {
        throw new HttpError(409, "STALE_BOARD", "The board changed before restore.", {
          latestSeq: board.latest_seq,
        });
      }
      const capacityRowsWritten = this.ensureActionCapacity(board);
      const seq = board.latest_seq + 1;
      const current = readAllItemRecords(this.#sql);
      assertItemsOutsideLockedSections(
        [...current.values()].flatMap((record) => (record.deleted ? [] : [record.item])),
        current,
      );
      const targetItems = snapshot.items.map(
        (item) => ({ ...structuredClone(item), version: seq }) as BoardItem,
      );
      const target = new Map(targetItems.map((item) => [item.id, item]));
      this.ensureItemIdentityCapacity(
        [...target.keys()].filter((itemId) => !current.has(itemId)).length,
        current.size,
      );
      const snapshotAccounting = snapshotAccountingForItems(targetItems);
      this.assertProspectiveSnapshotFits(board, snapshotAccounting, {
        seq,
        createdAt: acceptedAt,
      });
      const replacements: BoardItem[] = [];
      const removals: string[] = [];
      const restorations: string[] = [];
      const authoritativeOperations: Array<Record<string, unknown>> = [];
      let maximumZ = 0;
      let itemRowsWritten = 0;

      for (const [itemId, record] of current) {
        if (!record.deleted && !target.has(itemId)) {
          const tombstone = itemWriteFromState(
            { ...record.item, version: seq },
            true,
            crypto.randomUUID(),
          );
          itemRowsWritten += writeItem(this.#sql, tombstone);
          removals.push(itemId);
          authoritativeOperations.push({ kind: "item.delete", itemId, version: seq });
        }
      }
      for (const item of targetItems) {
        maximumZ = Math.max(maximumZ, item.z);
        itemRowsWritten += writeItem(
          this.#sql,
          itemWriteFromState(item, false, crypto.randomUUID()),
        );
        replacements.push(item);
        const wasLive = current.get(item.id)?.deleted === false;
        if (!wasLive) restorations.push(item.id);
        authoritativeOperations.push({ kind: wasLive ? "item.update" : "item.create", item });
      }
      const commentRowsWritten =
        this.orphanOpenComments(removals, acceptedAt) +
        this.restoreOrphanedComments(restorations, acceptedAt);
      commentsChanged = commentRowsWritten > 0;
      const attributionRowsWritten = this.replaceCurrentAttribution(
        targetItems,
        snapshotAttribution,
        snapshot.seq,
        snapshot.createdAt,
      );

      const expandedOperation: Record<string, unknown> = {
        kind: "items.batch",
        operations: authoritativeOperations,
      };
      const actionActor = {
        id: actor.actorId,
        displayName: this.requireOwner(board, actor.actorId).displayName,
      };
      const creators = this.restoredItemCreators(targetItems, actor.actorId);
      const actionBase = {
        v: 1,
        t: "server.action",
        seq,
        acceptedAt,
        actor: actionActor,
        commandId,
        actionId,
      } satisfies Omit<ServerAction, "creators" | "op">;
      const expandedAction: ServerAction = {
        ...actionBase,
        ...(creators.length > 0 ? { creators } : {}),
        op: expandedOperation,
      };
      requiresResync = utf8(JSON.stringify(expandedAction)).byteLength > MAX_PUBLIC_RESULT_BYTES;
      action = requiresResync
        ? { ...actionBase, op: { kind: "board.clear", removed: [] } }
        : expandedAction;
      const payload: StoredActionPayload = { publicResult: action, effects: [] };
      snapshotScheduleRowsWritten = this.upsertSnapshotJob(
        seq,
        acceptedAt,
        board.latest_snapshot_seq,
      );
      const invalidatedHistoryRows = this.invalidateAllHistory(acceptedAt);
      responseBody = { restoredFromSeq: snapshotSeq, seq, requiresResync };
      const receiptRowsWritten = this.writeHttpReceipt(
        actor.actorId,
        idempotencyKey,
        "snapshot.restore",
        requestHash,
        responseBody,
        200,
      );
      const boardRowsWritten = this.#sql.exec(
        `UPDATE board SET latest_seq = ?, next_z = ?, updated_at_ms = ?,
         dirty_since_seq = COALESCE(dirty_since_seq, ?),
         dirty_since_at_ms = COALESCE(dirty_since_at_ms, ?),
         snapshot_live_item_count = ?, snapshot_live_item_bytes = ?,
         min_replay_seq = CASE WHEN ? THEN ? ELSE min_replay_seq END
         WHERE singleton = 1`,
        seq,
        Math.max(board.next_z, maximumZ + 1),
        acceptedAt,
        seq,
        acceptedAt,
        snapshotAccounting.itemCount,
        snapshotAccounting.itemBytes,
        requiresResync ? 1 : 0,
        seq,
      ).rowsWritten;
      recordedFrames = this.#pendingFrameCount;
      const rowsReadEstimate = current.size + targetItems.length + 12;
      const rowsWrittenEstimate =
        capacityRowsWritten +
        itemRowsWritten +
        attributionRowsWritten +
        commentRowsWritten +
        invalidatedHistoryRows +
        receiptRowsWritten +
        boardRowsWritten +
        ACTION_INSERT_BILLED_ROWS +
        snapshotScheduleRowsWritten +
        (snapshotScheduleRowsWritten > 0 ? 1 : 0);
      const actionRowsWritten = this.#sql.exec(
        `INSERT INTO actions(
          seq, action_id, command_id, request_hash, actor_id, kind, payload_json,
          affected_item_ids_json, undoable, accepted_at_ms, usage_incoming_frames,
          usage_rows_read_estimate, usage_rows_written_estimate, usage_r2_reads
        ) VALUES (?, ?, ?, ?, ?, 'board.restore', ?, ?, 0, ?, ?, ?, ?, 1)`,
        seq,
        actionId,
        commandId,
        requestHash,
        actor.actorId,
        JSON.stringify(payload),
        JSON.stringify([...new Set([...removals, ...replacements.map((item) => item.id)])]),
        acceptedAt,
        recordedFrames,
        rowsReadEstimate,
        rowsWrittenEstimate,
      ).rowsWritten;
      if (actionRowsWritten !== ACTION_INSERT_BILLED_ROWS) {
        throw new BoardDomainError("INTERNAL_ERROR", "Action billing accounting drifted.");
      }
    });

    if (action !== undefined) {
      this.#pendingFrameCount = Math.max(0, this.#pendingFrameCount - recordedFrames);
      if (commentsChanged) this.broadcastCommentsRefresh();
      if (requiresResync)
        this.broadcastResyncRequired("Snapshot restore requires a fresh bootstrap.");
      else this.broadcastAction(action);
      this.broadcastAllHistoryStates();
      if (snapshotScheduleRowsWritten > 0) this.scheduleNextAlarmAfterCommit();
    }
    return Response.json(responseBody);
  }

  private async exportJson(
    actor: InternalActorContext,
    capturedBoard: BoardRow,
  ): Promise<Response> {
    const board = readBoard(this.#sql) ?? capturedBoard;
    this.requireView(board, actor.actorId);
    const snapshot = captureSnapshot(this.#sql, board);
    return this.canonicalExportResponse(board, snapshot);
  }

  private async exportForOrganisation(request: Request): Promise<Response> {
    const body = await readJsonBody(request, 4 * 1_024);
    assertExactKeys(body, ["organisationId", "format"], ["organisationId", "format"]);
    if (
      typeof body.organisationId !== "string" ||
      !ORGANISATION_ID_PATTERN.test(body.organisationId)
    ) {
      throw new HttpError(400, "BAD_REQUEST", "The organisation ID is invalid.");
    }
    if (body.format !== "canonical" && body.format !== "attributed") {
      throw new HttpError(400, "BAD_REQUEST", "The export format is invalid.");
    }
    const board = this.requireBoard();
    if (board.organisation_mode !== 1 || board.organisation_id !== body.organisationId) {
      throw boardNotFoundError();
    }
    const snapshot = captureSnapshot(this.#sql, board);
    return body.format === "canonical"
      ? this.canonicalExportResponse(board, snapshot)
      : this.attributedExportResponse(board, snapshot, true);
  }

  private async canonicalExportResponse(
    board: BoardRow,
    snapshot: CanonicalSnapshot,
  ): Promise<Response> {
    const body = appendSectionExportSummaries(
      serializeSnapshot(snapshot),
      buildSectionExportSummaries(snapshot.items),
    );
    const etag = `"${await sha256Base64Url(body)}"`;
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="whiteboard-${board.public_id}.json"`,
        "Cache-Control": "no-store",
        "X-Whiteboard-Seq": String(snapshot.seq),
        ETag: etag,
      },
    });
  }

  private async exportAttributedJson(
    actor: InternalActorContext,
    capturedBoard: BoardRow,
  ): Promise<Response> {
    const board = readBoard(this.#sql) ?? capturedBoard;
    this.requireOwner(board, actor.actorId);
    const snapshot = captureSnapshot(this.#sql, board);
    return this.attributedExportResponse(board, snapshot, false);
  }

  private async attributedExportResponse(
    board: BoardRow,
    snapshot: CanonicalSnapshot,
    includeExternalParticipantIds: boolean,
  ): Promise<Response> {
    const exportObject = this.attributedExportObject(
      board,
      snapshot,
      includeExternalParticipantIds,
    );
    const body = JSON.stringify(exportObject);
    const etag = `"${await sha256Base64Url(body)}"`;
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="whiteboard-${board.public_id}-attributed.json"`,
        "Cache-Control": "no-store",
        "X-Whiteboard-Seq": String(snapshot.seq),
        ETag: etag,
      },
    });
  }

  private attributedExportObject(
    board: BoardRow,
    snapshot: CanonicalSnapshot,
    includeExternalParticipantIds: boolean,
  ) {
    const itemAttribution = this.readItemAttributionMap(snapshot.items);
    const referencedActorIds = new Set<string>();
    for (const item of snapshot.items) {
      referencedActorIds.add(item.createdBy);
      collectAttributionActorIds(itemAttribution.get(item.id), referencedActorIds);
    }
    const memberRows = this.#sql
      .exec<{
        actor_id: string;
        display_name: string;
        external_participant_id: string | null;
        role: BoardRole;
        revoked_at_ms: number | null;
      }>(
        `SELECT actor_id, display_name, external_participant_id, role, revoked_at_ms
         FROM members ORDER BY created_at_ms, actor_id`,
      )
      .toArray();
    const participantIds = new Map(
      memberRows.map((member) => [member.actor_id, member.external_participant_id]),
    );
    const directory = this.exportActorDirectory(referencedActorIds);
    const actorRef = (actorId: string | null): ExportActor | null => {
      if (actorId === null) return null;
      const reference = directory.get(actorId) ?? {
        id: actorId,
        displayName: fallbackDisplayName(actorId),
        participantHash: actorId,
      };
      return includeExternalParticipantIds
        ? { ...reference, participantId: participantIds.get(actorId) ?? null }
        : reference;
    };
    const participants: Array<{
      id: string;
      displayName: string;
      participantHash: string;
      participantId?: string | null;
      role: BoardRole | null;
      status: "active" | "revoked" | "referenced";
    }> = memberRows.map((member) => ({
      id: member.actor_id,
      displayName: member.display_name,
      participantHash: member.actor_id,
      ...(includeExternalParticipantIds ? { participantId: member.external_participant_id } : {}),
      role: member.role,
      status: member.revoked_at_ms === null ? "active" : "revoked",
    }));
    const memberIds = new Set(participants.map((participant) => participant.id));
    for (const actorId of [...referencedActorIds].sort()) {
      if (memberIds.has(actorId)) continue;
      const reference = actorRef(actorId);
      if (reference === null) continue;
      participants.push({
        ...reference,
        ...(includeExternalParticipantIds ? { participantId: null } : {}),
        role: null,
        status: "referenced",
      });
    }
    const objects = snapshot.items.map((item) => {
      const attribution = itemAttribution.get(item.id) ?? this.fallbackItemAttribution(item);
      return {
        item,
        attribution: {
          createdBy: actorRef(item.createdBy),
          lastModifiedBy: actorRef(attribution.lastModifiedBy),
          updatedSeq: attribution.updatedSeq,
          updatedAt: attribution.updatedAt,
        },
        content: exportItemContent(item, attribution, actorRef),
      };
    });
    return {
      format: "cf-whiteboard-attributed-json",
      version: 1,
      board: {
        id: board.public_id,
        title: board.title,
        seq: snapshot.seq,
        stateCreatedAt: snapshot.createdAt,
      },
      participants,
      sections: buildSectionExportSummaries(snapshot.items),
      objects,
    };
  }

  private async exportSvg(actor: InternalActorContext, capturedBoard: BoardRow): Promise<Response> {
    const board = readBoard(this.#sql) ?? capturedBoard;
    this.requireView(board, actor.actorId);
    const snapshot = captureSnapshot(this.#sql, board);
    const body = serializeAuthoritativeSvg({
      boardId: board.public_id,
      seq: snapshot.seq,
      title: board.title,
      items: snapshot.items,
    });
    const etag = `"${await sha256Base64Url(body)}"`;
    return new Response(body, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="whiteboard-${board.public_id}.svg"`,
        "Cache-Control": "no-store",
        "X-Whiteboard-Seq": String(snapshot.seq),
        ETag: etag,
      },
    });
  }

  private upgradeWebSocket(
    request: Request,
    actor: InternalActorContext,
    capturedBoard: BoardRow,
  ): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(426, "BAD_REQUEST", "A WebSocket upgrade is required.");
    }
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "since" && key !== "client")) {
      throw new HttpError(400, "BAD_REQUEST", "The WebSocket query is invalid.");
    }
    if (
      url.searchParams.getAll("since").length !== 1 ||
      url.searchParams.getAll("client").length !== 1
    ) {
      throw new HttpError(400, "BAD_REQUEST", "The WebSocket query is invalid.");
    }
    const sinceRaw = url.searchParams.get("since") ?? "";
    if (!/^(?:0|[1-9]\d*)$/u.test(sinceRaw))
      throw new HttpError(400, "BAD_REQUEST", "since is invalid.");
    const since = Number(sinceRaw);
    if (!Number.isSafeInteger(since)) throw new HttpError(400, "BAD_REQUEST", "since is invalid.");
    const clientInstanceId = requireOpaqueId(url.searchParams.get("client"), "client instance ID");
    const board = readBoard(this.#sql) ?? capturedBoard;
    const access = this.requireView(board, actor.actorId);
    const features = featuresForBoard(board);
    const activeSockets = this.activeSocketCounts(actor.actorId);
    if (activeSockets.actor >= MAX_CONNECTIONS_PER_ACTOR) {
      throw new HttpError(
        429,
        "RATE_LIMITED",
        "This device has reached its connection limit for the board.",
      );
    }
    if (activeSockets.total >= LIMITS.maxConnections) {
      throw new HttpError(429, "BOARD_FULL", "This board has reached its connection limit.");
    }
    const history = this.historyState(actor.actorId);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      v: 1,
      connectionId: crypto.randomUUID(),
      actorId: actor.actorId,
      displayName: access.displayName,
      role: access.role,
      aclVersion: board.acl_version,
      sessionExpiresAt: actor.sessionExpiresAt,
      clientInstanceId,
      connectedAt: Date.now(),
      state: "syncing",
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`actor:${actor.actorId}`]);
    this.log("info", "socket.connected", {
      requestId: actor.requestId,
      protocolVersion: 1,
      result: access.role,
    });
    this.emitBoardMetrics();

    const replayMetrics: ReplayMetrics = { actions: 0, bytes: 0 };
    try {
      sendJson(server, {
        v: 1,
        t: "server.welcome",
        actor: { id: actor.actorId, displayName: access.displayName, role: access.role },
        drawingPolicy: board.drawing_policy,
        imagesEnabled: features.images,
        features,
        aclVersion: board.acl_version,
        historyVersion: history.historyVersion,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        sessionExpiresAt: actor.sessionExpiresAt,
        protocolVersion: 1,
        latestSeq: board.latest_seq,
        limits: LIMITS,
      });

      if (since < board.min_replay_seq || since > board.latest_seq) {
        this.resyncSocket(server, board.latest_seq, "Replay history is unavailable.");
        this.log("warn", "replay.unavailable", {
          requestId: actor.requestId,
          result: "resync_required",
          code: "REPLAY_UNAVAILABLE",
          replayActions: 0,
          replayBytes: 0,
          resyncRequired: true,
        });
        return webSocketUpgradeResponse(client, request);
      }

      let cursor = since;
      let rounds = 0;
      while (rounds < MAX_CATCH_UP_ROUNDS) {
        const highWater = this.requireBoard().latest_seq;
        if (cursor < highWater) {
          const sent = this.sendReplayRange(server, cursor, highWater);
          replayMetrics.actions += sent.actions;
          replayMetrics.bytes += sent.bytes;
        }
        cursor = highWater;
        if (this.requireBoard().latest_seq === cursor) break;
        rounds += 1;
      }
      if (this.requireBoard().latest_seq !== cursor) {
        this.resyncSocket(server, this.requireBoard().latest_seq, "Could not catch up.");
        this.log("warn", "replay.unavailable", {
          requestId: actor.requestId,
          result: "resync_required",
          code: "REPLAY_UNAVAILABLE",
          replayActions: replayMetrics.actions,
          replayBytes: replayMetrics.bytes,
          resyncRequired: true,
        });
      } else {
        attachment.state = "live";
        server.serializeAttachment(attachment);
        sendJson(server, { v: 1, t: "server.ready", latestSeq: cursor });
        // Presence is ephemeral and must never overtake startup replay/ready.
        this.broadcastPresenceState();
        this.log("info", "replay.completed", {
          requestId: actor.requestId,
          result: "ready",
          code: "OK",
          replayActions: replayMetrics.actions,
          replayBytes: replayMetrics.bytes,
          resyncRequired: false,
        });
      }
    } catch (error) {
      const latestSeq = readBoard(this.#sql)?.latest_seq ?? board.latest_seq;
      this.resyncSocket(server, latestSeq, "Replay history could not be delivered.");
      this.log("warn", "replay.unavailable", {
        requestId: actor.requestId,
        result: "resync_required",
        code: mapRoomError(error).code,
        replayActions: replayMetrics.actions,
        replayBytes: replayMetrics.bytes,
        resyncRequired: true,
      });
    }
    return webSocketUpgradeResponse(client, request);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const messageStartedAt = performance.now();
    let attachment: SocketAttachment;
    try {
      attachment = parseAttachment(socket.deserializeAttachment());
    } catch {
      socket.close(1008, "Invalid connection state");
      return;
    }
    if (Date.now() >= attachment.sessionExpiresAt) {
      socket.close(4001, "Session expired");
      return;
    }
    if (typeof message !== "string") {
      socket.close(1003, "Binary frames are unsupported");
      return;
    }
    const frameBytes = utf8(message).byteLength;
    let frame: ClientFrame | undefined;
    try {
      frame = parseClientFrame(message);
      this.recordIncomingFrame();
      if (frame.t === "client.preview") {
        this.recordTrafficFrame("preview");
        const now = Date.now();
        if (
          !this.#buckets.consume(
            "board:preview-pressure",
            PREVIEW_SHED_TRIGGER_PER_SECOND,
            PREVIEW_SHED_TRIGGER_PER_SECOND,
            now,
          )
        ) {
          this.#previewOverloadedUntil = now + 1_000;
          if (this.#buckets.consume("board:preview-overload-warning", 1 / 60, 1, now)) {
            this.log("warn", "room.overloaded", {
              code: "PREVIEW_RELAY_SHED",
              frameBytes,
              result: "preview_dropped",
            });
          }
        }
        // Dropped ephemeral traffic cannot mutate or reveal board state. An
        // admitted frame still performs the authoritative board/ACL checks,
        // so owner-driven revocation remains immediate while sustained stress
        // revalidates every actor at least once per second.
        if (
          now < this.#previewOverloadedUntil &&
          !this.#buckets.consume(
            `actor:${attachment.actorId}:preview-overload`,
            OVERLOADED_PREVIEW_HZ_PER_ACTOR,
            1,
            now,
          )
        ) {
          return;
        }
      }
      const board = this.requireBoard();
      attachment = this.refreshAttachment(socket, attachment, board);
      switch (frame.t) {
        case "client.commit":
          this.recordTrafficFrame("commit");
          await this.handleCommit(socket, attachment, frame, frameBytes, messageStartedAt);
          break;
        case "client.preview":
          this.handlePreview(socket, attachment, frame, frameBytes, board);
          break;
        case "client.presence":
          this.handlePresence(socket, attachment, frame, board);
          break;
        case "client.facilitation.spotlight":
          this.handleFacilitationSpotlight(socket, attachment, frame, board);
          break;
        case "client.sync_check":
          this.handleSyncCheck(socket, attachment, frame, board);
          break;
        default:
          throw new BoardDomainError("INVALID_FRAME", "Unknown frame type.");
      }
    } catch (error) {
      const mapped = mapRoomError(error);
      if (mapped.status === 410) {
        socket.close(4011, "Board archived");
        return;
      }
      if (mapped.code === "REPLAY_UNAVAILABLE") {
        this.resyncSocket(
          socket,
          readBoard(this.#sql)?.latest_seq ?? 0,
          "Replay history could not be delivered.",
        );
        return;
      }
      const commandId =
        isRecord(frame) && typeof frame.commandId === "string" ? frame.commandId : undefined;
      sendJson(socket, {
        v: 1,
        t: "server.rejected",
        ...(commandId ? { commandId } : {}),
        code: mapped.code,
        message: mapped.message,
        latestSeq: readBoard(this.#sql)?.latest_seq ?? 0,
        ...(mapped.details ?? {}),
      });
      if (frame?.t === "client.commit") {
        this.log(mapped.status >= 500 ? "error" : "warn", "command.rejected", {
          protocolVersion: 1,
          actionKind: frame.op.kind,
          code: mapped.code,
          frameBytes,
          result: "rejected",
          durationMs: Math.round(performance.now() - messageStartedAt),
        });
      }
      if (mapped.code === "MESSAGE_TOO_LARGE") socket.close(1009, "Message too large");
      if (mapped.code === "AUTH_REQUIRED") socket.close(4001, "Authentication required");
      if (mapped.code === "UNSUPPORTED_VERSION") {
        socket.close(1002, "Unsupported protocol version; reload required");
      }
      if (
        mapped.code === "INVALID_FRAME" &&
        !this.#buckets.consume(`${attachment.connectionId}:invalid`, 1, 5)
      ) {
        socket.close(1008, "Invalid frame rate limit exceeded");
      }
    }
  }

  webSocketClose(socket: WebSocket, code: number, _reason: string, _wasClean: boolean): void {
    let connectionId = "unknown";
    try {
      connectionId = parseAttachment(socket.deserializeAttachment()).connectionId;
    } catch {
      // Stored attachments are hostile input after wake-up.
    }
    this.#buckets.deletePrefix(`${connectionId}:`);
    this.cleanupActorRateBuckets(socket);
    if (this.#boardDeletion !== null || readBoard(this.#sql) === null) return;
    this.broadcastPresenceState(socket);
    this.log("info", "socket.disconnected", { closeCode: code, result: "closed" });
    this.flushTrafficMetrics(true);
    this.emitBoardMetrics(true);
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    try {
      const attachment = parseAttachment(socket.deserializeAttachment());
      this.#buckets.deletePrefix(`${attachment.connectionId}:`);
      this.cleanupActorRateBuckets(socket, attachment.actorId);
    } catch {
      // Ignore malformed attachment during error cleanup.
    }
    if (this.#boardDeletion !== null || readBoard(this.#sql) === null) return;
    this.broadcastPresenceState(socket);
    socket.close(1011, "WebSocket error");
  }

  private async handleCommit(
    socket: WebSocket,
    attachment: SocketAttachment,
    frame: unknown,
    frameBytes: number,
    startedAt: number,
  ): Promise<void> {
    const parsed = parseCommitFrame(frame);
    const isHistory = parsed.op.kind === "history.undo" || parsed.op.kind === "history.redo";
    const trafficClass = isHistory ? "history" : "commit";
    const connectionAllowed = isHistory
      ? this.#buckets.consume(`${attachment.connectionId}:${trafficClass}`, 2, 4)
      : this.#buckets.consume(`${attachment.connectionId}:${trafficClass}`, 5, 10);
    const actorAllowed = isHistory
      ? this.#buckets.consume(`actor:${attachment.actorId}:${trafficClass}`, 2, 4)
      : this.#buckets.consume(`actor:${attachment.actorId}:${trafficClass}`, 5, 10);
    // History transitions and ordinary commits contend for the same board-wide
    // durable-write capacity so alternating traffic cannot double the limit.
    const boardAllowed = this.#buckets.consume("board:durable", 50, 75);
    if (!connectionAllowed || !actorAllowed || !boardAllowed) {
      this.log("warn", "rate_limit.triggered", {
        code: "RATE_LIMITED",
        frameBytes,
        result: "durable_command_rejected",
      });
      throw new BoardDomainError("RATE_LIMITED", "Too many durable commands.");
    }
    const requestHash = await sha256Base64Url(
      canonicalRequestHashInput(parsed as unknown as import("@collab/protocol").ClientCommitFrame),
    );
    const duplicate = this.findDuplicateAction(parsed.commandId, attachment.actorId, requestHash);
    if (duplicate !== null) {
      this.requireView(this.requireBoard(), attachment.actorId);
      sendJson(socket, duplicate);
      return;
    }

    let metrics: CommitMetrics | null;
    const execution: CommitExecution = { transactionStarted: false };
    try {
      if (parsed.op.kind === "history.undo" || parsed.op.kind === "history.redo") {
        metrics = this.commitHistory(socket, attachment, parsed, requestHash, execution);
      } else if (parsed.op.kind === "board.clear") {
        metrics = await this.commitClear(socket, attachment, parsed, requestHash, execution);
      } else {
        metrics = this.commitNormal(socket, attachment, parsed, requestHash, execution);
      }
    } catch (error) {
      const mapped = mapRoomError(error);
      if (execution.transactionStarted) {
        this.log(mapped.status >= 500 ? "error" : "warn", "storage.transaction_completed", {
          result: "rolled_back",
          code: mapped.code,
          durationMs: Math.round(performance.now() - startedAt),
          sqliteRowsRead: 0,
          sqliteRowsWritten: 0,
        });
      }
      throw error;
    }
    if (metrics === null) return;
    const durationMs = Math.round(performance.now() - startedAt);
    this.log("info", "storage.transaction_completed", {
      result: "committed",
      code: "OK",
      durationMs: metrics.sqliteDurationMs,
      sqliteRowsRead: metrics.sqliteRowsRead,
      sqliteRowsWritten: metrics.sqliteRowsWritten,
    });
    this.log("info", "command.accepted", {
      protocolVersion: 1,
      actionKind: metrics.actionKind,
      result: "committed",
      code: "OK",
      seq: metrics.seq,
      durationMs,
    });
    this.emitBoardMetrics();
  }

  private commitNormal(
    socket: WebSocket,
    attachment: SocketAttachment,
    command: ParsedCommit,
    requestHash: string,
    execution: CommitExecution,
  ): CommitMetrics | null {
    const operation = command.op;
    if (
      operation.kind === "history.undo" ||
      operation.kind === "history.redo" ||
      operation.kind === "board.clear"
    ) {
      throw new BoardDomainError("INVALID_FRAME", "The command was routed incorrectly.");
    }
    let action!: ServerAction;
    let duplicate: ServerAction | null = null;
    let history!: ReturnType<BoardRoom["historyState"]>;
    let snapshotScheduleRowsWritten = 0;
    let recordedFrames = 0;
    let sqliteRowsRead = 0;
    let sqliteRowsWritten = 0;
    let commentsOrphaned = false;
    const transactionStartedAt = performance.now();
    execution.transactionStarted = true;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      const access = this.requireView(board, attachment.actorId);
      const raced = this.findDuplicateAction(command.commandId, attachment.actorId, requestHash);
      if (raced !== null) {
        duplicate = raced;
        return;
      }
      this.requireContentMutationAllowed(board, access.role);
      if (this.actionIdExists(command.actionId)) {
        throw new BoardDomainError("INVALID_FRAME", "The action ID was already used.");
      }
      const capacityRowsWritten = this.ensureActionCapacity(board);
      this.ensureItemIdentityCapacity(newItemIdentityCount(operation));
      const seq = board.latest_seq + 1;
      const records = readItems(this.#sql, affectedIds(operation));
      const sectionRecords = readItems(this.#sql, sectionRecordIdsForMutation(operation, records));
      for (const [itemId, record] of sectionRecords) records.set(itemId, record);
      assertOperationFeaturesEnabled(featuresForBoard(board), operation, records);
      const prepared = prepareOwnedItemOperation(operation, records, {
        seq,
        actorId: attachment.actorId,
        role: access.role,
        nextZ: board.next_z,
        liveCount: board.snapshot_live_item_count,
      });
      for (const write of prepared.writes.values()) {
        const item = write.item as unknown as ProtocolBoardItem;
        if (!write.deleted && item.kind === "image") {
          this.requireCommittedImageAsset(board, item);
        }
      }
      const topologyRowsRead = this.assertProspectiveMoveCopyClosure(
        prepared.effects,
        "after",
        undefined,
        { actorId: attachment.actorId, role: access.role },
      );
      const acceptedAt = Date.now();
      action = {
        v: 1,
        t: "server.action",
        seq,
        acceptedAt,
        actor: { id: attachment.actorId, displayName: access.displayName },
        commandId: command.commandId,
        actionId: command.actionId,
        op: prepared.publicOperation,
      };
      const attributionEffects = this.deriveAttributionEffects(
        prepared.effects,
        attachment.actorId,
        seq,
        acceptedAt,
      );
      const payload: StoredActionPayload = {
        publicResult: action,
        effects: prepared.effects,
        attributionEffects,
      };
      const publicBytes = utf8(JSON.stringify(action)).byteLength;
      const payloadJson = JSON.stringify(payload);
      if (
        publicBytes > MAX_PUBLIC_RESULT_BYTES ||
        utf8(payloadJson).byteLength > MAX_ACTION_PAYLOAD_BYTES
      ) {
        throw new BoardDomainError("MESSAGE_TOO_LARGE", "The authoritative action is too large.");
      }
      const snapshotAccounting = this.projectSnapshotAccounting(
        board,
        [...prepared.writes].map(([itemId, write]) => ({
          before: records.get(itemId),
          ...(write.deleted ? {} : { after: write.item }),
        })),
      );
      this.assertProspectiveSnapshotFits(board, snapshotAccounting, {
        seq,
        createdAt: acceptedAt,
      });
      snapshotScheduleRowsWritten = this.upsertSnapshotJob(
        seq,
        acceptedAt,
        board.latest_snapshot_seq,
      );
      let itemRowsWritten = 0;
      for (const write of prepared.writes.values()) {
        itemRowsWritten += writeItem(this.#sql, write);
      }
      const commentRowsWritten = this.orphanOpenComments(
        [...prepared.writes.values()]
          .filter((write) => write.deleted)
          .map((write) => write.item.id),
        acceptedAt,
      );
      commentsOrphaned = commentRowsWritten > 0;
      const attributionRowsWritten = this.applyAttributionEffects(attributionEffects, "after");
      const invalidatedHistory = this.#sql.exec(
        "UPDATE history_entries SET state = 'invalidated', last_transition_seq = ? WHERE actor_id = ? AND state = 'undone'",
        seq,
        attachment.actorId,
      );
      const historyRowsWritten = this.#sql.exec(
        `INSERT INTO history_entries(
           normal_action_seq, actor_id, state, last_transition_seq, action_id, payload_json
         ) VALUES (?, ?, 'active', ?, ?, ?)`,
        seq,
        attachment.actorId,
        seq,
        command.actionId,
        payloadJson,
      ).rowsWritten;
      const historyVersion = this.incrementHistoryVersion(attachment.actorId, acceptedAt);
      const boardRowsWritten = this.#sql.exec(
        `UPDATE board SET latest_seq = ?, next_z = ?, updated_at_ms = ?,
         dirty_since_seq = COALESCE(dirty_since_seq, ?),
         dirty_since_at_ms = COALESCE(dirty_since_at_ms, ?),
         snapshot_live_item_count = ?, snapshot_live_item_bytes = ?
         WHERE singleton = 1`,
        seq,
        prepared.nextZ,
        acceptedAt,
        seq,
        acceptedAt,
        snapshotAccounting.itemCount,
        snapshotAccounting.itemBytes,
      ).rowsWritten;
      recordedFrames = this.#pendingFrameCount;
      const rowsReadEstimate = records.size + topologyRowsRead + 8;
      const rowsWrittenEstimate =
        capacityRowsWritten +
        snapshotScheduleRowsWritten +
        (snapshotScheduleRowsWritten > 0 ? 1 : 0) +
        itemRowsWritten +
        attributionRowsWritten +
        commentRowsWritten +
        invalidatedHistory.rowsWritten +
        historyRowsWritten +
        historyVersion.rowsWritten +
        boardRowsWritten +
        ACTION_INSERT_BILLED_ROWS;
      sqliteRowsRead = rowsReadEstimate;
      sqliteRowsWritten = rowsWrittenEstimate;
      const actionRowsWritten = this.#sql.exec(
        `INSERT INTO actions(
          seq, action_id, command_id, request_hash, actor_id, kind, payload_json,
          affected_item_ids_json, undoable, accepted_at_ms, usage_incoming_frames,
          usage_rows_read_estimate, usage_rows_written_estimate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        seq,
        command.actionId,
        command.commandId,
        requestHash,
        attachment.actorId,
        operation.kind,
        payloadJson,
        JSON.stringify(prepared.affectedItemIds),
        acceptedAt,
        recordedFrames,
        rowsReadEstimate,
        rowsWrittenEstimate,
      ).rowsWritten;
      if (actionRowsWritten !== ACTION_INSERT_BILLED_ROWS) {
        throw new BoardDomainError("INTERNAL_ERROR", "Action billing accounting drifted.");
      }
      history = {
        historyVersion: historyVersion.historyVersion,
        canUndo: true,
        canRedo: false,
      };
    });
    if (duplicate !== null) {
      sendJson(socket, duplicate);
      return null;
    }
    this.#pendingFrameCount = Math.max(0, this.#pendingFrameCount - recordedFrames);
    this.broadcastAction(action);
    if (commentsOrphaned) this.broadcastCommentsRefresh();
    this.broadcastHistoryState(attachment.actorId, history);
    if (snapshotScheduleRowsWritten > 0) this.scheduleNextAlarmAfterCommit();
    return {
      actionKind: operation.kind,
      seq: action.seq,
      sqliteDurationMs: Math.round(performance.now() - transactionStartedAt),
      sqliteRowsRead,
      sqliteRowsWritten,
    };
  }

  private commitHistory(
    socket: WebSocket,
    attachment: SocketAttachment,
    command: ParsedCommit,
    requestHash: string,
    execution: CommitExecution,
  ): CommitMetrics | null {
    const operation = command.op;
    if (operation.kind !== "history.undo" && operation.kind !== "history.redo") return null;
    let action!: ServerAction;
    let duplicate: ServerAction | null = null;
    let history!: ReturnType<BoardRoom["historyState"]>;
    let snapshotScheduleRowsWritten = 0;
    let recordedFrames = 0;
    let sqliteRowsRead = 0;
    let sqliteRowsWritten = 0;
    let commentsChanged = false;
    const transactionStartedAt = performance.now();
    execution.transactionStarted = true;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      const access = this.requireView(board, attachment.actorId);
      const raced = this.findDuplicateAction(command.commandId, attachment.actorId, requestHash);
      if (raced !== null) {
        duplicate = raced;
        return;
      }
      this.requireContentMutationAllowed(board, access.role);
      const currentHistory = this.historyState(attachment.actorId);
      if (currentHistory.historyVersion !== operation.expectedHistoryVersion) {
        throw new BoardDomainError(
          "STALE_HISTORY",
          "Undo history changed in another tab.",
          currentHistory,
        );
      }
      const undo = operation.kind === "history.undo";
      const entry = this.#sql
        .exec<HistoryEntryRow>(
          undo
            ? `SELECT normal_action_seq, actor_id, state, last_transition_seq,
                action_id, payload_json
               FROM history_entries
               WHERE actor_id = ? AND state = 'active'
               ORDER BY normal_action_seq DESC LIMIT 1`
            : `SELECT normal_action_seq, actor_id, state, last_transition_seq,
                action_id, payload_json
               FROM history_entries
               WHERE actor_id = ? AND state = 'undone'
               ORDER BY last_transition_seq DESC LIMIT 1`,
          attachment.actorId,
        )
        .toArray()[0];
      if (entry === undefined) {
        throw new BoardDomainError(
          undo ? "UNDO_EMPTY" : "REDO_EMPTY",
          undo ? "Nothing can be undone." : "Nothing can be redone.",
        );
      }
      if (operation.targetActionId !== undefined && operation.targetActionId !== entry.action_id) {
        throw new BoardDomainError(
          "STALE_HISTORY",
          "The requested history action is no longer on top.",
          currentHistory,
        );
      }
      const originalPayload = parseStoredActionPayload(entry.payload_json);
      let effects = originalPayload.effects;
      if (effects.length === 0)
        throw new BoardDomainError("INTERNAL_ERROR", "Stored undo effects are unavailable.");
      const currentRecords = new Map<string, ItemRecord>();
      for (const effect of effects) {
        const current = readItem(this.#sql, effect.itemId);
        const expectedToken = undo ? effect.afterStateToken : effect.beforeStateToken;
        if (current === undefined || current.stateToken !== expectedToken) {
          throw new BoardDomainError(
            undo ? "UNDO_CONFLICT" : "UNDO_CONFLICT",
            undo
              ? "Another participant changed an item in this action."
              : "The item changed after this action was undone.",
          );
        }
        currentRecords.set(effect.itemId, current);
      }

      // Applying this entry may remove a Section (undoing its create, or
      // redoing its delete). Members that joined after the entry was recorded
      // are not in its effects, so synthesize a detach for each of them in the
      // same direction as the entry. The detached side gets a fresh state token
      // because it is a new logical state: any other participant's history
      // entry that recorded the member must now conflict instead of replaying
      // against a Section that no longer exists.
      let topologyItems: readonly BoardItem[] | undefined;
      const dependentItemIds = new Set<string>();
      const deletedSectionIds = deletedSectionIdsForTarget(effects, undo ? "before" : "after");
      if (deletedSectionIds.size > 0) {
        topologyItems = readLiveItems(this.#sql);
        const effectItemIds = new Set(effects.map((effect) => effect.itemId));
        const dependentEffects: ItemEffect[] = [];
        for (const item of topologyItems) {
          if (
            item.sectionId === undefined ||
            !deletedSectionIds.has(item.sectionId) ||
            effectItemIds.has(item.id)
          ) {
            continue;
          }
          const current = readItem(this.#sql, item.id);
          if (current === undefined || current.deleted) {
            throw new BoardDomainError(
              "INTERNAL_ERROR",
              "A live Section member record is unavailable.",
            );
          }
          // Membership was assigned by geometry, so removing it is the
          // Section creator's right even when the member belongs to someone
          // else. Owners may detach anything.
          const section = currentRecords.get(item.sectionId)?.item;
          if (access.role !== "owner" && section?.createdBy !== attachment.actorId) {
            throw new BoardDomainError("FORBIDDEN", "You can modify only work that you created.", {
              itemId: item.id,
            });
          }
          const attached = structuredClone(current.item);
          const detached = structuredClone(current.item);
          delete detached.sectionId;
          const detachedToken = crypto.randomUUID();
          dependentEffects.push(
            undo
              ? {
                  itemId: item.id,
                  before: { exists: true, item: detached },
                  after: { exists: true, item: attached },
                  beforeStateToken: detachedToken,
                  afterStateToken: current.stateToken,
                }
              : {
                  itemId: item.id,
                  before: { exists: true, item: attached },
                  after: { exists: true, item: detached },
                  beforeStateToken: current.stateToken,
                  afterStateToken: detachedToken,
                },
          );
          currentRecords.set(item.id, current);
          dependentItemIds.add(item.id);
        }
        if (dependentEffects.length > 0) effects = [...effects, ...dependentEffects];
      }
      // Relationship-only changes to the membership of a Section this actor
      // created are theirs to apply in either direction, whoever authored the
      // member: membership was assigned by geometry, not by the member's
      // author. This covers the synthesized detaches above and the recorded
      // detaches/re-attaches of the actor's own Section delete or create.
      const membershipExemptItemIds = new Set(dependentItemIds);
      for (const effect of effects) {
        if (membershipExemptItemIds.has(effect.itemId)) continue;
        if (!isPureHistorySectionMembershipChange(effect)) continue;
        const sectionIds = [effect.before, effect.after].flatMap((state) =>
          state.exists && state.item.sectionId !== undefined ? [state.item.sectionId] : [],
        );
        const ownsEverySection =
          sectionIds.length > 0 &&
          sectionIds.every(
            (sectionId) =>
              (currentRecords.get(sectionId) ?? readItem(this.#sql, sectionId))?.item.createdBy ===
              attachment.actorId,
          );
        if (access.role === "owner" || ownsEverySection) membershipExemptItemIds.add(effect.itemId);
      }
      const currentItems = effects.flatMap((effect) => {
        const current = currentRecords.get(effect.itemId);
        return current === undefined || current.deleted ? [] : [current.item];
      });
      const targetItems = effects.flatMap((effect) => {
        const target = undo ? effect.before : effect.after;
        return target.exists ? [target.item] : [];
      });
      const historyItems = [...currentItems, ...targetItems];
      // Synthesized detaches were authorised above against the Section's
      // creator, so the member's own author is not required here.
      assertItemsOwnedByActor(
        historyItems.filter((item) => !membershipExemptItemIds.has(item.id)),
        {
          actorId: attachment.actorId,
          role: access.role,
        },
      );
      if (access.role !== "owner" && effects.some(isPureHistorySectionLockChange)) {
        throw new BoardDomainError("FORBIDDEN", "Only an owner can lock or unlock a Section.");
      }
      const sectionRecords = readItems(this.#sql, sectionRecordIdsForItems(historyItems));
      for (const [itemId, record] of sectionRecords) currentRecords.set(itemId, record);
      const lockCheckedCurrentItems = effects.flatMap((effect) => {
        if (isPureHistorySectionLockChange(effect)) return [];
        const current = currentRecords.get(effect.itemId);
        return current === undefined || current.deleted ? [] : [current.item];
      });
      assertItemsOutsideLockedSections(lockCheckedCurrentItems, currentRecords);
      const prospectiveRecords = new Map(currentRecords);
      const lockCheckedItems: BoardItem[] = [];
      for (const effect of effects) {
        const target = undo ? effect.before : effect.after;
        if (!target.exists) {
          prospectiveRecords.delete(effect.itemId);
          continue;
        }
        const current = currentRecords.get(effect.itemId);
        prospectiveRecords.set(effect.itemId, {
          item: target.item,
          deleted: false,
          stateToken: current?.stateToken ?? "",
        });
        if (!isPureHistorySectionLockChange(effect)) lockCheckedItems.push(target.item);
      }
      assertItemsOutsideLockedSections(lockCheckedItems, prospectiveRecords);
      if (this.actionIdExists(command.actionId)) {
        throw new BoardDomainError("INVALID_FRAME", "The action ID was already used.");
      }
      const capacityRowsWritten = this.ensureActionCapacity(board);
      const seq = board.latest_seq + 1;
      const acceptedAt = Date.now();
      const topologyRowsRead = this.assertProspectiveMoveCopyClosure(
        effects,
        undo ? "before" : "after",
        topologyItems,
        { actorId: attachment.actorId, role: access.role },
      );
      const snapshotAccounting = this.projectSnapshotAccounting(
        board,
        effects.map((effect) => {
          const state = undo ? effect.before : effect.after;
          return {
            before: currentRecords.get(effect.itemId),
            ...(state.exists
              ? { after: { ...structuredClone(state.item), version: seq } as BoardItem }
              : {}),
          };
        }),
      );
      this.assertProspectiveSnapshotFits(board, snapshotAccounting, {
        seq,
        createdAt: acceptedAt,
      });
      snapshotScheduleRowsWritten = this.upsertSnapshotJob(
        seq,
        acceptedAt,
        board.latest_snapshot_seq,
      );
      const changes: Array<
        | { kind: "item.replace"; item: BoardItem }
        | { kind: "item.remove"; itemId: string; version: number }
      > = [];
      let itemRowsWritten = 0;
      for (const effect of effects) {
        const state = undo ? effect.before : effect.after;
        const stateToken = undo ? effect.beforeStateToken : effect.afterStateToken;
        const write = writeLogicalState(this.#sql, effect.itemId, state, stateToken, seq);
        itemRowsWritten += write.rowsWritten;
        changes.push(
          write.deleted
            ? { kind: "item.remove", itemId: effect.itemId, version: seq }
            : { kind: "item.replace", item: write.item },
        );
      }
      const commentRowsWritten =
        this.orphanOpenComments(
          changes.flatMap((change) => (change.kind === "item.remove" ? [change.itemId] : [])),
          acceptedAt,
        ) +
        this.restoreOrphanedComments(
          changes.flatMap((change) =>
            change.kind === "item.replace" && currentRecords.get(change.item.id)?.deleted === true
              ? [change.item.id]
              : [],
          ),
          acceptedAt,
        );
      commentsChanged = commentRowsWritten > 0;
      const storedAttributionEffects = originalPayload.attributionEffects;
      const synthesizedAttributionEffects =
        storedAttributionEffects === undefined
          ? []
          : effects
              .filter(
                (effect) =>
                  !storedAttributionEffects.some(
                    (attributionEffect) => attributionEffect.itemId === effect.itemId,
                  ),
              )
              .map((effect) =>
                this.deriveHistoryAttributionEffect(
                  effect,
                  currentRecords.get(effect.itemId),
                  undo ? "before" : "after",
                  attachment.actorId,
                  seq,
                  acceptedAt,
                ),
              );

      const targetAttributionEffects =
        storedAttributionEffects === undefined
          ? effects.map((effect) => {
              const state = undo ? effect.before : effect.after;
              const attribution = state.exists
                ? initialItemAttribution(
                    state.item,
                    state.item.createdBy,
                    state.item.version,
                    acceptedAt,
                  )
                : null;
              return { itemId: effect.itemId, before: attribution, after: attribution };
            })
          : [...storedAttributionEffects, ...synthesizedAttributionEffects];
      const attributionRowsWritten = this.applyAttributionEffects(
        targetAttributionEffects,
        storedAttributionEffects === undefined ? "after" : undo ? "before" : "after",
      );
      const creators = this.restoredItemCreators(
        changes.flatMap((change) => (change.kind === "item.replace" ? [change.item] : [])),
        attachment.actorId,
      );
      action = {
        v: 1,
        t: "server.action",
        seq,
        acceptedAt,
        actor: { id: attachment.actorId, displayName: access.displayName },
        ...(creators.length > 0 ? { creators } : {}),
        commandId: command.commandId,
        actionId: command.actionId,
        op: { kind: operation.kind, targetActionId: entry.action_id, changes },
      };
      const payload: StoredActionPayload = { publicResult: action, effects: [] };
      const payloadJson = JSON.stringify(payload);
      const historyEntryPayloadJson = JSON.stringify({ ...originalPayload, effects });
      if (
        utf8(JSON.stringify(action)).byteLength > MAX_PUBLIC_RESULT_BYTES ||
        utf8(payloadJson).byteLength > MAX_ACTION_PAYLOAD_BYTES ||
        utf8(historyEntryPayloadJson).byteLength > MAX_ACTION_PAYLOAD_BYTES
      ) {
        throw new BoardDomainError("MESSAGE_TOO_LARGE", "The history action is too large.");
      }
      const historyRowsWritten = this.#sql.exec(
        `UPDATE history_entries
         SET state = ?, last_transition_seq = ?, payload_json = ?
         WHERE normal_action_seq = ?`,
        undo ? "undone" : "active",
        seq,
        historyEntryPayloadJson,
        entry.normal_action_seq,
      ).rowsWritten;
      const historyVersion = this.incrementHistoryVersion(attachment.actorId, acceptedAt);
      const boardRowsWritten = this.#sql.exec(
        `UPDATE board SET latest_seq = ?, updated_at_ms = ?,
         dirty_since_seq = COALESCE(dirty_since_seq, ?),
         dirty_since_at_ms = COALESCE(dirty_since_at_ms, ?),
         snapshot_live_item_count = ?, snapshot_live_item_bytes = ?
         WHERE singleton = 1`,
        seq,
        acceptedAt,
        seq,
        acceptedAt,
        snapshotAccounting.itemCount,
        snapshotAccounting.itemBytes,
      ).rowsWritten;
      recordedFrames = this.#pendingFrameCount;
      const rowsReadEstimate = effects.length + topologyRowsRead + 10;
      const rowsWrittenEstimate =
        capacityRowsWritten +
        snapshotScheduleRowsWritten +
        (snapshotScheduleRowsWritten > 0 ? 1 : 0) +
        itemRowsWritten +
        attributionRowsWritten +
        commentRowsWritten +
        historyRowsWritten +
        historyVersion.rowsWritten +
        boardRowsWritten +
        ACTION_INSERT_BILLED_ROWS;
      sqliteRowsRead = rowsReadEstimate;
      sqliteRowsWritten = rowsWrittenEstimate;
      const actionRowsWritten = this.#sql.exec(
        `INSERT INTO actions(
          seq, action_id, command_id, request_hash, actor_id, kind, payload_json,
          affected_item_ids_json, undoable, target_action_seq, accepted_at_ms,
          usage_incoming_frames, usage_rows_read_estimate, usage_rows_written_estimate
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        seq,
        command.actionId,
        command.commandId,
        requestHash,
        attachment.actorId,
        operation.kind,
        payloadJson,
        JSON.stringify(effects.map((effect) => effect.itemId)),
        entry.normal_action_seq,
        acceptedAt,
        recordedFrames,
        rowsReadEstimate,
        rowsWrittenEstimate,
      ).rowsWritten;
      if (actionRowsWritten !== ACTION_INSERT_BILLED_ROWS) {
        throw new BoardDomainError("INTERNAL_ERROR", "Action billing accounting drifted.");
      }
      history = this.historyState(attachment.actorId);
    });
    if (duplicate !== null) {
      sendJson(socket, duplicate);
      return null;
    }
    this.#pendingFrameCount = Math.max(0, this.#pendingFrameCount - recordedFrames);
    this.broadcastAction(action);
    if (commentsChanged) this.broadcastCommentsRefresh();
    this.broadcastHistoryState(attachment.actorId, history);
    if (snapshotScheduleRowsWritten > 0) this.scheduleNextAlarmAfterCommit();
    return {
      actionKind: operation.kind,
      seq: action.seq,
      sqliteDurationMs: Math.round(performance.now() - transactionStartedAt),
      sqliteRowsRead,
      sqliteRowsWritten,
    };
  }

  private async commitClear(
    socket: WebSocket,
    attachment: SocketAttachment,
    command: ParsedCommit,
    requestHash: string,
    execution: CommitExecution,
  ): Promise<CommitMetrics | null> {
    const operation = command.op;
    if (operation.kind !== "board.clear") return null;
    const initialBoard = this.requireBoard();
    const access = this.requireView(initialBoard, attachment.actorId);
    if (access.role !== "owner")
      throw new BoardDomainError("FORBIDDEN", "Only the owner can clear the board.");
    this.requireContentMutationAllowed(initialBoard, access.role);
    if (initialBoard.latest_seq !== operation.expectedBoardSeq) {
      throw new BoardDomainError("STALE_BOARD", "The board changed before it could be cleared.", {
        latestSeq: initialBoard.latest_seq,
      });
    }
    const snapshot = captureSnapshot(this.#sql, initialBoard);
    const snapshotAttribution = this.captureSnapshotAttribution(snapshot.items);
    const stored = await this.persistSnapshotObject(snapshot);
    let action!: ServerAction;
    let duplicate: ServerAction | null = null;
    let requiresResync = false;
    let snapshotScheduleRowsWritten = 0;
    let recordedFrames = 0;
    let sqliteRowsRead = 0;
    let sqliteRowsWritten = 0;
    let commentsOrphaned = false;
    const transactionStartedAt = performance.now();
    execution.transactionStarted = true;
    this.ctx.storage.transactionSync(() => {
      const board = this.requireBoard();
      const currentAccess = this.requireView(board, attachment.actorId);
      const raced = this.findDuplicateAction(command.commandId, attachment.actorId, requestHash);
      if (raced !== null) {
        duplicate = raced;
        return;
      }
      if (currentAccess.role !== "owner")
        throw new BoardDomainError("FORBIDDEN", "Only the owner can clear the board.");
      this.requireContentMutationAllowed(board, currentAccess.role);
      const lockedSectionRows = this.#sql
        .exec<ItemSqlRow>("SELECT * FROM items WHERE deleted = 0 AND kind = 'zone'")
        .toArray();
      assertItemsOutsideLockedSections(
        lockedSectionRows.map((row) => itemRecordFromRow(row).item),
        new Map(),
      );
      if (board.latest_seq !== operation.expectedBoardSeq) {
        throw new BoardDomainError("STALE_BOARD", "The board changed before it could be cleared.", {
          latestSeq: board.latest_seq,
        });
      }
      if (this.actionIdExists(command.actionId)) {
        throw new BoardDomainError("INVALID_FRAME", "The action ID was already used.");
      }
      const capacityRowsWritten = this.ensureActionCapacity(board);
      const seq = board.latest_seq + 1;
      const acceptedAt = Date.now();
      const snapshotAccounting = { itemCount: 0, itemBytes: 0 };
      this.assertProspectiveSnapshotFits(board, snapshotAccounting, {
        seq,
        createdAt: acceptedAt,
      });
      const liveRows = this.#sql
        .exec<ItemSqlRow>("SELECT * FROM items WHERE deleted = 0 ORDER BY z_order")
        .toArray();
      const removals: string[] = [];
      let itemRowsWritten = 0;
      for (const row of liveRows) {
        const record = itemRecordFromRow(row);
        itemRowsWritten += writeItem(
          this.#sql,
          itemWriteFromState({ ...record.item, version: seq }, true, crypto.randomUUID()),
        );
        removals.push(record.item.id);
      }
      const commentRowsWritten = this.orphanOpenComments(removals, acceptedAt);
      commentsOrphaned = commentRowsWritten > 0;
      const attributionRowsWritten = this.#sql.exec("DELETE FROM item_attribution").rowsWritten;
      const expanded = {
        kind: "board.clear",
        removed: removals.map((itemId) => ({ itemId, version: seq })),
      };
      requiresResync = utf8(JSON.stringify(expanded)).byteLength > MAX_PUBLIC_RESULT_BYTES;
      action = {
        v: 1,
        t: "server.action",
        seq,
        acceptedAt,
        actor: { id: attachment.actorId, displayName: currentAccess.displayName },
        commandId: command.commandId,
        actionId: command.actionId,
        op: requiresResync ? { kind: "board.clear", removed: [] } : expanded,
      };
      const payload: StoredActionPayload = { publicResult: action, effects: [] };
      const snapshotRowsWritten = this.#sql.exec(
        `INSERT INTO snapshots(
          seq, r2_json_key, sha256, item_count, byte_count, kind, label, created_by, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'pre_clear', NULL, ?, ?)
        ON CONFLICT(seq) DO UPDATE SET
          r2_json_key = excluded.r2_json_key,
          sha256 = excluded.sha256,
          item_count = excluded.item_count,
          byte_count = excluded.byte_count,
          kind = CASE WHEN snapshots.kind = 'named' THEN 'named' ELSE 'pre_clear' END,
          label = CASE WHEN snapshots.kind = 'named' THEN snapshots.label ELSE NULL END,
          created_by = CASE
            WHEN snapshots.kind = 'named' THEN snapshots.created_by
            ELSE excluded.created_by
          END`,
        snapshot.seq,
        stored.key,
        stored.sha256,
        snapshot.items.length,
        stored.bytes.byteLength,
        attachment.actorId,
        snapshot.createdAt,
      ).rowsWritten;
      const snapshotAttributionRowsWritten = this.writeSnapshotAttribution(
        snapshot.seq,
        snapshotAttribution,
      );
      const invalidatedHistoryRows = this.invalidateAllHistory(acceptedAt);
      snapshotScheduleRowsWritten = this.upsertSnapshotJob(seq, acceptedAt, snapshot.seq);
      const boardRowsWritten = this.#sql.exec(
        `UPDATE board SET latest_seq = ?, latest_snapshot_seq = MAX(latest_snapshot_seq, ?),
         updated_at_ms = ?, dirty_since_seq = ?, dirty_since_at_ms = ?,
         snapshot_live_item_count = ?, snapshot_live_item_bytes = ?,
         min_replay_seq = CASE WHEN ? THEN ? ELSE min_replay_seq END,
         usage_checkpoint_seq = ?
         WHERE singleton = 1`,
        seq,
        snapshot.seq,
        acceptedAt,
        seq,
        acceptedAt,
        snapshotAccounting.itemCount,
        snapshotAccounting.itemBytes,
        requiresResync ? 1 : 0,
        seq,
        seq,
      ).rowsWritten;
      recordedFrames = this.#pendingFrameCount;
      const rowsReadEstimate = liveRows.length + snapshot.items.length + 10;
      const rowsWrittenEstimate =
        stored.sqliteRowsWritten +
        capacityRowsWritten +
        itemRowsWritten +
        attributionRowsWritten +
        commentRowsWritten +
        snapshotRowsWritten +
        snapshotAttributionRowsWritten +
        invalidatedHistoryRows +
        boardRowsWritten +
        ACTION_INSERT_BILLED_ROWS +
        snapshotScheduleRowsWritten +
        (snapshotScheduleRowsWritten > 0 ? 1 : 0);
      sqliteRowsRead = rowsReadEstimate;
      sqliteRowsWritten = rowsWrittenEstimate;
      const actionRowsWritten = this.#sql.exec(
        `INSERT INTO actions(
          seq, action_id, command_id, request_hash, actor_id, kind, payload_json,
          affected_item_ids_json, undoable, accepted_at_ms, usage_incoming_frames,
          usage_rows_read_estimate, usage_rows_written_estimate, usage_r2_reads,
          usage_r2_writes, usage_r2_bytes, usage_snapshots
        ) VALUES (?, ?, ?, ?, ?, 'board.clear', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1)`,
        seq,
        command.actionId,
        command.commandId,
        requestHash,
        attachment.actorId,
        JSON.stringify(payload),
        JSON.stringify(removals),
        acceptedAt,
        recordedFrames,
        rowsReadEstimate,
        rowsWrittenEstimate,
        stored.r2Reads,
        stored.r2Writes,
        stored.r2Bytes,
      ).rowsWritten;
      if (actionRowsWritten !== ACTION_INSERT_BILLED_ROWS) {
        throw new BoardDomainError("INTERNAL_ERROR", "Action billing accounting drifted.");
      }
      this.checkpointUsage(board.usage_checkpoint_seq, seq, {}, acceptedAt);
    });
    if (duplicate !== null) {
      sendJson(socket, duplicate);
      return null;
    }
    this.#pendingFrameCount = Math.max(0, this.#pendingFrameCount - recordedFrames);
    if (requiresResync) {
      sendJson(socket, action);
      this.broadcastResyncRequired("Board clear requires a fresh bootstrap.");
    } else {
      this.broadcastAction(action);
    }
    if (commentsOrphaned) this.broadcastCommentsRefresh();
    this.broadcastAllHistoryStates();
    if (snapshotScheduleRowsWritten > 0) this.scheduleNextAlarmAfterCommit();
    return {
      actionKind: operation.kind,
      seq: action.seq,
      sqliteDurationMs: Math.round(performance.now() - transactionStartedAt),
      sqliteRowsRead,
      sqliteRowsWritten,
    };
  }

  private handlePreview(
    socket: WebSocket,
    attachment: SocketAttachment,
    frame: Extract<ClientFrame, { t: "client.preview" }>,
    frameBytes: number,
    board: BoardRow,
  ): void {
    const { gestureId, previewSeq, kind, payload } = frame;
    // refreshAttachment has already revalidated this socket against the current
    // ACL version. Avoid another membership read on this high-volume path.
    this.requireContentMutationAllowed(board, attachment.role);
    const features = featuresForBoard(board);
    if ((kind === "pencil.start" || kind === "pencil.segment") && !features.pencil) {
      throw new BoardDomainError("FORBIDDEN", "This board feature is disabled.");
    }
    if (kind === "shape.geometry") {
      assertItemFeatureEnabled(features, { kind: payload.itemKind, geometry: payload.geometry });
    }
    const now = Date.now();
    const connectionKey = `${attachment.connectionId}:preview`;
    const connectionAllowed = this.#buckets.consume(connectionKey, 15, 30, now);
    const boardAllowed = this.#buckets.consume("board:preview", 200, 250, now);
    if (!connectionAllowed || !boardAllowed) {
      if (
        !connectionAllowed &&
        this.#buckets.violations(connectionKey) >= 30 &&
        this.#buckets.consume(`${attachment.connectionId}:preview-warning`, 1 / 60, 1, now)
      ) {
        this.log("warn", "rate_limit.triggered", {
          code: "RATE_LIMITED",
          frameBytes,
          result: "dropped",
        });
      }
      if (!boardAllowed) {
        this.#previewOverloadedUntil = now + 1_000;
        if (this.#buckets.consume("board:preview-overload-warning", 1 / 60, 1, now)) {
          this.log("warn", "room.overloaded", {
            code: "PREVIEW_RELAY_SHED",
            frameBytes,
            result: "preview_dropped",
          });
        }
      }
      return;
    }
    this.broadcastFrame(
      {
        v: 1,
        t: "server.preview",
        gestureId,
        previewSeq,
        kind,
        payload,
        actor: { id: attachment.actorId, displayName: attachment.displayName },
        connectionId: attachment.connectionId,
      },
      socket,
      true,
      board,
    );
  }

  private handlePresence(
    socket: WebSocket,
    attachment: SocketAttachment,
    frame: Extract<ClientFrame, { t: "client.presence" }>,
    board: BoardRow,
  ): void {
    const { cursor, activeTool } = frame;
    // Presence is deliberately the first fanout shed while preview relay work
    // is overloaded. ACL refresh already ran before this method was entered.
    if (Date.now() < this.#previewOverloadedUntil) return;
    if (!this.#buckets.consume(`${attachment.connectionId}:presence`, 5, 10)) return;
    this.broadcastFrame(
      {
        v: 1,
        t: "server.presence",
        cursor: { x: cursor.x, y: cursor.y },
        activeTool,
        actor: { id: attachment.actorId, displayName: attachment.displayName },
        connectionId: attachment.connectionId,
      },
      socket,
      true,
      board,
    );
  }

  private handleFacilitationSpotlight(
    socket: WebSocket,
    attachment: SocketAttachment,
    frame: Extract<ClientFrame, { t: "client.facilitation.spotlight" }>,
    board: BoardRow,
  ): void {
    if (frame.active) this.requireFeature(board, "spotlight");
    // Facilitation is independent of the drawing policy: an editor may guide
    // the class while the board is owner-only or locked. Viewers are always
    // receive-only at this authoritative boundary.
    if (attachment.role === "viewer") {
      throw new BoardDomainError("FORBIDDEN", "Viewers cannot broadcast a spotlight.");
    }
    const connectionAllowed = frame.active
      ? this.#buckets.consume(`${attachment.connectionId}:spotlight`, 15, 30)
      : this.#buckets.consume(`${attachment.connectionId}:spotlight-control`, 2, 4);
    if (!connectionAllowed) return;
    const actorAllowed = frame.active
      ? this.#buckets.consume(`actor:${attachment.actorId}:spotlight`, 20, 40)
      : this.#buckets.consume(`actor:${attachment.actorId}:spotlight-control`, 4, 8);
    if (!actorAllowed) return;
    const boardAllowed = frame.active
      ? this.#buckets.consume("board:spotlight", 100, 150)
      : this.#buckets.consume("board:spotlight-control", 10, 20);
    if (!boardAllowed) return;

    this.broadcastFrame(
      {
        v: 1,
        t: "server.facilitation.spotlight",
        spotlightId: frame.spotlightId,
        active: frame.active,
        ...(frame.active ? { viewport: frame.viewport } : {}),
        actor: { id: attachment.actorId, displayName: attachment.displayName },
        connectionId: attachment.connectionId,
      },
      socket,
      true,
      board,
    );
  }

  private handleSyncCheck(
    socket: WebSocket,
    attachment: SocketAttachment,
    frame: Extract<ClientFrame, { t: "client.sync_check" }>,
    board: BoardRow,
  ): void {
    const latestSeq = frame.latestSeq;
    if (
      !this.#buckets.consume(`${attachment.connectionId}:sync`, 1, 3) ||
      !this.#buckets.consume(`actor:${attachment.actorId}:sync`, 1, 3) ||
      !this.#buckets.consume("board:sync", 10, 50)
    ) {
      throw new BoardDomainError("RATE_LIMITED", "Too many synchronization checks.");
    }
    if (latestSeq === board.latest_seq) {
      sendJson(socket, { v: 1, t: "server.in_sync", latestSeq });
      return;
    }
    // A live action may already be queued on this ordered socket after the
    // client emitted its check but before this event ran. Replaying from the
    // client-declared sequence would duplicate that action. Startup replay has
    // an explicit syncing barrier, so make every live mismatch reconnect
    // through that authoritative path.
    this.resyncSocket(socket, board.latest_seq, "The client sequence differs from the room.");
  }

  private sendReplayRange(
    socket: WebSocket,
    fromExclusive: number,
    toInclusive: number,
  ): ReplayMetrics {
    let cursor = fromExclusive;
    const metrics: ReplayMetrics = { actions: 0, bytes: 0 };
    while (cursor < toInclusive) {
      const rows = this.#sql
        .exec<ActionRow>(
          `SELECT * FROM actions WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
          cursor,
          toInclusive,
          MAX_REPLAY_ACTIONS,
        )
        .toArray();
      if (rows.length === 0) {
        throw new BoardDomainError("REPLAY_UNAVAILABLE", "Replay history is unavailable.");
      }
      const actions: ServerAction[] = [];
      const chunkStart = cursor;
      for (const row of rows) {
        if (row.seq !== cursor + 1) {
          throw new BoardDomainError("REPLAY_UNAVAILABLE", "Replay history contains a gap.");
        }
        const action = parseStoredActionPayload(row.payload_json).publicResult;
        const prospective = JSON.stringify({
          v: 1,
          t: "server.replay",
          fromExclusive: chunkStart,
          toInclusive: row.seq,
          actions: [...actions, action],
        });
        if (actions.length > 0 && utf8(prospective).byteLength > 256 * 1_024) break;
        if (utf8(prospective).byteLength > MAX_PUBLIC_RESULT_BYTES) {
          throw new BoardDomainError(
            "REPLAY_UNAVAILABLE",
            "A retained action is too large to replay.",
          );
        }
        actions.push(action);
        cursor = row.seq;
      }
      if (actions.length === 0)
        throw new BoardDomainError("REPLAY_UNAVAILABLE", "Replay could not advance.");
      const replay = {
        v: 1,
        t: "server.replay",
        fromExclusive: chunkStart,
        toInclusive: cursor,
        actions,
      };
      metrics.actions += actions.length;
      metrics.bytes += utf8(JSON.stringify(replay)).byteLength;
      sendJson(socket, replay);
    }
    return metrics;
  }

  private broadcastAction(action: ServerAction): void {
    const { fanout, sendFailures } = this.broadcastFrame(action, undefined, true);
    this.log(sendFailures > 0 ? "warn" : "info", "broadcast.completed", {
      fanout,
      sendFailures,
    });
  }

  private broadcastPresenceState(omit?: WebSocket): void {
    const board = this.requireBoard();
    const participants: Array<{
      id: string;
      displayName: string;
      role: BoardRole;
      connectionId: string;
    }> = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === omit) continue;
      try {
        const attachment = parseAttachment(socket.deserializeAttachment());
        if (attachment.state !== "live") continue;
        if (attachment.sessionExpiresAt <= Date.now()) continue;
        const access = resolveAccess(this.#sql, board, attachment.actorId);
        if (!access.canView) continue;
        participants.push({
          id: attachment.actorId,
          displayName: access.displayName,
          role: access.role,
          connectionId: attachment.connectionId,
        });
      } catch {
        // Malformed attachments are excluded and closed by normal broadcasts.
      }
    }
    this.broadcastFrame({ v: 1, t: "server.presence_state", participants }, omit, true);
  }

  private resyncSocket(socket: WebSocket, latestSeq: number, message: string): void {
    try {
      sendJson(socket, {
        v: 1,
        t: "server.resync_required",
        code: "REPLAY_UNAVAILABLE",
        message,
        latestSeq,
      });
    } catch {
      // A failed send still must close the accepted socket without escaping.
    }
    try {
      socket.close(4009, "Authoritative resynchronization required");
    } catch {
      // A peer may already have disappeared while replay was being produced.
    }
  }

  private cleanupActorRateBuckets(closingSocket: WebSocket, knownActorId?: string): void {
    let actorId = knownActorId;
    if (actorId === undefined) {
      try {
        actorId = parseAttachment(closingSocket.deserializeAttachment()).actorId;
      } catch {
        return;
      }
    }
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === closingSocket) continue;
      try {
        if (parseAttachment(socket.deserializeAttachment()).actorId === actorId) return;
      } catch {
        // Malformed peers do not keep an actor bucket alive.
      }
    }
    this.#buckets.deletePrefix(`actor:${actorId}:`);
  }

  private broadcastHistoryState(actorId: string, history = this.historyState(actorId)): void {
    const board = this.requireBoard();
    const frame = { v: 1, t: "server.history_state", ...history };
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = parseAttachment(socket.deserializeAttachment());
        if (attachment.actorId !== actorId || attachment.state !== "live") continue;
        if (Date.now() >= attachment.sessionExpiresAt) {
          socket.close(4001, "Session expired");
          continue;
        }
        if (!resolveAccess(this.#sql, board, attachment.actorId).canView) {
          socket.close(4010, "Membership revoked");
          continue;
        }
        sendJson(socket, frame);
      } catch {
        socket.close(1008, "Invalid connection state");
      }
    }
  }

  private broadcastAllHistoryStates(): void {
    const actorIds = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        actorIds.add(parseAttachment(socket.deserializeAttachment()).actorId);
      } catch {
        // Malformed attachments are closed by the next ordinary broadcast.
      }
    }
    for (const actorId of actorIds) this.broadcastHistoryState(actorId);
  }

  private findLiveActorSocket(actorId: string): WebSocket | null {
    const board = this.requireBoard();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = parseAttachment(socket.deserializeAttachment());
        if (attachment.actorId !== actorId || attachment.state !== "live") continue;
        if (attachment.sessionExpiresAt <= Date.now()) {
          socket.close(4001, "Session expired");
          continue;
        }
        if (resolveAccess(this.#sql, board, actorId).canView) return socket;
      } catch {
        // Ignore sockets that are not eligible to receive the one-time secret.
      }
    }
    return null;
  }

  private sendOwnerRecoveryToken(socket: WebSocket, actorId: string, token: string): boolean {
    const board = this.requireBoard();
    if (board.owner_actor_id !== actorId) return false;
    try {
      const attachment = parseAttachment(socket.deserializeAttachment());
      if (
        attachment.actorId !== actorId ||
        attachment.state !== "live" ||
        attachment.sessionExpiresAt <= Date.now()
      ) {
        if (attachment.sessionExpiresAt <= Date.now()) socket.close(4001, "Session expired");
        return false;
      }
      const access = resolveAccess(this.#sql, board, actorId);
      if (!access.canView || access.role !== "owner") return false;
      sendJson(socket, {
        v: 1,
        t: "server.owner_recovery",
        ownerRecoveryToken: token,
        aclVersion: board.acl_version,
      });
      return true;
    } catch {
      // A failed target socket can rotate recovery after reconnecting.
      return false;
    }
  }

  private broadcastFrame(
    frame: unknown,
    omit?: WebSocket,
    skipSyncing = false,
    knownBoard?: BoardRow,
  ): { fanout: number; sendFailures: number } {
    const board = knownBoard ?? this.requireBoard();
    const serialized = JSON.stringify(frame);
    const now = Date.now();
    let fanout = 0;
    let sendFailures = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === omit) continue;
      try {
        let attachment = parseAttachment(socket.deserializeAttachment());
        if (now >= attachment.sessionExpiresAt) {
          socket.close(4001, "Session expired");
          continue;
        }
        if (attachment.aclVersion !== board.acl_version) {
          attachment = this.refreshAttachment(socket, attachment);
        }
        if (skipSyncing && attachment.state !== "live") continue;
        socket.send(serialized);
        fanout += 1;
      } catch {
        sendFailures += 1;
        try {
          socket.close(1008, "Connection authorization failed");
        } catch {
          // Ignore close failures independently.
        }
      }
    }
    return { fanout, sendFailures };
  }

  private closeSocketsForArchive(board: BoardRow): void {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = parseAttachment(socket.deserializeAttachment());
        if (attachment.sessionExpiresAt <= now) {
          socket.close(4001, "Session expired");
          continue;
        }
        if (!resolveAccess(this.#sql, board, attachment.actorId).canView) {
          socket.close(4010, "Membership revoked");
          continue;
        }
        socket.close(4011, "Board archived");
      } catch {
        try {
          socket.close(1008, "Invalid connection state");
        } catch {
          // A failed peer cannot compromise the committed archive.
        }
      }
    }
  }

  private broadcastAccessChanged(affectedActorId?: string): void {
    const board = this.requireBoard();
    const features = featuresForBoard(board);
    const affectedActor =
      affectedActorId === undefined
        ? undefined
        : this.actorDirectory(new Set([affectedActorId]))[0];
    if (affectedActorId !== undefined && affectedActor === undefined) {
      throw new BoardDomainError("INTERNAL_ERROR", "The affected board member is unavailable.");
    }
    const cancelledActors = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const oldAttachment = parseAttachment(socket.deserializeAttachment());
        if (Date.now() >= oldAttachment.sessionExpiresAt) {
          socket.close(4001, "Session expired");
          continue;
        }
        const access = resolveAccess(this.#sql, board, oldAttachment.actorId);
        if (!access.canView) {
          cancelledActors.add(oldAttachment.actorId);
          socket.close(4010, "Membership revoked");
          continue;
        }
        const attachment: SocketAttachment = {
          ...oldAttachment,
          role: access.role,
          displayName: access.displayName,
          aclVersion: board.acl_version,
        };
        socket.serializeAttachment(attachment);
        sendJson(socket, {
          v: 1,
          t: "access.changed",
          role: access.role,
          title: board.title,
          accessMode: board.access_mode,
          drawingPolicy: board.drawing_policy,
          imagesEnabled: features.images,
          features,
          aclVersion: board.acl_version,
          ...(affectedActorId ? { affectedActorId, affectedActor } : {}),
        });
        if (!canDraw(board.drawing_policy, access.role)) {
          cancelledActors.add(oldAttachment.actorId);
        }
      } catch {
        socket.close(1008, "Invalid connection state");
      }
    }
    for (const actorId of cancelledActors) {
      this.broadcastFrame({ v: 1, t: "server.previews_cleared", actorId }, undefined, false);
    }
  }

  private broadcastResyncRequired(message: string): void {
    const board = this.requireBoard();
    const latestSeq = board.latest_seq;
    let fanout = 0;
    let sendFailures = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = parseAttachment(socket.deserializeAttachment());
        if (attachment.sessionExpiresAt <= Date.now()) {
          socket.close(4001, "Session expired");
          continue;
        }
        const access = resolveAccess(this.#sql, board, attachment.actorId);
        if (!access.canView) {
          socket.close(4010, "Membership revoked");
          continue;
        }
        sendJson(socket, {
          v: 1,
          t: "server.resync_required",
          code: "REPLAY_UNAVAILABLE",
          message,
          latestSeq,
        });
        fanout += 1;
        socket.close(4009, "Authoritative resynchronization required");
      } catch {
        sendFailures += 1;
        try {
          socket.close(1008, "Connection authorization failed");
        } catch {
          // A failed socket cannot compromise the committed restore/clear.
        }
      }
    }
    this.log(sendFailures > 0 ? "warn" : "info", "broadcast.completed", {
      fanout,
      sendFailures,
    });
  }

  private refreshAttachment(
    socket: WebSocket,
    attachment: SocketAttachment,
    knownBoard?: BoardRow,
  ): SocketAttachment {
    const board = knownBoard ?? this.requireBoard();
    const features = featuresForBoard(board);
    this.ensureBoardActive(board);
    if (Date.now() >= attachment.sessionExpiresAt) {
      socket.close(4001, "Session expired");
      throw new BoardDomainError("AUTH_REQUIRED", "The device session expired.");
    }
    if (attachment.aclVersion === board.acl_version) return attachment;
    const access = resolveAccess(this.#sql, board, attachment.actorId);
    if (!access.canView) {
      socket.close(4010, "Membership revoked");
      throw new BoardDomainError("FORBIDDEN", "Board access was revoked.");
    }
    const refreshed: SocketAttachment = {
      ...attachment,
      role: access.role,
      displayName: access.displayName,
      aclVersion: board.acl_version,
    };
    socket.serializeAttachment(refreshed);
    sendJson(socket, {
      v: 1,
      t: "access.changed",
      role: refreshed.role,
      title: board.title,
      accessMode: board.access_mode,
      drawingPolicy: board.drawing_policy,
      imagesEnabled: features.images,
      features,
      aclVersion: board.acl_version,
    });
    return refreshed;
  }

  private findDuplicateAction(
    commandId: string,
    actorId: string,
    requestHash: string,
  ): ServerAction | null {
    const retained = this.#sql
      .exec<{ actor_id: string; request_hash: string; payload_json: string }>(
        "SELECT actor_id, request_hash, payload_json FROM actions WHERE command_id = ?",
        commandId,
      )
      .toArray()[0];
    const row: ActionReceiptRow | undefined =
      retained ??
      this.#sql
        .exec<ActionReceiptRow>(
          `SELECT actor_id, request_hash, payload_json
           FROM action_receipts WHERE command_id = ?`,
          commandId,
        )
        .toArray()[0];
    if (row === undefined) return null;
    if (row.actor_id !== actorId || row.request_hash !== requestHash) {
      this.log("warn", "command.idempotency_mismatch", {
        code: "INVALID_FRAME",
        result: "security_event",
      });
      throw new BoardDomainError(
        "INVALID_FRAME",
        "The command ID was reused with different input.",
      );
    }
    return parseStoredActionPayload(row.payload_json).publicResult;
  }

  private actionIdExists(actionId: string): boolean {
    return (
      this.#sql
        .exec<{ present: number }>(
          `SELECT 1 AS present FROM actions WHERE action_id = ?
           UNION ALL
           SELECT 1 AS present FROM action_receipts WHERE action_id = ?
           UNION ALL
           SELECT 1 AS present FROM history_entries WHERE action_id = ?
           LIMIT 1`,
          actionId,
          actionId,
          actionId,
        )
        .toArray().length > 0
    );
  }

  private historyState(actorId: string): {
    historyVersion: number;
    canUndo: boolean;
    canRedo: boolean;
  } {
    const historyVersion =
      this.#sql
        .exec<{ history_version: number }>(
          "SELECT history_version FROM history_state WHERE actor_id = ?",
          actorId,
        )
        .toArray()[0]?.history_version ?? 0;
    const canUndo =
      this.#sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM history_entries WHERE actor_id = ? AND state = 'active' LIMIT 1",
          actorId,
        )
        .toArray().length > 0;
    const canRedo =
      this.#sql
        .exec<{ present: number }>(
          "SELECT 1 AS present FROM history_entries WHERE actor_id = ? AND state = 'undone' LIMIT 1",
          actorId,
        )
        .toArray().length > 0;
    return { historyVersion, canUndo, canRedo };
  }

  private incrementHistoryVersion(
    actorId: string,
    now: number,
  ): { historyVersion: number; rowsWritten: number } {
    const cursor = this.#sql.exec<{ history_version: number }>(
      `INSERT INTO history_state(actor_id, history_version, updated_at_ms)
       VALUES (?, 1, ?)
       ON CONFLICT(actor_id) DO UPDATE SET
         history_version = history_version + 1,
         updated_at_ms = excluded.updated_at_ms
       RETURNING history_version`,
      actorId,
      now,
    );
    const historyVersion = cursor.one().history_version;
    return { historyVersion, rowsWritten: cursor.rowsWritten };
  }

  private invalidateAllHistory(now: number): number {
    const entries = this.#sql.exec(
      "UPDATE history_entries SET state = 'invalidated' WHERE state != 'invalidated'",
    );
    const states = this.#sql.exec(
      "UPDATE history_state SET history_version = history_version + 1, updated_at_ms = ?",
      now,
    );
    return entries.rowsWritten + states.rowsWritten;
  }

  private requireBoard(): BoardRow {
    const board = readBoard(this.#sql);
    if (board === null) throw new HttpError(404, "NOT_FOUND", "Board not found.");
    return board;
  }

  private requireBoardWithRecoveryHash(): BoardRow & {
    owner_recovery_hash: ArrayBuffer;
  } {
    const board = this.#sql
      .exec<BoardRow & { owner_recovery_hash: ArrayBuffer }>(
        "SELECT * FROM board WHERE singleton = 1",
      )
      .toArray()[0];
    if (board === undefined) throw new HttpError(404, "NOT_FOUND", "Board not found.");
    return board;
  }

  private ensureBoardActive(board: BoardRow): void {
    if (board.archived_at_ms !== null)
      throw new HttpError(410, "FORBIDDEN", "This board is archived.");
  }

  private requireView(board: BoardRow, actorId: string) {
    const access = resolveAccess(this.#sql, board, actorId);
    if (!access.canView) throw boardNotFoundError();
    this.ensureBoardActive(board);
    return access;
  }

  private activeSocketCounts(actorId: string): { total: number; actor: number } {
    let total = 0;
    let actor = 0;
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== 1) continue;
      let attachment: SocketAttachment;
      try {
        attachment = parseAttachment(socket.deserializeAttachment());
      } catch {
        socket.close(1008, "Invalid connection state");
        continue;
      }
      if (attachment.sessionExpiresAt <= now) {
        socket.close(4001, "Session expired");
        continue;
      }
      total += 1;
      if (attachment.actorId === actorId) actor += 1;
    }
    return { total, actor };
  }

  private requireOwner(board: BoardRow, actorId: string) {
    const access = this.requireView(board, actorId);
    if (access.role !== "owner") {
      throw new HttpError(403, "FORBIDDEN", "Only a board owner may perform this action.");
    }
    return access;
  }

  private requirePrimaryOwner(board: BoardRow, actorId: string) {
    const access = this.requireOwner(board, actorId);
    if (board.owner_actor_id !== actorId) {
      throw new HttpError(403, "FORBIDDEN", "Only the primary owner may perform this action.");
    }
    return access;
  }

  private checkAcl(board: BoardRow, expected: number): void {
    if (board.acl_version !== expected) {
      throw new HttpError(409, "STALE_ACL", "Board access settings changed.", {
        currentAclVersion: board.acl_version,
      });
    }
  }

  private requireContentMutationAllowed(board: BoardRow, role: BoardRole): void {
    if (!canDraw(board.drawing_policy, role)) {
      throw new BoardDomainError("FORBIDDEN", "Drawing is not currently allowed.");
    }
  }

  private requireFeature(board: BoardRow, feature: keyof BoardFeatures): void {
    if (!featuresForBoard(board)[feature]) {
      throw new HttpError(403, "FORBIDDEN", "This board feature is disabled.");
    }
  }

  private requireImageUploadAllowed(board: BoardRow, actorId: string) {
    const access = this.requireView(board, actorId);
    this.requireContentMutationAllowed(board, access.role);
    if (!featuresForBoard(board).images) {
      throw new HttpError(403, "FORBIDDEN", "Image uploads are disabled for this board.");
    }
    return access;
  }

  private requireCommittedImageAsset(
    board: BoardRow,
    item: Extract<ProtocolBoardItem, { kind: "image" }>,
  ): void {
    if (!this.holdsCommittedImageAsset(board, item.geometry)) {
      throw new BoardDomainError(
        "INVALID_FRAME",
        "The image asset is not available on this board.",
      );
    }
  }

  /**
   * Whether this board holds exactly the committed asset a caller names: the same bytes, in
   * this board's own bucket, at the dimensions and type it claims. Shared by the image cards
   * the canvas takes and the pictures a comment carries.
   */
  private holdsCommittedImageAsset(
    board: BoardRow,
    asset: {
      assetId: string;
      mimeType: string;
      intrinsicWidth: number;
      intrinsicHeight: number;
    },
  ): boolean {
    const row = this.readBoardAsset(asset.assetId);
    return (
      row !== null &&
      row.state === "committed" &&
      row.asset_id === asset.assetId &&
      row.sha256 === asset.assetId.slice("asset_".length) &&
      row.r2_key === `boards/${board.public_id}/assets/${asset.assetId}` &&
      row.mime_type === asset.mimeType &&
      row.intrinsic_width === asset.intrinsicWidth &&
      row.intrinsic_height === asset.intrinsicHeight
    );
  }

  /** Refuses a comment picture this Space has switched off or never stored. */
  private requireCommentImageMedia(board: BoardRow, media: CommentImageMedia): void {
    if (!featuresForBoard(board).images) {
      throw new BoardDomainError("FORBIDDEN", "Images are disabled for this Space.");
    }
    if (!this.holdsCommittedImageAsset(board, media)) {
      throw new HttpError(404, "NOT_FOUND", "The comment image is not available on this board.");
    }
  }

  private readHttpReceipt(actorId: string, key: string, operation: string) {
    return (
      this.#sql
        .exec<{ request_hash: string; response_json: string; status: number }>(
          `SELECT request_hash, response_json, status FROM http_receipts
           WHERE actor_id = ? AND idempotency_key = ? AND operation = ?`,
          actorId,
          key,
          operation,
        )
        .toArray()[0] ?? null
    );
  }

  private checkReceiptHash(stored: string, supplied: string): void {
    if (stored !== supplied) {
      throw new HttpError(409, "CONFLICT", "The idempotency key was reused with different input.");
    }
  }

  private writeHttpReceipt(
    actorId: string,
    key: string,
    operation: string,
    requestHash: string,
    response: unknown,
    status: number,
  ): number {
    const now = Date.now();
    let rowsWritten = this.pruneExpiredHttpReceipts(now);
    const receiptCount = this.#sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM http_receipts")
      .one().count;
    if (receiptCount >= MAX_HTTP_RECEIPTS) {
      throw new BoardDomainError(
        "BOARD_LIMIT_REACHED",
        "The board idempotency receipt limit was reached.",
      );
    }
    rowsWritten += this.#sql.exec(
      `INSERT INTO http_receipts(
        actor_id, idempotency_key, operation, request_hash, response_json, status, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      actorId,
      key,
      operation,
      requestHash,
      JSON.stringify(response),
      status,
      now,
    ).rowsWritten;
    return rowsWritten;
  }

  private pruneExpiredHttpReceipts(now: number): number {
    return this.#sql.exec(
      "DELETE FROM http_receipts WHERE created_at_ms < ?",
      now - HTTP_RECEIPT_RETENTION_MS,
    ).rowsWritten;
  }

  private assertMoveCopyClosureTarget(items: readonly BoardItem[]): void {
    this.assertSectionRelationshipTargets(items);
    const violation = findMoveCopyClosureLimitViolation(items);
    if (violation === null) return;
    throw new BoardDomainError(
      "BOARD_LIMIT_REACHED",
      `A group or Section move/copy closure may contain at most ${MAX_BATCH_OPERATIONS} objects.`,
      { ...violation, limit: MAX_BATCH_OPERATIONS },
    );
  }

  private assertSectionRelationshipTargets(items: Iterable<BoardItem>): void {
    const itemIndex = new Map<string, BoardItem>();
    for (const item of items) itemIndex.set(item.id, item);
    for (const item of itemIndex.values()) {
      if (item.sectionId === undefined) continue;
      if (item.kind !== "zone" && itemIndex.get(item.sectionId)?.kind === "zone") continue;
      throw new BoardDomainError(
        "INVALID_FRAME",
        "Every Section relationship must reference a live Section.",
        { sectionId: item.sectionId, itemId: item.id },
      );
    }
  }

  /**
   * Scans the whole live topology only when an effect changes a grouping edge
   * or creates/deletes a Section. The prepared effect overlay is checked in
   * the same SQLite transaction, before any durable action or item write.
   */
  private assertProspectiveMoveCopyClosure(
    effects: readonly ItemEffect[],
    target: "before" | "after",
    knownCurrentItems?: readonly BoardItem[],
    ownership?: ItemOwnershipContext,
  ): number {
    if (!effects.some(topologyChanged)) return 0;

    const currentItems = knownCurrentItems ?? readLiveItems(this.#sql);
    if (ownership !== undefined) {
      assertGroupMembershipOwnership(effects, target, currentItems, ownership);
    }
    const current = new Map(currentItems.map((item) => [item.id, item]));
    const deletedSectionIds = deletedSectionIdsForTarget(effects, target);

    const prospective = new Map(current);
    for (const effect of effects) {
      const state = effect[target];
      if (state.exists) prospective.set(effect.itemId, state.item);
      else prospective.delete(effect.itemId);
    }

    if (deletedSectionIds.size > 0) {
      for (const item of prospective.values()) {
        if (item.sectionId === undefined || !deletedSectionIds.has(item.sectionId)) continue;
        throw new BoardDomainError(
          "INVALID_FRAME",
          "Deleting a Section must clear every surviving member relationship in the same operation.",
          { sectionId: item.sectionId, itemId: item.id },
        );
      }
    }

    this.assertSectionRelationshipTargets(prospective.values());

    const violation = findMoveCopyClosureLimitViolation(prospective.values());
    if (violation === null) return currentItems.length;

    // Older workers could persist an oversized closure. Edge and Section
    // removal cannot enlarge any closure, so permit those monotonic repairs
    // (and board.clear remains independently available) until the board is
    // valid again.
    if (
      topologyChangesOnlyRemove(effects, target) &&
      findMoveCopyClosureLimitViolation(currentItems) !== null
    ) {
      this.log("warn", "topology.oversize_remediation", {
        result: violation.itemCount,
        seedItemId: violation.seedItemId,
      });
      return currentItems.length;
    }

    throw new BoardDomainError(
      "BOARD_LIMIT_REACHED",
      `A group or Section move/copy closure may contain at most ${MAX_BATCH_OPERATIONS} objects.`,
      { ...violation, limit: MAX_BATCH_OPERATIONS },
    );
  }

  private projectSnapshotAccounting(
    board: BoardRow,
    changes: Iterable<{ before?: ItemRecord; after?: BoardItem }>,
  ): { itemCount: number; itemBytes: number } {
    if (board.snapshot_live_item_count < 0 || board.snapshot_live_item_bytes < 0) {
      throw new BoardDomainError("INTERNAL_ERROR", "Snapshot accounting is unavailable.");
    }
    let itemCount = board.snapshot_live_item_count;
    let itemBytes = board.snapshot_live_item_bytes;
    for (const change of changes) {
      if (change.before !== undefined && !change.before.deleted) {
        itemCount -= 1;
        itemBytes -= canonicalSnapshotItemByteLength(
          change.before.item as unknown as ProtocolBoardItem,
        );
      }
      if (change.after !== undefined) {
        itemCount += 1;
        itemBytes += canonicalSnapshotItemByteLength(change.after as unknown as ProtocolBoardItem);
      }
    }
    if (itemCount < 0 || itemBytes < 0 || !Number.isSafeInteger(itemBytes)) {
      throw new BoardDomainError("INTERNAL_ERROR", "Snapshot accounting became inconsistent.");
    }
    return { itemCount, itemBytes };
  }

  private assertProspectiveSnapshotFits(
    board: BoardRow,
    accounting: { itemCount: number; itemBytes: number },
    metadata: { seq: number; createdAt: number; title?: string },
  ): void {
    const prospectiveBytes = canonicalSnapshotByteLengthFromParts({
      boardId: board.public_id,
      seq: metadata.seq,
      createdAt: metadata.createdAt,
      settings: { title: metadata.title ?? board.title },
      ...accounting,
    });
    if (prospectiveBytes <= MAX_SNAPSHOT_BYTES) return;

    // A legacy board may predate prospective admission. Permit only strict
    // byte reduction until it is back within the canonical snapshot limit.
    const currentBytes = canonicalSnapshotByteLengthFromParts({
      boardId: board.public_id,
      seq: board.latest_seq,
      createdAt: snapshotCreatedAt(this.#sql, board),
      settings: { title: board.title },
      itemCount: board.snapshot_live_item_count,
      itemBytes: board.snapshot_live_item_bytes,
    });
    if (currentBytes > MAX_SNAPSHOT_BYTES && prospectiveBytes < currentBytes) {
      this.log("warn", "snapshot.oversize_remediation", {
        seq: metadata.seq,
        result: prospectiveBytes,
      });
      return;
    }
    throw new BoardDomainError(
      "BOARD_LIMIT_REACHED",
      "The change would make the canonical board snapshot exceed 20 MiB.",
    );
  }

  private ensureDatabaseWriteCapacity(): void {
    if (this.#sql.databaseSize >= BOARD_DATABASE_WRITE_LIMIT_BYTES) {
      throw new BoardDomainError(
        "TEMPORARILY_UNAVAILABLE",
        "The board storage safety threshold was reached. Export the board and contact support.",
      );
    }
  }

  /**
   * Called from the mutation's SQLite transaction immediately before sequence
   * allocation. Keeping compaction in that transaction makes the replay floor
   * and the rows it describes advance atomically.
   */
  private ensureActionCapacity(board: BoardRow): number {
    const retained = this.actionCount();
    let rowsWritten = 0;
    if (retained >= ACTION_COMPACTION_TRIGGER) {
      rowsWritten = this.compactActions(Date.now(), ACTION_COMPACTION_TARGET, board);
    }
    const afterCompaction = this.actionCount();
    if (afterCompaction >= MAX_UNCOMPACTED_ACTIONS) {
      throw new BoardDomainError(
        "BOARD_LIMIT_REACHED",
        "The emergency uncheckpointed action limit was reached. Retry after snapshot storage recovers.",
      );
    }
    if (
      afterCompaction >= ACTION_COMPACTION_TRIGGER &&
      (afterCompaction === ACTION_COMPACTION_TRIGGER || afterCompaction % 1_000 === 0)
    ) {
      this.log("warn", "actions.compaction_deferred", {
        seq: board.latest_seq,
        result: afterCompaction,
      });
    }
    this.ensureDatabaseWriteCapacity();
    return rowsWritten;
  }

  private actionCount(): number {
    return this.#sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions").one().count;
  }

  /**
   * Compacts only a prefix covered by persisted snapshot metadata. The latest
   * replay window remains in `actions`; normal-action effects needed by active
   * undo/redo live independently in `history_entries`; recent command results
   * move to `action_receipts` for the client outbox retry lifetime.
   *
   * The caller owns the surrounding SQLite transaction.
   */
  private compactActions(
    now: number,
    targetCount = ACTION_COMPACTION_TARGET,
    capturedBoard?: BoardRow,
  ): number {
    let rowsWritten = this.pruneExpiredActionReceipts(now);
    const retained = this.actionCount();
    if (retained <= targetCount) return rowsWritten;

    const board = capturedBoard ?? this.requireBoard();
    const snapshot = this.#sql
      .exec<{ seq: number }>(
        `SELECT seq FROM snapshots
         WHERE seq <= ? ORDER BY seq DESC LIMIT 1`,
        board.latest_seq,
      )
      .toArray()[0];
    if (snapshot === undefined) return rowsWritten;

    // Replay is bounded to 100 actions per connection today. Retaining ten
    // times that window leaves operational margin while keeping compaction
    // deterministic even after earlier prefixes have already been removed.
    const oldestReplayAction = this.#sql
      .exec<{ seq: number }>(
        `SELECT seq FROM actions ORDER BY seq DESC LIMIT 1 OFFSET ?`,
        MIN_REPLAY_RETENTION_ACTIONS - 1,
      )
      .toArray()[0];
    if (oldestReplayAction === undefined) return rowsWritten;
    const safeThrough = Math.min(snapshot.seq, oldestReplayAction.seq - 1);
    if (safeThrough < 1) return rowsWritten;

    const desired = retained - targetCount;
    const candidates = this.#sql
      .exec<ActionRow>(
        `SELECT * FROM actions
         WHERE seq <= ? ORDER BY seq LIMIT ?`,
        safeThrough,
        desired,
      )
      .toArray();
    if (candidates.length === 0) return rowsWritten;

    // A forward migration copied every normal action's private effects into
    // history_entries. Refuse to delete any prefix if that proof is incomplete.
    const deleteThrough = candidates[candidates.length - 1]?.seq;
    if (deleteThrough === undefined) return rowsWritten;
    const missingHistoryLineage = this.#sql
      .exec<{ present: number }>(
        `SELECT 1 AS present FROM history_entries
         WHERE normal_action_seq <= ? AND state IN ('active', 'undone')
           AND (action_id IS NULL OR payload_json IS NULL)
         LIMIT 1`,
        deleteThrough,
      )
      .toArray()[0];
    if (missingHistoryLineage !== undefined) return rowsWritten;

    const receiptCutoff = now - ACTION_RECEIPT_RETENTION_MS;
    for (const candidate of candidates) {
      if (candidate.accepted_at_ms < receiptCutoff) continue;
      const stored = parseStoredActionPayload(candidate.payload_json);
      const receiptPayload = JSON.stringify({ publicResult: stored.publicResult, effects: [] });
      rowsWritten += this.#sql.exec(
        `INSERT INTO action_receipts(
           command_id, action_id, actor_id, request_hash, payload_json, accepted_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        candidate.command_id,
        candidate.action_id,
        candidate.actor_id,
        candidate.request_hash,
        receiptPayload,
        candidate.accepted_at_ms,
      ).rowsWritten;
    }

    // Invalidated entries can never become an undo or redo candidate. Active
    // and undone entries (including private effects) are intentionally kept,
    // which is stronger than the required latest-1,000 history guarantee.
    rowsWritten += this.#sql.exec(
      `DELETE FROM history_entries
       WHERE normal_action_seq <= ? AND state = 'invalidated'`,
      deleteThrough,
    ).rowsWritten;
    const deleted = this.#sql.exec("DELETE FROM actions WHERE seq <= ?", deleteThrough);
    rowsWritten += deleted.rowsWritten;
    rowsWritten += this.#sql.exec(
      "UPDATE board SET min_replay_seq = MAX(min_replay_seq, ?) WHERE singleton = 1",
      deleteThrough,
    ).rowsWritten;
    this.log("info", "actions.compacted", {
      seq: deleteThrough,
      result: deleted.rowsWritten,
    });
    return rowsWritten;
  }

  private pruneExpiredActionReceipts(now: number): number {
    return this.#sql.exec(
      "DELETE FROM action_receipts WHERE accepted_at_ms < ?",
      now - ACTION_RECEIPT_RETENTION_MS,
    ).rowsWritten;
  }

  private ensureItemIdentityCapacity(additional: number, currentCount?: number): void {
    if (additional <= 0) return;
    const count =
      currentCount ??
      this.#sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM items").one().count;
    if (count + additional > MAX_ITEM_IDENTITIES) {
      throw new BoardDomainError(
        "BOARD_LIMIT_REACHED",
        "The board permanent item identity limit was reached.",
      );
    }
  }

  private ensureInvitationCapacity(): void {
    const count = this.#sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM invitations")
      .one().count;
    if (count >= MAX_INVITATIONS) {
      throw new BoardDomainError("BOARD_LIMIT_REACHED", "The board invitation limit was reached.");
    }
  }

  private ensureMemberCapacity(): void {
    const count = this.#sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM members")
      .one().count;
    if (count >= MAX_MEMBERS) {
      throw new BoardDomainError("BOARD_LIMIT_REACHED", "The board member limit was reached.");
    }
  }

  private upsertSnapshotJob(seq: number, acceptedAt: number, latestSnapshotSeq: number): number {
    const existing = this.#sql
      .exec<{ due_at_ms: number }>(
        "SELECT due_at_ms FROM scheduled_jobs WHERE job_name = 'snapshot'",
      )
      .toArray()[0];
    const thresholdReached = seq - latestSnapshotSeq >= SNAPSHOT_ACTION_INTERVAL;
    if (existing === undefined) {
      return this.#sql.exec(
        `INSERT INTO scheduled_jobs(job_name, due_at_ms, attempt, payload_json, updated_at_ms)
         VALUES ('snapshot', ?, 0, '{}', ?)`,
        thresholdReached ? acceptedAt : acceptedAt + SNAPSHOT_TIME_MS,
        acceptedAt,
      ).rowsWritten;
    }
    if (!thresholdReached || existing.due_at_ms <= acceptedAt) return 0;

    // Crossing 250 dirty actions may make an existing time-based job due now.
    // The stored due time is then already <= every later action timestamp, so
    // this can update at most once for a dirty interval.
    return this.#sql.exec(
      `UPDATE scheduled_jobs SET due_at_ms = ?, updated_at_ms = ?
       WHERE job_name = 'snapshot' AND due_at_ms > ?`,
      acceptedAt,
      acceptedAt,
      acceptedAt,
    ).rowsWritten;
  }

  private scheduleNextAlarmAfterCommit(): void {
    this.ctx.waitUntil(
      this.scheduleNextAlarm().catch(() => {
        this.log("error", "snapshot.schedule_failed", { code: "ALARM_WRITE_FAILED" });
      }),
    );
  }

  private async scheduleNextAlarm(): Promise<void> {
    // Read the physical alarm before the logical job. Awaiting getAlarm() can
    // yield to a later action that advances the job, so querying the job after
    // that yield prevents this task from restoring a stale, later due time.
    const current = await this.ctx.storage.getAlarm();
    const next = this.#sql
      .exec<{ due_at_ms: number }>(
        "SELECT due_at_ms FROM scheduled_jobs ORDER BY due_at_ms LIMIT 1",
      )
      .toArray()[0];
    if (next === undefined) return;
    if (current === null || next.due_at_ms < current)
      await this.ctx.storage.setAlarm(next.due_at_ms);
  }

  private async persistSnapshotObject(snapshot: CanonicalSnapshot): Promise<{
    key: string;
    sha256: string;
    bytes: Uint8Array;
    r2Reads: number;
    r2Writes: number;
    r2Bytes: number;
    sqliteRowsWritten: number;
  }> {
    const accounting = snapshotAccountingForItems(snapshot.items);
    const current = readBoard(this.#sql);
    let sqliteRowsWritten = 0;
    if (
      current !== null &&
      current.latest_seq === snapshot.seq &&
      (current.snapshot_live_item_count !== accounting.itemCount ||
        current.snapshot_live_item_bytes !== accounting.itemBytes)
    ) {
      this.ctx.storage.transactionSync(() => {
        sqliteRowsWritten = this.#sql.exec(
          `UPDATE board SET snapshot_live_item_count = ?, snapshot_live_item_bytes = ?
           WHERE singleton = 1 AND latest_seq = ?`,
          accounting.itemCount,
          accounting.itemBytes,
          snapshot.seq,
        ).rowsWritten;
      });
      this.log("error", "snapshot.accounting_reconciled", {
        seq: snapshot.seq,
        result: accounting.itemBytes,
      });
    }
    const serialized = serializeSnapshot(snapshot);
    const bytes = utf8(serialized);
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The canonical board snapshot is too large.");
    }
    const digest = await sha256Base64Url(bytes);
    const key = `boards/${snapshot.boardId}/snapshots/${snapshot.seq}.json`;
    const result = await putImmutableR2Object(this.env.BOARD_SNAPSHOTS, key, bytes, {
      sha256: digest,
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    const wroteObject = result.disposition !== "preexisting";
    return {
      key,
      sha256: digest,
      bytes,
      r2Reads: result.disposition === "lost-race" ? 2 : 1,
      r2Writes: wroteObject ? 1 : 0,
      r2Bytes: wroteObject ? bytes.byteLength : 0,
      sqliteRowsWritten,
    };
  }

  private recordIncomingFrame(): void {
    this.#pendingFrameCount += 1;
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    safeLog(level, event, { ...this.#telemetry, ...fields });
  }

  private recordTrafficFrame(kind: "preview" | "commit"): void {
    if (kind === "preview") this.#previewFrames += 1;
    else this.#commitFrames += 1;
    this.flushTrafficMetrics();
  }

  private flushTrafficMetrics(force = false): void {
    const now = Date.now();
    const sampleWindowMs = Math.max(1, now - this.#trafficWindowStartedAt);
    if (!force && sampleWindowMs < TELEMETRY_AGGREGATE_INTERVAL_MS) return;
    if (this.#previewFrames === 0 && this.#commitFrames === 0) {
      this.#trafficWindowStartedAt = now;
      return;
    }
    this.log("info", "traffic.metrics", {
      previewFrames: this.#previewFrames,
      commitFrames: this.#commitFrames,
      sampleWindowMs,
    });
    this.#previewFrames = 0;
    this.#commitFrames = 0;
    this.#trafficWindowStartedAt = now;
  }

  private emitBoardMetrics(forceFinalZero = false): void {
    const board = readBoard(this.#sql);
    if (board === null) return;
    const now = Date.now();
    const activeSockets = this.activeSocketCounts("").total;
    const itemCount = Math.max(0, board.snapshot_live_item_count);
    const storageBytesEstimate = canonicalSnapshotByteLengthFromParts({
      boardId: board.public_id,
      seq: board.latest_seq,
      createdAt: snapshotCreatedAt(this.#sql, board),
      settings: { title: board.title },
      itemCount,
      itemBytes: Math.max(0, board.snapshot_live_item_bytes),
    });
    const signature = [
      activeSockets,
      board.latest_seq,
      board.latest_snapshot_seq,
      itemCount,
      storageBytesEstimate,
    ].join(":");
    const finalZero = forceFinalZero && activeSockets === 0;
    if (signature === this.#lastBoardMetricsSignature && !finalZero) return;
    if (!finalZero && now - this.#lastBoardMetricsAt < TELEMETRY_AGGREGATE_INTERVAL_MS) return;
    this.log("info", "board.metrics", {
      activeSockets,
      snapshotLagActions: Math.max(0, board.latest_seq - board.latest_snapshot_seq),
      snapshotLagMs:
        board.dirty_since_at_ms === null ? 0 : Math.max(0, now - board.dirty_since_at_ms),
      itemCount,
      storageBytesEstimate,
      itemLimitUtilization: Math.min(1, itemCount / LIMITS.maxItems),
      storageLimitUtilization: Math.min(1, storageBytesEstimate / MAX_SNAPSHOT_BYTES),
    });
    this.#lastBoardMetricsAt = now;
    this.#lastBoardMetricsSignature = signature;
  }

  /**
   * Rolls authoritative per-action accounting into daily aggregates. Action
   * estimates live on the existing `actions` row, so eviction cannot lose
   * them and accepting an action does not write an additional usage row.
   */
  private checkpointUsage(
    fromSequence: number,
    throughSequence: number,
    extra: UsageInput & { incomingFrames?: number },
    now = Date.now(),
  ): number {
    const rows = this.#sql
      .exec<{
        day_utc: string;
        incoming_frames: number;
        rows_read_estimate: number;
        rows_written_estimate: number;
        r2_reads: number;
        r2_writes: number;
        r2_bytes: number;
        snapshots: number;
        actions: number;
      }>(
        `SELECT strftime('%Y-%m-%d', accepted_at_ms / 1000, 'unixepoch') AS day_utc,
          SUM(usage_incoming_frames) AS incoming_frames,
          SUM(usage_rows_read_estimate) AS rows_read_estimate,
          SUM(usage_rows_written_estimate) AS rows_written_estimate,
          SUM(usage_r2_reads) AS r2_reads,
          SUM(usage_r2_writes) AS r2_writes,
          SUM(usage_r2_bytes) AS r2_bytes,
          SUM(usage_snapshots) AS snapshots,
          COUNT(*) AS actions
         FROM actions
         WHERE seq > ? AND seq <= ?
         GROUP BY day_utc ORDER BY day_utc`,
        fromSequence,
        throughSequence,
      )
      .toArray();
    const byDay = new Map<string, UsageDelta>();
    for (const row of rows) {
      byDay.set(row.day_utc, {
        incomingFrames: row.incoming_frames,
        rowsReadEstimate: row.rows_read_estimate,
        rowsWrittenEstimate: row.rows_written_estimate,
        r2Reads: row.r2_reads,
        r2Writes: row.r2_writes,
        r2Bytes: row.r2_bytes,
        actions: row.actions,
        snapshots: row.snapshots,
      });
    }

    const extraDelta: UsageDelta = {
      incomingFrames: extra.incomingFrames ?? 0,
      rowsReadEstimate: extra.rowsReadEstimate ?? 0,
      rowsWrittenEstimate: extra.rowsWrittenEstimate ?? 0,
      r2Reads: extra.r2Reads ?? 0,
      r2Writes: extra.r2Writes ?? 0,
      r2Bytes: extra.r2Bytes ?? 0,
      actions: extra.actions ?? 0,
      snapshots: extra.snapshots ?? 0,
    };
    if (Object.values(extraDelta).some((value) => value !== 0)) {
      const day = utcUsageDay(now);
      const current = byDay.get(day);
      if (current === undefined) byDay.set(day, extraDelta);
      else {
        for (const key of Object.keys(extraDelta) as Array<keyof UsageDelta>) {
          current[key] += extraDelta[key];
        }
      }
    }

    for (const [day, delta] of byDay) {
      // Count this aggregate upsert itself. Recompute billing from cumulative
      // frames so separate checkpoint batches do not each round up to 20.
      this.#sql.exec(
        `INSERT INTO usage_counters(
          day_utc, incoming_frames, billed_request_estimate, rows_read_estimate,
          rows_written_estimate, r2_reads, r2_writes, r2_bytes, actions, snapshots,
          updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day_utc) DO UPDATE SET
          incoming_frames = usage_counters.incoming_frames + excluded.incoming_frames,
          billed_request_estimate =
            (usage_counters.incoming_frames + excluded.incoming_frames + 19) / 20,
          rows_read_estimate = usage_counters.rows_read_estimate + excluded.rows_read_estimate,
          rows_written_estimate =
            usage_counters.rows_written_estimate + excluded.rows_written_estimate,
          r2_reads = usage_counters.r2_reads + excluded.r2_reads,
          r2_writes = usage_counters.r2_writes + excluded.r2_writes,
          r2_bytes = usage_counters.r2_bytes + excluded.r2_bytes,
          actions = usage_counters.actions + excluded.actions,
          snapshots = usage_counters.snapshots + excluded.snapshots,
          updated_at_ms = excluded.updated_at_ms`,
        day,
        delta.incomingFrames,
        Math.ceil(delta.incomingFrames / 20),
        delta.rowsReadEstimate,
        delta.rowsWrittenEstimate + 1,
        delta.r2Reads,
        delta.r2Writes,
        delta.r2Bytes,
        delta.actions,
        delta.snapshots,
        now,
      );
    }
    this.queueQuotaDaily(byDay.keys());
    return byDay.size;
  }

  private queueQuotaDaily(days: Iterable<string>): void {
    for (const day of days) this.#pendingQuotaDays.add(day);
    if (this.#pendingQuotaDays.size === 0 || this.#quotaEmissionScheduled) return;
    this.#quotaEmissionScheduled = true;
    this.ctx.waitUntil(
      Promise.resolve().then(() => {
        this.#quotaEmissionScheduled = false;
        const pending = [...this.#pendingQuotaDays];
        this.#pendingQuotaDays.clear();
        this.emitQuotaDaily(pending);
      }),
    );
  }

  private emitQuotaDaily(days: Iterable<string>): void {
    if (this.#telemetry.boardIdHash === undefined) return;
    for (const day of days) {
      const usage = this.#sql
        .exec<{
          incoming_frames: number;
          billed_request_estimate: number;
          rows_read_estimate: number;
          rows_written_estimate: number;
          r2_reads: number;
          r2_writes: number;
          r2_bytes: number;
          actions: number;
          snapshots: number;
        }>(
          `SELECT incoming_frames, billed_request_estimate, rows_read_estimate,
            rows_written_estimate, r2_reads, r2_writes, r2_bytes, actions, snapshots
           FROM usage_counters WHERE day_utc = ?`,
          day,
        )
        .toArray()[0];
      if (usage === undefined) continue;
      this.log("info", "quota.daily", {
        quotaDayUtc: day,
        incomingFrames: usage.incoming_frames,
        durableObjectRequestUnitsEstimate: usage.billed_request_estimate,
        sqliteRowsRead: usage.rows_read_estimate,
        sqliteRowsWritten: usage.rows_written_estimate,
        r2Reads: usage.r2_reads,
        r2Writes: usage.r2_writes,
        r2BytesWritten: usage.r2_bytes,
        actions: usage.actions,
        snapshots: usage.snapshots,
      });
    }
  }

  private async pruneRetention(now: number): Promise<void> {
    this.pruneExpiredHttpReceipts(now);
    this.pruneExpiredActionReceipts(now);
    const automatic = this.#sql
      .exec<{ seq: number; r2_json_key: string }>(
        `SELECT seq, r2_json_key FROM snapshots
         WHERE kind = 'automatic' ORDER BY seq DESC LIMIT ? OFFSET ?`,
        MAX_RETENTION_DELETES_PER_ALARM,
        RETAINED_AUTOMATIC_SNAPSHOTS,
      )
      .toArray();
    const remaining = Math.max(0, MAX_RETENTION_DELETES_PER_ALARM - automatic.length);
    const expiredPreClear =
      remaining === 0
        ? []
        : this.#sql
            .exec<{ seq: number; r2_json_key: string }>(
              `SELECT seq, r2_json_key FROM snapshots
               WHERE kind = 'pre_clear' AND created_at_ms < ?
               ORDER BY seq ASC LIMIT ?`,
              now - PRE_CLEAR_RETENTION_MS,
              remaining,
            )
            .toArray();
    const candidates = [...automatic, ...expiredPreClear];
    const removedKeys: string[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const candidate of candidates) {
        const deleted = this.#sql.exec(
          `DELETE FROM snapshots
           WHERE seq = ? AND r2_json_key = ? AND kind IN ('automatic', 'pre_clear')`,
          candidate.seq,
          candidate.r2_json_key,
        );
        if (deleted.rowsWritten > 0) {
          this.#sql.exec("DELETE FROM snapshot_attribution WHERE seq = ?", candidate.seq);
          removedKeys.push(candidate.r2_json_key);
        }
      }
    });
    for (const key of removedKeys) {
      try {
        await this.env.BOARD_SNAPSHOTS.delete(key);
      } catch {
        // Metadata is already safely outside retention. A later reconciliation
        // can remove this now-unreferenced immutable object.
        this.log("warn", "snapshot.retention_r2_delete_failed", {
          code: "R2_DELETE_FAILED",
        });
      }
    }
  }

  private async runRetentionSafely(now: number): Promise<void> {
    try {
      await this.pruneRetention(now);
    } catch {
      this.log("warn", "snapshot.retention_failed", { code: "RETENTION_FAILED" });
    }
  }

  async alarm(): Promise<void> {
    const job = this.#sql
      .exec<{ due_at_ms: number; attempt: number }>(
        "SELECT due_at_ms, attempt FROM scheduled_jobs WHERE job_name = 'snapshot'",
      )
      .toArray()[0];
    if (job === undefined) return;
    const board = this.requireBoard();
    // A metadata archive may leave a one-shot physical alarm behind. Archived
    // boards are terminal, so the wake performs no snapshot or rescheduling.
    if (board.archived_at_ms !== null) return;
    const now = Date.now();
    if (job.due_at_ms > now) {
      await this.scheduleNextAlarm();
      return;
    }
    const existing = this.#sql
      .exec<{ seq: number }>("SELECT seq FROM snapshots WHERE seq = ?", board.latest_seq)
      .toArray()[0];
    if (existing !== undefined) {
      const recordedFrames = this.#pendingFrameCount;
      this.ctx.storage.transactionSync(() => {
        const jobRowsWritten = this.#sql.exec(
          "DELETE FROM scheduled_jobs WHERE job_name = 'snapshot'",
        ).rowsWritten;
        const boardRowsWritten = this.#sql.exec(
          `UPDATE board SET latest_snapshot_seq = MAX(latest_snapshot_seq, ?),
           dirty_since_seq = NULL, dirty_since_at_ms = NULL,
           usage_checkpoint_seq = MAX(usage_checkpoint_seq, ?)
           WHERE singleton = 1`,
          board.latest_seq,
          board.latest_seq,
        ).rowsWritten;
        this.checkpointUsage(
          board.usage_checkpoint_seq,
          board.latest_seq,
          {
            incomingFrames: recordedFrames,
            rowsReadEstimate: 3,
            rowsWrittenEstimate: jobRowsWritten + boardRowsWritten,
          },
          now,
        );
        const compactedRows = this.compactActions(now);
        if (compactedRows > 0) {
          this.checkpointUsage(
            board.latest_seq,
            board.latest_seq,
            { rowsReadEstimate: 4, rowsWrittenEstimate: compactedRows },
            now,
          );
        }
      });
      this.#pendingFrameCount = Math.max(0, this.#pendingFrameCount - recordedFrames);
      await this.runRetentionSafely(now);
      return;
    }
    const snapshot = captureSnapshot(this.#sql, board);
    const snapshotAttribution = this.captureSnapshotAttribution(snapshot.items);
    const snapshotStartedAt = performance.now();
    try {
      const stored = await this.persistSnapshotObject(snapshot);
      const recordedFrames = this.#pendingFrameCount;
      this.ctx.storage.transactionSync(() => {
        const current = this.requireBoard();
        const snapshotRowsWritten = this.#sql.exec(
          `INSERT INTO snapshots(
            seq, r2_json_key, sha256, item_count, byte_count, kind, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'automatic', ?)
          ON CONFLICT(seq) DO NOTHING`,
          snapshot.seq,
          stored.key,
          stored.sha256,
          snapshot.items.length,
          stored.bytes.byteLength,
          snapshot.createdAt,
        ).rowsWritten;
        const snapshotAttributionRowsWritten = this.writeSnapshotAttribution(
          snapshot.seq,
          snapshotAttribution,
        );
        let jobRowsWritten: number;
        let boardRowsWritten: number;
        let physicalAlarmRowsWritten = 0;
        if (current.latest_seq === snapshot.seq) {
          jobRowsWritten = this.#sql.exec(
            "DELETE FROM scheduled_jobs WHERE job_name = 'snapshot'",
          ).rowsWritten;
          boardRowsWritten = this.#sql.exec(
            `UPDATE board SET latest_snapshot_seq = MAX(latest_snapshot_seq, ?),
             dirty_since_seq = NULL, dirty_since_at_ms = NULL,
             usage_checkpoint_seq = MAX(usage_checkpoint_seq, ?)
             WHERE singleton = 1`,
            snapshot.seq,
            snapshot.seq,
          ).rowsWritten;
        } else {
          const firstDirty = this.#sql
            .exec<{ seq: number; accepted_at_ms: number }>(
              "SELECT seq, accepted_at_ms FROM actions WHERE seq > ? ORDER BY seq LIMIT 1",
              snapshot.seq,
            )
            .one();
          const dueAt =
            current.latest_seq - snapshot.seq >= SNAPSHOT_ACTION_INTERVAL
              ? now
              : firstDirty.accepted_at_ms + SNAPSHOT_TIME_MS;
          boardRowsWritten = this.#sql.exec(
            `UPDATE board SET latest_snapshot_seq = MAX(latest_snapshot_seq, ?),
             dirty_since_seq = ?, dirty_since_at_ms = ?,
             usage_checkpoint_seq = MAX(usage_checkpoint_seq, ?)
             WHERE singleton = 1`,
            snapshot.seq,
            firstDirty.seq,
            firstDirty.accepted_at_ms,
            snapshot.seq,
          ).rowsWritten;
          jobRowsWritten = this.#sql.exec(
            "UPDATE scheduled_jobs SET due_at_ms = ?, attempt = 0, updated_at_ms = ? WHERE job_name = 'snapshot'",
            dueAt,
            now,
          ).rowsWritten;
          // The currently executing alarm is one-shot; retaining the logical
          // job schedules its next physical wake after this transaction.
          physicalAlarmRowsWritten = 1;
        }
        this.checkpointUsage(
          current.usage_checkpoint_seq,
          snapshot.seq,
          {
            incomingFrames: recordedFrames,
            rowsReadEstimate: snapshot.items.length + 6,
            rowsWrittenEstimate:
              stored.sqliteRowsWritten +
              snapshotRowsWritten +
              snapshotAttributionRowsWritten +
              boardRowsWritten +
              jobRowsWritten +
              physicalAlarmRowsWritten +
              job.attempt * 2,
            r2Reads: stored.r2Reads,
            r2Writes: stored.r2Writes,
            r2Bytes: stored.r2Bytes,
            snapshots: snapshotRowsWritten,
          },
          now,
        );
        const compactedRows = this.compactActions(now, ACTION_COMPACTION_TARGET, current);
        if (compactedRows > 0) {
          this.checkpointUsage(
            snapshot.seq,
            snapshot.seq,
            { rowsReadEstimate: 4, rowsWrittenEstimate: compactedRows },
            now,
          );
        }
      });
      this.#pendingFrameCount = Math.max(0, this.#pendingFrameCount - recordedFrames);
      this.log("info", "snapshot.completed", {
        seq: snapshot.seq,
        itemCount: snapshot.items.length,
        result: "completed",
        code: "OK",
        durationMs: Math.round(performance.now() - snapshotStartedAt),
        r2BytesWritten: stored.r2Bytes,
      });
      this.emitBoardMetrics();
    } catch {
      const attempt = Math.min(job.attempt + 1, 10);
      const delay = Math.min(15 * 60_000, 5_000 * 2 ** attempt);
      this.#sql.exec(
        "UPDATE scheduled_jobs SET due_at_ms = ?, attempt = ?, updated_at_ms = ? WHERE job_name = 'snapshot'",
        now + delay,
        attempt,
        now,
      );
      this.log("error", "snapshot.failed", {
        attempt,
        result: "failed",
        code: "R2_WRITE_FAILED",
        seq: snapshot.seq,
        durationMs: Math.round(performance.now() - snapshotStartedAt),
        r2BytesWritten: 0,
      });
    }
    await this.runRetentionSafely(now);
    await this.scheduleNextAlarm();
  }
}

function requireCommentBody(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "Comment text is required.");
  }
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  validateUnicodeText(normalized, "comment");
  if (
    normalized.length === 0 ||
    [...normalized].length > MAX_COMMENT_CODE_POINTS ||
    containsDisallowedControlCharacter(normalized)
  ) {
    throw new HttpError(
      400,
      "BAD_REQUEST",
      `Comments must be 1 to ${MAX_COMMENT_CODE_POINTS} visible characters.`,
    );
  }
  return normalized;
}

/**
 * Reads the optional writer metadata from a comment create body. Returns null for a typed
 * comment; both `assistedBy` and `assistance` must be present together for an assisted one.
 */
function requireCommentAssistance(body: Record<string, unknown>): Assistance | null {
  const hasAssistedBy = Object.hasOwn(body, "assistedBy");
  const hasAssistance = Object.hasOwn(body, "assistance");
  if (!hasAssistedBy && !hasAssistance) return null;
  if (hasAssistedBy !== hasAssistance) {
    throw new HttpError(400, "BAD_REQUEST", "assistedBy and assistance must be provided together.");
  }
  if (body.assistedBy !== "ai") {
    throw new HttpError(400, "BAD_REQUEST", "assistedBy must be 'ai'.");
  }
  const assistance = body.assistance;
  if (!isRecord(assistance)) {
    throw new HttpError(400, "BAD_REQUEST", "assistance must be an object.");
  }
  assertExactKeys(assistance, ["tool", "action"], ["tool"]);
  if (typeof assistance.tool !== "string" || !ASSISTANCE_TOOL_PATTERN.test(assistance.tool)) {
    throw new HttpError(400, "BAD_REQUEST", "assistance.tool must be a valid tool name.");
  }
  if (assistance.action === undefined) return { tool: assistance.tool };
  if (
    typeof assistance.action !== "string" ||
    !(ASSIST_ACTIONS as readonly string[]).includes(assistance.action)
  ) {
    throw new HttpError(400, "BAD_REQUEST", "assistance.action is not a supported action.");
  }
  return { tool: assistance.tool, action: assistance.action as AssistAction };
}

/**
 * Reads the optional picture or video a comment carries. The shared normalizer decides the
 * shape; this adds the text rules the board applies to every participant-authored string and
 * the stored bound the comment row is written under.
 */
function requireCommentMedia(body: Record<string, unknown>): CommentMedia | null {
  if (!Object.hasOwn(body, "media")) return null;
  if (body.media === null) {
    throw new HttpError(400, "BAD_REQUEST", "media must be an object or left out.");
  }
  let media: CommentMedia;
  try {
    media = normalizeCommentMedia(body.media);
  } catch (error) {
    if (error instanceof CommentMediaError) throw new HttpError(400, "BAD_REQUEST", error.message);
    throw error;
  }
  if (media.kind === "image" && media.alt !== undefined) {
    validateUnicodeText(media.alt, "comment image description");
    if (containsDisallowedControlCharacter(media.alt)) {
      throw new HttpError(
        400,
        "BAD_REQUEST",
        "The comment image description contains invalid characters.",
      );
    }
  }
  if (JSON.stringify(media).length > MAX_COMMENT_MEDIA_JSON_LENGTH) {
    throw new HttpError(400, "BAD_REQUEST", "The comment media is too large to store.");
  }
  return media;
}

function commentFromRow(row: CommentRow): BoardComment {
  const resolved = row.state === "resolved";
  if (
    (resolved && (row.resolved_by === null || row.resolved_at_ms === null)) ||
    (!resolved && (row.resolved_by !== null || row.resolved_at_ms !== null))
  ) {
    throw new HttpError(500, "INTERNAL_ERROR", "Stored comment data is invalid.");
  }
  const media = commentMediaFromRow(row);
  const assisted = row.assisted_by !== null;
  if (
    (assisted && (row.assisted_by !== "ai" || row.assistance_tool === null)) ||
    (!assisted && (row.assistance_tool !== null || row.assistance_action !== null)) ||
    (row.assistance_action !== null &&
      !(ASSIST_ACTIONS as readonly string[]).includes(row.assistance_action))
  ) {
    throw new HttpError(500, "INTERNAL_ERROR", "Stored comment data is invalid.");
  }
  return {
    id: row.comment_id,
    itemId: row.target_item_id,
    body: row.body,
    state: row.state,
    author: {
      id: row.created_by,
      displayName: row.author_name || fallbackDisplayName(row.created_by),
    },
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
    ...(resolved && row.resolved_by !== null && row.resolved_at_ms !== null
      ? {
          resolvedBy: {
            id: row.resolved_by,
            displayName: row.resolver_name || fallbackDisplayName(row.resolved_by),
          },
          resolvedAt: row.resolved_at_ms,
        }
      : {}),
    ...(assisted && row.assistance_tool !== null
      ? {
          assistedBy: "ai" as const,
          assistance: {
            tool: row.assistance_tool,
            ...(row.assistance_action !== null
              ? { action: row.assistance_action as AssistAction }
              : {}),
          },
        }
      : {}),
    ...(media === null ? {} : { media }),
  };
}

/**
 * Reads the stored picture or video back through the same normalizer that accepted it, so a
 * row that no longer satisfies the contract is reported as corrupt rather than served.
 */
function commentMediaFromRow(row: CommentRow): CommentMedia | null {
  if (row.media_kind === null && row.media_json === null) return null;
  if (row.media_kind === null || row.media_json === null) {
    throw new HttpError(500, "INTERNAL_ERROR", "Stored comment data is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.media_json);
  } catch {
    throw new HttpError(500, "INTERNAL_ERROR", "Stored comment data is invalid.");
  }
  let media: CommentMedia;
  try {
    media = normalizeCommentMedia(parsed);
  } catch (error) {
    if (error instanceof CommentMediaError) {
      throw new HttpError(500, "INTERNAL_ERROR", "Stored comment data is invalid.");
    }
    throw error;
  }
  if (media.kind !== row.media_kind) {
    throw new HttpError(500, "INTERNAL_ERROR", "Stored comment data is invalid.");
  }
  return media;
}

function topologyItem(state: ItemEffect["before"]): BoardItem | undefined {
  return state.exists ? state.item : undefined;
}

function deletedSectionIdsForTarget(
  effects: readonly ItemEffect[],
  target: "before" | "after",
): Set<string> {
  const source = target === "after" ? "before" : "after";
  const deletedSectionIds = new Set<string>();
  for (const effect of effects) {
    if (!effect[target].exists && topologyItem(effect[source])?.kind === "zone") {
      deletedSectionIds.add(effect.itemId);
    }
  }
  return deletedSectionIds;
}

function topologyChanged(effect: ItemEffect): boolean {
  const before = topologyItem(effect.before);
  const after = topologyItem(effect.after);
  return (
    (before?.kind === "zone") !== (after?.kind === "zone") ||
    before?.groupId !== after?.groupId ||
    before?.sectionId !== after?.sectionId
  );
}

function topologyChangesOnlyRemove(
  effects: readonly ItemEffect[],
  target: "before" | "after",
): boolean {
  const source = target === "after" ? "before" : "after";
  let changed = false;
  for (const effect of effects) {
    const sourceItem = topologyItem(effect[source]);
    const targetItem = topologyItem(effect[target]);
    if (
      (sourceItem?.kind === "zone") === (targetItem?.kind === "zone") &&
      sourceItem?.groupId === targetItem?.groupId &&
      sourceItem?.sectionId === targetItem?.sectionId
    ) {
      continue;
    }
    changed = true;
    if (sourceItem === undefined) return false;
    if (targetItem === undefined) continue;
    if (sourceItem.kind !== "zone" && targetItem.kind === "zone") return false;
    if (sourceItem.groupId !== targetItem.groupId && targetItem.groupId !== undefined) {
      return false;
    }
    if (sourceItem.sectionId !== targetItem.sectionId && targetItem.sectionId !== undefined) {
      return false;
    }
  }
  return changed;
}

function initialBoardFeatures(value: unknown): BoardFeatures {
  if (value === undefined) return { ...DEFAULT_BOARD_FEATURES };
  const patch = requireFeaturePatch(value, true);
  try {
    return normalizeBoardFeatures({ ...DEFAULT_BOARD_FEATURES, ...patch });
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "The board feature settings are invalid.");
  }
}

function requireFeaturePatch(value: unknown, allowEmpty = false): Partial<BoardFeatures> {
  if (!isRecord(value)) {
    throw new HttpError(400, "BAD_REQUEST", "The board feature settings are invalid.");
  }
  const allowed = new Set<string>(BOARD_FEATURE_KEYS);
  const patch: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (!allowed.has(key) || typeof enabled !== "boolean") {
      throw new HttpError(400, "BAD_REQUEST", "The board feature settings are invalid.");
    }
    patch[key] = enabled;
  }
  if (!allowEmpty && Object.keys(patch).length === 0) {
    throw new HttpError(400, "BAD_REQUEST", "No feature setting change was supplied.");
  }
  return patch as Partial<BoardFeatures>;
}

function featuresForBoard(board: BoardRow): BoardFeatures {
  try {
    const features = normalizePersistedBoardFeatures(JSON.parse(board.features_json));
    if (features.images !== (board.images_enabled === 1)) {
      throw new Error("The mirrored image feature setting differs.");
    }
    return features;
  } catch {
    throw new HttpError(500, "INTERNAL_ERROR", "The board feature settings are invalid.");
  }
}

function assertOperationFeaturesEnabled(
  features: BoardFeatures,
  operation: ParsedCommit["op"],
  records: ReadonlyMap<string, ItemRecord>,
): void {
  if (
    operation.kind === "history.undo" ||
    operation.kind === "history.redo" ||
    operation.kind === "board.clear"
  ) {
    return;
  }
  const operations = operation.kind === "items.batch" ? operation.operations : [operation];
  for (const child of operations) {
    if (child.kind === "item.create") {
      if (
        !features.objectTransforms &&
        transformLinearPartChanged([1, 0, 0, 1, 0, 0], child.item.transform)
      ) {
        throw new BoardDomainError("FORBIDDEN", "Object transforms are disabled for this board.");
      }
      if (
        !features.grouping &&
        (child.item.groupId !== undefined || child.item.sectionId !== undefined)
      ) {
        throw new BoardDomainError("FORBIDDEN", "Grouping is disabled for this board.");
      }
      assertItemFeatureEnabled(features, child.item as { kind: string; geometry?: unknown });
      if (
        geometryContainsVisiblePaths(child.item.geometry) &&
        (!features.eraser || !features.partialEraser)
      ) {
        throw new BoardDomainError("FORBIDDEN", "Partial erasing is disabled for this board.");
      }
      continue;
    }
    if (child.kind === "item.update") {
      if (
        !features.grouping &&
        (typeof child.patch.groupId === "string" || typeof child.patch.sectionId === "string")
      ) {
        throw new BoardDomainError("FORBIDDEN", "Grouping is disabled for this board.");
      }
      const source = records.get(child.itemId);
      if (
        source !== undefined &&
        !source.deleted &&
        child.patch.transform !== undefined &&
        transformLinearPartChanged(source.item.transform, child.patch.transform) &&
        !features.objectTransforms
      ) {
        throw new BoardDomainError("FORBIDDEN", "Object transforms are disabled for this board.");
      }
      if (
        source !== undefined &&
        !source.deleted &&
        visiblePathsChanged(source.item.geometry, child.patch.geometry) &&
        (!features.eraser || !features.partialEraser)
      ) {
        throw new BoardDomainError("FORBIDDEN", "Partial erasing is disabled for this board.");
      }
      if (source !== undefined && !source.deleted && child.patch.geometry !== undefined) {
        const currentFeature = itemFeature(source.item as { kind: string; geometry?: unknown });
        const nextFeature = itemFeature({
          kind: source.item.kind,
          geometry: child.patch.geometry,
        });
        if (nextFeature !== currentFeature && nextFeature !== null && !features[nextFeature]) {
          throw new BoardDomainError("FORBIDDEN", "This board feature is disabled.");
        }
      }
      continue;
    }
    if (child.kind !== "item.copy") continue;
    const source = records.get(child.sourceItemId);
    const sourceItem = source !== undefined && !source.deleted ? source.item : undefined;
    if (
      sourceItem !== undefined &&
      !features.objectTransforms &&
      transformLinearPartChanged([1, 0, 0, 1, 0, 0], sourceItem.transform)
    ) {
      throw new BoardDomainError("FORBIDDEN", "Object transforms are disabled for this board.");
    }
    const effectiveGroupId =
      child.newGroupId === undefined ? sourceItem?.groupId : child.newGroupId;
    const effectiveSectionId =
      child.newSectionId === undefined ? sourceItem?.sectionId : child.newSectionId;
    if (
      !features.grouping &&
      (typeof effectiveGroupId === "string" || typeof effectiveSectionId === "string")
    ) {
      throw new BoardDomainError("FORBIDDEN", "Grouping is disabled for this board.");
    }
    if (sourceItem !== undefined) {
      assertItemFeatureEnabled(features, sourceItem as { kind: string; geometry?: unknown });
    }
  }
}

/**
 * True when the effect changes nothing about the item except its Section
 * membership (and the version bump every write carries).
 */
function isPureHistorySectionMembershipChange(effect: ItemEffect): boolean {
  const before = effect.before;
  const after = effect.after;
  if (!before.exists || !after.exists) return false;
  if (before.item.sectionId === after.item.sectionId) return false;
  return (
    stableStringify(historyItemWithoutMembership(before.item)) ===
    stableStringify(historyItemWithoutMembership(after.item))
  );
}

function historyItemWithoutMembership(item: BoardItem): Record<string, unknown> {
  const comparable = structuredClone(item) as unknown as Record<string, unknown>;
  delete comparable.version;
  delete comparable.sectionId;
  return comparable;
}

function isPureHistorySectionLockChange(effect: ItemEffect): boolean {
  const before = effect.before;
  const after = effect.after;
  if (
    !before.exists ||
    !after.exists ||
    before.item.kind !== "zone" ||
    after.item.kind !== "zone"
  ) {
    return false;
  }
  const beforeLocked = (before.item.geometry as { locked?: boolean }).locked === true;
  const afterLocked = (after.item.geometry as { locked?: boolean }).locked === true;
  return (
    beforeLocked !== afterLocked &&
    stableStringify(historySectionWithoutLock(before.item)) ===
      stableStringify(historySectionWithoutLock(after.item))
  );
}

function historySectionWithoutLock(item: BoardItem): Record<string, unknown> {
  const comparable = structuredClone(item) as unknown as Record<string, unknown>;
  delete comparable.version;
  const geometry = comparable.geometry;
  if (isRecord(geometry)) delete geometry.locked;
  return comparable;
}

function transformLinearPartChanged(current: unknown, next: unknown): boolean {
  if (!Array.isArray(current) || !Array.isArray(next)) return false;
  return [0, 1, 2, 3].some((index) => current[index] !== next[index]);
}

function visiblePathsChanged(currentGeometry: unknown, nextGeometry: unknown): boolean {
  if (!isRecord(currentGeometry) || !isRecord(nextGeometry)) return false;
  const current = currentGeometry.visiblePaths ?? null;
  const next = nextGeometry.visiblePaths ?? null;
  return stableStringify(current) !== stableStringify(next);
}

function geometryContainsVisiblePaths(geometry: unknown): boolean {
  return isRecord(geometry) && Array.isArray(geometry.visiblePaths);
}

function assertItemFeatureEnabled(
  features: BoardFeatures,
  item: { kind: string; geometry?: unknown },
): void {
  const feature = itemFeature(item);
  if (feature !== null && !features[feature]) {
    throw new BoardDomainError("FORBIDDEN", "This board feature is disabled.");
  }
}

function itemFeature(item: { kind: string; geometry?: unknown }): keyof BoardFeatures | null {
  if (isRecord(item.geometry)) {
    const subtype =
      item.geometry.polygon ?? item.geometry.shape ?? item.geometry.shapeKind ?? item.geometry.kind;
    if (typeof subtype === "string") {
      const subtypeFeature = featureForKind(subtype);
      if (subtypeFeature !== null) return subtypeFeature;
    }
  }
  return featureForKind(item.kind);
}

function featureForKind(kind: string): keyof BoardFeatures | null {
  switch (kind) {
    case "pencil":
      return "pencil";
    case "line":
      return "line";
    case "square":
      return "square";
    case "rectangle":
      return "rectangle";
    case "triangle":
      return "triangle";
    case "rhombus":
      return "rhombus";
    case "pentagon":
      return "pentagon";
    case "hexagon":
      return "hexagon";
    case "ellipse":
    case "circle":
      return "circle";
    case "text":
      return "text";
    case "sticky":
      return "stickyNotes";
    case "stamp":
      return "stamps";
    case "image":
      return "images";
    case "table":
      return "tables";
    case "zone":
    case "section":
      return "sections";
    case "protractor":
      return "protractor";
    default:
      return null;
  }
}

interface InvitationMetadata {
  id: string;
  role: BoardRole;
  label: string | null;
  maxUses: number;
  expiresAt: number;
}

function newItemIdentityCount(operation: ParsedCommit["op"]): number {
  if (operation.kind === "item.create" || operation.kind === "item.copy") return 1;
  if (operation.kind === "items.batch") {
    return operation.operations.filter(
      (child) => child.kind === "item.create" || child.kind === "item.copy",
    ).length;
  }
  return 0;
}

function readInternalActor(request: Request, fallbackRequestId: string): InternalActorContext {
  const actorId = request.headers.get(INTERNAL_ACTOR_HEADER);
  const expiryRaw = request.headers.get(INTERNAL_EXPIRY_HEADER);
  const requestId = request.headers.get(INTERNAL_REQUEST_ID_HEADER) || fallbackRequestId;
  if (
    actorId === null ||
    !ACTOR_ID_PATTERN.test(actorId) ||
    expiryRaw === null ||
    !/^\d{13}$/u.test(expiryRaw)
  ) {
    throw new HttpError(401, "AUTH_REQUIRED", "Verified device context is required.");
  }
  const sessionExpiresAt = Number(expiryRaw);
  if (!Number.isSafeInteger(sessionExpiresAt) || sessionExpiresAt <= Date.now()) {
    throw new HttpError(401, "AUTH_REQUIRED", "The device session has expired.");
  }
  return { actorId, sessionExpiresAt, requestId: requestId.slice(0, 128) };
}

function requireMethod(request: Request, method: string): void {
  if (request.method !== method)
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "The method is not allowed.");
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: { code: "METHOD_NOT_ALLOWED", message: "The method is not allowed." } },
    { status: 405, headers: { Allow: allow } },
  );
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<void> {
  while (true) {
    const listed = await bucket.list({ prefix, limit: 1_000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length === 0) return;
    await bucket.delete(keys);
  }
}

function mapRoomError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const sqliteFull = mapSqliteFullError(error);
  if (sqliteFull !== null) return sqliteFull;
  if (error instanceof ProtocolValidationError) {
    return new HttpError(400, error.code, error.message, error.details);
  }
  if (error instanceof BoardDomainError) {
    const conflictCodes = new Set([
      "STALE_BOARD",
      "STALE_ITEM",
      "STALE_HISTORY",
      "UNDO_CONFLICT",
      "DUPLICATE_ITEM_ID",
    ]);
    const unavailableCodes = new Set(["TEMPORARILY_UNAVAILABLE", "REPLAY_UNAVAILABLE"]);
    const status =
      error.code === "FORBIDDEN"
        ? 403
        : error.code === "AUTH_REQUIRED"
          ? 401
          : error.code === "RATE_LIMITED"
            ? 429
            : error.code === "MESSAGE_TOO_LARGE" || error.code === "BOARD_LIMIT_REACHED"
              ? 413
              : conflictCodes.has(error.code)
                ? 409
                : unavailableCodes.has(error.code)
                  ? 503
                  : error.code === "INTERNAL_ERROR"
                    ? 500
                    : 400;
    return new HttpError(status, error.code, error.message, error.details);
  }
  return new HttpError(500, "INTERNAL_ERROR", "The board request could not be completed.");
}

function boardNotFoundError(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Board not found.");
}

function assetStorageUnavailable(): HttpError {
  return new HttpError(503, "TEMPORARILY_UNAVAILABLE", "Image storage is temporarily unavailable.");
}

function blobBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function parseOptionalLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "BAD_REQUEST", "The label is invalid.");
  const label = value.trim();
  if ([...label].length < 1 || [...label].length > 80 || /\p{Cc}/u.test(label)) {
    throw new HttpError(400, "BAD_REQUEST", "The label must be 1 to 80 visible characters.");
  }
  return label;
}

function optionalExternalParticipantId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "BAD_REQUEST", "The organisation participant ID is invalid.");
  }
  const normalized = value.normalize("NFC").trim();
  if (
    [...normalized].length < 1 ||
    [...normalized].length > 320 ||
    containsDisallowedControlCharacter(normalized)
  ) {
    throw new HttpError(400, "BAD_REQUEST", "The organisation participant ID is invalid.");
  }
  return normalized;
}

function parseOrganisationWebhookSettings(value: unknown): OrganisationWebhookSettings {
  if (!isRecord(value)) {
    throw new HttpError(500, "INTERNAL_ERROR", "The organisation settings response is invalid.");
  }
  const webhookUrl = normalizeOrganisationWebhookUrl(value.webhookUrl);
  if (
    (value.updatedBy !== null &&
      (typeof value.updatedBy !== "string" || !ACTOR_ID_PATTERN.test(value.updatedBy))) ||
    (value.updatedAt !== null &&
      (!Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0))
  ) {
    throw new HttpError(500, "INTERNAL_ERROR", "The organisation settings response is invalid.");
  }
  return {
    webhookUrl,
    updatedBy: value.updatedBy as string | null,
    updatedAt: value.updatedAt as number | null,
  };
}

type WebhookDeliveryReceipt = {
  id: string;
  event: "board.exported";
  createdAt: number;
  responseStatus: number;
};

function parseWebhookDeliveryReceipt(value: unknown): WebhookDeliveryReceipt {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^whd_[A-Za-z0-9_-]{22}$/u.test(value.id) ||
    value.event !== "board.exported" ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    !Number.isSafeInteger(value.responseStatus) ||
    (value.responseStatus as number) < 200 ||
    (value.responseStatus as number) > 299
  ) {
    throw new HttpError(500, "INTERNAL_ERROR", "The webhook delivery receipt is invalid.");
  }
  return {
    id: value.id,
    event: "board.exported",
    createdAt: value.createdAt as number,
    responseStatus: value.responseStatus as number,
  };
}

function parseRequiredLabel(value: unknown): string {
  const label = parseOptionalLabel(value);
  if (label === null) throw new HttpError(400, "BAD_REQUEST", "A snapshot label is required.");
  return label;
}

function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (key === null || key.length < 16 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new HttpError(400, "BAD_REQUEST", "A valid Idempotency-Key header is required.");
  }
  return key;
}

function invitationResponse(
  origin: string,
  boardId: string,
  metadata: InvitationMetadata,
  token: string,
  idempotentReplay: boolean,
): Response {
  return Response.json(
    {
      invitation: {
        id: metadata.id,
        role: metadata.role,
        label: metadata.label,
        maxUses: metadata.maxUses,
        expiresAt: metadata.expiresAt,
      },
      token,
      url: `${origin}/b/${boardId}#invite=${token}`,
      idempotentReplay,
    },
    { status: 201, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}

function textContentForItem(
  item: BoardItem,
): { kind: "text" | "sticky_text" | "zone_title" | "image_alt"; text: string } | null {
  const protocolItem = item as unknown as ProtocolBoardItem;
  if (protocolItem.kind === "text") return { kind: "text", text: protocolItem.geometry.text };
  if (protocolItem.kind === "sticky") {
    return { kind: "sticky_text", text: protocolItem.geometry.text };
  }
  if (protocolItem.kind === "zone") {
    return { kind: "zone_title", text: protocolItem.geometry.title };
  }
  if (protocolItem.kind === "image") {
    return { kind: "image_alt", text: protocolItem.geometry.alt ?? "" };
  }
  return null;
}

function changedContentAttribution(
  text: string,
  actorId: string,
  seq: number,
  acceptedAt: number,
): NonNullable<ItemAttributionState["content"]> {
  return {
    responsibleBy: text.trim().length > 0 ? actorId : null,
    lastChangedBy: actorId,
    updatedSeq: seq,
    updatedAt: acceptedAt,
  };
}

function initialContentAttribution(
  text: string,
  actorId: string,
  seq: number,
  acceptedAt: number,
): NonNullable<ItemAttributionState["content"]> {
  if (text.trim().length === 0) {
    return {
      responsibleBy: null,
      lastChangedBy: null,
      updatedSeq: null,
      updatedAt: null,
    };
  }
  return {
    responsibleBy: actorId,
    lastChangedBy: actorId,
    updatedSeq: seq,
    updatedAt: acceptedAt,
  };
}

function initialItemAttribution(
  item: BoardItem,
  actorId: string,
  seq: number,
  acceptedAt: number,
): ItemAttributionState {
  const protocolItem = item as unknown as ProtocolBoardItem;
  const textContent = textContentForItem(item);
  const tableCells =
    protocolItem.kind === "table"
      ? protocolItem.geometry.cells.map((row) =>
          row.map((text) => initialContentAttribution(text, actorId, seq, acceptedAt)),
        )
      : null;
  return {
    lastModifiedBy: actorId,
    updatedSeq: seq,
    updatedAt: acceptedAt,
    content:
      textContent === null
        ? null
        : initialContentAttribution(textContent.text, actorId, seq, acceptedAt),
    tableCells,
  };
}

function deriveItemAttribution(
  beforeItem: BoardItem | null,
  afterItem: BoardItem,
  before: ItemAttributionState | null,
  actorId: string,
  seq: number,
  acceptedAt: number,
): ItemAttributionState {
  if (beforeItem === null) {
    return initialItemAttribution(afterItem, actorId, seq, acceptedAt);
  }
  const afterProtocol = afterItem as unknown as ProtocolBoardItem;
  const beforeProtocol = beforeItem as unknown as ProtocolBoardItem;
  const beforeState =
    before ??
    initialItemAttribution(beforeItem, beforeItem.createdBy, beforeItem.version, acceptedAt);
  const afterText = textContentForItem(afterItem);
  const beforeText = beforeItem === null ? null : textContentForItem(beforeItem);
  const content =
    afterText === null
      ? null
      : beforeText !== null &&
          beforeText.kind === afterText.kind &&
          beforeText.text === afterText.text &&
          beforeState?.content !== null &&
          beforeState?.content !== undefined
        ? structuredClone(beforeState.content)
        : changedContentAttribution(afterText.text, actorId, seq, acceptedAt);
  const tableCells =
    afterProtocol.kind === "table"
      ? afterProtocol.geometry.cells.map((row, rowIndex) =>
          row.map((text, columnIndex) => {
            const previousText =
              beforeProtocol.kind === "table"
                ? beforeProtocol.geometry.cells[rowIndex]?.[columnIndex]
                : undefined;
            const previousAttribution = beforeState?.tableCells?.[rowIndex]?.[columnIndex];
            if (previousText === text && previousAttribution !== undefined) {
              return structuredClone(previousAttribution);
            }
            return changedContentAttribution(text, actorId, seq, acceptedAt);
          }),
        )
      : null;
  return {
    lastModifiedBy: actorId,
    updatedSeq: seq,
    updatedAt: acceptedAt,
    content,
    tableCells,
  };
}

function collectAttributionActorIds(
  attribution: ItemAttributionState | undefined,
  actorIds: Set<string>,
): void {
  if (attribution === undefined) return;
  actorIds.add(attribution.lastModifiedBy);
  const collectContent = (content: ItemAttributionState["content"]): void => {
    if (content?.responsibleBy !== null && content?.responsibleBy !== undefined) {
      actorIds.add(content.responsibleBy);
    }
    if (content?.lastChangedBy !== null && content?.lastChangedBy !== undefined) {
      actorIds.add(content.lastChangedBy);
    }
  };
  collectContent(attribution.content);
  for (const row of attribution.tableCells ?? []) {
    for (const cell of row) collectContent(cell);
  }
}

function exportItemContent(
  item: BoardItem,
  attribution: ItemAttributionState,
  actorRef: (actorId: string | null) => ExportActor | null,
): Array<Record<string, unknown>> {
  const protocolItem = item as unknown as ProtocolBoardItem;
  if (protocolItem.kind === "table") {
    return protocolItem.geometry.cells.flatMap((row, rowIndex) =>
      row.map((text, columnIndex) => {
        const cell =
          attribution.tableCells?.[rowIndex]?.[columnIndex] ??
          initialContentAttribution(
            text,
            item.createdBy,
            attribution.updatedSeq,
            attribution.updatedAt,
          );
        return {
          kind: "table_cell",
          row: rowIndex,
          column: columnIndex,
          text,
          responsibleUser: actorRef(cell.responsibleBy),
          lastChangedBy: actorRef(cell.lastChangedBy),
          updatedSeq: cell.updatedSeq,
          updatedAt: cell.updatedAt,
        };
      }),
    );
  }
  const textContent = textContentForItem(item);
  if (textContent === null) return [];
  const content =
    attribution.content ??
    initialContentAttribution(
      textContent.text,
      item.createdBy,
      attribution.updatedSeq,
      attribution.updatedAt,
    );
  return [
    {
      kind: textContent.kind,
      text: textContent.text,
      responsibleUser: actorRef(content.responsibleBy),
      lastChangedBy: actorRef(content.lastChangedBy),
      updatedSeq: content.updatedSeq,
      updatedAt: content.updatedAt,
    },
  ];
}

function parseItemAttributionState(payloadJson: string, itemId: string): ItemAttributionState {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw new BoardDomainError("INTERNAL_ERROR", "Stored item attribution is invalid.");
  }
  if (!isItemAttributionState(value)) {
    throw new BoardDomainError("INTERNAL_ERROR", `Stored attribution for ${itemId} is invalid.`);
  }
  return value;
}

function isContentAttribution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const actorOrNull = (actorId: unknown): boolean =>
    actorId === null || (typeof actorId === "string" && ACTOR_ID_PATTERN.test(actorId));
  const safeIntegerOrNull = (entry: unknown): boolean =>
    entry === null || (Number.isSafeInteger(entry) && (entry as number) >= 0);
  return (
    actorOrNull(value.responsibleBy) &&
    actorOrNull(value.lastChangedBy) &&
    safeIntegerOrNull(value.updatedSeq) &&
    safeIntegerOrNull(value.updatedAt)
  );
}

function isItemAttributionState(value: unknown): value is ItemAttributionState {
  if (!isRecord(value)) return false;
  if (
    typeof value.lastModifiedBy !== "string" ||
    !ACTOR_ID_PATTERN.test(value.lastModifiedBy) ||
    !Number.isSafeInteger(value.updatedSeq) ||
    (value.updatedSeq as number) < 0 ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0 ||
    (value.content !== null && !isContentAttribution(value.content)) ||
    (value.tableCells !== null &&
      (!Array.isArray(value.tableCells) ||
        !value.tableCells.every(
          (row) => Array.isArray(row) && row.every((cell) => isContentAttribution(cell)),
        )))
  ) {
    return false;
  }
  return true;
}

function parseSnapshotAttribution(payloadJson: string): Map<string, ItemAttributionState> {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw new BoardDomainError("INTERNAL_ERROR", "Stored snapshot attribution is invalid.");
  }
  if (!Array.isArray(value)) {
    throw new BoardDomainError("INTERNAL_ERROR", "Stored snapshot attribution is invalid.");
  }
  const result = new Map<string, ItemAttributionState>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.itemId !== "string" ||
      !OPAQUE_ID_PATTERN.test(entry.itemId) ||
      result.has(entry.itemId) ||
      !isItemAttributionState(entry.attribution)
    ) {
      throw new BoardDomainError("INTERNAL_ERROR", "Stored snapshot attribution is invalid.");
    }
    result.set(entry.itemId, entry.attribution);
  }
  return result;
}

function parseStoredActionPayload(payloadJson: string): StoredActionPayload {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw new BoardDomainError("INTERNAL_ERROR", "Stored action data is invalid.");
  }
  if (!isRecord(value) || !isRecord(value.publicResult) || !Array.isArray(value.effects)) {
    throw new BoardDomainError("INTERNAL_ERROR", "Stored action data is invalid.");
  }
  if (
    value.attributionEffects !== undefined &&
    (!Array.isArray(value.attributionEffects) ||
      value.attributionEffects.length > LIMITS.maxBatchItems ||
      !value.attributionEffects.every(isStoredAttributionEffect) ||
      new Set(value.attributionEffects.map((effect) => effect.itemId)).size !==
        value.attributionEffects.length)
  ) {
    throw new BoardDomainError("INTERNAL_ERROR", "Stored action attribution is invalid.");
  }
  const action = value.publicResult;
  if (
    action.v !== 1 ||
    action.t !== "server.action" ||
    !Number.isSafeInteger(action.seq) ||
    !Number.isSafeInteger(action.acceptedAt) ||
    !isStoredServerActor(action.actor) ||
    (action.creators !== undefined && !isStoredCreatorDirectory(action.creators)) ||
    typeof action.commandId !== "string" ||
    typeof action.actionId !== "string" ||
    !isRecord(action.op)
  ) {
    throw new BoardDomainError("INTERNAL_ERROR", "Stored action data is invalid.");
  }
  return value as unknown as StoredActionPayload;
}

function isStoredAttributionEffect(value: unknown): value is {
  itemId: string;
  before: ItemAttributionState | null;
  after: ItemAttributionState | null;
} {
  return (
    isRecord(value) &&
    typeof value.itemId === "string" &&
    OPAQUE_ID_PATTERN.test(value.itemId) &&
    (value.before === null || isItemAttributionState(value.before)) &&
    (value.after === null || isItemAttributionState(value.after))
  );
}

function isStoredServerActor(value: unknown): value is { id: string; displayName: string } {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, "id") || !Object.hasOwn(value, "displayName")) {
    return false;
  }
  if (typeof value.id !== "string" || !ACTOR_ID_PATTERN.test(value.id)) return false;
  if (typeof value.displayName !== "string" || value.displayName.trim() !== value.displayName) {
    return false;
  }
  const displayNameLength = [...value.displayName].length;
  return displayNameLength >= 1 && displayNameLength <= 40 && !/\p{Cc}/u.test(value.displayName);
}

function isStoredCreatorDirectory(
  value: unknown,
): value is Array<{ id: string; displayName: string }> {
  if (!Array.isArray(value) || value.length > LIMITS.maxItems) return false;
  const seen = new Set<string>();
  for (const creator of value) {
    if (!isStoredServerActor(creator) || seen.has(creator.id)) return false;
    seen.add(creator.id);
  }
  return true;
}

function parseAttachment(value: unknown): SocketAttachment {
  if (!isRecord(value)) throw new Error("Attachment is not an object.");
  const keys = [
    "v",
    "connectionId",
    "actorId",
    "displayName",
    "role",
    "aclVersion",
    "sessionExpiresAt",
    "clientInstanceId",
    "connectedAt",
    "state",
  ];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error("Attachment fields are invalid.");
  }
  if (
    value.v !== 1 ||
    typeof value.connectionId !== "string" ||
    value.connectionId.length > 80 ||
    typeof value.actorId !== "string" ||
    !ACTOR_ID_PATTERN.test(value.actorId) ||
    typeof value.displayName !== "string" ||
    [...value.displayName].length < 1 ||
    [...value.displayName].length > 40 ||
    (value.role !== "viewer" && value.role !== "editor" && value.role !== "owner") ||
    !Number.isSafeInteger(value.aclVersion) ||
    !Number.isSafeInteger(value.sessionExpiresAt) ||
    typeof value.clientInstanceId !== "string" ||
    value.clientInstanceId.length > 80 ||
    !Number.isSafeInteger(value.connectedAt) ||
    (value.state !== "syncing" && value.state !== "live")
  ) {
    throw new Error("Attachment values are invalid.");
  }
  return value as unknown as SocketAttachment;
}

function sendJson(socket: WebSocket, value: unknown): void {
  socket.send(JSON.stringify(value));
}

function webSocketUpgradeResponse(socket: WebSocket, request: Request): Response {
  const requestedProtocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim());
  const headers = new Headers();
  if (requestedProtocols.includes("whiteboard.v1")) {
    // Authentication-bearing protocols are consumed by the gateway. Never
    // reflect an arbitrary protocol value from the request back to a client.
    headers.set("Sec-WebSocket-Protocol", "whiteboard.v1");
  }
  return new Response(null, { status: 101, headers, webSocket: socket });
}
function canDraw(policy: DrawingPolicy, role: BoardRole): boolean {
  if (policy === "locked" || role === "viewer") return false;
  if (policy === "owner_only") return role === "owner";
  return role === "editor" || role === "owner";
}

/**
 * Comments follow the drawing policy's role rules but ignore a lock: a locked
 * board still accepts comments from participants who could otherwise draw.
 */
function canComment(policy: DrawingPolicy, role: BoardRole): boolean {
  return canDraw(policy === "locked" ? "editors_enabled" : policy, role);
}

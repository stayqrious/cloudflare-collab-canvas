import {
  ASSIST_ACTIONS,
  type AssistAction,
  type Assistance,
  type BoardFeatures,
  type CommentMedia,
  CommentMediaError,
  MAX_BATCH_OPERATIONS,
  normalizeBoardItem,
  normalizeCommentMedia,
} from "@collab/protocol";

import type {
  AccessMode,
  BoardComment,
  BoardItem,
  BoardSnapshot,
  Bootstrap,
  DrawingPolicy,
  Member,
  Role,
} from "../types";

export type FragmentClaim = { type: "invite" | "recovery"; token: string };

export type EmbedLaunch = {
  token: string;
  importSnapshot?: string;
};

const MAX_EMBED_IMPORT_ENCODED_CHARS = Math.ceil((1 * 1_024 * 1_024 * 4) / 3);

export type EmbedSession = {
  sessionToken: string;
  sessionExpiresAt: number;
  board: {
    id: string;
    url: string;
    title: string;
  };
  actor: {
    id: string;
    displayName: string;
    role: Role;
  };
};

export type ManagedInvitation = {
  id: string;
  role: Role;
  label: string | null;
  maxUses: number;
  expiresAt: number;
};

export type CreatedInvitation = {
  invitation: ManagedInvitation;
  token: string;
  url: string;
  idempotentReplay: boolean;
};

export type RecoverySnapshot = {
  seq: number;
  sha256: string;
  itemCount: number;
  byteCount: number;
  kind: "automatic" | "named" | "pre_clear";
  label: string | null;
  createdBy: string | null;
  createdAt: number;
};

export type BoardImageAsset = {
  assetId: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  intrinsicWidth: number;
  intrinsicHeight: number;
  sizeBytes: number;
};

export type AttributedDataExport = {
  format: "cf-whiteboard-attributed-json";
  version: 1;
  board: {
    id: string;
    title: string;
    seq: number;
    stateCreatedAt: number;
  };
  sections?: Array<{ id: string; name: string; locked: boolean; memberItemIds: string[] }>;
  participants: Array<{
    id: string;
    displayName: string;
    participantHash: string;
    participantId?: string | null;
    role: Role | null;
    status: "active" | "revoked" | "referenced";
  }>;
  objects: Array<{
    item: BoardItem;
    attribution: {
      createdBy: {
        id: string;
        displayName: string;
        participantHash: string;
        participantId?: string | null;
      };
      lastModifiedBy: {
        id: string;
        displayName: string;
        participantHash: string;
        participantId?: string | null;
      };
      updatedSeq: number;
      updatedAt: number;
    };
    content: Array<{
      kind: "text" | "sticky_text" | "zone_title" | "image_alt" | "table_cell";
      text: string;
      responsibleUser: {
        id: string;
        displayName: string;
        participantHash: string;
        participantId?: string | null;
      } | null;
      lastChangedBy: {
        id: string;
        displayName: string;
        participantHash: string;
        participantId?: string | null;
      } | null;
      updatedSeq: number | null;
      updatedAt: number | null;
      row?: number;
      column?: number;
    }>;
  }>;
};

export type OrganisationTemplate = {
  id: string;
  name: string;
  description: string | null;
  items: BoardItem[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type OrganisationTemplates = {
  organisationId: string | null;
  canManage: boolean;
  templates: OrganisationTemplate[];
};

export type OrganisationWebhookSettings = {
  organisationId: string | null;
  webhookUrl: string | null;
  updatedBy: string | null;
  updatedAt: number | null;
};

export type OrganisationWebhookDeliveryResult = {
  delivery: {
    id: string;
    event: "board.exported";
    createdAt: number;
    responseStatus: number;
  };
  idempotentReplay: boolean;
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private csrfToken = "";
  private embedBearer: string | null;
  turnstile: { enabled: boolean; required: boolean; siteKey: string | null } = {
    enabled: false,
    required: false,
    siteKey: null,
  };

  constructor(
    useStoredEmbedSession = typeof location !== "undefined" &&
      /^\/embed(?:\/|$)/u.test(location.pathname),
  ) {
    this.embedBearer = useStoredEmbedSession ? loadEmbedBearer() : null;
  }

  get embedSessionToken(): string | null {
    return this.embedBearer;
  }

  async startEmbedSession(launch: EmbedLaunch): Promise<EmbedSession> {
    if (
      launch.importSnapshot !== undefined &&
      launch.importSnapshot.length > MAX_EMBED_IMPORT_ENCODED_CHARS
    ) {
      throw new ApiError("PAYLOAD_TOO_LARGE", "The initial Space import is too large.", 413);
    }
    const result = await this.request<unknown>(
      "/api/v1/embed/session",
      {
        method: "POST",
        body: JSON.stringify({
          token: launch.token,
          ...(launch.importSnapshot === undefined ? {} : { importSnapshot: launch.importSnapshot }),
        }),
      },
      false,
      false,
    );
    const parsed = parseEmbedSession(result);
    this.embedBearer = parsed.sessionToken;
    storeEmbedBearer(parsed.sessionToken);
    return parsed;
  }

  async ensureSession(): Promise<void> {
    const result = await this.request<Record<string, unknown>>(
      "/api/v1/session",
      { method: "POST" },
      false,
    );
    const token = result.csrfToken ?? result.csrf;
    if (typeof token !== "string" || token.length === 0) {
      throw new ApiError(
        "INVALID_RESPONSE",
        "The server did not return a session token.",
        500,
        result,
      );
    }
    this.csrfToken = token;
    if (isRecord(result.turnstile)) {
      this.turnstile = {
        enabled: result.turnstile.enabled === true,
        required: result.turnstile.required === true,
        siteKey: typeof result.turnstile.siteKey === "string" ? result.turnstile.siteKey : null,
      };
    }
  }

  async refreshSession(): Promise<void> {
    if (this.embedBearer !== null) {
      throw new ApiError(
        "AUTH_REQUIRED",
        "Open this Space again from its parent application to renew access.",
        401,
      );
    }
    await this.ensureSession();
  }

  async bootstrap(boardId: string): Promise<Bootstrap> {
    const result = await this.request<Bootstrap>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/bootstrap`,
    );
    if ("url" in result.snapshot) {
      const snapshot = await this.request<BoardSnapshot>(result.snapshot.url);
      return { ...result, snapshot };
    }
    return result;
  }

  async claim(
    boardId: string,
    claim: FragmentClaim,
    confirmRecovery = false,
    turnstileToken?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/boards/${encodeURIComponent(boardId)}/claims`, {
      method: "POST",
      body: JSON.stringify({
        type: claim.type,
        token: claim.token,
        ...(claim.type === "recovery" ? { confirmOwnershipTransfer: confirmRecovery } : {}),
        ...(turnstileToken ? { turnstileToken } : {}),
      }),
    });
  }

  async createBoard(
    title: string,
    turnstileToken?: string,
    features?: Partial<BoardFeatures>,
  ): Promise<{
    board: {
      id: string;
      url: string;
      title: string;
      accessMode: AccessMode;
      features: BoardFeatures;
    };
    ownerRecoveryToken: string;
    ownerRecoveryUrl: string;
  }> {
    return this.request("/api/v1/boards", {
      method: "POST",
      body: JSON.stringify({
        title,
        ...(turnstileToken ? { turnstileToken } : {}),
        ...(features === undefined ? {} : { features }),
      }),
    });
  }

  async comments(boardId: string): Promise<BoardComment[]> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/comments`,
    );
    const values = isRecord(result) && Array.isArray(result.comments) ? result.comments : [];
    return values.map(parseBoardComment);
  }

  async createComment(
    boardId: string,
    itemId: string,
    body: string,
    assistance?: Assistance,
    media?: CommentMedia,
  ): Promise<BoardComment> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/comments`,
      {
        method: "POST",
        body: JSON.stringify({
          itemId,
          body,
          ...(assistance === undefined ? {} : { assistedBy: "ai", assistance }),
          ...(media === undefined ? {} : { media }),
        }),
      },
    );
    return parseBoardComment(result);
  }

  async resolveComment(boardId: string, commentId: string): Promise<BoardComment> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/comments/${encodeURIComponent(commentId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ state: "resolved" }),
      },
    );
    return parseBoardComment(result);
  }

  async members(boardId: string): Promise<Member[]> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/members`,
    );
    const values = Array.isArray(result)
      ? result
      : isRecord(result) && Array.isArray(result.members)
        ? result.members
        : [];
    return values.flatMap((value) => {
      if (!isRecord(value)) return [];
      const id =
        typeof value.id === "string"
          ? value.id
          : typeof value.actorId === "string"
            ? value.actorId
            : null;
      const displayName = typeof value.displayName === "string" ? value.displayName : null;
      const role = value.role;
      if (!id || !displayName || (role !== "viewer" && role !== "editor" && role !== "owner"))
        return [];
      return [
        {
          id,
          displayName,
          role,
          connected: value.connected === true,
          primaryOwner: value.primaryOwner === true,
        } satisfies Member,
      ];
    });
  }

  async updateMember(
    boardId: string,
    actorId: string,
    role: Role,
    expectedAclVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(actorId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ role, expectedAclVersion }),
      },
    );
  }

  async revokeMember(
    boardId: string,
    actorId: string,
    expectedAclVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(
      `/api/v1/boards/${encodeURIComponent(boardId)}/members/${encodeURIComponent(actorId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ expectedAclVersion }),
      },
    );
  }

  async updateSettings(
    boardId: string,
    values: {
      title?: string;
      accessMode?: AccessMode;
      drawingPolicy?: DrawingPolicy;
      imagesEnabled?: boolean;
      features?: Partial<BoardFeatures>;
    },
    expectedAclVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/boards/${encodeURIComponent(boardId)}/settings`, {
      method: "PATCH",
      body: JSON.stringify({ ...values, expectedAclVersion }),
    });
  }

  async archiveBoard(
    boardId: string,
    expectedAclVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/boards/${encodeURIComponent(boardId)}/archive`, {
      method: "POST",
      body: JSON.stringify({ expectedAclVersion }),
    });
  }

  async createInvitation(
    boardId: string,
    input: { role: Role; label?: string; maxUses: number; expiresAt: number },
  ): Promise<CreatedInvitation> {
    return this.request<CreatedInvitation>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/invitations`,
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          role: input.role,
          ...(input.label ? { label: input.label } : {}),
          maxUses: input.maxUses,
          expiresAtMs: input.expiresAt,
        }),
      },
    );
  }

  async revokeInvitation(boardId: string, invitationId: string): Promise<void> {
    await this.request(
      `/api/v1/boards/${encodeURIComponent(boardId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
  }

  async uploadBoardImage(boardId: string, image: Blob): Promise<BoardImageAsset> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/assets`,
      {
        method: "POST",
        headers: { "Content-Type": image.type },
        body: image,
      },
    );
    return parseBoardImageAsset(result);
  }

  async boardImage(boardId: string, assetId: string): Promise<Blob> {
    const headers = new Headers({ Accept: "image/*" });
    if (this.embedBearer) headers.set("Authorization", `Bearer ${this.embedBearer}`);
    const response = await fetch(
      `/api/v1/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(assetId)}`,
      {
        method: "GET",
        headers,
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const payload: unknown = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => "");
      const serverError = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      throw new ApiError(
        typeof serverError?.code === "string" ? serverError.code : `HTTP_${response.status}`,
        typeof serverError?.message === "string"
          ? serverError.message
          : "The image could not be loaded.",
        response.status,
        payload,
      );
    }
    return response.blob();
  }

  async attributedDataExport(boardId: string): Promise<AttributedDataExport> {
    return this.request<AttributedDataExport>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/export.attributed.json`,
    );
  }

  async organisationTemplates(boardId: string): Promise<OrganisationTemplates> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/organisation/templates`,
    );
    return parseOrganisationTemplates(result);
  }

  async createOrganisationTemplate(
    boardId: string,
    input: { name: string; description?: string; items: BoardItem[] },
  ): Promise<OrganisationTemplate> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/organisation/templates`,
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(input),
      },
    );
    return parseOrganisationTemplate(result);
  }

  async deleteOrganisationTemplate(boardId: string, templateId: string): Promise<void> {
    await this.request(
      `/api/v1/boards/${encodeURIComponent(boardId)}/organisation/templates/${encodeURIComponent(templateId)}`,
      { method: "DELETE" },
    );
  }

  async organisationWebhookSettings(boardId: string): Promise<OrganisationWebhookSettings> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/organisation/settings`,
    );
    return parseOrganisationWebhookSettings(result);
  }

  async updateOrganisationWebhookSettings(
    boardId: string,
    webhookUrl: string | null,
  ): Promise<OrganisationWebhookSettings> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/organisation/settings`,
      {
        method: "PATCH",
        body: JSON.stringify({ webhookUrl }),
      },
    );
    return parseOrganisationWebhookSettings(result);
  }

  async sendBoardToOrganisationWebhook(
    boardId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<OrganisationWebhookDeliveryResult> {
    const result = await this.request<unknown>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/organisation/webhook`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
    return parseOrganisationWebhookDelivery(result);
  }

  async snapshots(boardId: string): Promise<RecoverySnapshot[]> {
    const result = await this.request<{ snapshots?: unknown }>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/snapshots`,
    );
    if (!Array.isArray(result.snapshots)) return [];
    return result.snapshots.flatMap((value) => parseRecoverySnapshot(value));
  }

  async createNamedSnapshot(boardId: string, label: string): Promise<RecoverySnapshot> {
    const result = await this.request<{ snapshot?: unknown }>(
      `/api/v1/boards/${encodeURIComponent(boardId)}/snapshots`,
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ label }),
      },
    );
    const snapshot = parseRecoverySnapshot(result.snapshot)[0];
    if (snapshot === undefined) {
      throw new ApiError("INVALID_RESPONSE", "The server returned invalid snapshot data.", 500);
    }
    return snapshot;
  }

  async restoreSnapshot(
    boardId: string,
    seq: number,
    expectedBoardSeq: number,
  ): Promise<{ restoredFromSeq: number; seq: number; requiresResync: boolean }> {
    return this.request(
      `/api/v1/boards/${encodeURIComponent(boardId)}/restore/${encodeURIComponent(String(seq))}`,
      {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ expectedBoardSeq }),
      },
    );
  }

  async rotateRecovery(
    boardId: string,
    expectedAclVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/boards/${encodeURIComponent(boardId)}/owner-recovery/rotate`, {
      method: "POST",
      body: JSON.stringify({ expectedAclVersion }),
    });
  }

  async transferOwnership(
    boardId: string,
    targetActorId: string,
    expectedAclVersion: number,
  ): Promise<Record<string, unknown>> {
    return this.request(`/api/v1/boards/${encodeURIComponent(boardId)}/ownership-transfer`, {
      method: "POST",
      body: JSON.stringify({ targetActorId, expectedAclVersion }),
    });
  }

  async request<T = Record<string, unknown>>(
    path: string,
    init: RequestInit = {},
    includeCsrf = true,
    includeEmbedBearer = true,
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (includeEmbedBearer && this.embedBearer) {
      headers.set("Authorization", `Bearer ${this.embedBearer}`);
    }
    if (includeCsrf && method !== "GET" && method !== "HEAD" && this.csrfToken) {
      headers.set("X-CSRF-Token", this.csrfToken);
    }
    const response = await fetch(path, {
      ...init,
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.status === 204) return undefined as T;

    const contentType = response.headers.get("content-type") ?? "";
    const payload: unknown = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");
    if (!response.ok) {
      const serverError = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
      throw new ApiError(
        typeof serverError?.code === "string" ? serverError.code : `HTTP_${response.status}`,
        typeof serverError?.message === "string"
          ? serverError.message
          : "The request could not be completed.",
        response.status,
        payload,
      );
    }
    return payload as T;
  }
}

export function takeFragmentClaim(locationValue: Location = window.location): FragmentClaim | null {
  const parameters = new URLSearchParams(
    locationValue.hash.startsWith("#") ? locationValue.hash.slice(1) : locationValue.hash,
  );
  const invite = parameters.get("invite");
  const recovery = parameters.get("recovery");
  if (!invite && !recovery) return null;

  const clean = `${locationValue.pathname}${locationValue.search}`;
  history.replaceState(history.state, "", clean);
  if (recovery) return { type: "recovery", token: recovery };
  return invite ? { type: "invite", token: invite } : null;
}

export function takeEmbedLaunch(
  locationValue: Location = window.location,
  historyValue: History = window.history,
): EmbedLaunch | null {
  if (!/^\/embed\/?$/u.test(locationValue.pathname)) return null;
  const parameters = new URLSearchParams(
    locationValue.hash.startsWith("#") ? locationValue.hash.slice(1) : locationValue.hash,
  );
  const launch = parameters.get("launch");
  const importSnapshot = parameters.get("import");
  if (launch === null && importSnapshot === null) return null;

  // The one-time launch credential and initial board data must leave
  // browser-visible URL state before the network request starts. Neither is
  // persisted in session history.
  historyValue.replaceState(
    historyValue.state,
    "",
    `${locationValue.pathname}${locationValue.search}`,
  );
  if (launch === null) return null;
  return {
    token: launch,
    ...(importSnapshot === null ? {} : { importSnapshot }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const EMBED_BEARER_HISTORY_KEY = "cf-collab-canvas.embed-bearer";

function loadEmbedBearer(): string | null {
  try {
    const state: unknown = history.state;
    if (!isRecord(state)) return null;
    const token = state[EMBED_BEARER_HISTORY_KEY];
    return typeof token === "string" && /^es1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)
      ? token
      : null;
  } catch {
    return null;
  }
}

function storeEmbedBearer(token: string): void {
  try {
    const current: unknown = history.state;
    const state = isRecord(current) ? current : {};
    history.replaceState({ ...state, [EMBED_BEARER_HISTORY_KEY]: token }, "");
  } catch {
    // The in-memory copy remains usable when session history is unavailable.
  }
}

export function parseBoardComment(value: unknown): BoardComment {
  if (!isRecord(value) || !isRecord(value.author)) throw invalidCommentResponse(value);
  const state = value.state;
  if (
    typeof value.id !== "string" ||
    !/^c_[A-Za-z0-9_-]{22}$/u.test(value.id) ||
    typeof value.itemId !== "string" ||
    typeof value.body !== "string" ||
    value.body.trim().length === 0 ||
    (state !== "open" && state !== "resolved" && state !== "orphaned") ||
    typeof value.author.id !== "string" ||
    typeof value.author.displayName !== "string" ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.updatedAt)
  ) {
    throw invalidCommentResponse(value);
  }
  const resolvedBy = isRecord(value.resolvedBy) ? value.resolvedBy : null;
  if (
    (state === "resolved" &&
      (resolvedBy === null ||
        typeof resolvedBy.id !== "string" ||
        typeof resolvedBy.displayName !== "string" ||
        !Number.isSafeInteger(value.resolvedAt))) ||
    (state !== "resolved" && (value.resolvedBy !== undefined || value.resolvedAt !== undefined))
  ) {
    throw invalidCommentResponse(value);
  }
  const assistance = parseCommentAssistance(value);
  const media = parseCommentMedia(value);
  return {
    id: value.id,
    itemId: value.itemId,
    body: value.body,
    state,
    author: { id: value.author.id, displayName: value.author.displayName },
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
    ...(state === "resolved" && resolvedBy !== null
      ? {
          resolvedBy: {
            id: resolvedBy.id as string,
            displayName: resolvedBy.displayName as string,
          },
          resolvedAt: value.resolvedAt as number,
        }
      : {}),
    ...(assistance === null ? {} : { assistedBy: "ai" as const, assistance }),
    ...(media === null ? {} : { media }),
  };
}

/** Reads a comment's picture or video through the contract the edge validated it against. */
function parseCommentMedia(value: Record<string, unknown>): CommentMedia | null {
  if (value.media === undefined) return null;
  try {
    return normalizeCommentMedia(value.media);
  } catch (error) {
    if (error instanceof CommentMediaError) throw invalidCommentResponse(value);
    throw error;
  }
}

/** Validates the optional writer metadata pair; both fields must be present together. */
function parseCommentAssistance(value: Record<string, unknown>): Assistance | null {
  if (value.assistedBy === undefined && value.assistance === undefined) return null;
  const assistance = value.assistance;
  if (
    value.assistedBy !== "ai" ||
    !isRecord(assistance) ||
    typeof assistance.tool !== "string" ||
    assistance.tool.length === 0 ||
    (assistance.action !== undefined &&
      (typeof assistance.action !== "string" ||
        !(ASSIST_ACTIONS as readonly string[]).includes(assistance.action)))
  ) {
    throw invalidCommentResponse(value);
  }
  return {
    tool: assistance.tool,
    ...(assistance.action === undefined ? {} : { action: assistance.action as AssistAction }),
  };
}

function invalidCommentResponse(value: unknown): ApiError {
  return new ApiError("INVALID_RESPONSE", "The server returned invalid comment data.", 500, value);
}

function parseBoardImageAsset(value: unknown): BoardImageAsset {
  if (!isRecord(value)) throw invalidBoardImageAsset(value);
  const mimeType = value.mimeType;
  if (
    typeof value.assetId !== "string" ||
    !/^asset_[A-Za-z0-9_-]{43}$/u.test(value.assetId) ||
    (mimeType !== "image/png" &&
      mimeType !== "image/jpeg" &&
      mimeType !== "image/webp" &&
      mimeType !== "image/gif") ||
    !Number.isSafeInteger(value.intrinsicWidth) ||
    (value.intrinsicWidth as number) < 1 ||
    (value.intrinsicWidth as number) > 4_096 ||
    !Number.isSafeInteger(value.intrinsicHeight) ||
    (value.intrinsicHeight as number) < 1 ||
    (value.intrinsicHeight as number) > 4_096 ||
    (value.intrinsicWidth as number) * (value.intrinsicHeight as number) > 16_000_000 ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 1 ||
    (value.sizeBytes as number) > 5 * 1_024 * 1_024
  ) {
    throw invalidBoardImageAsset(value);
  }
  return {
    assetId: value.assetId,
    mimeType,
    intrinsicWidth: value.intrinsicWidth as number,
    intrinsicHeight: value.intrinsicHeight as number,
    sizeBytes: value.sizeBytes as number,
  };
}

function parseOrganisationTemplates(value: unknown): OrganisationTemplates {
  if (
    !isRecord(value) ||
    (value.organisationId !== null &&
      (typeof value.organisationId !== "string" ||
        !/^o_[A-Za-z0-9_-]{22}$/u.test(value.organisationId))) ||
    typeof value.canManage !== "boolean" ||
    !Array.isArray(value.templates)
  ) {
    throw invalidOrganisationTemplateResponse(value);
  }
  return {
    organisationId: value.organisationId,
    canManage: value.canManage,
    templates: value.templates.map((template) => parseOrganisationTemplate(template)),
  };
}

function parseOrganisationTemplate(value: unknown): OrganisationTemplate {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !/^tpl_[A-Za-z0-9_-]{22}$/u.test(value.id) ||
    typeof value.name !== "string" ||
    value.name.trim().length === 0 ||
    (value.description !== null && typeof value.description !== "string") ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > MAX_BATCH_OPERATIONS ||
    typeof value.createdBy !== "string" ||
    !/^a_[A-Za-z0-9_-]{22}$/u.test(value.createdBy) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.updatedAt as number) < 0
  ) {
    throw invalidOrganisationTemplateResponse(value);
  }
  let items: BoardItem[];
  try {
    items = value.items.map((item) => normalizeBoardItem(item) as BoardItem);
  } catch {
    throw invalidOrganisationTemplateResponse(value);
  }
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    items,
    createdBy: value.createdBy,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  };
}

function parseOrganisationWebhookSettings(value: unknown): OrganisationWebhookSettings {
  if (
    !isRecord(value) ||
    (value.organisationId !== null &&
      (typeof value.organisationId !== "string" ||
        !/^o_[A-Za-z0-9_-]{22}$/u.test(value.organisationId))) ||
    (value.webhookUrl !== null && typeof value.webhookUrl !== "string") ||
    (value.updatedBy !== null &&
      (typeof value.updatedBy !== "string" || !/^a_[A-Za-z0-9_-]{22}$/u.test(value.updatedBy))) ||
    (value.updatedAt !== null &&
      (!Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0))
  ) {
    throw invalidOrganisationWebhookResponse(value);
  }
  if (typeof value.webhookUrl === "string") {
    try {
      if (new URL(value.webhookUrl).protocol !== "https:") {
        throw invalidOrganisationWebhookResponse(value);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw invalidOrganisationWebhookResponse(value);
    }
  }
  return {
    organisationId: value.organisationId,
    webhookUrl: value.webhookUrl,
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt as number | null,
  };
}

function parseOrganisationWebhookDelivery(value: unknown): OrganisationWebhookDeliveryResult {
  const object = isRecord(value) ? value : null;
  const delivery = object !== null && isRecord(object.delivery) ? object.delivery : null;
  if (
    delivery === null ||
    typeof delivery.id !== "string" ||
    !/^whd_[A-Za-z0-9_-]{22}$/u.test(delivery.id) ||
    delivery.event !== "board.exported" ||
    !Number.isSafeInteger(delivery.createdAt) ||
    (delivery.createdAt as number) < 0 ||
    !Number.isSafeInteger(delivery.responseStatus) ||
    (delivery.responseStatus as number) < 200 ||
    (delivery.responseStatus as number) > 299 ||
    object === null ||
    typeof object.idempotentReplay !== "boolean"
  ) {
    throw invalidOrganisationWebhookResponse(value);
  }
  return {
    delivery: {
      id: delivery.id,
      event: "board.exported",
      createdAt: delivery.createdAt as number,
      responseStatus: delivery.responseStatus as number,
    },
    idempotentReplay: object.idempotentReplay,
  };
}

function invalidOrganisationTemplateResponse(details: unknown): ApiError {
  return new ApiError(
    "INVALID_RESPONSE",
    "The server returned invalid organisation template data.",
    500,
    details,
  );
}

function invalidOrganisationWebhookResponse(details: unknown): ApiError {
  return new ApiError(
    "INVALID_RESPONSE",
    "The server returned invalid organisation webhook data.",
    500,
    details,
  );
}

function invalidBoardImageAsset(details: unknown): ApiError {
  return new ApiError(
    "INVALID_RESPONSE",
    "The server did not return valid image metadata.",
    500,
    details,
  );
}

function parseEmbedSession(value: unknown): EmbedSession {
  if (!isRecord(value) || !isRecord(value.board) || !isRecord(value.actor)) {
    throw invalidEmbedSession(value);
  }
  const role = value.actor.role;
  if (
    typeof value.sessionToken !== "string" ||
    !/^es1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value.sessionToken) ||
    !Number.isSafeInteger(value.sessionExpiresAt) ||
    typeof value.board.id !== "string" ||
    !/^b_[A-Za-z0-9_-]{22}$/u.test(value.board.id) ||
    typeof value.board.url !== "string" ||
    typeof value.board.title !== "string" ||
    typeof value.actor.id !== "string" ||
    !/^a_[A-Za-z0-9_-]{22}$/u.test(value.actor.id) ||
    typeof value.actor.displayName !== "string" ||
    (role !== "viewer" && role !== "editor" && role !== "owner")
  ) {
    throw invalidEmbedSession(value);
  }
  return {
    sessionToken: value.sessionToken,
    sessionExpiresAt: value.sessionExpiresAt as number,
    board: {
      id: value.board.id,
      url: value.board.url,
      title: value.board.title,
    },
    actor: {
      id: value.actor.id,
      displayName: value.actor.displayName,
      role,
    },
  };
}

function invalidEmbedSession(details: unknown): ApiError {
  return new ApiError(
    "INVALID_RESPONSE",
    "The server did not return a valid embedded Space session.",
    500,
    details,
  );
}

function parseRecoverySnapshot(value: unknown): RecoverySnapshot[] {
  if (!isRecord(value)) return [];
  if (
    !Number.isSafeInteger(value.seq) ||
    typeof value.sha256 !== "string" ||
    !Number.isSafeInteger(value.itemCount) ||
    !Number.isSafeInteger(value.byteCount) ||
    (value.kind !== "automatic" && value.kind !== "named" && value.kind !== "pre_clear") ||
    (value.label !== null && typeof value.label !== "string") ||
    (value.createdBy !== null &&
      value.createdBy !== undefined &&
      typeof value.createdBy !== "string") ||
    !Number.isSafeInteger(value.createdAt)
  ) {
    return [];
  }
  return [
    {
      seq: value.seq as number,
      sha256: value.sha256,
      itemCount: value.itemCount as number,
      byteCount: value.byteCount as number,
      kind: value.kind,
      label: value.label,
      createdBy: typeof value.createdBy === "string" ? value.createdBy : null,
      createdAt: value.createdAt as number,
    },
  ];
}

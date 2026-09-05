/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { canonicalSnapshotByteLengthFromParts } from "@collab/board-core";
import { DEFAULT_BOARD_FEATURES } from "@collab/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CLASSROOM_IMPORT_ENCODED_CHARS, MAX_CLASSROOM_IMPORT_ITEMS } from "./classroom-import";
import { bytesToBase64Url, hmacSha256, sha256, sha256Base64Url, utf8 } from "./crypto";
import {
  backfillSnapshotAccounting,
  captureSnapshot,
  serializeSnapshot,
  snapshotAccountingForItems,
} from "./storage";
import { boardIdHash } from "./telemetry";
import type { BoardRow, Env } from "./types";

const boardId = "b_AAAAAAAAAAAAAAAAAAAAAA";
const actorId = "a_AAAAAAAAAAAAAAAAAAAAAA";
const editorId = "a_BBBBBBBBBBBBBBBBBBBBBA";
const coOwnerId = `a_${"C".repeat(22)}`;
const studentId = `a_${"D".repeat(22)}`;
const placeholderOwnerId = `a_${"P".repeat(22)}`;
const organisationId = `o_${"O".repeat(21)}A`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function internalRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-whiteboard-internal-actor", actorId);
  headers.set("x-whiteboard-internal-session-expiry", String(Date.now() + 60_000));
  headers.set("x-whiteboard-internal-request-id", crypto.randomUUID());
  return new Request(`https://board.test${path}`, { ...init, headers });
}

function internalActorRequest(actor: string, path: string, init: RequestInit = {}): Request {
  const request = internalRequest(path, init);
  request.headers.set("x-whiteboard-internal-actor", actor);
  return request;
}

async function initializeBoard(stub: DurableObjectStub): Promise<void> {
  const body = JSON.stringify({
    publicId: boardId,
    title: "Test board",
    accessMode: "link_view",
    ownerActorId: actorId,
    ownerDisplayName: "Owner 1",
    ownerRecoveryHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  const response = await stub.fetch(
    internalRequest("/__internal/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  expect(response.status).toBe(201);
  await response.arrayBuffer();
}

async function launchClassroom(
  stub: DurableObjectStub,
  actor: string,
  role: "viewer" | "editor" | "owner",
  launchIssuedAtMs: number,
  displayName = "Classroom participant",
  ownerRecoveryHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  importSnapshot?: string,
  publicId = boardId,
  organisation?: string,
): Promise<Response> {
  return stub.fetch(
    internalActorRequest(
      actor,
      organisation === undefined
        ? "/__internal/classroom-launch"
        : "/__internal/organisation-launch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          publicId,
          ...(organisation === undefined
            ? {}
            : {
                organisationId: organisation,
                spaceId: "classroom-board",
                participantId: `participant:${actor}`,
              }),
          title: "Classroom board",
          role,
          displayName,
          launchIssuedAtMs,
          placeholderOwnerActorId: placeholderOwnerId,
          ownerRecoveryHash,
          ...(importSnapshot === undefined ? {} : { importSnapshot }),
        }),
      },
    ),
  );
}
async function addEditor(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (_instance, durableState) => {
    const now = Date.now();
    durableState.storage.transactionSync(() => {
      durableState.storage.sql.exec(
        `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
         VALUES (?, 'editor', 'Editor', ?, ?)`,
        editorId,
        now,
        now,
      );
      durableState.storage.sql.exec("UPDATE board SET acl_version = 2");
    });
  });
}

function legacyBoardFeatures(): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(DEFAULT_BOARD_FEATURES).filter(
      ([key]) => key !== "objectTransforms" && key !== "grouping",
    ),
  );
}

function socketRequest(actor: string, since = 0, publicId = boardId): Request {
  const request = internalRequest(
    `/api/v1/boards/${publicId}/socket?since=${since}&client=018f0000-0000-7000-8000-000000000099`,
    { method: "GET", headers: { Upgrade: "websocket" } },
  );
  request.headers.set("x-whiteboard-internal-actor", actor);
  return request;
}

interface TestSocket {
  socket: WebSocket;
  received: Record<string, unknown>[];
  closed: Promise<CloseEvent>;
  next: (
    predicate: (frame: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
}

async function openSocket(
  stub: DurableObjectStub,
  actor: string,
  since = 0,
  publicId = boardId,
): Promise<TestSocket> {
  const response = await stub.fetch(socketRequest(actor, since, publicId));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Upgrade did not return a WebSocket.");
  const queued: Record<string, unknown>[] = [];
  const received: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    received.push(frame);
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex < 0) queued.push(frame);
    else waiters.splice(waiterIndex, 1)[0]?.resolve(frame);
  });
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
  socket.accept();
  const next = async (
    predicate: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> => {
    const queuedIndex = queued.findIndex(predicate);
    if (queuedIndex >= 0) return queued.splice(queuedIndex, 1)[0] ?? {};
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for a WebSocket frame."));
      }, 3_000);
    });
  };
  return { socket, received, closed, next };
}

async function connect(
  stub: DurableObjectStub,
  actor: string,
  since = 0,
  publicId = boardId,
): Promise<TestSocket> {
  const connected = await openSocket(stub, actor, since, publicId);
  await connected.next((frame) => frame.t === "server.ready");
  return connected;
}

function createCommit(commandId: string, actionId: string, itemId: string) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq: 0,
    op: {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "rectangle",
        style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 1, y: 2, width: 3, height: 4 },
      },
    },
  };
}

function createSectionMemberCommit(
  commandId: string,
  actionId: string,
  sectionId: string,
  memberId: string,
  memberGroupId?: string,
) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq: 0,
    op: {
      kind: "items.batch",
      operations: [
        {
          kind: "item.create",
          item: {
            id: sectionId,
            kind: "zone",
            style: {
              kind: "zone",
              borderColor: "#60a5fa",
              fill: "#eff6ff",
              textColor: "#1e3a8a",
              fontSize: 20,
              opacity: 0.8,
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: { x: 0, y: 0, width: 600, height: 400, title: "Review" },
          },
        },
        {
          kind: "item.create",
          item: {
            id: memberId,
            sectionId,
            ...(memberGroupId === undefined ? {} : { groupId: memberGroupId }),
            kind: "sticky",
            style: {
              kind: "sticky",
              fill: "#fff2a8",
              textColor: "#2f2a1f",
              fontSize: 20,
              opacity: 1,
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: { x: 10, y: 20, width: 180, height: 140, text: "Question" },
          },
        },
      ],
    },
  };
}

function createStickyCommit(commandId: string, actionId: string, itemId: string) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq: 0,
    op: {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "sticky",
        style: {
          kind: "sticky",
          fill: "#fff2a8",
          textColor: "#27231b",
          fontSize: 20,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 12, 18],
        geometry: {
          x: 40,
          y: 55,
          width: 220,
          height: 160,
          text: "Original classroom idea\nSecond line",
        },
      },
    },
  };
}

function createStampCommit(commandId: string, actionId: string, itemId: string) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq: 0,
    op: {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "stamp",
        style: { kind: "stamp", color: "#e11d48", opacity: 0.8 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 120, y: 160, size: 72, stamp: "star" },
      },
    },
  };
}

function createImageCommit(
  commandId: string,
  actionId: string,
  itemId: string,
  assetId: string,
  mimeType: "image/gif" | "image/png" = "image/gif",
  intrinsicWidth = 1,
  intrinsicHeight = 1,
) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq: 0,
    op: {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "image",
        style: { kind: "image", opacity: 1, radius: 12 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 10,
          y: 20,
          width: 100,
          height: 100,
          assetId,
          mimeType,
          intrinsicWidth,
          intrinsicHeight,
        },
      },
    },
  };
}

function createTableCommit(
  commandId: string,
  actionId: string,
  itemId: string,
  firstCell = "Know <this>",
) {
  return {
    v: 1,
    t: "client.commit",
    commandId,
    actionId,
    baseSeq: 0,
    op: {
      kind: "item.create",
      item: {
        id: itemId,
        kind: "table",
        style: {
          kind: "table",
          borderColor: "#64748b",
          fill: "#ffffff",
          headerFill: "#e2e8f0",
          textColor: "#0f172a",
          fontSize: 18,
          opacity: 1,
        },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: {
          x: 10,
          y: 20,
          columnWidths: [120, 120, 120],
          rowHeights: [48, 48, 48],
          cells: [
            [firstCell, "Want", "Learned"],
            ["", "", ""],
            ["", "", ""],
          ],
          headerRow: true,
        },
      },
    },
  };
}

function seedActionRows(
  sql: SqlStorage,
  count: number,
  acceptedAt: number,
  firstSequence = 1,
): void {
  const payload = JSON.stringify({
    publicResult: {
      v: 1,
      t: "server.action",
      seq: 1,
      acceptedAt,
      actor: { id: actorId, displayName: "Owner 1" },
      commandId: "seed-command",
      actionId: "seed-action",
      op: { kind: "board.clear", removed: [] },
    },
    effects: [],
  });
  const batchSize = 1_000;
  const lastSequence = firstSequence + count - 1;
  for (let start = firstSequence; start <= lastSequence; start += batchSize) {
    const end = Math.min(lastSequence, start + batchSize - 1);
    sql.exec(
      `WITH RECURSIVE sequence(seq) AS (
         VALUES (?)
         UNION ALL
         SELECT seq + 1 FROM sequence WHERE seq < ?
       )
       INSERT INTO actions(
         seq, action_id, command_id, request_hash, actor_id, kind, payload_json,
         affected_item_ids_json, undoable, accepted_at_ms
       )
       SELECT seq, printf('seed-action-%d', seq), printf('seed-command-%d', seq),
         printf('seed-hash-%d', seq), ?, 'seed', ?, '[]', 0, ?
       FROM sequence`,
      start,
      end,
      actorId,
      payload,
      acceptedAt,
    );
  }
}

function readSnapshotAccounting(sql: SqlStorage) {
  const board = sql.exec<BoardRow>("SELECT * FROM board WHERE singleton = 1").one();
  const snapshot = captureSnapshot(sql, board);
  const actual = snapshotAccountingForItems(snapshot.items);
  return {
    stored: {
      itemCount: board.snapshot_live_item_count,
      itemBytes: board.snapshot_live_item_bytes,
    },
    actual,
    decomposedBytes: canonicalSnapshotByteLengthFromParts({
      boardId: board.public_id,
      seq: snapshot.seq,
      createdAt: snapshot.createdAt,
      settings: snapshot.settings,
      ...actual,
    }),
    serializedBytes: new TextEncoder().encode(serializeSnapshot(snapshot)).byteLength,
  };
}

describe("BoardRoom initialization", () => {
  afterEach(async () => reset());

  it("applies the forward schema once and initializes idempotently", async () => {
    const binding = (env as unknown as Env).BOARD_ROOMS;
    const stub = binding.getByName(boardId);
    const body = JSON.stringify({
      publicId: boardId,
      title: "Test board",
      accessMode: "link_view",
      ownerActorId: actorId,
      ownerDisplayName: "Owner 1",
      ownerRecoveryHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const first = await stub.fetch(
      internalRequest("/__internal/initialize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(first.status).toBe(201);
    await first.arrayBuffer();
    const second = await stub.fetch(
      internalRequest("/__internal/initialize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    expect(second.status).toBe(200);
    await second.arrayBuffer();

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      migrations: durableState.storage.sql
        .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version")
        .toArray()
        .map((row) => row.version),
      boards: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM board")
        .one().count,
      owners: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM members WHERE role = 'owner'")
        .one().count,
      classroomMode: durableState.storage.sql
        .exec<{ classroom_mode: number }>("SELECT classroom_mode FROM board")
        .one().classroom_mode,
      organisation: durableState.storage.sql
        .exec<{ organisation_mode: number; organisation_id: string | null }>(
          "SELECT organisation_mode, organisation_id FROM board",
        )
        .one(),
      accounting: durableState.storage.sql
        .exec<{ item_count: number; item_bytes: number }>(
          `SELECT snapshot_live_item_count AS item_count,
            snapshot_live_item_bytes AS item_bytes FROM board`,
        )
        .one(),
    }));
    expect(state).toEqual({
      migrations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      boards: 1,
      owners: 1,
      classroomMode: 0,
      organisation: { organisation_mode: 0, organisation_id: null },
      accounting: { item_count: 0, item_bytes: 0 },
    });

    const bootstrap = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/bootstrap`, { method: "GET" }),
    );
    expect(bootstrap.status).toBe(200);
    const value = (await bootstrap.json()) as Record<string, unknown>;
    expect(value).toMatchObject({
      protocolVersion: 1,
      board: { features: { images: true, rectangle: true, protractor: true } },
      creators: [],
    });
  });

  it("fills additive feature defaults for boards written by older workers", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE board SET features_json = ? WHERE singleton = 1",
        JSON.stringify({ ...legacyBoardFeatures(), rectangle: false }),
      );
    });
    await evictDurableObject(stub);

    const bootstrap = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/bootstrap`, { method: "GET" }),
    );
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      board: {
        features: { rectangle: false, objectTransforms: true, grouping: true },
      },
    });
  });

  it("persists feature settings and rejects disabled item creation", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);

    const disabled = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          features: { rectangle: false, protractor: false },
          expectedAclVersion: 1,
        }),
      }),
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({
      board: { aclVersion: 2, features: { rectangle: false, protractor: false } },
    });

    const connected = await connect(stub, actorId);
    const rejected = createCommit(
      "018f0000-0000-7000-8000-000000000091",
      "018f0000-0000-7000-8000-000000000092",
      "018f0000-0000-7000-8000-000000000093",
    );
    connected.socket.send(JSON.stringify(rejected));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === rejected.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 0 });

    const enabled = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { rectangle: true }, expectedAclVersion: 2 }),
      }),
    );
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      board: { aclVersion: 3, features: { rectangle: true, protractor: false } },
    });
    await connected.next(
      (frame) =>
        frame.t === "access.changed" &&
        (frame.features as Record<string, unknown> | undefined)?.rectangle === true,
    );

    const accepted = createCommit(
      "018f0000-0000-7000-8000-000000000094",
      "018f0000-0000-7000-8000-000000000095",
      "018f0000-0000-7000-8000-000000000096",
    );
    connected.socket.send(JSON.stringify(accepted));
    expect(
      await connected.next(
        (frame) => frame.t === "server.action" && frame.commandId === accepted.commandId,
      ),
    ).toMatchObject({ seq: 1 });

    const disablePartialEraser = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          features: { partialEraser: false, square: false },
          expectedAclVersion: 3,
        }),
      }),
    );
    expect(disablePartialEraser.status).toBe(200);
    await disablePartialEraser.arrayBuffer();
    await connected.next(
      (frame) =>
        frame.t === "access.changed" &&
        (frame.features as Record<string, unknown> | undefined)?.partialEraser === false,
    );

    const partialErase = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000097",
      actionId: "018f0000-0000-7000-8000-000000000098",
      baseSeq: 1,
      op: {
        kind: "item.update",
        itemId: accepted.op.item.id,
        expectedVersion: 1,
        patch: {
          geometry: {
            ...accepted.op.item.geometry,
            visiblePaths: [
              [
                [1, 2],
                [4, 2],
              ],
            ],
          },
        },
      },
    };
    connected.socket.send(JSON.stringify(partialErase));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === partialErase.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    const erasedCreate = {
      ...createCommit(
        "018f0000-0000-7000-8000-000000000101",
        "018f0000-0000-7000-8000-000000000102",
        "018f0000-0000-7000-8000-000000000103",
      ),
      baseSeq: 1,
      op: {
        kind: "item.create",
        item: {
          ...createCommit(
            "018f0000-0000-7000-8000-000000000101",
            "018f0000-0000-7000-8000-000000000102",
            "018f0000-0000-7000-8000-000000000103",
          ).op.item,
          geometry: {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            shape: "rectangle",
            visiblePaths: [
              [
                [1, 2],
                [4, 2],
              ],
            ],
          },
        },
      },
    };
    connected.socket.send(JSON.stringify(erasedCreate));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === erasedCreate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    const disabledSubtypeUpdate = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000104",
      actionId: "018f0000-0000-7000-8000-000000000105",
      baseSeq: 1,
      op: {
        kind: "item.update",
        itemId: accepted.op.item.id,
        expectedVersion: 1,
        patch: {
          geometry: { x: 1, y: 2, width: 4, height: 4, shape: "square" },
        },
      },
    };
    connected.socket.send(JSON.stringify(disabledSubtypeUpdate));
    expect(
      await connected.next(
        (frame) =>
          frame.t === "server.rejected" && frame.commandId === disabledSubtypeUpdate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    const transformOnly = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000099",
      actionId: "018f0000-0000-7000-8000-000000000100",
      baseSeq: 1,
      op: {
        kind: "item.update",
        itemId: accepted.op.item.id,
        expectedVersion: 1,
        patch: { transform: [1, 0, 0, 1, 10, 10] },
      },
    };
    connected.socket.send(JSON.stringify(transformOnly));
    expect(
      await connected.next(
        (frame) => frame.t === "server.action" && frame.commandId === transformOnly.commandId,
      ),
    ).toMatchObject({ seq: 2 });
    connected.socket.close(1000, "done");
  });

  it("allows relationship cleanup but not assignment when grouping is disabled", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const sectionId = "018f0000-0000-7000-8000-000000000201";
    const memberId = "018f0000-0000-7000-8000-000000000202";
    const groupId = "018f0000-0000-7000-8000-000000000221";
    const created = createSectionMemberCommit(
      "018f0000-0000-7000-8000-000000000203",
      "018f0000-0000-7000-8000-000000000204",
      sectionId,
      memberId,
      groupId,
    );
    connected.socket.send(JSON.stringify(created));
    await connected.next(
      (frame) => frame.t === "server.action" && frame.commandId === created.commandId,
    );

    const disabled = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { grouping: false }, expectedAclVersion: 1 }),
      }),
    );
    expect(disabled.status).toBe(200);
    await disabled.arrayBuffer();
    await connected.next(
      (frame) =>
        frame.t === "access.changed" &&
        (frame.features as Record<string, unknown> | undefined)?.grouping === false,
    );

    const inheritedCopy = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000223",
      actionId: "018f0000-0000-7000-8000-000000000224",
      baseSeq: 1,
      op: {
        kind: "item.copy",
        sourceItemId: memberId,
        expectedVersion: 1,
        newItemId: "018f0000-0000-7000-8000-000000000222",
        translate: { x: 20, y: 20 },
      },
    };
    connected.socket.send(JSON.stringify(inheritedCopy));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === inheritedCopy.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    const partiallyClearedCopy = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000226",
      actionId: "018f0000-0000-7000-8000-000000000227",
      baseSeq: 1,
      op: {
        kind: "item.copy",
        sourceItemId: memberId,
        expectedVersion: 1,
        newItemId: "018f0000-0000-7000-8000-000000000225",
        translate: { x: 20, y: 20 },
        newSectionId: null,
      },
    };
    connected.socket.send(JSON.stringify(partiallyClearedCopy));
    expect(
      await connected.next(
        (frame) =>
          frame.t === "server.rejected" && frame.commandId === partiallyClearedCopy.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    const assignedCopy = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000216",
      actionId: "018f0000-0000-7000-8000-000000000217",
      baseSeq: 1,
      op: {
        kind: "item.copy",
        sourceItemId: memberId,
        expectedVersion: 1,
        newItemId: "018f0000-0000-7000-8000-000000000215",
        translate: { x: 20, y: 20 },
        newSectionId: sectionId,
      },
    };
    connected.socket.send(JSON.stringify(assignedCopy));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === assignedCopy.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    const relationFreeCopyId = "018f0000-0000-7000-8000-000000000218";
    const relationFreeCopy = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000219",
      actionId: "018f0000-0000-7000-8000-000000000220",
      baseSeq: 1,
      op: {
        kind: "item.copy",
        sourceItemId: memberId,
        expectedVersion: 1,
        newItemId: relationFreeCopyId,
        translate: { x: 20, y: 20 },
        newGroupId: null,
        newSectionId: null,
      },
    };
    connected.socket.send(JSON.stringify(relationFreeCopy));
    await connected.next(
      (frame) => frame.t === "server.action" && frame.commandId === relationFreeCopy.commandId,
    );

    const copiedItem = await runInDurableObject(stub, (_instance, durableState) => {
      const row = durableState.storage.sql
        .exec<{ data_json: string }>(
          "SELECT data_json FROM items WHERE item_id = ?",
          relationFreeCopyId,
        )
        .one();
      return JSON.parse(row.data_json) as Record<string, unknown>;
    });
    expect(copiedItem).not.toHaveProperty("groupId");
    expect(copiedItem).not.toHaveProperty("sectionId");

    const cleanup = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000205",
      actionId: "018f0000-0000-7000-8000-000000000206",
      baseSeq: 2,
      op: {
        kind: "items.batch",
        operations: [
          { kind: "item.delete", itemId: sectionId, expectedVersion: 1 },
          {
            kind: "item.update",
            itemId: memberId,
            expectedVersion: 1,
            patch: { sectionId: null },
          },
        ],
      },
    };
    connected.socket.send(JSON.stringify(cleanup));
    await connected.next(
      (frame) => frame.t === "server.action" && frame.commandId === cleanup.commandId,
    );

    const member = await runInDurableObject(stub, (_instance, durableState) => {
      const row = durableState.storage.sql
        .exec<{ data_json: string }>("SELECT data_json FROM items WHERE item_id = ?", memberId)
        .one();
      return JSON.parse(row.data_json) as Record<string, unknown>;
    });
    expect(member).not.toHaveProperty("sectionId");

    const assignment = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000207",
      actionId: "018f0000-0000-7000-8000-000000000208",
      baseSeq: 3,
      op: {
        kind: "item.update",
        itemId: memberId,
        expectedVersion: 3,
        patch: { sectionId },
      },
    };
    connected.socket.send(JSON.stringify(assignment));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === assignment.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 3 });
    connected.socket.close(1000, "done");
  });

  it("atomically rejects deleting a Section while a surviving member still references it", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const sectionId = "018f0000-0000-7000-8000-000000000209";
    const memberId = "018f0000-0000-7000-8000-000000000210";
    const created = createSectionMemberCommit(
      "018f0000-0000-7000-8000-000000000211",
      "018f0000-0000-7000-8000-000000000212",
      sectionId,
      memberId,
    );
    connected.socket.send(JSON.stringify(created));
    await connected.next(
      (frame) => frame.t === "server.action" && frame.commandId === created.commandId,
    );

    const bareDelete = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000213",
      actionId: "018f0000-0000-7000-8000-000000000214",
      baseSeq: 1,
      op: { kind: "item.delete", itemId: sectionId, expectedVersion: 1 },
    };
    connected.socket.send(JSON.stringify(bareDelete));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === bareDelete.commandId,
      ),
    ).toMatchObject({
      code: "INVALID_FRAME",
      latestSeq: 1,
      sectionId,
      itemId: memberId,
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => {
      const section = durableState.storage.sql
        .exec<{ deleted: number }>("SELECT deleted FROM items WHERE item_id = ?", sectionId)
        .one();
      const member = durableState.storage.sql
        .exec<{ data_json: string }>("SELECT data_json FROM items WHERE item_id = ?", memberId)
        .one();
      return {
        latestSeq: durableState.storage.sql
          .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
          .one().latest_seq,
        actions: durableState.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
          .one().count,
        history: durableState.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")
          .one().count,
        sectionDeleted: section.deleted,
        member: JSON.parse(member.data_json) as Record<string, unknown>,
      };
    });
    expect(state).toMatchObject({
      latestSeq: 1,
      actions: 1,
      history: 1,
      sectionDeleted: 0,
      member: { id: memberId, sectionId },
    });
    connected.socket.close(1000, "done");
  });

  it("allows translation but rejects scale and rotation when object transforms are disabled", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const created = createCommit(
      "018f0000-0000-7000-8000-000000000111",
      "018f0000-0000-7000-8000-000000000112",
      "018f0000-0000-7000-8000-000000000113",
    );
    connected.socket.send(JSON.stringify(created));
    await connected.next(
      (frame) => frame.t === "server.action" && frame.commandId === created.commandId,
    );

    const disabled = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { objectTransforms: false }, expectedAclVersion: 1 }),
      }),
    );
    expect(disabled.status).toBe(200);
    await disabled.arrayBuffer();
    await connected.next(
      (frame) =>
        frame.t === "access.changed" &&
        (frame.features as Record<string, unknown> | undefined)?.objectTransforms === false,
    );

    const scaledCreate = createCommit(
      "018f0000-0000-7000-8000-00000000011a",
      "018f0000-0000-7000-8000-00000000011b",
      "018f0000-0000-7000-8000-00000000011c",
    );
    scaledCreate.baseSeq = 1;
    scaledCreate.op.item.transform = [1.5, 0, 0, 1.5, 0, 0];
    connected.socket.send(JSON.stringify(scaledCreate));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === scaledCreate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    const translated = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000114",
      actionId: "018f0000-0000-7000-8000-000000000115",
      baseSeq: 1,
      op: {
        kind: "item.update",
        itemId: created.op.item.id,
        expectedVersion: 1,
        patch: { transform: [1, 0, 0, 1, 25, 30] },
      },
    };
    connected.socket.send(JSON.stringify(translated));
    await connected.next(
      (frame) => frame.t === "server.action" && frame.commandId === translated.commandId,
    );

    const scaled = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000116",
      actionId: "018f0000-0000-7000-8000-000000000117",
      baseSeq: 2,
      op: {
        kind: "item.update",
        itemId: created.op.item.id,
        expectedVersion: 2,
        patch: { transform: [1.5, 0, 0, 1.5, 25, 30] },
      },
    };
    connected.socket.send(JSON.stringify(scaled));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === scaled.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 2 });
    connected.socket.close(1000, "done");
  });

  it("rejects copies that preserve transformed sources after transforms are disabled", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const created = createCommit(
      "018f0000-0000-7000-8000-00000000012a",
      "018f0000-0000-7000-8000-00000000012b",
      "018f0000-0000-7000-8000-00000000012c",
    );
    created.op.item.transform = [0, 1, -1, 0, 20, 30];
    connected.socket.send(JSON.stringify(created));
    await connected.next(
      (frame) => frame.t === "server.action" && frame.commandId === created.commandId,
    );

    const disabled = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { objectTransforms: false }, expectedAclVersion: 1 }),
      }),
    );
    expect(disabled.status).toBe(200);
    await disabled.arrayBuffer();
    await connected.next(
      (frame) =>
        frame.t === "access.changed" &&
        (frame.features as Record<string, unknown> | undefined)?.objectTransforms === false,
    );

    const copy = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-00000000012d",
      actionId: "018f0000-0000-7000-8000-00000000012e",
      baseSeq: 1,
      op: {
        kind: "item.copy",
        sourceItemId: created.op.item.id,
        expectedVersion: 1,
        newItemId: "018f0000-0000-7000-8000-00000000012f",
        translate: { x: 20, y: 20 },
      },
    };
    connected.socket.send(JSON.stringify(copy));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === copy.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });
    connected.socket.close(1000, "done");
  });

  it("gates square and rectangle previews by their canonical subtype", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const disableSquare = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          features: { square: false, rectangle: true },
          expectedAclVersion: 1,
        }),
      }),
    );
    expect(disableSquare.status).toBe(200);
    await disableSquare.arrayBuffer();

    const sender = await connect(stub, actorId);
    const receiver = await connect(stub, actorId);
    const squarePreview = {
      v: 1,
      t: "client.preview",
      gestureId: "018f0000-0000-7000-8000-000000000106",
      previewSeq: 1,
      kind: "shape.geometry",
      payload: {
        itemId: "018f0000-0000-7000-8000-000000000107",
        itemKind: "rectangle",
        geometry: { x: 10, y: 20, width: 80, height: 80, shape: "square" },
        style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
      },
    };
    sender.socket.send(JSON.stringify(squarePreview));
    expect(await sender.next((frame) => frame.t === "server.rejected")).toMatchObject({
      code: "FORBIDDEN",
    });

    const enableSquareOnly = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          features: { square: true, rectangle: false },
          expectedAclVersion: 2,
        }),
      }),
    );
    expect(enableSquareOnly.status).toBe(200);
    await enableSquareOnly.arrayBuffer();
    await Promise.all([
      sender.next((frame) => frame.t === "access.changed"),
      receiver.next((frame) => frame.t === "access.changed"),
    ]);

    sender.socket.send(JSON.stringify({ ...squarePreview, previewSeq: 2 }));
    expect(
      await receiver.next(
        (frame) => frame.t === "server.preview" && frame.gestureId === squarePreview.gestureId,
      ),
    ).toMatchObject({ payload: { geometry: { shape: "square" } } });
    sender.socket.close(1000, "done");
    receiver.socket.close(1000, "done");
  });

  it("returns names only for visible-item creators, including revoked members", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);

    const editor = await connect(stub, editorId);
    editor.socket.send(
      JSON.stringify(
        createStampCommit(
          "018f0000-0000-7000-8000-000000000101",
          "018f0000-0000-7000-8000-000000000102",
          "018f0000-0000-7000-8000-000000000103",
        ),
      ),
    );
    await editor.next((frame) => frame.t === "server.action" && frame.seq === 1);
    editor.socket.close(1000, "done");

    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.sql.exec(
        "UPDATE members SET revoked_at_ms = ?, updated_at_ms = ? WHERE actor_id = ?",
        now,
        now,
        editorId,
      );
      durableState.storage.sql.exec(
        `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
         VALUES (?, 'viewer', 'Member without items', ?, ?)`,
        studentId,
        now,
        now,
      );
    });

    const bootstrap = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/bootstrap`, { method: "GET" }),
    );
    expect(bootstrap.status).toBe(200);
    const value = (await bootstrap.json()) as {
      creators: Array<Record<string, unknown>>;
      snapshot: { items: Array<{ createdBy: string }> };
    };
    expect(value.snapshot.items).toHaveLength(1);
    expect(value.snapshot.items[0]?.createdBy).toBe(editorId);
    expect(value.creators).toEqual([{ id: editorId, displayName: "Editor" }]);
    expect(Object.keys(value.creators[0] ?? {}).sort()).toEqual(["displayName", "id"]);
  });

  it("persists creator metadata when another actor restores an item", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const itemId = "018f0000-0000-7000-8000-000000000110";
    const create = createStickyCommit(
      "018f0000-0000-7000-8000-000000000111",
      "018f0000-0000-7000-8000-000000000112",
      itemId,
    );
    editor.socket.send(JSON.stringify(create));
    await Promise.all([
      owner.next((frame) => frame.t === "server.action" && frame.seq === 1),
      editor.next((frame) => frame.t === "server.action" && frame.seq === 1),
    ]);

    const deleteActionId = "018f0000-0000-7000-8000-000000000114";
    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000113",
        actionId: deleteActionId,
        baseSeq: 1,
        op: { kind: "item.delete", itemId, expectedVersion: 1 },
      }),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 2);

    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000115",
        actionId: "018f0000-0000-7000-8000-000000000116",
        baseSeq: 2,
        op: {
          kind: "history.undo",
          expectedHistoryVersion: 1,
          targetActionId: deleteActionId,
        },
      }),
    );
    const undo = await owner.next((frame) => frame.t === "server.action" && frame.seq === 3);
    expect(undo).toMatchObject({
      actor: { id: actorId, displayName: "Owner 1" },
      creators: [{ id: editorId, displayName: "Editor" }],
      op: { changes: [{ kind: "item.replace", item: { id: itemId, createdBy: editorId } }] },
    });

    const named = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "creator-restore-snapshot-0001",
        },
        body: JSON.stringify({ label: "Attributed restore" }),
      }),
    );
    expect(named.status).toBe(201);
    await named.arrayBuffer();

    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000117",
        actionId: "018f0000-0000-7000-8000-000000000118",
        baseSeq: 3,
        op: { kind: "item.delete", itemId, expectedVersion: 3 },
      }),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 4);

    const restored = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/restore/3`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "creator-restore-apply-0002",
        },
        body: JSON.stringify({ expectedBoardSeq: 4 }),
      }),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ seq: 5, requiresResync: false });
    const restoreAction = await owner.next(
      (frame) => frame.t === "server.action" && frame.seq === 5,
    );
    expect(restoreAction.creators).toEqual([{ id: editorId, displayName: "Editor" }]);

    owner.socket.close(1000, "replay");
    editor.socket.close(1000, "replay");
    const replayed = await connect(stub, actorId, 2);
    const replay = await replayed.next((frame) => frame.t === "server.replay");
    const replayActions = replay.actions as Array<Record<string, unknown>>;
    expect(replayActions[0]?.creators).toEqual([{ id: editorId, displayName: "Editor" }]);
    expect(replayActions[2]?.creators).toEqual([{ id: editorId, displayName: "Editor" }]);
    replayed.socket.close(1000, "done");
  }, 45_000);

  it("rejects restoring a foreign item after its deleting owner is demoted", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE members SET role = 'owner', updated_at_ms = ? WHERE actor_id = ?",
        Date.now(),
        editorId,
      );
    });
    const primaryOwner = await connect(stub, actorId);
    const formerOwner = await connect(stub, editorId);
    const itemId = "018f0000-0000-7000-8000-000000000a10";
    const create = createCommit(
      "018f0000-0000-7000-8000-000000000a11",
      "018f0000-0000-7000-8000-000000000a12",
      itemId,
    );
    primaryOwner.socket.send(JSON.stringify(create));
    await Promise.all([
      primaryOwner.next((frame) => frame.t === "server.action" && frame.seq === 1),
      formerOwner.next((frame) => frame.t === "server.action" && frame.seq === 1),
    ]);

    const deleteActionId = "018f0000-0000-7000-8000-000000000a14";
    formerOwner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000a13",
        actionId: deleteActionId,
        baseSeq: 1,
        op: { kind: "item.delete", itemId, expectedVersion: 1 },
      }),
    );
    await Promise.all([
      primaryOwner.next((frame) => frame.t === "server.action" && frame.seq === 2),
      formerOwner.next((frame) => frame.t === "server.action" && frame.seq === 2),
    ]);
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE members SET role = 'editor', updated_at_ms = ? WHERE actor_id = ?",
        Date.now(),
        editorId,
      );
    });

    const undoCommandId = "018f0000-0000-7000-8000-000000000a15";
    formerOwner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: undoCommandId,
        actionId: "018f0000-0000-7000-8000-000000000a16",
        baseSeq: 2,
        op: {
          kind: "history.undo",
          expectedHistoryVersion: 1,
          targetActionId: deleteActionId,
        },
      }),
    );
    expect(
      await formerOwner.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === undoCommandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 2 });
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      deleted: durableState.storage.sql
        .exec<{ deleted: number }>("SELECT deleted FROM items WHERE item_id = ?", itemId)
        .one().deleted,
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
    }));
    expect(state).toEqual({ deleted: 1, latestSeq: 2 });
    primaryOwner.socket.close(1000, "done");
    formerOwner.socket.close(1000, "done");
  });

  it("migrates existing boards to multiple active owners", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);

    const state = await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.sql.exec(
        `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
         VALUES (?, 'owner', 'Co-owner', ?, ?)`,
        coOwnerId,
        now,
        now,
      );
      return {
        activeOwners: durableState.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM members WHERE role = 'owner' AND revoked_at_ms IS NULL",
          )
          .one().count,
        legacyIndex: durableState.storage.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'index' AND name = 'members_one_active_owner'`,
          )
          .one().count,
      };
    });
    expect(state).toEqual({ activeOwners: 2, legacyIndex: 0 });
  });

  it("creates a private classroom board from a viewer and adopts the first active owner", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    const issuedAt = Date.now() - 10_000;

    const viewerLaunch = await launchClassroom(stub, studentId, "viewer", issuedAt, "Student");
    expect(viewerLaunch.status).toBe(201);
    expect(await viewerLaunch.json()).toMatchObject({
      board: { id: boardId, accessMode: "private", aclVersion: 1 },
      actor: { id: studentId, role: "viewer", displayName: "Student" },
      created: true,
      launchApplied: true,
      primaryOwner: false,
    });

    const viewerState = await runInDurableObject(stub, (_instance, durableState) => ({
      board: durableState.storage.sql
        .exec<{ owner_actor_id: string; classroom_mode: number; access_mode: string }>(
          "SELECT owner_actor_id, classroom_mode, access_mode FROM board",
        )
        .one(),
      members: durableState.storage.sql
        .exec<{ actor_id: string; role: string }>(
          "SELECT actor_id, role FROM members ORDER BY actor_id",
        )
        .toArray(),
      placeholderMembers: durableState.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM members WHERE actor_id = ?",
          placeholderOwnerId,
        )
        .one().count,
    }));
    expect(viewerState).toEqual({
      board: {
        owner_actor_id: placeholderOwnerId,
        classroom_mode: 1,
        access_mode: "private",
      },
      members: [{ actor_id: studentId, role: "viewer" }],
      placeholderMembers: 0,
    });

    const firstOwner = await launchClassroom(stub, actorId, "owner", issuedAt + 1, "Coach one");
    expect(firstOwner.status).toBe(200);
    expect(await firstOwner.json()).toMatchObject({
      board: { aclVersion: 2 },
      actor: { id: actorId, role: "owner" },
      primaryOwner: true,
    });

    const secondOwner = await launchClassroom(stub, coOwnerId, "owner", issuedAt + 2, "Coach two");
    expect(secondOwner.status).toBe(200);
    expect(await secondOwner.json()).toMatchObject({
      board: { aclVersion: 3 },
      actor: { id: coOwnerId, role: "owner" },
      primaryOwner: false,
    });

    const membersResponse = await stub.fetch(
      internalActorRequest(coOwnerId, `/api/v1/boards/${boardId}/members`),
    );
    expect(membersResponse.status).toBe(200);
    expect(await membersResponse.json()).toMatchObject({
      aclVersion: 3,
      members: expect.arrayContaining([
        expect.objectContaining({ actorId, role: "owner", primaryOwner: true }),
        expect.objectContaining({ actorId: coOwnerId, role: "owner", primaryOwner: false }),
        expect.objectContaining({ actorId: studentId, role: "viewer", primaryOwner: false }),
      ]),
    });
  });

  it("shares bounded templates across organisation boards and authorizes every live owner", async () => {
    const binding = (env as unknown as Env).BOARD_ROOMS;
    const stub = binding.getByName(boardId);
    const issuedAt = Date.now() - 10_000;
    const ownerLaunch = await launchClassroom(
      stub,
      actorId,
      "owner",
      issuedAt,
      "Coach one",
      undefined,
      undefined,
      boardId,
      organisationId,
    );
    expect(ownerLaunch.status).toBe(201);
    await ownerLaunch.arrayBuffer();
    const viewerLaunch = await launchClassroom(
      stub,
      studentId,
      "viewer",
      issuedAt + 1,
      "Student",
      undefined,
      undefined,
      boardId,
      organisationId,
    );
    expect(viewerLaunch.status).toBe(200);
    await viewerLaunch.arrayBuffer();
    const coOwnerLaunch = await launchClassroom(
      stub,
      coOwnerId,
      "owner",
      issuedAt + 2,
      "Coach two",
      undefined,
      undefined,
      boardId,
      organisationId,
    );
    expect(coOwnerLaunch.status).toBe(200);
    await coOwnerLaunch.arrayBuffer();

    const organisationAdmin = await (env as unknown as Env).ORGANISATION_ROOMS.getByName(
      organisationId,
    ).fetch(
      new Request(`https://board.test/__internal/organisations/${organisationId}/admin`, {
        headers: { "x-whiteboard-internal-request-id": crypto.randomUUID() },
      }),
    );
    expect(organisationAdmin.status, await organisationAdmin.clone().text()).toBe(200);
    expect(await organisationAdmin.json()).toMatchObject({
      boards: [
        {
          boardId,
          spaceId: "classroom-board",
          owners: [
            { id: actorId, displayName: "Coach one", identifierHash: actorId },
            { id: coOwnerId, displayName: "Coach two", identifierHash: coOwnerId },
          ],
          participants: [{ id: studentId, displayName: "Student", identifierHash: studentId }],
        },
      ],
    });

    const route = `/api/v1/boards/${boardId}/organisation/templates`;
    const viewerList = await stub.fetch(internalActorRequest(studentId, route));
    expect(viewerList.status).toBe(200);
    expect(await viewerList.json()).toEqual({
      organisationId,
      canManage: false,
      templates: [],
    });

    const source = createStickyCommit(
      "018f0000-0000-7000-8000-000000000211",
      "018f0000-0000-7000-8000-000000000212",
      "018f0000-0000-7000-8000-000000000213",
    ).op.item;
    const item = { ...source, z: 1, version: 1, createdBy: actorId };
    const createBody = JSON.stringify({
      name: "  Exit reflection  ",
      description: "  End-of-lesson prompts  ",
      items: [item],
    });
    const rejected = await stub.fetch(
      internalActorRequest(studentId, route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: createBody,
      }),
    );
    expect(rejected.status).toBe(403);

    const createdResponse = await stub.fetch(
      internalActorRequest(actorId, route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: createBody,
      }),
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      name: string;
      description: string | null;
      items: unknown[];
      createdBy: string;
      createdAt: number;
      updatedAt: number;
    };
    expect(created).toMatchObject({
      id: expect.stringMatching(/^tpl_[A-Za-z0-9_-]{22}$/u),
      name: "Exit reflection",
      description: "End-of-lesson prompts",
      items: [item],
      createdBy: actorId,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    const coOwnerList = await stub.fetch(internalActorRequest(coOwnerId, route));
    expect(coOwnerList.status).toBe(200);
    expect(await coOwnerList.json()).toMatchObject({
      organisationId,
      canManage: true,
      templates: [created],
    });

    const rejectedUpdate = await stub.fetch(
      internalActorRequest(studentId, `${route}/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Student rewrite" }),
      }),
    );
    expect(rejectedUpdate.status).toBe(403);

    const updatedResponse = await stub.fetch(
      internalActorRequest(coOwnerId, `${route}/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Revised exit reflection",
          description: null,
        }),
      }),
    );
    expect(updatedResponse.status, await updatedResponse.clone().text()).toBe(200);
    const updated = (await updatedResponse.json()) as typeof created;
    expect(updated).toMatchObject({
      ...created,
      name: "Revised exit reflection",
      description: null,
      updatedAt: expect.any(Number),
    });

    const siblingBoardId = `b_${"R".repeat(21)}A`;
    const siblingStub = binding.getByName(siblingBoardId);
    const siblingLaunch = await launchClassroom(
      siblingStub,
      actorId,
      "owner",
      issuedAt + 3,
      "Coach one",
      undefined,
      undefined,
      siblingBoardId,
      organisationId,
    );
    expect(siblingLaunch.status).toBe(201);
    await siblingLaunch.arrayBuffer();
    const siblingList = await siblingStub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${siblingBoardId}/organisation/templates`),
    );
    expect(siblingList.status).toBe(200);
    expect(await siblingList.json()).toMatchObject({
      organisationId,
      canManage: true,
      templates: [updated],
    });

    const deleted = await stub.fetch(
      internalActorRequest(coOwnerId, `${route}/${created.id}`, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");

    const mismatch = await launchClassroom(
      stub,
      actorId,
      "owner",
      issuedAt + 4,
      "Coach one",
      undefined,
      undefined,
      boardId,
      `o_${"Q".repeat(21)}A`,
    );
    expect(mismatch.status).toBe(409);

    const ordinaryBoardId = `b_${"U".repeat(22)}`;
    const ordinaryStub = binding.getByName(ordinaryBoardId);
    const ordinaryLaunch = await launchClassroom(
      ordinaryStub,
      actorId,
      "owner",
      issuedAt,
      "Ordinary owner",
      undefined,
      undefined,
      ordinaryBoardId,
    );
    expect(ordinaryLaunch.status).toBe(201);
    await ordinaryLaunch.arrayBuffer();
    const ordinaryList = await ordinaryStub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${ordinaryBoardId}/organisation/templates`),
    );
    expect(ordinaryList.status).toBe(200);
    expect(await ordinaryList.json()).toEqual({
      organisationId: null,
      canManage: false,
      templates: [],
    });
  });

  it("deletes Organisation board state, private R2 objects, and active connections", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    const issuedAt = Date.now() - 10_000;
    const launch = await launchClassroom(
      stub,
      actorId,
      "owner",
      issuedAt,
      "Coach",
      undefined,
      undefined,
      boardId,
      organisationId,
    );
    expect(launch.status, await launch.clone().text()).toBe(201);
    await launch.arrayBuffer();
    const connection = await openSocket(stub, actorId);

    const snapshotKey = `boards/${boardId}/snapshots/7.json`;
    const assetKey = `boards/${boardId}/assets/asset_${"I".repeat(43)}`;
    const unrelatedSnapshotKey = `boards/b_${"Z".repeat(22)}/snapshots/7.json`;
    const unrelatedAssetKey = `boards/b_${"Z".repeat(22)}/assets/asset_${"J".repeat(43)}`;
    await Promise.all([
      typedEnv.BOARD_SNAPSHOTS.put(snapshotKey, "{}"),
      typedEnv.BOARD_ASSETS.put(assetKey, new Uint8Array([137, 80, 78, 71])),
      typedEnv.BOARD_SNAPSHOTS.put(unrelatedSnapshotKey, "{}"),
      typedEnv.BOARD_ASSETS.put(unrelatedAssetKey, new Uint8Array([1])),
    ]);

    const crossOrganisation = await stub.fetch(
      internalRequest("/__internal/organisation-delete", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId: `o_${"Q".repeat(21)}A`, boardId }),
      }),
    );
    expect(crossOrganisation.status).toBe(404);
    expect(await typedEnv.BOARD_SNAPSHOTS.head(snapshotKey)).not.toBeNull();
    expect(await typedEnv.BOARD_ASSETS.head(assetKey)).not.toBeNull();

    const deleted = await stub.fetch(
      internalRequest("/__internal/organisation-delete", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId, boardId }),
      }),
    );
    expect(deleted.status, await deleted.clone().text()).toBe(204);
    expect(await deleted.text()).toBe("");
    expect((await connection.closed).code).toBe(4012);
    expect(await typedEnv.BOARD_SNAPSHOTS.head(snapshotKey)).toBeNull();
    expect(await typedEnv.BOARD_ASSETS.head(assetKey)).toBeNull();
    expect(await typedEnv.BOARD_SNAPSHOTS.head(unrelatedSnapshotKey)).not.toBeNull();
    expect(await typedEnv.BOARD_ASSETS.head(unrelatedAssetKey)).not.toBeNull();

    const missing = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/bootstrap`));
    expect(missing.status).toBe(404);
    const repeated = await stub.fetch(
      internalRequest("/__internal/organisation-delete", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId, boardId }),
      }),
    );
    expect(repeated.status).toBe(204);

    const recreated = await launchClassroom(
      stub,
      actorId,
      "owner",
      issuedAt + 1,
      "Coach",
      undefined,
      undefined,
      boardId,
      organisationId,
    );
    expect(recreated.status, await recreated.clone().text()).toBe(201);
  });

  it("maps responsible users to participant IDs only in same-organisation trusted exports", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    const issuedAt = Date.now() - 10_000;
    expect(
      (
        await launchClassroom(
          stub,
          actorId,
          "owner",
          issuedAt,
          "Coach",
          undefined,
          undefined,
          boardId,
          organisationId,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await launchClassroom(
          stub,
          editorId,
          "editor",
          issuedAt + 1,
          "Asha",
          undefined,
          undefined,
          boardId,
          organisationId,
        )
      ).status,
    ).toBe(200);

    const editor = await connect(stub, editorId);
    editor.socket.send(
      JSON.stringify(
        createStickyCommit(
          "018f0000-0000-7000-8000-000000000b01",
          "018f0000-0000-7000-8000-000000000b02",
          "018f0000-0000-7000-8000-000000000b03",
        ),
      ),
    );
    await editor.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const browserResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.attributed.json`),
    );
    expect(browserResponse.status).toBe(200);
    const browserExport = (await browserResponse.json()) as {
      participants: Array<Record<string, unknown>>;
      objects: Array<{
        attribution: { createdBy: Record<string, unknown> };
        content: Array<{ responsibleUser: Record<string, unknown> }>;
      }>;
    };
    expect(
      browserExport.participants.every((participant) => !("participantId" in participant)),
    ).toBe(true);
    expect(browserExport.participants).toContainEqual(
      expect.objectContaining({ id: editorId, participantHash: editorId }),
    );
    expect(browserExport.objects[0]?.attribution.createdBy).toMatchObject({
      id: editorId,
      participantHash: editorId,
    });
    expect(browserExport.objects[0]?.content[0]?.responsibleUser).toMatchObject({
      id: editorId,
      participantHash: editorId,
    });
    expect(browserExport.objects[0]?.attribution.createdBy).not.toHaveProperty("participantId");
    expect(browserExport.objects[0]?.content[0]?.responsibleUser).not.toHaveProperty(
      "participantId",
    );

    const trustedResponse = await stub.fetch(
      internalRequest("/__internal/organisation-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId, format: "attributed" }),
      }),
    );
    expect(trustedResponse.status).toBe(200);
    const trustedExport = (await trustedResponse.json()) as {
      participants: Array<{ id: string; participantId: string | null }>;
      objects: Array<{
        attribution: { createdBy: { id: string; participantId: string | null } };
        content: Array<{
          responsibleUser: { id: string; participantId: string | null };
        }>;
      }>;
    };
    expect(trustedExport.participants).toContainEqual(
      expect.objectContaining({ id: editorId, participantId: `participant:${editorId}` }),
    );
    expect(trustedExport.objects[0]?.attribution.createdBy).toMatchObject({
      id: editorId,
      participantId: `participant:${editorId}`,
    });
    expect(trustedExport.objects[0]?.content[0]?.responsibleUser).toMatchObject({
      id: editorId,
      participantId: `participant:${editorId}`,
    });

    const crossOrganisation = await stub.fetch(
      internalRequest("/__internal/organisation-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organisationId: `o_${"Q".repeat(21)}A`,
          format: "attributed",
        }),
      }),
    );
    expect(crossOrganisation.status).toBe(404);
    expect(await crossOrganisation.json()).toMatchObject({
      error: { message: "Board not found." },
    });
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE board SET archived_at_ms = ? WHERE singleton = 1",
        Date.now(),
      );
    });
    const archivedTrusted = await stub.fetch(
      internalRequest("/__internal/organisation-export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organisationId, format: "canonical" }),
      }),
    );
    expect(archivedTrusted.status).toBe(200);
    expect(await archivedTrusted.json()).toMatchObject({ boardId });
    editor.socket.close(1000, "done");
  });

  it("sends one signed attributed webhook for each owner idempotency key", async () => {
    const testEnv = env as unknown as Env;
    const registry = JSON.parse(testEnv.ORGANISATION_SIGNING_KEYS ?? "{}") as Record<
      string,
      {
        derivation_key: string;
        current: { key_id: string; key: string };
      }
    >;
    const configured = Object.entries(registry)[0];
    if (configured === undefined) throw new Error("The test Organisation registry is missing.");
    const [organisationKey, keys] = configured;
    const configuredOrganisationId = `o_${bytesToBase64Url(
      (
        await hmacSha256(
          keys.derivation_key,
          `organisation:v1\u0000${organisationKey.normalize("NFC").trim()}`,
        )
      ).slice(0, 16),
    )}`;
    testEnv.WEBHOOK_ALLOWED_ORIGINS = "https://hooks.partner.example";
    const stub = testEnv.BOARD_ROOMS.getByName(boardId);
    const launched = await launchClassroom(
      stub,
      actorId,
      "owner",
      Date.now() - 1_000,
      "Coach",
      undefined,
      undefined,
      boardId,
      configuredOrganisationId,
    );
    expect(launched.status).toBe(201);
    await launched.arrayBuffer();

    const settings = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/organisation/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          webhookUrl: "https://hooks.partner.example/events/spacescale",
        }),
      }),
    );
    expect(settings.status, await settings.clone().text()).toBe(200);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const send = () =>
      stub.fetch(
        internalRequest(`/api/v1/boards/${boardId}/organisation/webhook`, {
          method: "POST",
          headers: { "idempotency-key": "board-webhook-integration-0001" },
        }),
      );
    const delivered = await send();
    expect(delivered.status, await delivered.clone().text()).toBe(200);
    expect(await delivered.json()).toMatchObject({
      delivery: {
        id: expect.stringMatching(/^whd_[A-Za-z0-9_-]{22}$/u),
        event: "board.exported",
        responseStatus: 204,
      },
      idempotentReplay: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [webhookUrl, init] = fetchMock.mock.calls[0] ?? [];
    expect(webhookUrl).toBe("https://hooks.partner.example/events/spacescale");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    const rawBody = String(init?.body);
    const payload = JSON.parse(rawBody) as {
      event: string;
      organisation: { id: string };
      export: { participants: Array<{ participantId: string | null }> };
    };
    expect(payload).toMatchObject({
      event: "board.exported",
      organisation: { id: configuredOrganisationId },
    });
    expect(payload.export.participants).toContainEqual(
      expect.objectContaining({ participantId: `participant:${actorId}` }),
    );
    const timestamp = new Headers(init?.headers).get("x-spacescale-webhook-timestamp");
    expect(timestamp).toMatch(/^\d+$/u);
    const expectedSignature = bytesToBase64Url(
      await hmacSha256(keys.current.key, `v1.${timestamp}.${rawBody}`),
    );
    expect(new Headers(init?.headers).get("x-spacescale-webhook-key-id")).toBe(keys.current.key_id);
    expect(new Headers(init?.headers).get("x-spacescale-webhook-signature")).toBe(
      `v1=${expectedSignature}`,
    );

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotentReplay: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a newer classroom launch demote the primary owner", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    const issuedAt = Date.now() - 10_000;
    const initial = await launchClassroom(stub, actorId, "owner", issuedAt, "Coach one");
    expect(initial.status).toBe(201);

    const downgrade = await launchClassroom(stub, actorId, "viewer", issuedAt + 1, "Coach renamed");
    expect(downgrade.status).toBe(200);
    expect(await downgrade.json()).toMatchObject({
      board: { aclVersion: 2 },
      actor: { id: actorId, role: "owner", displayName: "Coach renamed" },
      launchApplied: true,
      primaryOwner: true,
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      ownerActorId: durableState.storage.sql
        .exec<{ owner_actor_id: string }>("SELECT owner_actor_id FROM board")
        .one().owner_actor_id,
      member: durableState.storage.sql
        .exec<{ role: string; display_name: string }>(
          "SELECT role, display_name FROM members WHERE actor_id = ?",
          actorId,
        )
        .one(),
    }));
    expect(state).toEqual({
      ownerActorId: actorId,
      member: { role: "owner", display_name: "Coach renamed" },
    });
  });

  it("reopens an existing classroom board without resetting its persisted state", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    const issuedAt = Date.now() - 10_000;
    expect((await launchClassroom(stub, actorId, "owner", issuedAt, "Coach")).status).toBe(201);
    expect((await launchClassroom(stub, studentId, "editor", issuedAt + 1, "Student")).status).toBe(
      200,
    );

    const coach = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000832";
    coach.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000830",
          "018f0000-0000-7000-8000-000000000831",
          itemId,
        ),
      ),
    );
    await coach.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const customizedTitle = "Coach-customized classroom board";
    const lock = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: customizedTitle,
          drawingPolicy: "locked",
          expectedAclVersion: 2,
        }),
      }),
    );
    expect(lock.status).toBe(200);
    expect(await lock.json()).toMatchObject({
      board: { title: customizedTitle, drawingPolicy: "locked", aclVersion: 3 },
    });

    const named = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "classroom-relaunch-snapshot-0001",
        },
        body: JSON.stringify({ label: "Before classroom relaunch" }),
      }),
    );
    expect(named.status).toBe(201);
    const namedResult = (await named.json()) as {
      snapshot: {
        seq: number;
        sha256: string;
        itemCount: number;
        byteCount: number;
        kind: "named";
        label: string;
        createdAt: number;
      };
    };
    expect(namedResult).toMatchObject({
      snapshot: {
        seq: 1,
        kind: "named",
        label: "Before classroom relaunch",
        itemCount: 1,
      },
    });

    const downgrade = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/members/${studentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer", expectedAclVersion: 3 }),
      }),
    );
    expect(downgrade.status).toBe(200);
    expect(await downgrade.json()).toMatchObject({ aclVersion: 4 });

    const reopened = await launchClassroom(stub, coOwnerId, "viewer", issuedAt + 2, "New student");
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({
      board: { id: boardId, drawingPolicy: "locked", aclVersion: 5 },
      actor: { id: coOwnerId, role: "viewer", displayName: "New student" },
      created: false,
      launchApplied: true,
    });

    const bootstrap = await stub.fetch(
      internalActorRequest(coOwnerId, `/api/v1/boards/${boardId}/bootstrap`),
    );
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      board: {
        id: boardId,
        drawingPolicy: "locked",
        aclVersion: 5,
        latestSeq: 1,
        snapshotSeq: 1,
      },
      actor: { id: coOwnerId, role: "viewer", displayName: "New student" },
      snapshot: {
        boardId,
        seq: 1,
        settings: { title: customizedTitle },
        items: [expect.objectContaining({ id: itemId, createdBy: actorId })],
      },
    });

    const snapshots = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/snapshots`));
    expect(snapshots.status).toBe(200);
    const snapshotList = (await snapshots.json()) as {
      snapshots: Array<{
        seq: number;
        sha256: string;
        itemCount: number;
        byteCount: number;
        kind: "automatic" | "named" | "pre_clear";
        label: string | null;
        createdBy: string | null;
        createdAt: number;
      }>;
    };
    expect(snapshotList.snapshots).toContainEqual({
      ...namedResult.snapshot,
      createdBy: actorId,
    });

    const members = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/members`));
    expect(members.status).toBe(200);
    expect(await members.json()).toMatchObject({
      aclVersion: 5,
      members: expect.arrayContaining([
        expect.objectContaining({ actorId, role: "owner", primaryOwner: true }),
        expect.objectContaining({ actorId: studentId, role: "viewer" }),
        expect.objectContaining({ actorId: coOwnerId, role: "viewer" }),
      ]),
    });
    coach.socket.close(1000, "done");
  });

  it("round-trips a canonical export into first owner launch and ignores every later import", async () => {
    const binding = (env as unknown as Env).BOARD_ROOMS;
    const sourceStub = binding.getByName(boardId);
    await initializeBoard(sourceStub);
    const sourceSocket = await connect(sourceStub, actorId);
    const itemId = "018f0000-0000-7000-8000-0000000008a2";
    sourceSocket.socket.send(
      JSON.stringify(
        createStickyCommit(
          "018f0000-0000-7000-8000-0000000008a0",
          "018f0000-0000-7000-8000-0000000008a1",
          itemId,
        ),
      ),
    );
    await sourceSocket.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const sourceExportResponse = await sourceStub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.json`),
    );
    expect(sourceExportResponse.status).toBe(200);
    const sourceExportText = await sourceExportResponse.text();
    const sourceExport = JSON.parse(sourceExportText) as {
      format: string;
      version: number;
      boardId: string;
      seq: number;
      createdAt: number;
      settings: { title: string };
      items: Array<Record<string, unknown>>;
    };
    expect(sourceExport).toMatchObject({
      format: "cf-whiteboard-json",
      version: 1,
      boardId,
      seq: 1,
      settings: { title: "Test board" },
      items: [
        expect.objectContaining({
          id: itemId,
          version: 1,
          createdBy: actorId,
          geometry: expect.objectContaining({ text: "Original classroom idea\nSecond line" }),
        }),
      ],
    });

    const destinationBoardId = `b_${"I".repeat(21)}A`;
    const destinationStub = binding.getByName(destinationBoardId);
    const issuedAt = Date.now() - 5_000;
    const encodedExport = bytesToBase64Url(utf8(sourceExportText));
    const firstLaunch = await launchClassroom(
      destinationStub,
      actorId,
      "owner",
      issuedAt,
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      encodedExport,
      destinationBoardId,
    );
    expect(firstLaunch.status).toBe(201);
    expect(await firstLaunch.json()).toMatchObject({
      board: { id: destinationBoardId, title: "Test board" },
      actor: { id: actorId, role: "owner" },
      created: true,
    });

    const bootstrapResponse = await destinationStub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${destinationBoardId}/bootstrap`),
    );
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = (await bootstrapResponse.json()) as {
      board: { latestSeq: number; snapshotSeq: number; title: string };
      snapshot: { seq: number; settings: { title: string }; items: Array<Record<string, unknown>> };
    };
    expect(bootstrap).toMatchObject({
      board: { latestSeq: 1, snapshotSeq: 1, title: "Test board" },
      snapshot: {
        seq: 1,
        settings: { title: "Test board" },
        items: [
          expect.objectContaining({
            id: itemId,
            z: 1,
            version: 1,
            createdBy: actorId,
            style: sourceExport.items[0]?.style,
            transform: sourceExport.items[0]?.transform,
            geometry: sourceExport.items[0]?.geometry,
          }),
        ],
      },
    });

    const importedExportResponse = await destinationStub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${destinationBoardId}/export.json`),
    );
    expect(importedExportResponse.status, await importedExportResponse.clone().text()).toBe(200);
    const importedExport = (await importedExportResponse.json()) as typeof sourceExport;
    expect(importedExport).toMatchObject({
      format: sourceExport.format,
      version: sourceExport.version,
      boardId: destinationBoardId,
      seq: 1,
      settings: sourceExport.settings,
      items: sourceExport.items,
    });

    // Version 1 is immediately usable by the normal optimistic/server edit
    // path; imported state is not mistaken for a local unsaved object.
    const destinationSocket = await connect(destinationStub, actorId, 1, destinationBoardId);
    destinationSocket.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-0000000008a3",
        actionId: "018f0000-0000-7000-8000-0000000008a4",
        baseSeq: 1,
        op: {
          kind: "item.update",
          itemId,
          expectedVersion: 1,
          patch: {
            geometry: {
              x: 40,
              y: 55,
              width: 240,
              height: 170,
              text: "Imported and editable",
            },
          },
        },
      }),
    );
    await expect(
      destinationSocket.next((frame) => frame.t === "server.action" && frame.seq === 2),
    ).resolves.toMatchObject({
      op: { kind: "item.update", item: { id: itemId, version: 2 } },
    });

    const beforeRelaunch = await destinationStub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${destinationBoardId}/export.json`),
    );
    const beforeRelaunchValue = await beforeRelaunch.json();
    const overwriteAttempt = bytesToBase64Url(
      utf8(
        JSON.stringify({
          format: "cf-whiteboard-json",
          version: 1,
          boardId,
          seq: 0,
          createdAt: Date.now(),
          settings: { title: "Overwrite attempt" },
          items: [],
        }),
      ),
    );
    const repeatedLaunch = await launchClassroom(
      destinationStub,
      actorId,
      "owner",
      issuedAt + 1,
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      overwriteAttempt,
      destinationBoardId,
    );
    expect(repeatedLaunch.status).toBe(200);
    expect(await repeatedLaunch.json()).toMatchObject({
      board: { title: "Test board" },
      created: false,
    });
    const malformedRelaunch = await launchClassroom(
      destinationStub,
      actorId,
      "owner",
      issuedAt + 2,
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "not+base64url",
      destinationBoardId,
    );
    expect(malformedRelaunch.status).toBe(200);
    await malformedRelaunch.arrayBuffer();
    const afterRelaunch = await destinationStub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${destinationBoardId}/export.json`),
    );
    expect(await afterRelaunch.json()).toEqual(beforeRelaunchValue);

    sourceSocket.socket.close(1000, "done");
    destinationSocket.socket.close(1000, "done");
  });

  it("ignores a first student import and creates the normal blank classroom board", async () => {
    const destinationBoardId = `b_${"J".repeat(21)}A`;
    const destinationStub = (env as unknown as Env).BOARD_ROOMS.getByName(destinationBoardId);
    const issuedAt = Date.now() - 5_000;
    const studentLaunch = await launchClassroom(
      destinationStub,
      studentId,
      "editor",
      issuedAt,
      "Student",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "not+base64url",
      destinationBoardId,
    );
    expect(studentLaunch.status).toBe(201);
    expect(await studentLaunch.json()).toMatchObject({
      board: { id: destinationBoardId, title: "Classroom board" },
      actor: { id: studentId, role: "editor" },
      created: true,
    });

    const bootstrap = await destinationStub.fetch(
      internalActorRequest(studentId, `/api/v1/boards/${destinationBoardId}/bootstrap`),
    );
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      board: { latestSeq: 0, snapshotSeq: 0, title: "Classroom board" },
      snapshot: { seq: 0, settings: { title: "Classroom board" }, items: [] },
    });
  });

  it("rejects over-limit first-owner imports without partially creating a board", async () => {
    const binding = (env as unknown as Env).BOARD_ROOMS;
    const itemLimitBoardId = `b_${"K".repeat(21)}A`;
    const itemLimitStub = binding.getByName(itemLimitBoardId);
    const tooManyItems = bytesToBase64Url(
      utf8(
        JSON.stringify({
          format: "cf-whiteboard-json",
          version: 1,
          boardId,
          seq: 0,
          createdAt: Date.now(),
          settings: { title: "Too many objects" },
          items: Array.from({ length: MAX_CLASSROOM_IMPORT_ITEMS + 1 }, () => ({})),
        }),
      ),
    );
    const itemLimitResponse = await launchClassroom(
      itemLimitStub,
      actorId,
      "owner",
      Date.now() - 5_000,
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      tooManyItems,
      itemLimitBoardId,
    );
    expect(itemLimitResponse.status).toBe(413);
    expect(await itemLimitResponse.json()).toMatchObject({
      error: { code: "BOARD_LIMIT_REACHED" },
    });
    expect(
      await runInDurableObject(itemLimitStub, (_instance, durableState) => ({
        boards: durableState.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM board")
          .one().count,
        items: durableState.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM items")
          .one().count,
      })),
    ).toEqual({ boards: 0, items: 0 });

    const byteLimitBoardId = `b_${"L".repeat(21)}A`;
    const byteLimitStub = binding.getByName(byteLimitBoardId);
    const byteLimitResponse = await launchClassroom(
      byteLimitStub,
      actorId,
      "owner",
      Date.now() - 4_000,
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "A".repeat(MAX_CLASSROOM_IMPORT_ENCODED_CHARS + 1),
      byteLimitBoardId,
    );
    expect(byteLimitResponse.status).toBe(413);
    expect(await byteLimitResponse.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(
      await runInDurableObject(
        byteLimitStub,
        (_instance, durableState) =>
          durableState.storage.sql
            .exec<{ count: number }>("SELECT COUNT(*) AS count FROM board")
            .one().count,
      ),
    ).toBe(0);
  });

  it("keeps a paginated owner-only activity feed after action compaction", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const editor = await connect(stub, editorId);
    const first = {
      commandId: "018f0000-0000-7000-8000-000000000810",
      actionId: "018f0000-0000-7000-8000-000000000811",
      itemId: "018f0000-0000-7000-8000-000000000812",
    };
    const second = {
      commandId: "018f0000-0000-7000-8000-000000000820",
      actionId: "018f0000-0000-7000-8000-000000000821",
      itemId: "018f0000-0000-7000-8000-000000000822",
    };
    editor.socket.send(JSON.stringify(createCommit(first.commandId, first.actionId, first.itemId)));
    await editor.next((frame) => frame.t === "server.action" && frame.seq === 1);
    editor.socket.send(
      JSON.stringify(createCommit(second.commandId, second.actionId, second.itemId)),
    );
    await editor.next((frame) => frame.t === "server.action" && frame.seq === 2);

    const denied = await stub.fetch(
      internalActorRequest(editorId, `/api/v1/boards/${boardId}/activity?afterSeq=0&limit=1`),
    );
    expect(denied.status).toBe(403);

    const firstPage = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/activity?afterSeq=0&limit=1`),
    );
    expect(firstPage.status).toBe(200);
    expect(await firstPage.json()).toEqual({
      events: [
        {
          seq: 1,
          actionId: first.actionId,
          actor: { id: editorId, displayName: "Editor" },
          kind: "item.create",
          itemIds: [first.itemId],
          acceptedAt: expect.any(Number),
        },
      ],
      nextAfterSeq: 1,
      hasMore: true,
    });

    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM actions WHERE seq = 1");
    });
    const secondPage = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/activity?afterSeq=1&limit=1`),
    );
    expect(secondPage.status).toBe(200);
    expect(await secondPage.json()).toEqual({
      events: [
        {
          seq: 2,
          actionId: second.actionId,
          actor: { id: editorId, displayName: "Editor" },
          kind: "item.create",
          itemIds: [second.itemId],
          acceptedAt: expect.any(Number),
        },
      ],
      nextAfterSeq: 2,
      hasMore: false,
    });
    const retained = await runInDurableObject(stub, (_instance, durableState) => ({
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      activities: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM activity_log")
        .one().count,
    }));
    expect(retained).toEqual({ actions: 1, activities: 2 });
    editor.socket.close(1000, "done");
  });

  it("does not let stale classroom URLs undo a newer role change or revocation", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    const issuedAt = Date.now() - 10_000;
    const studentIssuedAt = Date.now() + 30_000;
    expect((await launchClassroom(stub, actorId, "owner", issuedAt, "Coach")).status).toBe(201);
    expect(
      (await launchClassroom(stub, studentId, "editor", studentIssuedAt, "Student")).status,
    ).toBe(200);

    const downgrade = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/members/${studentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer", expectedAclVersion: 2 }),
      }),
    );
    expect(downgrade.status).toBe(200);
    expect(await downgrade.json()).toMatchObject({ aclVersion: 3 });

    const staleAfterDowngrade = await launchClassroom(
      stub,
      studentId,
      "editor",
      studentIssuedAt,
      "Old student URL",
    );
    expect(staleAfterDowngrade.status).toBe(200);
    expect(await staleAfterDowngrade.json()).toMatchObject({
      board: { aclVersion: 3 },
      actor: { role: "viewer", displayName: "Student" },
      launchApplied: false,
    });

    const revoke = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/members/${studentId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedAclVersion: 3 }),
      }),
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ aclVersion: 4 });

    const staleAfterRevoke = await launchClassroom(
      stub,
      studentId,
      "editor",
      studentIssuedAt,
      "Old student URL",
    );
    expect(staleAfterRevoke.status).toBe(404);
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      aclVersion: durableState.storage.sql
        .exec<{ acl_version: number }>("SELECT acl_version FROM board")
        .one().acl_version,
      member: durableState.storage.sql
        .exec<{ role: string; display_name: string; revoked_at_ms: number | null }>(
          "SELECT role, display_name, revoked_at_ms FROM members WHERE actor_id = ?",
          studentId,
        )
        .one(),
    }));
    expect(state.aclVersion).toBe(4);
    expect(state.member).toMatchObject({ role: "viewer", display_name: "Student" });
    expect(state.member.revoked_at_ms).not.toBeNull();
  });

  it("keeps both classroom owners active when primary recovery custody transfers", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    const issuedAt = Date.now() - 10_000;
    await (await launchClassroom(stub, actorId, "owner", issuedAt, "Coach one")).arrayBuffer();
    await (
      await launchClassroom(stub, coOwnerId, "owner", issuedAt + 1, "Coach two")
    ).arrayBuffer();
    const target = await connect(stub, coOwnerId);

    const transfer = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/ownership-transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetActorId: coOwnerId, expectedAclVersion: 2 }),
      }),
    );
    expect(transfer.status).toBe(200);
    expect(await transfer.json()).toMatchObject({
      ownerActorId: coOwnerId,
      aclVersion: 3,
      recoveryTokenDelivered: true,
    });
    expect(await target.next((frame) => frame.t === "access.changed")).toMatchObject({
      role: "owner",
      aclVersion: 3,
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      primaryOwner: durableState.storage.sql
        .exec<{ owner_actor_id: string }>("SELECT owner_actor_id FROM board")
        .one().owner_actor_id,
      roles: durableState.storage.sql
        .exec<{ actor_id: string; role: string }>(
          "SELECT actor_id, role FROM members ORDER BY actor_id",
        )
        .toArray(),
    }));
    expect(state).toEqual({
      primaryOwner: coOwnerId,
      roles: [
        { actor_id: actorId, role: "owner" },
        { actor_id: coOwnerId, role: "owner" },
      ],
    });
    target.socket.close(1000, "done");
  });

  it("preserves unrelated classroom co-owners during owner recovery", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    const issuedAt = Date.now() - 10_000;
    const recoveryToken = "classroom-recovery-token-abcdefghijklmnopqrstuvwxyz";
    const recoveryHash = await sha256Base64Url(recoveryToken);
    await (
      await launchClassroom(stub, actorId, "owner", issuedAt, "Coach one", recoveryHash)
    ).arrayBuffer();
    await (
      await launchClassroom(stub, coOwnerId, "owner", issuedAt + 1, "Coach two", recoveryHash)
    ).arrayBuffer();

    const recovery = await stub.fetch(
      internalActorRequest(studentId, `/api/v1/boards/${boardId}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "recovery",
          token: recoveryToken,
          displayName: "Recovered owner",
          confirmOwnershipTransfer: true,
        }),
      }),
    );
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({
      actor: { id: studentId, role: "owner" },
      aclVersion: 3,
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      primaryOwner: durableState.storage.sql
        .exec<{ owner_actor_id: string }>("SELECT owner_actor_id FROM board")
        .one().owner_actor_id,
      roles: durableState.storage.sql
        .exec<{ actor_id: string; role: string }>(
          "SELECT actor_id, role FROM members ORDER BY actor_id",
        )
        .toArray(),
    }));
    expect(state).toEqual({
      primaryOwner: studentId,
      roles: [
        { actor_id: actorId, role: "editor" },
        { actor_id: coOwnerId, role: "owner" },
        { actor_id: studentId, role: "owner" },
      ],
    });
  });

  it("lets every owner administer and draw under owner-only policy while locked denies all", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);

    const promote = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/members/${editorId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "owner", expectedAclVersion: 2 }),
      }),
    );
    expect(promote.status).toBe(200);
    expect(await promote.json()).toMatchObject({ aclVersion: 3 });

    const members = await stub.fetch(
      internalActorRequest(editorId, `/api/v1/boards/${boardId}/members`),
    );
    expect(members.status).toBe(200);
    expect(await members.json()).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ actorId, role: "owner", primaryOwner: true }),
        expect.objectContaining({ actorId: editorId, role: "owner", primaryOwner: false }),
      ]),
    });

    const ownerOnly = await stub.fetch(
      internalActorRequest(editorId, `/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drawingPolicy: "owner_only", expectedAclVersion: 3 }),
      }),
    );
    expect(ownerOnly.status).toBe(200);
    expect(await ownerOnly.json()).toMatchObject({
      board: { drawingPolicy: "owner_only", aclVersion: 4 },
    });

    const primary = await connect(stub, actorId);
    const secondary = await connect(stub, editorId);
    const firstCommandId = "018f0000-0000-7000-8000-0000000000b0";
    primary.socket.send(
      JSON.stringify(
        createCommit(
          firstCommandId,
          "018f0000-0000-7000-8000-0000000000b1",
          "018f0000-0000-7000-8000-0000000000b2",
        ),
      ),
    );
    expect(
      await primary.next(
        (frame) => frame.t === "server.action" && frame.commandId === firstCommandId,
      ),
    ).toMatchObject({ seq: 1, actor: { id: actorId } });

    const secondCommandId = "018f0000-0000-7000-8000-0000000000c0";
    secondary.socket.send(
      JSON.stringify(
        createCommit(
          secondCommandId,
          "018f0000-0000-7000-8000-0000000000c1",
          "018f0000-0000-7000-8000-0000000000c2",
        ),
      ),
    );
    expect(
      await secondary.next(
        (frame) => frame.t === "server.action" && frame.commandId === secondCommandId,
      ),
    ).toMatchObject({ seq: 2, actor: { id: editorId } });

    const locked = await stub.fetch(
      internalActorRequest(editorId, `/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drawingPolicy: "locked", expectedAclVersion: 4 }),
      }),
    );
    expect(locked.status).toBe(200);
    expect(await locked.json()).toMatchObject({
      board: { drawingPolicy: "locked", aclVersion: 5 },
    });
    await Promise.all([
      primary.next((frame) => frame.t === "access.changed" && frame.drawingPolicy === "locked"),
      secondary.next((frame) => frame.t === "access.changed" && frame.drawingPolicy === "locked"),
    ]);

    const blockedPrimaryCommand = "018f0000-0000-7000-8000-0000000000d0";
    primary.socket.send(
      JSON.stringify(
        createCommit(
          blockedPrimaryCommand,
          "018f0000-0000-7000-8000-0000000000d1",
          "018f0000-0000-7000-8000-0000000000d2",
        ),
      ),
    );
    expect(
      await primary.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === blockedPrimaryCommand,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 2 });

    const blockedSecondaryCommand = "018f0000-0000-7000-8000-0000000000e0";
    secondary.socket.send(
      JSON.stringify(
        createCommit(
          blockedSecondaryCommand,
          "018f0000-0000-7000-8000-0000000000e1",
          "018f0000-0000-7000-8000-0000000000e2",
        ),
      ),
    );
    expect(
      await secondary.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === blockedSecondaryCommand,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 2 });

    const rotateAsSecondary = await stub.fetch(
      internalActorRequest(editorId, `/api/v1/boards/${boardId}/owner-recovery/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedAclVersion: 5 }),
      }),
    );
    expect(rotateAsSecondary.status).toBe(403);

    const demotePrimary = await stub.fetch(
      internalActorRequest(editorId, `/api/v1/boards/${boardId}/members/${actorId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "editor", expectedAclVersion: 5 }),
      }),
    );
    expect(demotePrimary.status).toBe(409);

    const removeSecondary = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/members/${editorId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedAclVersion: 5 }),
      }),
    );
    expect(removeSecondary.status).toBe(200);
    expect(await removeSecondary.json()).toMatchObject({ aclVersion: 6, revoked: true });
    primary.socket.close(1000, "done");
    secondary.socket.close(1000, "done");
  });

  it("echoes only the supported whiteboard WebSocket subprotocol", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const request = socketRequest(actorId);
    request.headers.set("Sec-WebSocket-Protocol", "whiteboard.v1, auth.sensitive-token");
    const response = await stub.fetch(request);
    expect(response.status).toBe(101);
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("whiteboard.v1");
    response.webSocket?.accept();
    response.webSocket?.close(1000, "done");
  });
  it("emits privacy-safe normalized room, replay, commit, storage, and broadcast events", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    output.mockClear();

    const bootstrap = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/bootstrap`, { method: "GET" }),
    );
    await bootstrap.arrayBuffer();
    const completion = loggedEvents(output, "room.http_completed");
    expect(completion).toHaveLength(1);
    expect(completion[0]).toMatchObject({
      environment: "development",
      boardIdHash: await boardIdHash(boardId),
      durableObjectVersion: expect.any(String),
      executionComponent: "BoardRoom",
      status: 200,
      internalError: false,
      durationMs: expect.any(Number),
    });

    output.mockClear();
    const connected = await connect(stub, actorId);
    expect(loggedEvents(output, "socket.connected")).toHaveLength(1);
    expect(loggedEvents(output, "replay.completed")).toEqual([
      expect.objectContaining({ replayActions: 0, replayBytes: 0, resyncRequired: false }),
    ]);

    output.mockClear();
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-0000000000a0",
          "018f0000-0000-7000-8000-0000000000a1",
          "018f0000-0000-7000-8000-0000000000a2",
        ),
      ),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 1);
    expect(loggedEvents(output, "command.accepted")).toEqual([
      expect.objectContaining({
        actionKind: "item.create",
        code: "OK",
        result: "committed",
        protocolVersion: 1,
        seq: 1,
        durationMs: expect.any(Number),
      }),
    ]);
    expect(loggedEvents(output, "storage.transaction_completed")).toEqual([
      expect.objectContaining({
        result: "committed",
        sqliteRowsRead: expect.any(Number),
        sqliteRowsWritten: expect.any(Number),
      }),
    ]);
    expect(loggedEvents(output, "broadcast.completed")).toEqual([
      expect.objectContaining({ fanout: 1, sendFailures: 0 }),
    ]);
    expect(JSON.stringify(output.mock.calls)).not.toContain(boardId);
    connected.socket.close(1000, "test complete");
  });

  it("backfills 10,000 Unicode items with one exact SQLite byte aggregation", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const dataJson = JSON.stringify({
      id: "fixture",
      kind: "text",
      z: 1,
      version: 1,
      createdBy: actorId,
      style: {
        kind: "text",
        color: "#112233",
        fontSize: 16,
        fontFamily: "sans",
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 1, y: 2, text: "雪🙂e\u0301" },
    });
    const bytesPerItem = new TextEncoder().encode(dataJson).byteLength;
    expect(bytesPerItem).toBeGreaterThan(dataJson.length);

    const result = await runInDurableObject(stub, (_instance, durableState) => {
      const sql = durableState.storage.sql;
      for (let start = 1; start <= 10_000; start += 1_000) {
        const end = start + 999;
        sql.exec(
          `WITH RECURSIVE sequence(value) AS (
             VALUES (?)
             UNION ALL SELECT value + 1 FROM sequence WHERE value < ?
           )
           INSERT INTO items(
             item_id, kind, z_order, version_seq, state_token, created_by, deleted, data_json
           )
           SELECT printf('fixture-%d', value), 'text', value, 1,
             printf('token-%d', value), ?, 0, ? FROM sequence`,
          start,
          end,
          actorId,
          dataJson,
        );
      }
      sql.exec(
        `UPDATE board SET snapshot_live_item_count = -1,
          snapshot_live_item_bytes = -1 WHERE singleton = 1`,
      );
      const startedAt = performance.now();
      backfillSnapshotAccounting(durableState.storage);
      const elapsedMs = performance.now() - startedAt;
      return {
        elapsedMs,
        accounting: sql
          .exec<{ item_count: number; item_bytes: number }>(
            `SELECT snapshot_live_item_count AS item_count,
              snapshot_live_item_bytes AS item_bytes FROM board`,
          )
          .one(),
      };
    });
    expect(result.accounting).toEqual({
      item_count: 10_000,
      item_bytes: 10_000 * bytesPerItem,
    });
    expect(result.elapsedMs).toBeLessThan(2_000);
  });

  it("writes a snapshot job only on first dirtiness and the 250-action threshold", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const base = Date.now() + 120_000;
    const result = await runInDurableObject(stub, async (instance, durableState) => {
      const sql = durableState.storage.sql;
      sql.exec("CREATE TABLE snapshot_job_audit(kind TEXT NOT NULL)");
      sql.exec(
        `CREATE TRIGGER snapshot_job_insert_audit AFTER INSERT ON scheduled_jobs
         BEGIN INSERT INTO snapshot_job_audit(kind) VALUES ('insert'); END`,
      );
      sql.exec(
        `CREATE TRIGGER snapshot_job_update_audit AFTER UPDATE ON scheduled_jobs
         BEGIN INSERT INTO snapshot_job_audit(kind) VALUES ('update'); END`,
      );
      const room = instance as unknown as {
        upsertSnapshotJob(seq: number, acceptedAt: number, latestSnapshotSeq: number): boolean;
        scheduleNextAlarm(): Promise<void>;
      };
      const changed: number[] = [];
      for (let seq = 1; seq <= 300; seq += 1) {
        if (room.upsertSnapshotJob(seq, base + seq - 1, 0)) changed.push(seq);
      }
      const audit = sql
        .exec<{ kind: string; count: number }>(
          "SELECT kind, COUNT(*) AS count FROM snapshot_job_audit GROUP BY kind ORDER BY kind",
        )
        .toArray();
      const dueAt = sql
        .exec<{ due_at_ms: number }>(
          "SELECT due_at_ms FROM scheduled_jobs WHERE job_name = 'snapshot'",
        )
        .one().due_at_ms;

      await durableState.storage.setAlarm(base + 200);
      await room.scheduleNextAlarm();
      const unchangedLaterAlarm = await durableState.storage.getAlarm();
      sql.exec("UPDATE scheduled_jobs SET due_at_ms = ? WHERE job_name = 'snapshot'", base + 100);
      await room.scheduleNextAlarm();
      const movedEarlierAlarm = await durableState.storage.getAlarm();
      return { changed, audit, dueAt, unchangedLaterAlarm, movedEarlierAlarm };
    });
    expect(result).toEqual({
      changed: [1, 250],
      audit: [
        { kind: "insert", count: 1 },
        { kind: "update", count: 1 },
      ],
      dueAt: base + 249,
      unchangedLaterAlarm: base + 200,
      movedEarlierAlarm: base + 100,
    });
  });

  it("checkpoints authoritative action usage after eviction without per-action usage writes", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000710",
          "018f0000-0000-7000-8000-000000000711",
          "018f0000-0000-7000-8000-000000000712",
        ),
      ),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 1);
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000713",
          "018f0000-0000-7000-8000-000000000714",
          "018f0000-0000-7000-8000-000000000715",
        ),
      ),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 2);
    const beforeCheckpoint = await runInDurableObject(stub, (_instance, durableState) => ({
      usageRows: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM usage_counters")
        .one().count,
      actionUsage: durableState.storage.sql
        .exec<{
          seq: number;
          frames: number;
          reads: number;
          writes: number;
        }>(
          `SELECT seq, usage_incoming_frames AS frames,
            usage_rows_read_estimate AS reads,
            usage_rows_written_estimate AS writes FROM actions ORDER BY seq`,
        )
        .toArray(),
    }));
    expect(beforeCheckpoint).toEqual({
      usageRows: 0,
      actionUsage: [
        { seq: 1, frames: 1, reads: 8, writes: 16 },
        { seq: 2, frames: 1, reads: 8, writes: 14 },
      ],
    });

    await evictDurableObject(stub, { webSockets: "hibernate" });
    const named = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "usage-checkpoint-after-eviction-0001",
        },
        body: JSON.stringify({ label: "Usage checkpoint" }),
      }),
    );
    expect(named.status).toBe(201);
    await named.arrayBuffer();

    const usage = await runInDurableObject(stub, (_instance, durableState) =>
      durableState.storage.sql
        .exec<{
          incoming_frames: number;
          billed_request_estimate: number;
          rows_read_estimate: number;
          rows_written_estimate: number;
          r2_reads: number;
          r2_writes: number;
          actions: number;
          snapshots: number;
        }>("SELECT * FROM usage_counters")
        .one(),
    );
    expect(usage).toMatchObject({
      incoming_frames: 2,
      billed_request_estimate: 1,
      rows_read_estimate: 23,
      rows_written_estimate: 37,
      r2_reads: 1,
      r2_writes: 1,
      actions: 2,
      snapshots: 1,
    });
    connected.socket.close(1000, "done");
  });

  it("rejects title and item growth whose prospective canonical snapshot exceeds 20 MiB", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      const sql = durableState.storage.sql;
      const board = sql.exec<BoardRow>("SELECT * FROM board").one();
      const envelope = canonicalSnapshotByteLengthFromParts({
        boardId: board.public_id,
        seq: board.latest_seq,
        createdAt: board.created_at_ms,
        settings: { title: board.title },
        itemCount: 1,
        itemBytes: 0,
      });
      sql.exec(
        `UPDATE board SET snapshot_live_item_count = 1,
          snapshot_live_item_bytes = ? WHERE singleton = 1`,
        20 * 1024 * 1024 - envelope,
      );
    });
    const response = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x".repeat(120), expectedAclVersion: 1 }),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "BOARD_LIMIT_REACHED" } });
    const board = await runInDurableObject(stub, (_instance, durableState) =>
      durableState.storage.sql
        .exec<{ title: string; acl_version: number }>("SELECT title, acl_version FROM board")
        .one(),
    );
    expect(board).toEqual({ title: "Test board", acl_version: 1 });

    const connected = await connect(stub, actorId);
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000600",
          "018f0000-0000-7000-8000-000000000601",
          "018f0000-0000-7000-8000-000000000602",
        ),
      ),
    );
    const rejected = await connected.next((frame) => frame.t === "server.rejected");
    expect(rejected).toMatchObject({ code: "BOARD_LIMIT_REACHED", latestSeq: 0 });
    const writes = await runInDurableObject(stub, (_instance, durableState) => ({
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      items: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM items")
        .one().count,
    }));
    expect(writes).toEqual({ actions: 0, items: 0 });
    connected.socket.close(1000, "done");
  });

  it("commits contiguously, deduplicates retries, rejects stale writes, and replays", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const command = createCommit(
      "018f0000-0000-7000-8000-000000000010",
      "018f0000-0000-7000-8000-000000000011",
      "018f0000-0000-7000-8000-000000000012",
    );
    connected.socket.send(JSON.stringify(command));
    const accepted = await connected.next((frame) => frame.t === "server.action");
    expect(accepted.seq).toBe(1);

    connected.socket.send(JSON.stringify(command));
    const duplicate = await connected.next((frame) => frame.t === "server.action");
    expect(duplicate).toEqual(accepted);

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000020",
        actionId: "018f0000-0000-7000-8000-000000000021",
        baseSeq: 0,
        op: {
          kind: "item.update",
          itemId: "018f0000-0000-7000-8000-000000000012",
          expectedVersion: 0,
          patch: { transform: [1, 0, 0, 1, 20, 20] },
        },
      }),
    );
    const rejected = await connected.next((frame) => frame.t === "server.rejected");
    expect(rejected).toMatchObject({ code: "STALE_ITEM", latestSeq: 1 });
    const counts = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      accounting: readSnapshotAccounting(durableState.storage.sql),
    }));
    expect(counts).toMatchObject({ latestSeq: 1, actions: 1 });
    expect(counts.accounting.stored).toEqual(counts.accounting.actual);
    expect(counts.accounting.decomposedBytes).toBe(counts.accounting.serializedBytes);
    const backfilled = await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        `UPDATE board SET snapshot_live_item_count = -1,
          snapshot_live_item_bytes = -1 WHERE singleton = 1`,
      );
      backfillSnapshotAccounting(durableState.storage);
      return readSnapshotAccounting(durableState.storage.sql);
    });
    expect(backfilled.stored).toEqual(backfilled.actual);

    connected.socket.close(1000, "reconnect test");
    const replayed = await connect(stub, actorId, 0);
    await replayed.next((frame) => frame.t === "server.presence_state");
    expect(replayed.received.slice(0, 4).map((frame) => frame.t)).toEqual([
      "server.welcome",
      "server.replay",
      "server.ready",
      "server.presence_state",
    ]);
    const replay = await replayed.next((frame) => frame.t === "server.replay");
    expect(replay).toMatchObject({ fromExclusive: 0, toInclusive: 1 });
    expect((replay.actions as unknown[]).length).toBe(1);
    replayed.socket.close(1000, "done");
  });

  it("keeps exact snapshot accounting through undo, redo, and clear", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const originalActionId = "018f0000-0000-7000-8000-000000000401";
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000400",
          originalActionId,
          "018f0000-0000-7000-8000-000000000402",
        ),
      ),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 1);

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000410",
        actionId: "018f0000-0000-7000-8000-000000000411",
        baseSeq: 1,
        op: {
          kind: "history.undo",
          expectedHistoryVersion: 1,
          targetActionId: originalActionId,
        },
      }),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 2);
    const afterUndo = await runInDurableObject(stub, (_instance, state) =>
      readSnapshotAccounting(state.storage.sql),
    );
    expect(afterUndo.stored).toEqual({ itemCount: 0, itemBytes: 0 });
    expect(afterUndo.decomposedBytes).toBe(afterUndo.serializedBytes);

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000420",
        actionId: "018f0000-0000-7000-8000-000000000421",
        baseSeq: 2,
        op: {
          kind: "history.redo",
          expectedHistoryVersion: 2,
          targetActionId: originalActionId,
        },
      }),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 3);
    const afterRedo = await runInDurableObject(stub, (_instance, state) =>
      readSnapshotAccounting(state.storage.sql),
    );
    expect(afterRedo.stored).toEqual(afterRedo.actual);
    expect(afterRedo.actual.itemCount).toBe(1);
    expect(afterRedo.decomposedBytes).toBe(afterRedo.serializedBytes);

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000430",
        actionId: "018f0000-0000-7000-8000-000000000431",
        baseSeq: 3,
        op: { kind: "board.clear", expectedBoardSeq: 3 },
      }),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 4);
    const afterClear = await runInDurableObject(stub, (_instance, state) =>
      readSnapshotAccounting(state.storage.sql),
    );
    expect(afterClear.stored).toEqual({ itemCount: 0, itemBytes: 0 });
    expect(afterClear.decomposedBytes).toBe(afterClear.serializedBytes);
    connected.socket.close(1000, "done");
  });

  it("enforces stamp roles and keeps the attributed owner stamp after object wake", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.transactionSync(() => {
        durableState.storage.sql.exec(
          `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
           VALUES (?, 'viewer', 'Viewer', ?, ?)`,
          studentId,
          now,
          now,
        );
        durableState.storage.sql.exec("UPDATE board SET acl_version = 3");
      });
    });

    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const viewer = await connect(stub, studentId);
    const ownerCreate = createStampCommit(
      "018f0000-0000-7000-8000-000000000870",
      "018f0000-0000-7000-8000-000000000871",
      "018f0000-0000-7000-8000-000000000872",
    );
    owner.socket.send(JSON.stringify(ownerCreate));
    expect(
      await owner.next(
        (frame) => frame.t === "server.action" && frame.commandId === ownerCreate.commandId,
      ),
    ).toMatchObject({
      seq: 1,
      actor: { id: actorId, displayName: "Owner 1" },
      op: {
        kind: "item.create",
        item: { ...ownerCreate.op.item, z: 1, version: 1, createdBy: actorId },
      },
    });

    const viewerCreate = createStampCommit(
      "018f0000-0000-7000-8000-000000000873",
      "018f0000-0000-7000-8000-000000000874",
      "018f0000-0000-7000-8000-000000000875",
    );
    viewerCreate.baseSeq = 1;
    viewer.socket.send(JSON.stringify(viewerCreate));
    expect(
      await viewer.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === viewerCreate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    const lock = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drawingPolicy: "locked", expectedAclVersion: 3 }),
      }),
    );
    expect(lock.status).toBe(200);
    expect(await lock.json()).toMatchObject({
      board: { drawingPolicy: "locked", aclVersion: 4 },
    });
    await editor.next((frame) => frame.t === "access.changed" && frame.drawingPolicy === "locked");

    const editorCreate = createStampCommit(
      "018f0000-0000-7000-8000-000000000876",
      "018f0000-0000-7000-8000-000000000877",
      "018f0000-0000-7000-8000-000000000878",
    );
    editorCreate.baseSeq = 1;
    editor.socket.send(JSON.stringify(editorCreate));
    expect(
      await editor.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === editorCreate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });

    await evictDurableObject(stub, { webSockets: "hibernate" });
    const exportedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.json`),
    );
    expect(exportedResponse.status).toBe(200);
    expect(exportedResponse.headers.get("X-Whiteboard-Seq")).toBe("1");
    const exported = (await exportedResponse.json()) as { seq: number; items: unknown[] };
    expect(exported.seq).toBe(1);
    expect(exported.items).toEqual([
      { ...ownerCreate.op.item, z: 1, version: 1, createdBy: actorId },
    ]);

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
    viewer.socket.close(1000, "done");
  });

  it("streams private R2 images only for the matching signed-viewer Organisation", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    const launched = await launchClassroom(
      stub,
      actorId,
      "owner",
      Date.now() - 1_000,
      "Organisation owner",
      undefined,
      undefined,
      boardId,
      organisationId,
    );
    expect(launched.status).toBe(201);
    await launched.arrayBuffer();

    const enabled = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { images: true }, expectedAclVersion: 1 }),
      }),
    );
    expect(enabled.status).toBe(200);
    await enabled.arrayBuffer();

    const imageBytes = Uint8Array.from(
      atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="),
      (character) => character.charCodeAt(0),
    );
    const uploaded = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/assets`, {
        method: "POST",
        headers: { "content-type": "image/gif" },
        body: imageBytes,
      }),
    );
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { assetId } = (await uploaded.json()) as { assetId: string };

    const viewed = await stub.fetch(
      internalRequest(
        `/__internal/organisation-assets/${assetId}?organisationId=${organisationId}`,
      ),
    );
    expect(viewed.status).toBe(200);
    expect(viewed.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await viewed.arrayBuffer())).toEqual(imageBytes);

    const crossOrganisation = await stub.fetch(
      internalRequest(
        `/__internal/organisation-assets/${assetId}?organisationId=o_${"Q".repeat(22)}`,
      ),
    );
    expect(crossOrganisation.status).toBe(404);
    expect(await crossOrganisation.json()).toMatchObject({
      error: { message: "Board not found." },
    });
  });

  it("requires image commits to reference matching committed board assets", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const enableImages = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { images: true }, expectedAclVersion: 1 }),
      }),
    );
    expect(enableImages.status).toBe(200);
    await enableImages.arrayBuffer();
    const connected = await connect(stub, actorId);

    const missing = createImageCommit(
      "018f0000-0000-7000-8000-000000000890",
      "018f0000-0000-7000-8000-000000000891",
      "018f0000-0000-7000-8000-000000000892",
      `asset_${"M".repeat(42)}Q`,
    );
    connected.socket.send(JSON.stringify(missing));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === missing.commandId,
      ),
    ).toMatchObject({ code: "INVALID_FRAME", latestSeq: 0 });

    const digest = "A".repeat(43);
    const assetId = `asset_${digest}`;
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.sql.exec(
        `INSERT INTO board_assets(
           asset_id, sha256, r2_key, mime_type, intrinsic_width,
           intrinsic_height, byte_count, state, created_by,
           created_at_ms, committed_at_ms
         ) VALUES (?, ?, ?, 'image/gif', 1, 1, 1, 'pending', ?, ?, NULL)`,
        assetId,
        digest,
        `boards/${boardId}/assets/${assetId}`,
        actorId,
        now,
      );
    });

    const pending = createImageCommit(
      "018f0000-0000-7000-8000-000000000893",
      "018f0000-0000-7000-8000-000000000894",
      "018f0000-0000-7000-8000-000000000895",
      assetId,
    );
    connected.socket.send(JSON.stringify(pending));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === pending.commandId,
      ),
    ).toMatchObject({ code: "INVALID_FRAME", latestSeq: 0 });

    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE board_assets SET state = 'committed', committed_at_ms = ? WHERE asset_id = ?",
        Date.now(),
        assetId,
      );
    });

    const mismatched = createImageCommit(
      "018f0000-0000-7000-8000-000000000896",
      "018f0000-0000-7000-8000-000000000897",
      "018f0000-0000-7000-8000-000000000898",
      assetId,
      "image/png",
    );
    connected.socket.send(JSON.stringify(mismatched));
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === mismatched.commandId,
      ),
    ).toMatchObject({ code: "INVALID_FRAME", latestSeq: 0 });

    const valid = createImageCommit(
      "018f0000-0000-7000-8000-000000000900",
      "018f0000-0000-7000-8000-000000000901",
      "018f0000-0000-7000-8000-000000000902",
      assetId,
    );
    connected.socket.send(JSON.stringify(valid));
    expect(
      await connected.next(
        (frame) => frame.t === "server.action" && frame.commandId === valid.commandId,
      ),
    ).toMatchObject({
      seq: 1,
      op: { kind: "item.create", item: { geometry: { assetId } } },
    });

    const counts = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      items: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM items")
        .one().count,
    }));
    expect(counts).toEqual({ latestSeq: 1, actions: 1, items: 1 });

    connected.socket.close(1000, "done");
  });

  it("keeps attributed sticky content durable through history, R2 restore, and hibernation", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const commandId = "018f0000-0000-7000-8000-000000000860";
    const actionId = "018f0000-0000-7000-8000-000000000861";
    const itemId = "018f0000-0000-7000-8000-000000000862";
    const create = createStickyCommit(commandId, actionId, itemId);

    connected.socket.send(JSON.stringify(create));
    const created = await connected.next((frame) => frame.t === "server.action" && frame.seq === 1);
    expect(created).toMatchObject({
      seq: 1,
      actionId,
      actor: { id: actorId, displayName: "Owner 1" },
      op: {
        kind: "item.create",
        item: {
          ...create.op.item,
          z: 1,
          version: 1,
          createdBy: actorId,
        },
      },
    });

    const activity = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/activity?afterSeq=0&limit=1`),
    );
    expect(activity.status).toBe(200);
    expect(await activity.json()).toEqual({
      events: [
        {
          seq: 1,
          actionId,
          actor: { id: actorId, displayName: "Owner 1" },
          kind: "item.create",
          itemIds: [itemId],
          acceptedAt: expect.any(Number),
        },
      ],
      nextAfterSeq: 1,
      hasMore: false,
    });

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000863",
        actionId: "018f0000-0000-7000-8000-000000000864",
        baseSeq: 1,
        op: {
          kind: "history.undo",
          expectedHistoryVersion: 1,
          targetActionId: actionId,
        },
      }),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 2);

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000865",
        actionId: "018f0000-0000-7000-8000-000000000866",
        baseSeq: 2,
        op: {
          kind: "history.redo",
          expectedHistoryVersion: 2,
          targetActionId: actionId,
        },
      }),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 3);

    const named = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "sticky-durability-snapshot-0001",
        },
        body: JSON.stringify({ label: "Sticky before edit" }),
      }),
    );
    expect(named.status).toBe(201);
    expect(await named.json()).toMatchObject({
      snapshot: {
        seq: 3,
        kind: "named",
        label: "Sticky before edit",
        itemCount: 1,
      },
    });

    const snapshotKey = await runInDurableObject(
      stub,
      (_instance, durableState) =>
        durableState.storage.sql
          .exec<{ r2_json_key: string }>("SELECT r2_json_key FROM snapshots WHERE seq = 3")
          .one().r2_json_key,
    );
    const snapshotObject = await typedEnv.BOARD_SNAPSHOTS.get(snapshotKey);
    if (snapshotObject === null) throw new Error("Expected the named sticky snapshot in R2.");
    const storedSnapshot = JSON.parse(await snapshotObject.text()) as {
      seq: number;
      items: unknown[];
    };
    expect(storedSnapshot.seq).toBe(3);
    expect(storedSnapshot.items).toEqual([
      {
        ...create.op.item,
        z: 1,
        version: 3,
        createdBy: actorId,
      },
    ]);

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000867",
        actionId: "018f0000-0000-7000-8000-000000000868",
        baseSeq: 3,
        op: {
          kind: "item.update",
          itemId,
          expectedVersion: 3,
          patch: {
            style: {
              kind: "sticky",
              fill: "#f8bbd0",
              textColor: "#1f2937",
              fontSize: 24,
              opacity: 0.9,
            },
            geometry: {
              x: 40,
              y: 55,
              width: 220,
              height: 160,
              text: "Temporary edit that must not survive restore",
            },
          },
        },
      }),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 4);

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000869",
        actionId: "018f0000-0000-7000-8000-00000000086a",
        baseSeq: 4,
        op: { kind: "item.delete", itemId, expectedVersion: 4 },
      }),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 5);

    const restored = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/restore/3`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "sticky-durability-restore-0002",
        },
        body: JSON.stringify({ expectedBoardSeq: 5 }),
      }),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ restoredFromSeq: 3, seq: 6, requiresResync: false });
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 6);

    await evictDurableObject(stub, { webSockets: "hibernate" });
    const bootstrap = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/bootstrap`));
    expect(bootstrap.status).toBe(200);
    const bootstrapped = (await bootstrap.json()) as {
      board: { latestSeq: number; snapshotSeq: number };
      snapshot: { seq: number; items: unknown[] };
    };
    expect(bootstrapped.board).toMatchObject({ latestSeq: 6, snapshotSeq: 6 });
    expect(bootstrapped.snapshot.seq).toBe(6);
    expect(bootstrapped.snapshot.items).toEqual([
      {
        ...create.op.item,
        z: 1,
        version: 6,
        createdBy: actorId,
      },
    ]);
    const attributedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.attributed.json`),
    );
    expect(attributedResponse.status).toBe(200);
    const attributed = (await attributedResponse.json()) as {
      objects: Array<{
        attribution: { updatedSeq: number };
        content: Array<{
          text: string;
          responsibleUser: { id: string; displayName: string } | null;
          updatedSeq: number | null;
        }>;
      }>;
    };
    expect(attributed.objects[0]).toMatchObject({
      attribution: { updatedSeq: 1 },
      content: [
        {
          text: "Original classroom idea\nSecond line",
          responsibleUser: { id: actorId, displayName: "Owner 1" },
          updatedSeq: 1,
        },
      ],
    });
    connected.socket.close(1000, "done");
  }, 45_000);

  it("exports owner-only classroom content with per-cell authorship, clears, and undo", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const tableId = "018f0000-0000-7000-8000-000000000a03";
    const create = createTableCommit(
      "018f0000-0000-7000-8000-000000000a01",
      "018f0000-0000-7000-8000-000000000a02",
      tableId,
      "Question",
    );
    editor.socket.send(JSON.stringify(create));
    await editor.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const withQuestion = [
      ["Question", "Feedback", "Next step"],
      ["Why do fractions flip?", "", ""],
      ["", "", ""],
    ];
    editor.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000a04",
        actionId: "018f0000-0000-7000-8000-000000000a05",
        baseSeq: 1,
        op: {
          kind: "item.update",
          itemId: tableId,
          expectedVersion: 1,
          patch: {
            geometry: {
              ...create.op.item.geometry,
              cells: withQuestion,
            },
          },
        },
      }),
    );
    await editor.next((frame) => frame.t === "server.action" && frame.seq === 2);

    editor.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000a06",
        actionId: "018f0000-0000-7000-8000-000000000a07",
        baseSeq: 2,
        op: {
          kind: "item.update",
          itemId: tableId,
          expectedVersion: 2,
          patch: {
            geometry: {
              ...create.op.item.geometry,
              cells: withQuestion.map((row, rowIndex) =>
                rowIndex === 1
                  ? row.map((cell, columnIndex) => (columnIndex === 0 ? "" : cell))
                  : row,
              ),
            },
          },
        },
      }),
    );
    await editor.next((frame) => frame.t === "server.action" && frame.seq === 3);

    const clearedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.attributed.json`),
    );
    expect(clearedResponse.status).toBe(200);
    expect(clearedResponse.headers.get("Content-Disposition")).toContain("-attributed.json");
    const cleared = (await clearedResponse.json()) as {
      format: string;
      version: number;
      participants: Array<Record<string, unknown>>;
      objects: Array<{
        attribution: Record<string, unknown>;
        content: Array<Record<string, unknown>>;
      }>;
    };
    expect(cleared).toMatchObject({
      format: "cf-whiteboard-attributed-json",
      version: 1,
      participants: [
        { id: actorId, displayName: "Owner 1", role: "owner", status: "active" },
        { id: editorId, displayName: "Editor", role: "editor", status: "active" },
      ],
    });
    expect(cleared.objects[0]?.attribution).toMatchObject({
      createdBy: { id: editorId, displayName: "Editor" },
      lastModifiedBy: { id: editorId, displayName: "Editor" },
      updatedSeq: 3,
    });
    expect(cleared.objects[0]?.content).toHaveLength(9);
    expect(cleared.objects[0]?.content[0]).toMatchObject({
      kind: "table_cell",
      row: 0,
      column: 0,
      text: "Question",
      responsibleUser: { id: editorId, displayName: "Editor" },
      lastChangedBy: { id: editorId, displayName: "Editor" },
      updatedSeq: 1,
    });
    expect(cleared.objects[0]?.content[3]).toMatchObject({
      kind: "table_cell",
      row: 1,
      column: 0,
      text: "",
      responsibleUser: null,
      lastChangedBy: { id: editorId, displayName: "Editor" },
      updatedSeq: 3,
    });
    expect(cleared.objects[0]?.content[4]).toEqual({
      kind: "table_cell",
      row: 1,
      column: 1,
      text: "",
      responsibleUser: null,
      lastChangedBy: null,
      updatedSeq: null,
      updatedAt: null,
    });

    const forbidden = await stub.fetch(
      internalActorRequest(editorId, `/api/v1/boards/${boardId}/export.attributed.json`),
    );
    expect(forbidden.status).toBe(403);

    editor.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000a08",
        actionId: "018f0000-0000-7000-8000-000000000a09",
        baseSeq: 3,
        op: {
          kind: "history.undo",
          expectedHistoryVersion: 3,
          targetActionId: "018f0000-0000-7000-8000-000000000a07",
        },
      }),
    );
    await editor.next((frame) => frame.t === "server.action" && frame.seq === 4);
    const undoneResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.attributed.json`),
    );
    const undone = (await undoneResponse.json()) as {
      objects: Array<{
        attribution: { updatedSeq: number };
        content: Array<Record<string, unknown>>;
      }>;
    };
    expect(undone.objects[0]?.attribution.updatedSeq).toBe(2);
    expect(undone.objects[0]?.content[3]).toMatchObject({
      text: "Why do fractions flip?",
      responsibleUser: { id: editorId, displayName: "Editor" },
      lastChangedBy: { id: editorId, displayName: "Editor" },
      updatedSeq: 2,
    });

    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000a10",
        actionId: "018f0000-0000-7000-8000-000000000a11",
        baseSeq: 4,
        op: {
          kind: "item.update",
          itemId: tableId,
          expectedVersion: 4,
          patch: { transform: [1, 0, 0, 1, 40, 20] },
        },
      }),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 5);
    const movedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.attributed.json`),
    );
    const moved = (await movedResponse.json()) as {
      objects: Array<{
        attribution: Record<string, unknown>;
        content: Array<Record<string, unknown>>;
      }>;
    };
    expect(moved.objects[0]?.attribution).toMatchObject({
      lastModifiedBy: { id: actorId, displayName: "Owner 1" },
      updatedSeq: 5,
    });
    expect(moved.objects[0]?.content[3]).toMatchObject({
      text: "Why do fractions flip?",
      responsibleUser: { id: editorId, displayName: "Editor" },
      lastChangedBy: { id: editorId, displayName: "Editor" },
      updatedSeq: 2,
    });

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  }, 45_000);

  it("reconstructs hibernated socket attachments after forced Durable Object eviction", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const response = await stub.fetch(socketRequest(actorId));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) throw new Error("Upgrade did not return a WebSocket.");
    socket.accept();

    await evictDurableObject(stub, { webSockets: "hibernate" });
    const actionReceived = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for action.")), 3_000);
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.t !== "server.action") return;
        clearTimeout(timeout);
        resolve(frame);
      });
    });
    socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000310",
          "018f0000-0000-7000-8000-000000000311",
          "018f0000-0000-7000-8000-000000000312",
        ),
      ),
    );

    const action = await actionReceived;
    expect(action).toMatchObject({
      seq: 1,
      commandId: "018f0000-0000-7000-8000-000000000310",
    });
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      sockets: durableState.getWebSockets().length,
      taggedSockets: durableState.getWebSockets(`actor:${actorId}`).length,
    }));
    expect(state).toEqual({ latestSeq: 1, sockets: 1, taggedSockets: 1 });
    socket.close(1000, "done");
  }, 45_000);

  it("caps one actor's sockets without consuming the board-wide capacity", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const ownerSockets = await Promise.all(Array.from({ length: 5 }, () => connect(stub, actorId)));

    const rejected = await stub.fetch(socketRequest(actorId));
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });

    await addEditor(stub);
    const editor = await connect(stub, editorId);
    const counts = await runInDurableObject(stub, (_instance, durableState) => ({
      total: durableState.getWebSockets().length,
      owner: durableState.getWebSockets(`actor:${actorId}`).length,
      editor: durableState.getWebSockets(`actor:${editorId}`).length,
    }));
    expect(counts).toEqual({ total: 6, owner: 5, editor: 1 });

    for (const connection of [...ownerSockets, editor]) connection.socket.close(1000, "done");
  });

  it("drops board-saturated previews without closing sockets or blocking durable ACKs", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const actors = [
      actorId,
      ...Array.from(
        { length: 8 },
        (_, index) => `a_${String.fromCharCode("B".charCodeAt(0) + index)}${"A".repeat(21)}`,
      ),
    ];
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      for (const actor of actors.slice(1)) {
        durableState.storage.sql.exec(
          `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
           VALUES (?, 'editor', 'Load editor', ?, ?)`,
          actor,
          now,
          now,
        );
      }
      durableState.storage.sql.exec("UPDATE board SET acl_version = 2");
    });
    const connections = await Promise.all(actors.map((actor) => connect(stub, actor)));
    const observer = connections[0];
    const target = connections.at(-1);
    if (observer === undefined || target === undefined) throw new Error("Missing test socket.");

    const previewFrame = (gestureId: string, previewSeq: number) => ({
      v: 1,
      t: "client.preview",
      gestureId,
      previewSeq,
      kind: "pencil.start",
      payload: {
        itemId: "018f0000-0000-7000-8000-000000000611",
        point: [1, 2],
        style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
      },
    });

    const helperGestures = connections.slice(0, -1).map((connection, index) => {
      const gestureId = `018f0000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
      for (let previewSeq = 0; previewSeq < 30; previewSeq += 1) {
        connection.socket.send(JSON.stringify(previewFrame(gestureId, previewSeq)));
      }
      return gestureId;
    });
    await Promise.all(
      helperGestures.map((gestureId) =>
        target.next((frame) => frame.t === "server.preview" && frame.gestureId === gestureId),
      ),
    );

    const targetGesture = "018f0000-0000-7000-8000-000000000610";
    for (let previewSeq = 0; previewSeq < 100; previewSeq += 1) {
      target.socket.send(JSON.stringify(previewFrame(targetGesture, previewSeq)));
    }
    const commandId = "018f0000-0000-7000-8000-000000000620";
    target.socket.send(
      JSON.stringify(
        createCommit(
          commandId,
          "018f0000-0000-7000-8000-000000000621",
          "018f0000-0000-7000-8000-000000000622",
        ),
      ),
    );
    const senderAction = await target.next(
      (frame) =>
        (frame.t === "server.action" && frame.commandId === commandId) ||
        frame.t === "server.rejected",
    );
    if (senderAction.t === "server.rejected") {
      throw new Error(`Durable command was rejected: ${JSON.stringify(senderAction)}`);
    }
    expect(senderAction).toMatchObject({ seq: 1, commandId });
    const peerAction = await observer.next(
      (frame) => frame.t === "server.action" && frame.commandId === commandId,
    );
    expect(peerAction).toMatchObject({ seq: 1, commandId });
    const relayedTargetPreviews = observer.received.filter(
      (frame) => frame.t === "server.preview" && frame.gestureId === targetGesture,
    ).length;
    expect(relayedTargetPreviews).toBeGreaterThan(0);
    expect(relayedTargetPreviews).toBeLessThan(100);
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      sockets: durableState.getWebSockets().length,
    }));
    expect(state).toEqual({ latestSeq: 1, sockets: connections.length });
    for (const connection of connections) connection.socket.close(1000, "done");
  }, 15_000);

  it("closes with resync_required instead of rejecting when a sync replay has a gap", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000110",
          "018f0000-0000-7000-8000-000000000111",
          "018f0000-0000-7000-8000-000000000112",
        ),
      ),
    );
    await connected.next((frame) => frame.t === "server.action");
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec("DELETE FROM actions WHERE seq = 1");
    });
    const closed = new Promise<CloseEvent>((resolve) => {
      connected.socket.addEventListener("close", resolve, { once: true });
    });
    connected.socket.send(JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: 0 }));
    const resync = await connected.next((frame) => frame.t === "server.resync_required");
    expect(resync).toMatchObject({ code: "REPLAY_UNAVAILABLE", latestSeq: 1 });
    expect((await closed).code).toBe(4009);
    expect(connected.received.some((frame) => frame.t === "server.rejected")).toBe(false);
  });

  it("resynchronizes a stale live sync check without replaying an already delivered action", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000320",
          "018f0000-0000-7000-8000-000000000321",
          "018f0000-0000-7000-8000-000000000322",
        ),
      ),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 1);
    const closed = new Promise<CloseEvent>((resolve) => {
      connected.socket.addEventListener("close", resolve, { once: true });
    });

    connected.socket.send(JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: 0 }));
    await connected.next((frame) => frame.t === "server.resync_required");

    expect((await closed).code).toBe(4009);
    expect(connected.received.some((frame) => frame.t === "server.replay")).toBe(false);
  });

  it("returns an accepted startup socket and closes 4009 when initial replay has a gap", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        `INSERT INTO actions(
           seq, action_id, command_id, request_hash, actor_id, kind, payload_json,
           affected_item_ids_json, undoable, accepted_at_ms
         ) VALUES (2, 'gap-action', 'gap-command', 'hash', ?, 'test', '{}', '[]', 0, ?)`,
        actorId,
        Date.now(),
      );
      durableState.storage.sql.exec(
        "UPDATE board SET latest_seq = 2, min_replay_seq = 0 WHERE singleton = 1",
      );
    });
    const socket = await openSocket(stub, actorId, 0);
    const resync = await socket.next((frame) => frame.t === "server.resync_required");
    expect(resync).toMatchObject({ code: "REPLAY_UNAVAILABLE", latestSeq: 2 });
    expect((await socket.closed).code).toBe(4009);
    expect(socket.received.map((frame) => frame.t)).toEqual([
      "server.welcome",
      "server.resync_required",
    ]);
  });

  it("closes a socket that exceeds the invalid-frame bucket", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const closed = new Promise<CloseEvent>((resolve) => {
      connected.socket.addEventListener("close", resolve, { once: true });
    });
    for (let index = 0; index < 6; index += 1) connected.socket.send("{}");
    expect((await closed).code).toBe(1008);
  });

  it("rejects and closes an unsupported protocol version immediately", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const closed = new Promise<CloseEvent>((resolve) => {
      connected.socket.addEventListener("close", resolve, { once: true });
    });

    connected.socket.send(JSON.stringify({ v: 2, t: "client.sync_check", latestSeq: 0 }));

    expect(await connected.next((frame) => frame.t === "server.rejected")).toMatchObject({
      code: "UNSUPPORTED_VERSION",
      reloadRequired: true,
    });
    expect((await closed).code).toBe(1002);
  });

  it("shares durable command capacity across an actor's sockets", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const first = await connect(stub, actorId);
    const second = await connect(stub, actorId);
    const sendCommit = (target: TestSocket, index: number) => {
      const suffix = String(100_000_000_000 + index);
      target.socket.send(
        JSON.stringify(
          createCommit(
            `018f0000-0000-7000-8000-${suffix}`,
            `018f0000-0000-7001-8000-${suffix}`,
            `018f0000-0000-7002-8000-${suffix}`,
          ),
        ),
      );
    };
    for (let index = 0; index < 10; index += 1) {
      sendCommit(index % 2 === 0 ? first : second, index);
    }
    const tenth = await first.next(
      (frame) => (frame.t === "server.action" && frame.seq === 10) || frame.t === "server.rejected",
    );
    expect(tenth).toMatchObject({ t: "server.action", seq: 10 });
    sendCommit(first, 10);
    sendCommit(second, 11);
    const rejected = await Promise.all([
      first.next((frame) => frame.t === "server.rejected"),
      second.next((frame) => frame.t === "server.rejected"),
    ]);
    expect(rejected).toEqual([
      expect.objectContaining({ code: "RATE_LIMITED", latestSeq: 10 }),
      expect.objectContaining({ code: "RATE_LIMITED", latestSeq: 10 }),
    ]);
    first.socket.close(1000, "done");
    second.socket.close(1000, "done");
  });

  it("throttles application-level sync checks", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    for (let index = 0; index < 4; index += 1) {
      connected.socket.send(JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: 0 }));
    }
    for (let index = 0; index < 3; index += 1) {
      await connected.next((frame) => frame.t === "server.in_sync");
    }
    expect(await connected.next((frame) => frame.t === "server.rejected")).toMatchObject({
      code: "RATE_LIMITED",
      latestSeq: 0,
    });
    connected.socket.close(1000, "done");
  });

  it("downgrades an existing editor socket before accepting its next commit", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const editor = await connect(stub, editorId);
    const downgrade = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/members/${editorId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer", expectedAclVersion: 2 }),
      }),
    );
    expect(downgrade.status).toBe(200);
    const changed = await editor.next((frame) => frame.t === "access.changed");
    expect(changed).toMatchObject({
      role: "viewer",
      aclVersion: 3,
      affectedActorId: editorId,
      affectedActor: { id: editorId, displayName: "Editor" },
    });

    editor.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000030",
          "018f0000-0000-7000-8000-000000000031",
          "018f0000-0000-7000-8000-000000000032",
        ),
      ),
    );
    const rejected = await editor.next((frame) => frame.t === "server.rejected");
    expect(rejected).toMatchObject({ code: "FORBIDDEN", latestSeq: 0 });
    editor.socket.close(1000, "done");
  });

  it("archives only at the current owner ACL, closes live sockets, and preserves private 404s", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec("UPDATE board SET access_mode = 'private' WHERE singleton = 1");
    });
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const archivePath = `/api/v1/boards/${boardId}/archive`;
    const archiveRequest = (actor: string, expectedAclVersion: number) =>
      internalActorRequest(actor, archivePath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedAclVersion }),
      });

    const stale = await stub.fetch(archiveRequest(actorId, 1));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "STALE_ACL", details: { currentAclVersion: 2 } },
    });

    const nonOwner = await stub.fetch(archiveRequest(editorId, 2));
    expect(nonOwner.status).toBe(403);
    expect(await nonOwner.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const archived = await stub.fetch(archiveRequest(actorId, 2));
    expect(archived.status).toBe(200);
    const result = (await archived.json()) as Record<string, unknown>;
    expect(result).toMatchObject({ archived: true, aclVersion: 3 });
    expect(result.archivedAt).toEqual(expect.any(Number));

    const [ownerClose, editorClose] = await Promise.all([owner.closed, editor.closed]);
    expect([ownerClose, editorClose]).toEqual([
      expect.objectContaining({ code: 4011, reason: "Board archived" }),
      expect.objectContaining({ code: 4011, reason: "Board archived" }),
    ]);
    const stored = await runInDurableObject(stub, (_instance, durableState) =>
      durableState.storage.sql
        .exec<{ archived_at_ms: number | null; acl_version: number }>(
          "SELECT archived_at_ms, acl_version FROM board WHERE singleton = 1",
        )
        .one(),
    );
    expect(stored).toEqual({ archived_at_ms: result.archivedAt, acl_version: 3 });

    const ownerRoutes = await Promise.all([
      stub.fetch(internalRequest(`/api/v1/boards/${boardId}/bootstrap`)),
      stub.fetch(internalRequest(`/api/v1/boards/${boardId}/export.json`)),
      stub.fetch(socketRequest(actorId)),
      stub.fetch(archiveRequest(actorId, 3)),
    ]);
    for (const response of ownerRoutes) {
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({
        error: { code: "FORBIDDEN", message: "This board is archived." },
      });
    }

    const outsiderId = `a_${"C".repeat(22)}`;
    const privateResponse = await stub.fetch(
      internalActorRequest(outsiderId, `/api/v1/boards/${boardId}/bootstrap`),
    );
    expect(privateResponse.status).toBe(404);
    expect(await privateResponse.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Board not found." },
    });
  });

  it("observes a Data Studio archive on a live socket's next inbound frame", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.transactionSync(() => {
        const now = Date.now();
        durableState.storage.sql.exec(
          `UPDATE board SET archived_at_ms = ?, acl_version = acl_version + 1,
           updated_at_ms = ? WHERE singleton = 1`,
          now,
          now,
        );
        durableState.storage.sql.exec(
          `INSERT INTO scheduled_jobs(job_name, due_at_ms, attempt, payload_json, updated_at_ms)
           VALUES ('snapshot', 0, 0, '{}', ?)`,
          now,
        );
      });
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    const alarmState = await runInDurableObject(stub, (_instance, durableState) => ({
      snapshots: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots")
        .one().count,
      scheduledJobs: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM scheduled_jobs")
        .one().count,
    }));
    expect(alarmState).toEqual({ snapshots: 0, scheduledJobs: 1 });

    connected.socket.send(JSON.stringify({ v: 1, t: "client.sync_check", latestSeq: 0 }));
    await expect(connected.closed).resolves.toMatchObject({
      code: 4011,
      reason: "Board archived",
    });
  });

  it("delivers a transferred owner's recovery token to exactly one target socket", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const firstEditorSocket = await connect(stub, editorId);
    const secondEditorSocket = await connect(stub, editorId);
    const recoveryFrames: Record<string, unknown>[] = [];
    for (const connection of [firstEditorSocket, secondEditorSocket]) {
      connection.socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.t === "server.owner_recovery") recoveryFrames.push(frame);
      });
    }

    const response = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/ownership-transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetActorId: editorId, expectedAclVersion: 2 }),
      }),
    );
    expect(response.status).toBe(200);
    const confirmation = (await response.json()) as Record<string, unknown>;
    expect(confirmation).toEqual({
      ownerActorId: editorId,
      aclVersion: 3,
      recoveryTokenDelivered: true,
    });
    expect(confirmation).not.toHaveProperty("ownerRecoveryToken");

    const accessFrames = await Promise.all([
      firstEditorSocket.next((frame) => frame.t === "access.changed"),
      secondEditorSocket.next((frame) => frame.t === "access.changed"),
    ]);
    expect(accessFrames).toEqual([
      expect.objectContaining({ role: "owner", aclVersion: 3 }),
      expect.objectContaining({ role: "owner", aclVersion: 3 }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(recoveryFrames).toHaveLength(1);
    expect(recoveryFrames[0]).toMatchObject({ aclVersion: 3 });
    expect(recoveryFrames[0]?.ownerRecoveryToken).toEqual(
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    );

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      ownerActorId: durableState.storage.sql
        .exec<{ owner_actor_id: string }>("SELECT owner_actor_id FROM board")
        .one().owner_actor_id,
      activeOwners: durableState.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM members WHERE role = 'owner' AND revoked_at_ms IS NULL",
        )
        .one().count,
    }));
    expect(state).toEqual({ ownerActorId: editorId, activeOwners: 1 });
    firstEditorSocket.socket.close(1000, "done");
    secondEditorSocket.socket.close(1000, "done");
  });

  it("rejects ownership transfer to an offline editor without changing ownership", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);

    const response = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/ownership-transfer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetActorId: editorId, expectedAclVersion: 2 }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "CONFLICT" } });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      ownerActorId: durableState.storage.sql
        .exec<{ owner_actor_id: string }>("SELECT owner_actor_id FROM board")
        .one().owner_actor_id,
      aclVersion: durableState.storage.sql
        .exec<{ acl_version: number }>("SELECT acl_version FROM board")
        .one().acl_version,
      roles: durableState.storage.sql
        .exec<{ actor_id: string; role: string }>(
          "SELECT actor_id, role FROM members ORDER BY actor_id",
        )
        .toArray(),
    }));
    expect(state).toEqual({
      ownerActorId: actorId,
      aclVersion: 2,
      roles: [
        { actor_id: actorId, role: "owner" },
        { actor_id: editorId, role: "editor" },
      ],
    });
  });

  it("rejects an invitation claim by the active owner without consuming it or changing roles", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const token = "owner-invite-token-abcdefghijklmnopqrstuvwxyz0123456789";
    const tokenHash = await sha256(token);
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.sql.exec(
        `INSERT INTO invitations(
           invitation_id, token_hash, role, max_uses, use_count,
           expires_at_ms, created_by, created_at_ms
         ) VALUES (?, ?, 'editor', 1, 0, ?, ?, ?)`,
        "invite_owner_regression",
        tokenHash,
        now + 60_000,
        actorId,
        now,
      );
    });

    const response = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "invite", token, displayName: "Owner changed" }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "CONFLICT" } });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      ownerActorId: durableState.storage.sql
        .exec<{ owner_actor_id: string }>("SELECT owner_actor_id FROM board")
        .one().owner_actor_id,
      owner: durableState.storage.sql
        .exec<{ role: string; display_name: string }>(
          "SELECT role, display_name FROM members WHERE actor_id = ?",
          actorId,
        )
        .one(),
      activeOwners: durableState.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM members WHERE role = 'owner' AND revoked_at_ms IS NULL",
        )
        .one().count,
      invitationUses: durableState.storage.sql
        .exec<{ use_count: number }>(
          "SELECT use_count FROM invitations WHERE invitation_id = 'invite_owner_regression'",
        )
        .one().use_count,
      aclVersion: durableState.storage.sql
        .exec<{ acl_version: number }>("SELECT acl_version FROM board")
        .one().acl_version,
    }));
    expect(state).toEqual({
      ownerActorId: actorId,
      owner: { role: "owner", display_name: "Owner 1" },
      activeOwners: 1,
      invitationUses: 0,
      aclVersion: 1,
    });
  });

  it("creates a co-owner invitation without changing primary ownership", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);

    const invitationResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/invitations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "co-owner-invitation-create-0001",
        },
        body: JSON.stringify({
          role: "owner",
          label: "Co-coach",
          maxUses: 1,
          expiresAtMs: Date.now() + 60_000,
        }),
      }),
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as {
      invitation: { role: string };
      token: string;
    };
    expect(invitation.invitation.role).toBe("owner");

    const claim = await stub.fetch(
      internalActorRequest(coOwnerId, `/api/v1/boards/${boardId}/claims`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "invite",
          token: invitation.token,
          displayName: "Co-coach",
        }),
      }),
    );
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({
      actor: { id: coOwnerId, role: "owner", displayName: "Co-coach" },
      aclVersion: 2,
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      primaryOwner: durableState.storage.sql
        .exec<{ owner_actor_id: string }>("SELECT owner_actor_id FROM board")
        .one().owner_actor_id,
      roles: durableState.storage.sql
        .exec<{ actor_id: string; role: string }>(
          "SELECT actor_id, role FROM members ORDER BY actor_id",
        )
        .toArray(),
    }));
    expect(state).toEqual({
      primaryOwner: actorId,
      roles: [
        { actor_id: actorId, role: "owner" },
        { actor_id: coOwnerId, role: "owner" },
      ],
    });
  });

  it("promotes same-sequence automatic metadata to a named snapshot without rewriting R2", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const create = (label: string, idempotencyKey: string) =>
      stub.fetch(
        internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ label }),
        }),
      );
    expect((await create("Initial label", "named-snapshot-initial-0001")).status).toBe(201);
    const key = await runInDurableObject(stub, (_instance, durableState) => {
      const row = durableState.storage.sql
        .exec<{ r2_json_key: string }>("SELECT r2_json_key FROM snapshots WHERE seq = 0")
        .one();
      durableState.storage.sql.exec(
        "UPDATE snapshots SET kind = 'automatic', label = NULL, created_by = NULL WHERE seq = 0",
      );
      return row.r2_json_key;
    });
    const before = await typedEnv.BOARD_SNAPSHOTS.head(key);
    if (before === null) throw new Error("Expected the immutable snapshot object.");

    const promoted = await create("Promoted label", "named-snapshot-promote-0002");
    expect(promoted.status).toBe(201);
    expect(await promoted.json()).toMatchObject({
      snapshot: { seq: 0, kind: "named", label: "Promoted label" },
    });
    const metadata = await runInDurableObject(stub, (_instance, durableState) => ({
      row: durableState.storage.sql
        .exec<{ kind: string; label: string; created_by: string }>(
          "SELECT kind, label, created_by FROM snapshots WHERE seq = 0",
        )
        .one(),
      count: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshots")
        .one().count,
    }));
    expect(metadata).toEqual({
      row: { kind: "named", label: "Promoted label", created_by: actorId },
      count: 1,
    });
    const after = await typedEnv.BOARD_SNAPSHOTS.head(key);
    expect(after?.version).toBe(before.version);
  });

  it("recomputes exact accounting for a restored snapshot's new item versions", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000502";
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000500",
          "018f0000-0000-7000-8000-000000000501",
          itemId,
        ),
      ),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 1);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE board SET snapshot_live_item_count = 0,
          snapshot_live_item_bytes = 0 WHERE singleton = 1`,
      );
    });

    const named = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "restore-accounting-named-0001",
        },
        body: JSON.stringify({ label: "Before edit" }),
      }),
    );
    expect(named.status).toBe(201);
    await named.arrayBuffer();
    const reconciled = await runInDurableObject(stub, (_instance, state) =>
      readSnapshotAccounting(state.storage.sql),
    );
    expect(reconciled.stored).toEqual(reconciled.actual);

    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000510",
        actionId: "018f0000-0000-7000-8000-000000000511",
        baseSeq: 1,
        op: {
          kind: "item.update",
          itemId,
          expectedVersion: 1,
          patch: { geometry: { x: 1, y: 2, width: 300, height: 400 } },
        },
      }),
    );
    await connected.next((frame) => frame.t === "server.action" && frame.seq === 2);

    const restored = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/restore/1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "restore-accounting-apply-0002",
        },
        body: JSON.stringify({ expectedBoardSeq: 2 }),
      }),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ restoredFromSeq: 1, seq: 3 });
    const accounting = await runInDurableObject(stub, (_instance, state) =>
      readSnapshotAccounting(state.storage.sql),
    );
    expect(accounting.stored).toEqual(accounting.actual);
    expect(accounting.actual.itemCount).toBe(1);
    expect(accounting.decomposedBytes).toBe(accounting.serializedBytes);
    connected.socket.close(1000, "done");
  });

  it("prunes expired receipts and automatic snapshots beyond the latest twenty", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const now = Date.now();
    const objects = Array.from({ length: 22 }, (_, index) => ({
      seq: index + 1,
      key: `tests/retention/${index + 1}.json`,
    }));
    await Promise.all(objects.map(({ key }) => typedEnv.BOARD_SNAPSHOTS.put(key, "{}")));
    await runInDurableObject(stub, async (_instance, durableState) => {
      for (const { seq, key } of objects) {
        durableState.storage.sql.exec(
          `INSERT INTO snapshots(
             seq, r2_json_key, sha256, item_count, byte_count, kind, created_at_ms
           ) VALUES (?, ?, 'digest', 0, 2, 'automatic', ?)`,
          seq,
          key,
          now,
        );
        durableState.storage.sql.exec(
          "INSERT INTO snapshot_attribution(seq, data_json) VALUES (?, '[]')",
          seq,
        );
      }
      durableState.storage.sql.exec(
        `INSERT INTO http_receipts(
           actor_id, idempotency_key, operation, request_hash, response_json, status, created_at_ms
         ) VALUES (?, 'expired-receipt-key', 'test', 'hash', '{}', 200, ?)`,
        actorId,
        now - 24 * 60 * 60 * 1_000 - 1,
      );
      durableState.storage.sql.exec(
        "UPDATE board SET latest_seq = 22, latest_snapshot_seq = 22 WHERE singleton = 1",
      );
      durableState.storage.sql.exec(
        `INSERT INTO scheduled_jobs(job_name, due_at_ms, attempt, payload_json, updated_at_ms)
         VALUES ('snapshot', ?, 0, '{}', ?)`,
        now - 1,
        now,
      );
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });
    const retained = await runInDurableObject(stub, (_instance, durableState) => ({
      snapshots: durableState.storage.sql
        .exec<{ seq: number }>("SELECT seq FROM snapshots ORDER BY seq")
        .toArray()
        .map((row) => row.seq),
      attributionSidecars: durableState.storage.sql
        .exec<{ seq: number }>("SELECT seq FROM snapshot_attribution ORDER BY seq")
        .toArray()
        .map((row) => row.seq),
      receipts: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM http_receipts")
        .one().count,
    }));
    expect(retained.snapshots).toEqual(Array.from({ length: 20 }, (_, index) => index + 3));
    expect(retained.attributionSidecars).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 3),
    );
    expect(retained.receipts).toBe(0);
    expect(await typedEnv.BOARD_SNAPSHOTS.head(objects[0]?.key ?? "missing")).toBeNull();
    expect(await typedEnv.BOARD_SNAPSHOTS.head(objects[2]?.key ?? "missing")).not.toBeNull();
  });

  it("compacts a snapshot-covered prefix while preserving replay, history, and retry receipts", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const now = Date.now();
    const expiredAt = now - 24 * 60 * 60 * 1_000 - 1;
    const snapshotKey = "tests/compaction/25000.json";
    await typedEnv.BOARD_SNAPSHOTS.put(snapshotKey, "{}", {
      customMetadata: { sha256: "compaction-digest" },
    });
    const retryCommandId = "018f0000-0000-7000-8000-000000000220";
    const retryActionId = "018f0000-0000-7000-8000-000000000221";
    const retryPayload = JSON.stringify({
      publicResult: {
        v: 1,
        t: "server.action",
        seq: 5_000,
        acceptedAt: now,
        actor: { id: actorId, displayName: "Owner 1" },
        commandId: retryCommandId,
        actionId: retryActionId,
        op: { kind: "board.clear", removed: [] },
      },
      effects: [{ privateDataThatReceiptsMustDrop: true }],
    });

    await runInDurableObject(stub, (_instance, durableState) => {
      const sql = durableState.storage.sql;
      seedActionRows(sql, 25_000, expiredAt);
      sql.exec(
        `INSERT INTO history_entries(
           normal_action_seq, actor_id, state, last_transition_seq, action_id, payload_json
         )
         SELECT seq, actor_id, 'active', seq, action_id, payload_json
         FROM actions WHERE seq <= 1001`,
      );
      sql.exec(
        `INSERT INTO history_entries(
           normal_action_seq, actor_id, state, last_transition_seq, action_id, payload_json
         )
         SELECT seq, actor_id, 'invalidated', seq, action_id, payload_json
         FROM actions WHERE seq = 1002`,
      );
      sql.exec(
        `UPDATE actions SET command_id = ?, action_id = ?, request_hash = 'retry-hash',
          payload_json = ?, accepted_at_ms = ? WHERE seq = 5000`,
        retryCommandId,
        retryActionId,
        retryPayload,
        now,
      );
      sql.exec(
        `INSERT INTO snapshots(
           seq, r2_json_key, sha256, item_count, byte_count, kind, created_at_ms
         ) VALUES (25000, ?, 'compaction-digest', 0, 2, 'automatic', ?)`,
        snapshotKey,
        now,
      );
      sql.exec(
        `UPDATE board SET latest_seq = 25000, latest_snapshot_seq = 25000,
          dirty_since_seq = 1, dirty_since_at_ms = ? WHERE singleton = 1`,
        now,
      );
      sql.exec(
        `INSERT INTO scheduled_jobs(job_name, due_at_ms, attempt, payload_json, updated_at_ms)
         VALUES ('snapshot', ?, 0, '{}', ?)`,
        now - 1,
        now,
      );
    });

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
    });

    const state = await runInDurableObject(stub, (instance, durableState) => {
      const sql = durableState.storage.sql;
      const duplicate = (
        instance as unknown as {
          findDuplicateAction(commandId: string, actor: string, hash: string): unknown;
        }
      ).findDuplicateAction(retryCommandId, actorId, "retry-hash");
      return {
        actionCount: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions").one()
          .count,
        firstAction: sql.exec<{ seq: number }>("SELECT MIN(seq) AS seq FROM actions").one().seq,
        minReplaySeq: sql.exec<{ min_replay_seq: number }>("SELECT min_replay_seq FROM board").one()
          .min_replay_seq,
        activeHistory: sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM history_entries WHERE state = 'active'",
          )
          .one().count,
        invalidatedHistory: sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM history_entries WHERE state = 'invalidated'",
          )
          .one().count,
        receipt: sql
          .exec<{ payload_json: string }>(
            "SELECT payload_json FROM action_receipts WHERE command_id = ?",
            retryCommandId,
          )
          .one().payload_json,
        duplicate,
      };
    });
    expect(state).toMatchObject({
      actionCount: 19_000,
      firstAction: 6_001,
      minReplaySeq: 6_000,
      activeHistory: 1_001,
      invalidatedHistory: 0,
      duplicate: { seq: 5_000, commandId: retryCommandId, actionId: retryActionId },
    });
    expect(JSON.parse(state.receipt)).toMatchObject({ effects: [] });
  });

  it("continues through the compaction trigger during R2 outage, then enforces an emergency cap", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    await runInDurableObject(stub, (_instance, durableState) => {
      seedActionRows(durableState.storage.sql, 20_000, Date.now());
      durableState.storage.sql.exec(
        "UPDATE board SET latest_seq = 20000, latest_snapshot_seq = 20000 WHERE singleton = 1",
      );
    });
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000210",
          "018f0000-0000-7000-8000-000000000211",
          "018f0000-0000-7000-8000-000000000212",
        ),
      ),
    );
    const accepted = await connected.next((frame) => frame.t === "server.action");
    expect(accepted).toMatchObject({ seq: 20_001 });
    const degraded = await runInDurableObject(stub, (_instance, durableState) => {
      const sql = durableState.storage.sql;
      return {
        actions: sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions").one().count,
        snapshotJob: sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM scheduled_jobs WHERE job_name = 'snapshot'",
          )
          .one().count,
      };
    });
    expect(degraded).toEqual({ actions: 20_001, snapshotJob: 1 });

    await runInDurableObject(stub, (_instance, durableState) => {
      seedActionRows(durableState.storage.sql, 79_999, Date.now(), 20_002);
      durableState.storage.sql.exec("UPDATE board SET latest_seq = 100000 WHERE singleton = 1");
    });
    connected.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000214",
          "018f0000-0000-7000-8000-000000000215",
          "018f0000-0000-7000-8000-000000000216",
        ),
      ),
    );
    const rejected = await connected.next((frame) => frame.t === "server.rejected");
    expect(rejected).toMatchObject({ code: "BOARD_LIMIT_REACHED", latestSeq: 100_000 });
    connected.socket.close(1000, "done");
  });

  it.each(["sqlite", "object"] as const)(
    "rejects a snapshot restore when the %s digest does not match, before board writes",
    async (mismatch) => {
      const typedEnv = env as unknown as Env;
      const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
      await initializeBoard(stub);
      const snapshotBytes = new TextEncoder().encode(
        JSON.stringify({
          format: "cf-whiteboard-json",
          version: 1,
          boardId,
          seq: 0,
          createdAt: Date.now(),
          settings: { title: "Test board" },
          items: [],
        }),
      );
      const digest = await sha256Base64Url(snapshotBytes);
      const wrongDigest = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      const key = `tests/${mismatch}/snapshot.json`;
      await typedEnv.BOARD_SNAPSHOTS.put(key, snapshotBytes, {
        customMetadata: { sha256: mismatch === "object" ? wrongDigest : digest },
      });
      await runInDurableObject(stub, (_instance, durableState) => {
        durableState.storage.sql.exec(
          `INSERT INTO snapshots(
             seq, r2_json_key, sha256, item_count, byte_count, kind, label,
             created_by, created_at_ms
           ) VALUES (0, ?, ?, 0, ?, 'named', 'Integrity test', ?, ?)`,
          key,
          mismatch === "sqlite" ? wrongDigest : digest,
          snapshotBytes.byteLength,
          actorId,
          Date.now(),
        );
      });

      const response = await stub.fetch(
        internalRequest(`/api/v1/boards/${boardId}/restore/0`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `snapshot-integrity-${mismatch}`,
          },
          body: JSON.stringify({ expectedBoardSeq: 0 }),
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "TEMPORARILY_UNAVAILABLE" },
      });

      const state = await runInDurableObject(stub, (_instance, durableState) => ({
        latestSeq: durableState.storage.sql
          .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
          .one().latest_seq,
        actions: durableState.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
          .one().count,
        receipts: durableState.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM http_receipts")
          .one().count,
      }));
      expect(state).toEqual({ latestSeq: 0, actions: 0, receipts: 0 });
    },
  );
});

describe("BoardRoom table collaboration", () => {
  afterEach(async () => reset());

  it("attributes and durably replays tables while enforcing admission and classroom controls", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.transactionSync(() => {
        durableState.storage.sql.exec(
          `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
           VALUES (?, 'viewer', 'Viewer', ?, ?)`,
          studentId,
          now,
          now,
        );
        durableState.storage.sql.exec("UPDATE board SET acl_version = 3");
      });
    });

    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const viewer = await connect(stub, studentId);

    const malformed = createTableCommit(
      "018f0000-0000-7000-8000-000000000920",
      "018f0000-0000-7000-8000-000000000921",
      "018f0000-0000-7000-8000-000000000922",
    );
    malformed.op.item.geometry.cells[1] = ["ragged"];
    owner.socket.send(JSON.stringify(malformed));
    expect(
      await owner.next((frame) => frame.t === "server.rejected" && frame.code === "INVALID_FRAME"),
    ).toMatchObject({ code: "INVALID_FRAME", latestSeq: 0 });
    const afterMalformed = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      items: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM items")
        .one().count,
    }));
    expect(afterMalformed).toEqual({ latestSeq: 0, actions: 0, items: 0 });

    const ownerCreate = createTableCommit(
      "018f0000-0000-7000-8000-000000000923",
      "018f0000-0000-7000-8000-000000000924",
      "018f0000-0000-7000-8000-000000000925",
    );
    owner.socket.send(JSON.stringify(ownerCreate));
    expect(
      await owner.next(
        (frame) => frame.t === "server.action" && frame.commandId === ownerCreate.commandId,
      ),
    ).toMatchObject({
      seq: 1,
      actor: { id: actorId, displayName: "Owner 1" },
      op: {
        kind: "item.create",
        item: { ...ownerCreate.op.item, z: 1, version: 1, createdBy: actorId },
      },
    });

    const editorCreate = createTableCommit(
      "018f0000-0000-7000-8000-000000000926",
      "018f0000-0000-7000-8000-000000000927",
      "018f0000-0000-7000-8000-000000000928",
      "Editor observation",
    );
    editorCreate.baseSeq = 1;
    editorCreate.op.item.geometry.x = 410;
    editor.socket.send(JSON.stringify(editorCreate));
    expect(
      await editor.next(
        (frame) => frame.t === "server.action" && frame.commandId === editorCreate.commandId,
      ),
    ).toMatchObject({
      seq: 2,
      actor: { id: editorId, displayName: "Editor" },
      op: {
        kind: "item.create",
        item: { ...editorCreate.op.item, z: 2, version: 2, createdBy: editorId },
      },
    });

    const viewerCreate = createTableCommit(
      "018f0000-0000-7000-8000-000000000929",
      "018f0000-0000-7000-8000-00000000092a",
      "018f0000-0000-7000-8000-00000000092b",
    );
    viewerCreate.baseSeq = 2;
    viewer.socket.send(JSON.stringify(viewerCreate));
    expect(
      await viewer.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === viewerCreate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 2 });

    const activity = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/activity?afterSeq=0&limit=10`),
    );
    expect(activity.status).toBe(200);
    expect(await activity.json()).toMatchObject({
      events: [
        {
          seq: 1,
          actor: { id: actorId, displayName: "Owner 1" },
          kind: "item.create",
          itemIds: [ownerCreate.op.item.id],
        },
        {
          seq: 2,
          actor: { id: editorId, displayName: "Editor" },
          kind: "item.create",
          itemIds: [editorCreate.op.item.id],
        },
      ],
    });

    const named = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "table-durability-snapshot-0001",
        },
        body: JSON.stringify({ label: "Classroom tables" }),
      }),
    );
    expect(named.status).toBe(201);
    expect(await named.json()).toMatchObject({
      snapshot: { seq: 2, kind: "named", label: "Classroom tables", itemCount: 2 },
    });
    const snapshotKey = await runInDurableObject(
      stub,
      (_instance, durableState) =>
        durableState.storage.sql
          .exec<{ r2_json_key: string }>("SELECT r2_json_key FROM snapshots WHERE seq = 2")
          .one().r2_json_key,
    );

    const lock = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drawingPolicy: "locked", expectedAclVersion: 3 }),
      }),
    );
    expect(lock.status).toBe(200);
    await editor.next((frame) => frame.t === "access.changed" && frame.drawingPolicy === "locked");

    const lockedEditorCreate = createTableCommit(
      "018f0000-0000-7000-8000-00000000092c",
      "018f0000-0000-7000-8000-00000000092d",
      "018f0000-0000-7000-8000-00000000092e",
    );
    lockedEditorCreate.baseSeq = 2;
    editor.socket.send(JSON.stringify(lockedEditorCreate));
    expect(
      await editor.next(
        (frame) =>
          frame.t === "server.rejected" && frame.commandId === lockedEditorCreate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 2 });

    owner.socket.close(1000, "reconnect");
    editor.socket.close(1000, "reconnect");
    viewer.socket.close(1000, "reconnect");
    const snapshotObject = await typedEnv.BOARD_SNAPSHOTS.get(snapshotKey);
    if (snapshotObject === null) throw new Error("Expected the named table snapshot in R2.");
    const storedSnapshot = JSON.parse(await snapshotObject.text()) as {
      seq: number;
      items: unknown[];
    };
    expect(storedSnapshot).toMatchObject({
      seq: 2,
      items: [
        { kind: "table", createdBy: actorId, geometry: ownerCreate.op.item.geometry },
        { kind: "table", createdBy: editorId, geometry: editorCreate.op.item.geometry },
      ],
    });
    const replayed = await connect(stub, actorId, 0);
    const replay = await replayed.next((frame) => frame.t === "server.replay");
    expect(replay).toMatchObject({
      fromExclusive: 0,
      toInclusive: 2,
      actions: [
        { seq: 1, actor: { id: actorId }, op: { item: { kind: "table" } } },
        { seq: 2, actor: { id: editorId }, op: { item: { kind: "table" } } },
      ],
    });

    const exportedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.json`),
    );
    expect(exportedResponse.status).toBe(200);
    expect(exportedResponse.headers.get("X-Whiteboard-Seq")).toBe("2");
    const exported = (await exportedResponse.json()) as { seq: number; items: unknown[] };
    expect(exported).toMatchObject({
      seq: 2,
      items: [
        { kind: "table", createdBy: actorId, geometry: ownerCreate.op.item.geometry },
        { kind: "table", createdBy: editorId, geometry: editorCreate.op.item.geometry },
      ],
    });

    const svgResponse = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/export.svg`));
    expect(svgResponse.status).toBe(200);
    expect(svgResponse.headers.get("X-Whiteboard-Seq")).toBe("2");
    const svg = await svgResponse.text();
    expect(svg).toContain("Know &lt;this&gt;");
    expect(svg).toContain("Editor observation");
    expect(svg).not.toContain("Know <this>");

    const finalState = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      liveTables: durableState.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM items WHERE deleted = 0 AND kind = 'table'",
        )
        .one().count,
    }));
    expect(finalState).toEqual({ latestSeq: 2, actions: 2, liveTables: 2 });

    replayed.socket.close(1000, "done");
  }, 45_000);
});

describe("BoardRoom move/copy closure admission", () => {
  afterEach(async () => reset());

  const topologyId = (index: number): string =>
    `018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;

  const importedSection = (id: string, z: number) => ({
    id,
    kind: "zone",
    z,
    version: 0,
    createdBy: actorId,
    style: {
      kind: "zone",
      borderColor: "#60a5fa",
      fill: "#eff6ff",
      textColor: "#1e3a8a",
      fontSize: 20,
      opacity: 0.8,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 20, y: 30, width: 600, height: 400, title: "Bounded Section" },
  });

  const importedRectangle = (
    id: string,
    z: number,
    relationships: { groupId?: string; sectionId?: string } = {},
  ) => ({
    id,
    ...relationships,
    kind: "rectangle",
    z,
    version: 0,
    createdBy: actorId,
    style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 1, y: 2, width: 3, height: 4 },
  });

  const encodeImport = (items: readonly unknown[]): string =>
    bytesToBase64Url(
      utf8(
        JSON.stringify({
          format: "cf-whiteboard-json",
          version: 1,
          boardId,
          seq: 0,
          createdAt: Date.now(),
          settings: { title: "Closure admission" },
          items,
        }),
      ),
    );

  it("atomically rejects a live item with a missing Section target", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const connected = await connect(stub, actorId);
    const itemId = topologyId(950);
    const sectionId = topologyId(951);
    const commandId = topologyId(952);
    connected.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId,
        actionId: topologyId(953),
        baseSeq: 0,
        op: {
          kind: "item.create",
          item: {
            id: itemId,
            sectionId,
            kind: "rectangle",
            style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: { x: 1, y: 2, width: 3, height: 4 },
          },
        },
      }),
    );
    expect(
      await connected.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === commandId,
      ),
    ).toMatchObject({ code: "INVALID_FRAME", latestSeq: 0, sectionId, itemId });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      liveItems: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM items WHERE deleted = 0")
        .one().count,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
    }));
    expect(state).toEqual({ latestSeq: 0, liveItems: 0, actions: 0 });
    connected.socket.close(1000, "done");
  });

  it("rejects a Section relationship whose member lies outside the Section", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const sectionId = topologyId(960);
    const createSection = {
      v: 1,
      t: "client.commit",
      commandId: topologyId(961),
      actionId: topologyId(962),
      baseSeq: 0,
      op: {
        kind: "item.create",
        item: {
          id: sectionId,
          kind: "zone",
          style: {
            kind: "zone",
            borderColor: "#60a5fa",
            fill: "#eff6ff",
            textColor: "#1e3a8a",
            fontSize: 20,
            opacity: 0.8,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 20, y: 30, width: 600, height: 400, title: "Bounded" },
        },
      },
    };
    owner.socket.send(JSON.stringify(createSection));
    await owner.next(
      (frame) => frame.t === "server.action" && frame.commandId === createSection.commandId,
    );
    await editor.next(
      (frame) => frame.t === "server.action" && frame.commandId === createSection.commandId,
    );

    const memberCommit = (index: number, x: number) => ({
      v: 1,
      t: "client.commit",
      commandId: topologyId(index + 1),
      actionId: topologyId(index + 2),
      baseSeq: 1,
      op: {
        kind: "item.create",
        item: {
          id: topologyId(index),
          sectionId,
          kind: "rectangle",
          style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x, y: 50, width: 120, height: 80 },
        },
      },
    });

    const outside = memberCommit(963, 900);
    editor.socket.send(JSON.stringify(outside));
    expect(
      await editor.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === outside.commandId,
      ),
    ).toMatchObject({ code: "INVALID_FRAME", latestSeq: 1, sectionId, itemId: topologyId(963) });

    const inside = memberCommit(966, 40);
    editor.socket.send(JSON.stringify(inside));
    expect(
      await editor.next(
        (frame) => frame.t === "server.action" && frame.commandId === inside.commandId,
      ),
    ).toMatchObject({ seq: 2 });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      liveItems: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM items WHERE deleted = 0")
        .one().count,
    }));
    expect(state).toEqual({ latestSeq: 2, liveItems: 2 });
    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  });

  it("re-checks group ownership when history replays a grouping", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const secondEditorId = `a_${"E".repeat(21)}A`;
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.sql.exec(
        `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
         VALUES (?, 'editor', 'Second editor', ?, ?)`,
        secondEditorId,
        now,
        now,
      );
    });
    const first = await connect(stub, editorId);
    const second = await connect(stub, secondEditorId);
    const groupId = topologyId(990);
    const rectangle = (index: number, x: number, withGroup: boolean) => ({
      id: topologyId(index),
      ...(withGroup ? { groupId } : {}),
      kind: "rectangle",
      style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x, y: 50, width: 120, height: 80 },
    });
    const send = async (
      socket: Awaited<ReturnType<typeof connect>>,
      index: number,
      baseSeq: number,
      op: unknown,
    ) => {
      const frame = {
        v: 1,
        t: "client.commit",
        commandId: topologyId(index),
        actionId: topologyId(index + 1),
        baseSeq,
        op,
      };
      socket.socket.send(JSON.stringify(frame));
      return frame;
    };

    const created = await send(first, 991, 0, {
      kind: "items.batch",
      operations: [
        { kind: "item.create", item: rectangle(993, 40, false) },
        { kind: "item.create", item: rectangle(994, 200, false) },
      ],
    });
    await first.next(
      (frame) => frame.t === "server.action" && frame.commandId === created.commandId,
    );
    const grouped = await send(first, 995, 1, {
      kind: "items.batch",
      operations: [
        { kind: "item.update", itemId: topologyId(993), expectedVersion: 1, patch: { groupId } },
        { kind: "item.update", itemId: topologyId(994), expectedVersion: 1, patch: { groupId } },
      ],
    });
    await first.next(
      (frame) => frame.t === "server.action" && frame.commandId === grouped.commandId,
    );
    const undone = await send(first, 997, 2, {
      kind: "history.undo",
      expectedHistoryVersion: 2,
      targetActionId: grouped.actionId,
    });
    await first.next(
      (frame) => frame.t === "server.action" && frame.commandId === undone.commandId,
    );
    await second.next(
      (frame) => frame.t === "server.action" && frame.commandId === undone.commandId,
    );

    // The group is empty again, so the second editor may reuse its id.
    const reused = await send(second, 1001, 3, {
      kind: "item.create",
      item: rectangle(1003, 400, true),
    });
    await second.next(
      (frame) => frame.t === "server.action" && frame.commandId === reused.commandId,
    );
    await first.next(
      (frame) => frame.t === "server.action" && frame.commandId === reused.commandId,
    );

    // Redoing the grouping would now bind the first editor's items to a group
    // holding another participant's item, which a fresh commit also rejects.
    const redone = await send(first, 1005, 4, {
      kind: "history.redo",
      expectedHistoryVersion: 3,
      targetActionId: grouped.actionId,
    });
    expect(
      await first.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === redone.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 4, groupId });
    first.socket.close(1000, "done");
    second.socket.close(1000, "done");
  });

  it("rejects an editor joining a group made of another actor's items", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const groupId = topologyId(970);
    const rectangle = (index: number, x: number, withGroup: boolean) => ({
      id: topologyId(index),
      ...(withGroup ? { groupId } : {}),
      kind: "rectangle",
      style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x, y: 50, width: 120, height: 80 },
    });
    const ownerGroup = {
      v: 1,
      t: "client.commit",
      commandId: topologyId(971),
      actionId: topologyId(972),
      baseSeq: 0,
      op: {
        kind: "items.batch",
        operations: [
          { kind: "item.create", item: rectangle(973, 40, true) },
          { kind: "item.create", item: rectangle(974, 200, true) },
        ],
      },
    };
    owner.socket.send(JSON.stringify(ownerGroup));
    await owner.next(
      (frame) => frame.t === "server.action" && frame.commandId === ownerGroup.commandId,
    );
    await editor.next(
      (frame) => frame.t === "server.action" && frame.commandId === ownerGroup.commandId,
    );

    const joinForeignGroup = {
      v: 1,
      t: "client.commit",
      commandId: topologyId(975),
      actionId: topologyId(976),
      baseSeq: 1,
      op: { kind: "item.create", item: rectangle(977, 400, true) },
    };
    editor.socket.send(JSON.stringify(joinForeignGroup));
    expect(
      await editor.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === joinForeignGroup.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1, groupId, itemId: topologyId(977) });

    const ownGroup = {
      v: 1,
      t: "client.commit",
      commandId: topologyId(978),
      actionId: topologyId(979),
      baseSeq: 1,
      op: {
        kind: "items.batch",
        operations: [
          {
            kind: "item.create",
            item: { ...rectangle(980, 400, false), groupId: topologyId(981) },
          },
          {
            kind: "item.create",
            item: { ...rectangle(982, 560, false), groupId: topologyId(981) },
          },
        ],
      },
    };
    editor.socket.send(JSON.stringify(ownGroup));
    expect(
      await editor.next(
        (frame) => frame.t === "server.action" && frame.commandId === ownGroup.commandId,
      ),
    ).toMatchObject({ seq: 2 });
    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  });

  it("detaches later members when history removes their Section and restores them on redo", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const sectionId = topologyId(910);
    const memberId = topologyId(911);
    const createSection = {
      v: 1,
      t: "client.commit",
      commandId: topologyId(912),
      actionId: topologyId(913),
      baseSeq: 0,
      op: {
        kind: "item.create",
        item: {
          id: sectionId,
          kind: "zone",
          style: {
            kind: "zone",
            borderColor: "#60a5fa",
            fill: "#eff6ff",
            textColor: "#1e3a8a",
            fontSize: 20,
            opacity: 0.8,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 20, y: 30, width: 600, height: 400, title: "History" },
        },
      },
    };
    owner.socket.send(JSON.stringify(createSection));
    await owner.next(
      (frame) => frame.t === "server.action" && frame.commandId === createSection.commandId,
    );
    await editor.next(
      (frame) => frame.t === "server.action" && frame.commandId === createSection.commandId,
    );

    const createMember = {
      v: 1,
      t: "client.commit",
      commandId: topologyId(914),
      actionId: topologyId(915),
      baseSeq: 1,
      op: {
        kind: "item.create",
        item: {
          id: memberId,
          sectionId,
          kind: "rectangle",
          style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 40, y: 50, width: 120, height: 80 },
        },
      },
    };
    editor.socket.send(JSON.stringify(createMember));
    await editor.next(
      (frame) => frame.t === "server.action" && frame.commandId === createMember.commandId,
    );
    await owner.next(
      (frame) => frame.t === "server.action" && frame.commandId === createMember.commandId,
    );

    const undo = {
      v: 1,
      t: "client.commit",
      commandId: topologyId(916),
      actionId: topologyId(917),
      baseSeq: 2,
      op: {
        kind: "history.undo",
        expectedHistoryVersion: 1,
        targetActionId: createSection.actionId,
      },
    };
    owner.socket.send(JSON.stringify(undo));
    expect(
      await owner.next(
        (frame) => frame.t === "server.action" && frame.commandId === undo.commandId,
      ),
    ).toMatchObject({
      seq: 3,
      op: {
        changes: expect.arrayContaining([
          { kind: "item.remove", itemId: sectionId, version: 3 },
          { kind: "item.replace", item: expect.objectContaining({ id: memberId, version: 3 }) },
        ]),
      },
    });

    const detachedState = await runInDurableObject(stub, (_instance, durableState) => {
      const item = durableState.storage.sql
        .exec<{ data_json: string }>("SELECT data_json FROM items WHERE item_id = ?", memberId)
        .one();
      const attribution = durableState.storage.sql
        .exec<{ data_json: string }>(
          "SELECT data_json FROM item_attribution WHERE item_id = ?",
          memberId,
        )
        .one();
      return {
        item: JSON.parse(item.data_json) as Record<string, unknown>,
        attribution: JSON.parse(attribution.data_json) as Record<string, unknown>,
      };
    });
    expect(detachedState.item).not.toHaveProperty("sectionId");
    expect(detachedState.attribution).toMatchObject({ lastModifiedBy: actorId, updatedSeq: 3 });

    const redo = {
      ...undo,
      commandId: topologyId(918),
      actionId: topologyId(919),
      baseSeq: 3,
      op: {
        kind: "history.redo",
        expectedHistoryVersion: 2,
        targetActionId: createSection.actionId,
      },
    };
    owner.socket.send(JSON.stringify(redo));
    expect(
      await owner.next(
        (frame) => frame.t === "server.action" && frame.commandId === redo.commandId,
      ),
    ).toMatchObject({
      seq: 4,
      op: {
        changes: expect.arrayContaining([
          { kind: "item.replace", item: expect.objectContaining({ id: sectionId, version: 4 }) },
          {
            kind: "item.replace",
            item: expect.objectContaining({ id: memberId, sectionId, version: 4 }),
          },
        ]),
      },
    });

    const restoredAttribution = await runInDurableObject(stub, (_instance, durableState) => {
      const row = durableState.storage.sql
        .exec<{ data_json: string }>(
          "SELECT data_json FROM item_attribution WHERE item_id = ?",
          memberId,
        )
        .one();
      return JSON.parse(row.data_json) as Record<string, unknown>;
    });
    expect(restoredAttribution).toMatchObject({ lastModifiedBy: actorId, updatedSeq: 4 });

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  });

  it("lets a Section creator's history cleanup detach another participant's item", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const sectionId = topologyId(920);
    const memberId = topologyId(921);
    const sectionTemplate = createSectionMemberCommit(
      topologyId(922),
      topologyId(923),
      sectionId,
      memberId,
    );
    const createSection = {
      ...sectionTemplate,
      op: sectionTemplate.op.operations[0],
    };
    editor.socket.send(JSON.stringify(createSection));
    await editor.next(
      (frame) => frame.t === "server.action" && frame.commandId === createSection.commandId,
    );
    await owner.next(
      (frame) => frame.t === "server.action" && frame.commandId === createSection.commandId,
    );

    const memberTemplate = createSectionMemberCommit(
      topologyId(924),
      topologyId(925),
      sectionId,
      memberId,
    );
    const createMember = {
      ...memberTemplate,
      baseSeq: 1,
      op: memberTemplate.op.operations[1],
    };
    owner.socket.send(JSON.stringify(createMember));
    await owner.next(
      (frame) => frame.t === "server.action" && frame.commandId === createMember.commandId,
    );
    await editor.next(
      (frame) => frame.t === "server.action" && frame.commandId === createMember.commandId,
    );

    const undo = {
      v: 1,
      t: "client.commit",
      commandId: topologyId(926),
      actionId: topologyId(927),
      baseSeq: 2,
      op: {
        kind: "history.undo",
        expectedHistoryVersion: 1,
        targetActionId: createSection.actionId,
      },
    };
    editor.socket.send(JSON.stringify(undo));
    // Membership was assigned by geometry when the owner drew inside the
    // editor's Section, so removing it is the editor's right; the member is
    // otherwise untouched.
    expect(
      await editor.next(
        (frame) => frame.t === "server.action" && frame.commandId === undo.commandId,
      ),
    ).toMatchObject({
      seq: 3,
      op: {
        changes: [
          { kind: "item.remove", itemId: sectionId },
          { kind: "item.replace", item: { id: memberId, createdBy: actorId } },
        ],
      },
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => {
      const section = durableState.storage.sql
        .exec<{ deleted: number }>("SELECT deleted FROM items WHERE item_id = ?", sectionId)
        .one();
      const member = durableState.storage.sql
        .exec<{ data_json: string }>("SELECT data_json FROM items WHERE item_id = ?", memberId)
        .one();
      return {
        latestSeq: durableState.storage.sql
          .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
          .one().latest_seq,
        actions: durableState.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
          .one().count,
        sectionDeleted: section.deleted,
        member: JSON.parse(member.data_json) as Record<string, unknown>,
      };
    });
    expect(state).toMatchObject({
      latestSeq: 3,
      actions: 3,
      sectionDeleted: 1,
      member: { id: memberId, createdBy: actorId },
    });
    expect(state.member.sectionId).toBeUndefined();

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  });

  it.each(["missing", "non-Section"] as const)(
    "rejects a first-launch import with a %s Section target",
    async (targetKind) => {
      const destinationBoardId = `b_${(targetKind === "missing" ? "P" : "Q").repeat(21)}A`;
      const stub = (env as unknown as Env).BOARD_ROOMS.getByName(destinationBoardId);
      const sectionId = topologyId(954);
      const itemId = topologyId(955);
      const member = importedRectangle(itemId, targetKind === "missing" ? 1 : 2, { sectionId });
      const items = targetKind === "missing" ? [member] : [importedRectangle(sectionId, 1), member];

      const launch = await launchClassroom(
        stub,
        actorId,
        "owner",
        Date.now(),
        "Coach",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        encodeImport(items),
        destinationBoardId,
      );
      expect(launch.status).toBe(400);
      expect(await launch.json()).toMatchObject({
        error: {
          code: "INVALID_FRAME",
          details: { sectionId, itemId },
        },
      });
    },
  );

  it("rejects a first-launch import that nests a Section inside another Section", async () => {
    const destinationBoardId = `b_${"R".repeat(21)}A`;
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(destinationBoardId);
    const sectionId = topologyId(958);
    const itemId = topologyId(959);
    const nestedSection = { ...importedSection(itemId, 2), sectionId };

    const launch = await launchClassroom(
      stub,
      actorId,
      "owner",
      Date.now(),
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      encodeImport([importedSection(sectionId, 1), nestedSection]),
      destinationBoardId,
    );
    expect(launch.status).toBe(400);
    expect(await launch.json()).toMatchObject({
      error: {
        code: "INVALID_FRAME",
        details: { sectionId, itemId },
      },
    });
  });

  it("rejects restoring a snapshot with a missing Section target", async () => {
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const sectionId = topologyId(956);
    const itemId = topologyId(957);
    const snapshotBytes = new TextEncoder().encode(
      JSON.stringify({
        format: "cf-whiteboard-json",
        version: 1,
        boardId,
        seq: 0,
        createdAt: Date.now(),
        settings: { title: "Invalid Section restore" },
        items: [importedRectangle(itemId, 1, { sectionId })],
      }),
    );
    const digest = await sha256Base64Url(snapshotBytes);
    const key = "tests/invalid-section-relationship/snapshot.json";
    await typedEnv.BOARD_SNAPSHOTS.put(key, snapshotBytes, {
      customMetadata: { sha256: digest },
    });
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        `INSERT INTO snapshots(
          seq, r2_json_key, sha256, item_count, byte_count, kind, label,
          created_by, created_at_ms
        ) VALUES (0, ?, ?, 1, ?, 'named', 'Invalid relationship', ?, ?)`,
        key,
        digest,
        snapshotBytes.byteLength,
        actorId,
        Date.now(),
      );
    });

    const response = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/restore/0`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "invalid-section-restore-0001",
        },
        body: JSON.stringify({ expectedBoardSeq: 0 }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "INVALID_FRAME",
        details: { sectionId, itemId },
      },
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      receipts: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM http_receipts")
        .one().count,
    }));
    expect(state).toEqual({ latestSeq: 0, actions: 0, receipts: 0 });
  });

  it("accepts a 100-object Section closure and atomically rejects its 101st direct member", async () => {
    const destinationBoardId = `b_${"M".repeat(21)}A`;
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(destinationBoardId);
    const sectionId = topologyId(1);
    const members = Array.from({ length: 99 }, (_, index) =>
      importedRectangle(topologyId(index + 2), index + 2, { sectionId }),
    );
    const launch = await launchClassroom(
      stub,
      actorId,
      "owner",
      Date.now(),
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      encodeImport([importedSection(sectionId, 1), ...members]),
      destinationBoardId,
    );
    expect(launch.status, await launch.clone().text()).toBe(201);

    const owner = await connect(stub, actorId, 1, destinationBoardId);
    const candidateId = topologyId(101);
    const commandId = topologyId(102);
    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId,
        actionId: topologyId(103),
        baseSeq: 1,
        op: {
          kind: "item.create",
          item: {
            id: candidateId,
            sectionId,
            kind: "rectangle",
            style: { kind: "stroke", color: "#112233", width: 2, opacity: 1 },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: { x: 40, y: 50, width: 3, height: 4 },
          },
        },
      }),
    );
    expect(
      await owner.next((frame) => frame.t === "server.rejected" && frame.commandId === commandId),
    ).toMatchObject({
      code: "BOARD_LIMIT_REACHED",
      latestSeq: 1,
      seedItemId: sectionId,
      itemCount: 101,
      limit: 100,
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      liveItems: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM items WHERE deleted = 0")
        .one().count,
      candidateRows: durableState.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM items WHERE item_id = ?",
          candidateId,
        )
        .one().count,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      history: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM history_entries")
        .one().count,
    }));
    expect(state).toEqual({
      latestSeq: 1,
      liveItems: 100,
      candidateRows: 0,
      actions: 0,
      history: 0,
    });
    owner.socket.close(1000, "done");
  });

  it("rejects a relationship edge whose group expansion makes a Section closure exceed 100", async () => {
    const destinationBoardId = `b_${"N".repeat(21)}A`;
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(destinationBoardId);
    const sectionId = topologyId(200);
    const bridgeId = topologyId(201);
    const groupId = topologyId(900);
    const sectionMembers = Array.from({ length: 59 }, (_, index) =>
      importedRectangle(topologyId(index + 201), index + 2, { sectionId }),
    );
    const groupMembers = Array.from({ length: 41 }, (_, index) =>
      importedRectangle(topologyId(index + 300), index + 61, { groupId }),
    );
    const launch = await launchClassroom(
      stub,
      actorId,
      "owner",
      Date.now(),
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      encodeImport([importedSection(sectionId, 1), ...sectionMembers, ...groupMembers]),
      destinationBoardId,
    );
    expect(launch.status, await launch.clone().text()).toBe(201);

    const owner = await connect(stub, actorId, 1, destinationBoardId);
    const commandId = topologyId(901);
    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId,
        actionId: topologyId(902),
        baseSeq: 1,
        op: {
          kind: "item.update",
          itemId: bridgeId,
          expectedVersion: 1,
          patch: { groupId },
        },
      }),
    );
    expect(
      await owner.next((frame) => frame.t === "server.rejected" && frame.commandId === commandId),
    ).toMatchObject({
      code: "BOARD_LIMIT_REACHED",
      latestSeq: 1,
      seedItemId: sectionId,
      itemCount: 101,
      limit: 100,
    });

    const state = await runInDurableObject(stub, (_instance, durableState) => {
      const row = durableState.storage.sql
        .exec<{ data_json: string }>("SELECT data_json FROM items WHERE item_id = ?", bridgeId)
        .one();
      return {
        latestSeq: durableState.storage.sql
          .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
          .one().latest_seq,
        actions: durableState.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
          .one().count,
        bridge: JSON.parse(row.data_json) as Record<string, unknown>,
      };
    });
    expect(state).toMatchObject({ latestSeq: 1, actions: 0 });
    expect(state.bridge).not.toHaveProperty("groupId");
    owner.socket.close(1000, "done");
  });
});

describe("BoardRoom Section locks", () => {
  afterEach(async () => reset());

  it("applies locked Sections atomically during the first owner launch", async () => {
    const binding = (env as unknown as Env).BOARD_ROOMS;
    const destinationBoardId = `b_${"L".repeat(21)}A`;
    const stub = binding.getByName(destinationBoardId);
    const sectionId = "018f0000-0000-7000-8000-0000000009a0";
    const stickyId = "018f0000-0000-7000-8000-0000000009a1";
    const importSnapshot = bytesToBase64Url(
      utf8(
        JSON.stringify({
          format: "cf-whiteboard-json",
          version: 1,
          boardId,
          seq: 0,
          createdAt: Date.now(),
          settings: { title: "Initially locked workshop" },
          items: [
            {
              id: sectionId,
              kind: "zone",
              z: 1,
              version: 0,
              createdBy: actorId,
              style: {
                kind: "zone",
                borderColor: "#60a5fa",
                fill: "#eff6ff",
                textColor: "#1e3a8a",
                fontSize: 20,
                opacity: 0.8,
              },
              transform: [1, 0, 0, 1, 0, 0],
              geometry: {
                x: 20,
                y: 30,
                width: 600,
                height: 400,
                title: "Prepared responses",
                locked: true,
              },
            },
            {
              id: stickyId,
              kind: "sticky",
              z: 2,
              version: 0,
              createdBy: actorId,
              sectionId,
              style: {
                kind: "sticky",
                fill: "#fde68a",
                textColor: "#292524",
                fontSize: 20,
                opacity: 1,
              },
              transform: [1, 0, 0, 1, 0, 0],
              geometry: { x: 80, y: 120, width: 180, height: 140, text: "Prepared prompt" },
            },
          ],
        }),
      ),
    );

    const launch = await launchClassroom(
      stub,
      actorId,
      "owner",
      Date.now(),
      "Coach",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      importSnapshot,
      destinationBoardId,
      organisationId,
    );
    expect(launch.status, await launch.clone().text()).toBe(201);

    const bootstrap = await stub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${destinationBoardId}/bootstrap`),
    );
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      board: { latestSeq: 1, title: "Initially locked workshop" },
      snapshot: {
        items: expect.arrayContaining([
          expect.objectContaining({
            id: sectionId,
            version: 1,
            geometry: expect.objectContaining({ locked: true }),
          }),
          expect.objectContaining({ id: stickyId, version: 1, sectionId }),
        ]),
      },
    });

    const exportedResponse = await stub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${destinationBoardId}/export.json`),
    );
    expect(exportedResponse.status).toBe(200);
    expect(await exportedResponse.json()).toMatchObject({
      sections: [
        {
          id: sectionId,
          name: "Prepared responses",
          locked: true,
          memberItemIds: [stickyId],
        },
      ],
    });

    const namedSnapshot = await stub.fetch(
      internalActorRequest(actorId, `/api/v1/boards/${destinationBoardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "locked-section-recovery-snapshot-0001",
        },
        body: JSON.stringify({ label: "Locked workshop recovery" }),
      }),
    );
    expect(namedSnapshot.status, await namedSnapshot.clone().text()).toBe(201);
    expect(await namedSnapshot.json()).toMatchObject({
      snapshot: {
        seq: 1,
        kind: "named",
        label: "Locked workshop recovery",
        itemCount: 2,
      },
    });

    const owner = await connect(stub, actorId, 1, destinationBoardId);
    const blockedUpdate = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-0000000009a2",
      actionId: "018f0000-0000-7000-8000-0000000009a3",
      baseSeq: 1,
      op: {
        kind: "item.update",
        itemId: stickyId,
        expectedVersion: 1,
        patch: {
          geometry: { x: 80, y: 120, width: 180, height: 140, text: "Blocked owner edit" },
        },
      },
    };
    owner.socket.send(JSON.stringify(blockedUpdate));
    expect(
      await owner.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === blockedUpdate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 1 });
    owner.socket.close(1000, "done");
  });

  it("freezes every participant's Section contents until an owner explicitly unlocks it", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const sectionId = "018f0000-0000-7000-8000-000000000980";
    const stickyId = "018f0000-0000-7000-8000-000000000981";
    const sectionGeometry = {
      x: 20,
      y: 30,
      width: 600,
      height: 400,
      title: "Frozen review",
    };

    const createSection = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000982",
      actionId: "018f0000-0000-7000-8000-000000000983",
      baseSeq: 0,
      op: {
        kind: "item.create",
        item: {
          id: sectionId,
          kind: "zone",
          style: {
            kind: "zone",
            borderColor: "#60a5fa",
            fill: "#eff6ff",
            textColor: "#1e3a8a",
            fontSize: 20,
            opacity: 0.8,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: sectionGeometry,
        },
      },
    };
    owner.socket.send(JSON.stringify(createSection));
    expect(
      await owner.next(
        (frame) => frame.t === "server.action" && frame.commandId === createSection.commandId,
      ),
    ).toMatchObject({ seq: 1, op: { item: { id: sectionId } } });

    const createSticky = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000984",
      actionId: "018f0000-0000-7000-8000-000000000985",
      baseSeq: 1,
      op: {
        kind: "item.create",
        item: {
          id: stickyId,
          sectionId,
          kind: "sticky",
          style: {
            kind: "sticky",
            fill: "#fde68a",
            textColor: "#292524",
            fontSize: 20,
            opacity: 1,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 80, y: 120, width: 180, height: 140, text: "Editor work" },
        },
      },
    };
    editor.socket.send(JSON.stringify(createSticky));
    expect(
      await editor.next(
        (frame) => frame.t === "server.action" && frame.commandId === createSticky.commandId,
      ),
    ).toMatchObject({ seq: 2, actor: { id: editorId }, op: { item: { sectionId } } });

    const preLockSnapshot = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "pre-lock-restore-snapshot-0001",
        },
        body: JSON.stringify({ label: "Before Section lock" }),
      }),
    );
    expect(preLockSnapshot.status).toBe(201);
    await preLockSnapshot.arrayBuffer();

    const lockSection = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000986",
      actionId: "018f0000-0000-7000-8000-000000000987",
      baseSeq: 2,
      op: {
        kind: "item.update",
        itemId: sectionId,
        expectedVersion: 1,
        patch: { geometry: { ...sectionGeometry, locked: true } },
      },
    };
    owner.socket.send(JSON.stringify(lockSection));
    expect(
      await owner.next(
        (frame) => frame.t === "server.action" && frame.commandId === lockSection.commandId,
      ),
    ).toMatchObject({ seq: 3, op: { item: { geometry: { locked: true } } } });
    await editor.next(
      (frame) => frame.t === "server.action" && frame.commandId === lockSection.commandId,
    );

    const blockedHistoryUndo = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-0000000009b1",
      actionId: "018f0000-0000-7000-8000-0000000009b2",
      baseSeq: 3,
      op: {
        kind: "history.undo",
        expectedHistoryVersion: 1,
        targetActionId: createSticky.actionId,
      },
    };
    editor.socket.send(JSON.stringify(blockedHistoryUndo));
    expect(
      await editor.next(
        (frame) =>
          frame.t === "server.rejected" && frame.commandId === blockedHistoryUndo.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 3 });

    const blockedRestore = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/restore/2`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "locked-section-restore-0002",
        },
        body: JSON.stringify({ expectedBoardSeq: 3 }),
      }),
    );
    expect(blockedRestore.status).toBe(403);
    expect(await blockedRestore.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const blockedOwnerUpdate = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000988",
      actionId: "018f0000-0000-7000-8000-000000000989",
      baseSeq: 3,
      op: {
        kind: "item.update",
        itemId: stickyId,
        expectedVersion: 2,
        patch: {
          geometry: { x: 80, y: 120, width: 180, height: 140, text: "Owner edit" },
        },
      },
    };
    owner.socket.send(JSON.stringify(blockedOwnerUpdate));
    expect(
      await owner.next(
        (frame) =>
          frame.t === "server.rejected" && frame.commandId === blockedOwnerUpdate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 3 });

    const blockedEditorUpdate = {
      ...blockedOwnerUpdate,
      commandId: "018f0000-0000-7000-8000-00000000098a",
      actionId: "018f0000-0000-7000-8000-00000000098b",
      op: {
        ...blockedOwnerUpdate.op,
        patch: {
          geometry: { x: 80, y: 120, width: 180, height: 140, text: "Editor edit" },
        },
      },
    };
    editor.socket.send(JSON.stringify(blockedEditorUpdate));
    expect(
      await editor.next(
        (frame) =>
          frame.t === "server.rejected" && frame.commandId === blockedEditorUpdate.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 3 });

    const blockedClear = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-00000000098c",
      actionId: "018f0000-0000-7000-8000-00000000098d",
      baseSeq: 3,
      op: { kind: "board.clear", expectedBoardSeq: 3 },
    };
    owner.socket.send(JSON.stringify(blockedClear));
    expect(
      await owner.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === blockedClear.commandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 3 });

    const exportedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/export.json`),
    );
    expect(exportedResponse.status).toBe(200);
    const exported = (await exportedResponse.json()) as {
      sections: Array<{ id: string; name: string; locked: boolean; memberItemIds: string[] }>;
    };
    expect(exported.sections).toContainEqual({
      id: sectionId,
      locked: true,
      name: "Frozen review",
      memberItemIds: [stickyId],
    });

    const unlockSection = {
      ...lockSection,
      commandId: "018f0000-0000-7000-8000-00000000098e",
      actionId: "018f0000-0000-7000-8000-00000000098f",
      baseSeq: 3,
      op: {
        ...lockSection.op,
        expectedVersion: 3,
        patch: { geometry: { ...sectionGeometry, locked: false } },
      },
    };
    owner.socket.send(JSON.stringify(unlockSection));
    expect(
      await owner.next(
        (frame) => frame.t === "server.action" && frame.commandId === unlockSection.commandId,
      ),
    ).toMatchObject({ seq: 4, op: { item: { geometry: sectionGeometry } } });
    await editor.next(
      (frame) => frame.t === "server.action" && frame.commandId === unlockSection.commandId,
    );

    const acceptedEditorUpdate = {
      ...blockedEditorUpdate,
      commandId: "018f0000-0000-7000-8000-000000000990",
      actionId: "018f0000-0000-7000-8000-000000000991",
      baseSeq: 4,
    };
    editor.socket.send(JSON.stringify(acceptedEditorUpdate));
    expect(
      await editor.next(
        (frame) =>
          frame.t === "server.action" && frame.commandId === acceptedEditorUpdate.commandId,
      ),
    ).toMatchObject({ seq: 5, op: { item: { geometry: { text: "Editor edit" } } } });

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  });

  it("rejects Section lock history after an owner is demoted", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE members SET role = 'owner', updated_at_ms = ? WHERE actor_id = ?",
        Date.now(),
        editorId,
      );
    });
    const formerOwner = await connect(stub, editorId);
    const sectionId = "018f0000-0000-7000-8000-000000000a20";
    const sectionGeometry = { x: 20, y: 30, width: 600, height: 400, title: "Locked history" };
    const createSection = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000a21",
      actionId: "018f0000-0000-7000-8000-000000000a22",
      baseSeq: 0,
      op: {
        kind: "item.create",
        item: {
          id: sectionId,
          kind: "zone",
          style: {
            kind: "zone",
            borderColor: "#60a5fa",
            fill: "#eff6ff",
            textColor: "#1e3a8a",
            fontSize: 20,
            opacity: 0.8,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: sectionGeometry,
        },
      },
    };
    formerOwner.socket.send(JSON.stringify(createSection));
    await formerOwner.next((frame) => frame.t === "server.action" && frame.seq === 1);
    const lockActionId = "018f0000-0000-7000-8000-000000000a24";
    formerOwner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000a23",
        actionId: lockActionId,
        baseSeq: 1,
        op: {
          kind: "item.update",
          itemId: sectionId,
          expectedVersion: 1,
          patch: { geometry: { ...sectionGeometry, locked: true } },
        },
      }),
    );
    await formerOwner.next((frame) => frame.t === "server.action" && frame.seq === 2);
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE members SET role = 'editor', updated_at_ms = ? WHERE actor_id = ?",
        Date.now(),
        editorId,
      );
    });

    const undoCommandId = "018f0000-0000-7000-8000-000000000a25";
    formerOwner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: undoCommandId,
        actionId: "018f0000-0000-7000-8000-000000000a26",
        baseSeq: 2,
        op: {
          kind: "history.undo",
          expectedHistoryVersion: 2,
          targetActionId: lockActionId,
        },
      }),
    );
    expect(
      await formerOwner.next(
        (frame) => frame.t === "server.rejected" && frame.commandId === undoCommandId,
      ),
    ).toMatchObject({ code: "FORBIDDEN", latestSeq: 2 });
    formerOwner.socket.close(1000, "done");
  });

  it("keeps Section lock history undoable and redoable", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, actorId);
    const sectionId = "018f0000-0000-7000-8000-0000000009b0";
    const sectionGeometry = { x: 20, y: 30, width: 600, height: 400, title: "History" };
    const createSection = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000992",
      actionId: "018f0000-0000-7000-8000-000000000993",
      baseSeq: 0,
      op: {
        kind: "item.create",
        item: {
          id: sectionId,
          kind: "zone",
          style: {
            kind: "zone",
            borderColor: "#60a5fa",
            fill: "#eff6ff",
            textColor: "#1e3a8a",
            fontSize: 20,
            opacity: 0.8,
          },
          transform: [1, 0, 0, 1, 0, 0],
          geometry: sectionGeometry,
        },
      },
    };
    owner.socket.send(JSON.stringify(createSection));
    await owner.next(
      (frame) => frame.t === "server.action" && frame.commandId === createSection.commandId,
    );

    const lockSection = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-000000000994",
      actionId: "018f0000-0000-7000-8000-000000000995",
      baseSeq: 1,
      op: {
        kind: "item.update",
        itemId: sectionId,
        expectedVersion: 1,
        patch: { geometry: { ...sectionGeometry, locked: true } },
      },
    };
    owner.socket.send(JSON.stringify(lockSection));
    await owner.next(
      (frame) => frame.t === "server.action" && frame.commandId === lockSection.commandId,
    );

    const applyHistory = async (
      kind: "history.undo" | "history.redo",
      commandId: string,
      actionId: string,
      baseSeq: number,
      expectedHistoryVersion: number,
      targetActionId: string,
    ) => {
      owner.socket.send(
        JSON.stringify({
          v: 1,
          t: "client.commit",
          commandId,
          actionId,
          baseSeq,
          op: { kind, expectedHistoryVersion, targetActionId },
        }),
      );
      return owner.next((frame) => frame.t === "server.action" && frame.commandId === commandId);
    };

    expect(
      await applyHistory(
        "history.undo",
        "018f0000-0000-7000-8000-000000000996",
        "018f0000-0000-7000-8000-000000000997",
        2,
        2,
        lockSection.actionId,
      ),
    ).toMatchObject({
      seq: 3,
      op: {
        changes: [{ kind: "item.replace", item: { id: sectionId, geometry: sectionGeometry } }],
      },
    });
    expect(
      await applyHistory(
        "history.undo",
        "018f0000-0000-7000-8000-000000000998",
        "018f0000-0000-7000-8000-000000000999",
        3,
        3,
        createSection.actionId,
      ),
    ).toMatchObject({ seq: 4, op: { changes: [{ kind: "item.remove", itemId: sectionId }] } });
    expect(
      await applyHistory(
        "history.redo",
        "018f0000-0000-7000-8000-00000000099a",
        "018f0000-0000-7000-8000-00000000099b",
        4,
        4,
        createSection.actionId,
      ),
    ).toMatchObject({
      seq: 5,
      op: {
        changes: [{ kind: "item.replace", item: { id: sectionId, geometry: sectionGeometry } }],
      },
    });
    expect(
      await applyHistory(
        "history.redo",
        "018f0000-0000-7000-8000-00000000099c",
        "018f0000-0000-7000-8000-00000000099d",
        5,
        5,
        lockSection.actionId,
      ),
    ).toMatchObject({
      seq: 6,
      op: {
        changes: [{ kind: "item.replace", item: { id: sectionId, geometry: { locked: true } } }],
      },
    });

    owner.socket.close(1000, "done");
  });
});

describe("BoardRoom Section membership history", () => {
  afterEach(async () => reset());

  const zoneStyle = {
    kind: "zone",
    borderColor: "#60a5fa",
    fill: "#eff6ff",
    textColor: "#1e3a8a",
    fontSize: 20,
    opacity: 0.8,
  };
  const stickyStyle = {
    kind: "sticky",
    fill: "#fff2a8",
    textColor: "#2f2a1f",
    fontSize: 20,
    opacity: 1,
  };

  function sectionCreate(commandId: string, actionId: string, sectionId: string, baseSeq: number) {
    return {
      v: 1,
      t: "client.commit",
      commandId,
      actionId,
      baseSeq,
      op: {
        kind: "item.create",
        item: {
          id: sectionId,
          kind: "zone",
          style: zoneStyle,
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 0, y: 0, width: 600, height: 400, title: "Members" },
        },
      },
    };
  }

  function memberCreate(
    commandId: string,
    actionId: string,
    memberId: string,
    sectionId: string,
    baseSeq: number,
  ) {
    return {
      v: 1,
      t: "client.commit",
      commandId,
      actionId,
      baseSeq,
      op: {
        kind: "item.create",
        item: {
          id: memberId,
          sectionId,
          kind: "sticky",
          style: stickyStyle,
          transform: [1, 0, 0, 1, 0, 0],
          geometry: { x: 10, y: 20, width: 180, height: 140, text: "Question" },
        },
      },
    };
  }

  function historyCommit(
    kind: "history.undo" | "history.redo",
    commandId: string,
    actionId: string,
    baseSeq: number,
    expectedHistoryVersion: number,
    targetActionId: string,
  ) {
    return {
      v: 1,
      t: "client.commit",
      commandId,
      actionId,
      baseSeq,
      op: { kind, expectedHistoryVersion, targetActionId },
    };
  }

  async function send(socket: TestSocket, frame: { commandId: string; [key: string]: unknown }) {
    socket.socket.send(JSON.stringify(frame));
    return socket.next(
      (received) =>
        (received.t === "server.action" || received.t === "server.rejected") &&
        received.commandId === frame.commandId,
    );
  }

  it("redoes a Section deletion after another participant attached a member", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const sectionId = "018f0000-0000-7000-8000-00000000a010";
    const memberId = "018f0000-0000-7000-8000-00000000a011";

    const created = sectionCreate(
      "018f0000-0000-7000-8000-00000000a012",
      "018f0000-0000-7000-8000-00000000a013",
      sectionId,
      0,
    );
    expect(await send(owner, created)).toMatchObject({ t: "server.action", seq: 1 });
    const deleted = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-00000000a014",
      actionId: "018f0000-0000-7000-8000-00000000a015",
      baseSeq: 1,
      op: { kind: "item.delete", itemId: sectionId, expectedVersion: 1 },
    };
    expect(await send(owner, deleted)).toMatchObject({ t: "server.action", seq: 2 });
    expect(
      await send(
        owner,
        historyCommit(
          "history.undo",
          "018f0000-0000-7000-8000-00000000a016",
          "018f0000-0000-7000-8000-00000000a017",
          2,
          2,
          deleted.actionId,
        ),
      ),
    ).toMatchObject({ t: "server.action", seq: 3 });

    // A different participant attaches a member while the Section is restored;
    // this does not invalidate the owner's redo stack.
    expect(
      await send(
        editor,
        memberCreate(
          "018f0000-0000-7000-8000-00000000a018",
          "018f0000-0000-7000-8000-00000000a019",
          memberId,
          sectionId,
          3,
        ),
      ),
    ).toMatchObject({ t: "server.action", seq: 4 });

    const redone = await send(
      owner,
      historyCommit(
        "history.redo",
        "018f0000-0000-7000-8000-00000000a01a",
        "018f0000-0000-7000-8000-00000000a01b",
        4,
        3,
        deleted.actionId,
      ),
    );
    expect(redone).toMatchObject({
      t: "server.action",
      seq: 5,
      op: {
        changes: [
          { kind: "item.remove", itemId: sectionId },
          { kind: "item.replace", item: { id: memberId } },
        ],
      },
    });
    const changes = (redone as { op: { changes: Array<{ item?: { sectionId?: string } }> } }).op
      .changes;
    expect(changes[1]?.item?.sectionId).toBeUndefined();

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  });

  it("makes another participant's history conflict once a Section undo detached their member", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const sectionId = "018f0000-0000-7000-8000-00000000a020";
    const memberId = "018f0000-0000-7000-8000-00000000a021";

    const created = sectionCreate(
      "018f0000-0000-7000-8000-00000000a022",
      "018f0000-0000-7000-8000-00000000a023",
      sectionId,
      0,
    );
    expect(await send(owner, created)).toMatchObject({ t: "server.action", seq: 1 });
    const memberCreated = memberCreate(
      "018f0000-0000-7000-8000-00000000a024",
      "018f0000-0000-7000-8000-00000000a025",
      memberId,
      sectionId,
      1,
    );
    expect(await send(editor, memberCreated)).toMatchObject({ t: "server.action", seq: 2 });

    // Undoing the Section create detaches the editor's member under a fresh
    // state token: the member's logical state changed.
    expect(
      await send(
        owner,
        historyCommit(
          "history.undo",
          "018f0000-0000-7000-8000-00000000a026",
          "018f0000-0000-7000-8000-00000000a027",
          2,
          1,
          created.actionId,
        ),
      ),
    ).toMatchObject({
      t: "server.action",
      seq: 3,
      op: {
        changes: [
          { kind: "item.remove", itemId: sectionId },
          { kind: "item.replace", item: { id: memberId } },
        ],
      },
    });

    // The editor's own entry recorded the attached member, so it must now
    // conflict rather than replay a Section relationship that no longer exists.
    expect(
      await send(
        editor,
        historyCommit(
          "history.undo",
          "018f0000-0000-7000-8000-00000000a028",
          "018f0000-0000-7000-8000-00000000a029",
          3,
          1,
          memberCreated.actionId,
        ),
      ),
    ).toMatchObject({ t: "server.rejected", code: "UNDO_CONFLICT" });

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  });

  it("lets a Section's creator delete or undo it after the owner attached an item", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const sectionId = "018f0000-0000-7000-8000-00000000a030";
    const memberId = "018f0000-0000-7000-8000-00000000a031";

    const created = sectionCreate(
      "018f0000-0000-7000-8000-00000000a032",
      "018f0000-0000-7000-8000-00000000a033",
      sectionId,
      0,
    );
    expect(await send(editor, created)).toMatchObject({ t: "server.action", seq: 1 });
    expect(
      await send(
        owner,
        memberCreate(
          "018f0000-0000-7000-8000-00000000a034",
          "018f0000-0000-7000-8000-00000000a035",
          memberId,
          sectionId,
          1,
        ),
      ),
    ).toMatchObject({ t: "server.action", seq: 2 });

    // The editor cannot edit the owner's sticky, but may detach it from the
    // editor's own Section as part of deleting that Section.
    const deleteWithDetach = {
      v: 1,
      t: "client.commit",
      commandId: "018f0000-0000-7000-8000-00000000a036",
      actionId: "018f0000-0000-7000-8000-00000000a037",
      baseSeq: 2,
      op: {
        kind: "items.batch",
        operations: [
          { kind: "item.delete", itemId: sectionId, expectedVersion: 1 },
          { kind: "item.update", itemId: memberId, expectedVersion: 2, patch: { sectionId: null } },
        ],
      },
    };
    expect(await send(editor, deleteWithDetach)).toMatchObject({ t: "server.action", seq: 3 });
    const afterDelete = await runInDurableObject(stub, (_instance, durableState) => ({
      sectionDeleted: durableState.storage.sql
        .exec<{ deleted: number }>("SELECT deleted FROM items WHERE item_id = ?", sectionId)
        .one().deleted,
      member: JSON.parse(
        durableState.storage.sql
          .exec<{ data_json: string }>("SELECT data_json FROM items WHERE item_id = ?", memberId)
          .one().data_json,
      ) as Record<string, unknown>,
    }));
    expect(afterDelete.sectionDeleted).toBe(1);
    expect(afterDelete.member).toMatchObject({ id: memberId, createdBy: actorId });
    expect(afterDelete.member.sectionId).toBeUndefined();

    // Moving the owner's sticky is still not the editor's to do.
    expect(
      await send(editor, {
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-00000000a038",
        actionId: "018f0000-0000-7000-8000-00000000a039",
        baseSeq: 3,
        op: {
          kind: "item.update",
          itemId: memberId,
          expectedVersion: 3,
          patch: { transform: [1, 0, 0, 1, 5, 5] },
        },
      }),
    ).toMatchObject({ t: "server.rejected", code: "FORBIDDEN" });

    // Undoing the deletion re-creates the Section and re-attaches the member
    // (its recorded before-state), which is the creator's right for a
    // relationship-only change. Undoing the Section's creation afterwards
    // detaches that foreign member again as a synthesized dependent change.
    expect(
      await send(
        editor,
        historyCommit(
          "history.undo",
          "018f0000-0000-7000-8000-00000000a03a",
          "018f0000-0000-7000-8000-00000000a03b",
          3,
          2,
          deleteWithDetach.actionId,
        ),
      ),
    ).toMatchObject({ t: "server.action", seq: 4 });
    expect(
      await send(
        editor,
        historyCommit(
          "history.undo",
          "018f0000-0000-7000-8000-00000000a03c",
          "018f0000-0000-7000-8000-00000000a03d",
          4,
          3,
          created.actionId,
        ),
      ),
    ).toMatchObject({
      t: "server.action",
      seq: 5,
      op: {
        changes: [
          { kind: "item.remove", itemId: sectionId },
          { kind: "item.replace", item: { id: memberId, createdBy: actorId } },
        ],
      },
    });

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
  });

  it("keeps a Section's lock through a recovery snapshot and restore", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, actorId);
    const sectionId = "018f0000-0000-7000-8000-00000000a040";
    const geometry = { x: 0, y: 0, width: 600, height: 400, title: "Members" };

    expect(
      await send(
        owner,
        sectionCreate(
          "018f0000-0000-7000-8000-00000000a041",
          "018f0000-0000-7000-8000-00000000a042",
          sectionId,
          0,
        ),
      ),
    ).toMatchObject({ t: "server.action", seq: 1 });
    const lock = (commandId: string, actionId: string, baseSeq: number, locked: boolean) => ({
      v: 1,
      t: "client.commit",
      commandId,
      actionId,
      baseSeq,
      op: {
        kind: "item.update",
        itemId: sectionId,
        expectedVersion: baseSeq,
        patch: { geometry: { ...geometry, locked } },
      },
    });
    expect(
      await send(
        owner,
        lock(
          "018f0000-0000-7000-8000-00000000a043",
          "018f0000-0000-7000-8000-00000000a044",
          1,
          true,
        ),
      ),
    ).toMatchObject({ t: "server.action", seq: 2, op: { item: { geometry: { locked: true } } } });

    // Snapshot the locked state, unlock so restore is permitted, then restore.
    const snapshot = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "locked-section-snapshot-a045",
        },
        body: JSON.stringify({ label: "While locked" }),
      }),
    );
    expect(snapshot.status).toBe(201);
    await snapshot.arrayBuffer();
    expect(
      await send(
        owner,
        lock(
          "018f0000-0000-7000-8000-00000000a046",
          "018f0000-0000-7000-8000-00000000a047",
          2,
          false,
        ),
      ),
    ).toMatchObject({ t: "server.action", seq: 3 });

    const restored = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/restore/2`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "locked-section-restore-a048",
        },
        body: JSON.stringify({ expectedBoardSeq: 3 }),
      }),
    );
    expect(restored.status).toBe(200);
    await restored.arrayBuffer();

    const stored = await runInDurableObject(
      stub,
      (_instance, durableState) =>
        JSON.parse(
          durableState.storage.sql
            .exec<{ data_json: string }>("SELECT data_json FROM items WHERE item_id = ?", sectionId)
            .one().data_json,
        ) as { geometry: { locked?: boolean } },
    );
    expect(stored.geometry.locked).toBe(true);

    owner.socket.close(1000, "done");
  });
});

describe("BoardRoom facilitation spotlight", () => {
  afterEach(async () => reset());

  it("relays owner and editor viewports without durable writes while viewers remain receive-only", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.transactionSync(() => {
        durableState.storage.sql.exec(
          `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
           VALUES (?, 'viewer', 'Viewer', ?, ?)`,
          studentId,
          now,
          now,
        );
        durableState.storage.sql.exec("UPDATE board SET acl_version = 3");
      });
    });

    const owner = await connect(stub, actorId);
    const editor = await connect(stub, editorId);
    const viewer = await connect(stub, studentId);
    const ownerSpotlightId = "018f0000-0000-7000-8000-000000000930";
    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.facilitation.spotlight",
        spotlightId: ownerSpotlightId,
        active: true,
        viewport: { center: { x: 125.555, y: -40.125 }, zoom: 1.23456 },
      }),
    );
    const [editorOwnerFrame, viewerOwnerFrame] = await Promise.all([
      editor.next(
        (frame) =>
          frame.t === "server.facilitation.spotlight" && frame.spotlightId === ownerSpotlightId,
      ),
      viewer.next(
        (frame) =>
          frame.t === "server.facilitation.spotlight" && frame.spotlightId === ownerSpotlightId,
      ),
    ]);
    for (const frame of [editorOwnerFrame, viewerOwnerFrame]) {
      expect(frame).toMatchObject({
        v: 1,
        t: "server.facilitation.spotlight",
        spotlightId: ownerSpotlightId,
        active: true,
        viewport: { center: { x: 125.56, y: -40.13 }, zoom: 1.2346 },
        actor: { id: actorId, displayName: "Owner 1" },
        connectionId: expect.any(String),
      });
    }

    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.facilitation.spotlight",
        spotlightId: ownerSpotlightId,
        active: false,
      }),
    );
    const ownerStopped = await viewer.next(
      (frame) =>
        frame.t === "server.facilitation.spotlight" &&
        frame.spotlightId === ownerSpotlightId &&
        frame.active === false,
    );
    expect(ownerStopped).not.toHaveProperty("viewport");

    const lock = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ drawingPolicy: "locked", expectedAclVersion: 3 }),
      }),
    );
    expect(lock.status).toBe(200);
    await editor.next((frame) => frame.t === "access.changed" && frame.drawingPolicy === "locked");

    const editorSpotlightId = "018f0000-0000-7000-8000-000000000931";
    editor.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.facilitation.spotlight",
        spotlightId: editorSpotlightId,
        active: true,
        viewport: { center: { x: 300, y: 220 }, zoom: 0.75 },
      }),
    );
    const [ownerEditorFrame, viewerEditorFrame] = await Promise.all([
      owner.next(
        (frame) =>
          frame.t === "server.facilitation.spotlight" && frame.spotlightId === editorSpotlightId,
      ),
      viewer.next(
        (frame) =>
          frame.t === "server.facilitation.spotlight" && frame.spotlightId === editorSpotlightId,
      ),
    ]);
    for (const frame of [ownerEditorFrame, viewerEditorFrame]) {
      expect(frame).toMatchObject({
        spotlightId: editorSpotlightId,
        active: true,
        viewport: { center: { x: 300, y: 220 }, zoom: 0.75 },
        actor: { id: editorId, displayName: "Editor" },
        connectionId: expect.any(String),
      });
    }

    viewer.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.facilitation.spotlight",
        spotlightId: "018f0000-0000-7000-8000-000000000932",
        active: true,
        viewport: { center: { x: 0, y: 0 }, zoom: 1 },
      }),
    );
    expect(await viewer.next((frame) => frame.t === "server.rejected")).toMatchObject({
      code: "FORBIDDEN",
      latestSeq: 0,
    });

    editor.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.facilitation.spotlight",
        spotlightId: editorSpotlightId,
        active: false,
      }),
    );
    expect(
      await viewer.next(
        (frame) =>
          frame.t === "server.facilitation.spotlight" &&
          frame.spotlightId === editorSpotlightId &&
          frame.active === false,
      ),
    ).toMatchObject({ actor: { id: editorId, displayName: "Editor" } });

    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      latestSeq: durableState.storage.sql
        .exec<{ latest_seq: number }>("SELECT latest_seq FROM board")
        .one().latest_seq,
      actions: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM actions")
        .one().count,
      items: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM items")
        .one().count,
    }));
    expect(state).toEqual({ latestSeq: 0, actions: 0, items: 0 });

    owner.socket.close(1000, "done");
    editor.socket.close(1000, "done");
    viewer.socket.close(1000, "done");
  });

  it("keeps room and stop capacity available after one connection floods spotlight updates", async () => {
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.transactionSync(() => {
        durableState.storage.sql.exec(
          `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
           VALUES (?, 'viewer', 'Viewer', ?, ?)`,
          studentId,
          now,
          now,
        );
        durableState.storage.sql.exec("UPDATE board SET acl_version = 3");
      });
    });

    const flooder = await connect(stub, actorId);
    const teacher = await connect(stub, editorId);
    const observer = await connect(stub, studentId);
    const floodSpotlightId = "018f0000-0000-7000-8000-000000000933";
    const floodFrame = JSON.stringify({
      v: 1,
      t: "client.facilitation.spotlight",
      spotlightId: floodSpotlightId,
      active: true,
      viewport: { center: { x: 10, y: 20 }, zoom: 1 },
    });
    for (let index = 0; index < 400; index += 1) flooder.socket.send(floodFrame);

    const teacherSpotlightId = "018f0000-0000-7000-8000-000000000934";
    teacher.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.facilitation.spotlight",
        spotlightId: teacherSpotlightId,
        active: true,
        viewport: { center: { x: 400, y: 250 }, zoom: 1.5 },
      }),
    );
    flooder.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.facilitation.spotlight",
        spotlightId: floodSpotlightId,
        active: false,
      }),
    );

    const [teacherFrame, stopFrame] = await Promise.all([
      observer.next(
        (frame) =>
          frame.t === "server.facilitation.spotlight" && frame.spotlightId === teacherSpotlightId,
      ),
      observer.next(
        (frame) =>
          frame.t === "server.facilitation.spotlight" &&
          frame.spotlightId === floodSpotlightId &&
          frame.active === false,
      ),
    ]);
    expect(teacherFrame).toMatchObject({
      active: true,
      actor: { id: editorId, displayName: "Editor" },
      viewport: { center: { x: 400, y: 250 }, zoom: 1.5 },
    });
    expect(stopFrame).toMatchObject({
      active: false,
      actor: { id: actorId, displayName: "Owner 1" },
    });

    flooder.socket.close(1000, "done");
    teacher.socket.close(1000, "done");
    observer.socket.close(1000, "done");
  });
});

function loggedEvents(
  output: { mock: { calls: unknown[][] } },
  event: string,
): Array<Record<string, unknown>> {
  return output.mock.calls
    .map((call) => call[0])
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>).event === event,
    );
}

describe("object comments", () => {
  afterEach(async () => reset());
  it("keeps comments attached through moves, orphans them on delete, and resolves them", async () => {
    const stub = env.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000c01";

    owner.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000c02",
          "018f0000-0000-7000-8000-000000000c03",
          itemId,
        ),
      ),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const createdResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, body: "Please align this with the heading." }),
      }),
    );
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as Record<string, unknown>;
    expect(created).toMatchObject({
      itemId,
      body: "Please align this with the heading.",
      state: "open",
      author: { id: actorId, displayName: "Owner 1" },
    });
    const commentId = String(created.id);
    expect(commentId).toMatch(/^c_[A-Za-z0-9_-]{22}$/u);
    await owner.next((frame) => frame.t === "server.comments.refresh");

    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000c04",
        actionId: "018f0000-0000-7000-8000-000000000c05",
        baseSeq: 1,
        op: {
          kind: "item.update",
          itemId,
          expectedVersion: 1,
          patch: { transform: [1, 0, 0, 1, 80, 45] },
        },
      }),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 2);
    const afterMove = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/comments`));
    expect(await afterMove.json()).toMatchObject({
      comments: [{ id: commentId, itemId, state: "open" }],
    });

    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000c06",
        actionId: "018f0000-0000-7000-8000-000000000c07",
        baseSeq: 2,
        op: { kind: "item.delete", itemId, expectedVersion: 2 },
      }),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 3);
    await owner.next((frame) => frame.t === "server.comments.refresh");
    const afterDelete = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/comments`));
    expect(await afterDelete.json()).toMatchObject({
      comments: [{ id: commentId, itemId, state: "orphaned" }],
    });

    const resolvedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments/${commentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "resolved" }),
      }),
    );
    expect(resolvedResponse.status).toBe(200);
    expect(await resolvedResponse.json()).toMatchObject({
      id: commentId,
      itemId,
      state: "resolved",
      resolvedBy: { id: actorId, displayName: "Owner 1" },
    });
    owner.socket.close(1000, "done");
  });

  it("rejects comments for missing objects and invalid state transitions", async () => {
    const stub = env.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const missing = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId: "018f0000-0000-7000-8000-000000000c08",
          body: "This target is gone.",
        }),
      }),
    );
    expect(missing.status).toBe(404);

    const invalidTransition = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments/c_${"A".repeat(22)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "open" }),
      }),
    );
    expect(invalidTransition.status).toBe(400);
  });

  it("carries a stored picture or a public video on a comment", async () => {
    const stub = env.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const enableImages = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { images: true }, expectedAclVersion: 1 }),
      }),
    );
    expect(enableImages.status).toBe(200);
    await enableImages.arrayBuffer();

    const owner = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000c60";
    owner.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000c61",
          "018f0000-0000-7000-8000-000000000c62",
          itemId,
        ),
      ),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const uploaded = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/assets`, {
        method: "POST",
        headers: { "content-type": "image/gif" },
        body: Uint8Array.from(
          atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="),
          (character) => character.charCodeAt(0),
        ),
      }),
    );
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { assetId } = (await uploaded.json()) as { assetId: string };
    const image = {
      kind: "image",
      assetId,
      mimeType: "image/gif",
      intrinsicWidth: 1,
      intrinsicHeight: 1,
      alt: "  A single grey pixel  ",
    };

    const withImage = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, body: "Compare with this.", media: image }),
      }),
    );
    expect(withImage.status, await withImage.clone().text()).toBe(201);
    expect(await withImage.json()).toMatchObject({
      media: { ...image, alt: "A single grey pixel" },
    });

    const withVideo = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId,
          body: "This clip covers the same step.",
          media: { kind: "video", url: "https://youtu.be/dQw4w9WgXcQ" },
        }),
      }),
    );
    expect(withVideo.status, await withVideo.clone().text()).toBe(201);
    expect(await withVideo.json()).toMatchObject({
      media: { kind: "video", provider: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" },
    });

    const listed = (await (
      await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/comments`))
    ).json()) as { comments: Record<string, unknown>[] };
    expect(listed.comments).toHaveLength(2);
    expect(listed.comments[0]?.media).toMatchObject({ kind: "image", assetId });
    expect(listed.comments[1]?.media).toMatchObject({ kind: "video" });

    // A picture must be one this board already holds, at the size the board stored.
    const unknownAsset = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId,
          body: "Elsewhere.",
          // Canonical, but never stored on this board.
          media: { ...image, assetId: `asset_${"M".repeat(42)}Q` },
        }),
      }),
    );
    expect(unknownAsset.status).toBe(404);

    const wrongSize = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, body: "Resized.", media: { ...image, intrinsicWidth: 2 } }),
      }),
    );
    expect(wrongSize.status).toBe(404);

    const notAVideo = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId,
          body: "Watch.",
          media: { kind: "video", url: "https://example.com/clip.mp4" },
        }),
      }),
    );
    expect(notAVideo.status).toBe(400);

    const disableImages = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ features: { images: false }, expectedAclVersion: 2 }),
      }),
    );
    expect(disableImages.status, await disableImages.clone().text()).toBe(200);
    await disableImages.arrayBuffer();

    const afterDisable = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, body: "Still?", media: image }),
      }),
    );
    expect(afterDisable.status).toBe(403);
  });

  it("stores writer metadata on assisted comments and keeps it through resolve", async () => {
    const stub = env.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000c30";
    owner.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000c31",
          "018f0000-0000-7000-8000-000000000c32",
          itemId,
        ),
      ),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const assistedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemId,
          body: "Step 2 drops the negative sign.",
          assistedBy: "ai",
          assistance: { tool: "comment_on_watched_step", action: "critique" },
        }),
      }),
    );
    expect(assistedResponse.status).toBe(201);
    const assisted = (await assistedResponse.json()) as Record<string, unknown>;
    expect(assisted).toMatchObject({
      itemId,
      state: "open",
      author: { id: actorId, displayName: "Owner 1" },
      assistedBy: "ai",
      assistance: { tool: "comment_on_watched_step", action: "critique" },
    });
    await owner.next((frame) => frame.t === "server.comments.refresh");

    const typedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, body: "I typed this one myself." }),
      }),
    );
    expect(typedResponse.status).toBe(201);
    const typed = (await typedResponse.json()) as Record<string, unknown>;
    expect(typed).not.toHaveProperty("assistedBy");
    expect(typed).not.toHaveProperty("assistance");
    await owner.next((frame) => frame.t === "server.comments.refresh");

    const listed = (await (
      await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/comments`))
    ).json()) as { comments: Record<string, unknown>[] };
    expect(listed.comments).toHaveLength(2);
    expect(listed.comments[0]).toMatchObject({
      id: assisted.id,
      assistedBy: "ai",
      assistance: { tool: "comment_on_watched_step", action: "critique" },
    });
    expect(listed.comments[1]).not.toHaveProperty("assistedBy");
    expect(listed.comments[1]).not.toHaveProperty("assistance");

    const resolvedResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments/${String(assisted.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "resolved" }),
      }),
    );
    expect(resolvedResponse.status).toBe(200);
    expect(await resolvedResponse.json()).toMatchObject({
      id: assisted.id,
      state: "resolved",
      resolvedBy: { id: actorId, displayName: "Owner 1" },
      assistedBy: "ai",
      assistance: { tool: "comment_on_watched_step", action: "critique" },
    });
    owner.socket.close(1000, "done");
  });

  it("rejects malformed comment writer metadata", async () => {
    const stub = env.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000c40";
    owner.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000c41",
          "018f0000-0000-7000-8000-000000000c42",
          itemId,
        ),
      ),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const post = (extra: Record<string, unknown>) =>
      stub.fetch(
        internalRequest(`/api/v1/boards/${boardId}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemId, body: "Looks fine to me.", ...extra }),
        }),
      );
    const cases: Record<string, unknown>[] = [
      { assistance: { tool: "comment_on_watched_step" } },
      { assistedBy: "ai" },
      { assistedBy: "human", assistance: { tool: "comment_on_watched_step" } },
      { assistedBy: "ai", assistance: "comment_on_watched_step" },
      { assistedBy: "ai", assistance: {} },
      { assistedBy: "ai", assistance: { tool: "Comment-On-Watched-Step" } },
      { assistedBy: "ai", assistance: { tool: `t${"o".repeat(64)}` } },
      { assistedBy: "ai", assistance: { tool: "comment_on_watched_step", action: "grade" } },
      { assistedBy: "ai", assistance: { tool: "comment_on_watched_step", stepAlias: "step_1" } },
    ];
    for (const extra of cases) {
      const response = await post(extra);
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    const listed = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/comments`));
    expect(await listed.json()).toEqual({ comments: [] });
    owner.socket.close(1000, "done");
  });

  it("rejects comment bodies containing unpaired surrogates", async () => {
    const stub = env.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000c20";
    owner.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000c21",
          "018f0000-0000-7000-8000-000000000c22",
          itemId,
        ),
      ),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const loneSurrogate = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, body: "unpaired\ud800 surrogate" }),
      }),
    );
    expect(loneSurrogate.status).toBe(400);
    const listed = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/comments`));
    expect(await listed.json()).toEqual({ comments: [] });
    owner.socket.close(1000, "done");
  });

  it("gates comment creation like drawing and resolution to the author or an owner", async () => {
    const stub = env.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    await addEditor(stub);
    await runInDurableObject(stub, (_instance, durableState) => {
      const now = Date.now();
      durableState.storage.sql.exec(
        `INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms)
         VALUES (?, 'viewer', 'Viewer', ?, ?)`,
        coOwnerId,
        now,
        now,
      );
    });
    const owner = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000c30";
    owner.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000c31",
          "018f0000-0000-7000-8000-000000000c32",
          itemId,
        ),
      ),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const createAs = (actor: string, body: string) =>
      stub.fetch(
        internalActorRequest(actor, `/api/v1/boards/${boardId}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ itemId, body }),
        }),
      );
    const resolveAs = (actor: string, commentId: string) =>
      stub.fetch(
        internalActorRequest(actor, `/api/v1/boards/${boardId}/comments/${commentId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: "resolved" }),
        }),
      );

    // studentId is not a member; on a link_view board it is an anonymous viewer.
    const anonymous = await createAs(studentId, "Anonymous viewers cannot comment.");
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    const viewer = await createAs(coOwnerId, "Viewer members cannot comment.");
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const ownerCreated = await createAs(actorId, "Owner comment.");
    expect(ownerCreated.status).toBe(201);
    const ownerCommentId = String(((await ownerCreated.json()) as { id: string }).id);
    const editorCreated = await createAs(editorId, "Editor comment.");
    expect(editorCreated.status).toBe(201);
    const editorCommentId = String(((await editorCreated.json()) as { id: string }).id);

    const editorOnOwners = await resolveAs(editorId, ownerCommentId);
    expect(editorOnOwners.status).toBe(403);
    expect(await editorOnOwners.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    const viewerOnEditors = await resolveAs(coOwnerId, editorCommentId);
    expect(viewerOnEditors.status).toBe(403);
    expect(await viewerOnEditors.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    const anonymousOnEditors = await resolveAs(studentId, editorCommentId);
    expect(anonymousOnEditors.status).toBe(403);
    await anonymousOnEditors.arrayBuffer();

    const listed = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/comments`));
    expect(await listed.json()).toMatchObject({
      comments: [
        { id: ownerCommentId, state: "open" },
        { id: editorCommentId, state: "open" },
      ],
    });

    const editorOnOwn = await resolveAs(editorId, editorCommentId);
    expect(editorOnOwn.status).toBe(200);
    expect(await editorOnOwn.json()).toMatchObject({
      id: editorCommentId,
      state: "resolved",
      resolvedBy: { id: editorId, displayName: "Editor" },
    });

    const secondEditorCreated = await createAs(editorId, "Second editor comment.");
    expect(secondEditorCreated.status).toBe(201);
    const secondEditorCommentId = String(((await secondEditorCreated.json()) as { id: string }).id);
    const ownerOnEditors = await resolveAs(actorId, secondEditorCommentId);
    expect(ownerOnEditors.status).toBe(200);
    expect(await ownerOnEditors.json()).toMatchObject({
      id: secondEditorCommentId,
      state: "resolved",
      resolvedBy: { id: actorId, displayName: "Owner 1" },
    });

    // A locked board keeps accepting comments from drawing roles, never from viewers.
    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec("UPDATE board SET drawing_policy = 'locked'");
    });
    const lockedEditor = await createAs(editorId, "Editors comment on a locked board.");
    expect(lockedEditor.status).toBe(201);
    await lockedEditor.arrayBuffer();
    const lockedOwner = await createAs(actorId, "Owners comment on a locked board.");
    expect(lockedOwner.status).toBe(201);
    await lockedOwner.arrayBuffer();
    const lockedViewer = await createAs(coOwnerId, "Viewers still cannot comment.");
    expect(lockedViewer.status).toBe(403);
    expect(await lockedViewer.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    owner.socket.close(1000, "done");
  });

  it("reopens orphaned comments when undo, redo, or restore brings the object back", async () => {
    const stub = env.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub);
    const owner = await connect(stub, actorId);
    const itemId = "018f0000-0000-7000-8000-000000000c40";
    owner.socket.send(
      JSON.stringify(
        createCommit(
          "018f0000-0000-7000-8000-000000000c41",
          "018f0000-0000-7000-8000-000000000c42",
          itemId,
        ),
      ),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 1);

    const createdResponse = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ itemId, body: "Still relevant after undo." }),
      }),
    );
    expect(createdResponse.status).toBe(201);
    const commentId = String(((await createdResponse.json()) as { id: string }).id);
    await owner.next((frame) => frame.t === "server.comments.refresh");

    const snapshot = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/snapshots`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "comment-restore-snapshot-0001",
        },
        body: JSON.stringify({ label: "Before delete" }),
      }),
    );
    expect(snapshot.status).toBe(201);
    await snapshot.arrayBuffer();

    const expectComments = async (state: string) => {
      const response = await stub.fetch(internalRequest(`/api/v1/boards/${boardId}/comments`));
      expect(await response.json()).toMatchObject({ comments: [{ id: commentId, itemId, state }] });
    };

    const deleteActionId = "018f0000-0000-7000-8000-000000000c44";
    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000c43",
        actionId: deleteActionId,
        baseSeq: 1,
        op: { kind: "item.delete", itemId, expectedVersion: 1 },
      }),
    );
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 2);
    await owner.next((frame) => frame.t === "server.comments.refresh");
    await expectComments("orphaned");

    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000c45",
        actionId: "018f0000-0000-7000-8000-000000000c46",
        baseSeq: 2,
        op: { kind: "history.undo", expectedHistoryVersion: 2, targetActionId: deleteActionId },
      }),
    );
    const undone = await owner.next((frame) => frame.t === "server.action" && frame.seq === 3);
    expect(undone).toMatchObject({
      op: { changes: [{ kind: "item.replace", item: { id: itemId } }] },
    });
    await owner.next((frame) => frame.t === "server.comments.refresh");
    await expectComments("open");

    owner.socket.send(
      JSON.stringify({
        v: 1,
        t: "client.commit",
        commandId: "018f0000-0000-7000-8000-000000000c47",
        actionId: "018f0000-0000-7000-8000-000000000c48",
        baseSeq: 3,
        op: { kind: "history.redo", expectedHistoryVersion: 3, targetActionId: deleteActionId },
      }),
    );
    const redone = await owner.next((frame) => frame.t === "server.action" && frame.seq === 4);
    expect(redone).toMatchObject({
      op: { changes: [{ kind: "item.remove", itemId }] },
    });
    await owner.next((frame) => frame.t === "server.comments.refresh");
    await expectComments("orphaned");

    const restored = await stub.fetch(
      internalRequest(`/api/v1/boards/${boardId}/restore/1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "comment-restore-apply-0002",
        },
        body: JSON.stringify({ expectedBoardSeq: 4 }),
      }),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ seq: 5 });
    await owner.next((frame) => frame.t === "server.action" && frame.seq === 5);
    await owner.next((frame) => frame.t === "server.comments.refresh");
    await expectComments("open");
    owner.socket.close(1000, "done");
  });
});

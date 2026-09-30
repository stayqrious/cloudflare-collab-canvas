/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_IMAGE_ASSET_BYTES } from "./image-assets";
import type { Env } from "./types";

const ownerId = "a_IIIIIIIIIIIIIIIIIIIIII";
const editorId = "a_JJJJJJJJJJJJJJJJJJJJJJ";
const viewerId = "a_KKKKKKKKKKKKKKKKKKKKKK";
let boardSequence = 0;

function nextBoardId(): string {
  boardSequence += 1;
  return `b_${String(boardSequence).padStart(22, "0")}`;
}

function internalRequest(actorId: string, path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("x-whiteboard-internal-actor", actorId);
  headers.set("x-whiteboard-internal-session-expiry", String(Date.now() + 60_000));
  headers.set("x-whiteboard-internal-request-id", crypto.randomUUID());
  return new Request(`https://board.test${path}`, { ...init, headers });
}

async function initializeBoard(stub: DurableObjectStub, boardId: string): Promise<void> {
  const response = await stub.fetch(
    internalRequest(ownerId, "/__internal/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicId: boardId,
        title: "Private image test",
        accessMode: "private",
        ownerActorId: ownerId,
        ownerDisplayName: "Image owner",
        ownerRecoveryHash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    }),
  );
  expect(response.status).toBe(201);
  await response.arrayBuffer();
}

async function setPolicy(
  stub: DurableObjectStub,
  boardId: string,
  expectedAclVersion: number,
  values: { imagesEnabled?: boolean; drawingPolicy?: "editors_enabled" | "owner_only" | "locked" },
): Promise<Response> {
  return stub.fetch(
    internalRequest(ownerId, `/api/v1/boards/${boardId}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedAclVersion, ...values }),
    }),
  );
}

async function addMembers(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const now = Date.now();
    state.storage.sql.exec(
      "INSERT INTO members(actor_id, role, display_name, created_at_ms, updated_at_ms) VALUES (?, 'editor', 'Editor', ?, ?), (?, 'viewer', 'Viewer', ?, ?)",
      editorId,
      now,
      now,
      viewerId,
      now,
      now,
    );
  });
}

function staticGif(tag?: number): Uint8Array {
  const base = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs="), (value) =>
    value.charCodeAt(0),
  );
  if (tag === undefined) return base;
  base[13] = tag;
  return base;
}

function upload(
  stub: DurableObjectStub,
  boardId: string,
  actorId: string,
  bytes: Uint8Array,
  contentType = "image/gif",
): Promise<Response> {
  return stub.fetch(
    internalRequest(actorId, `/api/v1/boards/${boardId}/assets`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes,
    }),
  );
}

describe("private board image assets", () => {
  it("defaults images on and enforces the toggle, role, owner policy, and board lock at commit time", async () => {
    const boardId = nextBoardId();
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub, boardId);
    await addMembers(stub);

    expect((await upload(stub, boardId, ownerId, staticGif())).status).toBe(201);
    const disabled = await setPolicy(stub, boardId, 1, { imagesEnabled: false });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      board: { imagesEnabled: false, aclVersion: 2 },
    });
    expect((await upload(stub, boardId, ownerId, staticGif(1))).status).toBe(403);
    const enabled = await setPolicy(stub, boardId, 2, { imagesEnabled: true });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      board: { imagesEnabled: true, aclVersion: 3 },
    });

    expect((await upload(stub, boardId, viewerId, staticGif())).status).toBe(403);
    expect((await upload(stub, boardId, editorId, staticGif(1))).status).toBe(201);
    expect((await setPolicy(stub, boardId, 3, { drawingPolicy: "owner_only" })).status).toBe(200);
    expect((await upload(stub, boardId, editorId, staticGif(2))).status).toBe(403);
    expect((await upload(stub, boardId, ownerId, staticGif(3))).status).toBe(201);
    expect((await setPolicy(stub, boardId, 4, { drawingPolicy: "locked" })).status).toBe(200);
    expect((await upload(stub, boardId, ownerId, staticGif(4))).status).toBe(403);
  });

  it("deduplicates immutable bytes and keeps raw data only in the private asset bucket", async () => {
    const boardId = nextBoardId();
    const typedEnv = env as unknown as Env;
    const stub = typedEnv.BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub, boardId);
    expect((await setPolicy(stub, boardId, 1, { imagesEnabled: true })).status).toBe(200);

    const first = await upload(stub, boardId, ownerId, staticGif());
    expect(first.status).toBe(201);
    const metadata = (await first.json()) as {
      assetId: string;
      mimeType: string;
      intrinsicWidth: number;
      intrinsicHeight: number;
      sizeBytes: number;
    };
    expect(metadata).toEqual({
      assetId: expect.stringMatching(/^asset_[A-Za-z0-9_-]{43}$/u),
      mimeType: "image/gif",
      intrinsicWidth: 1,
      intrinsicHeight: 1,
      sizeBytes: staticGif().byteLength,
    });
    const duplicate = await upload(stub, boardId, ownerId, staticGif());
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual(metadata);

    const key = `boards/${boardId}/assets/${metadata.assetId}`;
    expect(await typedEnv.BOARD_ASSETS.head(key)).not.toBeNull();
    expect(await typedEnv.BOARD_SNAPSHOTS.head(key)).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM board_assets").one().count).toBe(
        1,
      );
    });
  });

  it("re-authenticates reads, isolates board keys, and emits safe private response headers", async () => {
    const firstBoardId = nextBoardId();
    const secondBoardId = nextBoardId();
    const typedEnv = env as unknown as Env;
    const first = typedEnv.BOARD_ROOMS.getByName(firstBoardId);
    const second = typedEnv.BOARD_ROOMS.getByName(secondBoardId);
    await initializeBoard(first, firstBoardId);
    await initializeBoard(second, secondBoardId);
    await addMembers(first);
    expect((await setPolicy(first, firstBoardId, 1, { imagesEnabled: true })).status).toBe(200);
    const uploaded = (await (await upload(first, firstBoardId, ownerId, staticGif())).json()) as {
      assetId: string;
    };

    const readable = await first.fetch(
      internalRequest(viewerId, `/api/v1/boards/${firstBoardId}/assets/${uploaded.assetId}`),
    );
    expect(readable.status).toBe(200);
    expect(readable.headers.get("content-type")).toBe("image/gif");
    expect(readable.headers.get("cache-control")).toBe("private, no-store");
    expect(readable.headers.get("x-content-type-options")).toBe("nosniff");
    expect(readable.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await readable.arrayBuffer())).toEqual(staticGif());

    const outsider = "a_LLLLLLLLLLLLLLLLLLLLLL";
    expect(
      (
        await first.fetch(
          internalRequest(outsider, `/api/v1/boards/${firstBoardId}/assets/${uploaded.assetId}`),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await second.fetch(
          internalRequest(ownerId, `/api/v1/boards/${secondBoardId}/assets/${uploaded.assetId}`),
        )
      ).status,
    ).toBe(404);
    expect(
      await typedEnv.BOARD_ASSETS.head(`boards/${secondBoardId}/assets/${uploaded.assetId}`),
    ).toBeNull();
  });

  it("rejects MIME confusion, SVG/polyglot bytes, animation, oversized dimensions, and trailing data", async () => {
    const boardId = nextBoardId();
    const stub = (env as unknown as Env).BOARD_ROOMS.getByName(boardId);
    await initializeBoard(stub, boardId);
    expect((await setPolicy(stub, boardId, 1, { imagesEnabled: true })).status).toBe(200);

    expect((await upload(stub, boardId, ownerId, staticGif(), "image/png")).status).toBe(400);
    expect(
      (
        await upload(
          stub,
          boardId,
          ownerId,
          new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          "image/png",
        )
      ).status,
    ).toBe(400);
    expect(
      (await upload(stub, boardId, ownerId, staticGif(), "image/gif; charset=utf-8")).status,
    ).toBe(415);

    const imageBlock = staticGif().subarray(19, staticGif().byteLength - 1);
    const animated = Uint8Array.from([
      ...staticGif().subarray(0, staticGif().byteLength - 1),
      ...imageBlock,
      0x3b,
    ]);
    expect((await upload(stub, boardId, ownerId, animated)).status).toBe(400);
    expect(
      (
        await upload(
          stub,
          boardId,
          ownerId,
          Uint8Array.from([...staticGif(), ...new TextEncoder().encode("<script>")]),
        )
      ).status,
    ).toBe(400);

    const oversized = staticGif();
    oversized[6] = 0x01;
    oversized[7] = 0x10;
    expect((await upload(stub, boardId, ownerId, oversized)).status).toBe(400);

    expect(
      (await upload(stub, boardId, ownerId, new Uint8Array(MAX_IMAGE_ASSET_BYTES + 1))).status,
    ).toBe(413);
  });

  it("enforces count and byte quotas, including concurrent reservations", async () => {
    const countBoardId = nextBoardId();
    const typedEnv = env as unknown as Env;
    const countStub = typedEnv.BOARD_ROOMS.getByName(countBoardId);
    await initializeBoard(countStub, countBoardId);
    expect((await setPolicy(countStub, countBoardId, 1, { imagesEnabled: true })).status).toBe(200);
    await insertQuotaRows(countStub, 25, 1);
    expect((await upload(countStub, countBoardId, ownerId, staticGif())).status).toBe(413);

    const bytesBoardId = nextBoardId();
    const bytesStub = typedEnv.BOARD_ROOMS.getByName(bytesBoardId);
    await initializeBoard(bytesStub, bytesBoardId);
    expect((await setPolicy(bytesStub, bytesBoardId, 1, { imagesEnabled: true })).status).toBe(200);
    await insertQuotaRows(bytesStub, 12, 5 * 1_024 * 1_024);
    await insertQuotaRows(bytesStub, 1, 4 * 1_024 * 1_024 - 1, 12);
    expect((await upload(bytesStub, bytesBoardId, ownerId, staticGif())).status).toBe(413);

    const concurrentBoardId = nextBoardId();
    const concurrentStub = typedEnv.BOARD_ROOMS.getByName(concurrentBoardId);
    await initializeBoard(concurrentStub, concurrentBoardId);
    expect(
      (await setPolicy(concurrentStub, concurrentBoardId, 1, { imagesEnabled: true })).status,
    ).toBe(200);
    await insertQuotaRows(concurrentStub, 24, 1);
    const statuses = await Promise.all([
      upload(concurrentStub, concurrentBoardId, ownerId, staticGif(20)),
      upload(concurrentStub, concurrentBoardId, ownerId, staticGif(21)),
    ]);
    expect(statuses.map((response) => response.status).sort()).toEqual([201, 413]);
  });
});

async function insertQuotaRows(
  stub: DurableObjectStub,
  count: number,
  byteCount: number,
  offset = 0,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    for (let index = 0; index < count; index += 1) {
      const value = (offset + index).toString(36).padStart(43, "0");
      state.storage.sql.exec(
        "INSERT INTO board_assets(asset_id, sha256, r2_key, mime_type, intrinsic_width, intrinsic_height, byte_count, state, created_by, created_at_ms, committed_at_ms) VALUES (?, ?, ?, 'image/gif', 1, 1, ?, 'committed', ?, ?, ?)",
        `asset_${value}`,
        value,
        `quota/${value}`,
        byteCount,
        ownerId,
        Date.now(),
        Date.now(),
      );
    }
  });
}

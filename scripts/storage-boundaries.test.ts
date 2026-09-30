import { describe, expect, it, vi } from "vitest";
import {
  getR2Object,
  isSqliteFullError,
  mapSqliteFullError,
  putImmutableR2Object,
  type R2PutValue,
  readR2ObjectBytes,
  SQLITE_FULL_CAUSE_CHAIN_LIMIT,
} from "../apps/edge/src/storage-boundaries";

const DIGEST = "exact-base64url-sha256";
const KEY = "boards/board-1/snapshots/42.json";
const VALUE = new Uint8Array([1, 2, 3]);

type HeadMock = (key: string) => Promise<R2Object | null>;
type PutMock = (key: string, value: R2PutValue, options?: R2PutOptions) => Promise<R2Object | null>;

function objectWithSha256(sha256: string | undefined): R2Object {
  return {
    customMetadata: sha256 === undefined ? undefined : { sha256 },
  } as unknown as R2Object;
}

function bucketWith(
  head: ReturnType<typeof vi.fn<HeadMock>>,
  put: ReturnType<typeof vi.fn<PutMock>>,
): R2Bucket {
  return { head, put } as unknown as R2Bucket;
}

function expectUnavailable(promise: Promise<unknown>, message: string) {
  return expect(promise).rejects.toMatchObject({
    name: "HttpError",
    status: 503,
    code: "TEMPORARILY_UNAVAILABLE",
    message,
  });
}

describe("putImmutableR2Object", () => {
  it("accepts an exact pre-existing SHA-256 without issuing a PUT", async () => {
    const existing = objectWithSha256(DIGEST);
    const head = vi.fn<HeadMock>().mockResolvedValue(existing);
    const put = vi.fn<PutMock>();

    const result = await putImmutableR2Object(bucketWith(head, put), KEY, VALUE, {
      sha256: DIGEST,
    });

    expect(result).toEqual({ disposition: "preexisting", object: existing });
    expect(head).toHaveBeenCalledWith(KEY);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a pre-existing object whose SHA-256 metadata differs", async () => {
    const head = vi.fn<HeadMock>().mockResolvedValue(objectWithSha256("different"));
    const put = vi.fn<PutMock>();

    await expectUnavailable(
      putImmutableR2Object(bucketWith(head, put), KEY, VALUE, { sha256: DIGEST }),
      "Immutable snapshot storage conflict.",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("creates through a literal If-None-Match:* condition and exact metadata", async () => {
    const created = objectWithSha256(DIGEST);
    const head = vi.fn<HeadMock>().mockResolvedValue(null);
    const put = vi.fn<PutMock>().mockResolvedValue(created);
    const httpMetadata: R2HTTPMetadata = { contentType: "application/json; charset=utf-8" };

    const result = await putImmutableR2Object(bucketWith(head, put), KEY, VALUE, {
      sha256: DIGEST,
      httpMetadata,
    });

    expect(result).toEqual({ disposition: "created", object: created });
    expect(put).toHaveBeenCalledTimes(1);
    const [key, value, options] = put.mock.calls[0] ?? [];
    expect(key).toBe(KEY);
    expect(value).toBe(VALUE);
    const onlyIf = options?.onlyIf;
    expect(onlyIf).toBeInstanceOf(Headers);
    if (!(onlyIf instanceof Headers)) throw new Error("Expected conditional headers.");
    expect(onlyIf.get("If-None-Match")).toBe("*");
    expect(options?.customMetadata).toEqual({ sha256: DIGEST });
    expect(options?.httpMetadata).toBe(httpMetadata);
  });

  it("accepts a lost race only when the winner has the exact SHA-256", async () => {
    const winner = objectWithSha256(DIGEST);
    const head = vi.fn<HeadMock>().mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    const put = vi.fn<PutMock>().mockResolvedValue(null);

    const result = await putImmutableR2Object(bucketWith(head, put), KEY, VALUE, {
      sha256: DIGEST,
    });

    expect(result).toEqual({ disposition: "lost-race", object: winner });
    expect(head).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("rejects a lost race when the winner has different SHA-256 metadata", async () => {
    const head = vi
      .fn<HeadMock>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(objectWithSha256("different"));
    const put = vi.fn<PutMock>().mockResolvedValue(null);

    await expectUnavailable(
      putImmutableR2Object(bucketWith(head, put), KEY, VALUE, { sha256: DIGEST }),
      "Immutable snapshot storage conflict.",
    );
  });

  it("maps initial HEAD binding failures to a fixed unavailable error", async () => {
    const head = vi.fn<HeadMock>().mockRejectedValue(new Error("provider detail 10001"));
    const put = vi.fn<PutMock>();

    await expectUnavailable(
      putImmutableR2Object(bucketWith(head, put), KEY, VALUE, { sha256: DIGEST }),
      "Snapshot storage is temporarily unavailable.",
    );
  });

  it("maps PUT binding failures to a fixed unavailable error", async () => {
    const head = vi.fn<HeadMock>().mockResolvedValue(null);
    const put = vi.fn<PutMock>().mockRejectedValue(new Error("provider detail 10001"));

    await expectUnavailable(
      putImmutableR2Object(bucketWith(head, put), KEY, VALUE, { sha256: DIGEST }),
      "Snapshot storage is temporarily unavailable.",
    );
  });

  it("maps lost-race reconciliation failures to a fixed unavailable error", async () => {
    const head = vi
      .fn<HeadMock>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("provider detail 10001"));
    const put = vi.fn<PutMock>().mockResolvedValue(null);

    await expectUnavailable(
      putImmutableR2Object(bucketWith(head, put), KEY, VALUE, { sha256: DIGEST }),
      "Snapshot storage is temporarily unavailable.",
    );
  });

  it("treats a conditional null without a visible winner as unavailable", async () => {
    const head = vi.fn<HeadMock>().mockResolvedValue(null);
    const put = vi.fn<PutMock>().mockResolvedValue(null);

    await expectUnavailable(
      putImmutableR2Object(bucketWith(head, put), KEY, VALUE, { sha256: DIGEST }),
      "Snapshot storage is temporarily unavailable.",
    );
  });
});

describe("R2 reads", () => {
  it("returns an object or null without changing successful reads", async () => {
    const object = objectWithSha256(DIGEST) as R2ObjectBody;
    const get = vi.fn<(key: string) => Promise<R2ObjectBody | null>>().mockResolvedValue(object);

    await expect(getR2Object({ get } as unknown as R2Bucket, KEY)).resolves.toBe(object);
    expect(get).toHaveBeenCalledWith(KEY);
  });

  it("maps GET and body-read failures to the fixed unavailable response", async () => {
    const get = vi
      .fn<(key: string) => Promise<R2ObjectBody | null>>()
      .mockRejectedValue(new Error("provider GET detail"));
    await expectUnavailable(
      getR2Object({ get } as unknown as R2Bucket, KEY),
      "Snapshot storage is temporarily unavailable.",
    );

    const object = {
      arrayBuffer: vi
        .fn<() => Promise<ArrayBuffer>>()
        .mockRejectedValue(new Error("stream detail")),
    } as unknown as R2ObjectBody;
    await expectUnavailable(
      readR2ObjectBytes(object),
      "Snapshot storage is temporarily unavailable.",
    );
  });
});

describe("SQLITE_FULL mapping", () => {
  it("maps Cloudflare's documented message to a fixed 503 HttpError", () => {
    const mapped = mapSqliteFullError(new Error("database or disk is full: SQLITE_FULL"));

    expect(mapped).toMatchObject({
      name: "HttpError",
      status: 503,
      code: "TEMPORARILY_UNAVAILABLE",
      message: "Board storage is temporarily unavailable.",
    });
    expect(mapped?.details).toBeUndefined();
  });

  it("detects the documented marker through nested causes", () => {
    const storageError = new Error("database or disk is full: SQLITE_FULL");
    const wrapped = new Error("transaction failed", {
      cause: new Error("storage failed", { cause: storageError }),
    });

    expect(isSqliteFullError(wrapped)).toBe(true);
  });

  it("inspects at most the fixed cause-chain bound", () => {
    let lastVisible: unknown = { message: "database or disk is full: SQLITE_FULL" };
    for (let index = 1; index < SQLITE_FULL_CAUSE_CHAIN_LIMIT; index += 1) {
      lastVisible = { message: "wrapper", cause: lastVisible };
    }

    let beyondBound: unknown = { message: "database or disk is full: SQLITE_FULL" };
    for (let index = 0; index < SQLITE_FULL_CAUSE_CHAIN_LIMIT; index += 1) {
      beyondBound = { message: "wrapper", cause: beyondBound };
    }

    expect(isSqliteFullError(lastVisible)).toBe(true);
    expect(isSqliteFullError(beyondBound)).toBe(false);
  });

  it("terminates cyclic and throwing cause chains safely", () => {
    const cyclic: { message: string; cause?: unknown } = { message: "wrapper" };
    cyclic.cause = cyclic;
    const throwingCause = Object.defineProperty({ message: "wrapper" }, "cause", {
      get() {
        throw new Error("getter failure");
      },
    });

    expect(isSqliteFullError(cyclic)).toBe(false);
    expect(isSqliteFullError(throwingCause)).toBe(false);
  });

  it("returns null for unrelated errors and does not infer from a code field", () => {
    expect(mapSqliteFullError(new Error("database is busy: SQLITE_BUSY"))).toBeNull();
    expect(mapSqliteFullError({ message: "unrelated", code: "SQLITE_FULL" })).toBeNull();
    expect(mapSqliteFullError("SQLITE_FULL")).toBeNull();
  });
});

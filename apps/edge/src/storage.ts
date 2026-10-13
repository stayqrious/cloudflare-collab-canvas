import { canonicalSnapshotItemByteLength, serializeCanonicalSnapshot } from "@collab/board-core";
import type { BoardItem as ProtocolBoardItem } from "@collab/protocol";
import {
  BoardDomainError,
  canonicalItemFromUnknown,
  type ItemRecord,
  type ItemWrite,
  itemWriteFromState,
} from "./domain";
import type { BoardItem, BoardRow, CanonicalSnapshot, MemberRow, ResolvedAccess } from "./types";
import { fallbackDisplayName } from "./validation";

export interface ItemSqlRow {
  [key: string]: SqlStorageValue;
  item_id: string;
  kind: string;
  z_order: number;
  version_seq: number;
  state_token: string;
  created_by: string;
  deleted: number;
  data_json: string;
  min_x: number | null;
  min_y: number | null;
  max_x: number | null;
  max_y: number | null;
}

export interface SnapshotAccounting {
  itemCount: number;
  itemBytes: number;
}

export function readBoard(sql: SqlStorage): BoardRow | null {
  return sql.exec<BoardRow>("SELECT * FROM board WHERE singleton = 1").toArray()[0] ?? null;
}

export function readMember(sql: SqlStorage, actorId: string): MemberRow | null {
  return (
    sql
      .exec<MemberRow>(
        "SELECT actor_id, role, display_name, external_participant_id, revoked_at_ms FROM members WHERE actor_id = ?",
        actorId,
      )
      .toArray()[0] ?? null
  );
}

export function resolveAccess(sql: SqlStorage, board: BoardRow, actorId: string): ResolvedAccess {
  const member = readMember(sql, actorId);
  if (member !== null && member.revoked_at_ms === null) {
    return { role: member.role, displayName: member.display_name, canView: true };
  }
  if (board.access_mode === "link_view") {
    return { role: "viewer", displayName: fallbackDisplayName(actorId), canView: true };
  }
  return { role: "viewer", displayName: fallbackDisplayName(actorId), canView: false };
}

export function itemRecordFromRow(row: ItemSqlRow): ItemRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data_json);
  } catch {
    throw new Error("Stored item JSON is invalid.");
  }
  const item = canonicalItemFromUnknown(parsed);
  if (
    item.id !== row.item_id ||
    item.kind !== row.kind ||
    item.z !== row.z_order ||
    item.version !== row.version_seq ||
    item.createdBy !== row.created_by
  ) {
    throw new Error("Stored item columns do not agree with canonical JSON.");
  }
  return { item, deleted: row.deleted === 1, stateToken: row.state_token };
}

export function readItem(sql: SqlStorage, itemId: string): ItemRecord | undefined {
  const row = sql.exec<ItemSqlRow>("SELECT * FROM items WHERE item_id = ?", itemId).toArray()[0];
  return row === undefined ? undefined : itemRecordFromRow(row);
}

export function readItems(sql: SqlStorage, itemIds: readonly string[]): Map<string, ItemRecord> {
  const records = new Map<string, ItemRecord>();
  for (const itemId of new Set(itemIds)) {
    const record = readItem(sql, itemId);
    if (record !== undefined) records.set(itemId, record);
  }
  return records;
}

export function readLiveItems(sql: SqlStorage): BoardItem[] {
  return sql
    .exec<ItemSqlRow>("SELECT * FROM items WHERE deleted = 0 ORDER BY z_order")
    .toArray()
    .map((row) => itemRecordFromRow(row).item);
}

export function readAllItemRecords(sql: SqlStorage): Map<string, ItemRecord> {
  return new Map(
    sql
      .exec<ItemSqlRow>("SELECT * FROM items ORDER BY z_order")
      .toArray()
      .map((row) => {
        const record = itemRecordFromRow(row);
        return [record.item.id, record] as const;
      }),
  );
}

export function countLiveItems(sql: SqlStorage): number {
  return sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM items WHERE deleted = 0").one()
    .count;
}

export function snapshotAccountingForItems(items: readonly BoardItem[]): SnapshotAccounting {
  return {
    itemCount: items.length,
    itemBytes: items.reduce(
      (total, item) =>
        total + canonicalSnapshotItemByteLength(item as unknown as ProtocolBoardItem),
      0,
    ),
  };
}

export function backfillSnapshotAccounting(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  const board = readBoard(sql);
  if (
    board === null ||
    (board.snapshot_live_item_count >= 0 && board.snapshot_live_item_bytes >= 0)
  ) {
    return;
  }
  storage.transactionSync(() => {
    // `data_json` is the canonical item representation written by `writeItem`.
    // Casting TEXT to BLOB makes SQLite's length() count UTF-8 bytes rather
    // than Unicode code points, without materializing or parsing every item in
    // JavaScript during a Durable Object wake.
    const accounting = sql
      .exec<{ item_count: number; item_bytes: number }>(
        `SELECT COUNT(*) AS item_count,
          COALESCE(SUM(length(CAST(data_json AS BLOB))), 0) AS item_bytes
         FROM items WHERE deleted = 0`,
      )
      .one();
    sql.exec(
      `UPDATE board
       SET snapshot_live_item_count = ?, snapshot_live_item_bytes = ?
       WHERE singleton = 1
         AND (snapshot_live_item_count < 0 OR snapshot_live_item_bytes < 0)`,
      accounting.item_count,
      accounting.item_bytes,
    );
  });
}

export function writeItem(sql: SqlStorage, write: ItemWrite): number {
  const item = write.item;
  return sql.exec(
    `INSERT INTO items(
       item_id, kind, z_order, version_seq, state_token, created_by, deleted,
       data_json, min_x, min_y, max_x, max_y
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       kind = excluded.kind,
       z_order = excluded.z_order,
       version_seq = excluded.version_seq,
       state_token = excluded.state_token,
       created_by = excluded.created_by,
       deleted = excluded.deleted,
       data_json = excluded.data_json,
       min_x = excluded.min_x,
       min_y = excluded.min_y,
       max_x = excluded.max_x,
       max_y = excluded.max_y`,
    item.id,
    item.kind,
    item.z,
    item.version,
    write.stateToken,
    item.createdBy,
    write.deleted ? 1 : 0,
    JSON.stringify(item),
    write.bounds.minX,
    write.bounds.minY,
    write.bounds.maxX,
    write.bounds.maxY,
  ).rowsWritten;
}

export function writeLogicalState(
  sql: SqlStorage,
  itemId: string,
  state: { exists: false } | { exists: true; item: BoardItem },
  stateToken: string,
  version: number,
): ItemWrite & { rowsWritten: number } {
  const existing = readItem(sql, itemId);
  if (state.exists) {
    const item = { ...structuredClone(state.item), version };
    const write = itemWriteFromState(item, false, stateToken);
    return { ...write, rowsWritten: writeItem(sql, write) };
  }
  if (existing === undefined) {
    throw new BoardDomainError("INTERNAL_ERROR", "An undo tombstone is missing.");
  }
  const item = { ...existing.item, version };
  const write = itemWriteFromState(item, true, stateToken);
  return { ...write, rowsWritten: writeItem(sql, write) };
}

export function snapshotCreatedAt(sql: SqlStorage, board: BoardRow): number {
  return board.latest_seq === 0
    ? board.created_at_ms
    : (sql
        .exec<{ accepted_at_ms: number }>(
          "SELECT accepted_at_ms FROM actions WHERE seq = ?",
          board.latest_seq,
        )
        .toArray()[0]?.accepted_at_ms ?? board.updated_at_ms);
}

export function captureSnapshot(sql: SqlStorage, board: BoardRow): CanonicalSnapshot {
  return {
    format: "cf-whiteboard-json",
    version: 1,
    boardId: board.public_id,
    seq: board.latest_seq,
    createdAt: snapshotCreatedAt(sql, board),
    settings: { title: board.title },
    items: readLiveItems(sql),
  };
}

export function serializeSnapshot(snapshot: CanonicalSnapshot): string {
  return serializeCanonicalSnapshot({
    boardId: snapshot.boardId,
    seq: snapshot.seq,
    createdAt: snapshot.createdAt,
    settings: snapshot.settings,
    items: snapshot.items as unknown as ProtocolBoardItem[],
  });
}

export function parseStoredSnapshot(value: unknown, expectedBoardId: string): CanonicalSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BoardDomainError("INVALID_FRAME", "The recovery snapshot is invalid.");
  }
  const object = value as Record<string, unknown>;
  if (
    object.format !== "cf-whiteboard-json" ||
    object.version !== 1 ||
    object.boardId !== expectedBoardId ||
    !Number.isSafeInteger(object.seq) ||
    !Number.isSafeInteger(object.createdAt) ||
    !Array.isArray(object.items) ||
    object.items.length > 10_000
  ) {
    throw new BoardDomainError("INVALID_FRAME", "The recovery snapshot is invalid.");
  }
  const settings = object.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new BoardDomainError("INVALID_FRAME", "The recovery snapshot is invalid.");
  }
  const title = (settings as Record<string, unknown>).title;
  if (typeof title !== "string")
    throw new BoardDomainError("INVALID_FRAME", "The recovery snapshot is invalid.");
  const items = object.items.map(canonicalItemFromUnknown).sort((left, right) => left.z - right.z);
  const seenIds = new Set<string>();
  const seenZ = new Set<number>();
  for (const item of items) {
    if (seenIds.has(item.id) || seenZ.has(item.z)) {
      throw new BoardDomainError(
        "INVALID_FRAME",
        "The recovery snapshot contains duplicate items.",
      );
    }
    seenIds.add(item.id);
    seenZ.add(item.z);
  }
  return {
    format: "cf-whiteboard-json",
    version: 1,
    boardId: expectedBoardId,
    seq: object.seq as number,
    createdAt: object.createdAt as number,
    settings: { title },
    items,
  };
}

export function utcUsageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

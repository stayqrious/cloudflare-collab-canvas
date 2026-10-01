import { fallbackParticipantColor, participantColor } from "@collab/protocol";

// Public viewers do not consume membership slots. Bound their durable colour
// history too; once full, new actors receive a stable non-persisted fallback.
export const MAX_PARTICIPANT_COLORS = 10_000;
type AssignedColor = ReturnType<typeof participantColor>;
type ColorStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
type ColorRow = { actor_id: string; ordinal: number };

/** Batch lookup/allocation keeps bootstrap work constant in SQL call count. */
export function assignedParticipantColors(
  storage: ColorStorage,
  actorIds: Iterable<string>,
): Map<string, AssignedColor> {
  const ids = [...new Set(actorIds)];
  if (!ids.length) return new Map();
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const rows = sql
      .exec<ColorRow>(
        "SELECT actor_id, ordinal FROM participant_colors WHERE actor_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(ids),
      )
      .toArray();
    const colors = new Map(rows.map((row) => [row.actor_id, participantColor(row.ordinal - 1)]));
    const missing = ids.filter((id) => !colors.has(id));
    if (missing.length) {
      // Ordinals are never deleted/reused. The primary-key lookup stays cheap
      // even when an anonymous visitor arrives after the history reaches its cap.
      const lastOrdinal =
        sql
          .exec<{ ordinal: number }>(
            "SELECT ordinal FROM participant_colors ORDER BY ordinal DESC LIMIT 1",
          )
          .toArray()[0]?.ordinal ?? 0;
      const allocated = missing.slice(0, Math.max(0, MAX_PARTICIPANT_COLORS - lastOrdinal));
      if (allocated.length) {
        const inserted = sql
          .exec<ColorRow>(
            `INSERT INTO participant_colors(actor_id)
             SELECT value FROM json_each(?) ORDER BY CAST(key AS INTEGER)
             RETURNING actor_id, ordinal`,
            JSON.stringify(allocated),
          )
          .toArray();
        for (const row of inserted) colors.set(row.actor_id, participantColor(row.ordinal - 1));
      }
      for (const id of missing) {
        if (!colors.has(id)) colors.set(id, fallbackParticipantColor(id));
      }
    }
    return colors;
  });
}

/** A durable join ordinal keeps colours stable across reconnects and role changes. */
export function assignedParticipantColor(storage: ColorStorage, actorId: string): AssignedColor {
  return (
    assignedParticipantColors(storage, [actorId]).get(actorId) ?? fallbackParticipantColor(actorId)
  );
}

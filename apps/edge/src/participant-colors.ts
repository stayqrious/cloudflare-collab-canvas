import { participantColor } from "@collab/protocol";

/** A durable join ordinal keeps colours stable across reconnects and role changes. */
export function assignedParticipantColor(sql: SqlStorage, actorId: string) {
  const existing = sql
    .exec<{ ordinal: number }>("SELECT ordinal FROM participant_colors WHERE actor_id = ?", actorId)
    .toArray()[0];
  if (existing) return participantColor(existing.ordinal - 1);
  const inserted = sql
    .exec<{ ordinal: number }>(
      "INSERT INTO participant_colors(actor_id) VALUES (?) RETURNING ordinal",
      actorId,
    )
    .toArray()[0];
  if (!inserted) throw new Error("Participant colour allocation failed.");
  return participantColor(inserted.ordinal - 1);
}

import { ProtocolValidationError, validatePlainText } from "@collab/protocol";
import { HttpError } from "./http/errors";

export const BOARD_ID_PATTERN = /^b_[A-Za-z0-9_-]{22}$/u;
export const ACTOR_ID_PATTERN = /^a_[A-Za-z0-9_-]{22}$/u;
export const OPAQUE_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[A-Za-z0-9_-]{16,64})$/iu;

export function requireBoardId(value: string): string {
  if (!BOARD_ID_PATTERN.test(value)) throw new HttpError(404, "NOT_FOUND", "Board not found.");
  return value;
}

export function requireActorId(value: unknown): string {
  if (typeof value !== "string" || !ACTOR_ID_PATTERN.test(value)) {
    throw new HttpError(400, "BAD_REQUEST", "The actor ID is invalid.");
  }
  return value;
}

export function requireOpaqueId(value: unknown, field = "ID"): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) {
    throw new HttpError(400, "BAD_REQUEST", `The ${field} is invalid.`);
  }
  return value;
}

export function requireDisplayName(value: unknown): string {
  if (typeof value !== "string")
    throw new HttpError(400, "BAD_REQUEST", "Display name is required.");
  const normalized = value.trim();
  validateUnicodeText(normalized, "display name");
  const codePoints = [...normalized];
  if (codePoints.length < 1 || codePoints.length > 40 || /\p{Cc}/u.test(normalized)) {
    throw new HttpError(400, "BAD_REQUEST", "Display name must be 1 to 40 visible characters.");
  }
  return normalized;
}

export function optionalTitle(value: unknown, fallback = "Untitled board"): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string")
    throw new HttpError(400, "BAD_REQUEST", "The board title is invalid.");
  const title = value.trim();
  validateUnicodeText(title, "board title");
  if ([...title].length < 1 || [...title].length > 120 || /\p{Cc}/u.test(title)) {
    throw new HttpError(400, "BAD_REQUEST", "The board title must be 1 to 120 visible characters.");
  }
  return title;
}

export function validateUnicodeText(value: string, field: string): void {
  try {
    validatePlainText(value, field);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw new HttpError(400, "BAD_REQUEST", `The ${field} contains invalid Unicode.`);
    }
    throw error;
  }
}

/**
 * True when the text contains a C0/C1 control character other than the
 * newline and tab that multi-line text fields accept.
 */
export function containsDisallowedControlCharacter(value: string): boolean {
  return [...value].some(
    (character) => /\p{Cc}/u.test(character) && character !== "\n" && character !== "\t",
  );
}

export function requireSafeInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HttpError(400, "BAD_REQUEST", `${field} is invalid.`);
  }
  return value as number;
}

export function fallbackDisplayName(actorId: string): string {
  let value = 0;
  for (let index = Math.max(0, actorId.length - 6); index < actorId.length; index += 1) {
    value = (value * 33 + (actorId.codePointAt(index) ?? 0)) >>> 0;
  }
  return `Guest ${(value % 999) + 1}`;
}

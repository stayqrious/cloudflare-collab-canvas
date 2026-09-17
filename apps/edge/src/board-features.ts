import {
  type BoardFeatures,
  DEFAULT_BOARD_FEATURES,
  normalizeBoardFeatures,
  ProtocolValidationError,
} from "@collab/protocol";
import { isRecord } from "./http/body";

/**
 * Expands feature maps written by older workers after additive feature releases.
 * All pre-existing fields remain required; only the newly additive fields receive defaults.
 */
export function normalizePersistedBoardFeatures(value: unknown): BoardFeatures {
  if (!isRecord(value)) {
    throw new ProtocolValidationError("INVALID_FRAME", "Expected an object", "$features");
  }
  return normalizeBoardFeatures({
    ...value,
    ...(Object.hasOwn(value, "smartNote") ? {} : { smartNote: DEFAULT_BOARD_FEATURES.smartNote }),
    ...(Object.hasOwn(value, "objectTransforms")
      ? {}
      : { objectTransforms: DEFAULT_BOARD_FEATURES.objectTransforms }),
    ...(Object.hasOwn(value, "grouping") ? {} : { grouping: DEFAULT_BOARD_FEATURES.grouping }),
  });
}

import { DEFAULT_BOARD_FEATURES } from "@collab/protocol";
import { describe, expect, it } from "vitest";
import { normalizePersistedBoardFeatures } from "./board-features";

function withoutFeatures(...keys: Array<keyof typeof DEFAULT_BOARD_FEATURES>) {
  return Object.fromEntries(
    Object.entries(DEFAULT_BOARD_FEATURES).filter(([key]) => !keys.includes(key as never)),
  );
}

describe("normalizePersistedBoardFeatures", () => {
  it("fills only the additive feature defaults", () => {
    expect(
      normalizePersistedBoardFeatures({
        ...withoutFeatures("objectTransforms", "grouping", "smartNote"),
        rectangle: false,
      }),
    ).toEqual({
      ...DEFAULT_BOARD_FEATURES,
      rectangle: false,
      objectTransforms: true,
      grouping: true,
      smartNote: false,
    });
  });

  it("preserves explicit false values for additive features", () => {
    expect(
      normalizePersistedBoardFeatures({
        ...DEFAULT_BOARD_FEATURES,
        objectTransforms: false,
        grouping: false,
      }),
    ).toMatchObject({ objectTransforms: false, grouping: false });
  });

  it("preserves an explicitly enabled Smart Note flag", () => {
    expect(
      normalizePersistedBoardFeatures({ ...DEFAULT_BOARD_FEATURES, smartNote: true }).smartNote,
    ).toBe(true);
    expect(() =>
      normalizePersistedBoardFeatures({ ...DEFAULT_BOARD_FEATURES, smartNote: "yes" }),
    ).toThrow();
  });

  it("rejects a missing legacy feature", () => {
    expect(() => normalizePersistedBoardFeatures(withoutFeatures("images"))).toThrow();
  });

  it("rejects unknown and non-boolean feature values", () => {
    expect(() =>
      normalizePersistedBoardFeatures({ ...DEFAULT_BOARD_FEATURES, unknown: true }),
    ).toThrow();
    expect(() =>
      normalizePersistedBoardFeatures({ ...DEFAULT_BOARD_FEATURES, grouping: "yes" }),
    ).toThrow();
  });

  it("rejects null and array values", () => {
    expect(() => normalizePersistedBoardFeatures(null)).toThrow();
    expect(() => normalizePersistedBoardFeatures([])).toThrow();
  });
});

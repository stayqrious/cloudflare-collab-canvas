import { describe, expect, it } from "vitest";

import { buildClassDecision } from "./class-decision";

describe("class decision record", () => {
  it("grounds the decision in aggregate counts and keeps dissent visible", () => {
    let nextId = 1;
    const batch = buildClassDecision(
      {
        decisionTitle: "Cafeteria waste pilot",
        chosenOption: "Reusable container return",
        rationale: "It received the strongest response and can be tested at one lunch station.",
        minorityConcern: "Some students may not be able to return containers the same day.",
        pilotAction: "Run one return station for two weeks with a no-penalty late-return path.",
        successMeasure: "Return rate, queue time, and student-reported ease.",
        nextQuestion: "What support would make this pilot workable for more students?",
      },
      [
        { label: "Reusable container return", count: 8 },
        { label: "Smaller portions first", count: 5 },
        { label: "Compost sorting", count: 3 },
      ],
      { minX: 0, minY: 0, maxX: 600, maxY: 250 },
      () => `018f0000-0000-7000-8000-${String(nextId++).padStart(12, "0")}`,
    );

    expect(batch.operation.operations).toHaveLength(7);
    expect(batch.itemIds).toHaveLength(7);
    const created = batch.operation.operations.flatMap((operation) =>
      operation.kind === "item.create" ? [operation.item] : [],
    );
    expect(created.every((item) => item.assistedBy === "ai")).toBe(true);
    const counts = created.find((item) => item.kind === "table");
    expect(counts?.kind === "table" ? counts.geometry.cells : null).toEqual([
      ["Class response", "Votes"],
      ["Reusable container return", "8"],
      ["Smaller portions first", "5"],
      ["Compost sorting", "3"],
    ]);
    expect(
      created.some(
        (item) =>
          item.kind === "sticky" &&
          item.geometry.text.includes("DISSENT WE WILL NOT ERASE") &&
          item.geometry.text.includes("not be able to return"),
      ),
    ).toBe(true);
  });
});

import {
  MAX_BATCH_OPERATIONS,
  PROTOCOL_VERSION,
  validateClientFrame,
  validateDurableOperation,
} from "@collab/protocol";
import { describe, expect, it } from "vitest";

import type { BoardItem } from "../types";
import { ACTIVITY_TEMPLATES, type ActivityTemplateId, buildActivityBatch } from "./templates";
import { isVoteTable } from "./voting";

function deterministicIds(): () => string {
  let next = 1;
  return () => `018f0000-0000-7000-8000-${(next++).toString(16).padStart(12, "0")}`;
}

describe("classroom templates", () => {
  it("builds every template as a small valid ordinary-item batch", () => {
    const expectedCounts: Record<ActivityTemplateId, number> = {
      "problem-set-six-students": 95,
      "brainstorm-school-traffic": 29,
      "student-questions": 27,
      "debate-school-start": 14,
      "tasks-four-projects": 29,
      "marketing-ad-ideas": 36,
      "graph-check": 13,
      "collective-inquiry-demo": 13,
      "exit-ticket": 7,
      kwl: 2,
      "sort-it": 12,
      "pair-share": 7,
      "vote-with-stamps": 4,
    };

    expect(ACTIVITY_TEMPLATES.map(({ id }) => id)).toEqual(Object.keys(expectedCounts));
    for (const template of ACTIVITY_TEMPLATES) {
      const result = buildActivityBatch(template.id, [12.345, -9.876], deterministicIds());
      expect(result.operation.operations).toHaveLength(expectedCounts[template.id]);
      expect(result.operation.operations.length).toBeLessThanOrEqual(MAX_BATCH_OPERATIONS);
      expect(new Set(result.itemIds).size).toBe(result.itemIds.length);
      expect(
        result.operation.operations.every(
          (operation) =>
            operation.kind === "item.create" &&
            operation.item.transform.join(",") === "1,0,0,1,12.35,-9.88",
        ),
      ).toBe(true);
      expect(() => validateDurableOperation(result.operation)).not.toThrow();
      expect(() =>
        validateClientFrame({
          v: PROTOCOL_VERSION,
          t: "client.commit",
          commandId: "018f0000-0000-7000-8000-000000000101",
          actionId: "018f0000-0000-7000-8000-000000000102",
          baseSeq: 0,
          op: result.operation,
        }),
      ).not.toThrow();
    }
  });

  it("keeps the starter layouts focused on their intended primitives", () => {
    const byId = new Map(ACTIVITY_TEMPLATES.map((template) => [template.id, template]));
    expect(byId.get("exit-ticket")?.items.filter(({ kind }) => kind === "sticky")).toHaveLength(3);
    expect(byId.get("sort-it")?.items.filter(({ kind }) => kind === "sticky")).toHaveLength(6);
    expect(byId.get("pair-share")?.items.filter(({ kind }) => kind === "rectangle")).toHaveLength(
      2,
    );

    const kwl = byId.get("kwl")?.items.find(({ kind }) => kind === "table");
    expect(kwl?.kind).toBe("table");
    if (kwl?.kind !== "table") throw new Error("K-W-L table missing.");
    expect(kwl.geometry.cells[0]).toEqual(["What I know", "What I want to know", "What I learned"]);
    expect(kwl.geometry.rowHeights).toHaveLength(4);

    const voteBatch = buildActivityBatch("vote-with-stamps", [0, 0], deterministicIds());
    expect(
      voteBatch.operation.operations.some(
        (operation) =>
          operation.kind === "item.create" &&
          operation.item.kind === "text" &&
          operation.item.geometry.text.includes("one vote per participant"),
      ),
    ).toBe(false);
    const voteCreate = voteBatch.operation.operations.find(
      (operation) => operation.kind === "item.create" && operation.item.kind === "table",
    );
    if (voteCreate?.kind !== "item.create" || voteCreate.item.kind !== "table") {
      throw new Error("Vote table missing.");
    }
    const voteTable: BoardItem = {
      ...voteCreate.item,
      z: 1,
      version: 1,
      createdBy: "teacher",
    };
    expect(isVoteTable(voteTable)).toBe(true);
  });

  it("gives each demo board student Sections and no AI scaffolding", () => {
    const byId = new Map(ACTIVITY_TEMPLATES.map((template) => [template.id, template]));
    const demos = [
      "graph-check",
      "student-questions",
      "brainstorm-school-traffic",
      "problem-set-six-students",
      "debate-school-start",
      "tasks-four-projects",
      "marketing-ad-ideas",
    ] as const;

    for (const id of demos) {
      const template = byId.get(id);
      if (!template) throw new Error(`${id} is missing.`);
      // The AI answers in comments, so no board may carry a block waiting for it.
      for (const item of template.items) {
        const text =
          item.kind === "text" || item.kind === "sticky"
            ? item.geometry.text
            : item.kind === "zone"
              ? item.geometry.title
              : "";
        expect(text).not.toMatch(/\bAI\b/u);
        // A lone $ is a dollar sign, so no board may lean on it for math.
        expect(text.replace(/\$\$/gu, "")).not.toContain("$");
      }
      // Every stroke must be drawable.
      for (const item of template.items) {
        if (item.kind !== "pencil") continue;
        expect(item.geometry.points.length).toBeGreaterThanOrEqual(2);
      }
    }

    // The handwriting board is what makes a watch send a picture rather than a description.
    const graph = byId.get("graph-check");
    expect(graph?.items.filter(({ kind }) => kind === "pencil").length).toBeGreaterThanOrEqual(5);
    expect(
      graph?.items.some(
        (item) => item.kind === "sticky" && item.geometry.text.includes("\\(x=-3\\)"),
      ),
    ).toBe(true);

    // The three class boards each give six students a Section of their own.
    for (const id of [
      "student-questions",
      "brainstorm-school-traffic",
      "problem-set-six-students",
    ] as const) {
      const sections = byId.get(id)?.items.filter((item) => item.kind === "zone") ?? [];
      expect(sections, id).toHaveLength(6);
      const names = sections.map((item) => (item.kind === "zone" ? item.geometry.title : ""));
      expect(new Set(names).size, id).toBe(6);
      // Every Section holds work, or there would be nothing to comment on.
      expect(
        names.every((name) => name.length > 0),
        id,
      ).toBe(true);
    }

    // The debate board gives each side one Section, so a comment lands on one side's claim.
    const debate = byId.get("debate-school-start");
    const sides = debate?.items.filter((item) => item.kind === "zone") ?? [];
    expect(sides).toHaveLength(2);
    expect(debate?.items.filter(({ kind }) => kind === "sticky")).toHaveLength(8);

    // The problem set shows working: some drawn stroke by stroke, some in a handwriting face,
    // and every student has the same five questions in front of them.
    const problems = byId.get("problem-set-six-students");
    const strokes = (problems?.items ?? []).filter((item) => item.kind === "pencil");
    expect(strokes.length).toBeGreaterThanOrEqual(30);
    const handwritten = (problems?.items ?? []).filter(
      (item) => item.kind === "text" && item.style.fontFamily === "handwritten",
    );
    expect(handwritten.length).toBeGreaterThanOrEqual(15);
    const questionSheets = (problems?.items ?? []).filter(
      (item) => item.kind === "text" && item.geometry.text.includes("20 ÷ 4 × 5"),
    );
    expect(questionSheets).toHaveLength(6);
  });
});

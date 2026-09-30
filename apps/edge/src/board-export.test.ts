/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  MAX_LIVE_ITEMS,
  MAX_SECTION_EXPORT_INDEX_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_ZONE_TITLE_CODE_POINTS,
} from "@collab/protocol";
import { describe, expect, it } from "vitest";
import { appendSectionExportSummaries, buildSectionExportSummaries } from "./board-export";
import type { BoardItem } from "./types";

const ACTOR_ID = "018f0000-0000-7000-8000-000000000900";

function section(id: string, title: string, locked = false): BoardItem {
  return {
    id,
    kind: "zone",
    z: 1,
    version: 1,
    createdBy: ACTOR_ID,
    style: {
      kind: "zone",
      borderColor: "#000000",
      fill: "#ffffff",
      textColor: "#111111",
      fontSize: 18,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 200, height: 100, title, locked },
  };
}

function sticky(id: string, sectionId?: string): BoardItem {
  return {
    id,
    kind: "sticky",
    ...(sectionId === undefined ? {} : { sectionId }),
    z: 1,
    version: 1,
    createdBy: ACTOR_ID,
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#292524",
      fontSize: 20,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 0, 0],
    geometry: { x: 0, y: 0, width: 120, height: 80, text: "Member" },
  };
}

describe("canonical board exports", () => {
  it("indexes Section members in one traversal while preserving snapshot order", () => {
    const firstSectionId = "018f0000-0000-7000-8000-000000000901";
    const secondSectionId = "018f0000-0000-7000-8000-000000000902";
    const firstMemberId = "018f0000-0000-7000-8000-000000000903";
    const secondMemberId = "018f0000-0000-7000-8000-000000000904";
    const thirdMemberId = "018f0000-0000-7000-8000-000000000905";
    const items = [
      sticky(firstMemberId, firstSectionId),
      section(secondSectionId, "Second", true),
      sticky(secondMemberId, secondSectionId),
      section(firstSectionId, "First"),
      sticky(thirdMemberId, firstSectionId),
      sticky("018f0000-0000-7000-8000-000000000906"),
    ];
    let traversals = 0;
    const singleUseItems: Iterable<BoardItem> = {
      [Symbol.iterator]() {
        traversals += 1;
        if (traversals > 1) throw new Error("Section export items were traversed more than once");
        return items[Symbol.iterator]();
      },
    };

    expect(buildSectionExportSummaries(singleUseItems)).toEqual([
      {
        id: secondSectionId,
        name: "Second",
        locked: true,
        memberItemIds: [secondMemberId],
      },
      {
        id: firstSectionId,
        name: "First",
        locked: false,
        memberItemIds: [firstMemberId, thirdMemberId],
      },
    ]);
    expect(traversals).toBe(1);
  });

  it("allows derived Section summaries beyond the canonical snapshot storage limit", () => {
    const prefix = '{"format":"cf-whiteboard-json","padding":"';
    const suffix = '"}';
    const paddingBytes = MAX_SNAPSHOT_BYTES - prefix.length - suffix.length;
    const unicodePadding = "雪".repeat(Math.floor(paddingBytes / 3));
    const asciiPadding = "x".repeat(paddingBytes % 3);
    const serializedSnapshot = `${prefix}${unicodePadding}${asciiPadding}${suffix}`;

    expect(new TextEncoder().encode(serializedSnapshot).byteLength).toBe(MAX_SNAPSHOT_BYTES);

    const sections = [
      {
        id: "018f0000-0000-7000-8000-000000000901",
        name: "Workshop",
        locked: false,
        memberItemIds: ["018f0000-0000-7000-8000-000000000902"],
      },
    ];
    const body = appendSectionExportSummaries(serializedSnapshot, sections);

    expect(body.length).toBeGreaterThan(serializedSnapshot.length);
    expect(body.endsWith(`,"sections":${JSON.stringify(sections)}}`)).toBe(true);
  });

  it("keeps the worst-case Section index within the documented export bound", () => {
    const uuid = (index: number) =>
      `018f0000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
    const widestTitle = "\u{1F9E0}".repeat(MAX_ZONE_TITLE_CODE_POINTS);
    const indexBytes = (items: BoardItem[]) =>
      new TextEncoder().encode(JSON.stringify(buildSectionExportSummaries(items))).byteLength + 16;

    const allSections = Array.from({ length: MAX_LIVE_ITEMS }, (_, index) =>
      section(uuid(index), widestTitle, true),
    );
    expect(indexBytes(allSections)).toBeLessThanOrEqual(MAX_SECTION_EXPORT_INDEX_BYTES);

    const oneSectionWithMembers = [
      section(uuid(0), widestTitle),
      ...Array.from({ length: MAX_LIVE_ITEMS - 1 }, (_, index) => sticky(uuid(index + 1), uuid(0))),
    ];
    expect(indexBytes(oneSectionWithMembers)).toBeLessThanOrEqual(MAX_SECTION_EXPORT_INDEX_BYTES);
  });
});

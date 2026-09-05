import { MAX_CANONICAL_EXPORT_BYTES } from "@collab/protocol";
import type { BoardItem, ZoneGeometry } from "./types";

export interface SectionExportSummary {
  id: string;
  name: string;
  locked: boolean;
  memberItemIds: readonly string[];
}

/**
 * Builds export-only Section metadata in snapshot order. Members are indexed
 * during the same traversal so exporting many Sections remains linear in the
 * number of items.
 */
export function buildSectionExportSummaries(items: Iterable<BoardItem>): SectionExportSummary[] {
  const sections: Array<Omit<SectionExportSummary, "memberItemIds">> = [];
  const memberItemIdsBySectionId = new Map<string, string[]>();

  for (const item of items) {
    if (item.sectionId !== undefined) {
      const memberItemIds = memberItemIdsBySectionId.get(item.sectionId) ?? [];
      memberItemIds.push(item.id);
      memberItemIdsBySectionId.set(item.sectionId, memberItemIds);
    }

    if (item.kind === "zone") {
      const geometry = item.geometry as ZoneGeometry;
      sections.push({
        id: item.id,
        name: geometry.title,
        locked: geometry.locked === true,
      });
    }
  }

  return sections.map((section) => ({
    ...section,
    memberItemIds: memberItemIdsBySectionId.get(section.id) ?? [],
  }));
}

/**
 * Adds derived Section metadata after the canonical snapshot has passed its
 * storage-size validation. The index is bounded by
 * MAX_SECTION_EXPORT_INDEX_BYTES, so consumers accept exports up to
 * MAX_CANONICAL_EXPORT_BYTES rather than the bare snapshot limit.
 */
export function appendSectionExportSummaries(
  serializedSnapshot: string,
  sections: readonly SectionExportSummary[],
): string {
  const body = `${serializedSnapshot.slice(0, -1)},"sections":${JSON.stringify(sections)}}`;
  if (new TextEncoder().encode(body).byteLength > MAX_CANONICAL_EXPORT_BYTES) {
    throw new Error("The canonical export exceeds the supported export size.");
  }
  return body;
}

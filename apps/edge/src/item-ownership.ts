import { type Bounds, boundsContain, itemBounds } from "@collab/geometry";
import {
  BoardDomainError,
  type ItemRecord,
  type ItemWrite,
  type ParsedItemOperation,
  type PreparedOperation,
  prepareItemOperation,
} from "./domain";
import type { BoardItem, BoardRole, ItemEffect, ZoneGeometry } from "./types";

type SectionItem = BoardItem & { kind: "zone"; geometry: ZoneGeometry };

export type ItemMutationOperation =
  | ParsedItemOperation
  | { kind: "items.batch"; operations: ParsedItemOperation[] };

export type ItemOwnershipContext = {
  actorId: string;
  role: BoardRole;
};

export type OwnedItemPreparationOptions = ItemOwnershipContext & {
  seq: number;
  nextZ: number;
  liveCount: number;
  tokenFactory?: () => string;
};

function children(operation: ItemMutationOperation): readonly ParsedItemOperation[] {
  return operation.kind === "items.batch" ? operation.operations : [operation];
}

function liveItem(records: ReadonlyMap<string, ItemRecord>, itemId: string): BoardItem | undefined {
  const record = records.get(itemId);
  return record === undefined || record.deleted ? undefined : record.item;
}

function asSection(item: BoardItem | undefined): SectionItem | undefined {
  return item?.kind === "zone" && "title" in item.geometry ? (item as SectionItem) : undefined;
}

function lockedSection(
  records: ReadonlyMap<string, ItemRecord>,
  sectionId: string | undefined,
): SectionItem | undefined {
  if (sectionId === undefined) return undefined;
  const section = asSection(liveItem(records, sectionId));
  return section?.geometry.locked === true ? section : undefined;
}

function mutationSource(
  operation: ParsedItemOperation,
  records: ReadonlyMap<string, ItemRecord>,
): BoardItem | undefined {
  if (operation.kind === "item.create") return undefined;
  return liveItem(
    records,
    operation.kind === "item.copy" ? operation.sourceItemId : operation.itemId,
  );
}

function prospectiveSectionId(operation: ParsedItemOperation): string | undefined {
  if (operation.kind === "item.create") return operation.item.sectionId;
  if (operation.kind === "item.update") {
    return typeof operation.patch.sectionId === "string" ? operation.patch.sectionId : undefined;
  }
  if (operation.kind === "item.copy") {
    return typeof operation.newSectionId === "string" ? operation.newSectionId : undefined;
  }
  return undefined;
}

function zoneLockChange(
  operation: ParsedItemOperation,
  records: ReadonlyMap<string, ItemRecord>,
): { section: SectionItem; locked: boolean } | null {
  if (operation.kind !== "item.update" || operation.patch.geometry === undefined) return null;
  const source = asSection(liveItem(records, operation.itemId));
  if (source === undefined) return null;
  const geometry = operation.patch.geometry as Partial<typeof source.geometry>;
  const locked = geometry.locked === true;
  return locked === (source.geometry.locked === true) ? null : { section: source, locked };
}

/**
 * Lock state of every Section a batch creates or copies, keyed by the new
 * item ID. These Sections are absent from the pre-batch `records`, so a later
 * child in the same batch could otherwise lock them unnoticed.
 */
function batchSectionLockStates(
  operations: readonly ParsedItemOperation[],
  records: ReadonlyMap<string, ItemRecord>,
): Map<string, boolean> {
  const states = new Map<string, boolean>();
  for (const child of operations) {
    if (child.kind === "item.create" && child.item.kind === "zone") {
      states.set(child.item.id, (child.item.geometry as { locked?: unknown }).locked === true);
    } else if (child.kind === "item.copy") {
      const source = asSection(liveItem(records, child.sourceItemId));
      if (source !== undefined) states.set(child.newItemId, source.geometry.locked === true);
    }
  }
  return states;
}

function isPureZoneLockChange(operation: ParsedItemOperation, section: SectionItem): boolean {
  if (
    operation.kind !== "item.update" ||
    operation.patch.geometry === undefined ||
    Object.keys(operation.patch).length !== 1
  ) {
    return false;
  }
  const geometry = operation.patch.geometry as Partial<typeof section.geometry>;
  return (
    geometry.x === section.geometry.x &&
    geometry.y === section.geometry.y &&
    geometry.width === section.geometry.width &&
    geometry.height === section.geometry.height &&
    geometry.title === section.geometry.title &&
    (geometry.locked === true) !== (section.geometry.locked === true)
  );
}

function sectionLocked(sectionId: string, itemId?: string): never {
  throw new BoardDomainError(
    "FORBIDDEN",
    "This Section is locked. An owner must unlock it before its contents can change.",
    { sectionId, ...(itemId === undefined ? {} : { itemId }) },
  );
}

export function sectionRecordIdsForItems(items: Iterable<BoardItem>): string[] {
  const ids = new Set<string>();
  for (const item of items) if (item.sectionId !== undefined) ids.add(item.sectionId);
  return [...ids];
}

export function sectionRecordIdsForMutation(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
): string[] {
  const ids = new Set<string>();
  for (const child of children(operation)) {
    const source = mutationSource(child, records);
    if (source?.sectionId !== undefined) ids.add(source.sectionId);
    const prospective = prospectiveSectionId(child);
    if (prospective !== undefined) ids.add(prospective);
  }
  return [...ids];
}

export function assertItemsOutsideLockedSections(
  items: Iterable<BoardItem>,
  records: ReadonlyMap<string, ItemRecord>,
): void {
  for (const item of items) {
    const sectionItem = asSection(item);
    if (sectionItem?.geometry.locked === true) {
      sectionLocked(sectionItem.id, sectionItem.id);
    }
    const section = lockedSection(records, item.sectionId);
    if (section !== undefined) sectionLocked(section.id, item.id);
  }
}

export function assertSectionLockMutation(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
  context: ItemOwnershipContext,
): void {
  const operations = children(operation);
  const lockChanges = operations.flatMap((child) => {
    const change = zoneLockChange(child, records);
    return change === null ? [] : [{ operation: child, ...change }];
  });
  const [lockChange] = lockChanges;
  if (
    lockChange !== undefined &&
    (context.role !== "owner" ||
      operations.length !== 1 ||
      lockChanges.length !== 1 ||
      !isPureZoneLockChange(lockChange.operation, lockChange.section))
  ) {
    throw new BoardDomainError("FORBIDDEN", "Only an owner can lock or unlock a Section.");
  }

  const batchSectionLocks = batchSectionLockStates(operations, records);
  for (const child of operations) {
    if (
      child.kind === "item.create" &&
      child.item.kind === "zone" &&
      (child.item.geometry as { locked?: unknown }).locked === true &&
      context.role !== "owner"
    ) {
      throw new BoardDomainError("FORBIDDEN", "Only an owner can create a locked Section.");
    }

    // A lock change must be its own single operation, so one that targets a
    // Section created or copied earlier in this batch is never allowed.
    if (child.kind === "item.update" && child.patch.geometry !== undefined) {
      const lockedAtCreation = batchSectionLocks.get(child.itemId);
      if (
        lockedAtCreation !== undefined &&
        ((child.patch.geometry as { locked?: unknown }).locked === true) !== lockedAtCreation
      ) {
        throw new BoardDomainError("FORBIDDEN", "Only an owner can lock or unlock a Section.");
      }
    }

    const source = mutationSource(child, records);
    const sourceSection = asSection(source);
    if (sourceSection?.geometry.locked === true) {
      const change = zoneLockChange(child, records);
      if (
        change !== null &&
        context.role === "owner" &&
        change.locked === false &&
        isPureZoneLockChange(child, sourceSection)
      ) {
        continue;
      }
      sectionLocked(sourceSection.id, sourceSection.id);
    }

    const currentSection = lockedSection(records, source?.sectionId);
    if (currentSection !== undefined) sectionLocked(currentSection.id, source?.id);

    const nextSection = lockedSection(records, prospectiveSectionId(child));
    if (nextSection !== undefined) {
      const itemId = child.kind === "item.create" ? child.item.id : source?.id;
      sectionLocked(nextSection.id, itemId);
    }
  }
}

export function assertItemsOwnedByActor(
  items: Iterable<BoardItem>,
  context: ItemOwnershipContext,
): void {
  if (context.role === "owner") return;
  if (context.role !== "editor") {
    throw new BoardDomainError("FORBIDDEN", "Viewers cannot modify board items.");
  }
  for (const item of items) {
    if (item.createdBy === context.actorId) continue;
    throw new BoardDomainError("FORBIDDEN", "You can modify only work that you created.", {
      itemId: item.id,
    });
  }
}

/**
 * Enforces item ownership and Section locks before the reducer performs writes.
 *
 * Owners (including co-owners, which use the same role) may modify every
 * unlocked item. Editors may create new items and copy any unlocked item,
 * because a copy is a new item attributed to the copying actor. Updating or
 * deleting an existing live item is restricted to its creator.
 *
 * Missing and deleted records deliberately fall through to the reducer so its
 * normal not-found/stale errors remain authoritative.
 */
export function assertItemMutationOwnership(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
  context: ItemOwnershipContext,
): void {
  assertSectionLockMutation(operation, records, context);
  const existingItems = children(operation).flatMap((child) => {
    if (child.kind === "item.create" || child.kind === "item.copy") return [];
    const record = records.get(child.itemId);
    if (record === undefined || record.deleted) return [];
    if (isOwnSectionDetach(child, record.item, records, context.actorId)) return [];
    return [record.item];
  });
  assertItemsOwnedByActor(existingItems, context);
}

/**
 * A Section's creator may detach members they do not own from that Section.
 * Membership is assigned by geometry when another participant draws inside
 * the Section, so the creator must be able to reverse it (and delete the
 * Section) without that participant. Only a bare `{ sectionId: null }` patch
 * qualifies; any other change to the member still requires ownership, and
 * Section locks are enforced separately before this runs.
 */
export function isOwnSectionDetach(
  operation: ParsedItemOperation,
  member: BoardItem,
  records: ReadonlyMap<string, ItemRecord>,
  actorId: string,
): boolean {
  if (operation.kind !== "item.update") return false;
  const patch = operation.patch as Record<string, unknown>;
  if (Object.keys(patch).length !== 1 || patch.sectionId !== null) return false;
  if (member.sectionId === undefined) return false;
  const section = asSection(liveItem(records, member.sectionId));
  return section !== undefined && section.createdBy === actorId;
}

function boundsEqual(left: Bounds, right: Bounds): boolean {
  return (
    left.minX === right.minX &&
    left.minY === right.minY &&
    left.maxX === right.maxX &&
    left.maxY === right.maxY
  );
}

/**
 * Section membership is assigned by geometry, so every member a mutation
 * leaves inside a Section must lie within that Section's prospective bounds.
 * Without this an editor could attach an item anywhere on the board to
 * another participant's Section. A member whose bounds and membership are
 * both untouched is left alone so a stray member can still be edited and
 * re-homed by the client. A missing Section is reported by the topology check.
 */
export function assertSectionMembersContained(
  writes: ReadonlyMap<string, ItemWrite>,
  records: ReadonlyMap<string, ItemRecord>,
): void {
  for (const write of writes.values()) {
    const sectionId = write.item.sectionId;
    if (write.deleted || write.item.kind === "zone" || sectionId === undefined) continue;
    const sectionWrite = writes.get(sectionId);
    const section = asSection(
      sectionWrite === undefined
        ? liveItem(records, sectionId)
        : sectionWrite.deleted
          ? undefined
          : sectionWrite.item,
    );
    if (section === undefined) continue;
    const before = liveItem(records, write.item.id);
    if (
      before !== undefined &&
      before.sectionId === sectionId &&
      sectionWrite === undefined &&
      boundsEqual(itemBounds(before), write.bounds)
    ) {
      continue;
    }
    if (!boundsContain(sectionWrite?.bounds ?? itemBounds(section), write.bounds)) {
      throw new BoardDomainError("INVALID_FRAME", "A Section member must lie within its Section.", {
        sectionId,
        itemId: write.item.id,
      });
    }
  }
}

/**
 * Editors may add an item to a group only when every live member of that
 * group is their own (or the group is new). Otherwise an editor could bind
 * their item to another participant's group, after which neither could move
 * the group closure. `currentItems` is the live board before the effects are
 * applied, and `target` selects the state the effects are moving towards.
 */
export function assertGroupMembershipOwnership(
  effects: readonly ItemEffect[],
  target: "before" | "after",
  currentItems: Iterable<BoardItem>,
  context: ItemOwnershipContext,
): void {
  if (context.role === "owner") return;
  const source = target === "after" ? "before" : "after";
  const joins = effects.flatMap((effect) => {
    const next = effect[target];
    const previous = effect[source];
    if (!next.exists || next.item.groupId === undefined) return [];
    if (previous.exists && previous.item.groupId === next.item.groupId) return [];
    return [{ itemId: effect.itemId, groupId: next.item.groupId }];
  });
  if (joins.length === 0) return;
  const joinedGroupIds = new Set(joins.map((join) => join.groupId));
  for (const member of currentItems) {
    if (member.groupId === undefined || !joinedGroupIds.has(member.groupId)) continue;
    if (member.createdBy === context.actorId) continue;
    const join = joins.find((candidate) => candidate.groupId === member.groupId);
    throw new BoardDomainError(
      "FORBIDDEN",
      "You can add items only to groups made of work that you created.",
      { itemId: join?.itemId ?? member.id, groupId: member.groupId },
    );
  }
}

/**
 * Keeps authorization and reduction as one call so a forbidden child makes a
 * batch fail before token allocation or any other reducer work begins. The
 * prepared writes are then checked for Section containment, which needs the
 * reduced geometry.
 */
export function prepareOwnedItemOperation(
  operation: ItemMutationOperation,
  records: ReadonlyMap<string, ItemRecord>,
  options: OwnedItemPreparationOptions,
): PreparedOperation {
  assertItemMutationOwnership(operation, records, options);
  const prepared = prepareItemOperation(operation, records, options);
  assertSectionMembersContained(prepared.writes, records);
  return prepared;
}

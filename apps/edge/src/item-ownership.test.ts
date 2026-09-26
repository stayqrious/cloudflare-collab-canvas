import { describe, expect, it } from "vitest";
import { BoardDomainError, type ItemRecord, type ParsedItemOperation } from "./domain";
import {
  assertGroupMembershipOwnership,
  assertItemMutationOwnership,
  prepareOwnedItemOperation,
} from "./item-ownership";
import type { BoardItem, ItemEffect } from "./types";

const ownerId = "a_AAAAAAAAAAAAAAAAAAAAAA";
const editorId = "a_BBBBBBBBBBBBBBBBBBBBBA";
const otherEditorId = "a_CCCCCCCCCCCCCCCCCCCCCA";
const ownItemId = "018f0000-0000-7000-8000-000000000001";
const foreignItemId = "018f0000-0000-7000-8000-000000000002";
const copyItemId = "018f0000-0000-7000-8000-000000000003";
const sectionId = "018f0000-0000-7000-8000-000000000004";

function itemRecord(id: string, createdBy: string, deleted = false): ItemRecord {
  return {
    deleted,
    stateToken: `state:${id}`,
    item: {
      id,
      kind: "sticky",
      z: 1,
      version: 4,
      createdBy,
      style: {
        kind: "sticky",
        fill: "#fff2a8",
        textColor: "#2f2a1f",
        fontSize: 20,
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "Question" },
    },
  };
}

function sectionRecord(locked: boolean): ItemRecord {
  return {
    deleted: false,
    stateToken: "state:section",
    item: {
      id: sectionId,
      kind: "zone",
      z: 2,
      version: 4,
      createdBy: ownerId,
      style: {
        kind: "zone",
        borderColor: "#60a5fa",
        fill: "#eff6ff",
        textColor: "#1e3a8a",
        fontSize: 20,
        opacity: 0.8,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: { x: 0, y: 0, width: 600, height: 400, title: "Review", locked },
    },
  };
}

function update(itemId: string, patch: "text" | "design"): ParsedItemOperation {
  return {
    kind: "item.update",
    itemId,
    expectedVersion: 4,
    patch:
      patch === "text"
        ? { geometry: { x: 10, y: 20, width: 180, height: 140, text: "Changed" } }
        : {
            style: {
              kind: "sticky",
              fill: "#ffd6e7",
              textColor: "#2f2a1f",
              fontSize: 20,
              opacity: 1,
            },
          },
  };
}

function expectForbidden(run: () => void, itemId?: string): void {
  try {
    run();
    throw new Error("Expected ownership authorization to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(BoardDomainError);
    expect(error).toMatchObject({ code: "FORBIDDEN" });
    if (itemId !== undefined) {
      expect(error).toMatchObject({ details: { itemId } });
    }
  }
}

describe("classroom item ownership", () => {
  const records = new Map([
    [ownItemId, itemRecord(ownItemId, editorId)],
    [foreignItemId, itemRecord(foreignItemId, otherEditorId)],
  ]);

  it("lets owners and co-owners modify another actor's text or design", () => {
    expect(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), records, {
        actorId: ownerId,
        role: "owner",
      }),
    ).not.toThrow();
    expect(() =>
      assertItemMutationOwnership(update(foreignItemId, "design"), records, {
        actorId: ownerId,
        role: "owner",
      }),
    ).not.toThrow();
  });

  it("lets editors update and delete only items they created", () => {
    expect(() =>
      assertItemMutationOwnership(update(ownItemId, "text"), records, {
        actorId: editorId,
        role: "editor",
      }),
    ).not.toThrow();
    expect(() =>
      assertItemMutationOwnership(
        { kind: "item.delete", itemId: ownItemId, expectedVersion: 4 },
        records,
        { actorId: editorId, role: "editor" },
      ),
    ).not.toThrow();

    for (const operation of [
      update(foreignItemId, "text"),
      update(foreignItemId, "design"),
      { kind: "item.delete", itemId: foreignItemId, expectedVersion: 4 } as const,
    ]) {
      expectForbidden(
        () =>
          assertItemMutationOwnership(operation, records, {
            actorId: editorId,
            role: "editor",
          }),
        foreignItemId,
      );
    }
  });

  it("allows editors to create and to copy another actor's item into their own new item", () => {
    expect(() =>
      assertItemMutationOwnership(
        {
          kind: "item.create",
          item: {
            id: copyItemId,
            kind: "sticky",
            style: {
              kind: "sticky",
              fill: "#fff2a8",
              textColor: "#2f2a1f",
              fontSize: 20,
              opacity: 1,
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: { x: 10, y: 20, width: 180, height: 140, text: "Mine" },
          },
        },
        records,
        { actorId: editorId, role: "editor" },
      ),
    ).not.toThrow();
    expect(() =>
      assertItemMutationOwnership(
        {
          kind: "item.copy",
          sourceItemId: foreignItemId,
          expectedVersion: 4,
          newItemId: copyItemId,
          translate: { x: 24, y: 24 },
        },
        records,
        { actorId: editorId, role: "editor" },
      ),
    ).not.toThrow();
  });

  it("preflights every batch child before reduction so a forbidden child is atomic", () => {
    let tokenAllocations = 0;
    const before = structuredClone(records.get(ownItemId));
    expectForbidden(
      () =>
        prepareOwnedItemOperation(
          {
            kind: "items.batch",
            operations: [
              update(ownItemId, "design"),
              { kind: "item.delete", itemId: foreignItemId, expectedVersion: 4 },
            ],
          },
          records,
          {
            seq: 5,
            actorId: editorId,
            role: "editor",
            nextZ: 3,
            liveCount: 2,
            tokenFactory: () => {
              tokenAllocations += 1;
              return `next:${tokenAllocations}`;
            },
          },
        ),
      foreignItemId,
    );
    expect(tokenAllocations).toBe(0);
    expect(records.get(ownItemId)).toEqual(before);
  });

  it("lets a Section's creator detach a foreign surviving member while deleting it", () => {
    const section = sectionRecord(false);
    section.item.createdBy = editorId;
    const foreignMember = itemRecord(foreignItemId, otherEditorId);
    foreignMember.item.sectionId = sectionId;
    const sectionRecords = new Map([
      [sectionId, section],
      [foreignItemId, foreignMember],
    ]);
    const deleteWithDetach = {
      kind: "items.batch" as const,
      operations: [
        { kind: "item.delete" as const, itemId: sectionId, expectedVersion: 4 },
        {
          kind: "item.update" as const,
          itemId: foreignItemId,
          expectedVersion: 4,
          patch: { sectionId: null },
        },
      ],
    };

    // Membership was assigned by geometry, so the Section's creator may
    // reverse it even though they cannot otherwise edit the member.
    expect(() =>
      assertItemMutationOwnership(deleteWithDetach, sectionRecords, {
        actorId: editorId,
        role: "editor",
      }),
    ).not.toThrow();

    // A different editor has no such right over the member.
    const [, detachOnly] = deleteWithDetach.operations;
    if (detachOnly === undefined) throw new Error("expected the detach operation");
    expectForbidden(
      () =>
        assertItemMutationOwnership(detachOnly, sectionRecords, {
          actorId: "editor-c",
          role: "editor",
        }),
      foreignItemId,
    );
  });

  it("rejects Section deletion before reduction when the member patch does more than detach", () => {
    const section = sectionRecord(false);
    section.item.createdBy = editorId;
    const foreignMember = itemRecord(foreignItemId, otherEditorId);
    foreignMember.item.sectionId = sectionId;
    const sectionRecords = new Map([
      [sectionId, section],
      [foreignItemId, foreignMember],
    ]);
    const before = structuredClone(sectionRecords);
    let tokenAllocations = 0;

    expectForbidden(
      () =>
        prepareOwnedItemOperation(
          {
            kind: "items.batch",
            operations: [
              { kind: "item.delete", itemId: sectionId, expectedVersion: 4 },
              {
                kind: "item.update",
                itemId: foreignItemId,
                expectedVersion: 4,
                patch: { sectionId: null, transform: [1, 0, 0, 1, 5, 5] },
              },
            ],
          },
          sectionRecords,
          {
            seq: 5,
            actorId: editorId,
            role: "editor",
            nextZ: 3,
            liveCount: 2,
            tokenFactory: () => {
              tokenAllocations += 1;
              return `next:${tokenAllocations}`;
            },
          },
        ),
      foreignItemId,
    );
    expect(tokenAllocations).toBe(0);
    expect(sectionRecords).toEqual(before);
  });

  it("leaves missing or deleted item errors to the authoritative reducer", () => {
    const deleted = new Map([[foreignItemId, itemRecord(foreignItemId, otherEditorId, true)]]);
    expect(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), deleted, {
        actorId: editorId,
        role: "editor",
      }),
    ).not.toThrow();
    expect(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), new Map(), {
        actorId: editorId,
        role: "editor",
      }),
    ).not.toThrow();
  });

  it("freezes owner and editor mutations inside a locked Section until an owner unlocks it", () => {
    const member = itemRecord(foreignItemId, otherEditorId);
    member.item.sectionId = sectionId;
    const lockedRecords = new Map([
      [sectionId, sectionRecord(true)],
      [foreignItemId, member],
    ]);

    expectForbidden(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), lockedRecords, {
        actorId: ownerId,
        role: "owner",
      }),
    );
    expectForbidden(() =>
      assertItemMutationOwnership(update(foreignItemId, "text"), lockedRecords, {
        actorId: otherEditorId,
        role: "editor",
      }),
    );
    expectForbidden(() =>
      assertItemMutationOwnership(
        {
          kind: "item.copy",
          sourceItemId: foreignItemId,
          expectedVersion: 4,
          newItemId: copyItemId,
          translate: { x: 24, y: 24 },
        },
        lockedRecords,
        { actorId: ownerId, role: "owner" },
      ),
    );
    expectForbidden(() =>
      assertItemMutationOwnership(
        {
          kind: "item.create",
          item: {
            id: copyItemId,
            sectionId,
            kind: "sticky",
            style: {
              kind: "sticky",
              fill: "#fff2a8",
              textColor: "#2f2a1f",
              fontSize: 20,
              opacity: 1,
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: { x: 10, y: 20, width: 180, height: 140, text: "Blocked" },
          },
        },
        lockedRecords,
        { actorId: ownerId, role: "owner" },
      ),
    );

    expect(() =>
      assertItemMutationOwnership(
        {
          kind: "item.update",
          itemId: sectionId,
          expectedVersion: 4,
          patch: {
            geometry: {
              x: 0,
              y: 0,
              width: 600,
              height: 400,
              title: "Review",
              locked: false,
            },
          },
        },
        lockedRecords,
        { actorId: ownerId, role: "owner" },
      ),
    ).not.toThrow();
    expectForbidden(() =>
      assertItemMutationOwnership(
        {
          kind: "item.update",
          itemId: sectionId,
          expectedVersion: 4,
          patch: {
            geometry: {
              x: 0,
              y: 0,
              width: 600,
              height: 400,
              title: "Review",
              locked: false,
            },
          },
        },
        lockedRecords,
        { actorId: otherEditorId, role: "editor" },
      ),
    );
  });

  it("rejects viewer mutations at the same authorization boundary", () => {
    expectForbidden(() =>
      assertItemMutationOwnership(update(ownItemId, "text"), records, {
        actorId: editorId,
        role: "viewer",
      }),
    );
  });

  it("rejects locking a Section that the same batch created or copied", () => {
    const seq = 5;
    const unlockedSection = sectionRecord(false);
    const sectionCreate: ParsedItemOperation = {
      kind: "item.create",
      item: {
        id: copyItemId,
        kind: "zone",
        style: unlockedSection.item.style,
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 0, y: 0, width: 600, height: 400, title: "Mine" },
      },
    };
    const lockCreated: ParsedItemOperation = {
      kind: "item.update",
      itemId: copyItemId,
      expectedVersion: seq,
      patch: { geometry: { x: 0, y: 0, width: 600, height: 400, title: "Mine", locked: true } },
    };
    const sectionCopy: ParsedItemOperation = {
      kind: "item.copy",
      sourceItemId: sectionId,
      expectedVersion: 4,
      newItemId: copyItemId,
      translate: { x: 700, y: 0 },
    };
    const options = { seq, nextZ: 3, liveCount: 1, tokenFactory: () => "next" };

    for (const role of ["editor", "owner"] as const) {
      for (const first of [sectionCreate, sectionCopy]) {
        let error: unknown;
        try {
          prepareOwnedItemOperation(
            { kind: "items.batch", operations: [first, lockCreated] },
            new Map([[sectionId, unlockedSection]]),
            { ...options, actorId: role === "owner" ? ownerId : editorId, role },
          );
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(BoardDomainError);
        expect(error).toMatchObject({
          code: "FORBIDDEN",
          message: "Only an owner can lock or unlock a Section.",
        });
      }
    }

    // A lone create or copy stays available; only the in-batch lock is refused.
    for (const operation of [sectionCreate, sectionCopy]) {
      const prepared = prepareOwnedItemOperation(
        operation,
        new Map([[sectionId, unlockedSection]]),
        { ...options, actorId: editorId, role: "editor" },
      );
      expect(prepared.writes.get(copyItemId)?.item.geometry).not.toMatchObject({ locked: true });
    }
  });

  it("rejects Section membership whose bounds fall outside the Section", () => {
    const section = sectionRecord(false);
    const options = { seq: 5, nextZ: 3, liveCount: 1, tokenFactory: () => "next" };
    const context = { ...options, actorId: editorId, role: "editor" as const };
    const sticky = (id: string, x: number, sectionIdValue = sectionId): ParsedItemOperation => ({
      kind: "item.create",
      item: {
        id,
        sectionId: sectionIdValue,
        kind: "sticky",
        style: { kind: "sticky", fill: "#fff2a8", textColor: "#2f2a1f", fontSize: 20, opacity: 1 },
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x, y: 20, width: 180, height: 140, text: "Placed" },
      },
    });
    const expectOutside = (run: () => void, itemId: string, expectedSectionId = sectionId) => {
      let error: unknown;
      try {
        run();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(BoardDomainError);
      expect(error).toMatchObject({
        code: "INVALID_FRAME",
        details: { sectionId: expectedSectionId, itemId },
      });
    };

    // Contained members are accepted; an out-of-bounds create is refused.
    expect(() =>
      prepareOwnedItemOperation(sticky(copyItemId, 10), new Map([[sectionId, section]]), context),
    ).not.toThrow();
    expect(() =>
      prepareOwnedItemOperation(
        {
          kind: "item.create",
          item: {
            id: copyItemId,
            sectionId,
            kind: "text",
            style: {
              kind: "text",
              color: "#20201e",
              fontSize: 20,
              fontFamily: "sans",
              opacity: 1,
            },
            transform: [1, 0, 0, 1, 0, 0],
            geometry: {
              x: 100,
              y: 40,
              text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              embed: "video",
            },
          },
        },
        new Map([[sectionId, section]]),
        context,
      ),
    ).not.toThrow();
    expectOutside(
      () =>
        prepareOwnedItemOperation(
          sticky(copyItemId, 500),
          new Map([[sectionId, section]]),
          context,
        ),
      copyItemId,
    );

    // The same holds against a Section created earlier in the batch.
    const createdSectionId = "018f0000-0000-7000-8000-000000000005";
    const createSection: ParsedItemOperation = {
      kind: "item.create",
      item: {
        id: createdSectionId,
        kind: "zone",
        style: section.item.style,
        transform: [1, 0, 0, 1, 0, 0],
        geometry: { x: 1000, y: 1000, width: 300, height: 300, title: "New" },
      },
    };
    expectOutside(
      () =>
        prepareOwnedItemOperation(
          {
            kind: "items.batch",
            operations: [createSection, sticky(copyItemId, 10, createdSectionId)],
          },
          new Map(),
          context,
        ),
      copyItemId,
      createdSectionId,
    );

    // Assigning an existing item, or moving a member, must keep it inside.
    const own = itemRecord(ownItemId, editorId);
    expectOutside(
      () =>
        prepareOwnedItemOperation(
          {
            kind: "item.update",
            itemId: ownItemId,
            expectedVersion: 4,
            patch: { sectionId, transform: [1, 0, 0, 1, 900, 0] },
          },
          new Map([
            [sectionId, section],
            [ownItemId, own],
          ]),
          context,
        ),
      ownItemId,
    );
    const member = itemRecord(ownItemId, editorId);
    member.item.sectionId = sectionId;
    expectOutside(
      () =>
        prepareOwnedItemOperation(
          {
            kind: "item.update",
            itemId: ownItemId,
            expectedVersion: 4,
            patch: { transform: [1, 0, 0, 1, 900, 0] },
          },
          new Map([
            [sectionId, section],
            [ownItemId, member],
          ]),
          context,
        ),
      ownItemId,
    );
    expectOutside(
      () =>
        prepareOwnedItemOperation(
          {
            kind: "item.copy",
            sourceItemId: ownItemId,
            expectedVersion: 4,
            newItemId: copyItemId,
            translate: { x: 900, y: 0 },
          },
          new Map([
            [sectionId, section],
            [ownItemId, member],
          ]),
          context,
        ),
      copyItemId,
    );

    // A member whose bounds and membership are untouched is left to the client
    // to re-home, so a design-only edit still succeeds.
    const strayMember = itemRecord(ownItemId, editorId);
    strayMember.item.sectionId = sectionId;
    strayMember.item.transform = [1, 0, 0, 1, 900, 0];
    expect(() =>
      prepareOwnedItemOperation(
        update(ownItemId, "design"),
        new Map([
          [sectionId, section],
          [ownItemId, strayMember],
        ]),
        context,
      ),
    ).not.toThrow();
  });
});

describe("group membership ownership", () => {
  const groupId = "018f0000-0000-7000-8000-000000000021";
  const grouped = (id: string, createdBy: string, groupIdValue?: string): BoardItem => {
    const item = itemRecord(id, createdBy).item;
    if (groupIdValue !== undefined) item.groupId = groupIdValue;
    return item;
  };
  const joinEffect = (itemId: string, createdBy: string, before?: BoardItem): ItemEffect => ({
    itemId,
    before: before === undefined ? { exists: false } : { exists: true, item: before },
    after: { exists: true, item: grouped(itemId, createdBy, groupId) },
    beforeStateToken: "before",
    afterStateToken: "after",
  });
  const editor = { actorId: editorId, role: "editor" as const };

  it("lets editors join only groups whose existing members they created", () => {
    const foreignGroup = [grouped(foreignItemId, otherEditorId, groupId)];
    const ownGroup = [grouped(ownItemId, editorId, groupId)];

    expectForbidden(
      () =>
        assertGroupMembershipOwnership(
          [joinEffect(copyItemId, editorId)],
          "after",
          foreignGroup,
          editor,
        ),
      copyItemId,
    );
    expect(() =>
      assertGroupMembershipOwnership([joinEffect(copyItemId, editorId)], "after", ownGroup, editor),
    ).not.toThrow();
    expect(() =>
      assertGroupMembershipOwnership([joinEffect(copyItemId, editorId)], "after", [], editor),
    ).not.toThrow();
    // Owners may regroup anyone's work.
    expect(() =>
      assertGroupMembershipOwnership([joinEffect(copyItemId, ownerId)], "after", foreignGroup, {
        actorId: ownerId,
        role: "owner",
      }),
    ).not.toThrow();
  });

  it("ignores members that keep their group and reads the undo side when asked", () => {
    const foreignGroup = [grouped(foreignItemId, otherEditorId, groupId)];
    const unchanged = joinEffect(ownItemId, editorId, grouped(ownItemId, editorId, groupId));
    expect(() =>
      assertGroupMembershipOwnership([unchanged], "after", foreignGroup, editor),
    ).not.toThrow();

    const join = joinEffect(ownItemId, editorId, grouped(ownItemId, editorId));
    expect(() =>
      assertGroupMembershipOwnership([join], "before", foreignGroup, editor),
    ).not.toThrow();
    expectForbidden(
      () => assertGroupMembershipOwnership([join], "after", foreignGroup, editor),
      ownItemId,
    );
  });
});

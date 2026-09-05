import { DEFAULT_BOARD_FEATURES } from "@collab/protocol";
import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_TEMPLATES } from "../activities/templates";
import { ApiError } from "../transport/api";
import type { BoardComment, BoardItem, BoardSnapshot, DurableOperation } from "../types";
import {
  actorFromAccessChanged,
  attributedDataDownloadAllowed,
  attributedDataFilename,
  boardIdFromPath,
  buildCreatorNameMap,
  buildElementColourOperations,
  buildTextStyleOperations,
  CommentStore,
  canActorComment,
  canResolveComment,
  clampImageAlt,
  clampStickyText,
  conflictingMoveIssue,
  deriveCommentStates,
  effectiveTextFontWeight,
  elementColour,
  globalShortcutFor,
  imageUploadIssue,
  localSvg,
  MAX_IMAGE_UPLOAD_BYTES,
  managedInvitationStorageKey,
  objectCommentVisible,
  operationAllowedForActor,
  organisationTemplateManagementForRole,
  PendingCommitTracker,
  STAMP_CHOICES,
  STICKY_COLORS,
  savedAuthoritativeItems,
  serializeAttributedData,
  tableCellDraftFromOperation,
  templateAvailabilityIssue,
  templateFeatureIssue,
  templateHiddenByVoting,
  withAdaptiveTurnstile,
  zoneTitleDraftFromOperation,
} from "./app";

const boardId = "b_1234567890123456789012";

describe("SpaceScale browser storage", () => {
  it("uses the SpaceScale namespace for managed invitation metadata", () => {
    expect(managedInvitationStorageKey(boardId)).toBe(`spacescale:managed-invitations:${boardId}`);
  });
});

describe("effective selection font weight", () => {
  it("treats an omitted Section weight as bold and other omitted weights as normal", () => {
    expect(effectiveTextFontWeight({ kind: "zone", style: {} })).toBe("bold");
    expect(effectiveTextFontWeight({ kind: "zone", style: { fontWeight: "normal" } })).toBe(
      "normal",
    );
    expect(effectiveTextFontWeight({ kind: "sticky", style: {} })).toBe("normal");
  });
});

describe("adaptive Turnstile retry", () => {
  it("tries normal traffic without a token, then invisibly verifies and retries on demand", async () => {
    const container = {
      className: "",
      dataset: {} as Record<string, string>,
      setAttribute: vi.fn(),
      remove: vi.fn(),
    };
    const root = { append: vi.fn() };
    const removeWidget = vi.fn();
    const renderWidget = vi.fn(
      (
        _container: unknown,
        options: {
          callback(token: string): void;
        },
      ) => {
        options.callback("verified-token");
        return "widget-id";
      },
    );
    vi.stubGlobal("document", {
      createElement: () => container,
      querySelector: () => null,
    });
    vi.stubGlobal("window", {
      turnstile: {
        ready: (callback: () => void) => callback(),
        render: renderWidget,
        remove: removeWidget,
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });

    const turnstile = { enabled: true, required: false, siteKey: "public-site-key" };
    const tokens: Array<string | undefined> = [];
    try {
      const result = await withAdaptiveTurnstile(
        root as unknown as HTMLElement,
        turnstile,
        "board_create",
        async (token) => {
          tokens.push(token);
          if (tokens.length === 1) {
            throw new ApiError("TURNSTILE_REQUIRED", "Browser verification is required.", 428);
          }
          return "created";
        },
      );

      expect(result).toBe("created");
      expect(tokens).toEqual([undefined, "verified-token"]);
      expect(turnstile.required).toBe(true);
      expect(renderWidget).toHaveBeenCalledOnce();
      expect(removeWidget).toHaveBeenCalledWith("widget-id");
      expect(container.remove).toHaveBeenCalledOnce();
      expect(container.setAttribute).toHaveBeenCalledWith(
        "aria-label",
        "Checking browser security",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("creator display names", () => {
  it("combines bootstrap creators with the current participant and trims names", () => {
    const creators = [
      { id: "student-a", displayName: " Asha Patel " },
      { id: "coach", displayName: "Outdated coach name" },
      { id: "ignored", displayName: "   " },
    ];
    const self = { id: "coach", displayName: "Coach Mira" };

    expect([...buildCreatorNameMap(creators, self)]).toEqual([
      ["student-a", "Asha Patel"],
      ["coach", "Coach Mira"],
    ]);
  });

  it("accepts only a validated affected actor from access-change frames", () => {
    const actorId = `a_${"A".repeat(22)}`;
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActorId: actorId,
        affectedActor: { id: actorId, displayName: "Asha Patel" },
      }),
    ).toEqual({ id: actorId, displayName: "Asha Patel" });
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActorId: "asha@example.com",
        affectedActor: { id: "asha@example.com", displayName: "Asha Patel" },
      }),
    ).toBeNull();
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActorId: actorId,
        affectedActor: { id: actorId, displayName: "Asha\nPatel" },
      }),
    ).toBeNull();
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActorId: `a_${"B".repeat(22)}`,
        affectedActor: { id: actorId, displayName: "Asha Patel" },
      }),
    ).toBeNull();
    expect(
      actorFromAccessChanged({
        v: 1,
        t: "access.changed",
        affectedActor: { id: actorId, displayName: "Asha Patel" },
      }),
    ).toBeNull();
  });
});

describe("live Organisation-template management", () => {
  it("enables owners and disables editors or viewers after an access change", () => {
    expect(organisationTemplateManagementForRole("org-spacescale", "owner")).toBe(true);
    expect(organisationTemplateManagementForRole("org-spacescale", "editor")).toBe(false);
    expect(organisationTemplateManagementForRole("org-spacescale", "viewer")).toBe(false);
  });

  it("leaves non-Organisation Spaces outside live management synchronization", () => {
    expect(organisationTemplateManagementForRole(null, "owner")).toBeNull();
  });
});

describe("template feature preflight", () => {
  it("requires object transforms only for non-identity linear components", () => {
    const features = { ...DEFAULT_BOARD_FEATURES, objectTransforms: false };
    expect(
      templateFeatureIssue([{ kind: "rectangle", transform: [1, 0, 0, 1, 200, 100] }], features),
    ).toBeNull();
    expect(
      templateFeatureIssue([{ kind: "rectangle", transform: [0, 1, -1, 0, 200, 100] }], features),
    ).toMatch(/Scale and rotate/u);
  });

  it("hides both vote-seeding templates when voting is off, and only those", () => {
    const features = { ...DEFAULT_BOARD_FEATURES, voting: false };
    // K-W-L has a table but seeds no vote, so a table is not what makes a template vote-seeding.
    expect(templateHiddenByVoting("vote-with-stamps", features)).toBe(true);
    expect(templateHiddenByVoting("collective-inquiry-demo", features)).toBe(true);
    expect(templateHiddenByVoting("kwl", features)).toBe(false);
    expect(templateHiddenByVoting("vote-with-stamps", DEFAULT_BOARD_FEATURES)).toBe(false);
  });

  it("gives the menu and the WebMCP catalogue one answer for every template", () => {
    // The activities menu and read_templates both ask this, so a template can never be offered
    // in one place and refused in the other.
    for (const features of [
      DEFAULT_BOARD_FEATURES,
      { ...DEFAULT_BOARD_FEATURES, voting: false },
      { ...DEFAULT_BOARD_FEATURES, templates: false },
      { ...DEFAULT_BOARD_FEATURES, tables: false },
    ]) {
      for (const template of ACTIVITY_TEMPLATES) {
        const issue = templateAvailabilityIssue(template, features);
        // Anything hidden must also be refused, or the menu would show a dead button.
        if (templateHiddenByVoting(template.id, features)) expect(issue).not.toBeNull();
      }
    }
    const kwl = ACTIVITY_TEMPLATES.find(({ id }) => id === "kwl");
    if (!kwl) throw new Error("The K-W-L template is missing.");
    expect(templateAvailabilityIssue(kwl, DEFAULT_BOARD_FEATURES)).toBeNull();
    expect(templateAvailabilityIssue(kwl, { ...DEFAULT_BOARD_FEATURES, templates: false })).toMatch(
      /Enable templates/u,
    );
    expect(templateAvailabilityIssue(kwl, { ...DEFAULT_BOARD_FEATURES, tables: false })).toMatch(
      /Tables/u,
    );
  });
});

describe("student item ownership preflight", () => {
  const studentId = "student-a";
  const otherStudentId = "student-b";
  const ownItem: BoardItem = {
    id: "sticky-own",
    kind: "sticky",
    z: 1,
    version: 2,
    createdBy: studentId,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#292524",
      fontSize: 20,
      opacity: 1,
    },
    geometry: { x: 10, y: 20, width: 180, height: 140, text: "Mine" },
  };
  const foreignItem: BoardItem = {
    ...ownItem,
    id: "sticky-foreign",
    createdBy: otherStudentId,
    geometry: { ...ownItem.geometry, x: 220, text: "Theirs" },
  };
  const items = new Map([
    [ownItem.id, ownItem],
    [foreignItem.id, foreignItem],
  ]);

  it("allows owners to change any item and editors to change only their own", () => {
    const foreignUpdate: DurableOperation = {
      kind: "item.update",
      itemId: foreignItem.id,
      expectedVersion: foreignItem.version,
      patch: { transform: [1, 0, 0, 1, 40, 20] },
    };
    const ownUpdate: DurableOperation = {
      ...foreignUpdate,
      itemId: ownItem.id,
    };

    expect(operationAllowedForActor(foreignUpdate, "owner", "coach", items)).toBe(true);
    expect(operationAllowedForActor(ownUpdate, "editor", studentId, items)).toBe(true);
    expect(operationAllowedForActor(foreignUpdate, "editor", studentId, items)).toBe(false);
    expect(
      operationAllowedForActor(
        {
          kind: "item.delete",
          itemId: foreignItem.id,
          expectedVersion: foreignItem.version,
        },
        "editor",
        studentId,
        items,
      ),
    ).toBe(false);
  });

  it("lets a Section creator detach a foreign member without granting other edits", () => {
    const section: BoardItem = {
      id: "section-mine",
      kind: "zone",
      z: 0,
      version: 1,
      createdBy: studentId,
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "zone",
        borderColor: "#60a5fa",
        fill: "#eff6ff",
        textColor: "#1e3a8a",
        fontSize: 20,
        opacity: 0.8,
      },
      geometry: { x: 0, y: 0, width: 600, height: 400, title: "Mine" },
    };
    const foreignMember: BoardItem = {
      ...foreignItem,
      id: "sticky-member",
      sectionId: section.id,
    };
    const scoped = new Map<string, BoardItem>([
      [section.id, section],
      [foreignMember.id, foreignMember],
      [ownItem.id, ownItem],
    ]);
    const detach: DurableOperation = {
      kind: "item.update",
      itemId: foreignMember.id,
      expectedVersion: foreignMember.version,
      patch: { sectionId: null },
    };
    const deleteSectionWithDetach: DurableOperation = {
      kind: "items.batch",
      operations: [
        { kind: "item.delete", itemId: section.id, expectedVersion: section.version },
        detach,
      ],
    };

    expect(operationAllowedForActor(detach, "editor", studentId, scoped)).toBe(true);
    expect(operationAllowedForActor(deleteSectionWithDetach, "editor", studentId, scoped)).toBe(
      true,
    );
    // Not the Section's creator: no special right over the member.
    expect(operationAllowedForActor(detach, "editor", "student-c", scoped)).toBe(false);
    // Anything beyond a bare detach still needs ownership of the member.
    expect(
      operationAllowedForActor(
        { ...detach, patch: { sectionId: null, transform: [1, 0, 0, 1, 5, 5] } },
        "editor",
        studentId,
        scoped,
      ),
    ).toBe(false);
    expect(
      operationAllowedForActor(
        { ...detach, patch: { sectionId: section.id } },
        "editor",
        studentId,
        scoped,
      ),
    ).toBe(false);
  });

  it("allows a foreign copy but rejects a batch containing any foreign mutation", () => {
    const copy: DurableOperation = {
      kind: "item.copy",
      sourceItemId: foreignItem.id,
      expectedVersion: foreignItem.version,
      newItemId: "sticky-copy",
      translate: { x: 20, y: 20 },
    };
    expect(operationAllowedForActor(copy, "editor", studentId, items)).toBe(true);
    expect(
      operationAllowedForActor(
        {
          kind: "items.batch",
          operations: [
            {
              kind: "item.update",
              itemId: ownItem.id,
              expectedVersion: ownItem.version,
              patch: { geometry: { ...ownItem.geometry, text: "Changed" } },
            },
            {
              kind: "item.delete",
              itemId: foreignItem.id,
              expectedVersion: foreignItem.version,
            },
          ],
        },
        "editor",
        studentId,
        items,
      ),
    ).toBe(false);
  });

  it("blocks everyone from mutating locked Section contents while allowing an owner unlock", () => {
    const section: BoardItem = {
      id: "locked-section",
      kind: "zone",
      z: 1,
      version: 5,
      createdBy: "coach",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "zone",
        borderColor: "#60a5fa",
        fill: "#eff6ff",
        textColor: "#1e3a8a",
        fontSize: 20,
        opacity: 0.8,
      },
      geometry: { x: 0, y: 0, width: 600, height: 400, title: "Review", locked: true },
    };
    const member: BoardItem = { ...ownItem, sectionId: section.id };
    const lockedItems = new Map<string, BoardItem>([
      [section.id, section],
      [member.id, member],
    ]);
    const updateMember: DurableOperation = {
      kind: "item.update",
      itemId: member.id,
      expectedVersion: member.version,
      patch: { geometry: { ...member.geometry, text: "Blocked" } },
    };
    const copyMember: DurableOperation = {
      kind: "item.copy",
      sourceItemId: member.id,
      expectedVersion: member.version,
      newItemId: "locked-copy",
      translate: { x: 20, y: 20 },
    };
    const unlock: DurableOperation = {
      kind: "item.update",
      itemId: section.id,
      expectedVersion: section.version,
      patch: { geometry: { ...section.geometry, locked: false } },
    };

    expect(operationAllowedForActor(updateMember, "owner", "coach", lockedItems)).toBe(false);
    expect(operationAllowedForActor(updateMember, "editor", studentId, lockedItems)).toBe(false);
    expect(operationAllowedForActor(copyMember, "owner", "coach", lockedItems)).toBe(false);
    expect(operationAllowedForActor(unlock, "owner", "coach", lockedItems)).toBe(true);
    expect(operationAllowedForActor(unlock, "editor", studentId, lockedItems)).toBe(false);
  });

  it("keeps editor history available while viewers cannot commit", () => {
    expect(
      operationAllowedForActor(
        { kind: "history.undo", expectedHistoryVersion: 3 },
        "editor",
        studentId,
        items,
      ),
    ).toBe(true);
    expect(
      operationAllowedForActor(
        {
          kind: "item.create",
          item: {
            id: "new-sticky",
            kind: "sticky",
            transform: [1, 0, 0, 1, 0, 0],
            style: ownItem.style,
            geometry: ownItem.geometry,
          },
        },
        "viewer",
        "observer",
        items,
      ),
    ).toBe(false);
  });
});

describe("board path routing", () => {
  it("accepts normal and embedded Space paths", () => {
    expect(boardIdFromPath(`/b/${boardId}`)).toBe(boardId);
    expect(boardIdFromPath(`/b/${boardId}/`)).toBe(boardId);
    expect(boardIdFromPath(`/embed/b/${boardId}`)).toBe(boardId);
    expect(boardIdFromPath(`/embed/b/${boardId}/`)).toBe(boardId);
  });

  it("rejects launch and malformed paths", () => {
    expect(boardIdFromPath("/embed")).toBeNull();
    expect(boardIdFromPath(`/other/b/${boardId}`)).toBeNull();
    expect(boardIdFromPath("/embed/b/not-a-board")).toBeNull();
  });
});

describe("attributed data download", () => {
  it("is visible to every owner and hidden from editors and viewers", () => {
    expect(attributedDataDownloadAllowed("owner")).toBe(true);
    expect(attributedDataDownloadAllowed("editor")).toBe(false);
    expect(attributedDataDownloadAllowed("viewer")).toBe(false);
  });

  it("uses an attributed-data filename and preserves attributed text as formatted JSON", () => {
    const data = {
      format: "cf-whiteboard-attributed-json" as const,
      version: 1 as const,
      board: {
        id: boardId,
        title: "Peer Feedback: 7/B",
        seq: 12,
        stateCreatedAt: 1_900_000_000_000,
      },
      participants: [
        {
          id: "a_1234567890123456789012",
          displayName: "Asha Patel",
          participantHash: "a_1234567890123456789012",
          role: "editor" as const,
          status: "active" as const,
        },
        {
          id: "a_2345678901234567890123",
          displayName: "Ben Shah",
          participantHash: "a_2345678901234567890123",
          role: null,
          status: "referenced" as const,
        },
      ],
      objects: [
        {
          item: {
            id: "018f47a1-7a2b-7c3d-8e4f-123456789abd",
            kind: "sticky" as const,
            z: 1,
            version: 1,
            createdBy: "a_2345678901234567890123",
            transform: [1, 0, 0, 1, 0, 0] as const,
            style: {
              kind: "sticky" as const,
              fill: "#fde68a",
              textColor: "#292524",
              fontSize: 20,
              opacity: 1,
            },
            geometry: {
              x: 10,
              y: 20,
              width: 180,
              height: 140,
              text: "Could you explain the second step?",
            },
          },
          attribution: {
            createdBy: {
              id: "a_2345678901234567890123",
              displayName: "Coach Mira",
              participantHash: "a_2345678901234567890123",
            },
            lastModifiedBy: {
              id: "a_1234567890123456789012",
              displayName: "Asha Patel",
              participantHash: "a_1234567890123456789012",
            },
            updatedSeq: 12,
            updatedAt: 1_900_000_001_000,
          },
          content: [
            {
              kind: "sticky_text" as const,
              text: "Could you explain the second step?",
              responsibleUser: {
                id: "a_1234567890123456789012",
                displayName: "Asha Patel",
                participantHash: "a_1234567890123456789012",
              },
              lastChangedBy: {
                id: "a_1234567890123456789012",
                displayName: "Asha Patel",
                participantHash: "a_1234567890123456789012",
              },
              updatedSeq: 12,
              updatedAt: 1_900_000_001_000,
            },
          ],
        },
        {
          item: {
            id: "018f47a1-7a2b-7c3d-8e4f-123456789abe",
            kind: "table" as const,
            z: 2,
            version: 1,
            createdBy: "a_2345678901234567890123",
            transform: [1, 0, 0, 1, 0, 0] as const,
            style: {
              kind: "table" as const,
              borderColor: "#a8a59d",
              fill: "#fffefa",
              headerFill: "#e8edff",
              textColor: "#20201e",
              fontSize: 16,
              opacity: 1,
            },
            geometry: {
              x: 220,
              y: 20,
              columnWidths: [120],
              rowHeights: [48],
              cells: [[""]],
            },
          },
          attribution: {
            createdBy: {
              id: "a_2345678901234567890123",
              displayName: "Coach Mira",
              participantHash: "a_2345678901234567890123",
            },
            lastModifiedBy: {
              id: "a_2345678901234567890123",
              displayName: "Coach Mira",
              participantHash: "a_2345678901234567890123",
            },
            updatedSeq: 11,
            updatedAt: 1_900_000_000_500,
          },
          content: [
            {
              kind: "table_cell" as const,
              row: 0,
              column: 0,
              text: "",
              responsibleUser: null,
              lastChangedBy: null,
              updatedSeq: null,
              updatedAt: null,
            },
          ],
        },
      ],
    };

    expect(attributedDataFilename(data.board.title)).toBe("peer-feedback-7-b-attributed-data.json");
    const serialized = serializeAttributedData(data);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(data);
    expect(serialized).toContain('"text": "Could you explain the second step?"');
    expect(serialized).toContain('"responsibleUser": null');
    expect(serialized).toContain('"displayName": "Asha Patel"');
    expect(serialized).toContain('"id": "a_1234567890123456789012"');
    expect(serialized).not.toContain("@example.com");
  });
});

describe("sticky note UI configuration", () => {
  it("offers the six classroom palette colours", () => {
    expect(STICKY_COLORS.map(({ name }) => name)).toEqual([
      "Yellow",
      "Coral",
      "Lavender",
      "Mint",
      "Sky",
      "Slate",
    ]);
    expect(STICKY_COLORS.every(({ value }) => /^#[0-9a-f]{6}$/.test(value))).toBe(true);
  });

  it("builds all-or-nothing versioned recolor updates without changing other style fields", () => {
    const first: Extract<BoardItem, { kind: "sticky" }> = {
      id: "sticky-a",
      kind: "sticky",
      z: 1,
      version: 4,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "sticky",
        fill: "#fde68a",
        textColor: "#292524",
        fontSize: 20,
        opacity: 0.9,
      },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "First" },
    };
    const second: Extract<BoardItem, { kind: "sticky" }> = {
      ...first,
      id: "sticky-b",
      z: 2,
      version: 6,
      style: { ...first.style, fill: "#bfdbfe" },
      geometry: { ...first.geometry, x: 220, text: "Second" },
    };

    expect(buildElementColourOperations([first, second], "#fecdd3")).toEqual([
      {
        kind: "item.update",
        itemId: "sticky-a",
        expectedVersion: 4,
        patch: { style: { ...first.style, fill: "#fecdd3" } },
      },
      {
        kind: "item.update",
        itemId: "sticky-b",
        expectedVersion: 6,
        patch: { style: { ...second.style, fill: "#fecdd3" } },
      },
    ]);
    expect(buildElementColourOperations([first, { ...second, version: 0 }], "#fecdd3")).toEqual([]);

    const authoritative = new Map<string, BoardItem>([
      [first.id, first],
      [second.id, second],
    ]);
    expect(savedAuthoritativeItems([first.id, second.id], authoritative, authoritative)).toEqual([
      first,
      second,
    ]);
    const renderedWithPending = new Map<string, BoardItem>([
      [first.id, first],
      [second.id, { ...second, version: 0 }],
    ]);
    expect(
      savedAuthoritativeItems([first.id, second.id], renderedWithPending, authoritative),
    ).toBeNull();
  });

  it("refuses per-note moves the board's own propagation would tear apart", () => {
    const note: Extract<BoardItem, { kind: "sticky" }> = {
      id: "sticky-a",
      kind: "sticky",
      z: 1,
      version: 4,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "sticky", fill: "#fde68a", textColor: "#292524", fontSize: 20, opacity: 1 },
      geometry: { x: 10, y: 20, width: 180, height: 140, text: "First" },
    };
    const section: Extract<BoardItem, { kind: "zone" }> = {
      id: "zone-1",
      kind: "zone",
      z: 0,
      version: 2,
      createdBy: "teacher",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "zone",
        borderColor: "#0284c7",
        fill: "#e0f2fe",
        textColor: "#0c4a6e",
        fontSize: 18,
        opacity: 1,
      },
      geometry: { x: 0, y: 0, width: 800, height: 600, title: "Ideas" },
    };
    const move = (x: number) => ({ x, y: 0 });

    // Two members of one group sent to different places would drift apart while still grouped.
    const grouped = { ...note, groupId: "group-1" };
    const peer = { ...grouped, id: "sticky-b", version: 6 };
    expect(
      conflictingMoveIssue(
        [grouped, peer],
        new Map([
          ["sticky-a", move(10)],
          ["sticky-b", move(40)],
        ]),
        [grouped, peer],
      ),
    ).toContain("pull that unit apart");
    // The same shift keeps the unit intact, and naming one member is how a drag moves a group.
    expect(
      conflictingMoveIssue(
        [grouped, peer],
        new Map([
          ["sticky-a", move(10)],
          ["sticky-b", move(10)],
        ]),
        [grouped, peer],
      ),
    ).toBeNull();
    expect(
      conflictingMoveIssue([grouped], new Map([["sticky-a", move(10)]]), [grouped, peer]),
    ).toBeNull();

    // A note asked to stay put is a different shift, not an absence of one: the moving member
    // would otherwise carry it along while the result claimed it had not budged.
    expect(
      conflictingMoveIssue(
        [grouped, peer],
        new Map([
          ["sticky-a", move(0)],
          ["sticky-b", move(40)],
        ]),
        [grouped, peer],
      ),
    ).toContain("pull that unit apart");

    // A note grouped with a Section carries that Section, which carries the Section's own
    // members — so a member named with a different shift conflicts two relations away.
    const groupedWithSection = { ...note, groupId: "group-2" };
    const sectionInGroup = { ...section, groupId: "group-2" };
    const insideSection = { ...note, id: "sticky-c", version: 9, sectionId: "zone-1" };
    const board = [groupedWithSection, sectionInGroup, insideSection];
    expect(
      conflictingMoveIssue(
        [groupedWithSection, insideSection],
        new Map([
          ["sticky-a", move(10)],
          ["sticky-c", move(40)],
        ]),
        board,
      ),
    ).toContain("pull that unit apart");

    // Propagation runs one way: a Section carries its members, but a member never carries the
    // Section, so two notes that merely share one stay independent however far apart they go.
    const alsoInside = { ...insideSection, id: "sticky-d", version: 11 };
    expect(
      conflictingMoveIssue(
        [insideSection, alsoInside],
        new Map([
          ["sticky-c", move(10)],
          ["sticky-d", move(900)],
        ]),
        [section, insideSection, alsoInside],
      ),
    ).toBeNull();

    // Notes in no group and no Section are independent.
    const loose = { ...note, id: "sticky-e" };
    expect(
      conflictingMoveIssue(
        [note, loose],
        new Map([
          ["sticky-a", move(10)],
          ["sticky-e", move(900)],
        ]),
        [note, loose],
      ),
    ).toBeNull();
  });

  it("preserves unrelated text style while changing colour, family, and size", () => {
    const text: Extract<BoardItem, { kind: "text" }> = {
      id: "text-a",
      kind: "text",
      z: 1,
      version: 3,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "text",
        color: "#1e1e1e",
        fontSize: 28,
        fontFamily: "sans",
        opacity: 0.8,
      },
      geometry: { x: 10, y: 20, text: "Question" },
    };
    const video: Extract<BoardItem, { kind: "text" }> = {
      ...text,
      id: "video-a",
      geometry: {
        ...text.geometry,
        text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        embed: "video",
      },
    };

    expect(buildElementColourOperations([text], "#874fff")).toEqual([
      {
        kind: "item.update",
        itemId: "text-a",
        expectedVersion: 3,
        patch: { style: { ...text.style, color: "#874fff" } },
      },
    ]);
    expect(elementColour(video)).toBeNull();
    expect(buildElementColourOperations([video], "#874fff")).toEqual([]);
    expect(buildElementColourOperations([text, video], "#874fff")).toEqual([]);
    expect(buildTextStyleOperations([text], { fontFamily: "handwritten", fontSize: 52 })).toEqual([
      {
        kind: "item.update",
        itemId: "text-a",
        expectedVersion: 3,
        patch: {
          style: { ...text.style, fontFamily: "handwritten", fontSize: 52 },
        },
      },
    ]);
    expect(buildTextStyleOperations([video], { fontFamily: "serif", fontSize: 72 })).toEqual([]);

    const sticky: Extract<BoardItem, { kind: "sticky" }> = {
      id: "sticky-a",
      kind: "sticky",
      z: 2,
      version: 5,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "sticky",
        fill: "#ffdf8a",
        textColor: "#20201e",
        fontSize: 20,
        opacity: 1,
      },
      geometry: { x: 20, y: 30, width: 180, height: 140, text: "Evidence" },
    };
    expect(
      buildTextStyleOperations([sticky], {
        fontFamily: "serif",
        fontWeight: "bold",
        fontStyle: "italic",
        textDecoration: "underline",
      }),
    ).toEqual([
      {
        kind: "item.update",
        itemId: "sticky-a",
        expectedVersion: 5,
        patch: {
          style: {
            ...sticky.style,
            fontFamily: "serif",
            fontWeight: "bold",
            fontStyle: "italic",
            textDecoration: "underline",
          },
        },
      },
    ]);
  });

  it("clears Section membership when font size expands text outside its Section", () => {
    const section: Extract<BoardItem, { kind: "zone" }> = {
      id: "section-a",
      kind: "zone",
      z: 1,
      version: 2,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "zone",
        borderColor: "#60a5fa",
        fill: "#eff6ff",
        textColor: "#1e3a8a",
        fontSize: 20,
        opacity: 0.8,
      },
      geometry: { x: 0, y: 0, width: 100, height: 100, title: "Text" },
    };
    const text: Extract<BoardItem, { kind: "text" }> = {
      id: "text-section-member",
      kind: "text",
      sectionId: section.id,
      z: 2,
      version: 3,
      createdBy: "student-a",
      transform: [1, 0, 0, 1, 0, 0],
      style: { kind: "text", color: "#1e1e1e", fontSize: 10, fontFamily: "sans", opacity: 1 },
      geometry: { x: 10, y: 30, text: "Question" },
    };

    expect(buildTextStyleOperations([text], { fontSize: 30 }, [section, text], false)).toEqual([
      {
        kind: "item.update",
        itemId: text.id,
        expectedVersion: text.version,
        patch: { style: { ...text.style, fontSize: 30 }, sectionId: null },
      },
    ]);
  });

  it("limits input by Unicode code point rather than UTF-16 length", () => {
    const value = `${"😀".repeat(1_000)}overflow`;
    const clamped = clampStickyText(value);
    expect([...clamped]).toHaveLength(1_000);
    expect(clamped).toBe("😀".repeat(1_000));
  });

  it("escapes the accessible title and wraps escaped sticky text in local SVG", () => {
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 4,
      items: [
        {
          id: "018f47a1-7a2b-7c3d-8e4f-123456789abd",
          kind: "sticky",
          z: 1,
          version: 4,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [1, 0, 0, 1, 0, 0],
          style: {
            kind: "sticky",
            fill: "#fde68a",
            textColor: "#292524",
            fontSize: 20,
            opacity: 1,
          },
          geometry: {
            x: 10,
            y: 20,
            width: 180,
            height: 140,
            text: "one <tag> & two three four",
          },
        },
      ],
    };

    const svg = localSvg(snapshot, `Class "<ideas>" & 'notes'`);

    expect(svg).toContain('aria-label="Class &quot;&lt;ideas&gt;&quot; &amp; &apos;notes&apos;"');
    expect(svg).toContain('<tspan x="24" dy="0">one &lt;tag&gt; &amp;</tspan>');
    expect(svg).toContain('<tspan x="24" dy="24">two three</tspan>');
    expect(svg).not.toContain("<tag>");
  });

  it("frames a sticky using its complete affine transform", () => {
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 1,
      items: [
        {
          id: "018f47a1-7a2b-7c3d-8e4f-123456789abe",
          kind: "sticky",
          z: 1,
          version: 1,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [0, 1, -1, 0, 200, 10],
          style: {
            kind: "sticky",
            fill: "#fde68a",
            textColor: "#292524",
            fontSize: 20,
            opacity: 1,
          },
          geometry: { x: 0, y: 0, width: 100, height: 50, text: "Rotated" },
        },
      ],
    };

    expect(localSvg(snapshot, "Rotated sticky")).toContain('viewBox="118 -22 114 164"');
  });

  it("keeps literal TeX source inside the local recovery SVG viewBox", () => {
    const source = "$$\\displaystyle x$$";
    const fontSize = 20;
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 1,
      items: [
        {
          id: "018f47a1-7a2b-7c3d-8e4f-123456789abf",
          kind: "text",
          z: 1,
          version: 1,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [1, 0, 0, 1, 0, 0],
          style: {
            kind: "text",
            color: "#112233",
            fontSize,
            fontFamily: "sans",
            opacity: 1,
          },
          geometry: { x: 100, y: 40, text: source },
        },
      ],
    };
    const maxX = 100 + Array.from(source).length * fontSize * 0.6;

    expect(localSvg(snapshot, "Math recovery")).toContain(`viewBox="68 -12 ${maxX - 100 + 64} 88"`);
  });
});

describe("image card UI validation", () => {
  it("prechecks supported MIME types, empty files, and the classroom size limit", () => {
    expect(imageUploadIssue({ type: "image/png", size: 1_024 })).toBeNull();
    expect(imageUploadIssue({ type: "image/svg+xml", size: 1_024 })).toContain(
      "PNG, JPEG, WebP, or GIF",
    );
    expect(imageUploadIssue({ type: "image/png", size: 0 })).toContain("empty");
    expect(imageUploadIssue({ type: "image/png", size: MAX_IMAGE_UPLOAD_BYTES + 1 })).toContain(
      "5 MiB",
    );
  });

  it("limits alt text by Unicode code point", () => {
    expect(clampImageAlt(`${"😀".repeat(500)}overflow`)).toBe("😀".repeat(500));
  });
});

describe("table cell draft recovery", () => {
  it("recovers the exact single-cell text from a rejected whole-geometry update", () => {
    const item: Extract<BoardItem, { kind: "table" }> = {
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac1",
      kind: "table",
      z: 1,
      version: 7,
      createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "table",
        borderColor: "#a8a59d",
        fill: "#fffefa",
        headerFill: "#e8edff",
        textColor: "#20201e",
        fontSize: 16,
        opacity: 1,
      },
      geometry: {
        x: 10,
        y: 20,
        columnWidths: [120, 120],
        rowHeights: [48, 48],
        cells: [
          ["Topic", "Evidence"],
          ["Before", ""],
        ],
      },
    };
    const geometry = structuredClone(item.geometry);
    const editedRow = geometry.cells[1];
    if (!editedRow) throw new Error("Expected the second table row.");
    editedRow[0] = "Student draft must survive exactly <&> 😀";
    const operation: DurableOperation = {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry },
    };

    expect(tableCellDraftFromOperation(operation, new Map([[item.id, item]]))).toEqual({
      itemId: item.id,
      row: 1,
      column: 0,
      text: "Student draft must survive exactly <&> 😀",
      selectionStart: 41,
      selectionEnd: 41,
    });

    geometry.columnWidths[0] = 180;
    expect(tableCellDraftFromOperation(operation, new Map([[item.id, item]]))).toBeUndefined();
  });
});

describe("zone title draft recovery", () => {
  it("recovers title-only updates and ignores rejected zone resizes", () => {
    const item: Extract<BoardItem, { kind: "zone" }> = {
      id: "018f47a1-7a2b-7c3d-8e4f-123456789ac2",
      kind: "zone",
      z: 1,
      version: 4,
      createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
      transform: [1, 0, 0, 1, 0, 0],
      style: {
        kind: "zone",
        borderColor: "#a8a59d",
        fill: "#e8edff",
        textColor: "#4f5b75",
        fontSize: 18,
        opacity: 0.18,
      },
      geometry: { x: 10, y: 20, width: 520, height: 320, title: "Evidence" },
    };
    const titleOperation: DurableOperation = {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry: { ...item.geometry, title: "Questions" } },
    };
    expect(zoneTitleDraftFromOperation(titleOperation, new Map([[item.id, item]]))).toMatchObject({
      itemId: item.id,
      title: "Questions",
    });

    const resizeOperation: DurableOperation = {
      kind: "item.update",
      itemId: item.id,
      expectedVersion: item.version,
      patch: { geometry: { ...item.geometry, width: 680, height: 420 } },
    };
    expect(
      zoneTitleDraftFromOperation(resizeOperation, new Map([[item.id, item]])),
    ).toBeUndefined();
  });
});

describe("stamp UI configuration", () => {
  it("offers the six classroom stamp designs", () => {
    expect(STAMP_CHOICES.map(({ kind }) => kind)).toEqual([
      "star",
      "check",
      "heart",
      "question",
      "smile",
      "sparkle",
    ]);
    expect(new Set(STAMP_CHOICES.map(({ glyph }) => glyph)).size).toBe(6);
  });

  it("exports a centered stamp using the shared deterministic SVG path", () => {
    const itemId = "018f47a1-7a2b-7c3d-8e4f-123456789abf";
    const snapshot: BoardSnapshot = {
      format: "cf-whiteboard-json",
      version: 1,
      seq: 5,
      items: [
        {
          id: itemId,
          kind: "stamp",
          z: 1,
          version: 1,
          createdBy: "018f47a1-7a2b-7c3d-8e4f-123456789abc",
          transform: [1, 0, 0, 1, 0, 0],
          style: { kind: "stamp", color: "#8e4ec6", opacity: 0.75 },
          geometry: { x: 100, y: 80, size: 72, stamp: "star" },
        },
      ],
    };

    const svg = localSvg(snapshot, "Stamp feedback");

    expect(svg).toContain('viewBox="32 12 136 136"');
    expect(svg).toContain(`data-item-id="${itemId}"`);
    expect(svg).toContain('transform="translate(64 44) scale(3)"');
    expect(svg).toContain('fill="#8e4ec6"');
    expect(svg).toContain('opacity="0.75"');
    expect(svg).not.toContain("<text");
  });
});

describe("object comment visibility", () => {
  it("shows only open comments by default and reveals hidden states on request", () => {
    expect(objectCommentVisible("open", false)).toBe(true);
    expect(objectCommentVisible("resolved", false)).toBe(false);
    expect(objectCommentVisible("orphaned", false)).toBe(false);
    expect(objectCommentVisible("resolved", true)).toBe(true);
    expect(objectCommentVisible("orphaned", true)).toBe(true);
  });
});

describe("object comment permissions", () => {
  it("mirrors the server gate: drawing roles may comment, and a lock does not block them", () => {
    expect(canActorComment("ready", "owner", "editors_enabled")).toBe(true);
    expect(canActorComment("connecting", "editor", "editors_enabled")).toBe(true);
    expect(canActorComment("ready", "viewer", "editors_enabled")).toBe(false);
    expect(canActorComment("ready", "editor", "owner_only")).toBe(false);
    expect(canActorComment("ready", "owner", "locked")).toBe(true);
    expect(canActorComment("ready", "editor", "locked")).toBe(true);
    expect(canActorComment("ready", "viewer", "locked")).toBe(false);
    expect(canActorComment("archived", "owner", "editors_enabled")).toBe(false);
    expect(canActorComment("reload_required", "owner", "editors_enabled")).toBe(false);
    expect(canActorComment("stopped", "owner", "editors_enabled")).toBe(false);
  });

  it("offers Resolve only to the comment author or a board owner", () => {
    const authored = { author: { id: "a_author", displayName: "Author" } };
    expect(canResolveComment(authored, "a_author", "editor")).toBe(true);
    expect(canResolveComment(authored, "a_other", "editor")).toBe(false);
    expect(canResolveComment(authored, "a_other", "viewer")).toBe(false);
    expect(canResolveComment(authored, "a_other", "owner")).toBe(true);
  });
});

function comment(overrides: Partial<BoardComment> = {}): BoardComment {
  return {
    id: "c_1",
    itemId: "item_1",
    body: "Look here",
    state: "open",
    author: { id: "a_1", displayName: "Ada" },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("object comment states", () => {
  it("shows an open comment as orphaned only while its object is missing", () => {
    const open = comment();
    const resolved = comment({ id: "c_2", state: "resolved" });
    const serverOrphaned = comment({ id: "c_3", state: "orphaned" });
    const missing = deriveCommentStates([open, resolved, serverOrphaned], () => false);
    expect(missing.map((value) => value.state)).toEqual(["orphaned", "resolved", "orphaned"]);
    const present = deriveCommentStates([open, resolved, serverOrphaned], () => true);
    expect(present.map((value) => value.state)).toEqual(["open", "resolved", "orphaned"]);
    expect(present[0]).toBe(open);
  });

  it("flips a locally orphaned comment back to open when a rejected delete restores its object", () => {
    const items = new Set(["item_1"]);
    const store = new CommentStore((itemId) => items.has(itemId));
    const load = store.beginLoad();
    expect(store.completeLoad(load, [comment()])).toBe(true);
    expect(store.comments[0]?.state).toBe("open");

    items.delete("item_1");
    expect(store.reconcile()).toBe(true);
    expect(store.comments[0]?.state).toBe("orphaned");
    expect(store.reconcile()).toBe(false);

    items.add("item_1");
    expect(store.reconcile()).toBe(true);
    expect(store.comments[0]?.state).toBe("open");
  });

  it("keeps a local write ahead of an older in-flight load", () => {
    const store = new CommentStore(() => true);
    const stale = store.beginLoad();
    store.upsert(comment({ id: "c_new", createdAt: 2_000, updatedAt: 2_000 }));
    expect(store.comments.map((value) => value.id)).toEqual(["c_new"]);

    expect(store.completeLoad(stale, [comment({ id: "c_old" })])).toBe(false);
    expect(store.comments.map((value) => value.id)).toEqual(["c_new"]);
    expect(store.isLatestLoad(stale)).toBe(true);

    const fresh = store.beginLoad();
    expect(store.isLatestLoad(stale)).toBe(false);
    expect(store.completeLoad(fresh, [comment({ id: "c_old" }), comment({ id: "c_new" })])).toBe(
      true,
    );
    expect(store.comments.map((value) => value.id)).toEqual(["c_old", "c_new"]);
  });

  it("reports a resolved comment as a change without flipping its state", () => {
    const store = new CommentStore(() => true);
    store.completeLoad(store.beginLoad(), [comment()]);
    store.upsert(comment({ state: "resolved", updatedAt: 3_000 }));
    expect(store.comments[0]?.state).toBe("resolved");
    expect(store.reconcile()).toBe(false);
  });
});

describe("tool commit tracking", () => {
  it("withdraws a queued command on timeout and reports the failure", () => {
    vi.useFakeTimers();
    try {
      const tracker = new PendingCommitTracker(30_000);
      const resolve = vi.fn();
      const withdraw = vi.fn(() => true);
      tracker.track("cmd_1", resolve, withdraw);
      vi.advanceTimersByTime(29_999);
      expect(withdraw).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(withdraw).toHaveBeenCalledWith("cmd_1");
      expect(resolve).toHaveBeenCalledWith(false);
      tracker.finish("cmd_1", true);
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports success when the server already answered before the timeout fired", () => {
    vi.useFakeTimers();
    try {
      const tracker = new PendingCommitTracker(30_000);
      const resolve = vi.fn();
      tracker.track("cmd_1", resolve, () => false);
      vi.advanceTimersByTime(30_000);
      expect(resolve).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the timer on an authoritative answer and settles the rest on destroy", () => {
    vi.useFakeTimers();
    try {
      const tracker = new PendingCommitTracker(30_000);
      const acked = vi.fn();
      const abandoned = vi.fn();
      const withdraw = vi.fn(() => true);
      tracker.track("cmd_1", acked, withdraw);
      tracker.track("cmd_2", abandoned, withdraw);
      tracker.finish("cmd_1", true);
      expect(acked).toHaveBeenCalledWith(true);
      tracker.finishAll(false);
      expect(abandoned).toHaveBeenCalledWith(false);
      vi.advanceTimersByTime(30_000);
      expect(withdraw).not.toHaveBeenCalled();
      expect(acked).toHaveBeenCalledTimes(1);
      expect(abandoned).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("global keyboard shortcuts", () => {
  const idle = {
    editing: false,
    toolsMenuOpen: false,
    shapeMenuOpen: false,
    followingSpotlight: false,
  };
  const escapeKey = { key: "Escape", ctrlKey: false, metaKey: false, shiftKey: false };

  it("lets Escape close menus and stop spotlight-follow even from an input", () => {
    expect(globalShortcutFor(escapeKey, { ...idle, editing: true, toolsMenuOpen: true })).toBe(
      "close-tools-menu",
    );
    expect(globalShortcutFor(escapeKey, { ...idle, editing: true, shapeMenuOpen: true })).toBe(
      "close-shape-menu",
    );
    expect(globalShortcutFor(escapeKey, { ...idle, editing: true, followingSpotlight: true })).toBe(
      "stop-following-spotlight",
    );
    expect(globalShortcutFor(escapeKey, { ...idle, editing: true })).toBeNull();
  });

  it("keeps undo and redo out of text fields while honouring them elsewhere", () => {
    const undo = { key: "z", ctrlKey: true, metaKey: false, shiftKey: false };
    expect(globalShortcutFor(undo, idle)).toBe("undo");
    expect(globalShortcutFor({ ...undo, shiftKey: true }, idle)).toBe("redo");
    expect(globalShortcutFor({ ...undo, key: "y" }, idle)).toBe("redo");
    expect(
      globalShortcutFor({ ...undo, key: "y", ctrlKey: false, metaKey: true }, idle),
    ).toBeNull();
    expect(globalShortcutFor(undo, { ...idle, editing: true })).toBeNull();
    expect(globalShortcutFor({ ...undo, ctrlKey: false }, idle)).toBeNull();
  });
});

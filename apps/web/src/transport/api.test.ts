import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, parseBoardComment, takeEmbedLaunch } from "./api";

type CapturedRequest = { path: string; init: RequestInit };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adaptive Turnstile session state", () => {
  it("keeps the server-derived challenge requirement separate from global enablement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          csrfToken: "csrf-token",
          turnstile: {
            enabled: true,
            required: false,
            siteKey: "public-site-key",
          },
        }),
      ),
    );

    const api = new ApiClient();
    await api.ensureSession();

    expect(api.turnstile).toEqual({
      enabled: true,
      required: false,
      siteKey: "public-site-key",
    });
  });
});

describe("owner recovery APIs", () => {
  it("sends CSRF and idempotency headers for invitations, snapshots, and restore", async () => {
    const requests: CapturedRequest[] = [];
    const responses: unknown[] = [
      { csrfToken: "csrf-token" },
      {
        invitation: {
          id: "i_1234567890123456789012",
          role: "editor",
          label: "Workshop",
          maxUses: 1,
          expiresAt: 2_000_000_000_000,
        },
        token: "one-time-token",
        url: "https://example.test/b/board#invite=one-time-token",
        idempotentReplay: false,
      },
      { invitationId: "i_1234567890123456789012", revoked: true },
      {
        snapshot: {
          seq: 7,
          sha256: "digest",
          itemCount: 2,
          byteCount: 512,
          kind: "named",
          label: "Before workshop",
          createdAt: 1_900_000_000_000,
        },
      },
      { restoredFromSeq: 7, seq: 9, requiresResync: false },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({ path: String(input), init });
      return Response.json(responses.shift());
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new ApiClient();
    await api.ensureSession();
    const invitation = await api.createInvitation("b_1234567890123456789012", {
      role: "editor",
      label: "Workshop",
      maxUses: 1,
      expiresAt: 2_000_000_000_000,
    });
    await api.revokeInvitation("b_1234567890123456789012", invitation.invitation.id);
    const snapshot = await api.createNamedSnapshot("b_1234567890123456789012", "Before workshop");
    const restored = await api.restoreSnapshot("b_1234567890123456789012", snapshot.seq, 8);

    expect(invitation.invitation.id).toBe("i_1234567890123456789012");
    expect(snapshot).toMatchObject({ seq: 7, kind: "named", label: "Before workshop" });
    expect(restored).toEqual({ restoredFromSeq: 7, seq: 9, requiresResync: false });

    for (const request of requests.slice(1)) {
      expect(new Headers(request.init.headers).get("x-csrf-token")).toBe("csrf-token");
    }
    expect(new Headers(requests[1]?.init.headers).get("idempotency-key")).toBeTruthy();
    expect(new Headers(requests[3]?.init.headers).get("idempotency-key")).toBeTruthy();
    expect(new Headers(requests[4]?.init.headers).get("idempotency-key")).toBeTruthy();
    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/session",
      "/api/v1/boards/b_1234567890123456789012/invitations",
      "/api/v1/boards/b_1234567890123456789012/invitations/i_1234567890123456789012",
      "/api/v1/boards/b_1234567890123456789012/snapshots",
      "/api/v1/boards/b_1234567890123456789012/restore/7",
    ]);
  });

  it("creates invitations for co-owners", async () => {
    const requests: CapturedRequest[] = [];
    const responses: unknown[] = [
      { csrfToken: "csrf-token" },
      {
        invitation: {
          id: "i_1234567890123456789012",
          role: "owner",
          label: "Co-coach",
          maxUses: 1,
          expiresAt: 2_000_000_000_000,
        },
        token: "one-time-token",
        url: "https://example.test/b/board#invite=one-time-token",
        idempotentReplay: false,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        return Response.json(responses.shift());
      }),
    );

    const api = new ApiClient();
    await api.ensureSession();
    const result = await api.createInvitation("b_1234567890123456789012", {
      role: "owner",
      label: "Co-coach",
      maxUses: 1,
      expiresAt: 2_000_000_000_000,
    });

    expect(result.invitation.role).toBe("owner");
    expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({
      role: "owner",
      label: "Co-coach",
    });
  });

  it("keeps only fully validated snapshot metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          snapshots: [
            {
              seq: 11,
              sha256: "digest",
              itemCount: 4,
              byteCount: 1_024,
              kind: "automatic",
              label: null,
              createdBy: null,
              createdAt: 1_900_000_000_000,
            },
            {
              seq: "12",
              sha256: "bad",
              itemCount: 0,
              byteCount: 1,
              kind: "automatic",
              label: null,
              createdBy: null,
              createdAt: 1_900_000_000_000,
            },
          ],
        }),
      ),
    );

    const snapshots = await new ApiClient().snapshots("b_1234567890123456789012");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ seq: 11, kind: "automatic", itemCount: 4 });
  });
});

describe("board archive API", () => {
  it("posts the expected ACL version with same-origin credentials and CSRF", async () => {
    const requests: CapturedRequest[] = [];
    const responses: unknown[] = [
      { csrfToken: "csrf-token" },
      { archived: true, archivedAt: 1_900_000_000_000, aclVersion: 8 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        return Response.json(responses.shift());
      }),
    );

    const api = new ApiClient();
    await api.ensureSession();
    const result = await api.archiveBoard("b_1234567890123456789012", 7);

    expect(result).toEqual({ archived: true, archivedAt: 1_900_000_000_000, aclVersion: 8 });
    const request = requests[1];
    expect(request?.path).toBe("/api/v1/boards/b_1234567890123456789012/archive");
    expect(request?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ expectedAclVersion: 7 }),
    });
    const headers = new Headers(request?.init.headers);
    expect(headers.get("x-csrf-token")).toBe("csrf-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
  });
});

describe("embedded Space session", () => {
  it("exchanges a launch token before storing and using the bearer", async () => {
    const requests: CapturedRequest[] = [];
    const historyValue = {
      state: { source: "parent-application" } as unknown,
      replaceState: vi.fn((state: unknown) => {
        historyValue.state = state;
      }),
    };
    vi.stubGlobal("history", historyValue);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        if (requests.length === 1) {
          return Response.json({
            sessionToken: "es1.session.signature",
            sessionExpiresAt: 2_000_000_000_000,
            board: {
              id: "b_1234567890123456789012",
              url: "/embed/b/b_1234567890123456789012",
              title: "Biology lab",
            },
            actor: {
              id: "a_1234567890123456789012",
              displayName: "Ada",
              role: "editor",
            },
          });
        }
        if (requests.length === 2) return Response.json({ csrfToken: "embed-csrf" });
        return Response.json({ ok: true });
      }),
    );

    const api = new ApiClient(true);
    const launched = await api.startEmbedSession({
      token: "cl1.launch.signature",
      importSnapshot: "eyJmb3JtYXQiOiJjZi13aGl0ZWJvYXJkLWpzb24ifQ",
    });
    await api.ensureSession();
    await api.request("/api/v1/boards/b_1234567890123456789012/settings", {
      method: "PATCH",
      body: JSON.stringify({ drawingPolicy: "locked" }),
    });

    expect(launched).toMatchObject({
      board: { id: "b_1234567890123456789012", title: "Biology lab" },
      actor: { id: "a_1234567890123456789012", role: "editor" },
    });
    expect(requests[0]?.path).toBe("/api/v1/embed/session");
    expect(requests[0]?.init.body).toBe(
      JSON.stringify({
        token: "cl1.launch.signature",
        importSnapshot: "eyJmb3JtYXQiOiJjZi13aGl0ZWJvYXJkLWpzb24ifQ",
      }),
    );
    expect(new Headers(requests[0]?.init.headers).has("authorization")).toBe(false);
    expect(new Headers(requests[1]?.init.headers).get("authorization")).toBe(
      "Bearer es1.session.signature",
    );
    expect(requests[1]?.path).not.toContain("es1.session.signature");
    expect(new Headers(requests[2]?.init.headers).get("authorization")).toBe(
      "Bearer es1.session.signature",
    );
    expect(new Headers(requests[2]?.init.headers).get("x-csrf-token")).toBe("embed-csrf");
    expect(historyValue.state).toEqual({
      source: "parent-application",
      "cf-collab-canvas.embed-bearer": "es1.session.signature",
    });
  });

  it("restores a bearer only for an embed client and leaves legacy requests unchanged", async () => {
    vi.stubGlobal("history", {
      state: {
        "cf-collab-canvas.embed-bearer": "es1.restored.signature",
      },
      replaceState: vi.fn(),
    });
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        return Response.json({ ok: true });
      }),
    );

    await new ApiClient(true).request("/embed-resource");
    await new ApiClient(false).request("/legacy-resource");

    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
      "Bearer es1.restored.signature",
    );
    expect(new Headers(requests[1]?.init.headers).has("authorization")).toBe(false);
  });

  it("scrubs launch and import data before returning the one-time exchange payload", () => {
    const replaceState = vi.fn();
    const locationValue = {
      pathname: "/embed",
      search: "?theme=light",
      hash: "#launch=cl1.launch.signature&import=eyJmb3JtYXQiOiJjZi13aGl0ZWJvYXJkLWpzb24ifQ",
    } as Location;
    const historyValue = { state: { source: "lms" }, replaceState } as unknown as History;

    expect(takeEmbedLaunch(locationValue, historyValue)).toEqual({
      token: "cl1.launch.signature",
      importSnapshot: "eyJmb3JtYXQiOiJjZi13aGl0ZWJvYXJkLWpzb24ifQ",
    });
    expect(replaceState).toHaveBeenCalledWith({ source: "lms" }, "", "/embed?theme=light");
  });

  it("scrubs an orphaned import fragment without attempting a launch", () => {
    const replaceState = vi.fn();
    const locationValue = {
      pathname: "/embed",
      search: "",
      hash: "#import=eyJpdGVtcyI6W119",
    } as Location;
    const historyValue = { state: null, replaceState } as unknown as History;

    expect(takeEmbedLaunch(locationValue, historyValue)).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/embed");
  });

  it("keeps owner roles and primary-owner metadata in the member response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          members: [
            {
              actorId: "a_1234567890123456789012",
              displayName: "Coach",
              role: "owner",
              primaryOwner: true,
            },
          ],
        }),
      ),
    );

    await expect(new ApiClient(false).members("b_1234567890123456789012")).resolves.toEqual([
      {
        id: "a_1234567890123456789012",
        displayName: "Coach",
        role: "owner",
        connected: false,
        primaryOwner: true,
      },
    ]);
  });
});

describe("attributed data export", () => {
  it("fetches attributed data with the stored embed bearer", async () => {
    vi.stubGlobal("history", {
      state: {
        "cf-collab-canvas.embed-bearer": "es1.embedded.signature",
      },
      replaceState: vi.fn(),
    });
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        return Response.json({
          format: "cf-whiteboard-attributed-json",
          version: 1,
          board: {
            id: "b_1234567890123456789012",
            title: "Peer feedback",
            seq: 12,
            stateCreatedAt: 1_900_000_000_000,
          },
          participants: [
            {
              id: "a_1234567890123456789012",
              displayName: "Asha Patel",
              participantHash: "a_1234567890123456789012",
              role: "editor",
              status: "active",
            },
          ],
          objects: [],
        });
      }),
    );

    const exported = await new ApiClient(true).attributedDataExport("b_1234567890123456789012");

    expect(exported).toMatchObject({
      format: "cf-whiteboard-attributed-json",
      board: { title: "Peer feedback", seq: 12 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe(
      "/api/v1/boards/b_1234567890123456789012/export.attributed.json",
    );
    expect(requests[0]?.init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer es1.embedded.signature");
    expect(requests[0]?.path).not.toContain("es1.embedded.signature");
  });
});

describe("organisation template APIs", () => {
  const templateItem = {
    id: "018f0000-0000-7000-8000-000000000001",
    kind: "sticky",
    z: 1,
    version: 3,
    createdBy: `a_${"A".repeat(22)}`,
    transform: [1, 0, 0, 1, 0, 0],
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#20201e",
      fontSize: 20,
      opacity: 1,
    },
    geometry: { x: 10, y: 20, width: 180, height: 120, text: "Reflect" },
  };
  const template = {
    id: `tpl_${"T".repeat(22)}`,
    name: "Weekly reflection",
    description: "A reusable check-in",
    items: [templateItem],
    createdBy: `a_${"A".repeat(22)}`,
    createdAt: 1_900_000_000_000,
    updatedAt: 1_900_000_000_100,
  };

  it("loads, creates, and deletes templates on the board organisation route", async () => {
    const requests: CapturedRequest[] = [];
    const responses: Array<Response> = [
      Response.json({
        organisationId: `o_${"O".repeat(22)}`,
        canManage: true,
        templates: [template],
      }),
      Response.json(template, { status: 201 }),
      new Response(null, { status: 204 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        const response = responses.shift();
        if (!response) throw new Error("Unexpected request.");
        return response;
      }),
    );
    vi.stubGlobal("crypto", { ...crypto, randomUUID: () => "idempotency-key" });

    const api = new ApiClient(false);
    const collection = await api.organisationTemplates("b_1234567890123456789012");
    const created = await api.createOrganisationTemplate("b_1234567890123456789012", {
      name: template.name,
      description: template.description,
      items: collection.templates[0]?.items ?? [],
    });
    await api.deleteOrganisationTemplate("b_1234567890123456789012", created.id);

    expect(collection).toMatchObject({
      organisationId: `o_${"O".repeat(22)}`,
      canManage: true,
      templates: [{ name: "Weekly reflection", items: [{ kind: "sticky" }] }],
    });
    expect(requests.map((request) => request.path)).toEqual([
      "/api/v1/boards/b_1234567890123456789012/organisation/templates",
      "/api/v1/boards/b_1234567890123456789012/organisation/templates",
      `/api/v1/boards/b_1234567890123456789012/organisation/templates/${template.id}`,
    ]);
    expect(requests.map((request) => request.init.method)).toEqual(["GET", "POST", "DELETE"]);
    expect(new Headers(requests[1]?.init.headers).get("idempotency-key")).toBe("idempotency-key");
    expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({
      name: "Weekly reflection",
      description: "A reusable check-in",
      items: [{ id: templateItem.id, version: 3, createdBy: templateItem.createdBy }],
    });
  });

  it("rejects malformed template objects instead of exposing partial server data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          organisationId: null,
          canManage: false,
          templates: [{ ...template, items: [{ ...templateItem, version: "three" }] }],
        }),
      ),
    );

    await expect(
      new ApiClient(false).organisationTemplates("b_1234567890123456789012"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("organisation webhook APIs", () => {
  it("loads and updates settings, then sends the current board with idempotency", async () => {
    const boardId = "b_1234567890123456789012";
    const organisationId = `o_${"O".repeat(22)}`;
    const actorId = `a_${"A".repeat(22)}`;
    const requests: CapturedRequest[] = [];
    const responses: unknown[] = [
      {
        organisationId,
        webhookUrl: null,
        updatedBy: null,
        updatedAt: null,
      },
      {
        organisationId,
        webhookUrl: "https://hooks.partner.example/spacescale",
        updatedBy: actorId,
        updatedAt: 1_900_000_000_000,
      },
      {
        delivery: {
          id: `whd_${"D".repeat(22)}`,
          event: "board.exported",
          createdAt: 1_900_000_000_100,
          responseStatus: 204,
        },
        idempotentReplay: false,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        return Response.json(responses.shift());
      }),
    );
    vi.stubGlobal("crypto", { ...crypto, randomUUID: () => "webhook-idempotency-key" });

    const api = new ApiClient(false);
    await expect(api.organisationWebhookSettings(boardId)).resolves.toMatchObject({
      organisationId,
      webhookUrl: null,
    });
    await expect(
      api.updateOrganisationWebhookSettings(boardId, "https://hooks.partner.example/spacescale"),
    ).resolves.toMatchObject({ webhookUrl: "https://hooks.partner.example/spacescale" });
    await expect(
      api.sendBoardToOrganisationWebhook(boardId, "stable-retry-key"),
    ).resolves.toMatchObject({
      delivery: { event: "board.exported", responseStatus: 204 },
      idempotentReplay: false,
    });

    expect(requests.map((request) => [request.path, request.init.method])).toEqual([
      [`/api/v1/boards/${boardId}/organisation/settings`, "GET"],
      [`/api/v1/boards/${boardId}/organisation/settings`, "PATCH"],
      [`/api/v1/boards/${boardId}/organisation/webhook`, "POST"],
    ]);
    expect(requests[1]?.init.body).toBe(
      JSON.stringify({ webhookUrl: "https://hooks.partner.example/spacescale" }),
    );
    expect(new Headers(requests[2]?.init.headers).get("idempotency-key")).toBe("stable-retry-key");
  });

  it("rejects malformed webhook settings and delivery responses", async () => {
    const responses = [
      { organisationId: "school-42", webhookUrl: "http://unsafe.example" },
      {
        delivery: {
          id: "delivery",
          event: "board.exported",
          createdAt: 1,
          responseStatus: 302,
        },
        idempotentReplay: false,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(responses.shift())),
    );
    const api = new ApiClient(false);
    await expect(api.organisationWebhookSettings("b_1234567890123456789012")).rejects.toMatchObject(
      { code: "INVALID_RESPONSE" },
    );
    await expect(
      api.sendBoardToOrganisationWebhook("b_1234567890123456789012"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("board image assets", () => {
  it("uploads raw image bytes with CSRF and fetches authenticated Blob bytes", async () => {
    const requests: CapturedRequest[] = [];
    const assetId = `asset_${"d".repeat(43)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        if (requests.length === 1) return Response.json({ csrfToken: "csrf-token" });
        if (requests.length === 2) {
          return Response.json({
            assetId,
            mimeType: "image/png",
            intrinsicWidth: 640,
            intrinsicHeight: 480,
            sizeBytes: 4,
          });
        }
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const api = new ApiClient(false);
    await api.ensureSession();
    const image = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    await expect(api.uploadBoardImage("b_1234567890123456789012", image)).resolves.toEqual({
      assetId,
      mimeType: "image/png",
      intrinsicWidth: 640,
      intrinsicHeight: 480,
      sizeBytes: 4,
    });
    const loaded = await api.boardImage("b_1234567890123456789012", assetId);

    expect(loaded.type).toBe("image/png");
    expect(requests[1]?.path).toBe("/api/v1/boards/b_1234567890123456789012/assets");
    expect(requests[1]?.init.body).toBe(image);
    expect(new Headers(requests[1]?.init.headers).get("content-type")).toBe("image/png");
    expect(new Headers(requests[1]?.init.headers).get("x-csrf-token")).toBe("csrf-token");
    expect(requests[2]?.path).toBe(`/api/v1/boards/b_1234567890123456789012/assets/${assetId}`);
    expect(new Headers(requests[2]?.init.headers).get("accept")).toBe("image/*");
    expect(requests[2]?.init.credentials).toBe("same-origin");
  });
});

describe("comment API responses", () => {
  it("accepts all three comment states and resolved attribution", () => {
    const base = {
      id: `c_${"A".repeat(22)}`,
      itemId: "018f0000-0000-7000-8000-000000000c01",
      body: "Review this object",
      author: { id: `a_${"B".repeat(22)}`, displayName: "Asha" },
      createdAt: 100,
      updatedAt: 120,
    };
    expect(parseBoardComment({ ...base, state: "open" }).state).toBe("open");
    expect(parseBoardComment({ ...base, state: "orphaned" }).state).toBe("orphaned");
    expect(
      parseBoardComment({
        ...base,
        state: "resolved",
        resolvedBy: { id: `a_${"C".repeat(22)}`, displayName: "Mira" },
        resolvedAt: 130,
      }),
    ).toMatchObject({ state: "resolved", resolvedAt: 130 });
  });

  it("rejects unsupported states", () => {
    expect(() =>
      parseBoardComment({
        id: `c_${"A".repeat(22)}`,
        itemId: "018f0000-0000-7000-8000-000000000c01",
        body: "Review this object",
        state: "hidden",
        author: { id: `a_${"B".repeat(22)}`, displayName: "Asha" },
        createdAt: 100,
        updatedAt: 120,
      }),
    ).toThrow("invalid comment data");
  });

  it("passes writer metadata through only when the pair is present and valid", () => {
    const base = {
      id: `c_${"A".repeat(22)}`,
      itemId: "018f0000-0000-7000-8000-000000000c01",
      body: "Review this object",
      state: "open",
      author: { id: `a_${"B".repeat(22)}`, displayName: "Asha" },
      createdAt: 100,
      updatedAt: 120,
    };
    const typed = parseBoardComment(base);
    expect(typed).not.toHaveProperty("assistedBy");
    expect(typed).not.toHaveProperty("assistance");

    expect(
      parseBoardComment({
        ...base,
        assistedBy: "ai",
        assistance: { tool: "comment_on_watched_step", action: "critique" },
      }),
    ).toMatchObject({
      assistedBy: "ai",
      assistance: { tool: "comment_on_watched_step", action: "critique" },
    });
    expect(
      parseBoardComment({
        ...base,
        assistedBy: "ai",
        assistance: { tool: "comment_on_watched_step" },
      }).assistance,
    ).toEqual({ tool: "comment_on_watched_step" });

    expect(() => parseBoardComment({ ...base, assistedBy: "ai" })).toThrow(
      expect.objectContaining({ code: "INVALID_RESPONSE" }),
    );
    expect(() => parseBoardComment({ ...base, assistance: { tool: "x" } })).toThrow(
      expect.objectContaining({ code: "INVALID_RESPONSE" }),
    );
    expect(() =>
      parseBoardComment({ ...base, assistedBy: "ai", assistance: { tool: "x", action: "grade" } }),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
    expect(() =>
      parseBoardComment({ ...base, assistedBy: "human", assistance: { tool: "x" } }),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it("keeps a comment's picture or video, and refuses one the contract does not allow", () => {
    const base = {
      id: `c_${"A".repeat(22)}`,
      itemId: "018f0000-0000-7000-8000-000000000c01",
      body: "Compare this with your sketch",
      state: "open",
      author: { id: `a_${"B".repeat(22)}`, displayName: "Asha" },
      createdAt: 100,
      updatedAt: 120,
    };
    expect(parseBoardComment(base)).not.toHaveProperty("media");
    expect(
      parseBoardComment({
        ...base,
        media: {
          kind: "image",
          assetId: `asset_${"A".repeat(43)}`,
          mimeType: "image/png",
          intrinsicWidth: 800,
          intrinsicHeight: 600,
          alt: "A parabola",
        },
      }).media,
    ).toMatchObject({ kind: "image", alt: "A parabola" });
    expect(
      parseBoardComment({
        ...base,
        media: { kind: "video", provider: "vimeo", url: "https://vimeo.com/123456" },
      }).media,
    ).toEqual({ kind: "video", provider: "vimeo", url: "https://vimeo.com/123456" });

    expect(() =>
      parseBoardComment({ ...base, media: { kind: "video", url: "https://example.com/clip" } }),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
    expect(() =>
      parseBoardComment({ ...base, media: { kind: "sound", url: "https://example.com/a.mp3" } }),
    ).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it("sends the comment's media only when createComment is given some", async () => {
    const requests: CapturedRequest[] = [];
    const comment = {
      id: `c_${"A".repeat(22)}`,
      itemId: "018f0000-0000-7000-8000-000000000c01",
      body: "Watch this before the next step",
      state: "open",
      author: { id: `a_${"B".repeat(22)}`, displayName: "Asha" },
      createdAt: 100,
      updatedAt: 100,
    };
    const media = {
      kind: "video" as const,
      provider: "youtube" as const,
      url: "https://youtu.be/dQw4w9WgXcQ",
    };
    const responses: unknown[] = [{ csrfToken: "csrf-token" }, { ...comment, media }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        return Response.json(responses.shift());
      }),
    );

    const api = new ApiClient();
    await api.ensureSession();
    const posted = await api.createComment(
      "b_1234567890123456789012",
      comment.itemId,
      comment.body,
      undefined,
      media,
    );

    expect(requests[1]?.init.body).toBe(
      JSON.stringify({ itemId: comment.itemId, body: comment.body, media }),
    );
    expect(posted.media).toEqual(media);
  });

  it("sends assistedBy and assistance only when createComment is given assistance", async () => {
    const requests: CapturedRequest[] = [];
    const comment = {
      id: `c_${"A".repeat(22)}`,
      itemId: "018f0000-0000-7000-8000-000000000c01",
      body: "Check the second step",
      state: "open",
      author: { id: `a_${"B".repeat(22)}`, displayName: "Asha" },
      createdAt: 100,
      updatedAt: 100,
    };
    const responses: unknown[] = [
      { csrfToken: "csrf-token" },
      comment,
      { ...comment, assistedBy: "ai", assistance: { tool: "comment_on_watched_step" } },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({ path: String(input), init });
        return Response.json(responses.shift());
      }),
    );

    const api = new ApiClient();
    await api.ensureSession();
    const boardId = "b_1234567890123456789012";
    await api.createComment(boardId, comment.itemId, comment.body);
    const assisted = await api.createComment(boardId, comment.itemId, comment.body, {
      tool: "comment_on_watched_step",
    });

    expect(requests[1]?.init.body).toBe(
      JSON.stringify({ itemId: comment.itemId, body: comment.body }),
    );
    expect(requests[2]?.init.body).toBe(
      JSON.stringify({
        itemId: comment.itemId,
        body: comment.body,
        assistedBy: "ai",
        assistance: { tool: "comment_on_watched_step" },
      }),
    );
    expect(assisted).toMatchObject({
      assistedBy: "ai",
      assistance: { tool: "comment_on_watched_step" },
    });
  });
});

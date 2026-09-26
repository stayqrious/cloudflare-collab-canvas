/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { BoardFeatures } from "@collab/protocol";
import { describe, expect, it, vi } from "vitest";
import { MAX_CLASSROOM_IMPORT_ENCODED_CHARS } from "./classroom-import";
import gateway from "./gateway";
import { configuredFrameAncestors } from "./http/security";
import { HmacIdentityService } from "./identity";
import {
  OrganisationAuthService,
  type OrganisationSigningKeyRegistry,
  signOrganisationLaunchToken,
} from "./organisation-auth";
import type { Env } from "./types";

const ORGANISATION_KEY = "school-42";
const DERIVATION_KEY = `organisation-derivation-key-${"d".repeat(32)}`;
const SIGNING_KEY = `organisation-signing-key-${"s".repeat(32)}`;
const SESSION_KEY = "classroom-session-key-with-enough-entropy";

const SIGNING_KEYS: OrganisationSigningKeyRegistry = {
  [ORGANISATION_KEY]: {
    derivation_key: DERIVATION_KEY,
    current: { key_id: "2026-08", key: SIGNING_KEY },
    previous: [],
  },
};

type CapturedRequest = {
  boardId: string;
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
};

function makeEnv(options: { allowedOrigins?: string } = {}): {
  env: Env;
  captured: CapturedRequest[];
  getByName: ReturnType<typeof vi.fn>;
} {
  const captured: CapturedRequest[] = [];
  const getByName = vi.fn((boardId: string) => ({
    fetch: async (request: Request): Promise<Response> => {
      const body = request.body === null ? null : await request.clone().json();
      captured.push({
        boardId,
        method: request.method,
        url: request.url,
        headers: new Headers(request.headers),
        body,
      });
      const pathname = new URL(request.url).pathname;
      if (pathname === "/__internal/organisation-launch") {
        const launch = body as {
          publicId: string;
          title: string;
          role: "owner" | "editor" | "viewer";
          displayName: string;
          features: Record<string, boolean>;
        };
        return Response.json(
          {
            board: {
              id: launch.publicId,
              title: launch.title,
              accessMode: "private",
              drawingPolicy: "editors_enabled",
              imagesEnabled: launch.features.images === true,
              features: launch.features,
              aclVersion: 1,
            },
            actor: {
              id: request.headers.get("x-whiteboard-internal-actor"),
              role: launch.role,
              displayName: launch.displayName,
            },
            created: true,
            launchApplied: true,
          },
          { status: 201 },
        );
      }
      if (pathname === "/__internal/organisation-export") {
        return Response.json(
          {
            format: "cf-whiteboard-json",
            version: 1,
            boardId,
            seq: 7,
            createdAt: 1_700_000_000_000,
            settings: { title: "Read-only geometry" },
            items: [],
          },
          {
            headers: {
              "Content-Disposition": `attachment; filename="whiteboard-${boardId}.json"`,
              "X-Whiteboard-Seq": "7",
            },
          },
        );
      }
      if (/^\/__internal\/organisation-assets\/asset_[A-Za-z0-9_-]{43}$/u.test(pathname)) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png", "Content-Length": "4" },
        });
      }
      if (pathname.endsWith("/socket")) {
        const pair = new WebSocketPair();
        pair[1].accept();
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return Response.json({ forwarded: true });
    },
  }));
  const env = {
    APP_HOSTNAME: "localhost",
    ORGANISATION_SIGNING_KEYS: JSON.stringify(SIGNING_KEYS),
    ALLOWED_ORIGINS: options.allowedOrigins,
    SESSION_SIGNING_KEY_CURRENT: SESSION_KEY,
    SESSION_SIGNING_KEY_PREVIOUS: "",
    BOARD_CREATION_ENABLED: "true",
    TURNSTILE_ENABLED: "false",
    ENVIRONMENT: "development",
    WORKER_VERSION: { id: "organisation-test-version" },
    BOARD_ROOMS: { getByName },
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><title>Canvas</title>", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
  } as unknown as Env;
  return { env, captured, getByName };
}

async function launchToken(
  suffix: string,
  overrides: Partial<{
    organisation_id: string;
    space_id: string;
    role: "owner" | "editor" | "viewer";
    display_name: string;
    participant_id: string;
    features: Partial<BoardFeatures>;
    organisation_admin: boolean;
  }> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return signOrganisationLaunchToken(
    {
      v: 1,
      aud: "localhost",
      organisation_id: ORGANISATION_KEY,
      space_id: `Classroom Space ${suffix}`,
      key_id: "2026-08",
      role: "editor",
      display_name: `Student ${suffix}`,
      participant_id: `student-${suffix}`,
      iat: now - 5,
      exp: now + 3_600,
      ...overrides,
    },
    SIGNING_KEY,
  );
}

async function exchange(
  env: Env,
  token: string,
  origin = "http://localhost",
  importSnapshot?: string,
): Promise<Response> {
  return gateway.fetch(
    new Request("http://localhost/api/v1/embed/session", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...(importSnapshot === undefined ? {} : { importSnapshot }) }),
    }),
    env,
  );
}

describe("organisation embed gateway", () => {
  it("exchanges a signed launch for a scoped session after authoritative membership", async () => {
    const { env, captured, getByName } = makeEnv();
    const response = await exchange(
      env,
      await launchToken("exchange", {
        space_id: "  Algebra Space  ",
        role: "owner",
        display_name: "  Coach Mira  ",
        participant_id: "coach-mira",
        features: { line: false, protractor: false },
      }),
      "http://localhost",
      "eyJmb3JtYXQiOiJjZi13aGl0ZWJvYXJkLWpzb24ifQ",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = (await response.json()) as {
      sessionToken: string;
      sessionExpiresAt: number;
      board: { id: string; title: string; url: string };
      actor: { id: string; role: string; displayName: string };
    };
    expect(result.board).toMatchObject({
      title: "Algebra Space",
      url: `http://localhost/embed/b/${result.board.id}`,
    });
    expect(result.actor).toMatchObject({ role: "owner", displayName: "Coach Mira" });
    expect(getByName).toHaveBeenCalledWith(result.board.id);

    expect(captured).toHaveLength(1);
    const forwarded = captured[0];
    expect(forwarded?.url).toBe("http://localhost/__internal/organisation-launch");
    expect(forwarded?.headers.get("authorization")).toBeNull();
    expect(forwarded?.headers.get("x-whiteboard-internal-actor")).toBe(result.actor.id);
    expect(forwarded?.headers.get("x-whiteboard-internal-session-expiry")).toBe(
      String(result.sessionExpiresAt),
    );
    expect(forwarded?.body).toEqual({
      publicId: result.board.id,
      organisationId: expect.stringMatching(/^o_[A-Za-z0-9_-]{22}$/u),
      title: "Algebra Space",
      role: "owner",
      displayName: "Coach Mira",
      participantId: "coach-mira",
      launchIssuedAtMs: expect.any(Number),
      placeholderOwnerActorId: expect.stringMatching(/^a_[A-Za-z0-9_-]{22}$/u),
      spaceId: "Algebra Space",
      ownerRecoveryHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      features: expect.objectContaining({ images: true, line: false, protractor: false }),
      importSnapshot: "eyJmb3JtYXQiOiJjZi13aGl0ZWJvYXJkLWpzb24ifQ",
    });

    const verified = await new HmacIdentityService(env).verifySession(
      new Request("http://localhost", {
        headers: { Authorization: `Bearer ${result.sessionToken}` },
      }),
    );
    expect(verified).toMatchObject({ actorId: result.actor.id, boardId: result.board.id });
  });

  it("requires exact same-origin launch POSTs and fails closed on invalid tokens", async () => {
    const { env, getByName } = makeEnv();
    const token = await launchToken("origin");
    const crossSite = await exchange(env, token, "https://attacker.example");
    expect(crossSite.status).toBe(403);
    expect(getByName).not.toHaveBeenCalled();

    const absentOrigin = await gateway.fetch(
      new Request("http://localhost/api/v1/embed/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      env,
    );
    expect(absentOrigin.status).toBe(403);

    const invalid = await exchange(env, `${token.slice(0, -1)}x`);
    expect(invalid.status).toBe(401);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("bounds import transport before the signed launch reaches a room", async () => {
    const { env, getByName } = makeEnv();
    const token = await launchToken("import-bounds");
    const invalidType = await gateway.fetch(
      new Request("http://localhost/api/v1/embed/session", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ token, importSnapshot: 42 }),
      }),
      env,
    );
    expect(invalidType.status).toBe(400);

    const tooLarge = await exchange(
      env,
      token,
      "http://localhost",
      "A".repeat(MAX_CLASSROOM_IMPORT_ENCODED_CHARS + 1),
    );
    expect(tooLarge.status).toBe(413);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("accepts bearer mutations without CSRF but enforces the exact board scope", async () => {
    const { env, captured } = makeEnv();
    const launch = await exchange(env, await launchToken("scope"));
    const result = (await launch.json()) as { sessionToken: string; board: { id: string } };
    captured.length = 0;

    const allowed = await gateway.fetch(
      new Request(`http://localhost/api/v1/boards/${result.board.id}/settings`, {
        method: "PATCH",
        headers: {
          Origin: "http://localhost",
          Authorization: `Bearer ${result.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expectedAclVersion: 1, drawingPolicy: "owner_only" }),
      }),
      env,
    );
    expect(allowed.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.get("authorization")).toBeNull();

    const otherBoard = "b_ZZZZZZZZZZZZZZZZZZZZZZ";
    const denied = await gateway.fetch(
      new Request(`http://localhost/api/v1/boards/${otherBoard}/bootstrap`, {
        headers: { Authorization: `Bearer ${result.sessionToken}` },
      }),
      env,
    );
    expect(denied.status).toBe(403);
    expect(captured).toHaveLength(1);

    const legacyCreate = await gateway.fetch(
      new Request("http://localhost/api/v1/boards", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          Authorization: `Bearer ${result.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Out of scope" }),
      }),
      env,
    );
    expect(legacyCreate.status).toBe(403);
  });

  it("exports only the token-derived board for an owner organisation assertion", async () => {
    const { env, captured } = makeEnv();
    const token = await launchToken("service-export", {
      role: "owner",
      participant_id: "coach-service",
    });
    const launch = await new OrganisationAuthService(env).verifyLaunchToken(token);
    const organisationPath = encodeURIComponent(ORGANISATION_KEY);

    const response = await gateway.fetch(
      new Request(
        `http://localhost/api/v1/organisations/${organisationPath}/boards/${launch.boardId}/export.attributed.json`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(captured.at(-1)).toMatchObject({
      boardId: launch.boardId,
      url: "http://localhost/__internal/organisation-export",
      body: { organisationId: launch.organisationId, format: "attributed" },
    });

    const wrongBoard = await gateway.fetch(
      new Request(
        `http://localhost/api/v1/organisations/${organisationPath}/boards/b_ZZZZZZZZZZZZZZZZZZZZZZ/export.json`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      env,
    );
    expect(wrongBoard.status).toBe(404);

    const viewerToken = await launchToken("service-export", { role: "viewer" });
    const viewer = await gateway.fetch(
      new Request(
        `http://localhost/api/v1/organisations/${organisationPath}/boards/${launch.boardId}/export.json`,
        { headers: { Authorization: `Bearer ${viewerToken}` } },
      ),
      env,
    );
    expect(viewer.status).toBe(403);
  });

  it("deletes only the token-derived board for an owner Organisation assertion", async () => {
    const { env, captured } = makeEnv();
    const organisationFetch = vi.fn(
      async (_request: Request) => new Response(null, { status: 204 }),
    );
    env.ORGANISATION_ROOMS = {
      getByName: vi.fn(() => ({ fetch: organisationFetch })),
    } as unknown as DurableObjectNamespace;
    const token = await launchToken("service-delete", {
      role: "owner",
      participant_id: "board-lifecycle-service",
    });
    const launch = await new OrganisationAuthService(env).verifyLaunchToken(token);
    const route = `/api/v1/organisations/${encodeURIComponent(ORGANISATION_KEY)}/boards/${launch.boardId}`;

    const response = await gateway.fetch(
      new Request(`http://localhost${route}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(204);
    expect(await response.text()).toBe("");
    expect(captured.at(-1)).toMatchObject({
      boardId: launch.boardId,
      method: "DELETE",
      url: "http://localhost/__internal/organisation-delete",
      body: { organisationId: launch.organisationId, boardId: launch.boardId },
    });
    expect(captured.at(-1)?.headers.get("authorization")).toBeNull();
    expect(captured.at(-1)?.headers.get("x-whiteboard-internal-actor")).toBe(launch.actorId);
    const organisationRequest = organisationFetch.mock.calls[0]?.[0];
    expect(organisationRequest?.method).toBe("DELETE");
    expect(organisationRequest?.url).toBe(
      `http://localhost/__internal/organisations/${launch.organisationId}/spaces/${launch.boardId}`,
    );

    captured.length = 0;
    const wrongBoard = await gateway.fetch(
      new Request(
        `http://localhost/api/v1/organisations/${encodeURIComponent(ORGANISATION_KEY)}/boards/b_ZZZZZZZZZZZZZZZZZZZZZZ`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      ),
      env,
    );
    expect(wrongBoard.status).toBe(404);
    expect(captured).toHaveLength(0);

    const viewerToken = await launchToken("service-delete", { role: "viewer" });
    const viewer = await gateway.fetch(
      new Request(`http://localhost${route}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      env,
    );
    expect(viewer.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("lets only an Organisation admin assertion configure its own webhook", async () => {
    const { env } = makeEnv();
    const organisationFetch = vi.fn(async (request: Request) => {
      if (request.method === "PATCH") {
        const body = (await request.clone().json()) as { updatedBy: string };
        return Response.json({
          webhookUrl: "https://partner.example/hooks/spacescale",
          updatedBy: body.updatedBy,
          updatedAt: Date.now(),
        });
      }
      return Response.json({ webhookUrl: null, updatedBy: null, updatedAt: null });
    });
    (env as Env).ORGANISATION_ROOMS = {
      getByName: vi.fn(() => ({ fetch: organisationFetch })),
    } as unknown as DurableObjectNamespace;
    const token = await launchToken("service-settings", {
      role: "owner",
      organisation_admin: true,
    });
    const launch = await new OrganisationAuthService(env).verifyLaunchToken(token);
    const route = `/api/v1/organisations/${encodeURIComponent(ORGANISATION_KEY)}/webhook`;

    const configured = await gateway.fetch(
      new Request(`http://localhost${route}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ webhookUrl: "https://partner.example/hooks/spacescale" }),
      }),
      env,
    );
    expect(configured.status, await configured.clone().text()).toBe(200);
    expect(await configured.json()).toMatchObject({
      organisationId: launch.organisationId,
      webhookUrl: "https://partner.example/hooks/spacescale",
    });
    const forwarded = organisationFetch.mock.calls[0]?.[0];
    expect(forwarded?.method).toBe("PATCH");
    expect(await forwarded?.json()).toEqual({
      webhookUrl: "https://partner.example/hooks/spacescale",
      updatedBy: launch.actorId,
    });

    const plainOwnerToken = await launchToken("service-settings", { role: "owner" });
    const refused = await gateway.fetch(
      new Request(`http://localhost${route}`, {
        headers: { Authorization: `Bearer ${plainOwnerToken}` },
      }),
      env,
    );
    expect(refused.status).toBe(403);

    const crossOrganisation = await gateway.fetch(
      new Request("http://localhost/api/v1/organisations/other-school/webhook", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    );
    expect(crossOrganisation.status).toBe(404);
  });

  it("lets only owner assertions manage Organisation templates through server APIs", async () => {
    const { env } = makeEnv();
    const token = await launchToken("service-templates", { role: "owner" });
    const launch = await new OrganisationAuthService(env).verifyLaunchToken(token);
    const templateId = `tpl_${"T".repeat(22)}`;
    const template = {
      id: templateId,
      name: "Reflection",
      description: null,
      items: [],
      createdBy: launch.actorId,
      createdAt: 1,
      updatedAt: 1,
    };
    const organisationFetch = vi.fn(async (request: Request) => {
      if (request.method === "GET") return Response.json([template]);
      if (request.method === "POST") return Response.json(template, { status: 201 });
      if (request.method === "PATCH") {
        return Response.json({ ...template, name: "Revised reflection", updatedAt: 2 });
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 405 });
    });
    env.ORGANISATION_ROOMS = {
      getByName: vi.fn(() => ({ fetch: organisationFetch })),
    } as unknown as Env["ORGANISATION_ROOMS"];
    const route = `/api/v1/organisations/${encodeURIComponent(ORGANISATION_KEY)}/templates`;
    const authorization = { Authorization: `Bearer ${token}` };

    const listed = await gateway.fetch(
      new Request(`http://localhost${route}`, { headers: authorization }),
      env,
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      organisationId: launch.organisationId,
      templates: [template],
    });

    const created = await gateway.fetch(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Reflection", items: [{ id: "source-item" }] }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    expect(await organisationFetch.mock.calls[1]?.[0].clone().json()).toEqual({
      name: "Reflection",
      items: [{ id: "source-item" }],
      createdBy: launch.actorId,
    });

    const updated = await gateway.fetch(
      new Request(`http://localhost${route}/${templateId}`, {
        method: "PATCH",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Revised reflection" }),
      }),
      env,
    );
    expect(updated.status).toBe(200);
    expect(await organisationFetch.mock.calls[2]?.[0].clone().json()).toEqual({
      name: "Revised reflection",
    });

    const deleted = await gateway.fetch(
      new Request(`http://localhost${route}/${templateId}`, {
        method: "DELETE",
        headers: authorization,
      }),
      env,
    );
    expect(deleted.status).toBe(204);

    const viewerToken = await launchToken("service-templates-viewer", { role: "viewer" });
    const rejected = await gateway.fetch(
      new Request(`http://localhost${route}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${viewerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Forbidden", items: [{ id: "source-item" }] }),
      }),
      env,
    );
    expect(rejected.status).toBe(403);
    expect(organisationFetch).toHaveBeenCalledTimes(4);
  });

  it("extracts WebSocket bearer auth, strips it before forwarding, and negotiates only v1", async () => {
    const { env, captured } = makeEnv();
    const launch = await exchange(env, await launchToken("socket"));
    const result = (await launch.json()) as { sessionToken: string; board: { id: string } };
    captured.length = 0;

    const response = await gateway.fetch(
      new Request(
        "http://localhost/api/v1/boards/" +
          result.board.id +
          "/socket?since=0&client=018f0000-0000-7000-8000-000000000001",
        {
          headers: {
            Origin: "http://localhost",
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Protocol": `whiteboard.v1, auth.${result.sessionToken}`,
          },
        },
      ),
      env,
    );
    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe("whiteboard.v1");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers.get("sec-websocket-protocol")).toBe("whiteboard.v1");
    expect(captured[0]?.headers.get("authorization")).toBeNull();

    const ambiguous = await gateway.fetch(
      new Request(
        "http://localhost/api/v1/boards/" +
          result.board.id +
          "/socket?since=0&client=018f0000-0000-7000-8000-000000000002",
        {
          headers: {
            Origin: "http://localhost",
            Upgrade: "websocket",
            Authorization: `Bearer ${result.sessionToken}`,
            "Sec-WebSocket-Protocol": `whiteboard.v1, auth.${result.sessionToken}`,
          },
        },
      ),
      env,
    );
    expect(ambiguous.status).toBe(400);
  });
});

describe("embed response framing policy", () => {
  it("allows only configured exact origins on embed paths and keeps normal pages denied", async () => {
    const { env } = makeEnv({
      allowedOrigins: "https://classroom.example, https://lms.example",
    });
    const embed = await gateway.fetch(new Request("http://localhost/embed"), env);
    expect(embed.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://classroom.example https://lms.example",
    );
    expect(embed.headers.get("x-frame-options")).toBeNull();

    const nestedEmbed = await gateway.fetch(
      new Request("http://localhost/embed/b/b_AAAAAAAAAAAAAAAAAAAAAA"),
      env,
    );
    expect(nestedEmbed.headers.get("content-security-policy")).toContain(
      "frame-ancestors https://classroom.example https://lms.example",
    );
    expect(nestedEmbed.headers.get("x-frame-options")).toBeNull();

    const normal = await gateway.fetch(new Request("http://localhost/"), env);
    expect(normal.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(normal.headers.get("x-frame-options")).toBe("DENY");
  });

  it("allows explicit all-origins opt-in and fails closed for invalid origin lists", async () => {
    expect(configuredFrameAncestors(undefined)).toBe("'none'");
    expect(configuredFrameAncestors("   ")).toBe("'none'");
    expect(configuredFrameAncestors("x".repeat(2_049))).toBe("'none'");
    expect(configuredFrameAncestors("*")).toBe("*");
    expect(configuredFrameAncestors("https://*.example.com")).toBe("'none'");
    expect(configuredFrameAncestors("http://classroom.example")).toBe("'none'");
    expect(configuredFrameAncestors("https://classroom.example/path")).toBe("'none'");
    expect(configuredFrameAncestors("https://classroom.example/")).toBe("'none'");
    expect(configuredFrameAncestors("not-an-origin")).toBe("'none'");
    expect(configuredFrameAncestors("https://one.example https://two.example")).toBe("'none'");
    expect(configuredFrameAncestors("https://one.example,")).toBe("'none'");
    expect(configuredFrameAncestors("*,https://classroom.example")).toBe("'none'");
    expect(configuredFrameAncestors("http://localhost:4173")).toBe("http://localhost:4173");

    const { env } = makeEnv({ allowedOrigins: "https://ok.example,/not-an-origin" });
    const response = await gateway.fetch(new Request("http://localhost/embed"), env);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBeNull();

    const { env: allowAll } = makeEnv({ allowedOrigins: "*" });
    const allowAllResponse = await gateway.fetch(new Request("http://localhost/embed"), allowAll);
    expect(allowAllResponse.headers.get("content-security-policy")).toContain("frame-ancestors *");
    expect(allowAllResponse.headers.get("x-frame-options")).toBeNull();
  });

  it("opens canonical exports through signed read-only viewer sessions", async () => {
    const { env, captured } = makeEnv();
    const token = await launchToken("viewer", {
      role: "viewer",
      display_name: "Read-only guest",
      participant_id: "viewer-guest",
    });
    const verified = await new OrganisationAuthService(env).verifyLaunchToken(token);

    const response = await gateway.fetch(
      new Request("http://localhost/api/v1/viewer/session", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const viewerAssetToken = response.headers.get("x-spacescale-viewer-asset-token");
    expect(viewerAssetToken).toMatch(/^vas1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    await expect(
      new HmacIdentityService(env).verifyViewerAssetSession(
        new Request("http://localhost/api/v1/viewer/assets/asset_test", {
          headers: { Authorization: `Bearer ${viewerAssetToken}` },
        }),
      ),
    ).resolves.toMatchObject({
      actorId: verified.actorId,
      boardId: verified.boardId,
      organisationId: verified.organisationId,
    });
    expect(await response.json()).toEqual({
      format: "cf-whiteboard-json",
      version: 1,
      boardId: verified.boardId,
      seq: 7,
      createdAt: 1_700_000_000_000,
      settings: { title: "Read-only geometry" },
      items: [],
    });
    expect(captured.at(-1)).toMatchObject({
      boardId: verified.boardId,
      url: "http://localhost/__internal/organisation-export",
      body: { organisationId: verified.organisationId, format: "canonical" },
    });

    const assetId = `asset_${"I".repeat(43)}`;
    const image = await gateway.fetch(
      new Request(`http://localhost/api/v1/viewer/assets/${assetId}`, {
        headers: { Authorization: `Bearer ${viewerAssetToken}` },
      }),
      env,
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(captured.at(-1)).toMatchObject({
      boardId: verified.boardId,
      url: `http://localhost/__internal/organisation-assets/${assetId}?organisationId=${verified.organisationId}`,
      body: null,
    });
  });

  it("loads Organisation administration, signs per-Space viewers, and updates settings", async () => {
    const { env } = makeEnv();
    const token = await launchToken("admin", {
      space_id: "Admin Space",
      role: "owner",
      display_name: "Coach Owner",
      participant_id: "coach-owner",
      organisation_admin: true,
    });
    const participantToken = await launchToken("admin", {
      space_id: "Admin Space",
      role: "owner",
      display_name: "Coach Owner",
      participant_id: "coach-owner",
    });
    const authentication = new OrganisationAuthService(env);
    const verified = await authentication.verifyLaunchToken(token);
    const participantHash = `a_${"P".repeat(22)}`;
    let webhookUrl: string | null = null;
    const organisationFetch = vi.fn(async (request: Request): Promise<Response> => {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/settings") && request.method === "PATCH") {
        const body = (await request.json()) as { webhookUrl: string | null };
        webhookUrl = body.webhookUrl;
        return Response.json({
          webhookUrl,
          updatedBy: verified.actorId,
          updatedAt: Date.now(),
        });
      }
      if (pathname.endsWith("/admin") && request.method === "GET") {
        return Response.json({
          settings: { webhookUrl, updatedBy: null, updatedAt: null },
          templateCount: 3,
          boards: [
            {
              boardId: verified.boardId,
              spaceId: verified.spaceId,
              title: "Admin Space",
              archived: false,
              owners: [
                {
                  id: verified.actorId,
                  displayName: "Coach Owner",
                  role: "owner",
                  identifierHash: verified.actorId,
                },
              ],
              participants: [
                {
                  id: participantHash,
                  displayName: "Student One",
                  role: "editor",
                  identifierHash: participantHash,
                },
              ],
              settings: {},
              updatedAt: Date.now(),
            },
          ],
        });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    });
    env.ORGANISATION_ROOMS = {
      getByName: vi.fn(() => ({ fetch: organisationFetch })),
    } as unknown as Env["ORGANISATION_ROOMS"];

    const refused = await gateway.fetch(
      new Request("http://localhost/api/v1/organisation-admin/session", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ token: participantToken }),
      }),
      env,
    );
    expect(refused.status).toBe(403);

    const session = await gateway.fetch(
      new Request("http://localhost/api/v1/organisation-admin/session", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      env,
    );
    expect(session.status, await session.clone().text()).toBe(200);
    const snapshot = (await session.json()) as {
      organisation: { id: string; name: string };
      settings: { webhookUrl: string | null; details: Array<{ key: string; value: unknown }> };
      boards: Array<{
        id: string;
        owners: Array<{ identifierHash: string }>;
        participants: Array<{ identifierHash: string }>;
        viewerUrl: string;
      }>;
    };
    expect(snapshot.organisation).toEqual({
      id: verified.organisationId,
      name: ORGANISATION_KEY,
    });
    expect(snapshot.settings.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "spaceCount", value: 1 }),
        expect.objectContaining({ key: "templateCount", value: 3 }),
      ]),
    );
    expect(snapshot.boards[0]).toMatchObject({
      id: verified.boardId,
      owners: [{ identifierHash: verified.actorId }],
      participants: [{ identifierHash: participantHash }],
    });

    const viewerUrl = new URL(snapshot.boards[0]?.viewerUrl ?? "");
    expect(viewerUrl.pathname).toBe("/viewer");
    const viewerToken = new URLSearchParams(viewerUrl.hash.slice(1)).get("launch");
    const signedViewer = await authentication.verifyLaunchToken(viewerToken);
    expect(signedViewer).toMatchObject({
      organisationId: verified.organisationId,
      boardId: verified.boardId,
      spaceId: verified.spaceId,
      role: "viewer",
    });

    const updated = await gateway.fetch(
      new Request("http://localhost/api/v1/organisation-admin/webhook", {
        method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          webhookUrl: "https://partner.example/hooks/spacescale",
        }),
      }),
      env,
    );
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({
      webhookUrl: "https://partner.example/hooks/spacescale",
    });
  });
});

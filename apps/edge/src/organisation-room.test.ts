/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULT_BOARD_FEATURES } from "@collab/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ORGANISATION_TEMPLATE_ITEMS } from "./organisation-room";
import type { Env } from "./types";

const organisationId = `o_${"A".repeat(22)}`;
const actorId = `a_${"B".repeat(21)}A`;
const collectionPath = `/__internal/organisations/${organisationId}/templates`;

afterEach(async () => reset());

function templateItem(id = "018f0000-0000-7000-8000-000000000301", z = 1) {
  return {
    id,
    kind: "sticky",
    z,
    version: 7,
    createdBy: actorId,
    style: {
      kind: "sticky",
      fill: "#fde68a",
      textColor: "#20201e",
      fontSize: 20,
      opacity: 1,
    },
    transform: [1, 0, 0, 1, 12, 18],
    geometry: { x: 40, y: 55, width: 220, height: 160, text: "Reflect" },
  };
}

function request(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://organisation.test${path}`, {
    method,
    headers: {
      "x-whiteboard-internal-request-id": crypto.randomUUID(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function legacyBoardFeatures(): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(DEFAULT_BOARD_FEATURES).filter(
      ([key]) => key !== "objectTransforms" && key !== "grouping" && key !== "smartNote",
    ),
  );
}

describe("OrganisationRoom templates", () => {
  it("persists canonical templates across hibernation and deletes them", async () => {
    const stub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(organisationId);
    const item = templateItem();
    const createdResponse = await stub.fetch(
      request(collectionPath, "POST", {
        name: "  Exit reflection  ",
        description: "   ",
        items: [item],
        createdBy: actorId,
      }),
    );
    expect(createdResponse.status, await createdResponse.clone().text()).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      name: string;
      description: string | null;
      items: unknown[];
      createdBy: string;
      createdAt: number;
      updatedAt: number;
    };
    expect(created).toEqual({
      id: expect.stringMatching(/^tpl_[A-Za-z0-9_-]{22}$/u),
      name: "Exit reflection",
      description: null,
      items: [item],
      createdBy: actorId,
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });

    const updatedResponse = await stub.fetch(
      request(`${collectionPath}/${created.id}`, "PATCH", {
        name: "  Revised reflection  ",
        description: "  Updated prompts  ",
      }),
    );
    expect(updatedResponse.status, await updatedResponse.clone().text()).toBe(200);
    const updated = (await updatedResponse.json()) as typeof created;
    expect(updated).toEqual({
      ...created,
      name: "Revised reflection",
      description: "Updated prompts",
      updatedAt: expect.any(Number),
    });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.createdBy).toBe(created.createdBy);

    await evictDurableObject(stub);
    const listed = await stub.fetch(request(collectionPath));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([updated]);
    const state = await runInDurableObject(stub, (_instance, durableState) => ({
      migrations: durableState.storage.sql
        .exec<{ version: number }>("SELECT version FROM _sql_schema_migrations ORDER BY version")
        .toArray()
        .map(({ version }) => version),
      organisationId: durableState.storage.sql
        .exec<{ organisation_id: string }>("SELECT organisation_id FROM organisation")
        .one().organisation_id,
      templates: durableState.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM templates")
        .one().count,
    }));
    expect(state).toEqual({ migrations: [1, 2], organisationId, templates: 1 });

    const deleted = await stub.fetch(request(`${collectionPath}/${created.id}`, "DELETE"));
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    const missing = await stub.fetch(request(`${collectionPath}/${created.id}`, "DELETE"));
    expect(missing.status).toBe(404);
    expect(await (await stub.fetch(request(collectionPath))).json()).toEqual([]);
  });

  it("rejects malformed, image-backed, excessive, duplicate, and cross-scope input", async () => {
    const stub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(organisationId);
    const post = (body: unknown) => stub.fetch(request(collectionPath, "POST", body));

    expect((await post({ name: "Empty", items: [], createdBy: actorId })).status).toBe(400);
    expect(
      (
        await post({
          name: "Too many",
          items: Array.from({ length: MAX_ORGANISATION_TEMPLATE_ITEMS + 1 }, () => templateItem()),
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "Duplicate",
          items: [templateItem(), templateItem()],
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "Image",
          items: [
            {
              ...templateItem(),
              kind: "image",
              style: { kind: "image", opacity: 1, radius: 12 },
              geometry: {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
                assetId: `asset_${"d".repeat(43)}`,
                mimeType: "image/png",
                intrinsicWidth: 200,
                intrinsicHeight: 100,
              },
            },
          ],
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "Malformed",
          items: [{ ...templateItem(), geometry: { x: Number.NaN } }],
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          name: "N".repeat(101),
          items: [templateItem()],
          createdBy: actorId,
        })
      ).status,
    ).toBe(400);

    const otherOrganisationId = `o_${"C".repeat(21)}A`;
    const conflict = await stub.fetch(
      request(`/__internal/organisations/${otherOrganisationId}/templates`),
    );
    expect(conflict.status).toBe(409);

    const otherStub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(otherOrganisationId);
    const isolated = await otherStub.fetch(
      request(`/__internal/organisations/${otherOrganisationId}/templates`),
    );
    expect(isolated.status).toBe(200);
    expect(await isolated.json()).toEqual([]);
  });
});

describe("OrganisationRoom webhook settings", () => {
  it("stores one canonical public HTTPS webhook per organisation and supports clearing it", async () => {
    (env as unknown as Env).WEBHOOK_ALLOWED_ORIGINS = "https://partner.example";
    const stub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(organisationId);
    const path = `/__internal/organisations/${organisationId}/settings`;

    const initial = await stub.fetch(request(path));
    expect(await initial.json()).toEqual({ webhookUrl: null, updatedBy: null, updatedAt: null });

    const configured = await stub.fetch(
      request(path, "PATCH", {
        webhookUrl: "https://partner.example/hooks/space-scale?tenant=42",
        updatedBy: actorId,
      }),
    );
    expect(configured.status, await configured.clone().text()).toBe(200);
    expect(await configured.json()).toEqual({
      webhookUrl: "https://partner.example/hooks/space-scale?tenant=42",
      updatedBy: actorId,
      updatedAt: expect.any(Number),
    });

    await evictDurableObject(stub);
    expect(await (await stub.fetch(request(path))).json()).toMatchObject({
      webhookUrl: "https://partner.example/hooks/space-scale?tenant=42",
      updatedBy: actorId,
    });

    const cleared = await stub.fetch(
      request(path, "PATCH", { webhookUrl: null, updatedBy: actorId }),
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ webhookUrl: null, updatedBy: actorId });
  });

  it("rejects local, IP-literal, insecure, credentialed, fragmented, and malformed URLs", async () => {
    const stub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(organisationId);
    const path = `/__internal/organisations/${organisationId}/settings`;
    const invalid = [
      "http://partner.example/hook",
      "https://localhost/hook",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://service.internal/hook",
      "https://localhost./hook",
      "https://service.internal./hook",
      "https://user:password@partner.example/hook",
      "https://partner.example:8443/hook",
      "https://partner.example/hook#fragment",
      "not a URL",
    ];
    for (const webhookUrl of invalid) {
      const response = await stub.fetch(request(path, "PATCH", { webhookUrl, updatedBy: actorId }));
      expect(response.status, webhookUrl).toBe(400);
    }
  });
});

describe("OrganisationRoom Space registry", () => {
  it("upserts owner/participant summaries and returns all Spaces to the admin view", async () => {
    const stub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(organisationId);
    const boardId = `b_${"D".repeat(22)}`;
    const coOwnerId = `a_${"E".repeat(22)}`;
    const participantId = `a_${"F".repeat(22)}`;
    const path = `/__internal/organisations/${organisationId}/spaces/${boardId}`;

    const stored = await stub.fetch(
      request(path, "PUT", {
        spaceId: "geometry-period-2",
        title: "Geometry period 2",
        archived: false,
        members: [
          { id: actorId, displayName: "Coach Mira", role: "owner" },
          { id: coOwnerId, displayName: "Coach Arun", role: "owner" },
          { id: participantId, displayName: "Student A", role: "editor" },
        ],
        settings: {
          accessMode: "private",
          drawingPolicy: "editors_enabled",
          features: DEFAULT_BOARD_FEATURES,
          aclVersion: 4,
        },
      }),
    );
    expect(stored.status, await stored.clone().text()).toBe(200);
    expect(await stored.json()).toMatchObject({
      boardId,
      spaceId: "geometry-period-2",
      title: "Geometry period 2",
      archived: false,
      owners: [
        { id: actorId, displayName: "Coach Mira", role: "owner", identifierHash: actorId },
        { id: coOwnerId, displayName: "Coach Arun", role: "owner", identifierHash: coOwnerId },
      ],
      participants: [
        {
          id: participantId,
          displayName: "Student A",
          role: "editor",
          identifierHash: participantId,
        },
      ],
      settings: {
        accessMode: "private",
        drawingPolicy: "editors_enabled",
        aclVersion: 4,
      },
      updatedAt: expect.any(Number),
    });

    await evictDurableObject(stub);
    const admin = await stub.fetch(request(`/__internal/organisations/${organisationId}/admin`));
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({
      settings: { webhookUrl: null },
      templateCount: 0,
      boards: [
        {
          boardId,
          owners: [{ identifierHash: actorId }, { identifierHash: coOwnerId }],
          participants: [{ identifierHash: participantId }],
        },
      ],
    });

    const deleted = await stub.fetch(request(path, "DELETE"));
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    expect(
      await (await stub.fetch(request(`/__internal/organisations/${organisationId}/admin`))).json(),
    ).toMatchObject({ boards: [] });

    const repeated = await stub.fetch(request(path, "DELETE"));
    expect(repeated.status).toBe(204);
  });

  it("fills additive feature defaults in Space summaries written by older workers", async () => {
    const stub = (env as unknown as Env).ORGANISATION_ROOMS.getByName(organisationId);
    const boardId = `b_${"L".repeat(22)}`;
    const path = `/__internal/organisations/${organisationId}/spaces/${boardId}`;
    const stored = await stub.fetch(
      request(path, "PUT", {
        spaceId: "legacy-feature-space",
        title: "Legacy feature Space",
        archived: false,
        members: [{ id: actorId, displayName: "Coach Mira", role: "owner" }],
        settings: {
          accessMode: "private",
          drawingPolicy: "editors_enabled",
          features: { ...legacyBoardFeatures(), rectangle: false },
          aclVersion: 1,
        },
      }),
    );
    expect(stored.status, await stored.clone().text()).toBe(200);
    expect(await stored.json()).toMatchObject({
      settings: {
        features: { rectangle: false, objectTransforms: true, grouping: true },
      },
    });

    const storedFeatures = await runInDurableObject(stub, (_instance, durableState) => {
      const row = durableState.storage.sql
        .exec<{ settings_json: string }>(
          "SELECT settings_json FROM spaces WHERE board_id = ?",
          boardId,
        )
        .one();
      return (JSON.parse(row.settings_json) as { features: Record<string, boolean> }).features;
    });
    expect(storedFeatures).toMatchObject({
      rectangle: false,
      objectTransforms: true,
      grouping: true,
    });

    await runInDurableObject(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE spaces SET settings_json = ? WHERE board_id = ?",
        JSON.stringify({
          accessMode: "private",
          drawingPolicy: "editors_enabled",
          features: { ...legacyBoardFeatures(), rectangle: false },
          aclVersion: 1,
        }),
        boardId,
      );
    });
    await evictDurableObject(stub);

    const admin = await stub.fetch(request(`/__internal/organisations/${organisationId}/admin`));
    expect(admin.status, await admin.clone().text()).toBe(200);
    expect(await admin.json()).toMatchObject({
      boards: [
        {
          boardId,
          settings: {
            features: { rectangle: false, objectTransforms: true, grouping: true },
          },
        },
      ],
    });
  });
});

#!/usr/bin/env node
import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const config = {
  origin: (process.env.SPACESCALE_ORIGIN ?? "https://your-spacescale.example").replace(/\/$/u, ""),
  organisationId: required("SPACESCALE_ORGANISATION_ID"),
  keyId: required("SPACESCALE_KEY_ID"),
  signingKey: required("SPACESCALE_SIGNING_KEY"),
  spaceId: process.env.SPACESCALE_SPACE_ID ?? `sample-space-${Date.now()}`,
};
config.hostname = new URL(config.origin).hostname;

const SYNTHETIC_TEMPLATE_AUTHOR = `a_${"A".repeat(22)}`;
const SYNTHETIC_SOURCE_BOARD = `b_${"A".repeat(22)}`;

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createLaunchToken({
  hostname,
  organisationId,
  spaceId,
  keyId,
  signingKey,
  role,
  displayName,
  participantId,
  features,
  organisationAdmin,
  expiresInSeconds = 60 * 60,
}) {
  if (!["owner", "editor", "viewer"].includes(role)) throw new Error("Invalid role");
  if (expiresInSeconds < 1 || expiresInSeconds > 24 * 60 * 60) {
    throw new Error("expiresInSeconds must be between 1 and 86400");
  }
  const now = Math.floor(Date.now() / 1_000);
  const payload = {
    v: 1,
    aud: hostname,
    organisation_id: organisationId,
    space_id: spaceId,
    key_id: keyId,
    role,
    display_name: displayName,
    participant_id: participantId,
    iat: now,
    exp: now + expiresInSeconds,
    ...(features === undefined ? {} : { features }),
    ...(organisationAdmin === undefined ? {} : { organisation_admin: organisationAdmin }),
  };
  const encodedPayload = base64urlJson(payload);
  const signed = `el1.${encodedPayload}`;
  const signature = createHmac("sha256", signingKey).update(signed).digest("base64url");
  return `${signed}.${signature}`;
}

export function createEmbedUrl({ origin, launchToken, initialTemplate }) {
  const fragment = new URLSearchParams({ launch: launchToken });
  if (initialTemplate !== undefined) {
    fragment.set("import", base64urlJson(initialTemplate));
  }
  return `${origin.replace(/\/$/u, "")}/embed#${fragment}`;
}

function sampleItems(version, { lockSections = false } = {}) {
  const responseSectionId = randomUUID();
  return [
    {
      id: randomUUID(),
      kind: "text",
      z: 1,
      version,
      createdBy: SYNTHETIC_TEMPLATE_AUTHOR,
      style: {
        kind: "text",
        color: "#1f2937",
        fontSize: 32,
        fontFamily: "sans",
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: {
        x: 80,
        y: 70,
        text: "What did you notice? What do you wonder?",
      },
    },
    {
      id: responseSectionId,
      kind: "zone",
      z: 2,
      version,
      createdBy: SYNTHETIC_TEMPLATE_AUTHOR,
      style: {
        kind: "zone",
        borderColor: "#60a5fa",
        fill: "#eff6ff",
        textColor: "#1e3a8a",
        fontSize: 20,
        opacity: 0.8,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: {
        x: 80,
        y: 130,
        width: 700,
        height: 360,
        title: "Participant responses",
        locked: lockSections,
      },
    },
    {
      id: randomUUID(),
      kind: "sticky",
      z: 3,
      version,
      createdBy: SYNTHETIC_TEMPLATE_AUTHOR,
      sectionId: responseSectionId,
      style: {
        kind: "sticky",
        fill: "#FFE7A8",
        textColor: "#20201E",
        fontSize: 20,
        opacity: 1,
      },
      transform: [1, 0, 0, 1, 0, 0],
      geometry: {
        x: 100,
        y: 150,
        width: 240,
        height: 180,
        text: "Add your response",
      },
    },
  ];
}

export function createInitialTemplate(title, { lockSections = false } = {}) {
  return {
    format: "cf-whiteboard-json",
    version: 1,
    boardId: SYNTHETIC_SOURCE_BOARD,
    seq: 0,
    createdAt: Date.now(),
    settings: { title },
    items: sampleItems(0, { lockSections }),
  };
}

async function jsonRequest(path, { method = "GET", token, body, originHeader } = {}) {
  const response = await fetch(`${config.origin}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(originHeader === undefined ? {} : { Origin: originHeader }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

export async function resolveSpace({ ownerToken, initialTemplate }) {
  return jsonRequest("/api/v1/embed/session", {
    method: "POST",
    originHeader: config.origin,
    body: {
      token: ownerToken,
      ...(initialTemplate === undefined ? {} : { importSnapshot: base64urlJson(initialTemplate) }),
    },
  });
}

function organisationPath(suffix) {
  return `/api/v1/organisations/${encodeURIComponent(config.organisationId)}${suffix}`;
}

export function listOrganisationTemplates(ownerToken) {
  return jsonRequest(organisationPath("/templates"), { token: ownerToken });
}

export function createOrganisationTemplate(ownerToken, template) {
  return jsonRequest(organisationPath("/templates"), {
    method: "POST",
    token: ownerToken,
    body: template,
  });
}

export function updateOrganisationTemplate(ownerToken, templateId, changes) {
  return jsonRequest(organisationPath(`/templates/${encodeURIComponent(templateId)}`), {
    method: "PATCH",
    token: ownerToken,
    body: changes,
  });
}

export function deleteOrganisationTemplate(ownerToken, templateId) {
  return jsonRequest(organisationPath(`/templates/${encodeURIComponent(templateId)}`), {
    method: "DELETE",
    token: ownerToken,
  });
}

export function deleteBoard(ownerToken, boardId) {
  return jsonRequest(organisationPath(`/boards/${encodeURIComponent(boardId)}`), {
    method: "DELETE",
    token: ownerToken,
  });
}

async function main() {
  const initialTemplate = createInitialTemplate("Notice and wonder", { lockSections: true });
  const common = {
    hostname: config.hostname,
    organisationId: config.organisationId,
    spaceId: config.spaceId,
    keyId: config.keyId,
    signingKey: config.signingKey,
  };
  const ownerToken = createLaunchToken({
    ...common,
    role: "owner",
    displayName: "Coach Sample",
    participantId: "service:coach-sample",
    features: { organisationTemplates: true, templates: true },
  });
  const editorToken = createLaunchToken({
    ...common,
    role: "editor",
    displayName: "Student Sample",
    participantId: "student:sample-001",
  });
  const adminToken = createLaunchToken({
    ...common,
    role: "owner",
    displayName: "Organisation administrator",
    participantId: "service:organisation-admin",
    organisationAdmin: true,
    expiresInSeconds: 15 * 60,
  });

  console.log("Owner iframe URL:");
  console.log(createEmbedUrl({ origin: config.origin, launchToken: ownerToken, initialTemplate }));
  console.log("\nStudent iframe URL:");
  console.log(createEmbedUrl({ origin: config.origin, launchToken: editorToken }));
  console.log("\nOrganisation admin URL:");
  console.log(`${config.origin}/organisation/admin#launch=${encodeURIComponent(adminToken)}`);

  // Optional backend preflight: creates the Space and atomically applies the
  // initial template before any iframe is rendered.
  const launch = await resolveSpace({ ownerToken, initialTemplate });
  const boardId = launch.board.id;
  console.log("\nResolved board ID:", boardId);

  const apiToken = createLaunchToken({
    ...common,
    role: "owner",
    displayName: "Partner API",
    participantId: "service:partner-api",
    expiresInSeconds: 5 * 60,
  });

  const canonical = await jsonRequest(organisationPath(`/boards/${boardId}/export.json`), {
    token: apiToken,
  });
  const attributed = await jsonRequest(
    organisationPath(`/boards/${boardId}/export.attributed.json`),
    { token: apiToken },
  );
  console.log("Canonical objects:", canonical.items.length);
  console.log("Attributed participants:", attributed.participants.length);

  const created = await createOrganisationTemplate(apiToken, {
    name: "Notice and wonder",
    description: "Reusable prompt and response card",
    items: sampleItems(1),
  });
  console.log("Created Organisation template:", created.id);

  const updated = await updateOrganisationTemplate(apiToken, created.id, {
    name: "Notice, wonder, connect",
    description: "Updated from the parent backend",
    // Include items here as well when replacing the template objects.
  });
  console.log("Updated Organisation template:", updated.name);

  const listed = await listOrganisationTemplates(apiToken);
  console.log("Organisation template count:", listed.templates.length);

  // Destructive operations are available when needed, but are not run by this sample:
  // await deleteOrganisationTemplate(apiToken, created.id);
  // await deleteBoard(apiToken, boardId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

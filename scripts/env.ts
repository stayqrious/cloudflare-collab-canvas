import { existsSync, readFileSync } from "node:fs";
import { isConfiguredValue } from "./deployment-config.ts";

/** Parses a local env file without applying it; a missing file yields no values. */
export function readLocalEnv(path = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(path)) return values;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Keep runtime configuration canonical while accepting the common local
    // mistake of pasting an HTTPS origin into the hostname-only .env field.
    if (key === "APP_HOSTNAME" && value.startsWith("https://")) {
      const url = new URL(value);
      if (url.pathname !== "/" || url.search || url.hash || url.port) {
        throw new Error("APP_HOSTNAME may not contain a port, path, query, or fragment.");
      }
      value = url.hostname;
    }
    values[key] = value;
  }
  return values;
}

export function loadLocalEnv(path = ".env"): void {
  for (const [key, value] of Object.entries(readLocalEnv(path))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnvironment(names: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (!value || !isConfiguredValue(value)) missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(`Missing configured environment variables: ${missing.join(", ")}`);
  }
  return values;
}

export function assertPublicConfiguration(values: Record<string, string>): void {
  if (
    values.CLOUDFLARE_ACCOUNT_ID !== undefined &&
    !/^[a-f\d]{32}$/iu.test(values.CLOUDFLARE_ACCOUNT_ID)
  ) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal identifier.");
  }
  const hostname = values.APP_HOSTNAME;
  if (
    hostname &&
    hostname !== "localhost" &&
    (!/^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(
      hostname,
    ) ||
      hostname.includes("://") ||
      hostname.includes("/"))
  ) {
    throw new Error("APP_HOSTNAME must contain only a valid hostname.");
  }
  for (const [name, key] of [
    ["SESSION_SIGNING_KEY_CURRENT", values.SESSION_SIGNING_KEY_CURRENT],
  ] as const) {
    if (!key) continue;
    const looksBase64 = /^[A-Za-z\d+/]+={0,2}$/u.test(key) && key.length % 4 === 0;
    const keyBytes = looksBase64
      ? Buffer.from(key, "base64").byteLength
      : Buffer.byteLength(key, "utf8");
    if (keyBytes < 32) {
      throw new Error(`${name} must contain at least 32 random bytes.`);
    }
  }
  if (values.ORGANISATION_SIGNING_KEYS) {
    assertOrganisationSigningKeys(values.ORGANISATION_SIGNING_KEYS);
  }
  const allowedOrigins = values.ALLOWED_ORIGINS?.trim();
  if (allowedOrigins && allowedOrigins !== "*") {
    if (allowedOrigins.length > 2_048) {
      throw new Error("ALLOWED_ORIGINS is too long.");
    }
    const sources = allowedOrigins.split(",").map((source) => source.trim());
    if (sources.length > 20 || sources.some((source) => source.length === 0)) {
      throw new Error("ALLOWED_ORIGINS must contain 1 to 20 comma-separated origins.");
    }
    for (const source of sources) {
      let origin: URL;
      try {
        origin = new URL(source);
      } catch {
        throw new Error("ALLOWED_ORIGINS must contain only absolute origins.");
      }
      const local =
        origin.hostname === "localhost" ||
        origin.hostname === "127.0.0.1" ||
        origin.hostname === "[::1]";
      if (
        source.includes("*") ||
        origin.username !== "" ||
        origin.password !== "" ||
        origin.pathname !== "/" ||
        origin.search !== "" ||
        origin.hash !== "" ||
        origin.origin !== source ||
        (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))
      ) {
        throw new Error(
          "ALLOWED_ORIGINS must be '*' or comma-separated exact HTTPS origins without paths.",
        );
      }
    }
  }
}

function assertOrganisationSigningKeys(source: string): void {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("ORGANISATION_SIGNING_KEYS must be valid JSON.");
  }
  if (!isRecord(value) || Object.keys(value).length < 1 || Object.keys(value).length > 256) {
    throw new Error("ORGANISATION_SIGNING_KEYS must contain 1 to 256 organisations.");
  }
  for (const [organisationId, rawOrganisation] of Object.entries(value)) {
    if (
      organisationId.normalize("NFC").trim() !== organisationId ||
      organisationId.length < 1 ||
      organisationId.length > 120 ||
      !isRecord(rawOrganisation) ||
      !hasStrongKey(rawOrganisation.derivation_key) ||
      !isRecord(rawOrganisation.current) ||
      !validKeyId(rawOrganisation.current.key_id) ||
      !hasStrongKey(rawOrganisation.current.key) ||
      !Array.isArray(rawOrganisation.previous) ||
      rawOrganisation.previous.length > 8
    ) {
      throw new Error(`ORGANISATION_SIGNING_KEYS has an invalid entry for ${organisationId}.`);
    }
    const keyIds = new Set<string>([rawOrganisation.current.key_id as string]);
    for (const previous of rawOrganisation.previous) {
      if (
        !isRecord(previous) ||
        !validKeyId(previous.key_id) ||
        !hasStrongKey(previous.key) ||
        keyIds.has(previous.key_id as string)
      ) {
        throw new Error(`ORGANISATION_SIGNING_KEYS has an invalid rotation for ${organisationId}.`);
      }
      keyIds.add(previous.key_id as string);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validKeyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function hasStrongKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const looksBase64 = /^[A-Za-z\d+/]+={0,2}$/u.test(value) && value.length % 4 === 0;
  return (
    (looksBase64 ? Buffer.from(value, "base64").byteLength : Buffer.byteLength(value, "utf8")) >= 32
  );
}

export function assertTurnstileSiteKeyForEnvironment(
  siteKey: string,
  environment: "development" | "staging" | "production",
): void {
  if (siteKey.startsWith("replace-with-") || siteKey.length < 10) {
    throw new Error("TURNSTILE_SITE_KEY must be a configured public widget site key.");
  }
  if (environment !== "development" && /^[123]x0{10,}/u.test(siteKey)) {
    throw new Error(`Cloudflare Turnstile test site keys are forbidden in ${environment}.`);
  }
}

export type CloudflareEnvelope<T> = {
  success: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
};

export async function cloudflareRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; envelope: CloudflareEnvelope<T> }> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not configured.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  let envelope: CloudflareEnvelope<T>;
  try {
    envelope = (await response.json()) as CloudflareEnvelope<T>;
  } catch {
    envelope = { success: false, errors: [{ code: response.status }] };
  }
  return { response, envelope };
}

export function publicApiFailure(
  label: string,
  response: Response,
  envelope: CloudflareEnvelope<unknown>,
): Error {
  const codes = (envelope.errors ?? [])
    .map((error) => error.code)
    .filter((code): code is number => typeof code === "number");
  return new Error(
    `${label} failed (HTTP ${response.status}; codes ${codes.join(",") || "none"}).`,
  );
}

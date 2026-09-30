import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnv } from "node:util";
import { isConfiguredValue } from "./deployment-config.ts";
import { assertPublicConfiguration } from "./env.ts";

export const LOCAL_DEVELOPMENT_SECRETS_PATH = ".generated/.dev.vars";

export type LocalDevelopmentSecretsResult = {
  path: string;
  created: boolean;
};

export function ensureLocalDevelopmentSecrets(
  path = LOCAL_DEVELOPMENT_SECRETS_PATH,
): LocalDevelopmentSecretsResult {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const organisationRegistry = {
      demo: {
        derivation_key: randomBytes(32).toString("base64"),
        current: {
          key_id: "local-v1",
          key: randomBytes(32).toString("base64"),
        },
        previous: [],
      },
    };
    const lines = [
      "# Generated for local development. Never deploy or commit this file.",
      `SESSION_SIGNING_KEY_CURRENT=${randomBytes(32).toString("base64")}`,
      'SESSION_SIGNING_KEY_PREVIOUS=""',
      `ORGANISATION_SIGNING_KEYS='${JSON.stringify(organisationRegistry)}'`,
      'WEBHOOK_ALLOWED_ORIGINS=""',
    ];
    writeFileSync(path, `${lines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { path, created: true };
  }

  const values = parseEnv(readFileSync(path, "utf8"));
  const missing = ["SESSION_SIGNING_KEY_CURRENT", "ORGANISATION_SIGNING_KEYS"].filter(
    (name) => !isConfiguredValue(values[name]),
  );
  if (missing.length > 0) {
    throw new Error(
      `${path} is incomplete. Configure ${missing.join(", ")} or remove the file so setup can generate fresh local values.`,
    );
  }
  const configuredValues = Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  assertPublicConfiguration(configuredValues);
  const registry = JSON.parse(values.ORGANISATION_SIGNING_KEYS ?? "null") as Record<
    string,
    unknown
  > | null;
  if (!registry || registry.demo === undefined) {
    throw new Error(
      `${path} must contain a demo entry in ORGANISATION_SIGNING_KEYS for the local classroom flow.`,
    );
  }
  chmodSync(path, 0o600);
  return { path, created: false };
}

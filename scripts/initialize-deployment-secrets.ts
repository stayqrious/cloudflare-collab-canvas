import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { isConfiguredValue, parseEnvironmentArguments } from "./deployment-config.ts";
import { loadLocalEnv } from "./env.ts";
import { ensureLocalDevelopmentSecrets } from "./local-development-secrets.ts";

try {
  const { environment } = parseEnvironmentArguments(process.argv.slice(2));
  if (environment === "development") {
    const result = ensureLocalDevelopmentSecrets();
    process.stdout.write(`${JSON.stringify({ ok: true, environment, ...result })}\n`);
  } else {
    const path = `.env.${environment}`;
    loadLocalEnv(path);
    loadLocalEnv();
    const needsSessionKey = !isConfiguredValue(process.env.SESSION_SIGNING_KEY_CURRENT);
    const needsOrganisationKeys = !isConfiguredValue(process.env.ORGANISATION_SIGNING_KEYS);

    if (!needsSessionKey && !needsOrganisationKeys) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, environment, generated: [], existingConfiguration: true })}\n`,
      );
    } else {
      if (existsSync(path)) {
        throw new Error(
          `Deployment secrets are incomplete. Add the missing values to ${path}; the initializer will not overwrite it.`,
        );
      }

      const generatedNames: string[] = [];
      const lines: string[] = [];
      if (needsSessionKey) {
        lines.push(`SESSION_SIGNING_KEY_CURRENT=${randomBytes(32).toString("base64")}`);
        generatedNames.push("SESSION_SIGNING_KEY_CURRENT");
      }
      if (needsOrganisationKeys) {
        const registry = {
          hackathon: {
            derivation_key: randomBytes(32).toString("base64"),
            current: {
              key_id: "v1",
              key: randomBytes(32).toString("base64"),
            },
            previous: [],
          },
        };
        lines.push(`ORGANISATION_SIGNING_KEYS=${JSON.stringify(registry)}`);
        generatedNames.push("ORGANISATION_SIGNING_KEYS");
      }
      writeFileSync(path, `${lines.join("\n")}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      process.stdout.write(
        `${JSON.stringify({ ok: true, environment, generated: generatedNames, path })}\n`,
      );
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Secret initialization failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

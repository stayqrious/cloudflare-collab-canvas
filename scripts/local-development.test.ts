import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { deploymentConfigurationFromEnvironment } from "./deployment-config";
import { ensureLocalDevelopmentSecrets } from "./local-development-secrets";

type PackageManifest = {
  scripts?: Record<string, string>;
};

describe("local development configuration", () => {
  it("forces the development environment, local bindings, and bundled local values", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as PackageManifest;
    const playwright = readFileSync("tests/playwright/playwright.config.ts", "utf8");
    const classroomTest = readFileSync("tests/playwright/classroom-embed.spec.ts", "utf8");
    const edgeTestConfig = readFileSync("vitest.cloudflare.config.ts", "utf8");
    const localOnlyCommand = "wrangler dev --config .generated/wrangler.development.jsonc --local";

    expect(manifest.scripts?.dev).toContain(localOnlyCommand);
    expect(playwright).toContain(localOnlyCommand);
    expect(manifest.scripts?.dev).toContain("config:setup -- --env development");
    expect(manifest.scripts?.build).toContain("config:setup -- --env production --dry-run");
    expect(manifest.scripts?.["cf:types"]).toContain("--env-file .dev.vars.example");
    expect(playwright).toContain("config:setup -- --env development");
    expect(playwright).toContain("cwd: repositoryRoot");
    expect(manifest.scripts?.["test:e2e"]).toContain("npm run build:web");
    expect(manifest.scripts?.["test:edge"]).toContain("npm run build:web");
    expect(classroomTest).toContain('".generated/.dev.vars"');
    expect(edgeTestConfig).toContain("miniflare: { bindings: localBindings }");
    expect(edgeTestConfig).toContain('"./.generated/.dev.vars"');
  });

  it("documents local secret names without shipping reusable secret values", () => {
    const development = deploymentConfigurationFromEnvironment("development", {});
    const template = readFileSync(".dev.vars.example", "utf8");

    expect(development).toMatchObject({
      hostname: "localhost",
      environment: "development",
      turnstileEnabled: false,
    });
    expect(template).toContain("SESSION_SIGNING_KEY_CURRENT=");
    expect(template).toContain("ORGANISATION_SIGNING_KEYS=");
    expect(template).toContain("replace-with-generated-local-key");
    expect(template).not.toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(template).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(development.bucketName).not.toBe(development.assetBucketName);
    expect(template).not.toContain("R2_ASSET");
  });

  it("creates strong per-checkout local values once and locks the file to the owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "spacescale-local-secrets-"));
    const path = join(directory, ".dev.vars");
    try {
      const first = ensureLocalDevelopmentSecrets(path);
      const contents = readFileSync(path, "utf8");
      const values = parseEnv(contents);
      const registry = JSON.parse(values.ORGANISATION_SIGNING_KEYS ?? "null") as {
        demo?: { derivation_key?: string; current?: { key?: string } };
      };

      expect(first).toEqual({ path, created: true });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(values.SESSION_SIGNING_KEY_CURRENT).toMatch(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u);
      expect(registry.demo?.derivation_key).toMatch(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u);
      expect(registry.demo?.current?.key).toMatch(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/u);

      expect(ensureLocalDevelopmentSecrets(path)).toEqual({
        path,
        created: false,
      });
      expect(readFileSync(path, "utf8")).toBe(contents);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails clearly when an existing local secret file is incomplete", () => {
    const directory = mkdtempSync(join(tmpdir(), "spacescale-local-secrets-"));
    const path = join(directory, ".dev.vars");
    try {
      writeFileSync(path, "SESSION_SIGNING_KEY_CURRENT=already-configured\n", {
        mode: 0o600,
      });
      expect(() => ensureLocalDevelopmentSecrets(path)).toThrow(
        /Configure ORGANISATION_SIGNING_KEYS/u,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

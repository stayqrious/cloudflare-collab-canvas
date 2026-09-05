import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeploymentConfigurationError,
  deploymentConfigurationFromEnvironment,
  dryRunDeploymentValues,
  generatedWranglerConfigPath,
  isConfiguredValue,
  parseEnvironmentArguments,
  requestedEnvironment,
  writeGeneratedWranglerConfig,
} from "./deployment-config";

const originalCwd = process.cwd();

afterEach(() => process.chdir(originalCwd));

describe("setup-time deployment configuration", () => {
  it("fails closed without exposing partial resource values", () => {
    const partial = "private-value-that-must-not-appear";
    expect(() =>
      deploymentConfigurationFromEnvironment("production", {
        DEPLOYMENT_NAME: "example",
        APP_HOSTNAME: partial,
      }),
    ).toThrow(DeploymentConfigurationError);
    try {
      deploymentConfigurationFromEnvironment("production", {
        DEPLOYMENT_NAME: "example",
        APP_HOSTNAME: partial,
      });
    } catch (error) {
      expect(String(error)).not.toContain(partial);
      expect(String(error)).toContain("Deployment initialization is incomplete");
    }
  });

  it("derives simple isolated resource names from deployment name and environment", () => {
    const configuration = deploymentConfigurationFromEnvironment("production", {
      DEPLOYMENT_NAME: "example-canvas",
      APP_HOSTNAME: "canvas.example.test",
      TURNSTILE_SITE_KEY: "configured-site-key",
    });

    expect(configuration.workerName).toBe("example-canvas-production");
    expect(configuration.bucketName).toBe("example-canvas-production-snapshots");
    expect(configuration.assetBucketName).toBe("example-canvas-production-assets");
  });

  it("keeps an existing installation on its own Worker and bucket names", () => {
    const configuration = deploymentConfigurationFromEnvironment("production", {
      DEPLOYMENT_NAME: "example-canvas",
      APP_HOSTNAME: "canvas.example.test",
      TURNSTILE_SITE_KEY: "configured-site-key",
      CLOUDFLARE_WORKER_NAME: "existing-canvas",
      R2_BUCKET_NAME: "existing-canvas-snapshots",
      R2_ASSET_BUCKET_NAME: "existing-canvas-assets",
    });

    expect(configuration.workerName).toBe("existing-canvas");
    expect(configuration.bucketName).toBe("existing-canvas-snapshots");
    expect(configuration.assetBucketName).toBe("existing-canvas-assets");
  });

  it("rejects an invalid override without exposing its value", () => {
    const invalidBucket = "Invalid_Private_Bucket_Value";
    try {
      deploymentConfigurationFromEnvironment("staging", {
        DEPLOYMENT_NAME: "example-canvas",
        APP_HOSTNAME: "staging.example.test",
        R2_BUCKET_NAME: invalidBucket,
        TURNSTILE_ENABLED: "false",
      });
      throw new Error("Expected override rejection");
    } catch (error) {
      expect(String(error)).toContain("R2_BUCKET_NAME");
      expect(String(error)).not.toContain(invalidBucket);
    }
  });

  it("refuses to point both buckets at one name", () => {
    expect(() =>
      deploymentConfigurationFromEnvironment("staging", {
        DEPLOYMENT_NAME: "example-canvas",
        APP_HOSTNAME: "staging.example.test",
        R2_BUCKET_NAME: "one-bucket",
        R2_ASSET_BUCKET_NAME: "one-bucket",
        TURNSTILE_ENABLED: "false",
      }),
    ).toThrow();
  });

  it("keeps staging and production resource mappings separate", () => {
    const shared = { DEPLOYMENT_NAME: "example-canvas", APP_HOSTNAME: "canvas.example.test" };
    const staging = deploymentConfigurationFromEnvironment("staging", {
      ...shared,
      TURNSTILE_ENABLED: "false",
    });
    const production = deploymentConfigurationFromEnvironment("production", {
      ...shared,
      TURNSTILE_SITE_KEY: "configured-site-key",
    });

    expect(staging.workerName).toBe("example-canvas-staging");
    expect(staging.bucketName).not.toBe(production.bucketName);
    expect(staging.assetBucketName).not.toBe(production.assetBucketName);
  });

  it("writes the resolved mapping only to the ignored generated config", () => {
    const directory = mkdtempSync(join(tmpdir(), "spacescale-config-"));
    chmodSync(directory, 0o700);
    process.chdir(directory);
    const configuration = deploymentConfigurationFromEnvironment("staging", {
      DEPLOYMENT_NAME: "example-canvas",
      APP_HOSTNAME: "staging.example.test",
      TURNSTILE_ENABLED: "false",
    });

    const path = writeGeneratedWranglerConfig(configuration);
    expect(path).toBe(generatedWranglerConfigPath("staging"));
    const written = readFileSync(path, "utf8");
    const parsed = JSON.parse(written) as {
      routes?: unknown;
      workers_dev?: unknown;
      keep_vars?: unknown;
    };
    expect(written).toContain("example-canvas-staging-snapshots");
    expect(written).toContain("example-canvas-staging-assets");
    expect(parsed.routes).toEqual([{ pattern: "staging.example.test", custom_domain: true }]);
    expect(parsed.workers_dev).toBe(false);
    expect(parsed.keep_vars).toBe(true);
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});

describe("shared deployment command helpers", () => {
  it("reads the requested environment without validating other arguments", () => {
    expect(requestedEnvironment(["--env", "staging", "--verbose"])).toBe("staging");
    expect(requestedEnvironment(["--verbose"])).toBeUndefined();
    expect(requestedEnvironment(["--env"])).toBeUndefined();
  });

  it("parses strict environment arguments with optional flags only", () => {
    expect(parseEnvironmentArguments(["--env", "production"])).toEqual({
      environment: "production",
      flags: {},
    });
    expect(parseEnvironmentArguments(["--dry-run", "--env", "staging"], ["--dry-run"])).toEqual({
      environment: "staging",
      flags: { "--dry-run": true },
    });
    for (const args of [
      [],
      ["--env"],
      ["--env", "test"],
      ["--env", "production", "--dry-run"],
      ["--env", "production", "--env", "staging"],
    ]) {
      expect(() => parseEnvironmentArguments(args)).toThrow(DeploymentConfigurationError);
    }
  });

  it("treats blanks and .env.sample placeholders as unconfigured", () => {
    expect(isConfiguredValue(undefined)).toBe(false);
    expect(isConfiguredValue("   ")).toBe(false);
    expect(isConfiguredValue("replace-with-your-value")).toBe(false);
    expect(isConfiguredValue(" configured ")).toBe(true);
  });

  it("verifies a production build without deployment details using dry-run values", () => {
    const dryRun = dryRunDeploymentValues("production", {});
    const configuration = deploymentConfigurationFromEnvironment("production", dryRun.values);

    expect(dryRun.placeholders).toEqual(["DEPLOYMENT_NAME", "APP_HOSTNAME", "TURNSTILE_SITE_KEY"]);
    expect(configuration.hostname.endsWith(".workers.dev")).toBe(true);
    expect(configuration.turnstileEnabled).toBe(true);
    expect(configuration.workerName).toBe("dry-run-production");
  });

  it("keeps configured deployment details during a dry run", () => {
    const dryRun = dryRunDeploymentValues("staging", {
      DEPLOYMENT_NAME: "example-canvas",
      APP_HOSTNAME: "replace-with-hostname",
      TURNSTILE_ENABLED: "false",
    });

    expect(dryRun.placeholders).toEqual(["APP_HOSTNAME"]);
    expect(dryRun.values.DEPLOYMENT_NAME).toBe("example-canvas");
    expect(dryRun.values.TURNSTILE_SITE_KEY).toBeUndefined();
    expect(dryRunDeploymentValues("development", {})).toEqual({ values: {}, placeholders: [] });
  });
});

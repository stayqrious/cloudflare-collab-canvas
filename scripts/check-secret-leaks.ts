import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  derivedResourceNames,
  isConfiguredValue,
  validDeploymentName,
} from "./deployment-config.ts";
import { loadLocalEnv } from "./env.ts";

const SECRET_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CLASSROOM_INTEGRATION_KEY",
  "ORGANISATION_SIGNING_KEYS",
  "TURNSTILE_SECRET_KEY",
  "SESSION_SIGNING_KEY_CURRENT",
  "SESSION_SIGNING_KEY_PREVIOUS",
] as const;
const PRIVATE_CONFIGURATION_NAMES = [
  "R2_BUCKET_NAME",
  "R2_ASSET_BUCKET_NAME",
  "CLOUDFLARE_WORKER_NAME",
  "APP_HOSTNAME",
] as const;
const BUILD_DIRECTORIES = ["apps/web/dist", "dist/worker"] as const;
const GENERATED_BUILD_METADATA = new Set(["dist/worker/README.md"]);

loadLocalEnv();

const files = new Set(
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean),
);
for (const directory of BUILD_DIRECTORIES) addFilesRecursively(directory, files);

const protectedValues: Array<{ name: string; value: string }> = [
  ...SECRET_NAMES,
  ...PRIVATE_CONFIGURATION_NAMES,
].flatMap((name) => {
  const value = process.env[name];
  return value !== undefined && value.length >= 12 && isConfiguredValue(value)
    ? [{ name, value }]
    : [];
});
const deploymentName = process.env.DEPLOYMENT_NAME?.trim();
if (deploymentName !== undefined && validDeploymentName(deploymentName)) {
  for (const environment of ["staging", "production"] as const) {
    const names = derivedResourceNames(deploymentName, environment);
    protectedValues.push(
      { name: "DERIVED_WORKER_NAME", value: names.workerName },
      { name: "DERIVED_SNAPSHOT_BUCKET_NAME", value: names.bucketName },
      { name: "DERIVED_ASSET_BUCKET_NAME", value: names.assetBucketName },
    );
  }
}
const leaks: Array<{ secret: string; file: string }> = [];
for (const file of files) {
  if (GENERATED_BUILD_METADATA.has(file)) continue;
  if (!existsSync(file)) continue;
  let contents: Buffer;
  try {
    contents = readFileSync(file);
  } catch {
    continue;
  }
  for (const protectedValue of protectedValues) {
    if (contents.includes(Buffer.from(protectedValue.value))) {
      leaks.push({ secret: protectedValue.name, file });
    }
  }
}

process.stdout.write(
  `${JSON.stringify({
    ok: leaks.length === 0,
    scannedFiles: files.size,
    configuredSecretsChecked: protectedValues.map((secret) => secret.name),
    leaks,
  })}\n`,
);
if (leaks.length > 0) process.exitCode = 1;

function addFilesRecursively(path: string, files: Set<string>): void {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) addFilesRecursively(child, files);
    else if (entry.isFile()) files.add(child);
  }
}

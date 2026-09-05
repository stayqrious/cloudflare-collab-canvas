import { existsSync, readFileSync } from "node:fs";

const sample = readFileSync(".env.sample", "utf8");
const readme = readFileSync("README.md", "utf8");
const operations = readFileSync("docs/operations.md", "utf8");
const packageManifest = readFileSync("package.json", "utf8");
const deployWorkflow = readFileSync(".github/workflows/deploy.yml", "utf8");
const setupSource = readFileSync("scripts/deployment-config.ts", "utf8");
const gitignoreLines = readFileSync(".gitignore", "utf8").split(/\r?\n/u);
const sampleEntries = [...sample.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gmu)].flatMap((match) =>
  match[1] !== undefined && match[2] !== undefined ? [[match[1], match[2]]] : [],
);
const sampleValues = Object.fromEntries(sampleEntries) as Record<string, string>;
const keys = sampleEntries.map(([key]) => key);
const errors: string[] = [];

if (!readme.includes("## Cloudflare setup")) errors.push("README lacks a Cloudflare setup section");
for (const requiredIgnore of [".env", ".env.*", "!.env.sample", ".dev.vars", ".generated/"]) {
  if (!gitignoreLines.includes(requiredIgnore)) errors.push(`${requiredIgnore} is not ignored`);
}
// The committed Wrangler configuration is what Cloudflare Workers Builds deploys
// from its connected branch. It must keep Worker-level variables, which is the
// only thing standing between a deployment and every dashboard-set var.
if (!existsSync("wrangler.jsonc")) {
  errors.push("wrangler.jsonc must stay committed for the connected deployment");
} else if (!readFileSync("wrangler.jsonc", "utf8").includes('"keep_vars": true')) {
  errors.push("wrangler.jsonc must set keep_vars so dashboard variables survive a deploy");
}
if (existsSync("config/environments.json")) {
  errors.push("config/environments.json must not contain committed deployment mappings");
}
for (const name of [
  "DEPLOYMENT_NAME",
  "R2_BUCKET_JURISDICTION",
  "APP_HOSTNAME",
  "BOARD_CREATION_ENABLED",
  "TURNSTILE_ENABLED",
]) {
  if (!keys.includes(name)) errors.push(`.env.sample is missing ${name}`);
  if (!readme.includes(`\`${name}\``)) errors.push(`README is missing ${name}`);
}
for (const name of ["DEPLOYMENT_NAME", "APP_HOSTNAME"]) {
  if (!sampleValues[name]?.startsWith("replace-with-")) {
    errors.push(`${name} must use a non-deployable placeholder in .env.sample`);
  }
}
// Explicit resource names are optional overrides for an installation that
// predates name derivation. They must be documented, and blank by default so a
// new installation takes the derived names.
for (const override of ["R2_BUCKET_NAME", "R2_ASSET_BUCKET_NAME", "CLOUDFLARE_WORKER_NAME"]) {
  if (!keys.includes(override)) {
    errors.push(`.env.sample does not document the ${override} override`);
  }
  if (sampleValues[override]) {
    errors.push(`${override} must be blank in .env.sample so derived names stay the default`);
  }
}
if (!packageManifest.includes('"deployment:init"')) {
  errors.push("package scripts lack deployment:init");
}
if (!packageManifest.includes(".generated/wrangler.")) {
  errors.push("package scripts do not consume generated Wrangler configuration");
}
if (!deployWorkflow.includes("npm run deployment:init")) {
  errors.push("deployment workflow does not initialize configuration and resources");
}
if (!deployWorkflow.includes(".generated/wrangler.")) {
  errors.push("deployment workflow does not consume generated Wrangler configuration");
}
if (!setupSource.includes("Deployment initialization is incomplete")) {
  errors.push("setup does not provide the safe missing-configuration error");
}
if (!readme.includes("generated") || !operations.includes("generated")) {
  errors.push("deployment guides do not explain generated configuration");
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({ ok: true, documentedEnvironmentKeys: keys.length, committedMappings: 0 })}\n`,
  );
}

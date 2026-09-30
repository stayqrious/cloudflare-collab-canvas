import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  deploymentConfigurationFromEnvironment,
  generatedWranglerConfigPath,
  parseEnvironmentArguments,
} from "./deployment-config.ts";
import { assertPublicConfiguration, loadLocalEnv, requireEnvironment } from "./env.ts";

function run(command: "npm" | "npx", args: string[]): void {
  const result = spawnSync(process.platform === "win32" ? `${command}.cmd` : command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error || result.status !== 0) throw new Error(`${command} deployment step failed.`);
}

/** Shared by Workers Builds, GitHub Actions, and an explicit local first deployment. */
export async function deploy(environment: "staging" | "production"): Promise<void> {
  loadLocalEnv(`.env.${environment}`);
  loadLocalEnv();
  const configuration = deploymentConfigurationFromEnvironment(environment, process.env);
  const branch = process.env.WORKERS_CI_BRANCH;
  if (process.env.WORKERS_CI && branch !== (environment === "production" ? "main" : "staging")) {
    throw new Error("Workers Builds must deploy only the configured staging or main branch.");
  }
  const required = requireEnvironment([
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "SESSION_SIGNING_KEY_CURRENT",
    "ORGANISATION_SIGNING_KEYS",
    ...(configuration.turnstileEnabled ? ["TURNSTILE_SECRET_KEY"] : []),
  ]);
  assertPublicConfiguration({ ...required, APP_HOSTNAME: configuration.hostname });
  const secrets: Record<string, string> = {};
  for (const name of [
    "SESSION_SIGNING_KEY_CURRENT",
    "ORGANISATION_SIGNING_KEYS",
    "SESSION_SIGNING_KEY_PREVIOUS",
    "TURNSTILE_SECRET_KEY",
  ]) {
    const value = process.env[name]?.trim();
    if (value) secrets[name] = value;
  }

  // Validate everything above before creating resources. Upload runtime secrets atomically
  // with the code, including on a fresh Worker; build secrets are not runtime bindings.
  run("npm", ["run", "deployment:init", "--", "--env", environment]);
  run("npm", ["run", "build:web"]);
  const directory = mkdtempSync(join(tmpdir(), "spacescale-deploy-"));
  try {
    const secretsPath = join(directory, "secrets.json");
    writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    run("npx", [
      "--no-install",
      "wrangler",
      "deploy",
      "--config",
      generatedWranglerConfigPath(environment),
      "--secrets-file",
      secretsPath,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  run("npm", ["run", "deployment:init", "--", "--env", environment, "--finalize"]);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(
        `https://${configuration.hostname}/healthz?deploy=${Date.now()}`,
        {
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        },
      );
      const result = (await response.json()) as { ok?: boolean; service?: string };
      if (response.ok && result.ok === true && result.service === "cloudflare-collab-canvas-edge") {
        process.stdout.write(
          `${JSON.stringify({ ok: true, environment, deployment: "complete" })}\n`,
        );
        return;
      }
    } catch {
      // DNS and certificate activation can lag domain attachment; retry without logging secrets.
    }
    if (attempt < 4) await setTimeout(3_000);
  }
  throw new Error("Post-deployment health check failed. Inspect the Worker and Custom Domain.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { environment } = parseEnvironmentArguments(process.argv.slice(2));
    if (environment === "development") throw new Error("Use npm run dev for local development.");
    await deploy(environment);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Deployment failed."}\n`);
    process.exitCode = 1;
  }
}

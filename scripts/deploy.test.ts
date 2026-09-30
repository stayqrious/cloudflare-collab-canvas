import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deploy } from "./deploy.ts";

const mocks = vi.hoisted(() => ({
  run: vi.fn((_command: string, _args: string[]) => ({ status: 0 })),
  sleep: vi.fn(async () => undefined),
}));
vi.mock("node:child_process", () => ({ spawnSync: mocks.run }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.sleep }));
vi.mock("./env.ts", async (original) => ({
  ...(await original<typeof import("./env.ts")>()),
  loadLocalEnv: vi.fn(),
}));

const healthy = () => Response.json({ ok: true, service: "cloudflare-collab-canvas-edge" });
let secretPath = "";

beforeEach(() => {
  vi.clearAllMocks();
  const values: Record<string, string> = {
    DEPLOYMENT_NAME: "example",
    APP_HOSTNAME: "canvas.example.test",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "test-management-token",
    SESSION_SIGNING_KEY_CURRENT: "s".repeat(44),
    ORGANISATION_SIGNING_KEYS: JSON.stringify({
      school: {
        derivation_key: "d".repeat(44),
        current: { key_id: "v1", key: "k".repeat(44) },
        previous: [],
      },
    }),
    TURNSTILE_SITE_KEY: "configured-site-key",
    TURNSTILE_SECRET_KEY: "configured-secret-key",
    SESSION_SIGNING_KEY_PREVIOUS: "",
    WORKERS_CI: "",
    WORKERS_CI_BRANCH: "",
    R2_BUCKET_JURISDICTION: "default",
    ALLOWED_ORIGINS: "",
    WEBHOOK_ALLOWED_ORIGINS: "",
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  for (const key of [
    "TURNSTILE_ENABLED",
    "R2_BUCKET_NAME",
    "R2_ASSET_BUCKET_NAME",
    "CLOUDFLARE_WORKER_NAME",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => healthy()),
  );
  secretPath = "";
  mocks.run.mockImplementation((_command, args) => {
    if (args.includes("--secrets-file")) {
      secretPath = args[args.indexOf("--secrets-file") + 1] ?? "";
      expect(statSync(secretPath).mode & 0o777).toBe(0o600);
      const secrets = JSON.parse(readFileSync(secretPath, "utf8"));
      expect(Object.keys(secrets).sort()).toEqual([
        "ORGANISATION_SIGNING_KEYS",
        "SESSION_SIGNING_KEY_CURRENT",
        "TURNSTILE_SECRET_KEY",
      ]);
      expect(secrets.ORGANISATION_SIGNING_KEYS).toBe(process.env.ORGANISATION_SIGNING_KEYS);
      expect(args).not.toContain(process.env.SESSION_SIGNING_KEY_CURRENT);
    }
    return { status: 0 };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shared deployment", () => {
  it.each(["staging", "production"] as const)(
    "provisions %s before deploying secrets and attaching its domain",
    async (environment) => {
      await deploy(environment);
      expect(mocks.run.mock.calls.map(([, args]) => args)).toEqual([
        ["run", "deployment:init", "--", "--env", environment],
        ["run", "build:web"],
        [
          "--no-install",
          "wrangler",
          "deploy",
          "--config",
          `.generated/wrangler.${environment}.jsonc`,
          "--secrets-file",
          secretPath,
        ],
        ["run", "deployment:init", "--", "--env", environment, "--finalize"],
      ]);
      expect(existsSync(secretPath)).toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects missing runtime secrets before provisioning anything", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    await expect(deploy("production")).rejects.toThrow("TURNSTILE_SECRET_KEY");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each([
    ["too short", "short-previous-key"],
    ["a placeholder", "replace-with-a-previous-session-signing-key"],
  ])("rejects a previous session key that is %s before provisioning anything", async (_, key) => {
    vi.stubEnv("SESSION_SIGNING_KEY_PREVIOUS", key);
    await expect(deploy("production")).rejects.toThrow("SESSION_SIGNING_KEY_PREVIOUS");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("uploads a strong previous session key during a rotation", async () => {
    const previous = "p".repeat(44);
    vi.stubEnv("SESSION_SIGNING_KEY_PREVIOUS", previous);
    let uploaded: Record<string, string> = {};
    mocks.run.mockImplementation((_command, args) => {
      if (args.includes("--secrets-file")) {
        uploaded = JSON.parse(readFileSync(args[args.indexOf("--secrets-file") + 1] ?? "", "utf8"));
      }
      return { status: 0 };
    });
    await deploy("production");
    expect(uploaded.SESSION_SIGNING_KEY_PREVIOUS).toBe(previous);
  });

  it("rejects invalid organisation keys without creating resources or exposing their value", async () => {
    vi.stubEnv("ORGANISATION_SIGNING_KEYS", "private-invalid-value");
    await expect(deploy("staging")).rejects.not.toThrow("private-invalid-value");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects preview branches and cross-environment Workers Builds deployments", async () => {
    vi.stubEnv("WORKERS_CI", "1");
    for (const branch of ["feature/change", "staging", ""]) {
      vi.stubEnv("WORKERS_CI_BRANCH", branch);
      await expect(deploy("production")).rejects.toThrow("configured staging or main branch");
    }
    expect(mocks.run).not.toHaveBeenCalled();
    vi.stubEnv("WORKERS_CI_BRANCH", "main");
    await deploy("production");
  });

  it("removes the temporary secret file and leaves the domain untouched if deployment fails", async () => {
    mocks.run.mockImplementation((_command, args) => {
      if (args.includes("--secrets-file")) {
        secretPath = args[args.indexOf("--secrets-file") + 1] ?? "";
        expect(existsSync(secretPath)).toBe(true);
        return { status: 1 };
      }
      return { status: 0 };
    });
    await expect(deploy("production")).rejects.toThrow("deployment step failed");
    expect(existsSync(secretPath)).toBe(false);
    expect(mocks.run).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops when provisioning fails", async () => {
    mocks.run.mockReturnValue({ status: 1 });
    await expect(deploy("staging")).rejects.toThrow("deployment step failed");
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("fails after bounded health retries instead of reporting a broken deployment as healthy", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true, service: "wrong-service" }));
    await expect(deploy("production")).rejects.toThrow("health check failed");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(mocks.sleep).toHaveBeenCalledTimes(4);
  });
});

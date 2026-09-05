import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environment: "staging" as "development" | "staging" | "production",
  assetScenario: "existing" as "existing" | "missing" | "conflict",
  assetLookupCount: 0,
  wafScenario: "existing" as "existing" | "missing-ruleset" | "missing-rule" | "drifted",
  requiredFailure: false,
  requiredCalls: [] as string[][],
  requestPaths: [] as string[],
  requestCalls: [] as Array<{
    path: string;
    method: string;
    body: string | undefined;
  }>,
  output: [] as string[],
  loadedEnvFiles: [] as string[],
  assertPublicConfiguration: vi.fn(),
  assertTurnstileSiteKeyForEnvironment: vi.fn(),
  writeGeneratedWranglerConfig: vi.fn(
    (configuration: { environment: string }) =>
      `.generated/wrangler.${configuration.environment}.jsonc`,
  ),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));

function configuredValue(name: string): string {
  const staging = mocks.environment === "staging";
  const values: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
    SESSION_SIGNING_KEY_CURRENT: "s".repeat(32),
    ORGANISATION_SIGNING_KEYS: JSON.stringify({
      demo: {
        derivation_key: "d".repeat(32),
        current: { key_id: "v1", key: "c".repeat(32) },
        previous: [],
      },
    }),
    DEPLOYMENT_NAME: "example",
    APP_HOSTNAME: staging ? "staging.example.test" : "production.example.test",
    TURNSTILE_SITE_KEY: "real-turnstile-site-key",
    TURNSTILE_SECRET_KEY: "real-turnstile-secret-key",
  };
  const value = values[name];
  if (value === undefined) throw new Error(`No test value for ${name}`);
  return value;
}

vi.mock("./env.ts", () => ({
  assertPublicConfiguration: mocks.assertPublicConfiguration,
  assertTurnstileSiteKeyForEnvironment: mocks.assertTurnstileSiteKeyForEnvironment,
  loadLocalEnv: vi.fn((path = ".env") => {
    mocks.loadedEnvFiles.push(path);
  }),
  readLocalEnv: vi.fn(() => ({})),
  requireEnvironment: vi.fn((names: readonly string[]) => {
    mocks.requiredCalls.push([...names]);
    if (mocks.requiredFailure) throw new Error("Missing configured environment variables");
    return Object.fromEntries(names.map((name) => [name, configuredValue(name)]));
  }),
  publicApiFailure: vi.fn((label: string) => new Error(label)),
  cloudflareRequest: vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method?.toUpperCase() ?? "GET";
    mocks.requestPaths.push(path);
    mocks.requestCalls.push({
      path,
      method,
      body: init.body === undefined ? undefined : String(init.body),
    });
    const hostname = configuredValue("APP_HOSTNAME");
    const bucketName = `example-${mocks.environment}-snapshots`;
    const assetBucketName =
      mocks.environment === "staging" ? "example-staging-assets" : "example-production-assets";
    const account = "a".repeat(32);
    const bucketLookupPath = `/accounts/${account}/r2/buckets/${encodeURIComponent(bucketName)}`;
    const assetLookupPath = `/accounts/${account}/r2/buckets/${encodeURIComponent(assetBucketName)}`;
    const workerService = `example-${mocks.environment}`;
    const zoneId = "b".repeat(32);
    const rulesetId = "c".repeat(32);
    const wafRuleId = "d".repeat(32);
    const wafDescription = `SpaceScale: skip bot checks for authenticated ${mocks.environment} server APIs`;
    const expectedWafRule = {
      id: wafRuleId,
      action: "skip",
      action_parameters: { phases: ["http_request_sbfm"] },
      description: wafDescription,
      enabled: true,
      expression: `(http.host eq "${hostname}" and starts_with(http.request.uri.path, "/api/v1/organisations/"))`,
      logging: { enabled: true },
    };
    let result: unknown = {};
    let status = 200;
    let success = true;
    let errors: Array<{ code: number; message?: string }> | undefined;
    if (path.startsWith("/zones?")) {
      const requestedZone = new URL(`https://api.test${path}`).searchParams.get("name");
      result =
        requestedZone === "example.test"
          ? [{ id: zoneId, name: "example.test", status: "active" }]
          : [];
    } else if (
      path === `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`
    ) {
      if (mocks.wafScenario === "missing-ruleset") {
        status = 404;
        success = false;
        result = undefined;
        errors = [{ code: 10003, message: "entrypoint ruleset not found" }];
      } else {
        result = {
          id: rulesetId,
          phase: "http_request_firewall_custom",
          rules:
            mocks.wafScenario === "missing-rule"
              ? [{ id: "e".repeat(32), action: "block", description: "Existing rule" }]
              : [
                  mocks.wafScenario === "drifted"
                    ? {
                        ...expectedWafRule,
                        action_parameters: { phases: ["http_request_firewall_managed"] },
                      }
                    : expectedWafRule,
                ],
        };
      }
    } else if (method === "POST" && path === `/zones/${zoneId}/rulesets`) {
      result = {
        id: rulesetId,
        phase: "http_request_firewall_custom",
        rules: [expectedWafRule],
      };
    } else if (
      (method === "POST" || method === "PATCH") &&
      path.startsWith(`/zones/${zoneId}/rulesets/${rulesetId}/rules`)
    ) {
      result = {
        id: rulesetId,
        phase: "http_request_firewall_custom",
        rules: [expectedWafRule],
      };
    } else if (path.endsWith("/tokens/verify")) result = { status: "active" };
    else if (path.endsWith("/workers/scripts")) result = [];
    else if (path.includes("/workers/domains?")) {
      result = [{ hostname, service: workerService, cert_id: "certificate" }];
    } else if (method === "PUT" && path.endsWith("/workers/domains")) {
      result = { hostname, service: workerService, cert_id: "certificate" };
    } else if (path.endsWith("/r2/buckets?per_page=1000")) {
      result = {
        buckets: [bucketName, assetBucketName].map((name) => ({ name, jurisdiction: "default" })),
      };
    } else if (path.endsWith("/domains/managed")) result = { enabled: false };
    else if (path.endsWith("/domains/custom")) result = { domains: [] };
    else if (path.includes("/challenges/widgets/")) {
      result = {
        sitekey: configuredValue("TURNSTILE_SITE_KEY"),
        secret: configuredValue("TURNSTILE_SECRET_KEY"),
        domains: [hostname],
      };
    } else if (method === "POST" && path.endsWith("/r2/buckets")) {
      const body = JSON.parse(String(init.body)) as { name: string };
      if (mocks.assetScenario === "conflict" && body.name === assetBucketName) {
        status = 409;
        success = false;
        result = undefined;
      } else {
        result = { name: body.name, jurisdiction: "default" };
      }
    } else if (path === assetLookupPath) {
      mocks.assetLookupCount += 1;
      if (
        mocks.assetScenario === "missing" ||
        (mocks.assetScenario === "conflict" && mocks.assetLookupCount === 1)
      ) {
        status = 404;
        success = false;
        result = undefined;
      } else {
        result = { name: assetBucketName, jurisdiction: "default" };
      }
    } else if (path === bucketLookupPath) {
      result = { name: bucketName, jurisdiction: "default" };
    }
    return {
      response: new Response(null, { status }),
      envelope: { success, result, errors },
    };
  }),
}));

vi.mock("./deployment-config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./deployment-config.ts")>()),
  deploymentConfigurationFromEnvironment: vi.fn(
    (environment: "development" | "staging" | "production") => {
      mocks.environment = environment === "development" ? "staging" : environment;
      const staging = mocks.environment === "staging";
      return {
        environment,
        workerName: `example-${environment}`,
        bucketName: `example-${environment}-snapshots`,
        assetBucketName: staging ? "example-staging-assets" : "example-production-assets",
        jurisdiction: "default",
        hostname: configuredValue("APP_HOSTNAME"),
        turnstileEnabled: !staging,
        boardCreationEnabled: true,
        allowedOrigins: "*",
        webhookAllowedOrigins: "",
        ...(!staging ? { turnstileSiteKey: "real-turnstile-site-key" } : {}),
      };
    },
  ),
  parseDeploymentEnvironment: vi.fn(() => mocks.environment),
  writeGeneratedWranglerConfig: mocks.writeGeneratedWranglerConfig,
}));

const originalArgv = [...process.argv];
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  mocks.environment = "staging";
  mocks.assetScenario = "existing";
  mocks.assetLookupCount = 0;
  mocks.wafScenario = "existing";
  mocks.requiredFailure = false;
  mocks.requiredCalls.length = 0;
  mocks.requestPaths.length = 0;
  mocks.requestCalls.length = 0;
  mocks.output.length = 0;
  mocks.loadedEnvFiles.length = 0;
  mocks.assertPublicConfiguration.mockReset();
  mocks.assertTurnstileSiteKeyForEnvironment.mockReset();
  mocks.writeGeneratedWranglerConfig.mockClear();
  mocks.spawnSync.mockReset();
  mocks.spawnSync.mockReturnValue({ status: 0 });
  process.exitCode = 0;
  process.env.ALLOWED_ORIGINS = "*";
  delete process.env.DEPLOYMENT_NAME;
  delete process.env.APP_HOSTNAME;
  delete process.env.BOARD_CREATION_ENABLED;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    mocks.output.push(String(chunk));
    return true;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.exitCode = originalExitCode;
  delete process.env.DEPLOYMENT_ENVIRONMENT;
  delete process.env.ALLOWED_ORIGINS;
  delete process.env.DEPLOYMENT_NAME;
  delete process.env.APP_HOSTNAME;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.sequential("Cloudflare command Turnstile configuration", () => {
  it("initializes development locally without Cloudflare credentials", async () => {
    mocks.environment = "development";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "development"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toHaveLength(0);
    expect(mocks.requestPaths).toHaveLength(0);
    expect(JSON.parse(mocks.output.at(-1) ?? "{}")).toMatchObject({
      environment: "development",
      resources: { mode: "local", created: false },
    });
  });

  it("stops before configuration or API mutation when credentials are missing", async () => {
    mocks.requiredFailure = true;
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await expect(import("./bootstrap-cloudflare.ts")).rejects.toThrow(
      "Missing configured environment variables",
    );

    expect(mocks.writeGeneratedWranglerConfig).not.toHaveBeenCalled();
    expect(mocks.requestPaths).toHaveLength(0);
  });

  it("bootstraps staging without requiring a Turnstile site key", async () => {
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toEqual([["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]]);
    expect(mocks.assertTurnstileSiteKeyForEnvironment).not.toHaveBeenCalled();
    expect(mocks.requestPaths.some((path) => path.includes("/challenges/"))).toBe(false);
    expect(mocks.requestPaths.some((path) => path.includes("example-staging-assets"))).toBe(true);
  });

  it("creates the zone custom-rules entrypoint when it is absent", async () => {
    mocks.wafScenario = "missing-ruleset";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    const creation = mocks.requestCalls.find(
      (call) => call.method === "POST" && call.path === `/zones/${"b".repeat(32)}/rulesets`,
    );
    expect(JSON.parse(creation?.body ?? "{}")).toMatchObject({
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [
        {
          action: "skip",
          action_parameters: { phases: ["http_request_sbfm"] },
          enabled: true,
          expression:
            '(http.host eq "staging.example.test" and starts_with(http.request.uri.path, "/api/v1/organisations/"))',
        },
      ],
    });
    expect(JSON.parse(mocks.output.at(-1) ?? "{}").serverApiBotBypass).toMatchObject({
      applicable: true,
      created: true,
      updated: false,
    });
  });

  it("adds a missing bot-bypass rule without replacing the ruleset", async () => {
    mocks.wafScenario = "missing-rule";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    const creation = mocks.requestCalls.find(
      (call) =>
        call.method === "POST" &&
        call.path === `/zones/${"b".repeat(32)}/rulesets/${"c".repeat(32)}/rules`,
    );
    expect(JSON.parse(creation?.body ?? "{}")).toMatchObject({
      position: { before: "e".repeat(32) },
    });
    expect(JSON.parse(mocks.output.at(-1) ?? "{}").serverApiBotBypass).toMatchObject({
      created: true,
      updated: false,
    });
  });

  it("repairs a drifted bot-bypass rule in place", async () => {
    mocks.wafScenario = "drifted";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    const update = mocks.requestCalls.find((call) => call.method === "PATCH");
    expect(update?.path).toBe(
      `/zones/${"b".repeat(32)}/rulesets/${"c".repeat(32)}/rules/${"d".repeat(32)}`,
    );
    expect(JSON.parse(update?.body ?? "{}")).toMatchObject({
      action: "skip",
      action_parameters: { phases: ["http_request_sbfm"] },
      enabled: true,
    });
    expect(JSON.parse(mocks.output.at(-1) ?? "{}").serverApiBotBypass).toMatchObject({
      created: false,
      updated: true,
    });
  });

  it("validates production public configuration before provisioning", async () => {
    mocks.environment = "production";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "production"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toEqual([["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]]);
    expect(mocks.assertTurnstileSiteKeyForEnvironment).toHaveBeenCalledWith(
      "real-turnstile-site-key",
      "production",
    );
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("requires production public configuration only when deployment is requested", async () => {
    mocks.environment = "production";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "production", "--deploy"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requiredCalls).toEqual([["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]]);
    expect(mocks.assertTurnstileSiteKeyForEnvironment).toHaveBeenCalledWith(
      "real-turnstile-site-key",
      "production",
    );
    expect(mocks.spawnSync).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.output.at(-1) ?? "{}")).toMatchObject({
      deployment: "complete",
      customDomain: {
        applicable: true,
        created: false,
        updated: false,
        certificateAssigned: true,
      },
    });
  });

  it("does not mutate existing private buckets on a provisioning rerun", async () => {
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requestCalls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(JSON.parse(mocks.output.at(-1) ?? "{}")).toMatchObject({
      resources: { snapshotBucketCreated: false, assetBucketCreated: false },
    });
  });

  it("creates only the missing private asset bucket", async () => {
    mocks.assetScenario = "missing";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    const postCalls = mocks.requestCalls.filter((call) => call.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(JSON.parse(postCalls[0]?.body ?? "{}")).toEqual({
      name: "example-staging-assets",
    });
    expect(JSON.parse(mocks.output.at(-1) ?? "{}")).toMatchObject({
      resources: { snapshotBucketCreated: false, assetBucketCreated: true },
    });
  });

  it("re-reads and verifies an exact bucket after a first-create conflict", async () => {
    mocks.assetScenario = "conflict";
    process.argv = ["node", "bootstrap-cloudflare.ts", "--env", "staging"];

    await import("./bootstrap-cloudflare.ts");

    expect(mocks.requestCalls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(mocks.assetLookupCount).toBe(2);
    expect(JSON.parse(mocks.output.at(-1) ?? "{}")).toMatchObject({
      resources: { snapshotBucketCreated: false, assetBucketCreated: false },
    });
  });

  it("checks staging access without requiring or probing Turnstile credentials", async () => {
    await import("./check-cloudflare-access.ts");

    expect(mocks.requiredCalls).toHaveLength(1);
    expect(mocks.requiredCalls[0]).not.toContain("TURNSTILE_SITE_KEY");
    expect(mocks.requiredCalls[0]).not.toContain("TURNSTILE_SECRET_KEY");
    expect(mocks.assertTurnstileSiteKeyForEnvironment).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.requestPaths.some((path) => path.includes("/challenges/widgets/"))).toBe(false);
    expect(mocks.output.join("")).toContain(
      JSON.stringify({ check: "turnstile", enabled: false, skipped: true }),
    );
    expect(mocks.output.join("")).toContain('"configuredAssetBucketExists":true');
  });

  it("loads the resolved environment file before .env when --env is omitted", async () => {
    process.env.DEPLOYMENT_ENVIRONMENT = "staging";
    process.argv = ["node", "check-cloudflare-access.ts"];

    await import("./check-cloudflare-access.ts");

    expect(mocks.loadedEnvFiles).toEqual([".env.staging", ".env"]);
  });

  it("loads the requested environment file before .env", async () => {
    mocks.environment = "production";
    process.argv = ["node", "check-cloudflare-access.ts", "--env", "production"];

    await import("./check-cloudflare-access.ts");

    expect(mocks.loadedEnvFiles).toEqual([".env.production", ".env"]);
  });

  it("validates the account identifier and session key with the public configuration", async () => {
    await import("./check-cloudflare-access.ts");

    expect(mocks.assertPublicConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        SESSION_SIGNING_KEY_CURRENT: "s".repeat(32),
        ALLOWED_ORIGINS: "*",
        APP_HOSTNAME: "staging.example.test",
      }),
    );
  });

  it("keeps production access checks strict and probes both Turnstile credentials", async () => {
    mocks.environment = "production";

    await import("./check-cloudflare-access.ts");

    expect(mocks.requiredCalls).toHaveLength(2);
    expect(mocks.requiredCalls[1]).toEqual(["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"]);
    expect(mocks.assertTurnstileSiteKeyForEnvironment).toHaveBeenCalledWith(
      "real-turnstile-site-key",
      "production",
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.requestPaths.some((path) => path.includes("/challenges/widgets/"))).toBe(true);
    expect(process.exitCode).toBe(0);
  });
});

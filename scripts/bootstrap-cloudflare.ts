import { spawnSync } from "node:child_process";
import {
  deploymentConfigurationFromEnvironment,
  type DeploymentConfiguration as EnvironmentConfiguration,
  type DeploymentEnvironment as EnvironmentName,
  parseDeploymentEnvironment,
  writeGeneratedWranglerConfig,
} from "./deployment-config.ts";
import {
  assertPublicConfiguration,
  assertTurnstileSiteKeyForEnvironment,
  cloudflareRequest,
  loadLocalEnv,
  publicApiFailure,
  requireEnvironment,
} from "./env.ts";

type Bucket = {
  name: string;
  jurisdiction?: string;
  creation_date?: string;
  location?: string;
  storage_class?: string;
};
type Zone = { id: string; name: string; status?: string };
type WafRule = {
  id?: string;
  action?: string;
  action_parameters?: { phases?: string[] };
  description?: string;
  enabled?: boolean;
  expression?: string;
  logging?: { enabled?: boolean };
};
type WafRuleset = {
  id: string;
  name?: string;
  phase?: string;
  rules?: WafRule[];
};
type WafProvisioning = {
  applicable: boolean;
  created: boolean;
  updated: boolean;
};
type WorkerDomain = {
  hostname?: string;
  service?: string;
  cert_id?: string;
};
type CustomDomainProvisioning = {
  applicable: boolean;
  created: boolean;
  updated: boolean;
  certificateAssigned: boolean | null;
};

const SERVER_API_PREFIX = "/api/v1/organisations/";
const BOT_PHASE = "http_request_sbfm";

function jurisdictionHeaders(
  configuration: EnvironmentConfiguration,
): Record<string, string> | undefined {
  return configuration.jurisdiction === "default"
    ? undefined
    : { "cf-r2-jurisdiction": configuration.jurisdiction };
}

function parseArguments(args: string[]): {
  environment: EnvironmentName;
  deploy: boolean;
  finalize: boolean;
} {
  let environment: EnvironmentName | undefined;
  let deploy = false;
  let finalize = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--env") {
      try {
        environment = parseDeploymentEnvironment(args[index + 1]);
      } catch {
        throw new Error("--env must be development, staging, or production.");
      }
      index += 1;
      continue;
    }
    if (value === "--deploy") {
      deploy = true;
      continue;
    }
    if (value === "--finalize") {
      finalize = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!environment)
    throw new Error("Usage: npm run deployment:init -- --env <environment> [--deploy|--finalize]");
  if (deploy && finalize) throw new Error("Use only one of --deploy or --finalize.");
  return { environment, deploy, finalize };
}

async function getBucket(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<Bucket | undefined> {
  const result = await cloudflareRequest<Bucket>(
    `/accounts/${account}/r2/buckets/${encodeURIComponent(configuration.bucketName)}`,
    { headers: jurisdictionHeaders(configuration) },
  );
  if (result.response.status === 404) return undefined;
  if (!result.response.ok || !result.envelope.success || !result.envelope.result) {
    throw publicApiFailure("R2 bucket lookup", result.response, result.envelope);
  }
  return result.envelope.result;
}

async function createBucket(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<Bucket | undefined> {
  const result = await cloudflareRequest<Bucket>(`/accounts/${account}/r2/buckets`, {
    method: "POST",
    headers: jurisdictionHeaders(configuration),
    body: JSON.stringify({ name: configuration.bucketName }),
  });
  // A concurrent first deployment may create this exact bucket between our
  // lookup and create calls. The caller re-reads and fully verifies it.
  if (result.response.status === 409) return undefined;
  if (!result.response.ok || !result.envelope.success || !result.envelope.result) {
    throw publicApiFailure("R2 bucket creation", result.response, result.envelope);
  }
  return result.envelope.result;
}

function verifyBucket(bucket: Bucket, configuration: EnvironmentConfiguration): void {
  if (bucket.name !== configuration.bucketName) {
    throw new Error("Cloudflare returned a bucket with an unexpected name.");
  }
  const actualJurisdiction = bucket.jurisdiction ?? "default";
  if (actualJurisdiction !== configuration.jurisdiction) {
    throw new Error("Existing bucket jurisdiction does not match deployment configuration.");
  }
}

async function assertBucketPrivate(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<void> {
  const name = encodeURIComponent(configuration.bucketName);
  const headers = jurisdictionHeaders(configuration);
  const managed = await cloudflareRequest<{ enabled?: boolean }>(
    `/accounts/${account}/r2/buckets/${name}/domains/managed`,
    { headers },
  );
  if (managed.response.status !== 404 && !managed.envelope.success) {
    throw publicApiFailure("R2 managed-domain check", managed.response, managed.envelope);
  }
  if (managed.envelope.result?.enabled === true) {
    throw new Error(
      "The R2 bucket has a public r2.dev managed domain; disable it before deployment.",
    );
  }
  const custom = await cloudflareRequest<{ domains?: unknown[] }>(
    `/accounts/${account}/r2/buckets/${name}/domains/custom`,
    { headers },
  );
  if (custom.response.status !== 404 && !custom.envelope.success) {
    throw publicApiFailure("R2 custom-domain check", custom.response, custom.envelope);
  }
  if ((custom.envelope.result?.domains?.length ?? 0) > 0) {
    throw new Error("The R2 bucket has a public custom domain; remove it before deployment.");
  }
}

async function provisionPrivateBucket(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<boolean> {
  let bucket = await getBucket(account, configuration);
  let created = false;
  if (!bucket) {
    const createdBucket = await createBucket(account, configuration);
    if (createdBucket) {
      bucket = createdBucket;
      created = true;
    } else {
      bucket = await getBucket(account, configuration);
    }
  }
  if (!bucket) {
    throw new Error("R2 bucket creation conflicted, but the exact bucket could not be verified.");
  }
  verifyBucket(bucket, configuration);
  await assertBucketPrivate(account, configuration);
  return created;
}

function zoneCandidates(hostname: string): string[] {
  const labels = hostname.split(".");
  return labels.slice(0, -1).map((_, index) => labels.slice(index).join("."));
}

async function findOwningZone(hostname: string): Promise<Zone> {
  for (const candidate of zoneCandidates(hostname)) {
    const lookup = await cloudflareRequest<Zone[]>(
      `/zones?name=${encodeURIComponent(candidate)}&status=active&per_page=50`,
    );
    if (!lookup.response.ok || !lookup.envelope.success || !lookup.envelope.result) {
      throw publicApiFailure("Cloudflare zone lookup", lookup.response, lookup.envelope);
    }
    const exact = lookup.envelope.result.find(
      (zone) => zone.name === candidate && zone.status === "active",
    );
    if (exact) return exact;
  }
  throw new Error("No active Cloudflare zone is accessible for the configured hostname.");
}

function desiredBotBypassRule(environment: EnvironmentName, hostname: string): WafRule {
  return {
    action: "skip",
    action_parameters: { phases: [BOT_PHASE] },
    description: `SpaceScale: skip bot checks for authenticated ${environment} server APIs`,
    enabled: true,
    expression: `(http.host eq "${hostname}" and starts_with(http.request.uri.path, "${SERVER_API_PREFIX}"))`,
    logging: { enabled: true },
  };
}

function botBypassRuleMatches(actual: WafRule, expected: WafRule): boolean {
  return (
    actual.action === expected.action &&
    actual.description === expected.description &&
    actual.enabled === true &&
    actual.expression === expected.expression &&
    actual.logging?.enabled === true &&
    actual.action_parameters?.phases?.length === 1 &&
    actual.action_parameters.phases[0] === BOT_PHASE
  );
}

function verifiedRule(ruleset: WafRuleset, expected: WafRule): WafRule {
  const rule = ruleset.rules?.find((candidate) => candidate.description === expected.description);
  if (!rule?.id || !botBypassRuleMatches(rule, expected)) {
    throw new Error("Cloudflare did not return the expected server API bot-bypass rule.");
  }
  return rule;
}

async function provisionServerApiBotBypass(
  environment: EnvironmentName,
  hostname: string,
): Promise<WafProvisioning> {
  if (hostname === "localhost" || hostname.endsWith(".workers.dev")) {
    return {
      applicable: false,
      created: false,
      updated: false,
    };
  }

  const zone = await findOwningZone(hostname);
  if (!/^[a-f\d]{32}$/iu.test(zone.id)) {
    throw new Error("Cloudflare returned an invalid zone identifier.");
  }
  const zoneId = encodeURIComponent(zone.id);
  const entrypointPath = `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const entrypoint = await cloudflareRequest<WafRuleset>(entrypointPath);
  const expected = desiredBotBypassRule(environment, hostname);
  const noEntrypoint =
    entrypoint.response.status === 404 &&
    entrypoint.envelope.errors?.some((error) => error.code === 10003) === true;

  if (noEntrypoint) {
    const created = await cloudflareRequest<WafRuleset>(`/zones/${zoneId}/rulesets`, {
      method: "POST",
      body: JSON.stringify({
        name: "SpaceScale zone custom rules",
        description: "SpaceScale zone-level custom firewall rules",
        kind: "zone",
        phase: "http_request_firewall_custom",
        rules: [expected],
      }),
    });
    if (!created.response.ok || !created.envelope.success || !created.envelope.result) {
      throw publicApiFailure("WAF ruleset creation", created.response, created.envelope);
    }
    verifiedRule(created.envelope.result, expected);
    return {
      applicable: true,
      created: true,
      updated: false,
    };
  }

  if (!entrypoint.response.ok || !entrypoint.envelope.success || !entrypoint.envelope.result) {
    throw publicApiFailure("WAF ruleset lookup", entrypoint.response, entrypoint.envelope);
  }
  const ruleset = entrypoint.envelope.result;
  const rules = ruleset.rules ?? [];
  const existingIndex = rules.findIndex((rule) => rule.description === expected.description);
  const existing = existingIndex >= 0 ? rules[existingIndex] : undefined;
  const firstRule = rules[0];
  if (existing && existingIndex === 0 && botBypassRuleMatches(existing, expected)) {
    return {
      applicable: true,
      created: false,
      updated: false,
    };
  }

  const position = existingIndex !== 0 && firstRule?.id ? { before: firstRule.id } : undefined;
  const mutationPath = existing?.id
    ? `/zones/${zoneId}/rulesets/${encodeURIComponent(ruleset.id)}/rules/${encodeURIComponent(existing.id)}`
    : `/zones/${zoneId}/rulesets/${encodeURIComponent(ruleset.id)}/rules`;
  const mutation = await cloudflareRequest<WafRuleset>(mutationPath, {
    method: existing ? "PATCH" : "POST",
    body: JSON.stringify({ ...expected, ...(position ? { position } : {}) }),
  });
  if (!mutation.response.ok || !mutation.envelope.success || !mutation.envelope.result) {
    throw publicApiFailure(
      existing ? "WAF rule update" : "WAF rule creation",
      mutation.response,
      mutation.envelope,
    );
  }
  verifiedRule(mutation.envelope.result, expected);
  return {
    applicable: true,
    created: !existing,
    updated: Boolean(existing),
  };
}

async function provisionWorkerCustomDomain(
  account: string,
  configuration: EnvironmentConfiguration,
): Promise<CustomDomainProvisioning> {
  if (configuration.hostname === "localhost" || configuration.hostname.endsWith(".workers.dev")) {
    return {
      applicable: false,
      created: false,
      updated: false,
      certificateAssigned: null,
    };
  }

  const lookup = await cloudflareRequest<WorkerDomain[]>(
    `/accounts/${account}/workers/domains?hostname=${encodeURIComponent(configuration.hostname)}`,
  );
  if (!lookup.response.ok || !lookup.envelope.success || !lookup.envelope.result) {
    throw publicApiFailure("Worker Custom Domain lookup", lookup.response, lookup.envelope);
  }
  const existing = lookup.envelope.result.find(
    (domain) => domain.hostname === configuration.hostname,
  );
  if (existing?.service === configuration.workerName) {
    return {
      applicable: true,
      created: false,
      updated: false,
      certificateAssigned: Boolean(existing.cert_id),
    };
  }

  const attached = await cloudflareRequest<WorkerDomain>(`/accounts/${account}/workers/domains`, {
    method: "PUT",
    body: JSON.stringify({
      hostname: configuration.hostname,
      service: configuration.workerName,
    }),
  });
  if (!attached.response.ok || !attached.envelope.success || !attached.envelope.result) {
    throw publicApiFailure("Worker Custom Domain attachment", attached.response, attached.envelope);
  }
  if (
    attached.envelope.result.hostname !== configuration.hostname ||
    attached.envelope.result.service !== configuration.workerName
  ) {
    throw new Error("Cloudflare returned an unexpected Worker Custom Domain mapping.");
  }
  return {
    applicable: true,
    created: existing === undefined,
    updated: existing !== undefined,
    certificateAssigned: Boolean(attached.envelope.result.cert_id),
  };
}

async function initializeDeployment(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  loadLocalEnv(`.env.${args.environment}`);
  loadLocalEnv();
  const configuration = deploymentConfigurationFromEnvironment(args.environment, process.env);

  if (args.environment === "development") {
    if (args.deploy || args.finalize) {
      throw new Error("Development initialization is local-only; run `npm run dev` to start it.");
    }
    const configPath = writeGeneratedWranglerConfig(configuration);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        environment: args.environment,
        configPath,
        resources: { mode: "local", created: false },
        deployment: "not_applicable",
      })}\n`,
    );
    return;
  }

  // Validate every required local detail before writing the mapping or making
  // the first Cloudflare API request.
  const env = requireEnvironment(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const);
  assertPublicConfiguration({
    ...env,
    ALLOWED_ORIGINS: configuration.allowedOrigins,
    APP_HOSTNAME: configuration.hostname,
  });
  if (configuration.turnstileEnabled) {
    assertTurnstileSiteKeyForEnvironment(configuration.turnstileSiteKey ?? "", args.environment);
  }

  const generatedConfigPath = writeGeneratedWranglerConfig(configuration);
  const account = encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID ?? "");
  const tokenCheck = await cloudflareRequest<{ status?: string }>(
    `/accounts/${account}/tokens/verify`,
  );
  if (!tokenCheck.envelope.success || tokenCheck.envelope.result?.status !== "active") {
    throw publicApiFailure(
      "Cloudflare account token verification",
      tokenCheck.response,
      tokenCheck.envelope,
    );
  }

  if (args.finalize) {
    const customDomain = await provisionWorkerCustomDomain(account, configuration);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        environment: args.environment,
        configPath: generatedConfigPath,
        customDomain,
        deployment: "finalized",
      })}\n`,
    );
    return;
  }

  const created = await provisionPrivateBucket(account, configuration);
  const assetBucketConfiguration: EnvironmentConfiguration = {
    ...configuration,
    bucketName: configuration.assetBucketName,
  };
  const assetCreated = await provisionPrivateBucket(account, assetBucketConfiguration);
  const serverApiBotBypass = await provisionServerApiBotBypass(
    args.environment,
    configuration.hostname,
  );

  let customDomain: CustomDomainProvisioning | null = null;
  if (args.deploy) {
    const wranglerArguments = ["wrangler", "deploy", "--config", generatedConfigPath];
    const deployment = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      wranglerArguments,
      { stdio: "inherit", env: process.env },
    );
    if (deployment.error) throw deployment.error;
    if (deployment.status !== 0) throw new Error("Worker deployment failed.");
    customDomain = await provisionWorkerCustomDomain(account, configuration);
  }

  const result = {
    ok: true,
    environment: args.environment,
    configPath: generatedConfigPath,
    resources: {
      snapshotBucketCreated: created,
      assetBucketCreated: assetCreated,
      private: true,
    },
    serverApiBotBypass,
    customDomain,
    deployment: args.deploy ? "complete" : "not_requested",
    nextCommand: args.deploy
      ? null
      : `npm run deployment:init -- --env ${args.environment} --deploy`,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await initializeDeployment();

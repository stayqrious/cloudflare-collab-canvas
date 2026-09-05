import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type DeploymentEnvironment = "development" | "staging" | "production";

export type DeploymentConfiguration = {
  environment: DeploymentEnvironment;
  workerName: string;
  bucketName: string;
  assetBucketName: string;
  jurisdiction: "default" | "eu" | "fedramp";
  hostname: string;
  turnstileEnabled: boolean;
  boardCreationEnabled: boolean;
  allowedOrigins: string;
  webhookAllowedOrigins: string;
  turnstileSiteKey?: string;
};

export class DeploymentConfigurationError extends Error {
  constructor(fields: string[] = []) {
    const detail = fields.length > 0 ? ` Check: ${fields.join(", ")}.` : "";
    super(
      `Deployment initialization is incomplete or invalid.${detail} Copy .env.sample to .env, replace every required placeholder, and run \`npm run deployment:init -- --env <environment>\`.`,
    );
    this.name = "DeploymentConfigurationError";
  }
}

export const PLACEHOLDER_PREFIX = "replace-with-";
const GENERATED_DIRECTORY = ".generated";
const DEPLOYMENT_ENVIRONMENTS: readonly DeploymentEnvironment[] = [
  "development",
  "staging",
  "production",
];

// Non-deployable values used only to verify a production build on a checkout
// without deployment details (`npm run build`). The hostname deliberately maps
// to workers.dev so the dry-run config never references a custom domain.
const DRY_RUN_VALUES = {
  DEPLOYMENT_NAME: "dry-run",
  APP_HOSTNAME: "dry-run.workers.dev",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
} as const;

export function generatedWranglerConfigPath(environment: DeploymentEnvironment): string {
  return `${GENERATED_DIRECTORY}/wrangler.${environment}.jsonc`;
}

export function parseDeploymentEnvironment(value: string | undefined): DeploymentEnvironment {
  const environment = DEPLOYMENT_ENVIRONMENTS.find((candidate) => candidate === value);
  if (environment) return environment;
  throw new DeploymentConfigurationError();
}

/** Returns the raw `--env` value, if present, without validating the other arguments. */
export function requestedEnvironment(args: string[]): string | undefined {
  const index = args.indexOf("--env");
  return index < 0 ? undefined : args[index + 1];
}

/**
 * Strict argument parsing for commands that accept only `--env <environment>`
 * plus the listed boolean flags. Any other argument fails closed.
 */
export function parseEnvironmentArguments<Flag extends string>(
  args: string[],
  flags: readonly Flag[] = [],
): { environment: DeploymentEnvironment; flags: Record<Flag, boolean> } {
  const parsedFlags = Object.fromEntries(flags.map((flag) => [flag, false])) as Record<
    Flag,
    boolean
  >;
  const environmentIndex = args.indexOf("--env");
  const remaining = args.filter(
    (_, index) => index !== environmentIndex && index !== environmentIndex + 1,
  );
  for (const value of remaining) {
    if (!flags.includes(value as Flag)) throw new DeploymentConfigurationError();
    parsedFlags[value as Flag] = true;
  }
  return {
    environment: parseDeploymentEnvironment(requestedEnvironment(args)),
    flags: parsedFlags,
  };
}

/** True when a value is present and is not a `.env.sample` placeholder. */
export function isConfiguredValue(value: string | undefined): boolean {
  return optionalValue(value) !== undefined;
}

/**
 * Fills unconfigured deployment details with non-deployable dry-run values so a
 * production build can be verified without `.env` files. Configured values are
 * always kept, so a real checkout still builds against its own mapping.
 */
export function dryRunDeploymentValues(
  environment: DeploymentEnvironment,
  values: NodeJS.ProcessEnv,
): { values: NodeJS.ProcessEnv; placeholders: string[] } {
  if (environment === "development") return { values, placeholders: [] };
  const turnstileEnabled = booleanValue(values.TURNSTILE_ENABLED, environment === "production");
  const placeholders = (Object.keys(DRY_RUN_VALUES) as Array<keyof typeof DRY_RUN_VALUES>).filter(
    (name) =>
      !isConfiguredValue(values[name]) && (name !== "TURNSTILE_SITE_KEY" || turnstileEnabled),
  );
  return {
    values: {
      ...values,
      ...Object.fromEntries(placeholders.map((name) => [name, DRY_RUN_VALUES[name]])),
    },
    placeholders,
  };
}

export function deploymentConfigurationFromEnvironment(
  environment: DeploymentEnvironment,
  values: NodeJS.ProcessEnv,
): DeploymentConfiguration {
  if (environment === "development") return localDevelopmentConfiguration(values);

  const deploymentName = optionalValue(values.DEPLOYMENT_NAME);
  const configuredHostname = optionalValue(values.APP_HOSTNAME);
  const legacyMappings = [
    "R2_BUCKET_NAME",
    "R2_ASSET_BUCKET_NAME",
    "CLOUDFLARE_WORKER_NAME",
  ].filter((name) => optionalValue(values[name]) !== undefined);
  const requiredDetails = [
    ...(deploymentName ? [] : ["DEPLOYMENT_NAME"]),
    ...(configuredHostname ? [] : ["APP_HOSTNAME"]),
    ...legacyMappings,
  ];
  if (!deploymentName || !configuredHostname || legacyMappings.length > 0) {
    throw new DeploymentConfigurationError(requiredDetails);
  }

  const hostname = normalizeHostname(configuredHostname);
  const resourceNames = derivedResourceNames(deploymentName, environment);
  const jurisdiction = optionalValue(values.R2_BUCKET_JURISDICTION) ?? "default";
  const turnstileEnabled = booleanValue(values.TURNSTILE_ENABLED, environment === "production");
  const boardCreationEnabled = booleanValue(values.BOARD_CREATION_ENABLED, true);

  if (
    !validDeploymentName(deploymentName) ||
    !validHostname(hostname) ||
    (jurisdiction !== "default" && jurisdiction !== "eu" && jurisdiction !== "fedramp")
  ) {
    throw new DeploymentConfigurationError([
      "DEPLOYMENT_NAME",
      "APP_HOSTNAME",
      "R2_BUCKET_JURISDICTION",
    ]);
  }

  const turnstileSiteKey = optionalValue(values.TURNSTILE_SITE_KEY);
  if (turnstileEnabled && !turnstileSiteKey) {
    throw new DeploymentConfigurationError(["TURNSTILE_SITE_KEY"]);
  }

  return {
    environment,
    ...resourceNames,
    jurisdiction,
    hostname,
    turnstileEnabled,
    boardCreationEnabled,
    allowedOrigins: values.ALLOWED_ORIGINS?.trim() ?? "",
    webhookAllowedOrigins: values.WEBHOOK_ALLOWED_ORIGINS?.trim() ?? "",
    ...(turnstileSiteKey ? { turnstileSiteKey } : {}),
  };
}

export function writeGeneratedWranglerConfig(configuration: DeploymentConfiguration): string {
  const path = generatedWranglerConfigPath(configuration.environment);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(wranglerConfiguration(configuration), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

function wranglerConfiguration(configuration: DeploymentConfiguration): Record<string, unknown> {
  const local = configuration.environment === "development";
  const workersDev = local || configuration.hostname.endsWith(".workers.dev");
  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: configuration.workerName,
    main: "../apps/edge/src/gateway.ts",
    compatibility_date: "2026-08-04",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: workersDev,
    ...(local || workersDev ? { routes: [] } : {}),
    assets: {
      directory: "../apps/web/dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    },
    durable_objects: {
      bindings: [
        { name: "BOARD_ROOMS", class_name: "BoardRoom" },
        { name: "ORGANISATION_ROOMS", class_name: "OrganisationRoom" },
      ],
    },
    exports: {
      BoardRoom: { type: "durable-object", storage: "sqlite" },
      OrganisationRoom: { type: "durable-object", storage: "sqlite" },
    },
    r2_buckets: [
      { binding: "BOARD_SNAPSHOTS", bucket_name: configuration.bucketName },
      { binding: "BOARD_ASSETS", bucket_name: configuration.assetBucketName },
    ],
    vars: {
      APP_HOSTNAME: configuration.hostname,
      BOARD_CREATION_ENABLED: String(configuration.boardCreationEnabled),
      ALLOWED_ORIGINS: configuration.allowedOrigins,
      WEBHOOK_ALLOWED_ORIGINS: configuration.webhookAllowedOrigins,
      TURNSTILE_ENABLED: String(configuration.turnstileEnabled),
      ENVIRONMENT: configuration.environment,
      ...(configuration.turnstileSiteKey
        ? { TURNSTILE_SITE_KEY: configuration.turnstileSiteKey }
        : {}),
    },
    observability: { enabled: true, head_sampling_rate: 1 },
    version_metadata: { binding: "WORKER_VERSION" },
  };
}

function localDevelopmentConfiguration(values: NodeJS.ProcessEnv): DeploymentConfiguration {
  const deploymentName = optionalValue(values.DEPLOYMENT_NAME) ?? "spacescale";
  if (!validDeploymentName(deploymentName)) {
    throw new DeploymentConfigurationError(["DEPLOYMENT_NAME"]);
  }
  return {
    environment: "development",
    ...derivedResourceNames(deploymentName, "development"),
    jurisdiction: "default",
    hostname: "localhost",
    turnstileEnabled: false,
    boardCreationEnabled: true,
    allowedOrigins:
      "http://localhost,http://localhost:4173,http://localhost:5173,https://127.0.0.1:8787",
    webhookAllowedOrigins: "",
    turnstileSiteKey: "1x00000000000000000000AA",
  };
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.startsWith(PLACEHOLDER_PREFIX)) return undefined;
  return normalized;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  const normalized = optionalValue(value);
  if (normalized === undefined) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new DeploymentConfigurationError();
}

function normalizeHostname(value: string): string {
  if (!value.startsWith("https://")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DeploymentConfigurationError();
  }
  if (url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new DeploymentConfigurationError();
  }
  return url.hostname;
}

export function derivedResourceNames(
  deploymentName: string,
  environment: DeploymentEnvironment,
): Pick<DeploymentConfiguration, "workerName" | "bucketName" | "assetBucketName"> {
  const prefix = `${deploymentName}-${environment}`;
  return {
    workerName: prefix,
    bucketName: `${prefix}-snapshots`,
    assetBucketName: `${prefix}-assets`,
  };
}

export function validDeploymentName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/u.test(value);
}

function validHostname(value: string): boolean {
  return (
    value.length <= 253 &&
    /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/iu.test(value)
  );
}

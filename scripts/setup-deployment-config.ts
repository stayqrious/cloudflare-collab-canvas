import {
  deploymentConfigurationFromEnvironment,
  dryRunDeploymentValues,
  parseEnvironmentArguments,
  writeGeneratedWranglerConfig,
} from "./deployment-config.ts";
import { loadLocalEnv } from "./env.ts";
import { ensureLocalDevelopmentSecrets } from "./local-development-secrets.ts";

try {
  const { environment, flags } = parseEnvironmentArguments(process.argv.slice(2), ["--dry-run"]);
  const dryRun = flags["--dry-run"];
  const localSecrets = environment === "development" ? ensureLocalDevelopmentSecrets() : undefined;
  loadLocalEnv(`.env.${environment}`);
  loadLocalEnv();
  // `--dry-run` only verifies that the build works: unconfigured deployment
  // details fall back to non-deployable values instead of failing.
  const source = dryRun
    ? dryRunDeploymentValues(environment, process.env)
    : { values: process.env, placeholders: [] };
  const configuration = deploymentConfigurationFromEnvironment(environment, source.values);
  const configPath = writeGeneratedWranglerConfig(configuration);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      environment,
      configPath,
      ...(dryRun ? { dryRun: true, placeholders: source.placeholders } : {}),
      ...(localSecrets
        ? {
            localSecrets: {
              created: localSecrets.created,
              path: localSecrets.path,
            },
          }
        : {}),
    })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "Deployment configuration failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

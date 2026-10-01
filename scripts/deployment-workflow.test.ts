import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("deployment and CI workflows", () => {
  it("runs validation automatically and browser E2E on pull requests and dispatch", () => {
    expect(ci).toContain("workflow_dispatch:");
    expect(ci).toContain("pull_request:\n    branches: [main]");
    expect(ci).not.toContain("  push:");
    expect(ci).toContain(
      "group: ci-$" + "{{ github.workflow }}-$" + "{{ github.event_name }}-$" + "{{ github.ref }}",
    );
    expect(ci).toContain(
      "cancel-in-progress: $" + "{{ github.event_name != 'workflow_dispatch' }}",
    );
    expect(ci).toContain("npm run check");
    expect(ci).toContain("npm run cf:types -- --check");
    expect(ci).toContain("vars.AUTOMATION_PROVIDER != 'cloudflare'");
    expect(ci).toContain("github.event_name == 'workflow_dispatch'");
    expect(ci).toContain("npm run test:e2e -- --project=chromium --project=mobile-chromium");
    expect(ci).toContain("run: npm run test:e2e -- --max-failures=5\n");
  });

  it("deploys every staging and main push at its exact SHA once the full check passes", () => {
    expect(deploy).toContain("push:\n    branches: [staging, main]");
    expect(deploy).not.toContain("workflow_run");
    expect(occurrences(deploy, "ref: $" + "{{ github.sha }}")).toBe(3);
    expect(deploy).toContain("  validate:\n");
    expect(occurrences(deploy, "needs: validate")).toBe(2);
    expect(occurrences(deploy, "npm run check")).toBe(1);
    expect(deploy).toContain("npm run cf:types -- --check");
    expect(deploy).toContain("if: github.ref == 'refs/heads/staging'");
    expect(deploy).toContain("if: github.ref == 'refs/heads/main'");
  });

  it("uses the shared deploy command and skips automatic Actions when Cloudflare owns deployment", () => {
    expect(deploy).toContain("npm run deployment:deploy -- --env staging");
    expect(deploy).toContain("npm run deployment:deploy -- --env production");
    expect(deploy).toContain("if: vars.AUTOMATION_PROVIDER != 'cloudflare'");
    expect(deploy).not.toContain("wrangler versions upload");
  });

  it("keeps mappings environment-scoped and Turnstile explicit", () => {
    expect(occurrences(deploy, "DEPLOYMENT_NAME: $" + "{{ vars.DEPLOYMENT_NAME }}")).toBe(2);
    expect(occurrences(deploy, "APP_HOSTNAME: $" + "{{ vars.APP_HOSTNAME }}")).toBe(2);
    expect(deploy).toContain('TURNSTILE_ENABLED: "false"');
    expect(deploy).toContain("TURNSTILE_SITE_KEY: $" + "{{ vars.TURNSTILE_SITE_KEY }}");
    expect(deploy).toContain('TURNSTILE_ENABLED: "true"');
    expect(deploy).not.toContain("bucket_name:");
    expect(deploy).not.toContain("R2_BUCKET_NAME:");
    expect(deploy).not.toContain("CLOUDFLARE_WORKER_NAME:");
    expect(deploy).not.toContain('--env=""');
  });

  it("uploads every runtime secret from the GitHub environment with each version", () => {
    for (const name of [
      "ORGANISATION_SIGNING_KEYS",
      "SESSION_SIGNING_KEY_CURRENT",
      "SESSION_SIGNING_KEY_PREVIOUS",
      "TURNSTILE_SECRET_KEY",
    ]) {
      expect(occurrences(deploy, `${name}: $` + `{{ secrets.${name} }}`)).toBe(2);
    }
    expect(deploy).toContain("Configure the production Turnstile secret key");
  });
});

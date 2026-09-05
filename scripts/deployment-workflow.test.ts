import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1;
}

describe("deployment and CI workflows", () => {
  it("runs validation automatically and keeps browser E2E manual-only", () => {
    expect(ci).toContain("workflow_dispatch:");
    expect(ci).toContain("pull_request:\n    branches: [main]");
    expect(ci).toContain("push:\n    branches: [main]");
    expect(ci).toContain(
      "group: ci-$" + "{{ github.workflow }}-$" + "{{ github.event_name }}-$" + "{{ github.ref }}",
    );
    expect(ci).toContain(
      "cancel-in-progress: $" + "{{ github.event_name != 'workflow_dispatch' }}",
    );
    expect(ci).toContain("npm run check");
    expect(ci).toContain("npm run cf:types -- --check");
    expect(ci).toContain("browser:\n    if: github.event_name == 'workflow_dispatch'");
    expect(ci).toContain("npm run test:e2e");
  });

  it("deploys only direct staging and main pushes at their exact SHA", () => {
    expect(deploy).toContain("branches: [staging, main]");
    expect(deploy).not.toContain("workflow_run");
    expect(occurrences(deploy, "ref: $" + "{{ github.sha }}")).toBe(2);
    expect(deploy).toContain("if: github.ref == 'refs/heads/staging'");
    expect(deploy).toContain("if: github.ref == 'refs/heads/main'");
  });

  it("provisions private buckets and deploys each uploaded version directly at 100%", () => {
    expect(deploy).toContain("npm run deployment:init -- --env staging");
    expect(deploy).toContain("npm run deployment:init -- --env production");
    expect(deploy).toContain("npm run deployment:init -- --env staging --finalize");
    expect(deploy).toContain("npm run deployment:init -- --env production --finalize");
    expect(deploy).not.toContain("npm run config:setup");
    expect(deploy).not.toContain("npm run cf:bootstrap");
    expect(deploy).toContain("--config .generated/wrangler.staging.jsonc");
    expect(deploy).toContain("--config .generated/wrangler.production.jsonc");
    expect(occurrences(deploy, "wrangler versions upload")).toBe(2);
    expect(occurrences(deploy, "$" + "{{ steps.upload.outputs.version_id }}@100")).toBe(2);
    expect(deploy).not.toContain("--strict");
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

  it("uses only a small post-deploy health probe", () => {
    expect(occurrences(deploy, "for attempt in 1 2 3 4 5")).toBe(2);
    expect(occurrences(deploy, ".ok == true and .service ==")).toBe(2);
    expect(deploy).not.toContain("npm run check");
    expect(deploy).not.toContain("test:e2e");
    expect(deploy).not.toContain("load:smoke");
    expect(deploy).not.toContain("cloudflare/staging");
    expect(deploy).not.toContain("candidate");
    expect(deploy).not.toContain("rollback");
    expect(deploy).not.toContain("convergence");
    expect(deploy).not.toContain("Version-Overrides");
  });
});

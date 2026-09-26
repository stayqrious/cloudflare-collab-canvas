import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const localBaseUrl = "https://127.0.0.1:8787";
const localClassroomHostUrl = "http://localhost:4173";
const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? localBaseUrl;
const localProjectHeaders = (lastOctet: number): Record<string, string> | undefined =>
  process.env.PLAYWRIGHT_BASE_URL ? undefined : { "CF-Connecting-IP": `198.18.0.${lastOctet}` };

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        {
          command:
            "npm run config:setup -- --env development && npx wrangler dev --config .generated/wrangler.development.jsonc --local --ip 127.0.0.1 --port 8787 --local-protocol https",
          cwd: repositoryRoot,
          url: `${localBaseUrl}/healthz`,
          ignoreHTTPSErrors: true,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "node classroom-host.mjs",
          url: `${localClassroomHostUrl}/healthz`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
      ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        extraHTTPHeaders: localProjectHeaders(1),
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        extraHTTPHeaders: localProjectHeaders(2),
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        extraHTTPHeaders: localProjectHeaders(3),
      },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"], extraHTTPHeaders: localProjectHeaders(4) },
    },
    {
      name: "ipad-webkit",
      use: {
        ...devices["iPad Pro 11"],
        extraHTTPHeaders: localProjectHeaders(5),
      },
    },
  ],
});

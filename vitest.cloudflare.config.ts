import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const localBindings = parseEnv(
  readFileSync(new URL("./.generated/.dev.vars", import.meta.url), "utf8"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: { bindings: localBindings },
      wrangler: { configPath: "./.generated/wrangler.development.jsonc" },
    }),
  ],
  test: {
    include: ["apps/edge/**/*.test.ts", "tests/integration/**/*.test.ts"],
    fileParallelism: false,
    isolate: false,
    maxWorkers: 1,
  },
});

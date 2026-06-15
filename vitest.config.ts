import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["cli/**", "node_modules/**"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityFlags: ["nodejs_compat"],
          // 测试环境注入后台密路径(线上是 Cloudflare Secret,不在 wrangler.toml)
          bindings: { ADMIN_PATH: "test-admin", GATEWAY_UUID_SEED: "" },
        },
      },
    },
  },
});

import type { Env } from "../src/types";

declare module "cloudflare:test" {
  // 让测试环境的 env 类型与应用 Env 绑定一致
  interface ProvidedEnv extends Env {}
}

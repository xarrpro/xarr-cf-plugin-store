import type { RateLimit } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  KV: KVNamespace;
  RATE_LIMITER: RateLimit;
  GATEWAY_UUID_SEED: string; // 历史:首次启动迁移为第一个下载入口
  ADMIN_PATH: string;        // 自定义后台密路径(URL 第一段)
  ADMIN_TOKEN?: string;      // 固定主令牌(明文配在 wrangler.toml,方便查阅;KV 签发的令牌仍并行有效)
}

// 下载授权入口(可签发多个,发给不同渠道/人,可吊销)
export interface GatewayRecord {
  name: string;       // 备注
  createdAt: number;
  revoked: boolean;
}

export interface TokenRecord {
  name: string;
  hash: string;      // sha256(明文令牌) hex
  scope: string;     // 'admin'
  createdAt: number;
  expireAt: number;  // 0 = 永不过期
  revoked: boolean;
}

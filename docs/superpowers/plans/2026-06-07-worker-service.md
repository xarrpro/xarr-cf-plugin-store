# CF Plugin Store — Worker 服务端 实现计划(计划 A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Cloudflare Workers 上构建单作者私有插件分发服务的服务端：插件/版本管理、令牌鉴权、公开下载。

**Architecture:** 单 Worker + Hono 模块化路由。D1 存元数据、R2 存 zip 包、KV 存令牌与缓存。管理端隐藏在自定义 uuid 路径后并叠加 Bearer 令牌；公开端无鉴权可缓存。全程 TDD（`@cloudflare/vitest-pool-workers` 在真实 Workers runtime 跑）。

**Tech Stack:** TypeScript, Hono, Cloudflare Workers/D1/R2/KV, WebCrypto(SHA-256/Ed25519), fflate, Vitest + @cloudflare/vitest-pool-workers, wrangler。

设计依据：`docs/superpowers/specs/2026-06-07-cf-plugin-store-design.md`

---

## 文件结构

```
cf-plugin-store/
├─ src/
│  ├─ index.ts            # Hono app 入口 + 路由挂载
│  ├─ types.ts            # Env 绑定类型、领域类型
│  ├─ lib/
│  │  ├─ response.ts      # 统一响应包络 ok()/err()
│  │  ├─ hash.ts          # sha256Hex()、constantTimeEqual()
│  │  ├─ manifest.ts      # 从 zip 解析并校验 manifest.json
│  │  └─ signature.ts     # Ed25519 verify
│  ├─ services/
│  │  ├─ db.ts            # D1 查询封装
│  │  ├─ storage.ts       # R2 读写封装
│  │  └─ tokens.ts        # KV 令牌签发/校验/吊销 + gateway uuid
│  ├─ middleware/
│  │  ├─ gateway.ts       # uuid 路径比对（404 伪装）
│  │  ├─ auth.ts          # Bearer 令牌校验
│  │  └─ ratelimit.ts     # CF 原生 Rate Limiting binding
│  └─ routes/
│     ├─ public.ts        # 列表/详情/check-update/下载
│     └─ admin.ts         # 插件 CRUD / 上传版本 / 令牌
├─ migrations/0001_init.sql
├─ test/
│  ├─ helpers.ts
│  ├─ lib.test.ts
│  ├─ public.test.ts
│  └─ admin.test.ts
├─ wrangler.toml
├─ vitest.config.ts
├─ tsconfig.json
└─ package.json
```

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`, `migrations/0001_init.sql`, `src/types.ts`, `src/index.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "cf-plugin-store",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "migrate:local": "wrangler d1 migrations apply plugin_store --local",
    "migrate:remote": "wrangler d1 migrations apply plugin_store --remote"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "fflate": "^0.8.2"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "@cloudflare/workers-types": "^4.20240909.0",
    "typescript": "^5.6.0",
    "vitest": "2.1.9",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 创建 wrangler.toml**

```toml
name = "cf-plugin-store"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[vars]
GATEWAY_UUID_SEED = "change-me-initial-gateway-uuid"

[[d1_databases]]
binding = "DB"
database_name = "plugin_store"
database_id = "PLACEHOLDER_RUN_wrangler_d1_create"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "plugin-store-packages"

[[kv_namespaces]]
binding = "KV"
id = "PLACEHOLDER_RUN_wrangler_kv_namespace_create"

[[unsafe.bindings]]
name = "RATE_LIMITER"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 20, period = 60 }
```

> `database_id` 与 KV `id` 在真实部署前用 `wrangler d1 create` / `wrangler kv namespace create` 生成后替换。本地测试由 vitest-pool-workers 自动提供隔离实例。

- [ ] **Step 4: 创建 vitest.config.ts**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { compatibilityFlags: ["nodejs_compat"] },
      },
    },
  },
});
```

- [ ] **Step 5: 创建 migrations/0001_init.sql**

```sql
CREATE TABLE plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type INTEGER NOT NULL DEFAULT 1,
  author TEXT,
  description TEXT,
  homepage TEXT,
  preview_img_url TEXT,
  repository_url TEXT,
  latest_version TEXT,
  manifest_version INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id INTEGER NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable',
  min_program_version TEXT,
  changelog TEXT,
  r2_key TEXT NOT NULL,
  package_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  md5 TEXT,
  signature TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(plugin_id, version, channel)
);
CREATE INDEX idx_releases_plugin ON releases(plugin_id);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT,
  token_id TEXT,
  ip TEXT,
  ua TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE download_stats (
  plugin_id INTEGER NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plugin_id, version)
);
```

- [ ] **Step 6: 创建 src/types.ts**

```typescript
import type { RateLimit } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  KV: KVNamespace;
  RATE_LIMITER: RateLimit;
  GATEWAY_UUID_SEED: string;
}

export interface TokenRecord {
  name: string;
  hash: string;      // sha256(明文令牌) hex
  scope: string;     // 'admin'
  createdAt: number;
  expireAt: number;  // 0 = 永不过期
  revoked: boolean;
}
```

- [ ] **Step 7: 创建 src/index.ts（最小入口）**

```typescript
import { Hono } from "hono";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();
app.get("/", (c) => c.json({ ok: true, version: "0.1.0" }));
export default app;
```

- [ ] **Step 8: 安装依赖并验证类型**

Run: `cd cf-plugin-store && npm install && npx tsc --noEmit`
Expected: 安装成功，tsc 无错误。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: Worker 服务脚手架"
```

---

## Task 2: 统一响应包络 lib/response.ts

**Files:** Create `src/lib/response.ts`, `test/lib.test.ts`

- [ ] **Step 1: 写失败测试**(`test/lib.test.ts`)

```typescript
import { describe, it, expect } from "vitest";
import { ok, err } from "../src/lib/response";

describe("response", () => {
  it("ok 包络", async () => {
    const res = ok({ a: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 0, msg: "ok", data: { a: 1 } });
  });
  it("err 包络", async () => {
    const res = err(1001, "unauthorized", 401);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 1001, msg: "unauthorized", data: null });
  });
});
```

- [ ] **Step 2: 运行验证失败** — Run: `npx vitest run test/lib.test.ts` — Expected: FAIL（找不到模块）。

- [ ] **Step 3: 实现 src/lib/response.ts**

```typescript
export function ok(data: unknown = null, http = 200): Response {
  return Response.json({ code: 0, msg: "ok", data }, { status: http });
}
export function err(code: number, msg: string, http = 400): Response {
  return Response.json({ code, msg, data: null }, { status: http });
}
```

- [ ] **Step 4: 运行验证通过** — Run: `npx vitest run test/lib.test.ts` — Expected: PASS。

- [ ] **Step 5: Commit** — `git add src/lib/response.ts test/lib.test.ts && git commit -m "feat: 响应包络 ok/err"`

---

## Task 3: 哈希工具 lib/hash.ts

**Files:** Create `src/lib/hash.ts`; Modify `test/lib.test.ts`

- [ ] **Step 1: 追加失败测试**(`test/lib.test.ts`)

```typescript
import { sha256Hex, constantTimeEqual } from "../src/lib/hash";

describe("hash", () => {
  it("sha256Hex 稳定", async () => {
    const buf = new TextEncoder().encode("hello").buffer;
    expect(await sha256Hex(buf)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
  it("constantTimeEqual", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行验证失败** — Run: `npx vitest run test/lib.test.ts` — Expected: FAIL。

- [ ] **Step 3: 实现 src/lib/hash.ts**

```typescript
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 4: 运行验证通过** — Run: `npx vitest run test/lib.test.ts` — Expected: PASS。

- [ ] **Step 5: Commit** — `git add src/lib/hash.ts test/lib.test.ts && git commit -m "feat: sha256 与常量时间比较"`

---

## Task 4: manifest 解析 lib/manifest.ts

**Files:** Create `src/lib/manifest.ts`; Modify `test/lib.test.ts`

- [ ] **Step 1: 追加失败测试**(`test/lib.test.ts`)

```typescript
import { zipSync, strToU8 } from "fflate";
import { parseManifestFromZip, ManifestError } from "../src/lib/manifest";

describe("manifest", () => {
  function buildZip(manifestObj: unknown): ArrayBuffer {
    const files: Record<string, Uint8Array> = { "plugin.lua": strToU8("-- code") };
    if (manifestObj !== undefined) files["manifest.json"] = strToU8(JSON.stringify(manifestObj));
    const z = zipSync(files);
    return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength);
  }
  it("解析合法 manifest", async () => {
    const m = await parseManifestFromZip(buildZip({ name: "demo", title: "Demo", version: "1.0.0", type: 1 }));
    expect(m.name).toBe("demo");
    expect(m.version).toBe("1.0.0");
  });
  it("缺 manifest.json 抛错", async () => {
    await expect(parseManifestFromZip(buildZip(undefined))).rejects.toBeInstanceOf(ManifestError);
  });
  it("缺必填字段抛错", async () => {
    await expect(parseManifestFromZip(buildZip({ title: "D", version: "1.0.0" }))).rejects.toThrow(/name/);
  });
});
```

- [ ] **Step 2: 运行验证失败** — Run: `npx vitest run test/lib.test.ts` — Expected: FAIL。

- [ ] **Step 3: 实现 src/lib/manifest.ts**

```typescript
import { unzipSync, strFromU8 } from "fflate";

export class ManifestError extends Error {}

export interface Manifest {
  manifest_version: number;
  name: string;
  title: string;
  author?: string;
  description?: string;
  homepage?: string;
  version: string;
  min_program_version?: string;
  type: number;
}

const REQUIRED: (keyof Manifest)[] = ["name", "title", "version", "type"];

export async function parseManifestFromZip(buf: ArrayBuffer): Promise<Manifest> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch {
    throw new ManifestError("无法解压 zip 包");
  }
  const raw = files["manifest.json"];
  if (!raw) throw new ManifestError("zip 中缺少 manifest.json");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(strFromU8(raw));
  } catch {
    throw new ManifestError("manifest.json 不是合法 JSON");
  }
  for (const k of REQUIRED) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") {
      throw new ManifestError(`manifest.json 缺少必填字段: ${k}`);
    }
  }
  return {
    manifest_version: Number(obj.manifest_version ?? 1),
    name: String(obj.name),
    title: String(obj.title),
    author: obj.author ? String(obj.author) : undefined,
    description: obj.description ? String(obj.description) : undefined,
    homepage: obj.homepage ? String(obj.homepage) : undefined,
    version: String(obj.version),
    min_program_version: obj.min_program_version ? String(obj.min_program_version) : undefined,
    type: Number(obj.type),
  };
}

export function extractReadme(buf: ArrayBuffer): string | null {
  try {
    const files = unzipSync(new Uint8Array(buf));
    const r = files["README.md"];
    return r ? strFromU8(r) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 运行验证通过** — Run: `npx vitest run test/lib.test.ts` — Expected: PASS。

- [ ] **Step 5: Commit** — `git add src/lib/manifest.ts test/lib.test.ts && git commit -m "feat: 从 zip 解析 manifest"`

---

## Task 5: Ed25519 验签 lib/signature.ts

**Files:** Create `src/lib/signature.ts`; Modify `test/lib.test.ts`

- [ ] **Step 1: 追加失败测试**(`test/lib.test.ts`)

```typescript
import { verifyEd25519 } from "../src/lib/signature";

describe("signature", () => {
  it("正确签名通过、篡改失败", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const msg = new TextEncoder().encode("2cf24dba");
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, msg);
    const rawPub = await crypto.subtle.exportKey("raw", pair.publicKey);
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(await verifyEd25519("2cf24dba", hex(sig), hex(rawPub))).toBe(true);
    expect(await verifyEd25519("2cf24dbX", hex(sig), hex(rawPub))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行验证失败** — Run: `npx vitest run test/lib.test.ts` — Expected: FAIL。

- [ ] **Step 3: 实现 src/lib/signature.ts**

```typescript
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyEd25519(messageHex: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  try {
    const pub = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, pub, hexToBytes(signatureHex), new TextEncoder().encode(messageHex));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 运行验证通过** — Run: `npx vitest run test/lib.test.ts` — Expected: PASS。Ed25519 在当前 compatibility_date 已 GA。

- [ ] **Step 5: Commit** — `git add src/lib/signature.ts test/lib.test.ts && git commit -m "feat: Ed25519 验签"`

---

## Task 6: 测试夹具 test/helpers.ts

**Files:** Create `test/helpers.ts`

- [ ] **Step 1: 实现 helpers（工具文件，无独立测试）**

```typescript
import { env } from "cloudflare:test";
import { zipSync, strToU8 } from "fflate";
import { sha256Hex } from "../src/lib/hash";

export async function applyMigrations(): Promise<void> {
  const sql = `
    CREATE TABLE IF NOT EXISTS plugins (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE, title TEXT NOT NULL, type INTEGER NOT NULL DEFAULT 1, author TEXT,
      description TEXT, homepage TEXT, preview_img_url TEXT, repository_url TEXT, latest_version TEXT,
      manifest_version INTEGER NOT NULL DEFAULT 1, owner TEXT, status INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id INTEGER NOT NULL,
      version TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'stable', min_program_version TEXT, changelog TEXT,
      r2_key TEXT NOT NULL, package_size INTEGER NOT NULL, sha256 TEXT NOT NULL, md5 TEXT, signature TEXT,
      status INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, UNIQUE(plugin_id, version, channel));
    CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
      target TEXT, token_id TEXT, ip TEXT, ua TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS download_stats (plugin_id INTEGER NOT NULL, version TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (plugin_id, version));
  `;
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
}

export const TEST_GATEWAY = "test-gateway-uuid-123";
export const TEST_TOKEN = "test-token-plaintext-0123456789abcdef";

export async function seedAuth(): Promise<void> {
  await env.KV.put("config:gateway_uuid", TEST_GATEWAY);
  const hash = await sha256Hex(new TextEncoder().encode(TEST_TOKEN).buffer);
  await env.KV.put("token:tok_test", JSON.stringify({
    name: "test", hash, scope: "admin", createdAt: 1, expireAt: 0, revoked: false,
  }));
  (env as any).RATE_LIMITER ??= { limit: async () => ({ success: true }) };
}

export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

export function buildPluginZip(manifest: Record<string, unknown>): ArrayBuffer {
  const z = zipSync({
    "plugin.lua": strToU8("-- code"),
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "README.md": strToU8("# Demo"),
  });
  return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength);
}
```

- [ ] **Step 2: Commit** — `git add test/helpers.ts && git commit -m "test: 测试夹具"`

---

## Task 7: 令牌服务 services/tokens.ts

**Files:** Create `src/services/tokens.ts`, `test/admin.test.ts`

- [ ] **Step 1: 写失败测试**(`test/admin.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedAuth, TEST_TOKEN, TEST_GATEWAY } from "./helpers";
import { getGatewayUuid, verifyToken, issueToken, revokeToken } from "../src/services/tokens";

beforeEach(async () => { await applyMigrations(); await seedAuth(); });

describe("tokens service", () => {
  it("getGatewayUuid", async () => { expect(await getGatewayUuid(env)).toBe(TEST_GATEWAY); });
  it("verifyToken", async () => {
    expect(await verifyToken(env, TEST_TOKEN)).not.toBeNull();
    expect(await verifyToken(env, "wrong")).toBeNull();
  });
  it("issue/revoke", async () => {
    const { id, plaintext } = await issueToken(env, "ci", 0);
    expect(await verifyToken(env, plaintext)).not.toBeNull();
    await revokeToken(env, id);
    expect(await verifyToken(env, plaintext)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行验证失败** — Run: `npx vitest run test/admin.test.ts` — Expected: FAIL。

- [ ] **Step 3: 实现 src/services/tokens.ts**

```typescript
import type { Env, TokenRecord } from "../types";
import { sha256Hex, constantTimeEqual } from "../lib/hash";

export async function getGatewayUuid(env: Env): Promise<string> {
  const v = await env.KV.get("config:gateway_uuid");
  if (v) return v;
  await env.KV.put("config:gateway_uuid", env.GATEWAY_UUID_SEED);
  return env.GATEWAY_UUID_SEED;
}

export async function verifyToken(env: Env, plaintext: string): Promise<(TokenRecord & { id: string }) | null> {
  if (!plaintext) return null;
  const hash = await sha256Hex(new TextEncoder().encode(plaintext).buffer);
  const list = await env.KV.list({ prefix: "token:" });
  const now = Math.floor(Date.now() / 1000);
  for (const key of list.keys) {
    const raw = await env.KV.get(key.name);
    if (!raw) continue;
    const rec = JSON.parse(raw) as TokenRecord;
    if (rec.revoked) continue;
    if (rec.expireAt !== 0 && rec.expireAt < now) continue;
    if (constantTimeEqual(rec.hash, hash)) return { ...rec, id: key.name.replace("token:", "") };
  }
  return null;
}

export async function issueToken(env: Env, name: string, expireAt: number): Promise<{ id: string; plaintext: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await sha256Hex(new TextEncoder().encode(plaintext).buffer);
  const id = `tok_${crypto.randomUUID().slice(0, 8)}`;
  const rec: TokenRecord = { name, hash, scope: "admin", createdAt: Math.floor(Date.now() / 1000), expireAt, revoked: false };
  await env.KV.put(`token:${id}`, JSON.stringify(rec));
  return { id, plaintext };
}

export async function revokeToken(env: Env, id: string): Promise<void> {
  const raw = await env.KV.get(`token:${id}`);
  if (!raw) return;
  const rec = JSON.parse(raw) as TokenRecord;
  rec.revoked = true;
  await env.KV.put(`token:${id}`, JSON.stringify(rec));
}

export async function listTokens(env: Env): Promise<Array<{ id: string } & Omit<TokenRecord, "hash">>> {
  const list = await env.KV.list({ prefix: "token:" });
  const out: Array<{ id: string } & Omit<TokenRecord, "hash">> = [];
  for (const key of list.keys) {
    const raw = await env.KV.get(key.name);
    if (!raw) continue;
    const { hash, ...rest } = JSON.parse(raw) as TokenRecord;
    out.push({ id: key.name.replace("token:", ""), ...rest });
  }
  return out;
}
```

- [ ] **Step 4: 运行验证通过** — Run: `npx vitest run test/admin.test.ts` — Expected: PASS。

- [ ] **Step 5: Commit** — `git add src/services/tokens.ts test/admin.test.ts && git commit -m "feat: 令牌服务"`

---

## Task 8: 存储服务 services/storage.ts

**Files:** Create `src/services/storage.ts`; Modify `test/admin.test.ts`

- [ ] **Step 1: 追加失败测试**(`test/admin.test.ts`)

```typescript
import { putPackage, getPackage, deletePackage, packageKey } from "../src/services/storage";

describe("storage service", () => {
  it("put/get/delete 往返", async () => {
    const key = packageKey("uuid-1", "1.0.0", "demo");
    await putPackage(env, key, new TextEncoder().encode("zipdata").buffer, "application/zip");
    const got = await getPackage(env, key);
    expect(got).not.toBeNull();
    expect(await got!.text()).toBe("zipdata");
    await deletePackage(env, key);
    expect(await getPackage(env, key)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行验证失败** — Run: `npx vitest run test/admin.test.ts` — Expected: FAIL。

- [ ] **Step 3: 实现 src/services/storage.ts**

```typescript
import type { Env } from "../types";

export function packageKey(uuid: string, version: string, name: string): string {
  return `packages/${uuid}/${version}/${name}-${version}.zip`;
}
export function readmeKey(uuid: string, version: string): string {
  return `packages/${uuid}/${version}/README.md`;
}
export async function putPackage(env: Env, key: string, body: ArrayBuffer | string, contentType: string): Promise<void> {
  await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
}
export async function getPackage(env: Env, key: string): Promise<R2ObjectBody | null> {
  return await env.BUCKET.get(key);
}
export async function deletePackage(env: Env, key: string): Promise<void> {
  await env.BUCKET.delete(key);
}
```

- [ ] **Step 4: 运行验证通过** — Run: `npx vitest run test/admin.test.ts` — Expected: PASS。

- [ ] **Step 5: Commit** — `git add src/services/storage.ts test/admin.test.ts && git commit -m "feat: R2 存储服务"`

---

## Task 9: 数据库服务 services/db.ts

**Files:** Create `src/services/db.ts`; Modify `test/admin.test.ts`

- [ ] **Step 1: 追加失败测试**(`test/admin.test.ts`)

```typescript
import { createPlugin, getPluginByName, insertReleaseAtomic, writeAudit } from "../src/services/db";

describe("db service", () => {
  it("createPlugin + getPluginByName", async () => {
    const p = await createPlugin(env, { name: "demo", title: "Demo", type: 1, author: "xarr" });
    expect(p.uuid).toMatch(/.+/);
    expect((await getPluginByName(env, "demo"))!.name).toBe("demo");
  });
  it("insertReleaseAtomic 更新 latest_version", async () => {
    const p = await createPlugin(env, { name: "demo2", title: "D2", type: 1 });
    await insertReleaseAtomic(env, { pluginId: p.id, version: "1.0.0", channel: "stable", r2Key: "k",
      packageSize: 10, sha256: "abc", signature: null, changelog: "", minProgramVersion: "" });
    expect((await getPluginByName(env, "demo2"))!.latest_version).toBe("1.0.0");
  });
  it("重复版本抛错", async () => {
    const p = await createPlugin(env, { name: "demo3", title: "D3", type: 1 });
    const a = { pluginId: p.id, version: "1.0.0", channel: "stable", r2Key: "k",
      packageSize: 10, sha256: "abc", signature: null, changelog: "", minProgramVersion: "" };
    await insertReleaseAtomic(env, a);
    await expect(insertReleaseAtomic(env, a)).rejects.toThrow();
  });
  it("writeAudit 落库", async () => {
    await writeAudit(env, { action: "test", target: "x", tokenId: "t", ip: "1.1.1.1", ua: "ua" });
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs").first<{ c: number }>();
    expect(row!.c).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 运行验证失败** — Run: `npx vitest run test/admin.test.ts` — Expected: FAIL。

- [ ] **Step 3: 实现 src/services/db.ts**

```typescript
import type { Env } from "../types";

export interface PluginRow {
  id: number; uuid: string; name: string; title: string; type: number;
  author: string | null; description: string | null; homepage: string | null;
  latest_version: string | null; status: number; created_at: number; updated_at: number;
  deleted_at: number | null;
}

export async function createPlugin(env: Env, input: {
  name: string; title: string; type: number; author?: string; description?: string; homepage?: string;
}): Promise<PluginRow> {
  const uuid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO plugins (uuid, name, title, type, author, description, homepage, manifest_version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
  ).bind(uuid, input.name, input.title, input.type, input.author ?? null,
         input.description ?? null, input.homepage ?? null, now, now).run();
  return (await getPluginByName(env, input.name))!;
}

export async function getPluginByName(env: Env, name: string): Promise<PluginRow | null> {
  return await env.DB.prepare(`SELECT * FROM plugins WHERE name = ? AND deleted_at IS NULL`).bind(name).first<PluginRow>();
}

export async function listPlugins(env: Env, filter: { type?: number; q?: string }): Promise<PluginRow[]> {
  let sql = `SELECT * FROM plugins WHERE deleted_at IS NULL AND status = 1`;
  const binds: unknown[] = [];
  if (filter.type !== undefined) { sql += ` AND type = ?`; binds.push(filter.type); }
  if (filter.q) { sql += ` AND (name LIKE ? OR title LIKE ?)`; binds.push(`%${filter.q}%`, `%${filter.q}%`); }
  sql += ` ORDER BY updated_at DESC`;
  return (await env.DB.prepare(sql).bind(...binds).all<PluginRow>()).results ?? [];
}

export async function getReleases(env: Env, pluginId: number) {
  return (await env.DB.prepare(
    `SELECT * FROM releases WHERE plugin_id = ? AND status = 1 ORDER BY created_at DESC`,
  ).bind(pluginId).all()).results ?? [];
}

export interface ReleaseInput {
  pluginId: number; version: string; channel: string; r2Key: string;
  packageSize: number; sha256: string; signature: string | null;
  changelog: string; minProgramVersion: string;
}

export async function insertReleaseAtomic(env: Env, r: ReleaseInput): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO releases (plugin_id, version, channel, min_program_version, changelog, r2_key, package_size, sha256, signature, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).bind(r.pluginId, r.version, r.channel, r.minProgramVersion || null, r.changelog || null,
           r.r2Key, r.packageSize, r.sha256, r.signature, now),
  ];
  if (r.channel === "stable") {
    stmts.push(env.DB.prepare(`UPDATE plugins SET latest_version = ?, updated_at = ? WHERE id = ?`).bind(r.version, now, r.pluginId));
  }
  await env.DB.batch(stmts);
}

export async function writeAudit(env: Env, a: { action: string; target?: string; tokenId?: string; ip?: string; ua?: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (action, target, token_id, ip, ua, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(a.action, a.target ?? null, a.tokenId ?? null, a.ip ?? null, a.ua ?? null, Math.floor(Date.now() / 1000)).run();
}

export async function incrDownload(env: Env, pluginId: number, version: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO download_stats (plugin_id, version, count) VALUES (?, ?, 1)
     ON CONFLICT(plugin_id, version) DO UPDATE SET count = count + 1`,
  ).bind(pluginId, version).run();
}
```

- [ ] **Step 4: 运行验证通过** — Run: `npx vitest run test/admin.test.ts` — Expected: PASS。

- [ ] **Step 5: Commit** — `git add src/services/db.ts test/admin.test.ts && git commit -m "feat: D1 数据库服务"`

---

## Task 10: 中间件 gateway / auth / ratelimit

**Files:** Create `src/middleware/gateway.ts`, `src/middleware/auth.ts`, `src/middleware/ratelimit.ts`

> 这三个中间件在 Task 11 admin 路由集成测试中验证（脱离路由难单测）。

- [ ] **Step 1: 实现 src/middleware/gateway.ts**

```typescript
import type { Context, Next } from "hono";
import type { Env } from "../types";
import { getGatewayUuid } from "../services/tokens";
import { constantTimeEqual } from "../lib/hash";

export async function gatewayGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const uuid = c.req.param("uuid") ?? "";
  const expected = await getGatewayUuid(c.env);
  if (!constantTimeEqual(uuid, expected)) return c.notFound();
  await next();
}
```

- [ ] **Step 2: 实现 src/middleware/auth.ts**

```typescript
import type { Context, Next } from "hono";
import type { Env, TokenRecord } from "../types";
import { verifyToken } from "../services/tokens";
import { err } from "../lib/response";

declare module "hono" {
  interface ContextVariableMap {
    token: TokenRecord & { id: string };
  }
}

export async function authGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const m = (c.req.header("Authorization") ?? "").match(/^Bearer\s+(.+)$/);
  if (!m) return err(1001, "未授权", 401);
  const rec = await verifyToken(c.env, m[1]);
  if (!rec) return err(1001, "未授权", 401);
  c.set("token", rec);
  await next();
}
```

- [ ] **Step 3: 实现 src/middleware/ratelimit.ts**

```typescript
import type { Context, Next } from "hono";
import type { Env } from "../types";
import { err } from "../lib/response";

export async function rateLimitGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.RATE_LIMITER.limit({ key: ip });
  if (!success) return err(1002, "请求过于频繁", 429);
  await next();
}
```

- [ ] **Step 4: 类型检查** — Run: `npx tsc --noEmit` — Expected: 无错误。

- [ ] **Step 5: Commit** — `git add src/middleware && git commit -m "feat: 中间件 gateway/auth/ratelimit"`

---

## Task 11: 管理路由 routes/admin.ts

**Files:** Create `src/routes/admin.ts`; Modify `src/index.ts`, `test/admin.test.ts`

- [ ] **Step 1: 在 src/index.ts 挂载 admin 路由**

```typescript
import { Hono } from "hono";
import type { Env } from "./types";
import { adminRoutes } from "./routes/admin";

const app = new Hono<{ Bindings: Env }>();
app.get("/", (c) => c.json({ ok: true, version: "0.1.0" }));
app.route("/:uuid/admin", adminRoutes);
export default app;
```

- [ ] **Step 2: 写失败集成测试**(`test/admin.test.ts` 追加)

```typescript
import app from "../src/index";
import { authHeaders, buildPluginZip, TEST_GATEWAY } from "./helpers";
import { sha256Hex } from "../src/lib/hash";

const adminUrl = (p: string) => `https://x/${TEST_GATEWAY}/admin${p}`;

describe("admin routes", () => {
  it("错误网关 uuid → 404", async () => {
    const res = await app.request("https://x/wrong/admin/plugins",
      { method: "POST", headers: authHeaders(), body: "{}" }, env);
    expect(res.status).toBe(404);
  });
  it("缺令牌 → 401", async () => {
    const res = await app.request(adminUrl("/plugins"),
      { method: "POST", body: JSON.stringify({ name: "a", title: "A", type: 1 }) }, env);
    expect(res.status).toBe(401);
  });
  it("创建 → 上传 → 重复 409", async () => {
    const create = await app.request(adminUrl("/plugins"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo-pay", title: "Demo Pay", type: 1 }),
    }, env);
    expect(create.status).toBe(200);
    const zip = buildPluginZip({ name: "demo-pay", title: "Demo Pay", version: "1.0.0", type: 1 });
    const sha = await sha256Hex(zip);
    const up = await app.request(adminUrl("/plugins/demo-pay/releases"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/zip", "X-Package-Sha256": sha }, body: zip,
    }, env);
    expect(up.status).toBe(200);
    expect((await up.json() as any).data.version).toBe("1.0.0");
    const dup = await app.request(adminUrl("/plugins/demo-pay/releases"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/zip", "X-Package-Sha256": sha }, body: zip,
    }, env);
    expect(dup.status).toBe(409);
  });
  it("校验和不匹配 → 422", async () => {
    await app.request(adminUrl("/plugins"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo-x", title: "X", type: 1 }),
    }, env);
    const zip = buildPluginZip({ name: "demo-x", title: "X", version: "1.0.0", type: 1 });
    const res = await app.request(adminUrl("/plugins/demo-x/releases"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/zip", "X-Package-Sha256": "deadbeef" }, body: zip,
    }, env);
    expect(res.status).toBe(422);
  });
  it("签发 → 列出 → 吊销", async () => {
    const issue = await app.request(adminUrl("/tokens"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ci", expireAt: 0 }),
    }, env);
    const { data } = await issue.json() as any;
    expect(data.plaintext).toMatch(/.+/);
    const list = await app.request(adminUrl("/tokens"), { headers: authHeaders() }, env);
    expect((await list.json() as any).data.length).toBeGreaterThan(0);
    const del = await app.request(adminUrl(`/tokens/${data.id}`), { method: "DELETE", headers: authHeaders() }, env);
    expect(del.status).toBe(200);
  });
});
```

- [ ] **Step 3: 运行验证失败** — Run: `npx vitest run test/admin.test.ts` — Expected: FAIL（找不到 admin 模块）。

- [ ] **Step 4: 实现 src/routes/admin.ts**

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { gatewayGuard } from "../middleware/gateway";
import { authGuard } from "../middleware/auth";
import { rateLimitGuard } from "../middleware/ratelimit";
import { ok, err } from "../lib/response";
import { parseManifestFromZip, extractReadme, ManifestError } from "../lib/manifest";
import { sha256Hex } from "../lib/hash";
import { createPlugin, getPluginByName, insertReleaseAtomic, writeAudit } from "../services/db";
import { packageKey, readmeKey, putPackage, deletePackage } from "../services/storage";
import { issueToken, listTokens, revokeToken } from "../services/tokens";

const MAX_SIZE = 25 * 1024 * 1024;

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", rateLimitGuard);
adminRoutes.use("*", gatewayGuard);
adminRoutes.use("*", authGuard);

function meta(c: any) {
  const t = c.get("token");
  return { ip: c.req.header("CF-Connecting-IP") ?? "", ua: c.req.header("User-Agent") ?? "", tokenId: t?.id ?? "" };
}

adminRoutes.post("/plugins", async (c) => {
  const b = await c.req.json().catch(() => null);
  if (!b?.name || !b?.title || !b?.type) return err(2003, "缺少 name/title/type", 422);
  if (await getPluginByName(c.env, b.name)) return err(2002, "插件已存在", 409);
  const p = await createPlugin(c.env, {
    name: b.name, title: b.title, type: Number(b.type), author: b.author, description: b.description, homepage: b.homepage,
  });
  await writeAudit(c.env, { action: "create_plugin", target: b.name, ...meta(c) });
  return ok({ uuid: p.uuid, name: p.name });
});

adminRoutes.post("/plugins/:name/releases", async (c) => {
  const name = c.req.param("name");
  const plugin = await getPluginByName(c.env, name);
  if (!plugin) return err(3001, "插件不存在", 404);

  const lenHeader = c.req.header("Content-Length");
  if (lenHeader && Number(lenHeader) > MAX_SIZE) return err(2004, "包体超过 25MB", 413);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > MAX_SIZE) return err(2004, "包体超过 25MB", 413);

  const serverSha = await sha256Hex(buf);
  const clientSha = c.req.header("X-Package-Sha256");
  if (clientSha && clientSha !== serverSha) return err(2001, "校验和不匹配", 422);

  let manifest;
  try { manifest = await parseManifestFromZip(buf); }
  catch (e) { if (e instanceof ManifestError) return err(2003, e.message, 422); throw e; }

  const channel = (c.req.query("channel") as string) || "stable";
  const signature = c.req.header("X-Package-Signature") ?? null;
  const key = packageKey(plugin.uuid, manifest.version, plugin.name);

  await putPackage(c.env, key, buf, "application/zip");
  const readme = extractReadme(buf);
  if (readme) await putPackage(c.env, readmeKey(plugin.uuid, manifest.version), readme, "text/markdown");

  try {
    await insertReleaseAtomic(c.env, {
      pluginId: plugin.id, version: manifest.version, channel, r2Key: key,
      packageSize: buf.byteLength, sha256: serverSha, signature,
      changelog: manifest.description ?? "", minProgramVersion: manifest.min_program_version ?? "",
    });
  } catch (e) {
    await deletePackage(c.env, key);
    if (/UNIQUE/i.test(String((e as Error).message))) return err(2002, "版本已存在，请升版本号", 409);
    return err(5001, "存储失败，请重试", 503);
  }

  await writeAudit(c.env, { action: "upload_release", target: `${name}@${manifest.version}`, ...meta(c) });
  await c.env.KV.delete("cache:plugins:list");
  return ok({ version: manifest.version, sha256: serverSha, size: buf.byteLength });
});

adminRoutes.post("/tokens", async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const { id, plaintext } = await issueToken(c.env, b.name ?? "unnamed", Number(b.expireAt ?? 0));
  await writeAudit(c.env, { action: "issue_token", target: id, ...meta(c) });
  return ok({ id, plaintext });
});

adminRoutes.get("/tokens", async (c) => ok(await listTokens(c.env)));

adminRoutes.delete("/tokens/:id", async (c) => {
  const id = c.req.param("id");
  await revokeToken(c.env, id);
  await writeAudit(c.env, { action: "revoke_token", target: id, ...meta(c) });
  return ok({ revoked: id });
});
```

- [ ] **Step 5: 运行验证通过** — Run: `npx vitest run test/admin.test.ts` — Expected: PASS（全部）。

- [ ] **Step 6: Commit** — `git add src/routes/admin.ts src/index.ts test/admin.test.ts && git commit -m "feat: 管理路由"`

---

## Task 12: 公开路由 routes/public.ts

**Files:** Create `src/routes/public.ts`; Modify `src/index.ts`, `test/public.test.ts`

- [ ] **Step 1: 更新 src/index.ts（完整）**

```typescript
import { Hono } from "hono";
import type { Env } from "./types";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";

const app = new Hono<{ Bindings: Env }>();
app.get("/", (c) => c.json({ ok: true, version: "0.1.0" }));
app.route("/", publicRoutes);
app.route("/:uuid/admin", adminRoutes);
export default app;
```

- [ ] **Step 2: 写失败测试**(`test/public.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedAuth, authHeaders, buildPluginZip, TEST_GATEWAY } from "./helpers";
import app from "../src/index";
import { sha256Hex } from "../src/lib/hash";

beforeEach(async () => { await applyMigrations(); await seedAuth(); });

async function seed() {
  await app.request(`https://x/${TEST_GATEWAY}/admin/plugins`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo", title: "Demo", type: 1 }),
  }, env);
  const zip = buildPluginZip({ name: "demo", title: "Demo", version: "1.0.0", type: 1 });
  const sha = await sha256Hex(zip);
  await app.request(`https://x/${TEST_GATEWAY}/admin/plugins/demo/releases`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/zip", "X-Package-Sha256": sha }, body: zip,
  }, env);
}

describe("public routes", () => {
  it("列表", async () => {
    await seed();
    const res = await app.request("https://x/api/plugins", {}, env);
    expect((await res.json() as any).data.some((p: any) => p.name === "demo")).toBe(true);
  });
  it("详情含版本", async () => {
    await seed();
    const { data } = await (await app.request("https://x/api/plugins/demo", {}, env)).json() as any;
    expect(data.plugin.name).toBe("demo");
    expect(data.releases.length).toBeGreaterThan(0);
  });
  it("check-update", async () => {
    await seed();
    const { data } = await (await app.request("https://x/api/plugins/demo/check-update?current=0.9.0", {}, env)).json() as any;
    expect(data.has_update).toBe(true);
    expect(data.latest).toBe("1.0.0");
  });
  it("下载", async () => {
    await seed();
    const res = await app.request("https://x/dl/demo/1.0.0", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("zip");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
  it("下载不存在版本 404", async () => {
    await seed();
    expect((await app.request("https://x/dl/demo/9.9.9", {}, env)).status).toBe(404);
  });
});
```

- [ ] **Step 3: 运行验证失败** — Run: `npx vitest run test/public.test.ts` — Expected: FAIL。

- [ ] **Step 4: 实现 src/routes/public.ts**

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { ok, err } from "../lib/response";
import { listPlugins, getPluginByName, getReleases, incrDownload } from "../services/db";
import { getPackage } from "../services/storage";

export const publicRoutes = new Hono<{ Bindings: Env }>();

function gt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

publicRoutes.get("/api/plugins", async (c) => {
  const type = c.req.query("type"), q = c.req.query("q");
  const rows = await listPlugins(c.env, { type: type ? Number(type) : undefined, q: q || undefined });
  return ok(rows.map((p) => ({
    uuid: p.uuid, name: p.name, title: p.title, type: p.type, author: p.author, latest_version: p.latest_version,
  })));
});

publicRoutes.get("/api/plugins/:name", async (c) => {
  const p = await getPluginByName(c.env, c.req.param("name"));
  if (!p) return err(3001, "插件不存在", 404);
  return ok({ plugin: p, releases: await getReleases(c.env, p.id) });
});

publicRoutes.get("/api/plugins/:name/check-update", async (c) => {
  const p = await getPluginByName(c.env, c.req.param("name"));
  if (!p) return err(3001, "插件不存在", 404);
  const current = c.req.query("current") ?? "0.0.0";
  const latest = p.latest_version ?? "0.0.0";
  return ok({ has_update: gt(latest, current), latest, min_program_version: null });
});

publicRoutes.get("/dl/:name/:version", async (c) => {
  const name = c.req.param("name"), version = c.req.param("version");
  const p = await getPluginByName(c.env, name);
  if (!p) return err(3001, "插件不存在", 404);
  const target = version === "latest" ? (p.latest_version ?? "") : version;
  const rel = await c.env.DB.prepare(
    `SELECT * FROM releases WHERE plugin_id = ? AND version = ? AND status = 1 LIMIT 1`,
  ).bind(p.id, target).first<{ r2_key: string; sha256: string }>();
  if (!rel) return err(3001, "版本不存在", 404);
  const obj = await getPackage(c.env, rel.r2_key);
  if (!obj) return err(3001, "包文件丢失", 404);
  c.executionCtx.waitUntil(incrDownload(c.env, p.id, target));
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-SHA256": rel.sha256,
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
});
```

- [ ] **Step 5: 运行验证通过** — Run: `npx vitest run test/public.test.ts` — Expected: PASS。

- [ ] **Step 6: 全量测试 + 类型检查** — Run: `npx vitest run && npx tsc --noEmit` — Expected: 全 PASS，tsc 无错误。

- [ ] **Step 7: Commit** — `git add src/routes/public.ts src/index.ts test/public.test.ts && git commit -m "feat: 公开路由"`

---

## Task 13: README 与部署说明

**Files:** Create `README.md`

- [ ] **Step 1: 写 README.md**

````markdown
# CF Plugin Store（Worker 服务端）

单作者私有插件分发服务，运行于 Cloudflare Workers。

## 本地开发
```bash
npm install
npm test
npm run dev
```

## 部署
```bash
wrangler d1 create plugin_store          # database_id 填入 wrangler.toml
wrangler kv namespace create KV          # id 填入 wrangler.toml
wrangler r2 bucket create plugin-store-packages
npm run migrate:remote
wrangler deploy                          # 部署后在控制台绑定自定义域（缓存需要）
```

首个管理员令牌需手动写入 KV（无令牌无法调签发接口）：
```bash
wrangler kv key put --binding=KV "token:tok_root" \
  '{"name":"root","hash":"<sha256(明文令牌)>","scope":"admin","createdAt":0,"expireAt":0,"revoked":false}'
```

## 接口速览
- 公开：`GET /api/plugins`、`/api/plugins/:name`、`/api/plugins/:name/check-update`、`/dl/:name/:version`
- 管理（前缀 = gateway uuid + Bearer 令牌）：`POST /:uuid/admin/plugins`、`/plugins/:name/releases`、`/tokens`

详见 `docs/superpowers/specs/2026-06-07-cf-plugin-store-design.md`。
````

- [ ] **Step 2: Commit** — `git add README.md && git commit -m "docs: README 与部署说明"`

---

## 自检备注

- **Spec 覆盖**：§3 数据模型→Task1；§4 API→Task11/12；§5.1 鉴权链→Task10/11；§5.2 上传流(25MB/sha校验/补偿删R2/409)→Task11；§5.3 下载缓存+计数→Task12；令牌→Task7/11；审计→Task9/11；包签名字段+verify→Task5/9/11（签名字段已存，强制验签留待计划 B 联调 CLI 后开启）。
- **类型一致**：`ReleaseInput` 在 Task9 定义、Task11 调用一致；`packageKey/readmeKey` 跨 Task8/11 一致；`verifyToken` 返回 `TokenRecord & {id} | null` 跨 Task7/auth/admin 一致（`meta()` 用 `token.id`）。
- **留待计划 B（CLI）**：`xplugin init/pack/publish`、Ed25519 客户端签名、强制验签开关。

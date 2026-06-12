# CF Plugin Store — 设计文档

- 日期：2026-06-07
- 状态：已评审，待实现
- 作者：xarr（单作者私有服务）

## 1. 背景与目标

从现有 `apps-store` / `merchant-server`（GoFrame + MySQL）的插件系统中，剥离其核心理念，
重写为一个运行在 **Cloudflare Workers** 上的**单作者私有插件分发服务**。

复用的核心理念：`uuid` 标识 + `manifest.json` 元数据 + zip 版本包 + 校验和 + 令牌鉴权 + 上下架。
丢弃的部分：多用户注册体系、开发者审核流（单租户不需要）。

### 目标
- 单作者把插件包一键发布到 Cloudflare 边缘，全球公开下载。
- 管理操作隐藏在自定义秘密入口（uuid 路径）后，再叠加令牌鉴权。
- 充分利用 Workers 的 isolate 自动扩展，得到高可用、低运维。
- 提供 Node CLI（npm-publish 风格）一键创建、打包、发布插件。

### 非目标（明确不做）
- 多作者 / 协作权限（`owner` 字段占位，将来再开）。
- 插件间依赖管理、全文搜索、发布 Webhook/通知。

## 2. 技术栈与架构

- **方案 A：单 Worker + [Hono](https://hono.dev) 模块化路由。**
- 存储职责：
  - **D1**：插件与版本的关系型元数据、审计日志、下载计数。
  - **R2**：zip 插件包本体、README、预览图。
  - **KV**：管理员令牌（哈希）、网关 uuid 配置、公开列表热点缓存。
- 限流：使用 **Cloudflare 原生 Rate Limiting binding**（见 §5.1），不用 KV 计数（KV 最终一致，限流不精确）。
- 不引入 Durable Objects / 多 Worker：单作者上传并发极低，版本一致性由 D1 唯一约束解决。

> 说明：Workers 是 isolate 模型，平台自动横向扩展到全球边缘节点，无需手动管理"多线程"。

### 部署前提
- **必须绑定自定义域**：下载缓存（Cache API `caches.default`）在 `*.workers.dev` 上受限，
  绑自定义域后才能拿到完整的边缘缓存红利。

## 3. 数据模型与存储布局

### 3.1 D1 表结构

```sql
-- 插件主档
CREATE TABLE plugins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,            -- 插件标识，用于 R2 路径（不可枚举）
  name TEXT NOT NULL UNIQUE,            -- 包名，用于下载路径（对消费端友好）
  title TEXT NOT NULL,
  type INTEGER NOT NULL DEFAULT 1,      -- 1=支付 2=短信 3=主题…（沿用现有约定）
  author TEXT,
  description TEXT,
  homepage TEXT,
  preview_img_url TEXT,
  repository_url TEXT,
  latest_version TEXT,                  -- 冗余：最新已发布 stable 版本号
  manifest_version INTEGER NOT NULL DEFAULT 1,  -- manifest 格式版本，便于将来兼容演进
  owner TEXT,                           -- 占位：将来多租户用，当前单作者不强用
  status INTEGER NOT NULL DEFAULT 1,    -- 1=上架 2=下架
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                    -- 软删除（name 仍占位，复用需硬删除）
);

-- 版本记录
CREATE TABLE releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id INTEGER NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable',   -- stable / beta，灰度发布
  min_program_version TEXT,
  changelog TEXT,
  r2_key TEXT NOT NULL,                      -- 包在 R2 的对象键
  package_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,                      -- 服务端复算校验（防传输损坏）
  md5 TEXT,
  signature TEXT,                            -- Ed25519 对 sha256 的签名（防篡改，可后开验签）
  status INTEGER NOT NULL DEFAULT 1,         -- 1=启用 2=关闭（撤回有问题版本）
  created_at INTEGER NOT NULL,
  UNIQUE(plugin_id, version, channel)        -- 防重复版本，替代 Durable Objects 强一致
);
CREATE INDEX idx_releases_plugin ON releases(plugin_id);

-- 审计日志：所有管理操作可追溯
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,        -- create_plugin / upload_release / revoke_token …
  target TEXT,                 -- 受影响的 plugin name / token id
  token_id TEXT,               -- 哪个令牌发起的
  ip TEXT,
  ua TEXT,
  created_at INTEGER NOT NULL
);

-- 下载计数（异步累加，不阻塞响应）
CREATE TABLE download_stats (
  plugin_id INTEGER NOT NULL REFERENCES plugins(id),
  version TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plugin_id, version)
);
```

### 3.2 R2 布局

```
packages/{plugin_uuid}/{version}/{name}-{version}.zip   # 插件包本体
packages/{plugin_uuid}/{version}/README.md              # 从 zip 提取
assets/preview/{plugin_uuid}/{filename}                 # 预览图
```

### 3.3 KV 结构

```
config:gateway_uuid → 当前生效的秘密入口 uuid（可随时改，旧路径立即失效；部署时由 env 播种初始值）
token:{tokenId}     → { name, hash(sha256), scope, createdAt, expireAt, revoked }
                       # 令牌只存哈希；明文仅签发时返回一次
cache:plugins:list  → 公开列表 JSON（写操作时主动失效；TTL 60s 兜底）
```

### 3.4 关键取舍
1. **网关 uuid 放 KV**：满足"自定义安全入口"，改入口无需重新部署；env 提供初始播种值。
2. **令牌只存 sha256 哈希 + 常量时间比较**：令牌为 32 字节高熵随机串，sha256 足够，无需 bcrypt。
3. **审计日志**：上传/上下架/令牌吊销为高危操作，需可追溯（谁、何时、哪个 IP）。
4. **`name` 唯一 + 软删除**：软删后 name 仍占位，避免下载链接指向已删内容。
5. **包签名（Ed25519）**：sha256 仅防损坏，签名防篡改。字段先埋，验签可后开。
6. **channel 字段**：唯一约束含 channel，灰度发布不动筋骨。

## 4. API 契约

统一响应包络（沿用现有 `BaseRes` 习惯，降低 merchant-server 接入成本）：

```json
{ "code": 0, "msg": "ok", "data": { } }
```

`code = 0` 成功；非 0 为错误码（见第 6 节）。

### 4.1 公开端（无需鉴权，可缓存）

```
GET  /                                       健康检查 { ok, version }
GET  /api/plugins                            列表（?type=&q=&channel= 过滤）
GET  /api/plugins/:name                      详情 + 版本列表
GET  /api/plugins/:name/releases/:version    单版本元数据
GET  /api/plugins/:name/check-update?current=1.2.0&channel=stable
                                             更新检查 → { has_update, latest, min_program_version }
GET  /dl/:name/:version                      下载 zip（流式回源 R2，带 Content-SHA256 头）
GET  /dl/:name/latest                        下载最新 stable 版
```

### 4.2 管理端（前缀 = KV `gateway_uuid`，且需 `Authorization: Bearer <token>`）

```
POST   /:uuid/admin/plugins                      创建插件
PATCH  /:uuid/admin/plugins/:name                改元数据 / 上下架
DELETE /:uuid/admin/plugins/:name                软删除
POST   /:uuid/admin/plugins/:name/releases       上传新版本（raw body = zip，见 §5.2）
PATCH  /:uuid/admin/plugins/:name/releases/:ver  改版本状态 / changelog
GET    /:uuid/admin/tokens                        列令牌（不含明文）
POST   /:uuid/admin/tokens                        签发令牌（明文仅此一次返回）
DELETE /:uuid/admin/tokens/:id                    吊销令牌
GET    /:uuid/admin/audit                         查审计日志
```

## 5. 鉴权与上传数据流

### 5.1 管理请求处理链（Hono 中间件）

```
1. 取路径 :uuid → 与 KV config:gateway_uuid 常量时间比对 → 不符则 404（伪装资源不存在）
2. 限流：Cloudflare 原生 Rate Limiting binding 按 IP 限速 → 超阈值则 429
3. 取 Authorization Bearer token → sha256 → 查 KV token:* → 校验未吊销/未过期 → 否则 401
4. 命中 → 注入 token 上下文 → 进入业务 handler
5. 业务结束 → 写 audit_logs
```

> uuid 不符返回 **404 而非 403**：让扫描者无法区分"入口错"还是"没权限"，最大化隐藏入口。
> 限流用 Cloudflare 原生 Rate Limiting binding（平台提供、精确、免运维），不用 KV 计数（KV 最终一致，限流会漏）。

### 5.2 上传版本数据流

`POST /:uuid/admin/plugins/:name/releases`，**raw body 直传 zip**（非 multipart）。

> **为什么不用 multipart 流式**：Workers 单请求内存有限，且 zip 的中央目录在文件末尾，
> 流式写出后无法再解析 manifest。插件包通常仅几 MB，故采用"整包读入内存"处理，简单可靠。

```
CLI 端                              Worker 端
─────────                           ─────────
打包 zip                        →   校验 Content-Length ≤ 25MB，超限直接 413
本地算 sha256 + Ed25519 签名     →   读入内存（ArrayBuffer）
（随请求头带 sha256/signature）      复算 sha256，与请求头比对，不符 → 422（未写任何存储）
                                    解析 zip 内 manifest.json，缺字段 → 422
                                    服务端强制覆盖 name/author/version（以 D1 为准）
                                    写 R2：zip 包 + 提取的 README
                                    D1 batch：插入 releases（UNIQUE 防重复）+ 更新 plugins.latest_version
                                       └ 若 D1 失败 → 删除刚写入的 R2 对象（补偿回滚）
                                    失效 KV cache:plugins:list
                                    写 audit_logs
                                ←   返回 { release_id, version, sha256, size }
```

- **包大小上限 25MB**：对插件包足够，且让"内存内处理"在 Workers 限制内安全。超限返回 413。
- **幂等性**：同 `name+version+channel` 重传命中 D1 UNIQUE → 返回 409，提示升版本号，绝不覆盖已发布包。
- **孤儿防护**：sha256 校验在写存储前完成；R2 先于 D1 写，D1 失败补偿删除 R2，杜绝"有包无记录/有记录无包"。

### 5.3 下载数据流（公开 + 缓存）

```
GET /dl/:name/:version
1. 查 D1 → 拿 r2_key（命中缓存优先）
2. 先查 CF Cache API（caches.default）；命中直接返回
3. 未命中 → 从 R2 取对象 → 设 Cache-Control（如 public, max-age=86400, immutable）→ 回填 Cache API
4. ctx.waitUntil() 异步累加 download_stats，不阻塞响应
```

> 缓存生效以**绑定自定义域**为前提（见 §2 部署前提）。大包可选直接 302 到 R2 自定义域，进一步省 Worker CPU 与带宽。

## 6. 错误处理

| 场景 | HTTP | code | 说明 |
|------|------|------|------|
| 网关 uuid 错 | 404 | - | 伪装资源不存在 |
| 限流触发 | 429 | 1002 | 失败次数过多 |
| 令牌缺失/无效/过期/吊销 | 401 | 1001 | 不区分原因 |
| 包体超限 | 413 | 2004 | 超过 25MB 上限 |
| 校验和不匹配 | 422 | 2001 | 未写入任何存储 |
| 版本重复 | 409 | 2002 | 提示升版本号 |
| manifest 缺失/非法 | 422 | 2003 | 指出缺哪个字段 |
| 插件/版本不存在 | 404 | 3001 | |
| R2/D1 故障 | 503 | 5001 | 可重试，记录日志 |

**原则**：sha256 校验先于写存储；R2 先于 D1，D1 失败补偿删 R2，杜绝孤儿状态。

## 7. manifest.json 约定

服务端在上传时强制覆盖 `name`/`author`/`version`（以数据库为准），其余字段取自 zip 内 manifest：

```json
{
  "manifest_version": 1,
  "name": "demo-pay",
  "title": "示例支付插件",
  "author": "xarr",
  "description": "…",
  "homepage": "",
  "version": "1.0.0",
  "min_program_version": "1.5.0",
  "type": 1
}
```

## 8. 项目结构

```
cf-plugin-store/
├─ src/
│  ├─ index.ts            # Hono app 入口 + 路由挂载
│  ├─ routes/             # public.ts / admin.ts
│  ├─ middleware/         # gateway.ts(uuid) / auth.ts(token) / ratelimit.ts / audit.ts
│  ├─ services/           # plugins / releases / tokens / storage(R2) / db(D1)
│  ├─ lib/                # manifest 解析、sha256、Ed25519 验签、响应包络
│  └─ types.ts
├─ migrations/            # D1 SQL 迁移（0001_init.sql …）
├─ test/                  # Vitest + @cloudflare/vitest-pool-workers
├─ cli/                   # Node CLI：init / pack / publish
│  └─ bin/xplugin.ts
├─ wrangler.toml          # D1/R2/KV + Rate Limiting binding
└─ package.json
```

## 9. CLI 设计（Node，npm-publish 风格）

```
xplugin init [name]      # 在当前目录生成插件骨架（manifest.json + 示例文件 + 密钥提示）
xplugin pack             # 读取插件目录 → 校验 manifest → 打包 zip → 算 sha256
xplugin publish          # pack + Ed25519 签名 + 携带 uuid+token 以 raw body 推送到 Worker
                         #   --channel beta  指定通道
                         #   --dry-run       仅本地校验与打包，不上传
```

配置（`~/.xplugin/config.json` 或环境变量）：服务 base URL、gateway uuid、令牌、签名私钥路径。

## 10. 测试策略（TDD）

使用 Cloudflare 官方 `@cloudflare/vitest-pool-workers`，在真实 Workers runtime 跑，带 D1/R2/KV 内存模拟。

- **单元**：manifest 解析、sha256、Ed25519 签名/验签、令牌哈希校验、响应包络。
- **集成**：完整上传流程、版本重复 409、包超限 413、校验和失败 422、uuid 错误 404、令牌过期 401、限流 429、更新检查、下载缓存命中。
- **CLI**：pack 产物正确性、publish 与本地 mock Worker 联调、dry-run。

先写测试，再写实现。

## 11. 扩展决策记录（评审结论）

### 已纳入本版
- 🔴 包签名（Ed25519，字段+流程先埋）、发布通道 channel、manifest_version。
- 🟡 下载缓存策略、更新检查 API、管理端限流（CF 原生 binding）、下载计数。

### 落地可行性修正（评审第二轮）
- 上传改为 **raw body + 内存内处理 + 25MB 上限**（规避 Workers 流式/内存/zip 解析冲突）。
- 限流改用 **Cloudflare 原生 Rate Limiting binding**（KV 最终一致，限流不精确）。
- 明确 **下载缓存以绑定自定义域为前提**。

### 明确不做（YAGNI）
- 多作者/协作、插件间依赖、全文搜索、发布 Webhook/通知。

### 可选（优先级低，后续按需）
- OpenAPI 文档（Hono + zod-openapi 自动生成）。
- 大包 302 直连 R2 自定义域。

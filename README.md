# CF Plugin Store

私有插件分发服务，运行于 Cloudflare Workers（Hono + D1 + R2 + KV）。提供后台管理、授权下载入口，并可作为「插件源」直接对接 [merchant-server](https://github.com/) 的应用商店。

## 特性

- **双层安全**：自定义后台密路径（`ADMIN_PATH`）+ 多个授权下载入口 UUID + Bearer 令牌
- **机密全程加密**：`ADMIN_TOKEN` / `ADMIN_PATH` / `GATEWAY_UUID_SEED` 用 Cloudflare Secret 存储，不落配置文件
- **离线 UI**：Shoelace + fflate 已打包内联，不依赖外部 CDN
- **插件源接入**：下载入口提供 `/source` 端点，粘贴进 merchant-server 仓库地址即可同步安装
- **CI/CD**：push 到 `main` 经 GitHub Actions 自动部署

## 技术栈

Cloudflare Workers · Hono 4 · D1（SQLite）· R2（对象存储）· KV · wrangler 3

---

## 本地开发

```bash
npm install
cp wrangler.toml.example wrangler.toml      # 填入你的 account_id / database_id / kv id
npm run dev
```

本地后台需要机密，放在 `.dev.vars`（已被 `.gitignore` 忽略）：

```
ADMIN_TOKEN="本地任意令牌"
ADMIN_PATH="console-dev"
GATEWAY_UUID_SEED="本地任意uuid"
```

测试：`npm test`（Worker）、`npm run test:cli`（CLI）。

---

## 部署

> ⚠️ 真实的 `wrangler.toml`（含账户/资源 ID）已被 `.gitignore` 忽略，不在版本库；仓库里是 `wrangler.toml.example`。

### 方式一：一键脚本（推荐首次部署）

```bash
./node_modules/.bin/wrangler login
bash deploy.sh
```

脚本会创建 D1/KV/R2，生成 `wrangler.toml` 并注入资源 ID，部署 Worker，再交互式设置三个 Cloudflare Secret，最后打印后台入口、管理员令牌和默认下载入口。**请妥善保管输出的令牌——它是 secret，无法再从配置查阅。**

### 方式二：手动

```bash
# 1. 创建资源（已存在则复用），把输出的 id 填进 wrangler.toml
./node_modules/.bin/wrangler d1 create plugin_store
./node_modules/.bin/wrangler kv namespace create KV
./node_modules/.bin/wrangler r2 bucket create plugin-store-packages

# 2. 首次建表（仅全新数据库；已有自定义表结构的库请跳过，见下方注意）
./node_modules/.bin/wrangler d1 migrations apply plugin_store --remote --config ./wrangler.toml

# 3. 部署
./node_modules/.bin/wrangler deploy --config ./wrangler.toml

# 4. 设置三个机密（部署后才能设；交互输入，不会进 shell 历史）
./node_modules/.bin/wrangler secret put ADMIN_TOKEN --config ./wrangler.toml
./node_modules/.bin/wrangler secret put ADMIN_PATH --config ./wrangler.toml
./node_modules/.bin/wrangler secret put GATEWAY_UUID_SEED --config ./wrangler.toml
```

> 务必带 `--config ./wrangler.toml`：若你的项目在某个 monorepo 子目录里，不带它时 wrangler 可能向上找到父目录的配置而出错或误操作到别的 Worker。

### 方式三：GitHub Actions 自动部署（持续集成）

`.github/workflows/deploy.yml` 已就绪：push 到 `main` 自动部署，也可在 Actions 页手动触发。需要先在仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（用「Edit Cloudflare Workers」模板创建） |
| `CF_ACCOUNT_ID` | 你的 account id |
| `CF_D1_DATABASE_ID` | D1 database id |
| `CF_KV_ID` | KV namespace id |

三个运行时机密（`ADMIN_TOKEN` 等）已是 Cloudflare Secret，CI **不需要**管理；workflow 也**不会**自动跑 D1 迁移。

---

## 安全模型

| 角色 | 入口 | 凭证 |
|---|---|---|
| 管理员 | `GET /<ADMIN_PATH>` 后台登录页 | `ADMIN_TOKEN`（Bearer） |
| 下载方 | `GET /<下载入口uuid>` 橱窗 + 下载 | 入口 uuid 本身即授权（可签发多个、可吊销） |
| 公开 | `GET /` 橱窗，仅展示不可下载 | 无 |

非法路径一律 404。下载入口在后台「下载入口」里签发/吊销。

## 接口速览

- **公开**：`GET /`、`GET /api/plugins`、`GET /api/plugins/:name`、`GET /api/plugins/:name/check-update`
- **下载入口（uuid）**：`GET /:uuid`（橱窗）、`GET /:uuid/dl/:name/:version`（授权下载）、`GET /:uuid/source` 与 `POST /:uuid/api/v1/download/ticket`（merchant-server 插件源）
- **后台（`/<ADMIN_PATH>` + Bearer）**：插件、版本、令牌、下载入口的增删管理

## 对接 merchant-server

把下载入口的 source 地址填进 merchant-server 后台「应用商店 / 仓库地址」：

```
https://<你的域名>/<下载入口uuid>/source
```

刷新即可同步插件列表并安装（uuid 透传授权，走票据下载流程）。

## 注意：D1 迁移

`migrations/0001_init.sql` 是初始建表脚本，仅用于**全新数据库**。若你的线上库是用其它方式建的、表结构有自定义列，**改 schema 前务必以线上实际为准**，不要直接套用迁移文件，以免结构冲突。

---

设计文档见 `docs/superpowers/specs/2026-06-07-cf-plugin-store-design.md`。

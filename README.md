<div align="center">

# XArr Plugin Store

**XArr 生态 · 插件分发服务**

基于 Cloudflare Workers 的插件商店后端,为 [XArr Pay](https://docs.xarr.cn) 商户系统提供插件托管、授权下载与一键接入的「插件源」。

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Hono-4-E36002)](https://hono.dev/)
[![Deploy](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions&logoColor=white)](#方式三github-actions-自动部署)

</div>

---

## 关于 XArr

**XArr** 是一套企业级产品体系,涵盖官网门户、**XArr Pay 支付系统(商户版)** 等模块,文档见 [docs.xarr.cn](https://docs.xarr.cn)。

**XArr Plugin Store** 是其中的插件分发组件:商户在 XArr Pay 后台填入一个授权地址,即可同步、安装由本服务托管的插件——无需各自打包分发,集中管理、按需授权。

```
┌─────────────────┐      插件源地址 /<uuid>/source     ┌──────────────────────┐
│  XArr Plugin     │ ─────────────────────────────────► │  XArr Pay 商户系统     │
│  Store (本服务)   │      列表同步 · 票据下载 · 安装       │  (merchant-server)    │
└─────────────────┘                                     └──────────────────────┘
```

---

## 特性

- 🔐 **双层安全** — 自定义后台密路径 + 多个可吊销的授权下载入口 + Bearer 令牌
- 🗝️ **机密零落盘** — 令牌/密路径/入口种子全部用 Cloudflare Secret 加密存储
- 🔌 **即插即用的插件源** — 一个 `/source` 地址直接对接 XArr Pay,列表同步 + 票据下载
- 📦 **完全离线 UI** — Shoelace + fflate 已打包内联,不依赖任何外部 CDN
- ⚡ **边缘运行** — Cloudflare Workers 全球边缘,D1 + R2 + KV 一体
- 🚀 **持续部署** — push `main` 经 GitHub Actions 自动上线

## 技术栈

`Cloudflare Workers` · `Hono 4` · `D1 (SQLite)` · `R2` · `KV` · `wrangler 3` · `TypeScript`

---

## 快速开始

```bash
npm install
cp wrangler.toml.example wrangler.toml   # 填入你的 account_id / database_id / kv id
npm run dev                              # 本地开发
npm test                                 # 运行测试
```

> 本地后台所需机密放在 `.dev.vars`(已被 `.gitignore` 忽略):
> ```
> ADMIN_TOKEN="本地任意令牌"
> ADMIN_PATH="console-dev"
> GATEWAY_UUID_SEED="本地任意uuid"
> ```

---

## 部署

> ⚠️ 真实的 `wrangler.toml`(含账户/资源 ID)已被 `.gitignore` 忽略,不在版本库;仓库里是 `wrangler.toml.example` 模板。

### 方式一 · 一键脚本(推荐首次部署)

```bash
./node_modules/.bin/wrangler login
bash deploy.sh
```

自动创建 D1/KV/R2 → 生成 `wrangler.toml` 注入资源 ID → 部署 → 交互式设置三个 Secret → 打印后台入口、管理员令牌与默认下载入口。

> **请妥善保管脚本输出的管理员令牌** —— 它是 Secret,之后无法再从配置查阅。

### 方式二 · 手动

```bash
# 1. 创建资源(已存在则复用),把输出的 id 填进 wrangler.toml
./node_modules/.bin/wrangler d1 create plugin_store
./node_modules/.bin/wrangler kv namespace create KV
./node_modules/.bin/wrangler r2 bucket create plugin-store-packages

# 2. 首次建表(仅全新数据库;已有自定义表结构请跳过)
./node_modules/.bin/wrangler d1 migrations apply plugin_store --remote --config ./wrangler.toml

# 3. 部署
./node_modules/.bin/wrangler deploy --config ./wrangler.toml

# 4. 设置三个机密(部署后才能设;交互输入,不进 shell 历史)
./node_modules/.bin/wrangler secret put ADMIN_TOKEN --config ./wrangler.toml
./node_modules/.bin/wrangler secret put ADMIN_PATH --config ./wrangler.toml
./node_modules/.bin/wrangler secret put GATEWAY_UUID_SEED --config ./wrangler.toml
```

> 务必带 `--config ./wrangler.toml`:在 monorepo 子目录中,不带它时 wrangler 可能向上找到父目录配置而出错或误操作到别的 Worker。

### 方式三 · GitHub Actions 自动部署

`.github/workflows/deploy.yml` 已就绪:push 到 `main` 自动部署,也可在 Actions 页手动触发。先在仓库 **Settings → Secrets and variables → Actions** 添加:

| Secret | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token(用「Edit Cloudflare Workers」模板创建) |
| `CF_ACCOUNT_ID` | 你的 account id |
| `CF_D1_DATABASE_ID` | D1 database id |
| `CF_KV_ID` | KV namespace id |

三个运行时机密(`ADMIN_TOKEN` 等)已是 Cloudflare Secret,CI **无需**管理;workflow 也**不会**自动跑 D1 迁移。

---

## 安全模型

| 角色 | 入口 | 凭证 |
|---|---|---|
| 管理员 | `GET /<ADMIN_PATH>` 后台登录页 | `ADMIN_TOKEN`(Bearer) |
| 下载方 | `GET /<下载入口uuid>` 橱窗 + 下载 | 入口 uuid 即授权(可签发多个、可吊销) |
| 公开访问 | `GET /` | 仅显示「需授权访问」提示,不展示任何插件 |

非法路径一律返回 404。下载入口在后台「下载入口」中签发/吊销。

## 对接 XArr Pay

在 XArr Pay 商户后台「应用商店 / 仓库地址」填入下载入口的 source 地址:

```
https://<你的域名>/<下载入口uuid>/source
```

刷新即可同步插件列表并安装(uuid 透传授权,走票据下载流程)。

## 接口速览

| 分类 | 端点 |
|---|---|
| 公开 | `GET /api/plugins`、`/api/plugins/:name`、`/api/plugins/:name/check-update` |
| 下载入口 | `GET /:uuid`(橱窗)、`GET /:uuid/dl/:name/:version`(授权下载) |
| 插件源 | `GET /:uuid/source`、`POST /:uuid/api/v1/download/ticket` |
| 后台 | `/<ADMIN_PATH>` + Bearer:插件 / 版本 / 令牌 / 下载入口管理 |

---

## 注意:D1 迁移

`migrations/0001_init.sql` 仅用于**全新数据库**。若线上库以其它方式建立、表结构有自定义列,**改 schema 前务必以线上实际为准**,不要直接套用迁移文件,以免结构冲突。

## 文档

- 设计文档:[`docs/superpowers/specs/2026-06-07-cf-plugin-store-design.md`](docs/superpowers/specs/2026-06-07-cf-plugin-store-design.md)
- XArr 产品文档:[docs.xarr.cn](https://docs.xarr.cn)

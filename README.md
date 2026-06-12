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

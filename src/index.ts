import { Hono } from "hono";
import type { Env } from "./types";
import { adminRoutes } from "./routes/admin";
import { publicRoutes } from "./routes/public";
import { STORE_HTML, ADMIN_HTML } from "./ui";
import { gatewayGuard } from "./middleware/gateway";
import { rateLimitGuard } from "./middleware/ratelimit";
import { isValidGateway } from "./services/gateways";
import { sourceListHandler, downloadTicketHandler } from "./routes/source";
import { getPluginByName, getReleases, incrDownload } from "./services/db";
import { getPackage } from "./services/storage";
import shoelaceJs from "./vendor/shoelace.js.txt";
import shoelaceCss from "./vendor/shoelace.css.txt";
import fflateJs from "./vendor/fflate.js.txt";

const app = new Hono<{ Bindings: Env }>();

// 根路径:不再公开展示插件列表,仅提示需从授权路径访问。
const ROOT_NOTICE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>需要授权访问</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  background:#0b0f17;color:#e6edf3;padding:24px}
.card{max-width:420px;text-align:center;background:#11161f;border:1px solid #222b39;
  border-radius:16px;padding:40px 32px;box-shadow:0 8px 40px rgba(0,0,0,.4)}
.icon{font-size:44px;line-height:1;margin-bottom:16px}
h1{font-size:20px;margin:0 0 10px}
p{margin:0;color:#9aa7b6;font-size:14px;line-height:1.7}
</style></head><body>
<div class="card">
  <div class="icon">🔒</div>
  <h1>需要授权访问</h1>
  <p>本服务不公开展示插件列表。<br>请通过你获得的授权地址访问。</p>
</div>
</body></html>`;
app.get("/", (c) => c.html(ROOT_NOTICE_HTML));
// 健康检查
app.get("/healthz", (c) => c.json({ ok: true, version: "0.2.0" }));
// 离线静态资源(Shoelace/fflate,产物内联进 Worker;不可变长缓存)
const JS_HDR = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" };
app.get("/vendor/shoelace.js", () => new Response(shoelaceJs, { headers: JS_HDR }));
app.get("/vendor/shoelace.css", () => new Response(shoelaceCss, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } }));
app.get("/vendor/fflate.js", () => new Response(fflateJs, { headers: JS_HDR }));
// 公开只读 API(/api/plugins ...)
app.route("/", publicRoutes);

// merchant-server 插件源接入(响应 code:200):列表 + 下载票据。均经 gatewayGuard 鉴权。
// 注册在 /:gate 子应用之前,确保多段路由不被 adminRoutes 的 use("*") 吞掉。
app.get("/:uuid/source", rateLimitGuard, gatewayGuard, sourceListHandler);
app.post("/:uuid/api/v1/download/ticket", rateLimitGuard, gatewayGuard, downloadTicketHandler);

// 授权下载:必须通过有效下载入口 UUID(支持多个)。注册在 /:gate 子应用之前,确保不被吞。
app.get("/:uuid/dl/:name/:version", rateLimitGuard, gatewayGuard, async (c) => {
  const name = c.req.param("name"), version = c.req.param("version");
  const p = await getPluginByName(c.env, name);
  if (!p) return c.json({ code: 3001, message: "插件不存在", data: null }, 404);
  const target = version === "latest" ? (p.latest_version ?? "") : version;
  const rels = await getReleases(c.env, p.id);
  const rel = rels.find((r: any) => r.version === target) as any;
  if (!rel) return c.json({ code: 3001, message: "版本不存在", data: null }, 404);
  const obj = await getPackage(c.env, rel.r2_key);
  if (!obj) return c.json({ code: 3001, message: "包文件丢失", data: null }, 404);
  await incrDownload(c.env, p.id, target);
  const body = await obj.arrayBuffer();
  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}-${target}.zip"`,
      "Content-SHA256": rel.sha256 ?? "",
      // URL 含授权 uuid 凭证:禁止任何共享/中间缓存存储私有插件包
      "Cache-Control": "private, no-store",
    },
  });
});

// 单段动态路由:后台页(== ADMIN_PATH) 或 下载橱窗(有效 UUID)。
// 必须注册在 /:gate 子应用之前 —— 否则 adminRoutes 的 use("*") 会吞掉 bare 单段请求。
app.get("/:seg", async (c) => {
  const seg = c.req.param("seg") ?? "";
  if (c.env.ADMIN_PATH && seg === c.env.ADMIN_PATH) {
    return c.html(ADMIN_HTML.split("__ADMIN_BASE__").join("/" + seg));
  }
  if (await isValidGateway(c.env, seg)) {
    return c.html(STORE_HTML.split("__DL_BASE__").join("/" + seg));
  }
  return c.notFound();
});

// 后台管理 API(多段子路径):挂在 /:gate(内部 adminPathGuard 校验 == ADMIN_PATH,再令牌鉴权)
app.route("/:gate", adminRoutes);

export default app;

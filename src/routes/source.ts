import type { Context } from "hono";
import type { Env } from "../types";
import { listPublishedForSource, getPluginByUuid } from "../services/db";

// merchant-server 插件源契约:响应 code 必须为 200(与本项目内部 {code:0} 不同)。
// 路由均挂在下载入口 /:uuid 下(gatewayGuard 鉴权);uuid = 下载授权入口,与插件自身 uuid 不同。

// GET /:uuid/source —— 用户填入 merchant-server「仓库地址」的 URL。
// merchant-server 会自动追加 ?open_id=&version=&version_time=&version_code=
export async function sourceListHandler(c: Context<{ Bindings: Env }>) {
  const gw = c.req.param("uuid") ?? "";
  const origin = new URL(c.req.url).origin;
  const base = `${origin}/${gw}`; // 既是 source_site,也是下载地址前缀
  const rows = await listPublishedForSource(c.env);
  const plugins = rows.map((p) => {
    const ver = p.latest_version ?? "";
    return {
      uuid: p.uuid,
      title: p.title,
      name: p.name,
      type: p.type,
      description: p.description ?? "",
      version: ver,
      min_program_version: p.min_program_version ?? "",
      author: p.author ?? "",
      homepage: p.homepage ?? "",
      preview_url: "",
      preview_img_url: (p as any).preview_img_url ?? "",
      external_support_url: "",
      external_repository_url: (p as any).repository_url ?? "",
      // 直链安装:download_install_type=2,download_url 给绝对地址(实际下载仍走票据流程)
      download_url: `${base}/dl/${encodeURIComponent(p.name)}/${encodeURIComponent(ver)}`,
      download_install_type: 2,
      app_url: "",
      amount: 0,
      pay_status: 0,
      // 关键:source_site 带上 /:uuid 路径 —— merchant-server 据此 POST {source_site}/api/v1/download/ticket
      source_site: base,
      update_time: p.updated_at,
    };
  });
  return c.json({ code: 200, message: "ok", data: { name: "cf-plugin-store", author: "", plugins } });
}

// POST /:uuid/api/v1/download/ticket —— merchant-server 安装前申请下载票据
// body: { open_id, uuid(插件uuid), version, version_code }
export async function downloadTicketHandler(c: Context<{ Bindings: Env }>) {
  const gw = c.req.param("uuid") ?? "";
  const origin = new URL(c.req.url).origin;
  const body = await c.req.json().catch(() => ({} as any));
  const pluginUuid = String(body?.uuid ?? "");
  const version = String(body?.version ?? "").trim();
  if (!pluginUuid) return c.json({ code: 400, message: "缺少 uuid", data: null }, 200);
  const p = await getPluginByUuid(c.env, pluginUuid);
  if (!p) return c.json({ code: 404, message: "插件不存在", data: null }, 200);
  const target = version || p.latest_version || "";
  if (!target) return c.json({ code: 404, message: "无可用版本", data: null }, 200);
  // 下载入口 uuid 已是授权凭证,download_url 直接指向 /:uuid/dl/:name/:version(绝对地址)
  const downloadUrl = `${origin}/${gw}/dl/${encodeURIComponent(p.name)}/${encodeURIComponent(target)}`;
  // expire_at 仅供 merchant-server 校验展示;真正鉴权靠路径中的入口 uuid
  const expireAt = Math.floor(Date.now() / 1000) + 600;
  return c.json({ code: 200, message: "ok", data: { ticket: gw, download_url: downloadUrl, expire_at: expireAt, content_length: 0 } });
}

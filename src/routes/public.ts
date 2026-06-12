import { Hono } from "hono";
import type { Env } from "../types";
import { ok, err } from "../lib/response";
import { listPlugins, getPluginByName, getReleases } from "../services/db";

export const publicRoutes = new Hono<{ Bindings: Env }>();

function gt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

// 列表:GET /api/plugins?type=&q= (公开元数据,不含下载入口)
publicRoutes.get("/api/plugins", async (c) => {
  const type = c.req.query("type"), q = c.req.query("q");
  const rows = await listPlugins(c.env, { type: type ? Number(type) : undefined, q: q || undefined });
  return ok(rows.map((p) => ({
    name: p.name, title: p.title, type: p.type, author: p.author,
    description: p.description, latest_version: p.latest_version,
  })));
});

// 详情:GET /api/plugins/:name -> { plugin, releases }
// 公开接口:仅返回展示所需字段,严禁泄露 uuid / r2_key / sha256 / signature 等内部信息。
publicRoutes.get("/api/plugins/:name", async (c) => {
  const p = await getPluginByName(c.env, c.req.param("name"));
  if (!p) return err(3001, "插件不存在", 404);
  const releases = (await getReleases(c.env, p.id)).map((r: any) => ({
    version: r.version,
    channel: r.channel,
    package_size: r.package_size,
    min_program_version: r.min_program_version ?? null,
    changelog: r.changelog ?? null,
    created_at: r.created_at,
  }));
  const plugin = {
    name: p.name, title: p.title, type: p.type, author: p.author,
    description: p.description, homepage: p.homepage,
    latest_version: p.latest_version, created_at: p.created_at, updated_at: p.updated_at,
  };
  return ok({ plugin, releases });
});

// 检查更新:GET /api/plugins/:name/check-update?current=
publicRoutes.get("/api/plugins/:name/check-update", async (c) => {
  const p = await getPluginByName(c.env, c.req.param("name"));
  if (!p) return err(3001, "插件不存在", 404);
  const current = c.req.query("current") ?? "0.0.0";
  const latest = p.latest_version ?? "0.0.0";
  return ok({ has_update: gt(latest, current), latest, min_program_version: null });
});

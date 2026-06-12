import { Hono } from "hono";
import type { Env } from "../types";
import { adminPathGuard } from "../middleware/gateway";
import { authGuard } from "../middleware/auth";
import { rateLimitGuard } from "../middleware/ratelimit";
import { ok, err } from "../lib/response";
import { parseManifestFromZip, extractReadme, ManifestError } from "../lib/manifest";
import { sha256Hex } from "../lib/hash";
import { createPlugin, getPluginByName, insertReleaseAtomic, writeAudit, listAllPlugins, updatePlugin, setPluginStatus, softDeletePlugin, getReleases, getAllReleases, setReleaseStatus, deleteReleaseRow, deleteDownloadStats, recomputeLatest, hardDeletePlugin } from "../services/db";
import { packageKey, readmeKey, putPackage, deletePackage } from "../services/storage";
import { issueToken, listTokens, revokeToken } from "../services/tokens";
import { listGateways, issueGateway, revokeGateway } from "../services/gateways";

const MAX_SIZE = 25 * 1024 * 1024;

// 仅承载后台 API(多段路由),挂在 /:gate;页面入口在 index.ts 的单段分发器里。
export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", rateLimitGuard);
adminRoutes.use("*", adminPathGuard);
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

// 下载入口(UUID)管理:列出 / 签发 / 吊销
adminRoutes.get("/gateways", async (c) => ok(await listGateways(c.env)));

adminRoutes.post("/gateways", async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const { uuid } = await issueGateway(c.env, b.name ?? "未命名");
  await writeAudit(c.env, { action: "issue_gateway", target: uuid, ...meta(c) });
  return ok({ uuid });
});

adminRoutes.delete("/gateways/:uuid", async (c) => {
  const uuid = c.req.param("uuid");
  await revokeGateway(c.env, uuid);
  await writeAudit(c.env, { action: "revoke_gateway", target: uuid, ...meta(c) });
  return ok({ revoked: uuid });
});

// 管理台:列出全部插件(含下架/草稿)
adminRoutes.get("/plugins", async (c) => ok(await listAllPlugins(c.env)));

// 管理台:某插件详情 + 全部版本(含已下架,故用 getAllReleases)
adminRoutes.get("/plugins/:name", async (c) => {
  const plugin = await getPluginByName(c.env, c.req.param("name"));
  if (!plugin) return err(3001, "插件不存在", 404);
  const releases = await getAllReleases(c.env, plugin.id);
  return ok({ plugin, releases });
});

// 管理台:上架(1)/下架(2)某个版本(可恢复,不删文件)
adminRoutes.patch("/plugins/:name/releases/:version/status", async (c) => {
  const name = c.req.param("name"), version = c.req.param("version");
  const channel = c.req.query("channel") || "stable";
  const plugin = await getPluginByName(c.env, name);
  if (!plugin) return err(3001, "插件不存在", 404);
  const b = await c.req.json().catch(() => ({} as any));
  const status = Number(b.status);
  if (status !== 1 && status !== 2) return err(2003, "status 仅支持 1(上架)/2(下架)", 422);
  const hit = await setReleaseStatus(c.env, plugin.id, version, channel, status);
  if (!hit) return err(3001, "版本不存在", 404);
  await recomputeLatest(c.env, plugin.id);
  await writeAudit(c.env, { action: "set_release_status", target: `${name}@${version}:${status}`, ...meta(c) });
  return ok({ name, version, channel, status });
});

// 管理台:删除某个版本(物理删 R2 文件 + DB 记录,不可恢复)
adminRoutes.delete("/plugins/:name/releases/:version", async (c) => {
  const name = c.req.param("name"), version = c.req.param("version");
  const channel = c.req.query("channel") || "stable";
  const plugin = await getPluginByName(c.env, name);
  if (!plugin) return err(3001, "插件不存在", 404);
  const all = await getAllReleases(c.env, plugin.id);
  const target = all.find((r: any) => r.version === version && r.channel === channel) as any;
  if (!target) return err(3001, "版本不存在", 404);
  await deleteReleaseRow(c.env, plugin.id, version, channel);
  const rest = all.filter((r: any) => !(r.version === version && r.channel === channel));
  // R2 zip:仅当没有其他版本记录引用同一 r2_key 时才删除(同 version 多 channel 共用文件)
  if (target.r2_key && !rest.some((r: any) => r.r2_key === target.r2_key)) await deletePackage(c.env, target.r2_key);
  // README + 下载统计:仅当该 version 已无任何记录时清理
  if (!rest.some((r: any) => r.version === version)) {
    await deletePackage(c.env, readmeKey(plugin.uuid, version));
    await deleteDownloadStats(c.env, plugin.id, version);
  }
  if (plugin.latest_version === version) await recomputeLatest(c.env, plugin.id);
  await writeAudit(c.env, { action: "delete_release", target: `${name}@${version}`, ...meta(c) });
  return ok({ deleted: `${name}@${version}` });
});

// 管理台:彻底删除插件(级联物理删所有版本 R2 文件 + 全部 DB 记录,不可恢复)
adminRoutes.delete("/plugins/:name/purge", async (c) => {
  const name = c.req.param("name");
  const plugin = await getPluginByName(c.env, name);
  if (!plugin) return err(3001, "插件不存在", 404);
  const all = await getAllReleases(c.env, plugin.id);
  // 先删 R2:去重 zip 的 r2_key,并按 version 去重删 README
  const keys = new Set<string>();
  const versions = new Set<string>();
  for (const r of all as any[]) {
    if (r.r2_key) keys.add(r.r2_key);
    if (r.version) versions.add(r.version);
  }
  for (const k of keys) await deletePackage(c.env, k);
  for (const v of versions) await deletePackage(c.env, readmeKey(plugin.uuid, v));
  await hardDeletePlugin(c.env, plugin.id);
  await writeAudit(c.env, { action: "purge_plugin", target: name, ...meta(c) });
  return ok({ purged: name, releases: all.length });
});

// 管理台:更新插件元信息
adminRoutes.patch("/plugins/:name", async (c) => {
  const name = c.req.param("name");
  if (!(await getPluginByName(c.env, name))) return err(3001, "插件不存在", 404);
  const b = await c.req.json().catch(() => ({} as any));
  await updatePlugin(c.env, name, {
    title: b.title, author: b.author, description: b.description, homepage: b.homepage,
    type: b.type !== undefined ? Number(b.type) : undefined,
  });
  await writeAudit(c.env, { action: "update_plugin", target: name, ...meta(c) });
  return ok({ name });
});

// 管理台:上架(1)/下架(2)
adminRoutes.patch("/plugins/:name/status", async (c) => {
  const name = c.req.param("name");
  if (!(await getPluginByName(c.env, name))) return err(3001, "插件不存在", 404);
  const b = await c.req.json().catch(() => ({} as any));
  const status = Number(b.status);
  if (status !== 1 && status !== 2) return err(2003, "status 仅支持 1(上架)/2(下架)", 422);
  await setPluginStatus(c.env, name, status);
  await writeAudit(c.env, { action: "set_status", target: `${name}:${status}`, ...meta(c) });
  return ok({ name, status });
});

// 管理台:软删除插件
adminRoutes.delete("/plugins/:name", async (c) => {
  const name = c.req.param("name");
  if (!(await getPluginByName(c.env, name))) return err(3001, "插件不存在", 404);
  await softDeletePlugin(c.env, name);
  await writeAudit(c.env, { action: "delete_plugin", target: name, ...meta(c) });
  return ok({ deleted: name });
});

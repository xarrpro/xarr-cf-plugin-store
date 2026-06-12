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
  const existing = await env.DB.prepare(
    `SELECT id FROM releases WHERE plugin_id = ? AND version = ? AND channel = ?`,
  ).bind(r.pluginId, r.version, r.channel).first();
  if (existing) throw new Error("UNIQUE constraint failed: releases.plugin_id, releases.version, releases.channel");
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

// 管理台:列出全部插件(含下架/草稿,仅排除已软删)
export async function listAllPlugins(env: Env): Promise<PluginRow[]> {
  return (await env.DB.prepare(
    `SELECT * FROM plugins WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
  ).all<PluginRow>()).results ?? [];
}

// 按 uuid 查插件(merchant-server 下载票据按插件 uuid 索引)
export async function getPluginByUuid(env: Env, uuid: string): Promise<PluginRow | null> {
  return await env.DB.prepare(`SELECT * FROM plugins WHERE uuid = ? AND deleted_at IS NULL`).bind(uuid).first<PluginRow>();
}

// 插件源(merchant-server)用:已上架且有稳定版本的插件 + 其 latest 版本的 min_program_version,一次查出
export async function listPublishedForSource(env: Env): Promise<Array<PluginRow & { min_program_version: string | null }>> {
  return (await env.DB.prepare(
    `SELECT p.*, r.min_program_version AS min_program_version
       FROM plugins p
       LEFT JOIN releases r ON r.plugin_id = p.id AND r.version = p.latest_version AND r.channel = 'stable' AND r.status = 1
      WHERE p.deleted_at IS NULL AND p.status = 1 AND p.latest_version IS NOT NULL
      ORDER BY p.updated_at DESC`,
  ).all<PluginRow & { min_program_version: string | null }>()).results ?? [];
}

// 管理台:更新插件元信息(仅更新传入字段)
export async function updatePlugin(env: Env, name: string, patch: {
  title?: string; author?: string; description?: string; homepage?: string; type?: number;
}): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) { sets.push("title = ?"); binds.push(patch.title); }
  if (patch.author !== undefined) { sets.push("author = ?"); binds.push(patch.author); }
  if (patch.description !== undefined) { sets.push("description = ?"); binds.push(patch.description); }
  if (patch.homepage !== undefined) { sets.push("homepage = ?"); binds.push(patch.homepage); }
  if (patch.type !== undefined) { sets.push("type = ?"); binds.push(Number(patch.type)); }
  if (sets.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  sets.push("updated_at = ?"); binds.push(now);
  binds.push(name);
  await env.DB.prepare(`UPDATE plugins SET ${sets.join(", ")} WHERE name = ? AND deleted_at IS NULL`).bind(...binds).run();
}

// 管理台:上架(1)/下架(2)
export async function setPluginStatus(env: Env, name: string, status: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE plugins SET status = ?, updated_at = ? WHERE name = ? AND deleted_at IS NULL`,
  ).bind(status, now, name).run();
}

// 管理台:软删除(仅打标记,不动版本/文件,可恢复)
export async function softDeletePlugin(env: Env, name: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE plugins SET deleted_at = ?, updated_at = ? WHERE name = ? AND deleted_at IS NULL`,
  ).bind(now, now, name).run();
}

// 管理台:某插件全部版本(含已下架),供后台版本管理使用
export async function getAllReleases(env: Env, pluginId: number) {
  return (await env.DB.prepare(
    `SELECT * FROM releases WHERE plugin_id = ? ORDER BY created_at DESC`,
  ).bind(pluginId).all()).results ?? [];
}

// 下架(2)/上架(1)某个版本;返回是否命中
export async function setReleaseStatus(env: Env, pluginId: number, version: string, channel: string, status: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE releases SET status = ? WHERE plugin_id = ? AND version = ? AND channel = ?`,
  ).bind(status, pluginId, version, channel).run();
  return ((r.meta as any)?.changes ?? 0) > 0;
}

// 删除单条版本记录(仅 DB 行,R2 文件由路由层处理)
export async function deleteReleaseRow(env: Env, pluginId: number, version: string, channel: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM releases WHERE plugin_id = ? AND version = ? AND channel = ?`,
  ).bind(pluginId, version, channel).run();
}

// 删除某版本的下载统计
export async function deleteDownloadStats(env: Env, pluginId: number, version: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM download_stats WHERE plugin_id = ? AND version = ?`,
  ).bind(pluginId, version).run();
}

// 重算 latest_version:取剩余「上架的 stable」中最新一条
export async function recomputeLatest(env: Env, pluginId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT version FROM releases WHERE plugin_id = ? AND channel = 'stable' AND status = 1 ORDER BY created_at DESC LIMIT 1`,
  ).bind(pluginId).first<{ version: string }>();
  await env.DB.prepare(`UPDATE plugins SET latest_version = ?, updated_at = ? WHERE id = ?`)
    .bind(row?.version ?? null, now, pluginId).run();
}

// 彻底删除插件的全部 DB 记录(releases + 下载统计 + 插件行);R2 文件由路由层先行删除
export async function hardDeletePlugin(env: Env, pluginId: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM releases WHERE plugin_id = ?`).bind(pluginId),
    env.DB.prepare(`DELETE FROM download_stats WHERE plugin_id = ?`).bind(pluginId),
    env.DB.prepare(`DELETE FROM plugins WHERE id = ?`).bind(pluginId),
  ]);
}

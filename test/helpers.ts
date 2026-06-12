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

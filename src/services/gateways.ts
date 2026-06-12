import type { Env, GatewayRecord } from "../types";

// 下载入口存 KV:key = `gw:<uuid>`,uuid 即 URL 第一段。校验走精确 key 查询,无需遍历。

// 首次启动把历史 GATEWAY_UUID_SEED 迁移成第一个下载入口,保证旧分发链接不失效。
async function ensureMigrated(env: Env): Promise<void> {
  const done = await env.KV.get("config:gw_migrated");
  if (done) return;
  const seed = env.GATEWAY_UUID_SEED;
  if (seed) {
    const exist = await env.KV.get(`gw:${seed}`);
    if (!exist) {
      const rec: GatewayRecord = { name: "默认入口(迁移)", createdAt: Math.floor(Date.now() / 1000), revoked: false };
      await env.KV.put(`gw:${seed}`, JSON.stringify(rec));
    }
  }
  await env.KV.put("config:gw_migrated", "1");
}

export async function isValidGateway(env: Env, uuid: string): Promise<boolean> {
  if (!uuid) return false;
  await ensureMigrated(env);
  const raw = await env.KV.get(`gw:${uuid}`);
  if (!raw) return false;
  try {
    const rec = JSON.parse(raw) as GatewayRecord;
    return !rec.revoked;
  } catch {
    return false;
  }
}

export async function listGateways(env: Env): Promise<Array<{ uuid: string } & GatewayRecord>> {
  await ensureMigrated(env);
  const list = await env.KV.list({ prefix: "gw:" });
  const out: Array<{ uuid: string } & GatewayRecord> = [];
  for (const key of list.keys) {
    const raw = await env.KV.get(key.name);
    if (!raw) continue;
    const rec = JSON.parse(raw) as GatewayRecord;
    if (rec.revoked) continue;
    out.push({ uuid: key.name.replace("gw:", ""), ...rec });
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
}

export async function issueGateway(env: Env, name: string): Promise<{ uuid: string }> {
  await ensureMigrated(env);
  const uuid = crypto.randomUUID();
  const rec: GatewayRecord = { name: name || "未命名", createdAt: Math.floor(Date.now() / 1000), revoked: false };
  await env.KV.put(`gw:${uuid}`, JSON.stringify(rec));
  return { uuid };
}

// 吊销即物理删除该入口(下载校验按 key 存在性判断,删除后立即失效)
export async function revokeGateway(env: Env, uuid: string): Promise<void> {
  await env.KV.delete(`gw:${uuid}`);
}

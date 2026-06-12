import type { Env, TokenRecord } from "../types";
import { sha256Hex, constantTimeEqual } from "../lib/hash";

export async function verifyToken(env: Env, plaintext: string): Promise<(TokenRecord & { id: string }) | null> {
  if (!plaintext) return null;
  const hash = await sha256Hex(new TextEncoder().encode(plaintext).buffer);
  const list = await env.KV.list({ prefix: "token:" });
  const now = Math.floor(Date.now() / 1000);
  for (const key of list.keys) {
    const raw = await env.KV.get(key.name);
    if (!raw) continue;
    const rec = JSON.parse(raw) as TokenRecord;
    if (rec.revoked) continue;
    if (rec.expireAt !== 0 && rec.expireAt < now) continue;
    if (constantTimeEqual(rec.hash, hash)) return { ...rec, id: key.name.replace("token:", "") };
  }
  return null;
}

export async function issueToken(env: Env, name: string, expireAt: number): Promise<{ id: string; plaintext: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await sha256Hex(new TextEncoder().encode(plaintext).buffer);
  const id = `tok_${crypto.randomUUID().slice(0, 8)}`;
  const rec: TokenRecord = { name, hash, scope: "admin", createdAt: Math.floor(Date.now() / 1000), expireAt, revoked: false };
  await env.KV.put(`token:${id}`, JSON.stringify(rec));
  return { id, plaintext };
}

export async function revokeToken(env: Env, id: string): Promise<void> {
  const raw = await env.KV.get(`token:${id}`);
  if (!raw) return;
  const rec = JSON.parse(raw) as TokenRecord;
  rec.revoked = true;
  await env.KV.put(`token:${id}`, JSON.stringify(rec));
}

export async function listTokens(env: Env): Promise<Array<{ id: string } & Omit<TokenRecord, "hash">>> {
  const list = await env.KV.list({ prefix: "token:" });
  const out: Array<{ id: string } & Omit<TokenRecord, "hash">> = [];
  for (const key of list.keys) {
    const raw = await env.KV.get(key.name);
    if (!raw) continue;
    const { hash, ...rest } = JSON.parse(raw) as TokenRecord;
    out.push({ id: key.name.replace("token:", ""), ...rest });
  }
  return out;
}

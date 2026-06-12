import type { Env } from "../types";

export function packageKey(uuid: string, version: string, name: string): string {
  return `packages/${uuid}/${version}/${name}-${version}.zip`;
}
export function readmeKey(uuid: string, version: string): string {
  return `packages/${uuid}/${version}/README.md`;
}
export async function putPackage(env: Env, key: string, body: ArrayBuffer | ArrayBufferLike | string, contentType: string): Promise<void> {
  await env.BUCKET.put(key, body as ArrayBuffer | string, { httpMetadata: { contentType } });
}
export async function getPackage(env: Env, key: string): Promise<R2ObjectBody | null> {
  return await env.BUCKET.get(key);
}
export async function deletePackage(env: Env, key: string): Promise<void> {
  await env.BUCKET.delete(key);
}

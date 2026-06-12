import { readFileSync, existsSync } from "node:fs";
import { pack } from "./pack.ts";
import { signHex } from "./sign.ts";
import { loadConfig, assertPublishConfig, type CliConfig } from "./config.ts";

export interface PublishOptions {
  dir: string;
  channel?: string;
  dryRun?: boolean;
  config?: CliConfig;
  fetchImpl?: typeof fetch;
}

export interface PublishResult {
  dryRun: boolean;
  name: string;
  version: string;
  sha256: string;
  signature: string | null;
  created?: boolean;
  uploaded?: boolean;
  data?: unknown;
}

// pack -> 签名 -> (创建插件) -> raw body 上传
export async function publish(opts: PublishOptions): Promise<PublishResult> {
  const { zip, sha256, manifest } = pack(opts.dir);

  // 若有签名私钥则签名
  let signature: string | null = null;
  const cfg = opts.config ?? loadConfig();
  if (cfg.signKeyPath && existsSync(cfg.signKeyPath)) {
    signature = signHex(sha256, readFileSync(cfg.signKeyPath, "utf8"));
  }

  if (opts.dryRun) {
    return { dryRun: true, name: manifest.name, version: manifest.version, sha256, signature };
  }

  assertPublishConfig(cfg);
  const doFetch = opts.fetchImpl ?? fetch;
  const base = cfg.baseUrl.replace(/\/$/, "");
  const adminBase = `${base}/${cfg.gatewayUuid}/admin`;
  const authHeader = { Authorization: `Bearer ${cfg.token}` };

  // 1. 确保插件存在:先尝试创建(已存在返回 409,忽略)
  let created = false;
  const createRes = await doFetch(`${adminBase}/plugins`, {
    method: "POST",
    headers: { ...authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ name: manifest.name, title: manifest.title, type: manifest.type }),
  });
  if (createRes.status === 200) created = true;
  else if (createRes.status !== 409) {
    throw new Error(`创建插件失败: HTTP ${createRes.status}`);
  }

  // 2. 上传版本(raw body = zip)
  const channel = opts.channel ?? "stable";
  const url = `${adminBase}/plugins/${encodeURIComponent(manifest.name)}/releases${
    channel !== "stable" ? `?channel=${encodeURIComponent(channel)}` : ""
  }`;
  const headers: Record<string, string> = {
    ...authHeader,
    "Content-Type": "application/zip",
    "X-Package-Sha256": sha256,
  };
  if (signature) headers["X-Package-Signature"] = signature;

  const upRes = await doFetch(url, { method: "POST", headers, body: zip });
  if (upRes.status !== 200) {
    throw new Error(`上传失败: HTTP ${upRes.status}`);
  }
  const data = await upRes.json().catch(() => null);
  return {
    dryRun: false, name: manifest.name, version: manifest.version,
    sha256, signature, created, uploaded: true, data,
  };
}

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  baseUrl: string;
  gatewayUuid: string;
  token: string;
  signKeyPath?: string;
}

// 配置来源优先级:环境变量 > ~/.xplugin/config.json
export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  let file: Partial<CliConfig> = {};
  const path = join(homedir(), ".xplugin", "config.json");
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      file = {
        baseUrl: raw.baseUrl ?? raw.base_url,
        gatewayUuid: raw.gatewayUuid ?? raw.gateway_uuid,
        token: raw.token,
        signKeyPath: raw.signKeyPath ?? raw.sign_key_path,
      };
    } catch {
      // 配置文件损坏时忽略,完全依赖环境变量
    }
  }
  const cfg: CliConfig = {
    baseUrl: env.XPLUGIN_BASE_URL ?? file.baseUrl ?? "",
    gatewayUuid: env.XPLUGIN_GATEWAY_UUID ?? file.gatewayUuid ?? "",
    token: env.XPLUGIN_TOKEN ?? file.token ?? "",
    signKeyPath: env.XPLUGIN_SIGN_KEY ?? file.signKeyPath,
  };
  return cfg;
}

// 校验上传所需的必填配置
export function assertPublishConfig(cfg: CliConfig): void {
  const missing: string[] = [];
  if (!cfg.baseUrl) missing.push("baseUrl/XPLUGIN_BASE_URL");
  if (!cfg.gatewayUuid) missing.push("gatewayUuid/XPLUGIN_GATEWAY_UUID");
  if (!cfg.token) missing.push("token/XPLUGIN_TOKEN");
  if (missing.length) {
    throw new Error(`缺少配置: ${missing.join(", ")}`);
  }
}

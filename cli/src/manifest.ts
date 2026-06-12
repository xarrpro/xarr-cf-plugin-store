import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface CliManifest {
  manifest_version: number;
  name: string;
  title: string;
  author?: string;
  description?: string;
  homepage?: string;
  version: string;
  min_program_version?: string;
  type: number;
}

const REQUIRED: (keyof CliManifest)[] = ["name", "title", "version", "type"];

export class CliManifestError extends Error {}

// 从插件目录读取并校验 manifest.json
export function loadManifest(dir: string): CliManifest {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) {
    throw new CliManifestError(`目录缺少 manifest.json: ${path}`);
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliManifestError("manifest.json 不是合法 JSON");
  }
  for (const k of REQUIRED) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") {
      throw new CliManifestError(`manifest.json 缺少必填字段: ${k}`);
    }
  }
  return {
    manifest_version: Number(obj.manifest_version ?? 1),
    name: String(obj.name),
    title: String(obj.title),
    author: obj.author ? String(obj.author) : undefined,
    description: obj.description ? String(obj.description) : undefined,
    homepage: obj.homepage ? String(obj.homepage) : undefined,
    version: String(obj.version),
    min_program_version: obj.min_program_version ? String(obj.min_program_version) : undefined,
    type: Number(obj.type),
  };
}

import { unzipSync, strFromU8 } from "fflate";

export class ManifestError extends Error {}

export interface Manifest {
  manifest_version: number;
  name: string;
  title: string;
  author: string;
  description: string;
  homepage?: string;
  version: string;
  min_program_version: string;
  type: number;
}

// 严格对齐 merchant-server 的必填字段
const REQUIRED: (keyof Manifest)[] = ["name", "title", "author", "description", "version", "min_program_version", "type"];
const SUPPORTED_TYPES = [1, 2, 3, 4, 5];
const LUA_TYPES = new Set([1, 4]); // 1=支付插件 4=短信插件:必须含入口 plugin.lua

// 校验并解析插件包:要求 zip 内为「{manifest.name}/...」单一顶层目录结构(与 merchant-server 安装时一致)
export async function parseManifestFromZip(buf: ArrayBuffer): Promise<Manifest> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch {
    throw new ManifestError("无法解压 zip 包");
  }
  // 实际文件路径(排除目录占位条目)
  const paths = Object.keys(files).filter((p) => p && !p.endsWith("/"));
  if (paths.length === 0) throw new ManifestError("zip 包为空");

  // 必须是单一顶层目录结构:{name}/...
  const tops = new Set<string>();
  for (const p of paths) {
    const i = p.indexOf("/");
    if (i < 0) throw new ManifestError(`zip 根不能有散落文件(${p}),必须为「插件名/...」的单一顶层目录结构`);
    tops.add(p.slice(0, i));
  }
  if (tops.size !== 1) {
    throw new ManifestError(`zip 根只能有一个顶层目录,当前有 ${tops.size} 个:${[...tops].join(", ")}`);
  }
  const top = [...tops][0];

  const raw = files[`${top}/manifest.json`];
  if (!raw) throw new ManifestError(`缺少 ${top}/manifest.json`);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(strFromU8(raw));
  } catch {
    throw new ManifestError("manifest.json 不是合法 JSON");
  }

  for (const k of REQUIRED) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") {
      throw new ManifestError(`manifest.json 缺少必填字段: ${k}`);
    }
  }

  const name = String(obj.name);
  if (name !== top) {
    throw new ManifestError(`顶层目录名(${top})与 manifest.name(${name})不一致`);
  }

  const type = Number(obj.type);
  if (!SUPPORTED_TYPES.includes(type)) {
    throw new ManifestError(`manifest.type(${obj.type})不是受支持的类型(1-5)`);
  }
  if (LUA_TYPES.has(type) && !files[`${top}/plugin.lua`]) {
    throw new ManifestError(`${type === 1 ? "支付" : "短信"}插件缺少入口文件 ${top}/plugin.lua`);
  }

  return {
    manifest_version: Number(obj.manifest_version ?? 1),
    name,
    title: String(obj.title),
    author: String(obj.author),
    description: String(obj.description),
    homepage: obj.homepage ? String(obj.homepage) : undefined,
    version: String(obj.version),
    min_program_version: String(obj.min_program_version),
    type,
  };
}

// 提取 README(新结构在 {name}/README.md;兼容根 README.md)
export function extractReadme(buf: ArrayBuffer): string | null {
  try {
    const files = unzipSync(new Uint8Array(buf));
    const key = Object.keys(files).find((p) => p.endsWith("/README.md") || p === "README.md");
    return key ? strFromU8(files[key]) : null;
  } catch {
    return null;
  }
}

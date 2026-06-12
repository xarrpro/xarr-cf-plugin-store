import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { loadManifest, type CliManifest } from "./manifest.ts";

export interface PackResult {
  zip: Uint8Array;
  sha256: string;
  manifest: CliManifest;
}

// 读取插件目录,校验 manifest,打包成 zip,计算 sha256
export function pack(dir: string): PackResult {
  const manifest = loadManifest(dir);

  const files: Record<string, Uint8Array> = {};
  // manifest.json 一定存在
  files["manifest.json"] = readFileSync(join(dir, "manifest.json"));
  // 可选入口文件与说明
  for (const f of ["plugin.lua", "index.html", "README.md"]) {
    const p = join(dir, f);
    if (existsSync(p)) files[f] = readFileSync(p);
  }

  const zip = zipSync(files);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  return { zip, sha256, manifest };
}

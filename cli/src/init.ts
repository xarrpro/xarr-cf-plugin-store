import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { generateKeypair } from "./sign.ts";

export interface InitResult {
  dir: string;
  files: string[];
  publicHex: string;
}

// 在 dir 下生成插件骨架:manifest.json / plugin.lua / README.md / ed25519 密钥
export function init(dir: string, name: string): InitResult {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];

  const manifest = {
    manifest_version: 1,
    name,
    title: name,
    author: "",
    description: "",
    version: "1.0.0",
    min_program_version: "",
    type: 1,
  };
  const writeIfAbsent = (rel: string, content: string) => {
    const p = join(dir, rel);
    if (!existsSync(p)) {
      writeFileSync(p, content);
      files.push(rel);
    }
  };

  writeIfAbsent("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  writeIfAbsent("plugin.lua", "-- " + name + " plugin entry\n");
  writeIfAbsent("README.md", `# ${name}\n`);

  const { privatePem, publicPem, publicHex } = generateKeypair();
  writeIfAbsent("ed25519_private.pem", privatePem);
  writeIfAbsent("ed25519_public.pem", publicPem);

  return { dir, files, publicHex };
}

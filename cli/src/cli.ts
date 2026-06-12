import { writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { pack } from "./pack.ts";
import { init } from "./init.ts";
import { publish } from "./publish.ts";

// 解析 --flag 与 --flag=value
function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v === undefined ? true : v;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export async function run(argv: string[], cwd = process.cwd()): Promise<string> {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "init": {
      const name = positional[0] ?? basename(cwd);
      const dir = positional[0] ? join(cwd, positional[0]) : cwd;
      const r = init(dir, name);
      return `已生成插件骨架于 ${r.dir}\n文件: ${r.files.join(", ")}\n公钥(hex): ${r.publicHex}`;
    }
    case "pack": {
      const r = pack(cwd);
      const out = join(cwd, `${r.manifest.name}-${r.manifest.version}.zip`);
      writeFileSync(out, r.zip);
      return `已打包: ${out}\nsha256: ${r.sha256}`;
    }
    case "publish": {
      const r = await publish({
        dir: cwd,
        channel: typeof flags.channel === "string" ? flags.channel : undefined,
        dryRun: Boolean(flags["dry-run"]),
      });
      if (r.dryRun) return `[dry-run] ${r.name}@${r.version} sha256=${r.sha256} 已本地打包,未上传`;
      return `已发布 ${r.name}@${r.version} (created=${r.created}) sha256=${r.sha256}`;
    }
    default:
      return "用法: xplugin <init|pack|publish> [--channel=beta] [--dry-run]";
  }
}

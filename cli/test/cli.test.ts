import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { createHash } from "node:crypto";

import { loadManifest, CliManifestError } from "../src/manifest";
import { pack } from "../src/pack";
import { generateKeypair, signHex, verifyHex } from "../src/sign";
import { loadConfig, assertPublishConfig } from "../src/config";
import { init } from "../src/init";
import { publish } from "../src/publish";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xplugin-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(obj: unknown) {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(obj));
  writeFileSync(join(dir, "plugin.lua"), "-- code");
}

describe("manifest", () => {
  it("解析合法 manifest", () => {
    writeManifest({ name: "demo", title: "Demo", version: "1.0.0", type: 1 });
    const m = loadManifest(dir);
    expect(m.name).toBe("demo");
    expect(m.version).toBe("1.0.0");
  });
  it("缺 manifest.json 抛错", () => {
    expect(() => loadManifest(dir)).toThrow(CliManifestError);
  });
  it("缺必填字段抛错", () => {
    writeManifest({ title: "Demo", version: "1.0.0" });
    expect(() => loadManifest(dir)).toThrow(/name/);
  });
});

describe("pack", () => {
  it("产物可解压且含 manifest", () => {
    writeManifest({ name: "demo", title: "Demo", version: "1.0.0", type: 1 });
    const r = pack(dir);
    const files = unzipSync(r.zip);
    expect(files["manifest.json"]).toBeDefined();
    expect(files["plugin.lua"]).toBeDefined();
    const m = JSON.parse(strFromU8(files["manifest.json"]));
    expect(m.name).toBe("demo");
  });
  it("sha256 与内容一致", () => {
    writeManifest({ name: "demo", title: "Demo", version: "1.0.0", type: 1 });
    const r = pack(dir);
    expect(r.sha256).toBe(createHash("sha256").update(r.zip).digest("hex"));
  });
  it("缺 manifest 时抛错", () => {
    expect(() => pack(dir)).toThrow();
  });
});

describe("sign", () => {
  it("签名可被本地验签通过", () => {
    const { privatePem, publicPem } = generateKeypair();
    const sig = signHex("2cf24dba", privatePem);
    expect(verifyHex("2cf24dba", sig, publicPem)).toBe(true);
    expect(verifyHex("2cf24dbX", sig, publicPem)).toBe(false);
  });
  it("publicHex 为 64 hex 字符(32 字节 raw)", () => {
    const { publicHex } = generateKeypair();
    expect(publicHex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("config", () => {
  it("环境变量覆盖", () => {
    const cfg = loadConfig({
      XPLUGIN_BASE_URL: "https://x", XPLUGIN_GATEWAY_UUID: "g", XPLUGIN_TOKEN: "t",
    } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).toBe("https://x");
    expect(cfg.gatewayUuid).toBe("g");
    expect(cfg.token).toBe("t");
  });
  it("assertPublishConfig 缺字段抛错", () => {
    expect(() => assertPublishConfig({ baseUrl: "", gatewayUuid: "", token: "" })).toThrow(/缺少配置/);
  });
});

describe("init", () => {
  it("生成骨架文件与密钥", () => {
    const sub = join(dir, "proj");
    const r = init(sub, "myplugin");
    expect(r.files).toContain("manifest.json");
    expect(r.files).toContain("ed25519_private.pem");
    expect(r.publicHex).toMatch(/^[0-9a-f]{64}$/);
    const m = loadManifest(sub);
    expect(m.name).toBe("myplugin");
  });
});

describe("publish", () => {
  beforeEach(() => {
    writeManifest({ name: "demo-pay", title: "Demo Pay", version: "1.0.0", type: 1 });
  });

  it("dry-run 不发请求", async () => {
    let called = false;
    const r = await publish({
      dir, dryRun: true,
      config: { baseUrl: "https://x", gatewayUuid: "g", token: "t" },
      fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch,
    });
    expect(called).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("正常流程:创建插件 + 上传,断言请求", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; bodyIsZip: boolean }> = [];
    const fetchImpl = (async (url: string, opt: RequestInit) => {
      const headers = (opt.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url), method: String(opt.method),
        headers, bodyIsZip: opt.body instanceof Uint8Array,
      });
      if (String(url).endsWith("/admin/plugins")) return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
      return new Response(JSON.stringify({ code: 0, data: { version: "1.0.0" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await publish({
      dir,
      config: { baseUrl: "https://x", gatewayUuid: "gw", token: "tok" },
      fetchImpl,
    });
    expect(r.uploaded).toBe(true);
    expect(calls.length).toBe(2);
    // 第一条:创建插件
    expect(calls[0].url).toBe("https://x/gw/admin/plugins");
    // 第二条:上传 raw zip body
    expect(calls[1].url).toBe("https://x/gw/admin/plugins/demo-pay/releases");
    expect(calls[1].headers["Content-Type"]).toBe("application/zip");
    expect(calls[1].headers["X-Package-Sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[1].headers["Authorization"]).toBe("Bearer tok");
    expect(calls[1].bodyIsZip).toBe(true);
  });

  it("插件已存在(409)时继续上传", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/admin/plugins")) return new Response("{}", { status: 409 });
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await publish({
      dir, config: { baseUrl: "https://x", gatewayUuid: "gw", token: "tok" }, fetchImpl,
    });
    expect(r.created).toBe(false);
    expect(r.uploaded).toBe(true);
  });

  it("channel=beta 带 query", async () => {
    let releaseUrl = "";
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/releases")) { releaseUrl = String(url); }
      if (String(url).endsWith("/admin/plugins")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await publish({
      dir, channel: "beta",
      config: { baseUrl: "https://x", gatewayUuid: "gw", token: "tok" }, fetchImpl,
    });
    expect(releaseUrl).toContain("channel=beta");
  });
});

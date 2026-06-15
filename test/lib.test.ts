import { describe, it, expect } from "vitest";
import { ok, err } from "../src/lib/response";
import { sha256Hex, constantTimeEqual } from "../src/lib/hash";
import { zipSync, strToU8 } from "fflate";
import { parseManifestFromZip, ManifestError } from "../src/lib/manifest";
import { verifyEd25519 } from "../src/lib/signature";

describe("response", () => {
  it("ok 包络", async () => {
    const res = ok({ a: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 200, message: "ok", data: { a: 1 } });
  });
  it("err 包络", async () => {
    const res = err(1001, "unauthorized", 401);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 1001, message: "unauthorized", data: null });
  });
});

describe("hash", () => {
  it("sha256Hex 稳定", async () => {
    const buf = new TextEncoder().encode("hello").buffer;
    expect(await sha256Hex(buf)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
  it("constantTimeEqual", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });
});

describe("manifest", () => {
  // zip 内需为「{name}/...」单一顶层目录;manifest 未指定 name 时默认 demo
  function buildZip(manifestObj: any): ArrayBuffer {
    const name = manifestObj && typeof manifestObj.name === "string" ? manifestObj.name : "demo";
    const files: Record<string, Uint8Array> = { [`${name}/plugin.lua`]: strToU8("-- code") };
    if (manifestObj !== undefined) files[`${name}/manifest.json`] = strToU8(JSON.stringify(manifestObj));
    const z = zipSync(files);
    return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength);
  }
  it("解析合法 manifest", async () => {
    const m = await parseManifestFromZip(buildZip({ name: "demo", title: "Demo", author: "x", description: "d", version: "1.0.0", min_program_version: "1.0.0", type: 1 }));
    expect(m.name).toBe("demo");
    expect(m.version).toBe("1.0.0");
  });
  it("缺 manifest.json 抛错", async () => {
    await expect(parseManifestFromZip(buildZip(undefined))).rejects.toBeInstanceOf(ManifestError);
  });
  it("缺必填字段抛错", async () => {
    await expect(parseManifestFromZip(buildZip({ name: "demo", title: "D", version: "1.0.0" }))).rejects.toThrow(/缺少必填字段/);
  });
});

describe("signature", () => {
  it("正确签名通过、篡改失败", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const msg = new TextEncoder().encode("2cf24dba");
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, msg);
    const rawPub = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
    const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(await verifyEd25519("2cf24dba", hex(sig), hex(rawPub))).toBe(true);
    expect(await verifyEd25519("2cf24dbX", hex(sig), hex(rawPub))).toBe(false);
  });
});

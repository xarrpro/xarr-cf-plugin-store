import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedAuth, TEST_TOKEN, TEST_GATEWAY, TEST_ADMIN_PATH } from "./helpers";
import { verifyToken, issueToken, revokeToken } from "../src/services/tokens";
import { putPackage, getPackage, deletePackage, packageKey } from "../src/services/storage";
import { createPlugin, getPluginByName, insertReleaseAtomic, writeAudit } from "../src/services/db";
import app from "../src/index";
import { authHeaders, buildPluginZip } from "./helpers";
import { sha256Hex } from "../src/lib/hash";

beforeEach(async () => { await applyMigrations(); await seedAuth(); });

describe("tokens service", () => {
  it("verifyToken", async () => {
    expect(await verifyToken(env, TEST_TOKEN)).not.toBeNull();
    expect(await verifyToken(env, "wrong")).toBeNull();
  });
  it("issue/revoke", async () => {
    const { id, plaintext } = await issueToken(env, "ci", 0);
    expect(await verifyToken(env, plaintext)).not.toBeNull();
    await revokeToken(env, id);
    expect(await verifyToken(env, plaintext)).toBeNull();
  });
});

describe("storage service", () => {
  it("put/get/delete 往返", async () => {
    const key = packageKey("uuid-1", "1.0.0", "demo");
    await putPackage(env, key, new TextEncoder().encode("zipdata").buffer, "application/zip");
    const got = await getPackage(env, key);
    expect(got).not.toBeNull();
    expect(await got!.text()).toBe("zipdata");
    await deletePackage(env, key);
    expect(await getPackage(env, key)).toBeNull();
  });
});

describe("db service", () => {
  it("createPlugin + getPluginByName", async () => {
    const p = await createPlugin(env, { name: "demo", title: "Demo", type: 1, author: "xarr" });
    expect(p.uuid).toMatch(/.+/);
    expect((await getPluginByName(env, "demo"))!.name).toBe("demo");
  });
  it("insertReleaseAtomic 更新 latest_version", async () => {
    const p = await createPlugin(env, { name: "demo2", title: "D2", type: 1 });
    await insertReleaseAtomic(env, { pluginId: p.id, version: "1.0.0", channel: "stable", r2Key: "k",
      packageSize: 10, sha256: "abc", signature: null, changelog: "", minProgramVersion: "" });
    expect((await getPluginByName(env, "demo2"))!.latest_version).toBe("1.0.0");
  });
  it("重复版本抛错", async () => {
    const p = await createPlugin(env, { name: "demo3", title: "D3", type: 1 });
    const a = { pluginId: p.id, version: "1.0.0", channel: "stable", r2Key: "k",
      packageSize: 10, sha256: "abc", signature: null, changelog: "", minProgramVersion: "" };
    await insertReleaseAtomic(env, a);
    await expect(insertReleaseAtomic(env, a)).rejects.toThrow();
  });
  it("writeAudit 落库", async () => {
    await writeAudit(env, { action: "test", target: "x", tokenId: "t", ip: "1.1.1.1", ua: "ua" });
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit_logs").first<{ c: number }>();
    expect(row!.c).toBeGreaterThan(0);
  });
});

const adminUrl = (p: string) => `https://x/${TEST_ADMIN_PATH}${p}`;

describe("admin routes", () => {
  it("错误后台路径 → 404", async () => {
    const res = await app.request("https://x/wrong/plugins",
      { method: "POST", headers: authHeaders(), body: "{}" }, env);
    expect(res.status).toBe(404);
  });
  it("缺令牌 → 401", async () => {
    const res = await app.request(adminUrl("/plugins"),
      { method: "POST", body: JSON.stringify({ name: "a", title: "A", type: 1 }) }, env);
    expect(res.status).toBe(401);
  });
  it("创建 → 上传 → 重复 409", async () => {
    const create = await app.request(adminUrl("/plugins"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo-pay", title: "Demo Pay", type: 1 }),
    }, env);
    expect(create.status).toBe(200);
    const zip = buildPluginZip({ name: "demo-pay", title: "Demo Pay", version: "1.0.0", type: 1 });
    const sha = await sha256Hex(zip);
    const up = await app.request(adminUrl("/plugins/demo-pay/releases"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/zip", "X-Package-Sha256": sha }, body: zip,
    }, env);
    expect(up.status).toBe(200);
    expect((await up.json() as any).data.version).toBe("1.0.0");
    const dup = await app.request(adminUrl("/plugins/demo-pay/releases"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/zip", "X-Package-Sha256": sha }, body: zip,
    }, env);
    expect(dup.status).toBe(409);
  });
  it("校验和不匹配 → 422", async () => {
    await app.request(adminUrl("/plugins"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo-x", title: "X", type: 1 }),
    }, env);
    const zip = buildPluginZip({ name: "demo-x", title: "X", version: "1.0.0", type: 1 });
    const res = await app.request(adminUrl("/plugins/demo-x/releases"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/zip", "X-Package-Sha256": "deadbeef" }, body: zip,
    }, env);
    expect(res.status).toBe(422);
  });
  it("签发 → 列出 → 吊销", async () => {
    const issue = await app.request(adminUrl("/tokens"), {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ci", expireAt: 0 }),
    }, env);
    const { data } = await issue.json() as any;
    expect(data.plaintext).toMatch(/.+/);
    const list = await app.request(adminUrl("/tokens"), { headers: authHeaders() }, env);
    expect((await list.json() as any).data.length).toBeGreaterThan(0);
    const del = await app.request(adminUrl(`/tokens/${data.id}`), { method: "DELETE", headers: authHeaders() }, env);
    expect(del.status).toBe(200);
  });
});

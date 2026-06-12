import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, seedAuth, authHeaders, buildPluginZip, TEST_GATEWAY } from "./helpers";
import app from "../src/index";
import { sha256Hex } from "../src/lib/hash";

beforeEach(async () => { await applyMigrations(); await seedAuth(); });

async function seed() {
  await app.request(`https://x/${TEST_GATEWAY}/admin/plugins`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo", title: "Demo", type: 1 }),
  }, env);
  const zip = buildPluginZip({ name: "demo", title: "Demo", version: "1.0.0", type: 1 });
  const sha = await sha256Hex(zip);
  await app.request(`https://x/${TEST_GATEWAY}/admin/plugins/demo/releases`, {
    method: "POST", headers: { ...authHeaders(), "Content-Type": "application/zip", "X-Package-Sha256": sha }, body: zip,
  }, env);
}

describe("public routes", () => {
  it("列表", async () => {
    await seed();
    const res = await app.request("https://x/api/plugins", {}, env);
    expect((await res.json() as any).data.some((p: any) => p.name === "demo")).toBe(true);
  });
  it("详情含版本", async () => {
    await seed();
    const { data } = await (await app.request("https://x/api/plugins/demo", {}, env)).json() as any;
    expect(data.plugin.name).toBe("demo");
    expect(data.releases.length).toBeGreaterThan(0);
  });
  it("check-update", async () => {
    await seed();
    const { data } = await (await app.request("https://x/api/plugins/demo/check-update?current=0.9.0", {}, env)).json() as any;
    expect(data.has_update).toBe(true);
    expect(data.latest).toBe("1.0.0");
  });
  it("下载", async () => {
    await seed();
    const res = await app.request("https://x/dl/demo/1.0.0", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("zip");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
  it("下载不存在版本 404", async () => {
    await seed();
    expect((await app.request("https://x/dl/demo/9.9.9", {}, env)).status).toBe(404);
  });
});

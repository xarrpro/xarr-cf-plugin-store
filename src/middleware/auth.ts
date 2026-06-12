import type { Context, Next } from "hono";
import type { Env, TokenRecord } from "../types";
import { verifyToken } from "../services/tokens";
import { constantTimeEqual } from "../lib/hash";
import { err } from "../lib/response";

declare module "hono" {
  interface ContextVariableMap {
    token: TokenRecord & { id: string };
  }
}

export async function authGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const m = (c.req.header("Authorization") ?? "").match(/^Bearer\s+(.+)$/);
  if (!m) return err(1001, "未授权", 401);
  // 固定主令牌(env):匹配则放行,合成一条 token 记录供审计用
  if (c.env.ADMIN_TOKEN && constantTimeEqual(m[1], c.env.ADMIN_TOKEN)) {
    c.set("token", { id: "env", name: "主令牌(env)", hash: "", scope: "admin", createdAt: 0, expireAt: 0, revoked: false });
    return next();
  }
  const rec = await verifyToken(c.env, m[1]);
  if (!rec) return err(1001, "未授权", 401);
  c.set("token", rec);
  await next();
}

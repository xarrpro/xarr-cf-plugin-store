import type { Context, Next } from "hono";
import type { Env } from "../types";
import { isValidGateway } from "../services/gateways";

// 校验下载入口 UUID(支持多个,KV 管理);非法一律 404
export async function gatewayGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const uuid = c.req.param("uuid") ?? c.req.param("seg") ?? "";
  if (!(await isValidGateway(c.env, uuid))) return c.notFound();
  await next();
}

// 校验后台自定义密路径(URL 第一段 == ADMIN_PATH);非法一律 404
export async function adminPathGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const seg = c.req.param("gate") ?? "";
  if (!c.env.ADMIN_PATH || seg !== c.env.ADMIN_PATH) return c.notFound();
  await next();
}

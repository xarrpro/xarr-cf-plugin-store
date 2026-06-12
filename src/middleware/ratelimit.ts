import type { Context, Next } from "hono";
import type { Env } from "../types";
import { err } from "../lib/response";

export async function rateLimitGuard(c: Context<{ Bindings: Env }>, next: Next) {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.RATE_LIMITER.limit({ key: ip });
  if (!success) return err(1002, "请求过于频繁", 429);
  await next();
}

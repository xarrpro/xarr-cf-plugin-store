export function ok(data: unknown = null, http = 200): Response {
  return Response.json({ code: 0, msg: "ok", data }, { status: http });
}
export function err(code: number, msg: string, http = 400): Response {
  return Response.json({ code, msg, data: null }, { status: http });
}

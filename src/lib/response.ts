export function ok(data: unknown = null, http = 200): Response {
  return Response.json({ code: 200, message: "ok", data }, { status: http });
}
export function err(code: number, message: string, http = 400): Response {
  return Response.json({ code, message, data: null }, { status: http });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** Thrown by handlers to return an error response from anywhere. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Headers every admin response carries. No cookie is ever set. */
export function withAdminHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-store");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "no-referrer");
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return out;
}

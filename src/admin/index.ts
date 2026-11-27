// The admin host: the write API under /api/ and the admin page at /.
//
// It shares a registrable domain with the content host, so a browser counts
// the two as same-site and script in a published bundle can send requests
// here that carry the Access cookie. Access alone therefore proves nothing
// about who wrote the request; every check below has to pass as well.
import type { Env } from "../env";
import { handleApi } from "./api";
import { verifyAccessJwt } from "./auth";
import { error, withAdminHeaders } from "./http";
import { adminPage } from "./ui";

export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  return withAdminHeaders(await route(req, env));
}

async function route(req: Request, env: Env): Promise<Response> {
  const safe = req.method === "GET" || req.method === "HEAD";

  // No preflight is ever answered. The API needs no CORS, so a cross-origin
  // caller that has to ask first (see requireJsonOrCustomHeader) stops here.
  if (req.method === "OPTIONS") {
    return error(405, "method_not_allowed", "preflight requests are not answered");
  }

  if (!safe) {
    const site = req.headers.get("Sec-Fetch-Site");
    if (site !== null && site !== "same-origin" && site !== "none") {
      return error(403, "cross_site", "cross-site requests are not allowed");
    }
    const origin = req.headers.get("Origin");
    if (origin !== null && origin !== `https://${env.ADMIN_HOST}`) {
      return error(403, "bad_origin", "requests from this origin are not allowed");
    }
  }

  if (!(await verifyAccessJwt(req.headers.get("Cf-Access-Jwt-Assertion"), env))) {
    return error(401, "unauthorized", "missing or invalid Access token");
  }

  const { pathname } = new URL(req.url);
  if (pathname === "/") {
    if (!safe) return error(405, "method_not_allowed", "method not allowed");
    return adminPage(env);
  }
  if (pathname.startsWith("/api/")) return handleApi(req, env, pathname);
  return error(404, "not_found", "not found");
}

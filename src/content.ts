// The public content host. Read-only: it serves slugs and nothing else, sets
// no cookies, and must never import anything from ./admin.
import type { Env } from "./env";
import { escapeHtml } from "./shared/html";
import { getItem, isExpired, type ItemRow } from "./shared/items";
import { contentTypeFor } from "./shared/mime";
import { decodeUrlPath } from "./shared/paths";
import { isValidSlug } from "./shared/slugs";
import { bundleKey, pasteKey } from "./shared/storage";

export const SANDBOX_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals";
export const PASTE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // Slugs can be replaced at any time, so always revalidate.
  "Cache-Control": "no-cache",
};

function respond(
  req: Request,
  body: BodyInit | null,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(req.method === "HEAD" ? null : body, {
    status,
    headers: { ...BASE_HEADERS, ...headers },
  });
}

function plain(req: Request, status: number, text: string): Response {
  return respond(req, text + "\n", status, { "Content-Type": "text/plain; charset=utf-8" });
}

const notFound = (req: Request): Response => plain(req, 404, "Not found");

export async function handleContent(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method not allowed\n", {
      status: 405,
      headers: { ...BASE_HEADERS, Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const url = new URL(req.url);
  if (url.pathname === "/robots.txt") {
    return plain(req, 200, "User-agent: *\nDisallow: /");
  }

  // "/<slug>" plus an optional remainder that starts with "/".
  const match = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return notFound(req);
  const slug = match[1]!;
  const rest = match[2];
  if (!isValidSlug(slug)) return notFound(req);

  const item = await getItem(env.DB, slug);
  if (!item) return notFound(req);
  if (isExpired(item)) return plain(req, 410, "Gone");

  switch (item.kind) {
    case "link":
      return serveLink(req, item, rest);
    case "paste":
      return servePaste(req, env, item, rest);
    case "bundle":
      return serveBundle(req, env, item, url, rest);
    default:
      return notFound(req);
  }
}

function serveLink(req: Request, item: ItemRow, rest: string | undefined): Response {
  if ((rest !== undefined && rest !== "/") || !item.target) return notFound(req);
  return respond(req, null, 302, { Location: item.target });
}

async function servePaste(
  req: Request,
  env: Env,
  item: ItemRow,
  rest: string | undefined,
): Promise<Response> {
  const raw = rest === "/raw";
  if (!raw && rest !== undefined && rest !== "/") return notFound(req);

  const object = await env.BUCKET.get(pasteKey(item.slug));
  if (!object) return notFound(req);
  const text = await object.text();

  // A paste is only ever text/plain, or escaped text inside the viewer. Its
  // declared content_type is metadata and never becomes a response header.
  if (raw) {
    return respond(req, text, 200, { "Content-Type": "text/plain; charset=utf-8" });
  }
  return respond(req, pasteViewer(item, text), 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": PASTE_CSP,
  });
}

function pasteViewer(item: ItemRow, text: string): string {
  const title = escapeHtml(item.title ?? item.slug);
  const type = escapeHtml(item.content_type ?? "text/plain");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  header { display: flex; gap: 1rem; align-items: baseline; padding: .75rem 1rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
  h1 { font-size: 1rem; margin: 0; flex: 1; overflow-wrap: anywhere; }
  header span, header a { font-size: .85rem; opacity: .75; }
  pre { margin: 0; padding: 1rem; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
</style>
</head>
<body>
<header><h1>${title}</h1><span>${type}</span><a href="/${item.slug}/raw">raw</a></header>
<pre>${escapeHtml(text)}</pre>
</body>
</html>
`;
}

async function serveBundle(
  req: Request,
  env: Env,
  item: ItemRow,
  url: URL,
  rest: string | undefined,
): Promise<Response> {
  if (!item.version) return notFound(req);

  // "/<slug>" -> "/<slug>/" so the page's relative URLs resolve inside the bundle.
  if (rest === undefined) {
    return respond(req, null, 301, { Location: `/${item.slug}/${url.search}` });
  }

  const path = rest === "/" ? "index.html" : decodeUrlPath(rest.slice(1));
  if (path === null) return notFound(req);
  const key = bundleKey(item.slug, item.version, path);

  const headers: Record<string, string> = { "Content-Type": contentTypeFor(path) };
  if (item.sandbox) headers["Content-Security-Policy"] = SANDBOX_CSP;

  if (req.method === "HEAD") {
    const head = await env.BUCKET.head(key);
    if (!head) return notFound(req);
    return respond(req, null, 200, {
      ...headers,
      ETag: head.httpEtag,
      "Content-Length": String(head.size),
    });
  }

  const ifNoneMatch = req.headers.get("If-None-Match");
  const object = await env.BUCKET.get(
    key,
    ifNoneMatch ? { onlyIf: new Headers({ "If-None-Match": ifNoneMatch }) } : undefined,
  );
  if (!object) return notFound(req);
  headers.ETag = object.httpEtag;
  // With onlyIf, R2 returns the metadata without a body when the ETag matched.
  if (!("body" in object)) return respond(req, null, 304, headers);
  return respond(req, object.body, 200, headers);
}

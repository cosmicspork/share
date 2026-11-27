// The JSON write API. Mounted under /api/ on the admin host only; every
// request has already passed the checks in ./index.
//
//   GET    /api/items[?kind=&limit=&offset=]      list, most recently updated first
//   GET    /api/items/<slug>
//   PATCH  /api/items/<slug>                      { title?, sandbox?, expires_at?, expires_in? }
//   DELETE /api/items/<slug>
//   POST   /api/links                             { url, ...common }
//   POST   /api/pastes                            { content, content_type?, ...common }
//   POST   /api/bundles                           { sandbox?, ...common }  -> { slug, version }
//   PUT    /api/bundles/<slug>/<version>/files/<path>    raw file body
//   POST   /api/bundles/<slug>/<version>/commit
//
// common: { slug?, title?, expires_at?, expires_in?, replace? }
import type { Env } from "../env";
import { sweepStaleDrafts } from "../shared/cleanup";
import { parseDuration } from "../shared/duration";
import { getItem, type ItemRow, itemToJson, type Kind, KINDS, nowSeconds } from "../shared/items";
import {
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_FILES,
  MAX_FILE_BYTES,
  MAX_PASTE_BYTES,
  MAX_TITLE_LENGTH,
  MAX_URL_LENGTH,
} from "../shared/limits";
import { contentTypeFor } from "../shared/mime";
import { decodeUrlPath } from "../shared/paths";
import {
  isReservedSlug,
  newVersionId,
  randomSlug,
  SLUG_RE,
  VERSION_RE,
} from "../shared/slugs";
import {
  bundleKey,
  deleteItemContent,
  listBundle,
  pasteKey,
} from "../shared/storage";
import { ApiError, error, json } from "./http";

/** Sent by the CLI and the admin page on requests that have no JSON body. */
export const CLIENT_HEADER = "X-Share-Client";

type Body = Record<string, unknown>;

interface DraftRow {
  slug: string;
  version: string;
  title: string | null;
  sandbox: number;
  expires_at: number | null;
  replace: number;
  created_at: number;
}

export async function handleApi(req: Request, env: Env, pathname: string): Promise<Response> {
  try {
    return await dispatch(req, env, pathname);
  } catch (e) {
    if (e instanceof ApiError) return error(e.status, e.code, e.message);
    throw e;
  }
}

async function dispatch(req: Request, env: Env, pathname: string): Promise<Response> {
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") requireJsonOrCustomHeader(req);

  let m: RegExpExecArray | null;

  if (pathname === "/api/items") {
    if (method === "GET") return listItems(req, env);
    throw methodNotAllowed();
  }
  if ((m = /^\/api\/items\/([^/]+)$/.exec(pathname))) {
    const slug = m[1]!;
    if (method === "GET") return json(itemToJson(await requireItem(env, slug), env));
    if (method === "PATCH") return patchItem(req, env, slug);
    if (method === "DELETE") return deleteItem(env, slug);
    throw methodNotAllowed();
  }
  if (pathname === "/api/links") {
    if (method === "POST") return createLink(req, env);
    throw methodNotAllowed();
  }
  if (pathname === "/api/pastes") {
    if (method === "POST") return createPaste(req, env);
    throw methodNotAllowed();
  }
  if (pathname === "/api/bundles") {
    if (method === "POST") return createDraft(req, env);
    throw methodNotAllowed();
  }
  if ((m = /^\/api\/bundles\/([^/]+)\/([^/]+)\/files\/(.+)$/.exec(pathname))) {
    if (method === "PUT") return uploadFile(req, env, m[1]!, m[2]!, m[3]!);
    throw methodNotAllowed();
  }
  if ((m = /^\/api\/bundles\/([^/]+)\/([^/]+)\/commit$/.exec(pathname))) {
    if (method === "POST") return commitDraft(env, m[1]!, m[2]!);
    throw methodNotAllowed();
  }
  throw new ApiError(404, "not_found", "not found");
}

const methodNotAllowed = () => new ApiError(405, "method_not_allowed", "method not allowed");

/**
 * A browser can send a cross-origin request without a preflight only if it
 * looks like a plain form post. Requiring a JSON content type or a custom
 * header forces the preflight, and preflights are never answered.
 */
function requireJsonOrCustomHeader(req: Request): void {
  const type = (req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/json" || req.headers.has(CLIENT_HEADER)) return;
  throw new ApiError(
    415,
    "unsupported_media_type",
    `send Content-Type: application/json or an ${CLIENT_HEADER} header`,
  );
}

// ---- request parsing -------------------------------------------------------

async function readJson(req: Request): Promise<Body> {
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw new ApiError(400, "bad_json", "request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "bad_json", "request body must be a JSON object");
  }
  return value as Body;
}

function optionalBool(body: Body, name: string): boolean | undefined {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ApiError(400, "bad_request", `${name} must be a boolean`);
  return v;
}

/** undefined: not given. null: explicitly cleared. */
function optionalTitle(body: Body): string | null | undefined {
  const v = body.title;
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > MAX_TITLE_LENGTH) {
    throw new ApiError(400, "bad_title", `title must be a string of at most ${MAX_TITLE_LENGTH} characters`);
  }
  return v;
}

/**
 * Expiry as unix seconds from `expires_at` (ISO 8601, or null for never) or
 * `expires_in` (seconds, or a duration such as "7d"). undefined: not given.
 */
function optionalExpiry(body: Body, now: number): number | null | undefined {
  const at = body.expires_at;
  const within = body.expires_in;
  if (at !== undefined && within !== undefined && within !== null) {
    throw new ApiError(400, "bad_expiry", "give expires_at or expires_in, not both");
  }
  let expires: number;
  if (within !== undefined && within !== null) {
    const seconds = typeof within === "number" ? within : typeof within === "string" ? parseDuration(within) : null;
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
      throw new ApiError(400, "bad_expiry", 'expires_in must be seconds or a duration like "7d"');
    }
    expires = now + Math.floor(seconds);
  } else if (at === undefined) {
    return undefined;
  } else if (at === null) {
    return null;
  } else {
    const ms = typeof at === "string" ? Date.parse(at) : NaN;
    if (Number.isNaN(ms)) throw new ApiError(400, "bad_expiry", "expires_at must be an ISO 8601 timestamp or null");
    expires = Math.floor(ms / 1000);
  }
  if (expires <= now) throw new ApiError(400, "bad_expiry", "expiry must be in the future");
  return expires;
}

function checkSlug(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new ApiError(400, "bad_slug", `slug must match ${SLUG_RE.source}`);
  }
  if (isReservedSlug(slug)) throw new ApiError(400, "reserved_slug", `"${slug}" is reserved`);
  return slug;
}

async function slugTaken(env: Env, slug: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM items WHERE slug = ?1 UNION ALL SELECT 1 FROM drafts WHERE slug = ?1 LIMIT 1",
  )
    .bind(slug)
    .first();
  return row !== null;
}

/**
 * The slug to write to: the requested one, or a fresh random one. An existing
 * slug is refused unless `replace` is set.
 */
async function resolveSlug(env: Env, body: Body, replace: boolean): Promise<string> {
  if (body.slug !== undefined && body.slug !== null && body.slug !== "") {
    const slug = checkSlug(body.slug);
    if (!replace && (await getItem(env.DB, slug))) throw slugExists(slug);
    return slug;
  }
  for (let i = 0; i < 8; i++) {
    const slug = randomSlug();
    if (!isReservedSlug(slug) && !(await slugTaken(env, slug))) return slug;
  }
  throw new ApiError(500, "slug_generation_failed", "could not find a free slug");
}

const slugExists = (slug: string) =>
  new ApiError(409, "slug_exists", `"${slug}" already exists; pass "replace": true to overwrite it`);

// ---- items -----------------------------------------------------------------

async function requireItem(env: Env, slug: string): Promise<ItemRow> {
  const item = SLUG_RE.test(slug) ? await getItem(env.DB, slug) : null;
  if (!item) throw new ApiError(404, "not_found", `no item "${slug}"`);
  return item;
}

async function listItems(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const kind = params.get("kind");
  if (kind !== null && !KINDS.includes(kind as Kind)) {
    throw new ApiError(400, "bad_kind", `kind must be one of ${KINDS.join(", ")}`);
  }
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 200) || 200, 1), 1000);
  const offset = Math.max(Number(params.get("offset") ?? 0) || 0, 0);

  const { results } = await env.DB.prepare(
    `SELECT * FROM items WHERE (?1 IS NULL OR kind = ?1)
      ORDER BY updated_at DESC, slug ASC LIMIT ?2 OFFSET ?3`,
  )
    .bind(kind, limit, offset)
    .all<ItemRow>();
  return json({ items: results.map((r) => itemToJson(r, env)) });
}

async function patchItem(req: Request, env: Env, slug: string): Promise<Response> {
  const item = await requireItem(env, slug);
  const body = await readJson(req);
  const now = nowSeconds();

  const title = optionalTitle(body);
  const expires = optionalExpiry(body, now);
  const sandbox = optionalBool(body, "sandbox");
  if (sandbox !== undefined && item.kind !== "bundle") {
    throw new ApiError(400, "bad_request", "sandbox only applies to bundles");
  }

  await env.DB.prepare(
    "UPDATE items SET title = ?, expires_at = ?, sandbox = ?, updated_at = ? WHERE slug = ?",
  )
    .bind(
      title === undefined ? item.title : title,
      expires === undefined ? item.expires_at : expires,
      sandbox === undefined ? item.sandbox : Number(sandbox),
      now,
      slug,
    )
    .run();
  return json(itemToJson(await requireItem(env, slug), env));
}

async function deleteItem(env: Env, slug: string): Promise<Response> {
  const item = await requireItem(env, slug);
  // Row first: once it is gone no reader can reach the content.
  await env.DB.prepare("DELETE FROM items WHERE slug = ?").bind(slug).run();
  await deleteItemContent(env.BUCKET, item);
  return new Response(null, { status: 204 });
}

interface NewItem {
  slug: string;
  kind: Kind;
  title: string | null;
  target: string | null;
  version: string | null;
  content_type: string | null;
  sandbox: boolean;
  size: number;
  file_count: number;
  expires_at: number | null;
}

/** The statement that creates the row, or replaces it when `replace` is set. */
function writeItemStatement(env: Env, item: NewItem, replace: boolean, now: number): D1PreparedStatement {
  const insert = `INSERT INTO items
      (slug, kind, title, target, version, content_type, sandbox, size, file_count,
       created_at, updated_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)`;
  // A replace keeps created_at: the slug is the same item, republished.
  const upsert = `${insert}
    ON CONFLICT (slug) DO UPDATE SET
      kind = excluded.kind, title = excluded.title, target = excluded.target,
      version = excluded.version, content_type = excluded.content_type,
      sandbox = excluded.sandbox, size = excluded.size, file_count = excluded.file_count,
      updated_at = excluded.updated_at, expires_at = excluded.expires_at`;
  return env.DB.prepare(replace ? upsert : insert).bind(
    item.slug,
    item.kind,
    item.title,
    item.target,
    item.version,
    item.content_type,
    Number(item.sandbox),
    item.size,
    item.file_count,
    now,
    item.expires_at,
  );
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(e.message);

/**
 * Write the row, then delete whatever content the previous row pointed at and
 * the new one does not. `extra` statements run in the same transaction.
 */
async function writeItem(
  env: Env,
  item: NewItem,
  replace: boolean,
  extra: D1PreparedStatement[] = [],
): Promise<Response> {
  const previous = await getItem(env.DB, item.slug);
  if (previous && !replace) throw slugExists(item.slug);

  try {
    await env.DB.batch([writeItemStatement(env, item, replace, nowSeconds()), ...extra]);
  } catch (e) {
    // Lost a race with another create of the same slug.
    if (isUniqueViolation(e)) throw slugExists(item.slug);
    throw e;
  }

  if (previous) {
    const sameObject =
      (previous.kind === "paste" && item.kind === "paste") ||
      (previous.kind === "bundle" && item.kind === "bundle" && previous.version === item.version);
    if (!sameObject) await deleteItemContent(env.BUCKET, previous);
  }

  const row = await requireItem(env, item.slug);
  return json(itemToJson(row, env), previous ? 200 : 201);
}

// ---- links -----------------------------------------------------------------

function checkTarget(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new ApiError(400, "bad_url", "url must be a string of reasonable length");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "bad_url", "url is not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(400, "bad_url", "only http: and https: URLs can be link targets");
  }
  return url.href;
}

async function createLink(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const now = nowSeconds();
  const target = checkTarget(body.url);
  const replace = optionalBool(body, "replace") ?? false;
  const title = optionalTitle(body) ?? null;
  const expires_at = optionalExpiry(body, now) ?? null;
  const slug = await resolveSlug(env, body, replace);

  return writeItem(
    env,
    { slug, kind: "link", title, target, version: null, content_type: null, sandbox: true, size: 0, file_count: 0, expires_at },
    replace,
  );
}

// ---- pastes ----------------------------------------------------------------

function checkPasteType(value: unknown): string {
  if (value === undefined || value === null || value === "") return "text/plain";
  if (typeof value !== "string" || !/^text\/[a-z0-9][a-z0-9.+-]{0,60}$/.test(value)) {
    throw new ApiError(400, "bad_content_type", "content_type must be a text/* media type");
  }
  return value;
}

async function createPaste(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const now = nowSeconds();
  if (typeof body.content !== "string") {
    throw new ApiError(400, "bad_request", "content must be a string");
  }
  const bytes = new TextEncoder().encode(body.content);
  if (bytes.byteLength > MAX_PASTE_BYTES) {
    throw new ApiError(413, "too_large", `a paste can be at most ${MAX_PASTE_BYTES} bytes`);
  }
  const content_type = checkPasteType(body.content_type);
  const replace = optionalBool(body, "replace") ?? false;
  const title = optionalTitle(body) ?? null;
  const expires_at = optionalExpiry(body, now) ?? null;
  const slug = await resolveSlug(env, body, replace);

  await env.BUCKET.put(pasteKey(slug), bytes, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  return writeItem(
    env,
    { slug, kind: "paste", title, target: null, version: null, content_type, sandbox: true, size: bytes.byteLength, file_count: 1, expires_at },
    replace,
  );
}

// ---- bundles ---------------------------------------------------------------
//
// A publish is draft -> upload files -> commit. Files land under a version
// prefix that no item row points at, so readers cannot see them. The commit
// validates the upload and then moves the row's `version` pointer in a single
// statement; that is the only moment a reader's view changes.

async function createDraft(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const now = nowSeconds();
  const replace = optionalBool(body, "replace") ?? false;
  const sandbox = optionalBool(body, "sandbox") ?? true;
  const title = optionalTitle(body) ?? null;
  const expires_at = optionalExpiry(body, now) ?? null;
  const slug = await resolveSlug(env, body, replace);
  const version = newVersionId();

  await env.DB.prepare(
    `INSERT INTO drafts (slug, version, title, sandbox, expires_at, replace, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(slug, version, title, Number(sandbox), expires_at, Number(replace), now)
    .run();

  return json(
    {
      slug,
      version,
      upload_url: `https://${env.ADMIN_HOST}/api/bundles/${slug}/${version}/files/`,
      commit_url: `https://${env.ADMIN_HOST}/api/bundles/${slug}/${version}/commit`,
    },
    201,
  );
}

async function requireDraft(env: Env, slug: string, version: string): Promise<DraftRow> {
  const draft =
    SLUG_RE.test(slug) && VERSION_RE.test(version)
      ? await env.DB.prepare("SELECT * FROM drafts WHERE slug = ? AND version = ?")
          .bind(slug, version)
          .first<DraftRow>()
      : null;
  if (!draft) throw new ApiError(404, "no_such_draft", "no such draft; it may already be committed");
  return draft;
}

async function uploadFile(
  req: Request,
  env: Env,
  slug: string,
  version: string,
  encodedPath: string,
): Promise<Response> {
  const path = decodeUrlPath(encodedPath);
  if (path === null) throw new ApiError(400, "bad_path", "invalid file path");
  await requireDraft(env, slug, version);

  const tooLarge = () =>
    new ApiError(413, "file_too_large", `a file can be at most ${MAX_FILE_BYTES} bytes`);
  if (Number(req.headers.get("Content-Length") ?? 0) > MAX_FILE_BYTES) throw tooLarge();
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_FILE_BYTES) throw tooLarge();

  await env.BUCKET.put(bundleKey(slug, version, path), body, {
    httpMetadata: { contentType: contentTypeFor(path) },
  });
  return json({ path, size: body.byteLength }, 201);
}

async function commitDraft(env: Env, slug: string, version: string): Promise<Response> {
  const draft = await requireDraft(env, slug, version);
  const files = await listBundle(env.BUCKET, slug, version);

  if (!files.some((f) => f.path === "index.html")) {
    throw new ApiError(400, "missing_index", "a bundle needs an index.html at its root");
  }
  if (files.length > MAX_BUNDLE_FILES) {
    throw new ApiError(413, "too_many_files", `a bundle can have at most ${MAX_BUNDLE_FILES} files`);
  }
  const size = files.reduce((sum, f) => sum + f.size, 0);
  if (files.some((f) => f.size > MAX_FILE_BYTES)) {
    throw new ApiError(413, "file_too_large", `a file can be at most ${MAX_FILE_BYTES} bytes`);
  }
  if (size > MAX_BUNDLE_BYTES) {
    throw new ApiError(413, "bundle_too_large", `a bundle can be at most ${MAX_BUNDLE_BYTES} bytes`);
  }

  const response = await writeItem(
    env,
    {
      slug,
      kind: "bundle",
      title: draft.title,
      target: null,
      version,
      content_type: null,
      sandbox: draft.sandbox === 1,
      size,
      file_count: files.length,
      expires_at: draft.expires_at,
    },
    draft.replace === 1,
    // Same transaction as the pointer move, so a committed version is never
    // also listed as a draft (the sweep deletes drafts' files).
    [env.DB.prepare("DELETE FROM drafts WHERE slug = ? AND version = ?").bind(slug, version)],
  );

  await sweepStaleDrafts(env);
  return response;
}

import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index";

export const CONTENT = `https://${env.CONTENT_HOST}`;
export const ADMIN = `https://${env.ADMIN_HOST}`;
const ISSUER = `https://${env.ACCESS_TEAM_DOMAIN}`;
const KID = "test-key";

/** Send a request straight into the Worker's fetch handler. */
export function send(url: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(url, { redirect: "manual", ...init }), env);
}

// ---- a stand-in for Cloudflare Access --------------------------------------

let keys: CryptoKeyPair | undefined;
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

async function keyPair(): Promise<CryptoKeyPair> {
  keys ??= (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  return keys;
}

/** Serve the test key from the team's JWKS URL. Returns the fetch spy. */
export async function installAccess() {
  const jwk = (await crypto.subtle.exportKey("jwk", (await keyPair()).publicKey)) as JsonWebKey;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${ISSUER}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
    }
    throw new Error(`unexpected outbound fetch: ${url}`);
  });
}

const b64url = (data: ArrayBuffer | string): string => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export interface TokenOptions {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  /** Sign with this key instead of the one Access publishes. */
  key?: CryptoKey;
}

export async function accessToken(opts: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT", ...opts.header };
  const claims = { iss: ISSUER, aud: [env.ACCESS_AUD], iat: now, nbf: now, exp: now + 300, sub: "", ...opts.claims };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = opts.key ?? (await keyPair()).privateKey;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

export async function otherKey(): Promise<CryptoKey> {
  return ((await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
}

// ---- authenticated admin calls ---------------------------------------------

/** An admin request the way the CLI sends it: valid token, custom header. */
export async function admin(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const raw = body instanceof ArrayBuffer || body instanceof Uint8Array || typeof body === "string";
  return send(ADMIN + path, {
    method,
    headers: {
      "Cf-Access-Jwt-Assertion": await accessToken(),
      "X-Share-Client": "test",
      ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
  });
}

export async function ok<T = any>(res: Response | Promise<Response>): Promise<T> {
  const r = await res;
  if (!r.ok) throw new Error(`expected success, got ${r.status}: ${await r.text()}`);
  return r.status === 204 ? (null as T) : ((await r.json()) as T);
}

export async function errorCode(res: Response | Promise<Response>): Promise<string> {
  const body = (await (await res).json()) as { error: { code: string } };
  return body.error.code;
}

export interface Draft {
  slug: string;
  version: string;
}

export function draft(body: Record<string, unknown> = {}): Promise<Draft> {
  return ok<Draft>(admin("POST", "/api/bundles", body));
}

export function upload(d: Draft, path: string, content: string | Uint8Array | ArrayBuffer): Promise<Response> {
  return admin("PUT", `/api/bundles/${d.slug}/${d.version}/files/${path}`, content);
}

export function commit(d: Draft): Promise<Response> {
  return admin("POST", `/api/bundles/${d.slug}/${d.version}/commit`);
}

/** Draft, upload and commit in one go. */
export async function publish(files: Record<string, string>, body: Record<string, unknown> = {}): Promise<Draft> {
  const d = await draft(body);
  for (const [path, content] of Object.entries(files)) await ok(upload(d, path, content));
  await ok(commit(d));
  return d;
}

export async function r2Keys(prefix = ""): Promise<string[]> {
  return (await env.BUCKET.list({ prefix })).objects.map((o) => o.key).sort();
}

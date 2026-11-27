// Verifies the JWT that Cloudflare Access attaches to every request it lets
// through. Access is the front door; this is the lock on the inner one, so a
// request that reaches the Worker some other way is still refused.
import type { Env } from "../env";

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

interface JwksCache {
  url: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
/** Minimum gap between refetches triggered by an unknown key id. */
const JWKS_MIN_REFETCH_MS = 30 * 1000;
const CLOCK_SKEW_SECONDS = 60;

let cache: JwksCache | null = null;

/** Test hook: forget cached signing keys. */
export function resetJwksCache(): void {
  cache = null;
}

function teamOrigin(env: Env): string | null {
  const domain = (env.ACCESS_TEAM_DOMAIN ?? "")
    .trim()
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "");
  return /^[a-z0-9.-]+$/i.test(domain) ? `https://${domain}` : null;
}

async function fetchJwks(url: string, now: number): Promise<JwksCache | null> {
  let jwks: { keys?: Jwk[] };
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    jwks = await res.json();
  } catch {
    return null;
  }
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // Skip a key we cannot import; the others may still be fine.
    }
  }
  return { url, keys, fetchedAt: now };
}

async function signingKey(origin: string, kid: string, now: number): Promise<CryptoKey | null> {
  const url = `${origin}/cdn-cgi/access/certs`;
  const fresh = cache !== null && cache.url === url && now - cache.fetchedAt < JWKS_TTL_MS;
  if (fresh) {
    const key = cache!.keys.get(kid);
    if (key) return key;
    // Unknown kid: Access may have rotated keys. Refetch, but not on every request.
    if (now - cache!.fetchedAt < JWKS_MIN_REFETCH_MS) return null;
  }
  const next = await fetchJwks(url, now);
  if (!next) return null;
  cache = next;
  return next.keys.get(kid) ?? null;
}

function b64urlBytes(input: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
  try {
    const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function b64urlJson(input: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(input);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * True only for a token that Access signed (RS256, a key from the team's
 * JWKS) for this application (`aud`), from this team (`iss`), and that has
 * not expired. Fails closed on any doubt, including missing configuration.
 */
export async function verifyAccessJwt(
  token: string | null,
  env: Env,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const origin = teamOrigin(env);
  const audience = (env.ACCESS_AUD ?? "").trim();
  if (!origin || !audience) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  const payload = b64urlJson(p);
  const signature = b64urlBytes(s);
  if (!header || !payload || !signature) return false;

  // Pinned algorithm: never let the token choose how it is verified.
  if (header.alg !== "RS256" || typeof header.kid !== "string") return false;

  const key = await signingKey(origin, header.kid, nowMs);
  if (!key) return false;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return false;

  const now = Math.floor(nowMs / 1000);
  if (payload.iss !== origin) return false;
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(audience) : aud === audience;
  if (!audOk) return false;
  if (typeof payload.exp !== "number" || payload.exp <= now) return false;
  if (typeof payload.nbf === "number" && payload.nbf > now + CLOCK_SKEW_SECONDS) return false;
  return true;
}

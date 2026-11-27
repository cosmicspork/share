// Entry point for `just dev` only. It wraps the real Worker with a stand-in
// for Cloudflare Access, so the admin API and page work on localhost:
//
//   /  and  /api/*   -> the admin host, as if Access had let you in
//   everything else  -> the content host
//
// (The two never overlap: the content host has no index and "api" is a
// reserved slug.) The stand-in signs a short-lived JWT per request and
// answers the Worker's request for the team's signing keys, so the real
// verification code runs unchanged. wrangler.jsonc does not reference this
// file; the deployed Worker has no dev mode and no way around Access.
import type { Env } from "../src/env";
import worker from "../src/index";

const DEV_TEAM = "dev.invalid";
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

let keys: Promise<CryptoKeyPair> | undefined;
const keyPair = () => (keys ??= crypto.subtle.generateKey(RSA, true, ["sign", "verify"]) as Promise<CryptoKeyPair>);

const b64url = (data: string | ArrayBuffer): string => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function accessJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const input = [
    b64url(JSON.stringify({ alg: "RS256", kid: "dev", typ: "JWT" })),
    b64url(JSON.stringify({ iss: `https://${DEV_TEAM}`, aud: [env.ACCESS_AUD], iat: now, exp: now + 60 })),
  ].join(".");
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await keyPair()).privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(sig)}`;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === `https://${DEV_TEAM}/cdn-cgi/access/certs`) {
    const jwk = (await crypto.subtle.exportKey("jwk", (await keyPair()).publicKey)) as JsonWebKey;
    return Response.json({ keys: [{ ...jwk, kid: "dev", alg: "RS256" }] });
  }
  return realFetch(input, init);
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (env.ACCESS_TEAM_DOMAIN !== DEV_TEAM) {
      return new Response("dev entry: start it with `just dev`\n", { status: 500 });
    }
    const url = new URL(req.url);
    const isAdmin = url.pathname === "/" || url.pathname.startsWith("/api/");
    url.protocol = "https:";
    url.hostname = isAdmin ? env.ADMIN_HOST : env.CONTENT_HOST;
    url.port = "";

    const headers = new Headers(req.headers);
    headers.delete("Cf-Access-Jwt-Assertion");
    if (isAdmin) {
      headers.set("Cf-Access-Jwt-Assertion", await accessJwt(env));
      // The browser's origin is localhost (and wrangler dev rewrites it to the
      // first route's host); the Worker expects the admin host's own origin.
      if (headers.has("Origin")) headers.set("Origin", `https://${env.ADMIN_HOST}`);
    }
    return worker.fetch(new Request(url, { method: req.method, headers, body: req.body, redirect: "manual" }), env);
  },
  scheduled: worker.scheduled,
} satisfies ExportedHandler<Env>;

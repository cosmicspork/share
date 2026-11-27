import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { accessToken, admin, ADMIN, errorCode, installAccess, ok, otherKey, send } from "./helpers";

const post = (headers: Record<string, string>) =>
  send(`${ADMIN}/api/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ url: "https://example.com/" }),
  });

const withToken = async (token: string | undefined) =>
  send(`${ADMIN}/api/items`, { headers: token === undefined ? {} : { "Cf-Access-Jwt-Assertion": token } });

async function itemCount(): Promise<number> {
  return (await ok(admin("GET", "/api/items"))).items.length;
}

describe("Access JWT", () => {
  it("accepts a valid token", async () => {
    expect((await withToken(await accessToken())).status).toBe(200);
  });

  it("rejects a request with no token, on the API and on the page", async () => {
    expect((await withToken(undefined)).status).toBe(401);
    expect((await send(`${ADMIN}/`)).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect(await itemCount()).toBe(0);
  });

  it("rejects garbage and structurally broken tokens", async () => {
    for (const token of ["nope", "a.b.c", "..", `${await accessToken()}.extra`]) {
      expect((await withToken(token)).status, token).toBe(401);
    }
  });

  it("rejects a token signed by another key", async () => {
    expect((await withToken(await accessToken({ key: await otherKey() }))).status).toBe(401);
  });

  it("rejects a token whose payload was altered after signing", async () => {
    const [h, , s] = (await accessToken({ claims: { aud: ["someone-else"] } })).split(".");
    const [, goodPayload] = (await accessToken()).split(".");
    expect((await withToken(`${h}.${goodPayload}.${s}`)).status).toBe(401);
  });

  it("rejects the wrong audience, issuer, or an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad: Record<string, unknown>[] = [
      { aud: ["another-app"] },
      { aud: "another-app" },
      { aud: undefined },
      { iss: "https://attacker.cloudflareaccess.com" },
      { iss: undefined },
      { exp: now - 1 },
      { exp: undefined },
      { exp: String(now + 300) },
      { nbf: now + 3600 },
    ];
    for (const claims of bad) {
      expect((await withToken(await accessToken({ claims }))).status, JSON.stringify(claims)).toBe(401);
    }
  });

  it("rejects alg none, HS256 and an unknown key id", async () => {
    const [h, p] = (await accessToken({ header: { alg: "none" } })).split(".");
    expect((await withToken(`${h}.${p}.`)).status).toBe(401);
    expect((await withToken(await accessToken({ header: { alg: "none" } }))).status).toBe(401);
    expect((await withToken(await accessToken({ header: { alg: "HS256" } }))).status).toBe(401);
    expect((await withToken(await accessToken({ header: { kid: "unknown" } }))).status).toBe(401);
  });

  it("fails closed when Access is not configured", async () => {
    const token = await accessToken();
    for (const override of [{ ACCESS_AUD: "" }, { ACCESS_TEAM_DOMAIN: "" }]) {
      const res = await worker.fetch(
        new Request(`${ADMIN}/api/items`, { headers: { "Cf-Access-Jwt-Assertion": token } }),
        { ...env, ...override },
      );
      expect(res.status).toBe(401);
    }
  });

  it("fails closed when the signing keys cannot be fetched", async () => {
    const spy = await installAccess();
    spy.mockImplementation(async () => new Response("down", { status: 503 }));
    expect((await withToken(await accessToken())).status).toBe(401);
  });

  it("caches the signing keys across requests", async () => {
    const spy = await installAccess();
    for (let i = 0; i < 3; i++) expect((await withToken(await accessToken())).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("cross-site request defences", () => {
  const authed = async (extra: Record<string, string>) =>
    post({ "Cf-Access-Jwt-Assertion": await accessToken(), ...extra });

  it("accepts same-origin and non-browser writes", async () => {
    expect((await authed({})).status).toBe(201);
    expect((await authed({ "Sec-Fetch-Site": "same-origin", Origin: ADMIN })).status).toBe(201);
    expect((await authed({ "Sec-Fetch-Site": "none" })).status).toBe(201);
  });

  it("rejects a write whose Sec-Fetch-Site is not same-origin or none", async () => {
    // same-site is what a bundle on the content host would send.
    for (const site of ["same-site", "cross-site", "bogus"]) {
      const res = await authed({ "Sec-Fetch-Site": site });
      expect(res.status, site).toBe(403);
      expect(await errorCode(res)).toBe("cross_site");
    }
    expect(await itemCount()).toBe(0);
  });

  it("rejects a write from a foreign Origin", async () => {
    for (const origin of [`https://${env.CONTENT_HOST}`, "https://evil.example", "null", `http://${env.ADMIN_HOST}`]) {
      const res = await authed({ Origin: origin });
      expect(res.status, origin).toBe(403);
      expect(await errorCode(res)).toBe("bad_origin");
    }
    // The origin check stands on its own, whatever Sec-Fetch-Site claims.
    expect((await authed({ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
    expect(await itemCount()).toBe(0);
  });

  it("applies the same checks to DELETE, PATCH and PUT", async () => {
    await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "keep" }));
    for (const method of ["DELETE", "PATCH", "PUT"]) {
      const res = await admin(method, "/api/items/keep", method === "DELETE" ? undefined : {}, {
        "Sec-Fetch-Site": "same-site",
      });
      expect(res.status, method).toBe(403);
    }
    expect(await itemCount()).toBe(1);
  });

  it("answers no preflight and sends no CORS headers", async () => {
    const res = await send(`${ADMIN}/api/links`, {
      method: "OPTIONS",
      headers: {
        Origin: `https://${env.CONTENT_HOST}`,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Cf-Access-Jwt-Assertion": await accessToken(),
      },
    });
    expect(res.status).toBe(405);
    const cors = [...res.headers.keys()].filter((k) => k.startsWith("access-control-"));
    expect(cors).toEqual([]);

    const get = await admin("GET", "/api/items", undefined, { Origin: `https://${env.CONTENT_HOST}` });
    expect([...get.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("requires a JSON content type or the custom header on writes", async () => {
    const token = await accessToken();
    // What a cross-origin HTML form or a no-preflight fetch can send.
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await send(`${ADMIN}/api/links`, {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token, "Content-Type": type },
        body: JSON.stringify({ url: "https://example.com/" }),
      });
      expect(res.status, type).toBe(415);
    }
    const bare = await send(`${ADMIN}/api/items/x`, { method: "DELETE", headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(bare.status).toBe(415);
    expect(await itemCount()).toBe(0);
  });
});

describe("admin page", () => {
  it("serves the UI with a locked-down CSP and no cookie", async () => {
    const res = await admin("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1];
    expect(html).toContain(`<script nonce="${nonce}">`);
    // No plain form posts: forms have no action/method and submit through fetch.
    expect(html).not.toMatch(/<form[^>]*(action|method)=/);
    expect(html).toContain('"X-Share-Client"');
  });

  it("never sets a cookie on API responses", async () => {
    const created = await admin("POST", "/api/links", { url: "https://example.com/" });
    expect(created.headers.get("Set-Cookie")).toBeNull();
    expect((await admin("GET", "/api/items")).headers.get("Set-Cookie")).toBeNull();
  });
});

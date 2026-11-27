import { describe, expect, it } from "vitest";
import contentSource from "../src/content.ts?raw";
import { accessToken, admin, ADMIN, CONTENT, ok, send } from "./helpers";

describe("host dispatch", () => {
  it("returns 404 on an unknown host, even for a valid admin request", async () => {
    for (const host of ["share.example.workers.dev", "joshbowen.net", "go.joshbowen.net.evil.example"]) {
      const res = await send(`https://${host}/api/items`, {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      });
      expect(res.status, host).toBe(404);
    }
    expect((await send("https://example.com/")).status).toBe(404);
  });

  it("does not expose the admin API on the content host", async () => {
    const headers = { "Cf-Access-Jwt-Assertion": await accessToken(), "X-Share-Client": "test" };
    const list = await send(`${CONTENT}/api/items`, { headers });
    expect(list.status).toBe(404);
    expect(await list.text()).toBe("Not found\n");

    const create = await send(`${CONTENT}/api/links`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(create.status).toBe(405);
    expect(await ok(admin("GET", "/api/items"))).toEqual({ items: [] });
  });

  it("does not serve content on the admin host", async () => {
    const item = await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "gh" }));
    expect((await send(`${CONTENT}/gh`)).status).toBe(302);

    const res = await admin("GET", "/gh");
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
    // And without a token the admin host gives nothing away at all.
    expect((await send(`${ADMIN}/${item.slug}`)).status).toBe(401);
  });

  it("keeps the content module free of admin imports", () => {
    const imports = [...contentSource.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => i!.includes("admin"))).toEqual([]);
  });
});

describe("content host", () => {
  it("allows only GET and HEAD", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const res = await send(`${CONTENT}/anything`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD");
    }
  });

  it("has no index: / is a bare 404", async () => {
    const res = await send(`${CONTENT}/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found\n");
  });

  it("disallows all crawling in robots.txt", async () => {
    const res = await send(`${CONTENT}/robots.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("never sets a cookie", async () => {
    await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "l" }));
    await ok(admin("POST", "/api/pastes", { content: "hi", slug: "p" }));
    for (const path of ["/", "/l", "/p", "/p/raw", "/missing", "/robots.txt"]) {
      expect((await send(CONTENT + path)).headers.get("Set-Cookie"), path).toBeNull();
    }
  });
});

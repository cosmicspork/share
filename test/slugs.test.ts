import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isValidSlug, randomSlug, RESERVED_SLUGS } from "../src/shared/slugs";
import { admin, CONTENT, draft, errorCode, ok, publish, r2Keys, send, upload, commit } from "./helpers";

const link = (body: Record<string, unknown>) => admin("POST", "/api/links", { url: "https://example.com/", ...body });

describe("slugs", () => {
  it("generates 6-character slugs from an unambiguous alphabet", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const slug = randomSlug();
      expect(slug).toMatch(/^[a-hjkmnp-z2-9]{6}$/);
      expect(isValidSlug(slug)).toBe(true);
      seen.add(slug);
    }
    expect(seen.size).toBeGreaterThan(495);

    const item = await ok(link({}));
    expect(item.slug).toMatch(/^[a-hjkmnp-z2-9]{6}$/);
    expect((await draft()).slug).toMatch(/^[a-hjkmnp-z2-9]{6}$/);
  });

  it("accepts custom slugs that match the pattern", async () => {
    for (const slug of ["a", "gh", "my-report-2026", "0", "a".repeat(63), "x-"]) {
      expect((await link({ slug })).status, slug).toBe(201);
    }
  });

  it("rejects malformed custom slugs", async () => {
    for (const slug of ["-a", "A", "Gh", "a_b", "a.b", "a b", "a/b", "ü", "a".repeat(64), "../x", 5, true]) {
      const res = await link({ slug });
      expect(res.status, String(slug)).toBe(400);
      expect(await errorCode(res)).toBe("bad_slug");
    }
  });

  it("refuses reserved slugs for every kind", async () => {
    expect([...RESERVED_SLUGS].sort()).toEqual(
      [".well-known", "admin", "api", "favicon.ico", "raw", "robots.txt", "static"],
    );
    for (const slug of RESERVED_SLUGS) {
      expect((await link({ slug, replace: true })).status, slug).toBe(400);
      expect((await admin("POST", "/api/pastes", { content: "x", slug })).status, slug).toBe(400);
      expect((await admin("POST", "/api/bundles", { slug })).status, slug).toBe(400);
      expect(isValidSlug(slug)).toBe(false);
    }
    expect(await errorCode(link({ slug: "api" }))).toBe("reserved_slug");
    // Reserved names resolve to nothing on the content host.
    for (const path of ["/api", "/admin", "/raw", "/static", "/favicon.ico", "/.well-known/security.txt"]) {
      expect((await send(CONTENT + path)).status, path).toBe(404);
    }
    expect((await ok(admin("GET", "/api/items"))).items).toEqual([]);
  });

  it("refuses a duplicate slug, across kinds, unless replace is set", async () => {
    await ok(link({ slug: "taken" }));
    for (const res of [
      await link({ slug: "taken", url: "https://other.example/" }),
      await link({ slug: "taken", replace: false }),
      await admin("POST", "/api/pastes", { content: "x", slug: "taken" }),
      await admin("POST", "/api/bundles", { slug: "taken" }),
    ]) {
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("slug_exists");
    }
    expect((await send(`${CONTENT}/taken`)).headers.get("Location")).toBe("https://example.com/");
    expect(await r2Keys()).toEqual([]);
  });

  it("re-checks for a duplicate at commit time", async () => {
    const d = await draft({ slug: "race" });
    await ok(upload(d, "index.html", "bundle"));
    await ok(link({ slug: "race" }));
    expect(await errorCode(commit(d))).toBe("slug_exists");
    expect((await send(`${CONTENT}/race`)).status).toBe(302);
  });

  it("replaces an item in place", async () => {
    const first = await ok(link({ slug: "r", title: "one" }));
    const res = await link({ slug: "r", url: "https://two.example/", replace: true });
    expect(res.status).toBe(200);
    const second = await res.json<any>();
    expect(second).toMatchObject({ target: "https://two.example/", title: null, created_at: first.created_at });
    expect((await send(`${CONTENT}/r`)).headers.get("Location")).toBe("https://two.example/");
    expect((await ok(admin("GET", "/api/items"))).items).toHaveLength(1);
  });

  it("lets replace create a slug that does not exist yet", async () => {
    expect((await link({ slug: "new", replace: true })).status).toBe(201);
  });

  it("can change the kind when replacing, and cleans up the old content", async () => {
    // link -> paste
    await ok(link({ slug: "s" }));
    await ok(admin("POST", "/api/pastes", { content: "text", slug: "s", replace: true }));
    expect(await (await send(`${CONTENT}/s/raw`)).text()).toBe("text");
    expect(await r2Keys()).toEqual(["p/s"]);

    // paste -> bundle
    const b = await publish({ "index.html": "page" }, { slug: "s", replace: true });
    expect(await (await send(`${CONTENT}/s/`)).text()).toBe("page");
    expect((await send(`${CONTENT}/s/raw`)).status).toBe(404);
    expect(await r2Keys()).toEqual([`b/s/${b.version}/index.html`]);

    // bundle -> link
    await ok(link({ slug: "s", replace: true }));
    const res = await send(`${CONTENT}/s`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(await r2Keys()).toEqual([]);

    const item = await ok(admin("GET", "/api/items/s"));
    expect(item).toMatchObject({ kind: "link", version: null, size: 0, file_count: 0, content_type: null });
  });
});

describe("items API", () => {
  it("lists most recently updated first and filters by kind", async () => {
    await ok(link({ slug: "l1" }));
    await ok(admin("POST", "/api/pastes", { content: "x", slug: "p1" }));
    await publish({ "index.html": "x" }, { slug: "b1" });
    await ok(link({ slug: "l2" }));
    // Spread the timestamps out; the tests run within one second.
    for (const [slug, t] of [["l1", 100], ["p1", 200], ["b1", 300], ["l2", 400]] as const) {
      await env.DB.prepare("UPDATE items SET updated_at = ? WHERE slug = ?").bind(t, slug).run();
    }

    const slugs = async (query = "") =>
      (await ok(admin("GET", `/api/items${query}`))).items.map((i: any) => i.slug);
    expect(await slugs()).toEqual(["l2", "b1", "p1", "l1"]);
    expect(await slugs("?kind=link")).toEqual(["l2", "l1"]);
    expect(await slugs("?kind=paste")).toEqual(["p1"]);
    expect(await slugs("?kind=bundle")).toEqual(["b1"]);
    expect(await slugs("?limit=1&offset=1")).toEqual(["b1"]);
    expect((await admin("GET", "/api/items?kind=nope")).status).toBe(400);
  });

  it("gets one item and 404s on a missing one", async () => {
    await ok(link({ slug: "one", title: "One" }));
    expect(await ok(admin("GET", "/api/items/one"))).toMatchObject({
      slug: "one", kind: "link", title: "One", url: `${CONTENT}/one`, expires_at: null, expired: false, sandbox: null,
    });
    expect((await admin("GET", "/api/items/none")).status).toBe(404);
    expect((await admin("GET", "/api/nothing")).status).toBe(404);
    expect((await admin("PUT", "/api/items/one", {})).status).toBe(405);
  });

  it("patches title, expiry and sandbox, leaving other fields alone", async () => {
    await publish({ "index.html": "x" }, { slug: "b", title: "Old" });

    let item = await ok(admin("PATCH", "/api/items/b", { title: "New" }));
    expect(item).toMatchObject({ title: "New", sandbox: true, expires_at: null });

    item = await ok(admin("PATCH", "/api/items/b", { expires_in: "7d", sandbox: false }));
    expect(item).toMatchObject({ title: "New", sandbox: false });
    const days = (Date.parse(item.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);

    item = await ok(admin("PATCH", "/api/items/b", { expires_at: null, title: null }));
    expect(item).toMatchObject({ title: null, expires_at: null, sandbox: false });

    expect((await admin("PATCH", "/api/items/b", { sandbox: "yes" })).status).toBe(400);
    expect((await admin("PATCH", "/api/items/b", { title: "x".repeat(201) })).status).toBe(400);
    expect((await admin("PATCH", "/api/items/none", { title: "x" })).status).toBe(404);

    await ok(link({ slug: "l" }));
    expect((await admin("PATCH", "/api/items/l", { sandbox: false })).status).toBe(400);
  });
});

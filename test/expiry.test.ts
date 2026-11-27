import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { parseDuration } from "../src/shared/duration";
import { admin, commit, CONTENT, draft, errorCode, ok, publish, r2Keys, send, upload } from "./helpers";

const now = () => Math.floor(Date.now() / 1000);

/** Move an item's expiry into the past, as if time had gone by. */
const expire = (slug: string) =>
  env.DB.prepare("UPDATE items SET expires_at = ? WHERE slug = ?").bind(now() - 10, slug).run();

async function runCron(): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController(), env, ctx);
  await waitOnExecutionContext(ctx);
}

const slugs = async () => (await ok(admin("GET", "/api/items"))).items.map((i: any) => i.slug).sort();

describe("expiry", () => {
  it("parses durations", () => {
    expect(parseDuration("7d")).toBe(604800);
    expect(parseDuration("12h")).toBe(43200);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("45s")).toBe(45);
    expect(parseDuration("2w")).toBe(1209600);
    for (const bad of ["", "7", "d", "7 days", "-1d", "0d", "1.5h", "7y"]) expect(parseDuration(bad), bad).toBeNull();
  });

  it("stores an expiry given as a duration, as seconds, or as a timestamp", async () => {
    const a = await ok(admin("POST", "/api/links", { url: "https://example.com/", expires_in: "1h" }));
    const b = await ok(admin("POST", "/api/links", { url: "https://example.com/", expires_in: 3600 }));
    const at = new Date(Date.now() + 3600_000).toISOString();
    const c = await ok(admin("POST", "/api/links", { url: "https://example.com/", expires_at: at }));
    for (const item of [a, b, c]) {
      const minutes = (Date.parse(item.expires_at) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(59.9);
      expect(minutes).toBeLessThanOrEqual(60);
      expect(item.expired).toBe(false);
    }
    expect((await send(`${CONTENT}/${a.slug}`)).status).toBe(302);
  });

  it("rejects a malformed or past expiry", async () => {
    const bodies = [
      { expires_in: "soon" },
      { expires_in: -5 },
      { expires_in: 0 },
      { expires_at: "yesterday" },
      { expires_at: "2001-01-01T00:00:00Z" },
      { expires_at: 12345 },
      { expires_at: new Date(Date.now() + 1000).toISOString(), expires_in: "1d" },
    ];
    for (const body of bodies) {
      const res = await admin("POST", "/api/links", { url: "https://example.com/", ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(res)).toBe("bad_expiry");
    }
  });

  it("returns 410 for an expired slug of each kind, on every path", async () => {
    await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "l", expires_in: "1d" }));
    await ok(admin("POST", "/api/pastes", { content: "x", slug: "p", expires_in: "1d" }));
    await publish({ "index.html": "x", "a.js": "1" }, { slug: "b", expires_in: "1d" });
    const paths = ["/l", "/p", "/p/raw", "/b", "/b/", "/b/a.js"];
    for (const path of paths) expect((await send(CONTENT + path)).status, path).toBeLessThan(400);

    for (const slug of ["l", "p", "b"]) await expire(slug);
    for (const path of paths) {
      const res = await send(CONTENT + path);
      expect(res.status, path).toBe(410);
      expect(res.headers.get("Location")).toBeNull();
      expect(await res.text()).toBe("Gone\n");
    }
    expect((await ok(admin("GET", "/api/items/l"))).expired).toBe(true);
  });

  it("carries a bundle's expiry from the draft to the committed item", async () => {
    const d = await draft({ slug: "b", expires_in: "2d" });
    await ok(upload(d, "index.html", "x"));
    const item = await ok(commit(d));
    expect((Date.parse(item.expires_at) - Date.now()) / 86_400_000).toBeGreaterThan(1.99);
  });

  it("can bring an expired slug back by replacing it or clearing the expiry", async () => {
    await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "a", expires_in: "1d" }));
    await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "b", expires_in: "1d" }));
    await expire("a");
    await expire("b");

    // Expired but not yet swept still occupies the slug.
    expect((await admin("POST", "/api/links", { url: "https://example.com/", slug: "a" })).status).toBe(409);
    await ok(admin("POST", "/api/links", { url: "https://new.example/", slug: "a", replace: true }));
    expect((await send(`${CONTENT}/a`)).headers.get("Location")).toBe("https://new.example/");

    await ok(admin("PATCH", "/api/items/b", { expires_at: null }));
    expect((await send(`${CONTENT}/b`)).status).toBe(302);
  });
});

describe("daily cleanup", () => {
  it("deletes expired rows and their objects, and nothing else", async () => {
    await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "old-link", expires_in: "1d" }));
    await ok(admin("POST", "/api/pastes", { content: "x", slug: "old-paste", expires_in: "1d" }));
    await publish({ "index.html": "x", "a/b.js": "1" }, { slug: "old-bundle", expires_in: "1d" });
    for (const slug of ["old-link", "old-paste", "old-bundle"]) await expire(slug);

    await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "keep-link" }));
    await ok(admin("POST", "/api/pastes", { content: "x", slug: "keep-paste", expires_in: "1d" }));
    const keep = await publish({ "index.html": "x" }, { slug: "keep-bundle" });

    await runCron();

    expect(await slugs()).toEqual(["keep-bundle", "keep-link", "keep-paste"]);
    expect(await r2Keys()).toEqual([`b/keep-bundle/${keep.version}/index.html`, "p/keep-paste"]);
    // Swept slugs are plain 404s now, and free to reuse.
    expect((await send(`${CONTENT}/old-link`)).status).toBe(404);
    expect((await admin("POST", "/api/links", { url: "https://example.com/", slug: "old-link" })).status).toBe(201);
  });

  it("deletes stale drafts and their uploads, but not recent drafts", async () => {
    const stale = await draft({ slug: "stale" });
    await ok(upload(stale, "index.html", "x"));
    await ok(upload(stale, "deep/file.js", "x"));
    const recent = await draft({ slug: "recent" });
    await ok(upload(recent, "index.html", "x"));
    await env.DB.prepare("UPDATE drafts SET created_at = ? WHERE slug = 'stale'").bind(now() - 25 * 3600).run();

    await runCron();

    expect(await r2Keys()).toEqual([`b/recent/${recent.version}/index.html`]);
    expect((await commit(stale)).status).toBe(404);
    await ok(commit(recent));
    expect((await send(`${CONTENT}/recent/`)).status).toBe(200);
  });

  it("does not touch a stale draft of a slug whose live bundle is a different version", async () => {
    const live = await publish({ "index.html": "live" }, { slug: "site" });
    const abandoned = await draft({ slug: "site", replace: true });
    await ok(upload(abandoned, "index.html", "never committed"));
    await env.DB.prepare("UPDATE drafts SET created_at = 0").run();

    await runCron();

    expect(await r2Keys()).toEqual([`b/site/${live.version}/index.html`]);
    expect(await (await send(`${CONTENT}/site/`)).text()).toBe("live");
  });

  it("is a no-op on empty storage", async () => {
    await runCron();
    expect(await slugs()).toEqual([]);
  });
});

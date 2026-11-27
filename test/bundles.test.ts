import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, MAX_FILE_BYTES } from "../src/shared/limits";
import { normalizePath } from "../src/shared/paths";
import { admin, commit, CONTENT, draft, errorCode, ok, publish, r2Keys, send, upload } from "./helpers";

const SANDBOX = "sandbox allow-scripts allow-popups allow-forms allow-modals";

describe("serving a bundle", () => {
  it("redirects /slug to /slug/ and serves files by path", async () => {
    await publish(
      { "index.html": "<h1>hi</h1>", "css/app.css": "body{}", "app.js": "1", "data.bin": "x" },
      { slug: "report" },
    );

    const bare = await send(`${CONTENT}/report?x=1`);
    expect(bare.status).toBe(301);
    expect(bare.headers.get("Location")).toBe("/report/?x=1");

    const index = await send(`${CONTENT}/report/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toBe("<h1>hi</h1>");

    const types: Record<string, string> = {
      "index.html": "text/html; charset=utf-8",
      "css/app.css": "text/css; charset=utf-8",
      "app.js": "text/javascript; charset=utf-8",
      "data.bin": "application/octet-stream",
    };
    for (const [path, type] of Object.entries(types)) {
      const res = await send(`${CONTENT}/report/${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toBe(type);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      await res.arrayBuffer();
    }
  });

  it("takes the content type from the extension, not from the uploader", async () => {
    const d = await draft({ slug: "typed" });
    await ok(admin("PUT", `/api/bundles/typed/${d.version}/files/index.html`, "<p>", { "Content-Type": "text/plain" }));
    await ok(admin("PUT", `/api/bundles/typed/${d.version}/files/notes.txt`, "<script>", { "Content-Type": "text/html" }));
    await ok(commit(d));
    expect((await send(`${CONTENT}/typed/notes.txt`)).headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect((await send(`${CONTENT}/typed/`)).headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns 404 for a missing file, with no SPA fallback", async () => {
    await publish({ "index.html": "home" }, { slug: "spa" });
    for (const path of ["nope.html", "deep/route", "index.html/extra", "css/"]) {
      const res = await send(`${CONTENT}/spa/${path}`);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe("Not found\n");
    }
  });

  it("sends the sandbox CSP by default, on every file", async () => {
    await publish({ "index.html": "<script>1</script>", "a.js": "1" }, { slug: "boxed" });
    for (const path of ["", "index.html", "a.js"]) {
      const res = await send(`${CONTENT}/boxed/${path}`);
      expect(res.headers.get("Content-Security-Policy"), path).toBe(SANDBOX);
      await res.arrayBuffer();
    }
    expect((await ok(admin("GET", "/api/items/boxed"))).sandbox).toBe(true);
    expect((await send(`${CONTENT}/boxed/`, { method: "HEAD" })).headers.get("Content-Security-Policy")).toBe(SANDBOX);
  });

  it("omits the sandbox only when asked, and PATCH can turn it back on", async () => {
    await publish({ "index.html": "trusted" }, { slug: "open", sandbox: false });
    expect((await send(`${CONTENT}/open/`)).headers.get("Content-Security-Policy")).toBeNull();

    await ok(admin("PATCH", "/api/items/open", { sandbox: true }));
    expect((await send(`${CONTENT}/open/`)).headers.get("Content-Security-Policy")).toBe(SANDBOX);
  });

  it("supports HEAD and ETag revalidation", async () => {
    await publish({ "index.html": "12345" }, { slug: "cache" });
    const head = await send(`${CONTENT}/cache/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("5");
    expect(await head.text()).toBe("");

    const etag = head.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    const again = await send(`${CONTENT}/cache/`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    const changed = await send(`${CONTENT}/cache/`, { headers: { "If-None-Match": '"other"' } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe("12345");
  });
});

describe("atomic publish", () => {
  it("shows a reader nothing until the commit", async () => {
    const d = await draft({ slug: "fresh" });
    await ok(upload(d, "index.html", "v1"));
    expect((await send(`${CONTENT}/fresh`)).status).toBe(404);
    expect((await send(`${CONTENT}/fresh/`)).status).toBe(404);
    expect((await ok(admin("GET", "/api/items"))).items).toEqual([]);

    await ok(commit(d));
    expect(await (await send(`${CONTENT}/fresh/`)).text()).toBe("v1");
  });

  it("keeps serving the old version, whole, while a new one uploads", async () => {
    await publish({ "index.html": "old index", "a.js": "old a", "gone.js": "old only" }, { slug: "site" });

    const d = await draft({ slug: "site", replace: true });
    await ok(upload(d, "index.html", "new index"));
    // Mid-upload: the reader still gets every file of the old version.
    expect(await (await send(`${CONTENT}/site/`)).text()).toBe("old index");
    expect(await (await send(`${CONTENT}/site/a.js`)).text()).toBe("old a");
    await ok(upload(d, "a.js", "new a"));
    await ok(upload(d, "added.js", "new only"));
    expect(await (await send(`${CONTENT}/site/a.js`)).text()).toBe("old a");
    expect((await send(`${CONTENT}/site/added.js`)).status).toBe(404);

    await ok(commit(d));
    expect(await (await send(`${CONTENT}/site/`)).text()).toBe("new index");
    expect(await (await send(`${CONTENT}/site/a.js`)).text()).toBe("new a");
    expect(await (await send(`${CONTENT}/site/added.js`)).text()).toBe("new only");
    // Files that only the old version had do not leak into the new one.
    expect((await send(`${CONTENT}/site/gone.js`)).status).toBe(404);
  });

  it("deletes the previous version's objects after a commit", async () => {
    const first = await publish({ "index.html": "1", "x.js": "1" }, { slug: "ver" });
    const second = await publish({ "index.html": "2" }, { slug: "ver", replace: true });
    expect(second.version).not.toBe(first.version);
    expect(await r2Keys()).toEqual([`b/ver/${second.version}/index.html`]);

    const item = await ok(admin("GET", "/api/items/ver"));
    expect(item).toMatchObject({ kind: "bundle", version: second.version, file_count: 1, size: 1 });
  });

  it("refuses a commit with no index.html and leaves readers untouched", async () => {
    await publish({ "index.html": "live" }, { slug: "idx" });
    const d = await draft({ slug: "idx", replace: true });
    await ok(upload(d, "main.js", "1"));
    await ok(upload(d, "sub/index.html", "not at the root"));

    const res = await commit(d);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("missing_index");
    expect(await (await send(`${CONTENT}/idx/`)).text()).toBe("live");

    // The draft survives, so the upload can be completed and committed.
    await ok(upload(d, "index.html", "fixed"));
    await ok(commit(d));
    expect(await (await send(`${CONTENT}/idx/`)).text()).toBe("fixed");
  });

  it("refuses an empty commit, a second commit, and uploads to a committed version", async () => {
    const empty = await draft();
    expect(await errorCode(commit(empty))).toBe("missing_index");

    const d = await publish({ "index.html": "x" }, { slug: "once" });
    expect((await commit(d)).status).toBe(404);
    // The live version is immutable: no upload can reach it after the commit.
    expect((await upload(d, "index.html", "defaced")).status).toBe(404);
    expect(await (await send(`${CONTENT}/once/`)).text()).toBe("x");
  });

  it("refuses uploads to a draft that was never created", async () => {
    const res = await upload({ slug: "ghost", version: "abc123" }, "index.html", "x");
    expect(res.status).toBe(404);
    expect(await r2Keys()).toEqual([]);
  });

  it("deletes stale uncommitted drafts after a commit, but not recent ones", async () => {
    const stale = await draft({ slug: "stale" });
    await ok(upload(stale, "index.html", "abandoned"));
    const recent = await draft({ slug: "recent" });
    await ok(upload(recent, "index.html", "in progress"));
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
    await env.DB.prepare("UPDATE drafts SET created_at = ? WHERE slug = 'stale'").bind(twoDaysAgo).run();

    const done = await publish({ "index.html": "x" }, { slug: "done" });

    expect(await r2Keys()).toEqual([
      `b/done/${done.version}/index.html`,
      `b/recent/${recent.version}/index.html`,
    ]);
    expect((await upload(stale, "more.js", "x")).status).toBe(404);
    await ok(commit(recent));
  });
});

describe("bundle paths", () => {
  it("rejects traversal, absolute paths, backslashes, NUL and empty segments", () => {
    const bad = [
      "", "/", "/etc/passwd", "..", "../x", "a/../b", "a/..", "./a", "a/./b", ".",
      "a//b", "a/", "/a", "a\\b", "..\\x", "a\0b", "a\nb", "x".repeat(600),
    ];
    for (const path of bad) expect(normalizePath(path), JSON.stringify(path)).toBeNull();
    for (const path of ["index.html", "a/b/c.js", "..a", "a..b/c", ".hidden", "sp ace.txt", "ü.txt"]) {
      expect(normalizePath(path), path).toBe(path);
    }
  });

  it("rejects bad upload paths over HTTP and stores nothing", async () => {
    const d = await draft({ slug: "paths" });
    const bad = [
      "..%2Fescape.html",        // encoded slash hiding a traversal
      "%2e%2e%2Fescape.html",
      "a%2F..%2F..%2Fescape",
      "..%5Cescape.html",        // backslash
      "a%5Cb.html",
      "a%00b.html",              // NUL
      "%2Fetc%2Fpasswd",         // absolute
      "a//b.html",               // empty segment
      "a/",
      "%E0%A4%A",                // malformed escape
    ];
    for (const path of bad) {
      const res = await upload(d, path, "x");
      expect(res.status, path).toBe(400);
      expect(await errorCode(res), path).toBe("bad_path");
    }
    // Dot segments are resolved by URL parsing before routing, so these can
    // only miss the upload route; they must never write outside the draft.
    for (const path of ["../../../p/other", "../other/index.html", "a/../../x"]) {
      const res = await upload(d, path, "x");
      expect(res.status, path).toBeGreaterThanOrEqual(400);
    }
    expect(await r2Keys()).toEqual([]);
  });

  it("serves nothing for traversal attempts on the content host", async () => {
    await ok(admin("POST", "/api/pastes", { content: "secret", slug: "secret" }));
    await publish({ "index.html": "home" }, { slug: "site" });
    const item = await ok(admin("GET", "/api/items/site"));
    for (const path of [
      "..%2F..%2F..%2Fp%2Fsecret",
      `..%2F${item.version}%2Findex.html`,
      "..%5C..%5Cp%5Csecret",
      "%2Fp%2Fsecret",
      "a%00",
      "%",
    ]) {
      const res = await send(`${CONTENT}/site/${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("round-trips paths with spaces and non-ASCII characters", async () => {
    const d = await draft({ slug: "names" });
    await ok(upload(d, "index.html", "x"));
    await ok(upload(d, "my%20file%20%C3%BC.txt", "spaced"));
    await ok(commit(d));
    expect(await (await send(`${CONTENT}/names/my%20file%20%C3%BC.txt`)).text()).toBe("spaced");
  });
});

describe("bundle limits", () => {
  // Limits are checked against what is actually stored, so these tests put
  // objects straight into the draft's prefix rather than upload megabytes.
  const fill = (slug: string, version: string, name: string, bytes: number) =>
    env.BUCKET.put(`b/${slug}/${version}/${name}`, new Uint8Array(bytes));

  it(`accepts ${MAX_BUNDLE_FILES} files and refuses one more`, async () => {
    const d = await draft({ slug: "many" });
    await ok(upload(d, "index.html", "x"));
    await Promise.all(Array.from({ length: MAX_BUNDLE_FILES - 1 }, (_, i) => fill("many", d.version, `f${i}.txt`, 1)));
    const extra = await draft({ slug: "toomany" });
    await ok(upload(extra, "index.html", "x"));
    await Promise.all(Array.from({ length: MAX_BUNDLE_FILES }, (_, i) => fill("toomany", extra.version, `f${i}.txt`, 1)));

    expect((await ok(commit(d))).file_count).toBe(MAX_BUNDLE_FILES);
    const res = await commit(extra);
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("too_many_files");
    expect((await send(`${CONTENT}/toomany/`)).status).toBe(404);
  });

  it("refuses a bundle over 20 MiB in total", async () => {
    const d = await draft({ slug: "big" });
    await ok(upload(d, "index.html", "x"));
    await fill("big", d.version, "a.bin", MAX_BUNDLE_BYTES / 2);
    await fill("big", d.version, "b.bin", MAX_BUNDLE_BYTES / 2);
    const res = await commit(d);
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("bundle_too_large");
    expect((await send(`${CONTENT}/big/`)).status).toBe(404);
  });

  it("accepts a bundle of exactly 20 MiB", async () => {
    const d = await draft({ slug: "full" });
    await ok(upload(d, "index.html", "x"));
    await fill("full", d.version, "a.bin", MAX_BUNDLE_BYTES / 2);
    await fill("full", d.version, "b.bin", MAX_BUNDLE_BYTES / 2 - 1);
    expect((await ok(commit(d))).size).toBe(MAX_BUNDLE_BYTES);
  });

  it("refuses a single file over 16 MiB, at upload and at commit", async () => {
    const d = await draft({ slug: "fat" });
    const res = await upload(d, "huge.bin", new Uint8Array(MAX_FILE_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("file_too_large");
    expect(await r2Keys()).toEqual([]);

    await ok(upload(d, "index.html", "x"));
    await ok(upload(d, "max.bin", new Uint8Array(MAX_FILE_BYTES)));
    await fill("fat", d.version, "smuggled.bin", MAX_FILE_BYTES + 1);
    expect(await errorCode(commit(d))).toBe("file_too_large");
  });
});

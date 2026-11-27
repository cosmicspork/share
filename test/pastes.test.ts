import { describe, expect, it } from "vitest";
import { MAX_PASTE_BYTES } from "../src/shared/limits";
import { admin, CONTENT, errorCode, ok, r2Keys, send } from "./helpers";

const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>&amp; "quoted" 'single' </pre><h1>out</h1>`;

describe("pastes", () => {
  it("stores text and serves it raw as text/plain", async () => {
    const item = await ok(admin("POST", "/api/pastes", { content: "hello\nworld\n" }));
    expect(item).toMatchObject({ kind: "paste", content_type: "text/plain", size: 12 });
    expect(item.url).toBe(`${CONTENT}/${item.slug}`);
    expect(await r2Keys()).toEqual([`p/${item.slug}`]);

    const raw = await send(`${CONTENT}/${item.slug}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(raw.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await raw.text()).toBe("hello\nworld\n");
  });

  it("shows an escaped viewer with a strict CSP and no scripts", async () => {
    await ok(admin("POST", "/api/pastes", { content: HOSTILE, slug: "x", title: "<b>title</b>" }));
    const res = await send(`${CONTENT}/x`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const html = await res.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<h1>out</h1>");
    expect(html).not.toContain("<b>title</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;title&lt;/b&gt;");
    expect(html).toContain("&amp;amp;");
    // The only <pre> that closes is the viewer's own.
    expect(html.match(/<\/pre>/g)).toHaveLength(1);
  });

  it("never serves a paste as HTML, whatever it contains or claims to be", async () => {
    const page = "<!doctype html><html><body><script>alert(1)</script></body></html>";
    await ok(admin("POST", "/api/pastes", { content: page, slug: "html", content_type: "text/html" }));
    await ok(admin("POST", "/api/pastes", { content: page, slug: "md", content_type: "text/markdown" }));

    for (const slug of ["html", "md"]) {
      const raw = await send(`${CONTENT}/${slug}/raw`);
      expect(raw.headers.get("Content-Type"), slug).toBe("text/plain; charset=utf-8");
      expect(raw.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(await raw.text()).toBe(page);

      const viewer = await (await send(`${CONTENT}/${slug}`)).text();
      expect(viewer).not.toContain("<script>");
      expect(viewer).toContain("&lt;script&gt;");
    }
    // No other path reaches the stored bytes.
    for (const path of ["/html/index.html", "/html/raw/", "/html/raw.html", "/html/x"]) {
      expect((await send(CONTENT + path)).status, path).toBe(404);
    }
  });

  it("accepts only text/* content types", async () => {
    for (const content_type of ["application/javascript", "image/svg+xml", "text/", "TEXT/HTML", "text/html; charset=x", 5]) {
      const res = await admin("POST", "/api/pastes", { content: "x", content_type });
      expect(res.status, String(content_type)).toBe(400);
    }
    expect(await r2Keys()).toEqual([]);
  });

  it("limits a paste to 1 MiB, counted in bytes", async () => {
    await ok(admin("POST", "/api/pastes", { content: "a".repeat(MAX_PASTE_BYTES), slug: "max" }));
    const over = await admin("POST", "/api/pastes", { content: "a".repeat(MAX_PASTE_BYTES + 1) });
    expect(over.status).toBe(413);
    expect(await errorCode(over)).toBe("too_large");
    // Fewer characters than the limit, more bytes.
    const wide = await admin("POST", "/api/pastes", { content: "é".repeat(MAX_PASTE_BYTES / 2 + 1) });
    expect(wide.status).toBe(413);
    expect(await r2Keys()).toEqual(["p/max"]);
  });

  it("requires string content", async () => {
    for (const body of [{}, { content: 5 }, { content: null }, { content: ["x"] }]) {
      expect((await admin("POST", "/api/pastes", body)).status).toBe(400);
    }
    const notJson = await admin("POST", "/api/pastes", "{nope", { "Content-Type": "application/json" });
    expect(await errorCode(notJson)).toBe("bad_json");
  });

  it("deletes the stored text with the item", async () => {
    await ok(admin("POST", "/api/pastes", { content: "bye", slug: "tmp" }));
    expect((await admin("DELETE", "/api/items/tmp")).status).toBe(204);
    expect(await r2Keys()).toEqual([]);
    expect((await send(`${CONTENT}/tmp`)).status).toBe(404);
    expect((await send(`${CONTENT}/tmp/raw`)).status).toBe(404);
    expect((await admin("DELETE", "/api/items/tmp")).status).toBe(404);
  });
});

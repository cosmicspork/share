import { describe, expect, it } from "vitest";
import { admin, CONTENT, errorCode, ok, send } from "./helpers";

describe("links", () => {
  it("redirects with a 302 to the target", async () => {
    const item = await ok(admin("POST", "/api/links", { url: "https://github.com/cosmicspork?tab=repos#x", slug: "gh" }));
    expect(item).toMatchObject({ slug: "gh", kind: "link", url: `${CONTENT}/gh`, target: "https://github.com/cosmicspork?tab=repos#x" });

    for (const path of ["/gh", "/gh/"]) {
      const res = await send(CONTENT + path);
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://github.com/cosmicspork?tab=repos#x");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
    expect((await send(`${CONTENT}/gh/raw`)).status).toBe(404);
    expect((await send(`${CONTENT}/gh/more`)).status).toBe(404);
    expect((await send(`${CONTENT}/gh`, { method: "HEAD" })).status).toBe(302);
  });

  it("accepts http and https targets", async () => {
    for (const url of ["http://example.com/", "https://example.com/a?b=c", "HTTPS://EXAMPLE.com/Path"]) {
      expect((await admin("POST", "/api/links", { url })).status, url).toBe(201);
    }
  });

  it("rejects every other kind of target on write", async () => {
    const bad = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com/",
      "vbscript:x",
      "blob:https://example.com/x",
      "//example.com/",
      "/relative",
      "example.com",
      "",
      "https://",
      `https://example.com/${"a".repeat(3000)}`,
      null,
      42,
      ["https://example.com/"],
    ];
    for (const url of bad) {
      const res = await admin("POST", "/api/links", { url });
      expect(res.status, String(url)).toBe(400);
      expect(await errorCode(res)).toBe("bad_url");
    }
    expect((await admin("POST", "/api/links", {})).status).toBe(400);
    expect((await ok(admin("GET", "/api/items"))).items).toEqual([]);
  });

  it("validates the target again when a link is replaced", async () => {
    await ok(admin("POST", "/api/links", { url: "https://example.com/", slug: "safe" }));
    const res = await admin("POST", "/api/links", { url: "javascript:alert(1)", slug: "safe", replace: true });
    expect(res.status).toBe(400);
    expect((await send(`${CONTENT}/safe`)).headers.get("Location")).toBe("https://example.com/");
  });
});

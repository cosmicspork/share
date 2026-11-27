import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { resetJwksCache } from "../src/admin/auth";
import { installAccess } from "./helpers";

// Every test starts from empty storage and a schema built by the real migrations.
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([env.DB.prepare("DELETE FROM items"), env.DB.prepare("DELETE FROM drafts")]);
  for (;;) {
    const page = await env.BUCKET.list();
    if (page.objects.length === 0) break;
    await env.BUCKET.delete(page.objects.map((o) => o.key));
  }
  resetJwksCache();
  await installAccess();
});

afterEach(() => {
  vi.restoreAllMocks();
});

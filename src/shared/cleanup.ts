import type { Env } from "../env";
import { type ItemRow, nowSeconds } from "./items";
import { STALE_DRAFT_SECONDS } from "./limits";
import { deleteBundleVersion, deleteItemContent } from "./storage";

/** Delete bundle drafts that were never committed, and their uploaded files. */
export async function sweepStaleDrafts(env: Env, now = nowSeconds()): Promise<number> {
  const cutoff = now - STALE_DRAFT_SECONDS;
  // The join protects a live version: if a draft row somehow outlived its own
  // commit, its files are the published bundle and must stay.
  const { results } = await env.DB.prepare(
    `SELECT d.slug, d.version, (i.slug IS NOT NULL) AS live
       FROM drafts d
       LEFT JOIN items i ON i.slug = d.slug AND i.kind = 'bundle' AND i.version = d.version
      WHERE d.created_at < ?`,
  )
    .bind(cutoff)
    .all<{ slug: string; version: string; live: number }>();

  for (const d of results) {
    if (!d.live) await deleteBundleVersion(env.BUCKET, d.slug, d.version);
    await env.DB.prepare("DELETE FROM drafts WHERE slug = ? AND version = ?")
      .bind(d.slug, d.version)
      .run();
  }
  return results.length;
}

/** Delete expired items and their content. */
export async function sweepExpired(env: Env, now = nowSeconds()): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT slug, kind, version FROM items WHERE expires_at IS NOT NULL AND expires_at <= ?",
  )
    .bind(now)
    .all<Pick<ItemRow, "slug" | "kind" | "version">>();

  for (const item of results) {
    // Row first, and only if it is still the expired one: the slug may have
    // been republished since the SELECT.
    const res = await env.DB.prepare(
      `DELETE FROM items
        WHERE slug = ? AND kind = ? AND version IS ?
          AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
      .bind(item.slug, item.kind, item.version, now)
      .run();
    if (res.meta.changes > 0) await deleteItemContent(env.BUCKET, item);
  }
  return results.length;
}

export async function sweep(env: Env, now = nowSeconds()): Promise<void> {
  await sweepExpired(env, now);
  await sweepStaleDrafts(env, now);
}

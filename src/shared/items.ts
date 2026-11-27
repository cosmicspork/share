import type { Env } from "../env";

import { type Kind, KINDS } from "./kinds";

export { type Kind, KINDS };

/** A row of the `items` table. Timestamps are unix seconds. */
export interface ItemRow {
  slug: string;
  kind: Kind;
  title: string | null;
  target: string | null;
  version: string | null;
  content_type: string | null;
  sandbox: number;
  size: number;
  file_count: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export async function getItem(db: D1Database, slug: string): Promise<ItemRow | null> {
  return db.prepare("SELECT * FROM items WHERE slug = ?").bind(slug).first<ItemRow>();
}

export function isExpired(item: Pick<ItemRow, "expires_at">, now = nowSeconds()): boolean {
  return item.expires_at !== null && item.expires_at <= now;
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

/** The JSON shape the admin API returns for an item. */
export function itemToJson(item: ItemRow, env: Env) {
  return {
    slug: item.slug,
    kind: item.kind,
    url: `https://${env.CONTENT_HOST}/${item.slug}`,
    title: item.title,
    target: item.target,
    version: item.version,
    content_type: item.content_type,
    sandbox: item.kind === "bundle" ? item.sandbox === 1 : null,
    size: item.size,
    file_count: item.file_count,
    created_at: iso(item.created_at),
    updated_at: iso(item.updated_at),
    expires_at: item.expires_at === null ? null : iso(item.expires_at),
    expired: isExpired(item),
  };
}

export type ItemJson = ReturnType<typeof itemToJson>;

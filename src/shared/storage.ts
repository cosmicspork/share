import type { ItemRow } from "./items";

export const bundlePrefix = (slug: string, version: string): string => `b/${slug}/${version}/`;
export const bundleKey = (slug: string, version: string, path: string): string =>
  bundlePrefix(slug, version) + path;
export const pasteKey = (slug: string): string => `p/${slug}`;

export interface StoredFile {
  path: string;
  size: number;
}

/** Every object under a bundle version, with paths relative to the bundle root. */
export async function listBundle(
  bucket: R2Bucket,
  slug: string,
  version: string,
): Promise<StoredFile[]> {
  const prefix = bundlePrefix(slug, version);
  const files: StoredFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const o of page.objects) files.push({ path: o.key.slice(prefix.length), size: o.size });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return files;
}

export async function deleteBundleVersion(
  bucket: R2Bucket,
  slug: string,
  version: string,
): Promise<void> {
  const prefix = bundlePrefix(slug, version);
  const keys = (await listBundle(bucket, slug, version)).map((f) => prefix + f.path);
  // R2 deletes at most 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
}

/** Delete whatever content an item row points at. */
export async function deleteItemContent(
  bucket: R2Bucket,
  item: Pick<ItemRow, "slug" | "kind" | "version">,
): Promise<void> {
  if (item.kind === "bundle" && item.version) {
    await deleteBundleVersion(bucket, item.slug, item.version);
  } else if (item.kind === "paste") {
    await bucket.delete(pasteKey(item.slug));
  }
}

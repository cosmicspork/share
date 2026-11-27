import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, MAX_FILE_BYTES } from "../src/shared/limits";
import { normalizePath } from "../src/shared/paths";
import type { BundleFile } from "./client";

/**
 * The files of a bundle: a directory with an index.html at its root, or one
 * .html file, which becomes the bundle's index.html. Dotfiles are skipped and
 * symlinks are not followed. Limits are checked here so a doomed publish fails
 * before anything is uploaded; the server checks them again.
 */
export async function collectBundle(path: string): Promise<BundleFile[]> {
  const info = await stat(path);
  const found: { path: string; abs: string; size: number }[] = [];

  if (info.isFile()) {
    if (!/\.html?$/i.test(path)) throw new Error(`${path}: a single-file bundle must be an .html file`);
    found.push({ path: "index.html", abs: path, size: info.size });
  } else if (info.isDirectory()) {
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const abs = join(dir, entry.name);
        const rel = prefix + entry.name;
        if (entry.isDirectory()) await walk(abs, rel + "/");
        else if (entry.isFile()) found.push({ path: rel, abs, size: (await stat(abs)).size });
      }
    };
    await walk(path, "");
    if (!found.some((f) => f.path === "index.html")) throw new Error(`${path}: no index.html at the root`);
  } else {
    throw new Error(`${path}: not a file or directory`);
  }

  if (found.length > MAX_BUNDLE_FILES) {
    throw new Error(`${found.length} files; a bundle can have at most ${MAX_BUNDLE_FILES}`);
  }
  let total = 0;
  for (const f of found) {
    if (normalizePath(f.path) === null) throw new Error(`${f.path}: file name cannot be published`);
    if (f.size > MAX_FILE_BYTES) throw new Error(`${f.path}: larger than ${MAX_FILE_BYTES} bytes`);
    total += f.size;
  }
  if (total > MAX_BUNDLE_BYTES) throw new Error(`${total} bytes; a bundle can be at most ${MAX_BUNDLE_BYTES}`);

  return found.map((f) => ({ path: f.path, body: Bun.file(f.abs) }));
}

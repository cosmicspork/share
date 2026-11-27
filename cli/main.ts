#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseDuration } from "../src/shared/duration";
import { KINDS } from "../src/shared/kinds";
import { type CommonOptions, type Item, type Kind, ShareClient, ShareError } from "./client";
import { configPath, loadConfig } from "./config";
import { collectBundle } from "./files";

const USAGE = `usage:
  share <dir | file.html>            publish a bundle
  share paste [file] [--type md]     publish text; reads stdin when no file is given
  share link <url> [slug]            publish a redirect
  share ls [--kind bundle|paste|link]
  share rm <slug>
  share open <slug>

options:
  --slug <slug>      use this slug instead of a random one
  --title <text>
  --expires <time>   e.g. 30m, 12h, 7d, 2w
  --replace          overwrite the slug if it exists
  --no-sandbox       bundle: serve without the CSP sandbox (trusted pages only)

Prints the published URL on stdout. Credentials: SHARE_ACCESS_CLIENT_ID and
SHARE_ACCESS_CLIENT_SECRET, or client_id / client_secret in
${configPath()}`;

class UsageError extends Error {}

const PASTE_TYPES: Record<string, string> = {
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
};

function pasteType(type: string | undefined, file: string | undefined): string {
  const fromFile = file && /\.(md|markdown)$/i.test(file) ? "md" : undefined;
  const t = (type ?? fromFile ?? "txt").toLowerCase();
  if (t.includes("/")) return t;
  return PASTE_TYPES[t] ?? `text/x-${t}`;
}

async function main(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        slug: { type: "string" },
        title: { type: "string" },
        expires: { type: "string" },
        replace: { type: "boolean" },
        "no-sandbox": { type: "boolean" },
        type: { type: "string" },
        kind: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values: flags, positionals } = parsed;
  if (flags.help || positionals.length === 0) {
    console.error(USAGE);
    process.exitCode = flags.help ? 0 : 2;
    return;
  }

  if (flags.expires !== undefined && parseDuration(flags.expires) === null) {
    throw new UsageError(`--expires: "${flags.expires}" is not a duration like 30m, 12h, 7d or 2w`);
  }
  const common: CommonOptions = {
    slug: flags.slug,
    title: flags.title,
    expires_in: flags.expires,
    replace: flags.replace || undefined,
  };

  const config = await loadConfig();
  const client = new ShareClient(config);
  const [command, ...args] = positionals as [string, ...string[]];
  const expectArgs = (min: number, max: number) => {
    if (args.length < min || args.length > max) throw new UsageError(`wrong number of arguments for "${command}"`);
  };
  const done = (item: Item) => console.log(item.url);

  switch (command) {
    case "link": {
      expectArgs(1, 2);
      if (args[1] && flags.slug) throw new UsageError("give the slug once: as an argument or with --slug");
      done(await client.createLink({ ...common, url: args[0]!, slug: args[1] ?? flags.slug }));
      return;
    }
    case "paste": {
      expectArgs(0, 1);
      const file = args[0];
      const content = file ? await readFile(file, "utf8") : await Bun.stdin.text();
      if (content.length === 0) throw new Error("nothing to paste");
      done(await client.createPaste({ ...common, content, content_type: pasteType(flags.type, file) }));
      return;
    }
    case "ls": {
      expectArgs(0, 0);
      if (flags.kind !== undefined && !KINDS.includes(flags.kind as Kind)) {
        throw new UsageError(`--kind must be one of ${KINDS.join(", ")}`);
      }
      for (const item of await client.list({ kind: flags.kind as Kind | undefined })) {
        const about = item.kind === "link" ? item.target : item.title;
        const expires = item.expires_at ? (item.expired ? "expired" : `until ${item.expires_at.slice(0, 10)}`) : "";
        console.log([item.url, item.kind, about ?? "", expires].join("\t").trimEnd());
      }
      return;
    }
    case "rm": {
      expectArgs(1, 1);
      await client.remove(args[0]!);
      return;
    }
    case "open": {
      expectArgs(1, 1);
      const item = await client.get(args[0]!);
      const opener = process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
      try {
        Bun.spawn([...opener, item.url], { stdio: ["ignore", "ignore", "ignore"] }).unref();
      } catch {
        console.error("share: could not start a browser");
      }
      done(item);
      return;
    }
    default: {
      // Anything else is a path to publish as a bundle.
      expectArgs(0, 0);
      let files;
      try {
        files = await collectBundle(command);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new UsageError(`"${command}" is not a command or an existing path`);
        }
        throw e;
      }
      done(await client.publishBundle(files, { ...common, sandbox: !flags["no-sandbox"] }));
    }
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof UsageError) {
    console.error(`share: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  let detail = (e as Error).message;
  if (e instanceof ShareError) {
    detail = e.code === "slug_exists" ? "that slug already exists; pass --replace to overwrite it" : `${e.message} (${e.status} ${e.code})`;
  }
  console.error(`share: ${detail}`);
  process.exit(1);
});

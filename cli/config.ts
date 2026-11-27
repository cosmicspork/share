import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  adminUrl: string;
  clientId?: string;
  clientSecret?: string;
}

const DEFAULT_ADMIN_URL = "https://go-admin.joshbowen.net";

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "share", "config.toml");
}

/**
 * Environment first, then ~/.config/share/config.toml, then defaults.
 *
 *   admin_url     = "https://go-admin.joshbowen.net"
 *   client_id     = "<service token id>.access"
 *   client_secret = "<service token secret>"
 */
export async function loadConfig(): Promise<Config> {
  let file: Record<string, unknown> = {};
  const path = configPath();
  if (existsSync(path)) {
    try {
      file = Bun.TOML.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`cannot read ${path}: ${(e as Error).message}`);
    }
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  return {
    adminUrl: process.env.SHARE_ADMIN_URL || str(file.admin_url) || DEFAULT_ADMIN_URL,
    clientId: process.env.SHARE_ACCESS_CLIENT_ID || str(file.client_id),
    clientSecret: process.env.SHARE_ACCESS_CLIENT_SECRET || str(file.client_secret),
  };
}

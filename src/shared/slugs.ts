export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Names that can never be slugs. Some would fail SLUG_RE anyway; listed so the intent is explicit. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "admin",
  "raw",
  "static",
  "favicon.ico",
  "robots.txt",
  ".well-known",
]);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !isReservedSlug(slug);
}

// No 0/o, 1/l/i: they are easy to confuse when read aloud or retyped.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RANDOM_SLUG_LENGTH = 6;

export function randomSlug(): string {
  // Rejection sampling, so every character is equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  const buf = new Uint8Array(16);
  while (out.length < RANDOM_SLUG_LENGTH) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < limit && out.length < RANDOM_SLUG_LENGTH) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/** Bundle version id: sortable by creation time, unguessable enough not to collide. */
export function newVersionId(now = Date.now()): string {
  const rand = new Uint8Array(5);
  crypto.getRandomValues(rand);
  return now.toString(36) + Array.from(rand, (b) => (b % 36).toString(36)).join("");
}

export const VERSION_RE = /^[a-z0-9]{1,32}$/;

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** Parse `90s`, `30m`, `12h`, `7d` or `2w` into seconds. Returns null when malformed. */
export function parseDuration(input: string): number | null {
  const m = /^(\d{1,9})([smhdw])$/.exec(input.trim());
  if (!m) return null;
  const seconds = Number(m[1]) * UNITS[m[2]!]!;
  return seconds > 0 ? seconds : null;
}

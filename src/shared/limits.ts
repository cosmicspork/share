const MiB = 1024 * 1024;

export const MAX_BUNDLE_FILES = 256;
export const MAX_BUNDLE_BYTES = 20 * MiB;
export const MAX_FILE_BYTES = 16 * MiB;
export const MAX_PASTE_BYTES = 1 * MiB;
export const MAX_PATH_LENGTH = 512;
export const MAX_TITLE_LENGTH = 200;
export const MAX_URL_LENGTH = 2048;

/** An uncommitted bundle draft older than this is garbage. */
export const STALE_DRAFT_SECONDS = 24 * 60 * 60;

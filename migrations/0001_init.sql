-- One row per published slug. All kinds share the namespace.
CREATE TABLE items (
  slug         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('bundle', 'paste', 'link')),
  title        TEXT,
  target       TEXT,                        -- link: destination URL
  version      TEXT,                        -- bundle: current version id
  content_type TEXT,                        -- paste: declared type (metadata only)
  sandbox      INTEGER NOT NULL DEFAULT 1,  -- bundle: send the CSP sandbox header
  size         INTEGER NOT NULL DEFAULT 0,  -- bytes
  file_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,            -- unix seconds
  updated_at   INTEGER NOT NULL,
  expires_at   INTEGER                      -- unix seconds, NULL = never
);

CREATE INDEX items_updated_at ON items (updated_at DESC);
CREATE INDEX items_expires_at ON items (expires_at) WHERE expires_at IS NOT NULL;

-- Bundle uploads in progress. A draft holds the metadata the commit will
-- write to `items`; readers never look at this table.
CREATE TABLE drafts (
  slug       TEXT NOT NULL,
  version    TEXT NOT NULL,
  title      TEXT,
  sandbox    INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  replace    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (slug, version)
);

CREATE INDEX drafts_created_at ON drafts (created_at);

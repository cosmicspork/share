# share

A personal publishing service on one Cloudflare Worker. It hosts three kinds of
thing under short slugs:

| Kind       | What it is                           | `https://go.joshbowen.net/<slug>`                 |
| ---------- | ------------------------------------ | ------------------------------------------------- |
| **bundle** | a folder with a root `index.html`    | redirects to `/<slug>/`, which serves the folder   |
| **paste**  | text or markdown, up to 1 MiB        | an escaped viewer; `/<slug>/raw` is `text/plain`   |
| **link**   | a redirect to an `http(s)` URL       | a 302 to the target                                |

Two hostnames, one Worker:

- `go.joshbowen.net` is public and read-only (GET and HEAD). It sets no
  cookies and has no index.
- `go-admin.joshbowen.net` has the JSON API under `/api/` and a small admin
  page at `/`. It sits behind Cloudflare Access.

Any other hostname gets a 404, and `workers_dev` / `preview_urls` are off so
there is no URL that reaches the API around Access.

## CLI

```sh
share ./my-report/                 # bundle: a directory, or a single .html file
share paste notes.md               # paste a file (.md is detected)
git diff | share paste --type diff # paste stdin
share link https://github.com/cosmicspork gh
share ls [--kind bundle|paste|link]
share rm <slug>
share open <slug>
```

Flags: `--slug`, `--title`, `--expires 7d` (`s`, `m`, `h`, `d`, `w`),
`--replace`, and for bundles `--no-sandbox`.

The published URL is the only thing written to stdout, so it pipes:
`share ./report | pbcopy`. Errors go to stderr with a non-zero exit code.

Things worth knowing:

- A slug that exists is refused without `--replace`. A replace is a full
  overwrite: title and expiry come from the new command, not the old item.
- Bundles skip dotfiles and do not follow symlinks.
- Bundles are served with `Content-Security-Policy: sandbox allow-scripts
  allow-popups allow-forms allow-modals` unless published with `--no-sandbox`.
  Sandboxed pages run scripts but get an opaque origin, so no `localStorage`,
  cookies or same-origin `fetch`. Use `--no-sandbox` only for pages you wrote.

Build the binary with `just build-cli` (output: `dist/share`), or run it
directly with `bun cli/main.ts`.

Credentials are an Access service token, from the environment or from
`~/.config/share/config.toml`:

```sh
export SHARE_ACCESS_CLIENT_ID=xxxxxxxx.access
export SHARE_ACCESS_CLIENT_SECRET=xxxxxxxx
```

```toml
# ~/.config/share/config.toml -- every key is optional; the environment wins
admin_url     = "https://go-admin.joshbowen.net"
client_id     = "xxxxxxxx.access"
client_secret = "xxxxxxxx"
```

`cli/client.ts` is the HTTP client on its own, with no dependency on the CLI,
the filesystem or the environment, for use from other tools.

## API

All on `go-admin.joshbowen.net`, JSON in and out. Errors are
`{"error": {"code", "message"}}`.

| Method and path                                    | Body                                              |
| -------------------------------------------------- | ------------------------------------------------- |
| `GET /api/items?kind=&limit=&offset=`              | lists, most recently updated first                |
| `GET /api/items/<slug>`                            |                                                   |
| `PATCH /api/items/<slug>`                          | `title`, `sandbox`, `expires_at` / `expires_in`   |
| `DELETE /api/items/<slug>`                         |                                                   |
| `POST /api/links`                                  | `url` + common                                    |
| `POST /api/pastes`                                 | `content`, `content_type` (`text/*`) + common     |
| `POST /api/bundles`                                | `sandbox` + common; returns `{slug, version}`     |
| `PUT /api/bundles/<slug>/<version>/files/<path>`   | the raw file                                      |
| `POST /api/bundles/<slug>/<version>/commit`        |                                                   |

Common fields: `slug`, `title`, `replace`, and either `expires_in` (seconds or
`"7d"`) or `expires_at` (ISO 8601; `null` clears it in a PATCH).

Every write needs `Content-Type: application/json` or an `X-Share-Client`
header (any value). With a service token:

```sh
curl https://go-admin.joshbowen.net/api/links \
  -H "CF-Access-Client-Id: $SHARE_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $SHARE_ACCESS_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "slug": "ex", "expires_in": "7d"}'
```

Publishing a bundle is draft, upload, commit. Uploaded files sit under a
version that nothing points at; the commit checks them (an `index.html`, at
most 256 files, 20 MiB in total, 16 MiB per file) and then switches the slug to
the new version in one statement. Readers see the old bundle or the new one,
never a mixture. The previous version's files are deleted after the switch, and
drafts left uncommitted for a day are deleted by the next commit or the daily
cron.

## How the admin host is protected

Both hosts are under `joshbowen.net`, so to a browser they are the same site:
JavaScript in a published bundle can send requests to the admin host that
carry the Access cookie. Access on its own therefore does not prove that a
request came from the admin page. Each admin request has to pass all of:

1. A valid `Cf-Access-Jwt-Assertion`: RS256 signature checked against the
   team's published keys, plus `aud`, `iss` and `exp`.
2. For anything but GET and HEAD: `Sec-Fetch-Site`, when present, must be
   `same-origin` or `none`, and `Origin`, when present, must be the admin
   host's own.
3. A JSON content type or the custom header, which a browser cannot send
   cross-origin without a preflight. Preflights are never answered, and no
   CORS header is ever sent.

The Worker sets no cookies. The admin page talks to the API with same-origin
`fetch` only, and its CSP forbids form posts.

## Setup

These are the one-time manual steps. Nothing in this repository creates
Cloudflare resources or deploys by itself except CI on `main`.

1. **R2 bucket.** `bunx wrangler r2 bucket create share`. Buckets are bound by
   name, so `wrangler.jsonc` needs no change unless you pick another name.
2. **D1 database.** `bunx wrangler d1 create share`, then put the printed
   `database_id` into `wrangler.jsonc` in place of the all-zero placeholder.
3. **Access application.** In Zero Trust, add a self-hosted application for
   `go-admin.joshbowen.net` (the whole host, no path) with an Allow policy for
   your own identity. Leave its CORS settings empty. Then set in
   `wrangler.jsonc`:
   - `ACCESS_TEAM_DOMAIN`: `<your-team>.cloudflareaccess.com`
   - `ACCESS_AUD`: the application's Audience (AUD) tag

   Neither is a secret. While either is empty the admin host rejects everything.
4. **Service token for the CLI.** Create one under Access > Service Auth, and
   add a second policy to the application with the action **Service Auth**
   that includes that token. Keep the client id and secret for the CLI
   configuration above.
5. **Repository secrets.** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
   The token has to be able to deploy Workers with custom domains on the
   `joshbowen.net` zone and to edit D1 (migrations run in CI) and R2.
6. **Deploy.** Merge to `main`. CI applies the D1 migrations and then runs
   `wrangler deploy`, which attaches both custom domains. Do the Access setup
   first: until `ACCESS_AUD` is set the API is closed, which is the safe way
   round.

## Development

Requires [bun](https://bun.sh) and [just](https://github.com/casey/just);
wrangler also needs Node.

```sh
just            # list recipes
just dev        # local Worker on http://localhost:8787
just test       # vitest, in the Workers runtime
just check      # typecheck the Worker and the CLI
just build-cli  # dist/share
just migrate    # apply D1 migrations to production (--local for the dev database)
just deploy     # break-glass: check, test, migrate, deploy
```

`just dev` runs the real Worker behind `scripts/dev-entry.ts`, a wrapper that
stands in for Cloudflare Access on one port: `/` and `/api/*` go to the admin
host with a freshly signed token, every other path goes to the content host.
The Worker's own token verification still runs. Point the CLI at it with
`SHARE_ADMIN_URL=http://localhost:8787`. Printed URLs name the production
host; open them on `localhost:8787` instead. The wrapper is not referenced by
`wrangler.jsonc` and is never deployed.

Layout:

```
src/index.ts        host dispatch and the cron handler
src/content.ts      the content host (imports nothing from src/admin)
src/admin/          Access verification, request checks, API, admin page
src/shared/         slugs, paths, limits, storage and cleanup used by both
migrations/         D1 schema
cli/                the share CLI; client.ts is the reusable HTTP client
test/               vitest suite
```

Storage: D1 has one `items` row per slug plus a `drafts` table for bundle
uploads in progress. R2 holds bundle files at `b/<slug>/<version>/<path>` and
pastes at `p/<slug>`. A daily cron deletes expired items and stale drafts;
until it runs, an expired slug answers 410.

## Deployment

Pushing to `main` runs `.github/workflows/deploy.yml`: typecheck, test, build
the CLI, apply D1 migrations, deploy. Pull requests run everything up to the
migrations. Actions are pinned by commit SHA and Dependabot proposes updates
monthly.

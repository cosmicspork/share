# Show available recipes
default:
    @just --list

# Local Worker on localhost:8787 with Cloudflare Access simulated (see README)
dev: (migrate "--local")
    bunx wrangler dev scripts/dev-entry.ts --var ACCESS_TEAM_DOMAIN:dev.invalid --var ACCESS_AUD:dev

# Run the test suite
test *args:
    bunx vitest run {{args}}

# Typecheck the Worker and the CLI
check:
    bunx tsc --noEmit
    bunx tsc --noEmit -p cli

# Compile the CLI into a single binary at dist/share
build-cli:
    bun build --compile cli/main.ts --outfile dist/share

# Apply D1 migrations: `just migrate` for production, `just migrate --local` for dev
migrate target="--remote":
    bunx wrangler d1 migrations apply share {{target}}

# Deploy by hand. CI deploys on push to main; this is the break-glass path.
deploy: check test migrate
    bunx wrangler deploy

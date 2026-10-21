# Deploy on Cloudflare Workers + D1

Self-contained deploy: one Worker serves the app and one D1 database holds the
mailbox. No external database, no Neon, no filesystem.

`DEPLOY_TARGET=cf` switches the Nitro preset to `cloudflare_module`. Nitro
writes `.output/server/wrangler.json` by merging `wrangler.jsonc` (this repo)
with the entry point, static-asset binding, and `nodejs_compat` it injects —
do not set `main`, `assets`, or `compatibility_*` in `wrangler.jsonc`.

## First deploy

```sh
npm run build:cf                        # → .output/ + .wrangler/deploy/config.json
npx wrangler login
npx wrangler d1 create grokbot-mail     # prints database_name + database_id
# paste database_id into wrangler.jsonc → d1_databases[].database_id

npx wrangler secret put GBM_INGEST_TOKEN
npx wrangler secret put GBM_SESSION_SECRET
npx wrangler secret put GBM_SITE_PASSWORD   # optional site gate

npm run deploy:cf                       # build + wrangler deploy
```

Migrations apply themselves: the first request runs `migrations/*.sql`
(rewritten for SQLite) through the `DB` binding and records them in
`_migrations` — same ledger the Postgres path uses.

Later deploys are just `npm run deploy:cf`.

## Env / secrets

`nodejs_compat` exposes `process.env` on Workers, so every `GBM_*` /
`SESSION_VERSION` variable works unchanged:

- Secrets (`GBM_INGEST_TOKEN`, `GBM_SESSION_SECRET`, `GBM_SITE_PASSWORD`) →
  `wrangler secret put`, never `vars`.
- Non-secret config (`GBM_INBOX_ADDRESS`, `GBM_OWNER_NAME`, `GBM_TAGS`) →
  `vars` in `wrangler.jsonc` or the dashboard.
- `GBM_DEMO=0` ships in `vars`; set it to `1` to serve sample mail instead.
- `DATABASE_URL` unset on purpose — setting it makes the app prefer Postgres,
  and `pg` cannot open a TCP socket on Workers (use Hyperdrive for that).

## What changes under D1

- **Dialect** — `Sql.dialect` is `"sqlite"`; the two Postgres-only expressions
  (`trim(both …)`, `regexp_replace`) have SQLite equivalents. Everything else —
  `on conflict`, `returning`, CTE `update`, `case` — is shared SQL.
- **Transactions** — D1 has no interactive transactions, so `runWriteTx`
  falls back to sequential statements. Correctness holds because every write
  is either upsert-idempotent (reposting an ingest batch repairs a partial
  one) or a CAS-guarded single-row `UPDATE` (the outbox status transition
  checks `status = <expected>` in the same statement).
- **No filesystem** — `data/config.json`, `data/outbox.log`, and
  `data/ingest/` reads/writes already degrade gracefully; attachment bytes
  come from `mail_attachment.content_b64`, and the outbox log goes to
  `console.error` (visible via `wrangler tail` / Workers Logs).
- **Wake retries** — still request-driven (`runDueWakes` on the next request).
  A Workers Cron Trigger could replace this later; nothing in this branch
  requires it.

## Local check

`npm run dev:cf` builds and runs the bundle in `workerd` locally (needs the
`workerd` postinstall approved — this repo blocks install scripts by
default). `npm run dev` (plain Vite + PGLite) still works for UI work.

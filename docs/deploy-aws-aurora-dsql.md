# Deploy on AWS Amplify + Aurora DSQL

AWS-only deploy: **Amplify Hosting** serves static assets and routes the app to
its **compute** tier (Lambda), and **Aurora DSQL** holds the mailbox. DSQL is
real Postgres on port 5432 — but auth is an **IAM-signed token**, not a
password, so there is no secret to manage.

`DEPLOY_TARGET=aws` switches the Nitro preset to `aws_amplify`, which emits the
`.amplify-hosting/` deployment-manifest bundle Amplify understands. Branched
from `feature/cloudflare-workers-d1` for the shared `Sql` plumbing
(`dialect`, `runWriteTx`); the D1/Wrangler files are simply unused here.

## Pieces

| Piece | File | What it does |
|---|---|---|
| App bundle | `npm run build:aws` | `.amplify-hosting/` — static + `compute/default` |
| Database infra | `infra/aurora-dsql.cfn.yaml` | DSQL cluster + `dsql:DbConnectAdmin` managed policy |
| Build spec | `amplify.yml` | `npm ci && npm run build:aws`, publishes `.amplify-hosting` |
| DB adapter | `src/lib/dsql-sql.ts` | `Sql` over `AuroraDSQLPool` (official pg connector): IAM token per connection, OCC retry |

## First deploy

```sh
aws cloudformation deploy \
  --stack-name grokbot-mail-dsql \
  --template-file infra/aurora-dsql.cfn.yaml \
  --capabilities CAPABILITY_IAM

aws cloudformation describe-stacks --stack-name grokbot-mail-dsql \
  --query 'Stacks[0].Outputs'
```

Then in the Amplify console — **Hosting → create app → Git repository** (or
"deploy without Git" and upload a zip of `.amplify-hosting` after
`npm run build:aws`):

1. Attach `DsqlAccessPolicyArn` (stack output) to the app's compute/backend role.
2. Set environment variables:
   - `DSQL_CLUSTER_ENDPOINT` — stack output (`…​.dsql.<region>.on.aws`)
   - `GBM_INGEST_TOKEN`, `GBM_SESSION_SECRET` — secrets
   - `GBM_SITE_PASSWORD` — optional site gate
   - `GBM_INBOX_ADDRESS`, `GBM_OWNER_NAME`, `GBM_TAGS` — mailbox identity
   - `GBM_DEMO=0` — real database, no sample mail
   - Optional: `DSQL_USER` (default `admin`), `DSQL_DATABASE` (default `postgres`)
   `AWS_REGION` is already set by the Lambda runtime; the connector also parses
   the region from the endpoint hostname.

Migrations apply themselves on first request — `migrations/*.sql` run over the
Postgres wire protocol into the shared `_migrations` ledger.

## What changes under DSQL

- **Dialect stays `pg`** — DSQL is Postgres; no SQL rewrites.
- **Transactions are real, with OCC** — `sql.tx` pins one pooled client and
  retries the callback on optimistic-concurrency conflicts
  (`isOCCError` from the connector). App write paths are upsert-idempotent,
  which is exactly what OCC retry needs.
- **No password, no pool config** — `AuroraDSQLPool` forces TLS, signs each
  connection (`dsql:DbConnectAdmin`), and refreshes tokens on reconnect.
  `max: 1` keeps one connection per warm Lambda instance.
- **DSQL dialect limits to know** — every table needs a primary key (this
  schema has them), and the usual DSQL restrictions apply (no foreign keys,
  no `create index concurrently`). The app's migration set is plain
  `create table`/`alter table add column`/`insert`/`create index` — supported.
- **Scaling** — DSQL is serverless with no capacity to provision; cold
  connections add a token-sign + TLS handshake on the first query of a warm
  Lambda instance.

## Cost shape

- Amplify Hosting: request + GB-served pricing, near $0 at this volume.
- Aurora DSQL: DPU-hours + storage; a mailbox workload is well inside a few
  dollars/month, and unlike Serverless v2 there is no minimum ACU charge —
  idle truly costs ~$0.

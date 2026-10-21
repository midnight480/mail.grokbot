# Deploy on AWS Amplify + Aurora Serverless v2 (Data API)

AWS-only deploy: **Amplify Hosting** serves static assets and routes the app to
its **compute** tier (Lambda), and **Aurora Serverless v2 (PostgreSQL)** holds
the mailbox. The app talks to the database over the **RDS Data API** — HTTPS,
IAM-signed, no VPC, no TCP driver, no `pg` pool.

`DEPLOY_TARGET=aws` switches the Nitro preset to `aws_amplify`, which emits the
`.amplify-hosting/` deployment-manifest bundle Amplify understands. Branched
from `feature/cloudflare-workers-d1` for the shared `Sql` plumbing
(`dialect`, `runWriteTx`); the D1/Wrangler files are simply unused here.

## Pieces

| Piece | File | What it does |
|---|---|---|
| App bundle | `npm run build:aws` | `.amplify-hosting/` — static + `compute/default` |
| Database infra | `infra/aurora-serverless.cfn.yaml` | Serverless v2 cluster, `EnableHttpEndpoint`, managed master secret, access policy |
| Build spec | `amplify.yml` | `npm ci && npm run build:aws`, publishes `.amplify-hosting` |
| DB adapter | `src/lib/rds-data-sql.ts` | `Sql` over `RDSDataClient`: `$n`→`:pN` params, real `Begin/Commit/RollbackTransaction` |

## First deploy

```sh
aws cloudformation deploy \
  --stack-name grokbot-mail-db \
  --template-file infra/aurora-serverless.cfn.yaml \
  --capabilities CAPABILITY_IAM

aws cloudformation describe-stacks --stack-name grokbot-mail-db \
  --query 'Stacks[0].Outputs'
```

Then in the Amplify console — **Hosting → create app → Git repository** (or
"deploy without Git" and upload a zip of `.amplify-hosting` after
`npm run build:aws`):

1. Attach `DbAccessPolicyArn` (stack output) to the app's compute/backend role.
2. Set environment variables:
   - `RDS_DATA_RESOURCE_ARN`, `RDS_DATA_SECRET_ARN`, `RDS_DATA_DATABASE`
     (all stack outputs)
   - `GBM_INGEST_TOKEN`, `GBM_SESSION_SECRET` — secrets
   - `GBM_SITE_PASSWORD` — optional site gate
   - `GBM_INBOX_ADDRESS`, `GBM_OWNER_NAME`, `GBM_TAGS` — mailbox identity
   - `GBM_DEMO=0` — real database, no sample mail
   `AWS_REGION` is already set by the Lambda runtime.

Migrations apply themselves on first request — `migrations/*.sql` run through
the Data API one statement at a time (the API accepts a single statement per
call) into the shared `_migrations` ledger.

## What changes under the Data API

- **Dialect stays `pg`** — Aurora is real Postgres, so no SQL rewrites at all.
- **Transactions are real** — `sql.tx` maps to
  `Begin/Commit/RollbackTransactionCommand` + `transactionId` on each
  statement, so `runWriteTx` keeps full atomicity (unlike the D1 branch).
- **No sockets, no pool** — every statement is one signed HTTPS call; ideal
  for Lambda but ~10-20 ms of per-statement latency. Fine at mailbox scale.
- **Payload limits** — a request/response over 1 MB fails; the app keeps
  attachment bytes in `content_b64` rows written one at a time, so stay under
  the ingest cap (`INGEST_MAX_BYTES`, 5 MB per POST — chunking a huge batch is
  on the bot side, and each row's value is what matters).
- **Auto-pause** — `MinAcu: 0` scales the cluster to zero when idle (needs
  Aurora PG 16.3+/15.7+/14.12+; the template doesn't pin a version so you get
  the current default). The first request after a pause waits a few seconds
  for resume — set `MinAcu` higher for zero cold start, or accept it and pay
  ~$0 while idle.

## Cost shape

- Amplify Hosting: request + GB-served pricing, near $0 at this volume.
- Aurora Serverless v2: 0 ACU while paused, ~$0.12/ACU-hour when active.
- Data API calls: free. Secrets Manager: ~$0.40/month.

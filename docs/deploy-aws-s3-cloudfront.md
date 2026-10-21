# Deploy on AWS S3 + CloudFront + Aurora Serverless v2 (Data API)

AWS-only deploy **without Amplify**: CloudFront fronts everything — hashed
`/assets/*` come from a private S3 bucket and all app traffic goes to a
**Lambda Function URL** (both origins locked down with Origin Access Control).
**Aurora Serverless v2 (PostgreSQL)** is the database, reached over the
**RDS Data API** — HTTPS + IAM, no VPC, no TCP, no `pg` pool.

`DEPLOY_TARGET=aws` switches the Nitro preset to `aws_lambda`; static assets
are inlined into the bundle (`serveStatic: "inline"`) so the Lambda can still
serve root files like `/favicon.svg` itself. Branched from
`feature/aws-amplify-aurora-serverless`; the Data API adapter is unchanged.

## Pieces

| Piece | File | What it does |
|---|---|---|
| App bundle | `npm run build:aws` | `.output/server/index.mjs` — `handler` for Function URL payload v2 |
| Infra | `infra/s3-cloudfront-aurora.cfn.yaml` | S3 + 2×OAC + CloudFront + Lambda + Function URL + role + Aurora cluster |
| DB adapter | `src/lib/rds-data-sql.ts` | `Sql` over `RDSDataClient`: `$n`→`:pN` params, real begin/commit/rollback |

## First deploy

```sh
aws cloudformation deploy \
  --stack-name grokbot-mail \
  --template-file infra/s3-cloudfront-aurora.cfn.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GBMIngestToken=... GBMSessionSecret=... \
                      GBMSitePassword=... GBMInboxAddress=you@example.com

# read outputs
aws cloudformation describe-stacks --stack-name grokbot-mail \
  --query 'Stacks[0].Outputs'

# ship the code
npm run build:aws
cd .output/server && zip -qr ../lambda.zip . && cd ../..
aws lambda update-function-code \
  --function-name <FunctionName output> \
  --zip-file fileb://.output/lambda.zip
aws s3 sync .output/public s3://<SiteBucketName output> --delete
aws cloudfront create-invalidation \
  --distribution-id <from console> --paths '/*'
```

The stack creates the Lambda with a 503 placeholder so CloudFront+DNS exist
before the first code upload — everything after `update-function-code` is
repeatable.

`GBM_TAGS` and other optional vars: `aws lambda update-function-configuration`
or add them under `Environment.Variables` in the template.

## What changes under the Data API

Same adapter as `feature/aws-amplify-aurora-serverless`:

- **Dialect stays `pg`** — no SQL rewrites.
- **Real transactions** — `sql.tx` maps to Begin/Commit/Rollback with a
  `transactionId`, so `runWriteTx` keeps full atomicity.
- **No sockets** — every statement is one signed HTTPS call; ~10-20 ms each,
  fine at mailbox scale. Statements in a transaction share `transactionId`.
- **Payload limit** — >1 MB request/response fails; attachment bytes live in
  `content_b64` rows written one at a time.
- **Auto-pause** — `MinAcu: 0` idles at ~$0 (Aurora PG 16.3+/15.7+/14.12+);
  first request after a pause waits a few seconds for resume.

## Request flow

```
browser → CloudFront ──/assets/*──→ S3 (OAC)
          └─ /* ──────→ Lambda Function URL (OAC SigV4)
                           └─ HTTPS → RDS Data API → Aurora
```

- `GBM_*` envs come from CFN parameters (`NoEcho` on secrets) into Lambda env.
- Migrations self-apply on first request through the Data API into the shared
  `_migrations` ledger.
- `npm run dev` (Vite + PGLite) is untouched for local work.

## Cost shape

- CloudFront + S3 + Lambda: near $0 at mailbox volume.
- Aurora Serverless v2: 0 ACU while paused, ~$0.12/ACU-hour when active.
- Data API calls free; Secrets Manager ~$0.40/month.

import { pendingMigrations } from "../../scripts/migration-plan.mjs";
import { neonPoolConfig } from "./pg-pool.ts";
import {
  toSql,
  txOverStatements,
  type Run,
  type Sql,
} from "./sql-types.ts";

/** Which database backend is active. */
export type DbSource = "neon" | "pglite" | "d1" | "rdsdata";

// An empty/whitespace DATABASE_URL (an easy misconfig in deploy UIs) must mean
// "unset" — otherwise production would silently run on the PGLite fallback.
const rawDatabaseUrl =
  typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
const databaseUrl =
  rawDatabaseUrl && rawDatabaseUrl.trim() ? rawDatabaseUrl : undefined;

/**
 * Cloudflare Workers reports `navigator.userAgent === "Cloudflare-Workers"`.
 * Used only to pick the default backend when DATABASE_URL is unset: on Workers
 * there is no durable local Postgres, so the D1 `DB` binding is the database.
 */
export const isWorkersRuntime =
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

/**
 * Aurora Serverless Data API is selected by its cluster ARN — Lambda compute
 * reaches it over HTTPS, no TCP and no DATABASE_URL.
 */
const rdsDataConfigured = Boolean(
  typeof process !== "undefined" && process.env.RDS_DATA_RESOURCE_ARN?.trim(),
);

/**
 * Active backend: real **Neon** when `DATABASE_URL` is set (deployed / configured
 * sandbox), Cloudflare **D1** under the Workers runtime (`DB` binding), **Aurora
 * Serverless Data API** when `RDS_DATA_RESOURCE_ARN`/`RDS_DATA_SECRET_ARN` are
 * set, otherwise a local embedded **PGLite** (Postgres compiled to WASM) so the
 * app has a working database even with nothing configured — the live preview
 * included. Swap in Neon later by just setting `DATABASE_URL`; no code changes.
 */
export const dbSource: DbSource = databaseUrl
  ? "neon"
  : rdsDataConfigured
    ? "rdsdata"
    : isWorkersRuntime
      ? "d1"
      : "pglite";

/**
 * The `Sql` interface plus `toSql`/`txOverStatements` live in `./sql-types.ts`
 * — a side-effect-free leaf so adapters and unit tests never trigger this
 * module's import-time PGLite bootstrap. Re-exported here for all existing
 * `from "@/lib/db"` consumers.
 */
export { toSql, txOverStatements } from "./sql-types.ts";
export type { Run, Sql } from "./sql-types.ts";

/**
 * Init state lives on globalThis as promises: dev HMR creates new instances of
 * this module, and two instances racing module-level state would open a second
 * pool or run two concurrent PGLite migration passes (whose duplicate
 * `_migrations` insert rejects — and would get memoized, poisoning every later
 * `getSql()`). A failed init clears its slot so the next call retries.
 */
const globalRef = globalThis as typeof globalThis & {
  __pgSqlPromise__?: Promise<Sql>;
  __pgliteInstance__?: Promise<import("@electric-sql/pglite").PGlite>;
  __pgliteMigrateChain__?: Promise<void>;
};

/**
 * Result-type parity: Postgres sends every value as text plus a type OID — the
 * JS value is the DRIVER's parsing choice, and pg and PGLite disagree (pg:
 * int8 -> string, date -> local-midnight Date; PGLite: int8 -> BigInt, which
 * JSON.stringify rejects, date -> UTC Date). Normalize both so preview and
 * production return identical, JSON-safe shapes:
 *   int8/bigint (incl. count(*)) -> number (past 2^53 loses precision — cast
 *                                   `::text` if you ever need huge integers)
 *   date                         -> 'YYYY-MM-DD' string
 *   interval                     -> Postgres interval text
 * numeric already comes back as a string on both (arbitrary precision).
 */
const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

function createNeonSql(): Promise<Sql> {
  globalRef.__pgSqlPromise__ ??= (async () => {
    // Regular Postgres driver: node-postgres (`pg`) — works directly with Neon's
    // pooled endpoint. One pool per process; warm serverless instances reuse it.
    // Serverless caps the pool at 1. PGLite is never opened on this path.
    if (!databaseUrl) throw new Error("DATABASE_URL is not set");
    const { Pool, types } = await import("pg");
    types.setTypeParser(OID_INT8, Number);
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);
    const pool = new Pool(neonPoolConfig(databaseUrl));
    const run = async <T>(text: string, params: unknown[]) => {
      const res = await pool.query(text, params);
      return res.rows as T[];
    };
    const sql = toSql(run);
    sql.dialect = "pg";
    sql.tx = txOverStatements(run);
    return sql;
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgSqlPromise__;
}

/**
 * Cloudflare D1 — the `DB` binding from `wrangler.jsonc`. `cloudflare:workers`
 * is resolved through a variable specifier so non-Workers bundles (Vercel,
 * Lambda) neither resolve nor bundle it.
 */
async function createD1Sql(): Promise<Sql> {
  const { d1Sql, migrateD1 } = await import("./d1-sql.ts");
  const specifier = "cloudflare:workers";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    env: Record<string, unknown>;
  };
  const binding = mod.env.DB as import("./d1-sql.ts").D1DatabaseLike | undefined;
  if (!binding) {
    throw new Error('Cloudflare D1 binding "DB" is not configured in wrangler.jsonc');
  }
  const sql = d1Sql(binding);
  await migrateD1(sql, binding);
  return sql;
}

/**
 * Aurora Serverless via the RDS Data API — HTTP + IAM signed calls, no TCP.
 * `RDS_DATA_RESOURCE_ARN` / `RDS_DATA_SECRET_ARN` select it (see
 * docs/deploy-aws-aurora-serverless.md).
 */
async function createRdsDataSql(): Promise<Sql> {
  const { rdsDataSql, rdsDataConfigFromEnv, migrateRdsData } = await import(
    "./rds-data-sql.ts"
  );
  const cfg = rdsDataConfigFromEnv();
  if (!cfg) {
    throw new Error("RDS_DATA_RESOURCE_ARN and RDS_DATA_SECRET_ARN are not set");
  }
  const { RDSDataClient } = await import("@aws-sdk/client-rds-data");
  const sql = rdsDataSql(new RDSDataClient({}), cfg);
  await migrateRdsData(sql);
  return sql;
}

async function createPgliteSql(): Promise<Sql> {
  // Embedded Postgres, imported on demand so it never loads on the Neon path.
  // One in-memory instance per process, shared across HMR module instances, so
  // data survives source edits (it resets on dev-server restart).
  globalRef.__pgliteInstance__ ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const pg = new PGlite({
      parsers: {
        [OID_INT8]: Number,
        [OID_DATE]: identity,
        [OID_INTERVAL]: identity,
      },
    });
    await pg.waitReady;
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    return pg;
  })().catch((err) => {
    globalRef.__pgliteInstance__ = undefined;
    throw err;
  });
  const pg = await globalRef.__pgliteInstance__;

  // Apply migrations/ (the single schema source) so preview matches production.
  // SQL is inlined by the bundler via import.meta.glob (no runtime fs); applied
  // files are tracked in _migrations. The glob does not descend, so the opt-in
  // auth schema under migrations/auth/ stays out. Runs once per module instance
  // — so an HMR reload after adding a migration file applies it live — with
  // passes serialized on a global chain so concurrent callers never
  // double-apply.
  const migrate = async (): Promise<void> => {
    const migrations = import.meta.glob("/migrations/*.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const doneRows = await pg.query<{ name: string }>(
      "select name from _migrations",
    );
    const done = doneRows.rows.map((r) => r.name);
    for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
      // Apply + record atomically (parity with scripts/migrate.mjs) so a failed
      // statement can't leave a file half-applied but untracked.
      await pg.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
  };
  const pass = (globalRef.__pgliteMigrateChain__ ?? Promise.resolve())
    .catch(() => undefined) // an earlier failed pass must not wedge the chain
    .then(migrate);
  globalRef.__pgliteMigrateChain__ = pass;
  await pass;

  const run = async <T>(text: string, params: unknown[]) => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  const sql = toSql(run);
  sql.dialect = "pg";
  sql.tx = txOverStatements(run);
  return sql;
}

let sqlPromise: Promise<Sql> | null = null;

async function createSql(): Promise<Sql> {
  if (typeof window !== "undefined") {
    throw new Error(
      "@/lib/db is server-only — call getSql() from a createServerFn handler " +
        "or a server route loader, never from client code.",
    );
  }
  if (dbSource === "neon") return createNeonSql();
  if (dbSource === "d1") return createD1Sql();
  if (dbSource === "rdsdata") return createRdsDataSql();
  return createPgliteSql();
}

/**
 * Get the shared, **server-only** SQL client. Neon when `DATABASE_URL` is set,
 * otherwise the local PGLite fallback. Memoized — safe to call per request.
 *
 * Schema comes from `migrations/*.sql`, auto-applied before the first query on
 * both backends — define tables there, never inline in server functions.
 */
export function getSql(): Promise<Sql> {
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null; // don't memoize failures — let the next call retry
    throw err;
  });
  return sqlPromise;
}

/**
 * The shared PGLite instance (preview only), with `migrations/*.sql` applied.
 * Lets Better Auth persist to the SAME embedded DB as app data in preview (via a
 * Kysely dialect). Throws when `DATABASE_URL` is set (that path uses Neon).
 */
export async function getPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  if (dbSource !== "pglite") {
    throw new Error("getPglite() is only available on the PGLite fallback (no DATABASE_URL)");
  }
  await getSql();
  const pg = await globalRef.__pgliteInstance__;
  if (!pg) throw new Error("PGLite instance failed to initialize");
  return pg;
}

/**
 * Finish DB bootstrap before the server handles traffic.
 *
 * - **PGLite** (preview / no `DATABASE_URL`): open the in-memory DB and apply
 *   `migrations/*.sql`. Idempotent — concurrent callers share one promise.
 * - **D1** (Workers): apply `migrations/*.sql` (rewritten for SQLite) on the
 *   first call.
 * - **Neon**: no-op (pool is created lazily on first query).
 *
 * Vite `configureServer` awaits this at dev startup; production imports of this
 * module kick it off immediately (see bottom of file).
 */
export function ensureDbReady(): Promise<void> {
  if (dbSource === "neon") return Promise.resolve();
  return getSql().then(() => undefined);
}

// Server-only eager start: kick PGLite bootstrap as soon as this module loads in
// Node. Client bundles never hit this path (`getSql` throws in the browser).
const globalBoot = globalThis as typeof globalThis & {
  __pgBootstrapPromise__?: Promise<void>;
};
if (typeof window === "undefined" && dbSource === "pglite") {
  globalBoot.__pgBootstrapPromise__ ??= ensureDbReady().catch((err) => {
    globalBoot.__pgBootstrapPromise__ = undefined;
    console.error("[db] PGLite bootstrap failed:", err);
    throw err;
  });
}

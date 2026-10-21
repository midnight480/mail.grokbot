/**
 * Aurora DSQL adapter for the shared `Sql` surface (`./db.ts`).
 *
 * DSQL speaks real Postgres on port 5432 but authenticates with an IAM-signed
 * token instead of a password. The official connector
 * (`@aws/aurora-dsql-node-postgres-connector`) is a `pg.Pool` subclass that
 * mints `getDbConnectAdminAuthToken` on every connection, forces TLS, and
 * resolves region from the hostname — so `DSQL_CLUSTER_ENDPOINT` is the only
 * required variable.
 *
 * Transactions pin a single pooled client (`runWriteTx` statements must land
 * on the same connection — a `max`-sized pool would scatter them). DSQL is
 * optimistic-concurrency: a conflicting commit fails with an OCC error, so
 * `sql.tx` retries the whole callback. Every write path here is
 * upsert-idempotent, which is exactly what retrying requires.
 *
 * DSQL dialect notes (vs full Postgres): every table needs a primary key —
 * this schema already has them — and `add column if not exists`, `on
 * conflict`, and `returning` are all supported.
 */

import { isOCCError } from "@aws/aurora-dsql-node-postgres-connector";
import { pendingMigrations } from "../../scripts/migration-plan.mjs";
import { toSql, type Sql } from "./db.ts";

export type DsqlConfig = {
  host: string;
  user: string;
  database: string;
};

/** Present when DSQL_CLUSTER_ENDPOINT is configured. */
export function dsqlConfigFromEnv(env = process.env): DsqlConfig | null {
  const host = env.DSQL_CLUSTER_ENDPOINT?.trim();
  if (!host) return null;
  return {
    host,
    user: env.DSQL_USER?.trim() || "admin",
    database: env.DSQL_DATABASE?.trim() || "postgres",
  };
}

const OCC_MAX_ATTEMPTS = 4;

type PoolLike = {
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

export function dsqlSql(pool: PoolLike): Sql {
  // While sql.tx runs, statements go through the held client so the whole
  // transaction stays on one connection.
  let txClient: Awaited<ReturnType<PoolLike["connect"]>> | null = null;

  const run = async <T>(text: string, params: unknown[]): Promise<T[]> => {
    const res = await (txClient ?? pool).query(text, params);
    return res.rows as T[];
  };
  const sql = toSql(run);
  sql.dialect = "pg";
  sql.tx = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        txClient = client;
        const value = await fn();
        await client.query("commit");
        return value;
      } catch (err) {
        try {
          await client.query("rollback");
        } catch {
          // The failed transaction is already unusable.
        }
        if (isOCCError(err) && attempt < OCC_MAX_ATTEMPTS) continue;
        throw err;
      } finally {
        txClient = null;
        client.release();
      }
    }
  };
  return sql;
}

/**
 * Apply pending `migrations/*.sql` — real Postgres wire protocol, whole files
 * in one call like the PGLite path, same `_migrations` ledger.
 */
export async function migrateDsql(sql: Sql): Promise<void> {
  await sql.query(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const doneRows = await sql.query<{ name: string }>(
    "select name from _migrations",
  );
  const done = doneRows.map((row) => row.name);
  const migrations = import.meta.glob("/migrations/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  for (const { name, path } of pendingMigrations(
    Object.keys(migrations),
    done,
  )) {
    await sql.query(migrations[path] ?? "");
    await sql.query("insert into _migrations (name) values ($1)", [name]);
  }
}

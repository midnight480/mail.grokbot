/**
 * Cloudflare D1 adapter for the shared `Sql` surface (`./db.ts`).
 *
 * D1 is SQLite behind a binding, so this wraps `db.prepare(...).bind(...)`:
 *
 *  - Postgres `$n` placeholders become positional `?`, with the params array
 *    expanded so a repeated `$n` binds its value again (D1 counts `?` marks).
 *  - JS `true`/`false` become `1`/`0` — SQLite has no boolean type, and the
 *    read layer (`asBool`, `boolValue`) already accepts `0`/`1`.
 *  - `.all()` serves both reads and writes (`RETURNING` rows included).
 *
 * Transactions: D1 has no interactive transactions through the binding, so
 * `sql.tx` stays unset and `runWriteTx` falls back to sequential statements.
 * That is safe here because every write is either upsert-idempotent (a repost
 * repairs a partial ingest batch) or a CAS-guarded single-row UPDATE (the
 * outbox status transition checks `status = <expected>` in the same UPDATE).
 */

import { pendingMigrations } from "../../scripts/migration-plan.mjs";
import { toSql, type Sql } from "./sql-types.ts";

/** Minimal structural subset of the Workers `D1PreparedStatement` binding. */
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

/** Minimal structural subset of the Workers `D1Database` binding. */
export interface D1DatabaseLike {
  prepare(query: string): D1PreparedLike;
  exec(query: string): Promise<unknown>;
  batch(statements: D1PreparedLike[]): Promise<unknown>;
}

/**
 * `$1`-style placeholders → positional `?`, expanding the params so each `?`
 * occurrence binds the right value even when one `$n` is referenced twice.
 */
export function toD1Statement(
  text: string,
  params: unknown[],
): { text: string; params: unknown[] } {
  const expanded: unknown[] = [];
  const sql = text.replace(/\$(\d+)/g, (_match, n: string) => {
    expanded.push(params[Number(n) - 1]);
    return "?";
  });
  return { text: sql, params: expanded };
}

function d1Param(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function d1Sql(db: D1DatabaseLike): Sql {
  const sql = toSql(async <T>(text: string, params: unknown[]): Promise<T[]> => {
    const stmt = toD1Statement(text, params);
    const result = await db
      .prepare(stmt.text)
      .bind(...stmt.params.map(d1Param))
      .all<T>();
    return result.results;
  });
  sql.dialect = "sqlite";
  return sql;
}

/**
 * Rewrite the Postgres-flavored `migrations/*.sql` for SQLite. Only actual
 * syntax errors need rewriting — SQLite's type affinity accepts `timestamptz`,
 * `boolean`, and `default true` as written:
 *
 *  - `alter table ... add column if not exists` → `add column` (SQLite has no
 *    `if not exists` there; the `_migrations` ledger already guarantees once).
 *  - `now()` → `current_timestamp` (SQLite has no `now()` function).
 */
export function toD1Migration(text: string): string {
  return text
    .replace(/add column if not exists/gi, "add column")
    .replace(/\bnow\s*\(\s*\)/g, "current_timestamp");
}

/** Apply pending `migrations/*.sql`, tracked in `_migrations` like the pg path. */
export async function migrateD1(sql: Sql, db: D1DatabaseLike): Promise<void> {
  await db.exec(
    "create table if not exists _migrations (name text primary key, applied_at text not null default current_timestamp)",
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
    await db.exec(toD1Migration(migrations[path] ?? ""));
    await sql.query("insert into _migrations (name) values ($1)", [name]);
  }
}

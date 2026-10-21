/**
 * Aurora Serverless Data API adapter for the shared `Sql` surface (`./db.ts`).
 *
 * The RDS Data API carries SQL over HTTPS, so Lambda (Amplify compute) needs
 * no VPC, no TCP socket, and no connection pool — IAM signs each call and the
 * Secrets Manager ARN supplies the database credentials to AWS, not to us.
 *
 *  - Postgres `$n` placeholders become `:p<n>` named parameters; a repeated
 *    `$n` reuses the same named parameter, which the API supports natively.
 *  - `ExecuteStatement` serves reads and writes (`RETURNING` rows included);
 *    `numberOfRecordsUpdated` covers the guard-CAS row counts.
 *  - Transactions exist as begin/commit/rollback with a `transactionId`, so
 *    `sql.tx` IS implemented — `runWriteTx` gets real atomicity here.
 *    One open transaction per client at a time is fine: this app's writes are
 *    a single-writer mailbox.
 *
 * Caveat for callers: `$n` inside a string literal is not supported (this app
 * has none).
 */

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
  type Field,
  type RDSDataClient,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
import { pendingMigrations } from "../../scripts/migration-plan.mjs";
import { toSql, type Sql } from "./sql-types.ts";

export type RdsDataConfig = {
  resourceArn: string;
  secretArn: string;
  database: string;
};

/** Present when RDS_DATA_RESOURCE_ARN + RDS_DATA_SECRET_ARN are configured. */
export function rdsDataConfigFromEnv(env = process.env): RdsDataConfig | null {
  const resourceArn = env.RDS_DATA_RESOURCE_ARN?.trim();
  const secretArn = env.RDS_DATA_SECRET_ARN?.trim();
  if (!resourceArn || !secretArn) return null;
  return {
    resourceArn,
    secretArn,
    database: env.RDS_DATA_DATABASE?.trim() || "postgres",
  };
}

function fieldValue(field: Field): unknown {
  if (!field || field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.blobValue !== undefined) {
    return Buffer.from(field.blobValue).toString("base64");
  }
  return null;
}

function toField(value: unknown): SqlParameter["value"] {
  if (value === undefined || value === null) return { isNull: true };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
  }
  if (typeof value === "bigint") return { longValue: Number(value) };
  if (value instanceof Date) return { stringValue: value.toISOString() };
  if (typeof value === "string") return { stringValue: value };
  return { stringValue: JSON.stringify(value) };
}

/** `$1`-style placeholders → `:p1` named parameters. */
export function toDataApiStatement(
  text: string,
  params: unknown[],
): { sql: string; parameters: SqlParameter[] } {
  const sql = text.replace(/\$(\d+)/g, ":p$1");
  const parameters = params.map((value, index) => ({
    name: `p${index + 1}`,
    value: toField(value),
  }));
  return { sql, parameters };
}

type DataClient = Pick<RDSDataClient, "send">;

export function rdsDataSql(client: DataClient, cfg: RdsDataConfig): Sql {
  // Data API transactions are pinned by transactionId on every statement —
  // tracked here for the duration of `sql.tx`.
  let txId: string | null = null;
  const scope = { resourceArn: cfg.resourceArn, secretArn: cfg.secretArn };

  const sql = toSql(async <T>(text: string, params: unknown[]): Promise<T[]> => {
    const stmt = toDataApiStatement(text, params);
    const res = await client.send(
      new ExecuteStatementCommand({
        ...scope,
        database: cfg.database,
        sql: stmt.sql,
        parameters: stmt.parameters,
        includeResultMetadata: true,
        transactionId: txId ?? undefined,
      }),
    );
    const columns = (res.columnMetadata ?? []).map((c) => c.name ?? "");
    return (res.records ?? []).map((record) => {
      const row: Record<string, unknown> = {};
      record.forEach((field, i) => {
        row[columns[i] ?? `_${i}`] = fieldValue(field);
      });
      return row as T;
    });
  });
  sql.dialect = "pg";
  sql.tx = async <T>(fn: () => Promise<T>): Promise<T> => {
    const began = await client.send(
      new BeginTransactionCommand({ ...scope, database: cfg.database }),
    );
    txId = began.transactionId ?? null;
    try {
      const value = await fn();
      await client.send(
        new CommitTransactionCommand({ ...scope, transactionId: txId ?? "" }),
      );
      return value;
    } catch (err) {
      try {
        await client.send(
          new RollbackTransactionCommand({ ...scope, transactionId: txId ?? "" }),
        );
      } catch {
        // The failed transaction is already unusable.
      }
      throw err;
    } finally {
      txId = null;
    }
  };
  return sql;
}

/**
 * Split a migration file into single statements — `ExecuteStatement` accepts
 * exactly one. Handles `--` line comments and single-quoted strings; the repo
 * migrations contain no `$$` bodies or `;` inside literals.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inString = false;
  let inComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inComment) {
      if (ch === "\n") inComment = false;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (next === "'") {
          current += next;
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      inComment = true;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === ";") {
      const stmt = current.trim();
      current = "";
      if (stmt) out.push(stmt);
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Apply pending `migrations/*.sql` through the Data API — real Postgres, so no
 * dialect rewrite; only statement splitting. Same `_migrations` ledger as the
 * pg/PGLite path.
 */
export async function migrateRdsData(sql: Sql): Promise<void> {
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
    for (const statement of splitStatements(migrations[path] ?? "")) {
      await sql.query(statement);
    }
    await sql.query("insert into _migrations (name) values ($1)", [name]);
  }
}

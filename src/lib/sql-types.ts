/**
 * The shared `Sql` surface plus its two generic helpers, kept in a leaf module
 * with NO side effects. `./db.ts` (the backend selector) re-exports everything
 * here — but unlike db.ts, importing this file never opens a PGLite instance
 * or touches the environment, so adapters and unit tests can use it anywhere.
 */

/**
 * Minimal shared SQL surface, satisfied by every backend (Neon, PGLite, D1,
 * RDS Data API). Both the tagged-template and `.query()` forms resolve to an
 * array of row objects:
 *
 *   const sql = await getSql();
 *   const rows = await sql`select * from todos where id = ${id}`; // parameterized
 *   const rows2 = await sql.query("select * from todos where id = $1", [id]);
 */
export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Dialect tag for the few queries whose SQL differs between Postgres and SQLite. */
  dialect?: "pg" | "sqlite";
  /**
   * Run `fn` inside a write transaction: commit on success, rollback on throw.
   * Backends without interactive transactions (D1) leave this unset — see
   * `runWriteTx` in `./sql-tx.ts` for the shared call site.
   */
  tx?<T>(fn: () => Promise<T>): Promise<T>;
}

export type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
export function toSql(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Rebuild with $1, $2, … placeholders so values stay parameterized.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  return sql;
}

/** `begin`/`commit`/`rollback` over plain statements — the Postgres-backed tx. */
export function txOverStatements(run: Run): NonNullable<Sql["tx"]> {
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await run("begin", []);
    try {
      const value = await fn();
      await run("commit", []);
      return value;
    } catch (err) {
      try {
        await run("rollback", []);
      } catch {
        // The failed transaction is already unusable.
      }
      throw err;
    }
  };
}

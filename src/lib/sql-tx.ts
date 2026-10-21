import type { Sql } from "./db.ts";

/**
 * Thrown inside a `runWriteTx` callback to abort the write and return `value`
 * as the transaction result — the "expected rejection" path (a 409 conflict),
 * distinct from a real failure.
 */
export class TxAbort<T> extends Error {
  readonly value: T;
  constructor(value: T) {
    super("transaction aborted");
    this.name = "TxAbort";
    this.value = value;
  }
}

export function abortTx<T>(value: T): never {
  throw new TxAbort<T>(value);
}

/**
 * Run `run` inside a transaction where the backend has one (Postgres, and any
 * adapter that sets `sql.tx`); sequential statements otherwise (D1, which has
 * no interactive transactions). A `TxAbort` thrown inside `run` rolls back on
 * real transactions and returns its value either way — callers handle the
 * aborted result exactly like a non-aborted one.
 */
export async function runWriteTx<T>(
  sql: Sql,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return sql.tx ? await sql.tx(run) : await run();
  } catch (err) {
    if (err instanceof TxAbort) return err.value;
    throw err;
  }
}

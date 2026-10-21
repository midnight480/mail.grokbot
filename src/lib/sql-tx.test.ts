import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toSql, txOverStatements, type Sql } from "./sql-types.ts";
import { abortTx, runWriteTx, TxAbort } from "./sql-tx.ts";

describe("toSql", () => {
  it("rebuilds tagged templates with $n placeholders", async () => {
    const seen: { text: string; params: unknown[] }[] = [];
    const sql = toSql(async (text, params) => {
      seen.push({ text, params });
      return [];
    });
    await sql`select * from t where a = ${1} and b = ${"x"}`;
    assert.equal(seen[0]?.text, "select * from t where a = $1 and b = $2");
    assert.deepEqual(seen[0]?.params, [1, "x"]);
  });
});

describe("txOverStatements", () => {
  it("wraps the body in begin/commit", async () => {
    const calls: string[] = [];
    const tx = txOverStatements(async (text) => {
      calls.push(text);
      return [];
    });
    const value = await tx(async () => {
      calls.push("body");
      return 42;
    });
    assert.equal(value, 42);
    assert.deepEqual(calls, ["begin", "body", "commit"]);
  });

  it("rolls back on throw", async () => {
    const calls: string[] = [];
    const tx = txOverStatements(async (text) => {
      calls.push(text);
      return [];
    });
    await assert.rejects(
      tx(async () => {
        throw new Error("nope");
      }),
      /nope/,
    );
    assert.deepEqual(calls, ["begin", "rollback"]);
  });
});

describe("runWriteTx", () => {
  const sequential: Sql = toSql(async () => []);

  it("delegates to sql.tx when the backend has one", async () => {
    const order: string[] = [];
    const sql: Sql = Object.assign(
      toSql(async () => []),
      {
        tx: async <T>(fn: () => Promise<T>): Promise<T> => {
          order.push("tx-open");
          const value = await fn();
          order.push("tx-close");
          return value;
        },
      },
    );
    const value = await runWriteTx(sql, async () => {
      order.push("body");
      return "v";
    });
    assert.equal(value, "v");
    assert.deepEqual(order, ["tx-open", "body", "tx-close"]);
  });

  it("runs sequentially when sql.tx is unset (D1)", async () => {
    let ran = false;
    const value = await runWriteTx(sequential, async () => {
      ran = true;
      return "v";
    });
    assert.equal(value, "v");
    assert.equal(ran, true);
  });

  it("returns the abortTx value as a normal result", async () => {
    const value = await runWriteTx(sequential, async () => {
      abortTx({ status: 409 });
    });
    assert.deepEqual(value, { status: 409 });
  });

  it("propagates real errors", async () => {
    await assert.rejects(
      runWriteTx(sequential, async () => {
        throw new Error("real");
      }),
      /real/,
    );
  });
});

describe("TxAbort", () => {
  it("carries the abort value", () => {
    const err = new TxAbort({ a: 1 });
    assert.equal(err.name, "TxAbort");
    assert.deepEqual(err.value, { a: 1 });
    assert.equal(err instanceof Error, true);
  });
});

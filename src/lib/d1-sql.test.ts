import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  d1Sql,
  toD1Migration,
  toD1Statement,
  type D1DatabaseLike,
  type D1PreparedLike,
} from "./d1-sql.ts";

/** Fake D1 binding that records prepared SQL and bound values. */
function fakeD1(results: Record<string, unknown>[] = []) {
  const calls: { text: string; params: unknown[] }[] = [];
  const db: D1DatabaseLike = {
    prepare(text: string): D1PreparedLike {
      return {
        bind(...values: unknown[]) {
          calls.push({ text, params: values });
          return this;
        },
        all<T = unknown>() {
          return Promise.resolve({ results: results as T[] });
        },
        run() {
          return Promise.resolve({});
        },
      };
    },
    exec: () => Promise.resolve({}),
    batch: () => Promise.resolve([]),
  };
  return { db, calls };
}

describe("toD1Statement", () => {
  it("rewrites $n placeholders to ? and keeps param order", () => {
    const stmt = toD1Statement("select * from t where a = $1 and b = $2", [
      "x",
      42,
    ]);
    assert.equal(stmt.text, "select * from t where a = ? and b = ?");
    assert.deepEqual(stmt.params, ["x", 42]);
  });

  it("expands a repeated $n so each ? binds the same value", () => {
    const stmt = toD1Statement("select $1 union all select $1", ["a"]);
    assert.equal(stmt.text, "select ? union all select ?");
    assert.deepEqual(stmt.params, ["a", "a"]);
  });
});

describe("d1Sql", () => {
  it("tags sqlite dialect and leaves tx unset for sequential writes", async () => {
    const { db } = fakeD1();
    const sql = d1Sql(db);
    assert.equal(sql.dialect, "sqlite");
    assert.equal(sql.tx, undefined);
    await sql.query("select 1");
  });

  it("builds ? placeholders from the tagged template", async () => {
    const { db, calls } = fakeD1([{ id: "m1" }]);
    const sql = d1Sql(db);
    const rows = await sql<{ id: string }>`select id from t where id = ${"m1"}`;
    assert.deepEqual(rows, [{ id: "m1" }]);
    assert.equal(calls[0]?.text, "select id from t where id = ?");
    assert.deepEqual(calls[0]?.params, ["m1"]);
  });

  it("normalizes booleans, undefined and dates for SQLite", async () => {
    const { db, calls } = fakeD1();
    const sql = d1Sql(db);
    const when = new Date("2026-10-18T00:00:00.000Z");
    await sql.query("insert into t values ($1, $2, $3, $4)", [
      true,
      false,
      undefined,
      when,
    ]);
    assert.deepEqual(calls[0]?.params, [1, 0, null, "2026-10-18T00:00:00.000Z"]);
  });
});

describe("toD1Migration", () => {
  it("strips add column if not exists and rewrites now()", () => {
    const sql = toD1Migration(
      "alter table t add column if not exists c timestamptz default now();",
    );
    assert.equal(
      sql,
      "alter table t add column c timestamptz default current_timestamp;",
    );
  });

  it("leaves plain SQLite-compatible DDL untouched", () => {
    const sql = "create table t (id text primary key);";
    assert.equal(toD1Migration(sql), sql);
  });
});

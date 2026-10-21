import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dsqlConfigFromEnv, dsqlSql } from "./dsql-sql.ts";

/** Fake pg Pool + client pair that records which statement ran where. */
function fakePool(failWith?: Error & { code?: string }) {
  const calls: { where: string; text: string }[] = [];
  let released = false;
  const client = {
    query(text: string) {
      calls.push({ where: "client", text });
      if (failWith && text === "commit") return Promise.reject(failWith);
      return Promise.resolve({ rows: [] });
    },
    release() {
      released = true;
    },
  };
  const pool = {
    connect: () => Promise.resolve(client),
    query(text: string) {
      calls.push({ where: "pool", text });
      return Promise.resolve({ rows: [] });
    },
    wasReleased: () => released,
  };
  return { pool, calls };
}

describe("dsqlConfigFromEnv", () => {
  it("returns null without DSQL_CLUSTER_ENDPOINT", () => {
    assert.equal(dsqlConfigFromEnv({}), null);
    assert.equal(dsqlConfigFromEnv({ DSQL_CLUSTER_ENDPOINT: "  " }), null);
  });

  it("defaults user and database", () => {
    assert.deepEqual(
      dsqlConfigFromEnv({ DSQL_CLUSTER_ENDPOINT: "abc.dsql.us-east-1.api.aws" }),
      { host: "abc.dsql.us-east-1.api.aws", user: "admin", database: "postgres" },
    );
  });
});

describe("dsqlSql", () => {
  it("tags pg dialect and queries through the pool outside a tx", async () => {
    const { pool, calls } = fakePool();
    const sql = dsqlSql(pool);
    assert.equal(sql.dialect, "pg");
    await sql.query("select 1");
    assert.deepEqual(calls, [{ where: "pool", text: "select 1" }]);
  });

  it("pins tx statements to one held client and releases it", async () => {
    const { pool, calls } = fakePool();
    const sql = dsqlSql(pool);
    assert.ok(sql.tx);
    const value = await sql.tx(async () => {
      await sql.query("update t set a = $1", [1]);
      return "done";
    });
    assert.equal(value, "done");
    assert.deepEqual(
      calls.map((c) => `${c.where}:${c.text}`),
      ["client:begin", "client:update t set a = $1", "client:commit"],
    );
    assert.equal(pool.wasReleased(), true);
  });

  it("rolls back and releases on a non-OCC error", async () => {
    const { pool, calls } = fakePool();
    const sql = dsqlSql(pool);
    assert.ok(sql.tx);
    await assert.rejects(
      sql.tx(async () => {
        throw new Error("nope");
      }),
      /nope/,
    );
    assert.deepEqual(
      calls.map((c) => `${c.where}:${c.text}`),
      ["client:begin", "client:rollback"],
    );
    assert.equal(pool.wasReleased(), true);
  });

  it("retries the whole callback on an OCC commit failure", async () => {
    const occ = Object.assign(new Error("occ conflict"), { code: "OC000" });
    const { pool, calls } = fakePool(occ);
    const sql = dsqlSql(pool);
    assert.ok(sql.tx);
    let bodies = 0;
    // First attempt commits-fails with OC000; second attempt is a fresh
    // connect() so make the pool return a working client the second time.
    let connects = 0;
    const goodClient = {
      query(text: string) {
        calls.push({ where: "client2", text });
        return Promise.resolve({ rows: [] });
      },
      release() {},
    };
    const flaky = pool.connect;
    pool.connect = () => {
      connects += 1;
      return connects === 1 ? flaky() : Promise.resolve(goodClient);
    };
    const value = await sql.tx(async () => {
      bodies += 1;
      return "ok";
    });
    assert.equal(value, "ok");
    assert.equal(bodies, 2);
    assert.equal(connects, 2);
    assert.deepEqual(
      calls.map((c) => `${c.where}:${c.text}`),
      ["client:begin", "client:commit", "client:rollback", "client2:begin", "client2:commit"],
    );
  });
});

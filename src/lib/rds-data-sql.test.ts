import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import {
  rdsDataConfigFromEnv,
  rdsDataSql,
  splitStatements,
  toDataApiStatement,
  type RdsDataConfig,
} from "./rds-data-sql.ts";

const CFG: RdsDataConfig = {
  resourceArn: "arn:aws:rds:us-east-1:123:cluster:gbm",
  secretArn: "arn:aws:secretsmanager:us-east-1:123:secret:gbm",
  database: "postgres",
};

/** Fake RDSDataClient that records the commands it would send. */
function fakeClient(records: unknown[][] = [], columnNames: string[] = []) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  let txCounter = 0;
  const client = {
    send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command instanceof BeginTransactionCommand) {
        txCounter += 1;
        return Promise.resolve({ transactionId: `tx-${txCounter}` });
      }
      return Promise.resolve({
        columnMetadata: columnNames.map((name) => ({ name })),
        records,
      });
    },
  };
  return { client, sent };
}

describe("rdsDataConfigFromEnv", () => {
  it("returns null unless both ARNs are set", () => {
    assert.equal(rdsDataConfigFromEnv({}), null);
    assert.equal(
      rdsDataConfigFromEnv({ RDS_DATA_RESOURCE_ARN: "arn:x" }),
      null,
    );
    assert.equal(
      rdsDataConfigFromEnv({
        RDS_DATA_RESOURCE_ARN: "  ",
        RDS_DATA_SECRET_ARN: "arn:y",
      }),
      null,
    );
  });

  it("defaults the database name to postgres", () => {
    const cfg = rdsDataConfigFromEnv({
      RDS_DATA_RESOURCE_ARN: "arn:x",
      RDS_DATA_SECRET_ARN: "arn:y",
    });
    assert.deepEqual(cfg, {
      resourceArn: "arn:x",
      secretArn: "arn:y",
      database: "postgres",
    });
  });
});

describe("toDataApiStatement", () => {
  it("rewrites $n placeholders to :pN named parameters", () => {
    const stmt = toDataApiStatement("select * from t where a = $1 and b = $2", [
      "x",
      7,
    ]);
    assert.equal(stmt.sql, "select * from t where a = :p1 and b = :p2");
    assert.deepEqual(
      stmt.parameters.map((p) => p.name),
      ["p1", "p2"],
    );
    assert.deepEqual(stmt.parameters[0]?.value, { stringValue: "x" });
    assert.deepEqual(stmt.parameters[1]?.value, { longValue: 7 });
  });

  it("maps JS values to Data API field types", () => {
    const stmt = toDataApiStatement("select $1, $2, $3, $4, $5, $6, $7", [
      null,
      true,
      1.5,
      BigInt(9),
      new Date("2026-10-18T00:00:00.000Z"),
      { k: "v" },
      undefined,
    ]);
    assert.deepEqual(stmt.parameters[0]?.value, { isNull: true });
    assert.deepEqual(stmt.parameters[1]?.value, { booleanValue: true });
    assert.deepEqual(stmt.parameters[2]?.value, { doubleValue: 1.5 });
    assert.deepEqual(stmt.parameters[3]?.value, { longValue: 9 });
    assert.deepEqual(stmt.parameters[4]?.value, {
      stringValue: "2026-10-18T00:00:00.000Z",
    });
    assert.deepEqual(stmt.parameters[5]?.value, {
      stringValue: '{"k":"v"}',
    });
    assert.deepEqual(stmt.parameters[6]?.value, { isNull: true });
  });
});

describe("rdsDataSql", () => {
  it("sends ExecuteStatement with the cluster scope and maps records", async () => {
    const { client, sent } = fakeClient(
      [[{ stringValue: "m1" }, { longValue: 3 }]],
      ["id", "unread"],
    );
    const sql = rdsDataSql(client, CFG);
    assert.equal(sql.dialect, "pg");
    const rows = await sql`select id, unread from t where id = ${"m1"}`;
    assert.deepEqual(rows, [{ id: "m1", unread: 3 }]);
    const exec = sent[0];
    assert.equal(exec?.name, "ExecuteStatementCommand");
    assert.equal(exec?.input.resourceArn, CFG.resourceArn);
    assert.equal(exec?.input.secretArn, CFG.secretArn);
    assert.equal(exec?.input.database, "postgres");
    assert.equal(exec?.input.transactionId, undefined);
  });

  it("pins statements to transactionId inside sql.tx and commits", async () => {
    const { client, sent } = fakeClient();
    const sql = rdsDataSql(client, CFG);
    assert.ok(sql.tx);
    const value = await sql.tx(async () => {
      await sql.query("update t set a = 1");
      return "done";
    });
    assert.equal(value, "done");
    assert.deepEqual(
      sent.map((c) => c.name),
      ["BeginTransactionCommand", "ExecuteStatementCommand", "CommitTransactionCommand"],
    );
    assert.equal(sent[1]?.input.transactionId, "tx-1");
    assert.equal(sent[2]?.input.transactionId, "tx-1");
  });

  it("rolls back when the transaction body throws", async () => {
    const { client, sent } = fakeClient();
    const sql = rdsDataSql(client, CFG);
    assert.ok(sql.tx);
    await assert.rejects(
      sql.tx(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(
      sent.map((c) => c.name),
      ["BeginTransactionCommand", "RollbackTransactionCommand"],
    );
  });
});

describe("splitStatements", () => {
  it("splits on semicolons and drops line comments", () => {
    const text = "-- a comment\ncreate table a (id int); -- tail\ncreate table b (id int);";
    assert.deepEqual(splitStatements(text), [
      "create table a (id int)",
      "create table b (id int)",
    ]);
  });

  it("keeps semicolons inside string literals and handles escaped quotes", () => {
    const text = "insert into t values ('a;b'), ('it''s;x');select 1;";
    assert.deepEqual(splitStatements(text), [
      "insert into t values ('a;b'), ('it''s;x')",
      "select 1",
    ]);
  });

  it("keeps a trailing statement without a semicolon", () => {
    assert.deepEqual(splitStatements("select 1"), ["select 1"]);
  });
});

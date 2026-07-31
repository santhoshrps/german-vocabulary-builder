import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync(
  resolve("migrations/ops/0001_runtime_contract.sql"),
  "utf8",
);
const canonicalSchema = readFileSync(resolve("../schema/ops.sql"), "utf8");

const legacyPendingSends = `
  CREATE TABLE pending_sends (
    id              TEXT PRIMARY KEY,
    descriptor      TEXT NOT NULL,
    descriptor_hash TEXT NOT NULL,
    audience        TEXT NOT NULL DEFAULT 'all',
    send_at         INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function columns(database, table) {
  return database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name);
}

function verifyRuntimeRepair(database) {
  assert.deepEqual(
    columns(database, "transaction_revocations"),
    ["original_transaction_id", "reason", "recorded_at"],
  );
  assert.ok(columns(database, "pending_sends").includes("envelope"));
  const metadataRows = database.prepare(`
    SELECT m.name AS table_name, p.name AS column_name
      FROM sqlite_master AS m
      JOIN pragma_table_info(m.name) AS p
     WHERE m.type = 'table'
       AND m.name IN ('transaction_revocations', 'pending_sends')
  `).all();
  assert.ok(metadataRows.some(
    (row) => row.table_name === "pending_sends" && row.column_name === "envelope",
  ));

  database.prepare(`
    INSERT INTO transaction_revocations (original_transaction_id, reason)
    VALUES (?, ?)
  `).run("sandbox:2000000000000001", "refund");
  database.prepare(`
    INSERT INTO pending_sends
      (id, descriptor, descriptor_hash, audience, send_at, envelope)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("send-1", "{}", "hash", "all", 1, "{\"id\":\"message-1\"}");
}

test("operational migration repairs the legacy production shape", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(legacyPendingSends);
  database.exec(migration);
  database.exec(canonicalSchema);
  verifyRuntimeRepair(database);
  database.close();
});

test("operational migration plus canonical schema initializes an empty database", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  database.exec(canonicalSchema);
  verifyRuntimeRepair(database);
  database.close();
});

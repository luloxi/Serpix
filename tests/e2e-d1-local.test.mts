import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { bindStatement, makeBatch } from "./db-helper.mts";
import { createD1, loadSqlJs, openLocalDb } from "../lib/e2e/d1-local.ts";

const wasm = readFileSync(new URL("../public/vendor/sql-wasm.wasm", import.meta.url));

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const DDL = `
CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT, n INTEGER);
CREATE TABLE log (id INTEGER PRIMARY KEY AUTOINCREMENT, seen INTEGER);
`;

async function both() {
  const node = new DatabaseSync(":memory:");
  node.exec(DDL);
  const nodeDb = {
    prepare(sql: string) {
      const bound = (values: unknown[]) => bindStatement(node, sql, values);
      return { ...bound([]), bind(...values: unknown[]) { return bound(values); } };
    },
    batch: makeBatch(node),
  };
  const SQL = await loadSqlJs(wasm);
  const raw = new SQL.Database();
  raw.exec(DDL);
  return { node, nodeDb, local: createD1(raw), raw };
}

async function runPair(
  nodeDb: { prepare(sql: string): { bind(...values: unknown[]): ReturnType<typeof bindStatement>; run(): Promise<{ meta: { changes: number }; results?: unknown[] }> } },
  local: ReturnType<typeof createD1>,
  sql: string,
  args: unknown[] = [],
) {
  const left = await nodeDb.prepare(sql).bind(...args).run();
  const right = await local.prepare(sql).bind(...args).run();
  assert.equal(right.meta.changes, left.meta.changes, sql);
  assert.deepEqual(plain(right.results ?? null), plain(left.results ?? null), sql);
}

test("sql.js adapter matches the node:sqlite D1 shim", async () => {
  const { nodeDb, local, raw } = await both();
  await runPair(nodeDb, local, "INSERT INTO item (name, n) VALUES (?, ?)", ["a", 1]);
  await runPair(nodeDb, local, "INSERT INTO item (name, n) VALUES (?, ?)", ["b", null]);
  const ignoreSql = "INSERT OR IGNORE INTO item (id, name, n) VALUES (1, 'nope', 9)";
  await runPair(nodeDb, local, ignoreSql);
  await runPair(nodeDb, local, "UPDATE item SET name = ? WHERE n IS NULL", ["blank"]);
  await runPair(nodeDb, local, "UPDATE item SET name = 'none' WHERE id = 99");
  const returning = await local.prepare("INSERT INTO item (name, n) VALUES (?, ?) RETURNING id, name").bind("c", 3).run();
  const returningNode = await nodeDb.prepare("INSERT INTO item (name, n) VALUES (?, ?) RETURNING id, name").bind("c", 3).run();
  assert.equal(returning.meta.changes, returningNode.meta.changes);
  assert.deepEqual(plain(returning.results), plain(returningNode.results));

  const update = local.prepare("UPDATE item SET n = 7 WHERE name = 'a'");
  const log = local.prepare("INSERT INTO log (seen) VALUES (changes())");
  const updateNode = nodeDb.prepare("UPDATE item SET n = 7 WHERE name = 'a'");
  const logNode = nodeDb.prepare("INSERT INTO log (seen) VALUES (changes())");
  const localBatch = await local.batch([update, log]);
  const nodeBatch = await nodeDb.batch([updateNode, logNode]);
  assert.deepEqual(localBatch.map((row) => row.meta.changes), nodeBatch.map((row) => row.meta.changes));
  const seen = await local.prepare("SELECT seen FROM log").all<{ seen: number }>();
  const seenNode = await nodeDb.prepare("SELECT seen FROM log").all<{ seen: number }>();
  assert.deepEqual(plain(seen.results), plain(seenNode.results));
  assert.equal(seen.results?.[0]?.seen, 1);

  const first = await local.prepare("SELECT name, n FROM item WHERE name = ?").bind("blank").first<{ name: string; n: number | null }>();
  const firstNode = await nodeDb.prepare("SELECT name, n FROM item WHERE name = ?").bind("blank").first<{ name: string; n: number | null }>();
  assert.deepEqual(plain(first), plain(firstNode));
  assert.equal(first?.n, null);
  const all = await local.prepare("SELECT name FROM item ORDER BY id").all<{ name: string }>();
  const allNode = await nodeDb.prepare("SELECT name FROM item ORDER BY id").all<{ name: string }>();
  assert.deepEqual(plain(all.results), plain(allNode.results));
  raw.close();
});

test("local database uses the app schema with foreign keys off", async () => {
  const { db, d1 } = await openLocalDb({ wasm });
  const fk = await d1.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>();
  assert.equal(Number(fk?.foreign_keys), 0);
  const user = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'").first();
  assert.ok(user);
  await d1.prepare("INSERT INTO contacts (id, user_id, kind, name, created_at, updated_at) VALUES ('c', 'missing-user', 'person', 'Ada', 1, 1)").run();
  const row = await d1.prepare("SELECT name FROM contacts WHERE id = 'c'").first<{ name: string }>();
  assert.equal(row?.name, "Ada");
  db.close();
});

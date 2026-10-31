import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { D1RunResult } from "../lib/finance.ts";

export type ShimStatement = {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResult>;
  /** Runs the statement without yielding, so a batch can use changes() between statements. */
  runSync(): D1RunResult;
};

/** Bound statement. RETURNING rows come back on run().results (D1 does the same). */
export function bindStatement(db: DatabaseSync, sql: string, values: unknown[]): ShimStatement {
  const stmt = db.prepare(sql);
  const args = values.map((value) => (value === undefined ? null : value)) as Array<string | number | bigint | Uint8Array | null>;
  const exec = (): D1RunResult => {
    if (/\bRETURNING\b/i.test(sql)) {
      const results = stmt.all(...(args as [])) as unknown[];
      const changes = Number((db.prepare("SELECT changes() AS c").get() as { c: number } | undefined)?.c ?? 0);
      return { meta: { changes }, results };
    }
    const info = stmt.run(...(args as []));
    return { meta: { changes: Number(info.changes) } };
  };
  return {
    async first<T>() {
      const row = stmt.get(...(args as [])) as T | undefined;
      return row ?? null;
    },
    async all<T>() {
      return { results: stmt.all(...(args as [])) as T[] };
    },
    async run() {
      return exec();
    },
    runSync() {
      return exec();
    },
  };
}

/** One transaction per batch, and batches on this connection run one at a time (as D1 does). */
export function makeBatch(db: DatabaseSync) {
  let tail: Promise<unknown> = Promise.resolve();
  return function batch(statements: Array<{ run: () => Promise<D1RunResult>; runSync?: () => D1RunResult }>) {
    // Sync body when every statement has runSync: no await between them, so changes() stays put.
    const run = async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results: D1RunResult[] = [];
        for (const statement of statements) results.push(statement.runSync ? statement.runSync() : await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
        throw error;
      }
    };
    const next = tail.then(run, run);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

function applyMigrations(db: DatabaseSync) {
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    try {
      db.exec(sql);
    } catch {
      for (const part of sql.split(/;\s*\n/)) {
        const statement = part.trim();
        if (!statement) continue;
        try { db.exec(statement); } catch { /* skip only if this sqlite build cannot run it */ }
      }
    }
  }
}

export function openDb() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  db.exec("PRAGMA foreign_keys = ON");
  const d1 = {
    prepare(sql: string) {
      const bound = (values: unknown[]) => bindStatement(db, sql, values);
      // D1 statements expose all/first/run directly; bind() is optional when there are no placeholders.
      return { ...bound([]), bind(...values: unknown[]) { return bound(values); } };
    },
    batch: makeBatch(db),
  };
  return { db, d1 };
}

export function user(db: DatabaseSync, id: string) {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, id + "@test.local", 1, 1, 1, "user", "approved");
}

export function account(db: DatabaseSync, id: string, userId: string, currency = "ARS") {
  db.prepare("INSERT INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, userId, id, currency, 0, 1, 1);
}

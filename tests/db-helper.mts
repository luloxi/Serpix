import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { D1Like } from "../lib/finance.ts";

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
  const d1: D1Like = {
    prepare(sql) {
      return {
        bind(...values) {
          const stmt = db.prepare(sql);
          const args = values.map((value) => (value === undefined ? null : value)) as Array<string | number | bigint | null>;
          return {
            async first<T>() {
              const row = stmt.get(...(args as [])) as T | undefined;
              return row ?? null;
            },
            async all<T>() {
              return { results: stmt.all(...(args as [])) as T[] };
            },
            async run() {
              const info = stmt.run(...(args as []));
              return { meta: { changes: Number(info.changes) } };
            },
          };
        },
      };
    },
  };
  return { db, d1 };
}

export function user(db: DatabaseSync, id: string) {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, id + "@test.local", 1, 1, 1, "user", "approved");
}

export function account(db: DatabaseSync, id: string, userId: string, currency = "ARS") {
  db.prepare("INSERT INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, userId, id, currency, 0, 1, 1);
}

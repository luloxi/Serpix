// In-memory D1 stand-in on node:sqlite with every migration applied (shared by the documents tests).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { D1Like } from "../lib/finance.ts";
import { bindStatement, makeBatch } from "./db-helper.mts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../migrations");

export function openDb() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    try { db.exec(sql); } catch {
      for (const part of sql.split(/;\s*\n/)) { const s = part.trim(); if (s) { try { db.exec(s); } catch { /* skip */ } } }
    }
  }
  db.exec("PRAGMA foreign_keys = ON");
  const d1: D1Like = {
    prepare(sql) {
      return {
        bind(...values) {
          return bindStatement(db, sql, values);
        },
      };
    },
    batch: makeBatch(db),
  };
  return { db, d1 };
}

export function seedUser(db: DatabaseSync, id: string) {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, id + "@test.local", 1, 1, 1, "user", "approved");
}
export function seedContact(db: DatabaseSync, id: string, userId: string, name: string) {
  db.prepare("INSERT INTO contacts (id,user_id,kind,name,email,phone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, userId, "company", name, id + "@c.test", "+54 9 11 5555", 1, 1);
}
export function seedAccount(db: DatabaseSync, id: string, userId: string, currency: string) {
  db.prepare("INSERT INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, userId, "Caja " + currency, currency, 0, 1, 1);
}
export function seedTask(db: DatabaseSync, id: string, userId: string, contactId: string | null, title: string) {
  db.prepare("INSERT INTO tasks (id,user_id,contact_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, userId, contactId, title, 1, 1);
}
export function seedEntry(db: DatabaseSync, id: string, userId: string, taskId: string | null, o: { hours?: number; rate?: number; billable?: number; currency?: string; startedAt?: number } = {}) {
  const ms = (o.hours ?? 2) * 3_600_000, rate = o.rate ?? 1_000_000;
  db.prepare("INSERT INTO time_entries (id,user_id,task_id,started_at,ended_at,duration_ms,billable,hourly_rate_minor,amount_minor,currency,description,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, userId, taskId, o.startedAt ?? 1_790_000_000_000, (o.startedAt ?? 1_790_000_000_000) + ms, ms, o.billable ?? 1, rate, Math.round((ms / 3_600_000) * rate), o.currency ?? "ARS", null, 1);
}

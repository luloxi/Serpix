// D1-shaped adapter over an in-memory sql.js database. Wasm bytes are injected:
// node tests read public/vendor/sql-wasm.wasm; the browser fetches that same file.
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import type { D1Like, D1RunResult } from "@/lib/finance.ts";
import { LOCAL_SCHEMA_SQL, LOCAL_USER_STUB_SQL } from "./schema.ts";

export type LocalDatabase = Database;

type InitFn = (config?: { wasmBinary?: ArrayBuffer | Uint8Array }) => Promise<SqlJsStatic>;

let loading: Promise<SqlJsStatic> | null = null;

function asInit(mod: unknown): InitFn {
  if (typeof mod === "function") return mod as InitFn;
  if (mod && typeof mod === "object" && "default" in mod && typeof mod.default === "function") return mod.default as InitFn;
  throw new Error("sql.js did not load");
}

export function loadSqlJs(wasm: Uint8Array | ArrayBuffer): Promise<SqlJsStatic> {
  if (!loading) {
    const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
    loading = asInit(initSqlJs)({ wasmBinary: bytes });
  }
  return loading;
}

/** Browser helper. Tests pass the bytes in and do not fetch. */
export async function fetchVendorWasm(fetchImpl: typeof fetch = globalThis.fetch): Promise<Uint8Array> {
  const response = await fetchImpl("/vendor/sql-wasm.wasm");
  if (!response.ok) throw new Error("sql wasm missing");
  return new Uint8Array(await response.arrayBuffer());
}

function sqlParam(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new Error("unsupported SQL value");
}

function normalizeCell(value: SqlValue): unknown {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function normalizeRow(row: Record<string, SqlValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) out[key] = normalizeCell(row[key]);
  return out;
}

export type LocalBound = {
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<D1RunResult>;
  runSync(): D1RunResult;
};

function bindStatement(db: Database, sql: string, values: unknown[]): LocalBound {
  const args = values.map(sqlParam);
  const returning = /\bRETURNING\b/i.test(sql);
  const exec = (): D1RunResult => {
    if (returning) {
      const stmt = db.prepare(sql);
      try {
        if (args.length) stmt.bind(args);
        const results: Record<string, unknown>[] = [];
        while (stmt.step()) results.push(normalizeRow(stmt.getAsObject()));
        return { meta: { changes: db.getRowsModified() }, results };
      } finally {
        stmt.free();
      }
    }
    if (args.length) db.run(sql, args);
    else db.run(sql);
    return { meta: { changes: db.getRowsModified() } };
  };
  const read = (): Record<string, unknown>[] => {
    const stmt = db.prepare(sql);
    try {
      if (args.length) stmt.bind(args);
      const results: Record<string, unknown>[] = [];
      while (stmt.step()) results.push(normalizeRow(stmt.getAsObject()));
      return results;
    } finally {
      stmt.free();
    }
  };
  return {
    async first<T>() {
      const rows = read();
      return (rows[0] as T | undefined) ?? null;
    },
    async all<T>() {
      return { results: read() as T[] };
    },
    async run() {
      return exec();
    },
    runSync() {
      return exec();
    },
  };
}

function makeBatch(db: Database) {
  let tail: Promise<unknown> = Promise.resolve();
  return function batch(statements: Array<{ run: () => Promise<D1RunResult>; runSync?: () => D1RunResult }>): Promise<D1RunResult[]> {
    const run = async () => {
      db.run("BEGIN IMMEDIATE");
      try {
        const results: D1RunResult[] = [];
        for (const statement of statements) results.push(statement.runSync ? statement.runSync() : await statement.run());
        db.run("COMMIT");
        return results;
      } catch (error) {
        try { db.run("ROLLBACK"); } catch { /* nothing to roll back */ }
        throw error;
      }
    };
    const next = tail.then(run, run);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}

export type LocalD1 = D1Like & {
  batch: (statements: LocalBound[]) => Promise<D1RunResult[]>;
};

export function createD1(db: Database): LocalD1 {
  return {
    prepare(sql: string) {
      const bound = (values: unknown[]) => bindStatement(db, sql, values);
      return { ...bound([]), bind(...values: unknown[]) { return bound(values); } };
    },
    batch: makeBatch(db),
  };
}

export async function openLocalDb(options: { wasm: Uint8Array | ArrayBuffer }): Promise<{ db: Database; d1: LocalD1 }> {
  const SQL = await loadSqlJs(options.wasm);
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(LOCAL_USER_STUB_SQL);
  db.exec(LOCAL_SCHEMA_SQL);
  return { db, d1: createD1(db) };
}

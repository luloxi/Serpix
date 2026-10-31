// Push and pull AES-GCM envelopes. Plaintext rows stay in the local database.
import { openBytes, openRecord, sealBytes, sealRecord } from "../crypto/envelope.ts";
import type { D1Like } from "../finance.ts";
import { MAX_RECEIPT_BYTES } from "../receipt.ts";
import type { LocalD1 } from "./d1-local.ts";

export const RECEIPT_FILES = "receipt_files";
const PAGE = 500;

export type SyncStatus = "idle" | "syncing" | "pending" | "offline" | "error";

type TableSpec = {
  table: string;
  collection: string;
  /** SQL expression for NEW/OLD, already quoted. */
  keyExpr: string;
};

const TABLES: TableSpec[] = [
  { table: "contacts", collection: "contacts", keyExpr: "id" },
  { table: "projects", collection: "projects", keyExpr: "id" },
  { table: "tasks", collection: "tasks", keyExpr: "id" },
  { table: "financial_accounts", collection: "accounts", keyExpr: "id" },
  { table: "financial_transactions", collection: "transactions", keyExpr: "id" },
  { table: "activities", collection: "activities", keyExpr: "id" },
  { table: "activity_contacts", collection: "activity_contacts", keyExpr: "activity_id || ':' || contact_id" },
  { table: "time_entries", collection: "time_entries", keyExpr: "id" },
  { table: "timer_state", collection: "timer_state", keyExpr: "user_id" },
  { table: "documents", collection: "documents", keyExpr: "id" },
  { table: "document_items", collection: "document_items", keyExpr: "id" },
  { table: "document_time_entries", collection: "document_time_entries", keyExpr: "time_entry_id" },
  { table: "receipts", collection: "receipts", keyExpr: "id" },
  { table: "recurring_rules", collection: "recurring_rules", keyExpr: "id" },
];

const TABLE_BY_NAME = new Map(TABLES.map((spec) => [spec.table, spec]));
const TABLE_BY_COLLECTION = new Map(TABLES.map((spec) => [spec.collection, spec]));

const DOC_STATUSES = new Set(["draft", "sent", "paid", "void"]);

function quote(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("bad identifier");
  return `"${name}"`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  if (!data) return new Uint8Array();
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type RemoteRecord = {
  collection: string;
  id: string;
  seq: number;
  version: number;
  blob: string;
  deleted: boolean;
  docType?: string | null;
  docNumber?: number | null;
  docStatus?: string | null;
  docDueDate?: string | null;
};

type DirtyEntry = { table: string; key: string; op: "upsert" | "delete"; seq: number };

export type SyncEngine = {
  pull: () => Promise<void>;
  push: () => Promise<void>;
  status: () => SyncStatus;
  idle: () => Promise<void>;
  close: () => void;
  /** Serializes local route handlers with pull/push so the applying flag cannot hide a user write. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
};

type SyncOptions = {
  userId: string;
  dek: CryptoKey;
  db: LocalD1;
  fetch: typeof fetch;
  baseUrl?: string;
  onStatus?: (status: SyncStatus) => void;
  events?: EventTarget;
};

function versionKey(collection: string, id: string): string {
  return collection + "\n" + id;
}

function keyWhere(table: string, key: string): { clause: string; args: unknown[] } {
  if (table === "activity_contacts") {
    const index = key.indexOf(":");
    if (index <= 0) throw new Error("bad activity key");
    return { clause: `${quote("activity_id")} = ? AND ${quote("contact_id")} = ?`, args: [key.slice(0, index), key.slice(index + 1)] };
  }
  if (table === "document_time_entries") return { clause: `${quote("time_entry_id")} = ?`, args: [key] };
  if (table === "timer_state") return { clause: `${quote("user_id")} = ?`, args: [key] };
  return { clause: `${quote("id")} = ?`, args: [key] };
}

function triggerKey(table: string, alias: "NEW" | "OLD"): string {
  if (table === "activity_contacts") return `${alias}.${quote("activity_id")} || ':' || ${alias}.${quote("contact_id")}`;
  if (table === "document_time_entries") return `${alias}.${quote("time_entry_id")}`;
  if (table === "timer_state") return `${alias}.${quote("user_id")}`;
  return `${alias}.${quote("id")}`;
}

export async function installSyncSchema(db: D1Like): Promise<void> {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS _sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0)",
  ).bind().run();
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS _dirty (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, "key" TEXT NOT NULL, op TEXT NOT NULL)',
  ).bind().run();
  await db.prepare("INSERT OR IGNORE INTO _sync_state (id, applying, cursor) VALUES (1, 0, 0)").bind().run();
  const when = "IFNULL((SELECT applying FROM _sync_state WHERE id = 1), 0) = 0";
  for (const spec of TABLES) {
    const inserted = triggerKey(spec.table, "NEW");
    const removed = triggerKey(spec.table, "OLD");
    const write = `INSERT INTO _dirty (tbl, "key", op) VALUES ('${spec.table}', `;
    await db.prepare(
      `CREATE TRIGGER IF NOT EXISTS ${quote("_dirty_" + spec.table + "_ai")} AFTER INSERT ON ${quote(spec.table)} WHEN ${when} BEGIN ${write}${inserted}, 'upsert'); END`,
    ).bind().run();
    await db.prepare(
      `CREATE TRIGGER IF NOT EXISTS ${quote("_dirty_" + spec.table + "_au")} AFTER UPDATE ON ${quote(spec.table)} WHEN ${when} BEGIN ${write}${inserted}, 'upsert'); END`,
    ).bind().run();
    await db.prepare(
      `CREATE TRIGGER IF NOT EXISTS ${quote("_dirty_" + spec.table + "_ad")} AFTER DELETE ON ${quote(spec.table)} WHEN ${when} BEGIN ${write}${removed}, 'delete'); END`,
    ).bind().run();
  }
}

export function createSync(options: SyncOptions): SyncEngine {
  const db = options.db;
  const base = options.baseUrl ?? "http://e2e.local";
  const versions = new Map<string, number>();
  const pendingFiles = new Map<string, string>();
  const columns = new Map<string, { names: string[]; pk: string[] }>();
  let status: SyncStatus = "idle";
  let chain: Promise<void> = Promise.resolve();
  let depth = 0;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unlisten = () => {};

  function setStatus(next: SyncStatus) {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  }

  function endpoint(path: string): string {
    return base + path;
  }

  async function setApplying(value: 0 | 1) {
    await db.prepare("UPDATE _sync_state SET applying = ? WHERE id = 1").bind(value).run();
  }

  async function withApplying<T>(fn: () => Promise<T>): Promise<T> {
    await setApplying(1);
    try {
      return await fn();
    } finally {
      await setApplying(0);
    }
  }

  async function tableInfo(table: string): Promise<{ names: string[]; pk: string[] }> {
    const cached = columns.get(table);
    if (cached) return cached;
    const rows = (await db.prepare(`PRAGMA table_info(${quote(table)})`).bind().all<{ name: string; pk: number }>()).results ?? [];
    const info = {
      names: rows.map((row) => String(row.name)),
      pk: rows.filter((row) => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((row) => String(row.name)),
    };
    if (!info.pk.length) throw new Error("missing primary key");
    columns.set(table, info);
    return info;
  }

  async function readRow(table: string, key: string): Promise<Record<string, unknown> | null> {
    const where = keyWhere(table, key);
    return db.prepare(`SELECT * FROM ${quote(table)} WHERE ${where.clause}`).bind(...where.args).first<Record<string, unknown>>();
  }

  async function writeRow(table: string, row: Record<string, unknown>) {
    const info = await tableInfo(table);
    const present = info.names.filter((name) => Object.prototype.hasOwnProperty.call(row, name));
    for (const pk of info.pk) if (!present.includes(pk)) throw new Error("row missing primary key");
    const updates = present.filter((name) => !info.pk.includes(name));
    const assignments = updates.length ? updates.map((name) => `${quote(name)} = excluded.${quote(name)}`).join(", ") : `${quote(info.pk[0])} = excluded.${quote(info.pk[0])}`;
    const sql = `INSERT INTO ${quote(table)} (${present.map(quote).join(", ")}) VALUES (${present.map(() => "?").join(", ")}) ON CONFLICT(${info.pk.map(quote).join(", ")}) DO UPDATE SET ${assignments}`;
    await db.prepare(sql).bind(...present.map((name) => row[name] ?? null)).run();
  }

  async function deleteRow(table: string, key: string) {
    const where = keyWhere(table, key);
    await db.prepare(`DELETE FROM ${quote(table)} WHERE ${where.clause}`).bind(...where.args).run();
  }

  async function cursor(): Promise<number> {
    const row = await db.prepare("SELECT cursor FROM _sync_state WHERE id = 1").bind().first<{ cursor: number }>();
    return Number(row?.cursor ?? 0);
  }

  async function setCursor(value: number) {
    await db.prepare("UPDATE _sync_state SET cursor = ? WHERE id = 1").bind(value).run();
  }

  async function dirtyKeys(): Promise<Set<string>> {
    const rows = (await db.prepare('SELECT tbl, "key" AS key FROM _dirty').bind().all<{ tbl: string; key: string }>()).results ?? [];
    const keys = new Set<string>();
    for (const row of rows) {
      const spec = TABLE_BY_NAME.get(row.tbl);
      if (spec) keys.add(versionKey(spec.collection, row.key));
    }
    return keys;
  }

  function remember(collection: string, id: string, version: number) {
    versions.set(versionKey(collection, id), version);
  }

  async function applyRecord(record: RemoteRecord, force: boolean, dirty: Set<string>) {
    const vk = versionKey(record.collection, record.id);
    if (!force && dirty.has(vk)) return false;
    if (!force && record.collection === RECEIPT_FILES && dirty.has(versionKey("receipts", record.id))) return false;
    remember(record.collection, record.id, record.version);
    if (record.collection === RECEIPT_FILES) {
      await applyFile(record);
      return true;
    }
    const spec = TABLE_BY_COLLECTION.get(record.collection);
    if (!spec) return true;
    if (record.deleted) {
      await deleteRow(spec.table, record.id);
      pendingFiles.delete(record.id);
      return true;
    }
    let plain: unknown;
    try {
      plain = await openRecord(options.dek, { table: record.collection, id: record.id, userId: options.userId }, record.blob);
    } catch (error) {
      setStatus("error");
      throw error;
    }
    if (!plain || typeof plain !== "object" || Array.isArray(plain)) {
      setStatus("error");
      throw new Error("record plaintext");
    }
    const row = { ...(plain as Record<string, unknown>) };
    if (spec.table === "receipts" && !Object.prototype.hasOwnProperty.call(row, "data")) {
      const pending = pendingFiles.get(record.id);
      if (pending !== undefined) {
        row.data = pending;
        pendingFiles.delete(record.id);
      } else {
        const existing = await readRow(spec.table, record.id);
        row.data = existing?.data ?? "";
      }
    }
    await writeRow(spec.table, row);
    return true;
  }

  async function applyFile(record: RemoteRecord) {
    if (record.deleted) {
      pendingFiles.delete(record.id);
      const existing = await readRow("receipts", record.id);
      if (existing) await db.prepare("UPDATE receipts SET data = '' WHERE id = ?").bind(record.id).run();
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await openBytes(options.dek, { table: RECEIPT_FILES, id: record.id, userId: options.userId }, record.blob);
    } catch (error) {
      setStatus("error");
      throw error;
    }
    const data = bytesToBase64(bytes);
    const existing = await readRow("receipts", record.id);
    if (!existing) {
      pendingFiles.set(record.id, data);
      return;
    }
    await db.prepare("UPDATE receipts SET data = ? WHERE id = ?").bind(data, record.id).run();
  }

  async function pullBody(force = false) {
    if (closed) return;
    setStatus("syncing");
    let since = await cursor();
    for (;;) {
      let response: Response;
      try {
        response = await options.fetch(endpoint(`/api/e2e/records?since=${since}&limit=${PAGE}`));
      } catch (error) {
        setStatus("offline");
        schedule();
        throw error;
      }
      if (!response.ok) {
        setStatus(response.status >= 500 ? "error" : "offline");
        if (response.status >= 500 || response.status === 0) schedule();
        throw new Error("pull failed " + response.status);
      }
      const body = await response.json() as { records?: RemoteRecord[]; cursor?: number; more?: boolean };
      const records = body.records ?? [];
      const dirty = force ? new Set<string>() : await dirtyKeys();
      let blocked = false;
      let advanced = since;
      await withApplying(async () => {
        for (const record of records) {
          const applied = await applyRecord(record, force, dirty);
          if (!applied) {
            blocked = true;
            continue;
          }
          if (!blocked) advanced = Number(record.seq);
        }
      });
      if (!blocked && body.cursor != null && records.length === 0) advanced = Number(body.cursor);
      if (advanced !== since) await setCursor(advanced);
      since = advanced;
      if (blocked || !body.more) break;
      if (!records.length) break;
    }
    await refreshStatus();
  }

  async function listDirty(): Promise<DirtyEntry[]> {
    const rows = (await db.prepare('SELECT seq, tbl, "key" AS key, op FROM _dirty ORDER BY seq ASC').bind().all<{ seq: number; tbl: string; key: string; op: string }>()).results ?? [];
    const merged = new Map<string, DirtyEntry>();
    for (const row of rows) {
      if (!TABLE_BY_NAME.has(row.tbl)) continue;
      merged.set(row.tbl + "\n" + row.key, { table: row.tbl, key: row.key, op: row.op === "delete" ? "delete" : "upsert", seq: Number(row.seq) });
    }
    return [...merged.values()];
  }

  async function clearDirty(entry: DirtyEntry) {
    await db.prepare('DELETE FROM _dirty WHERE tbl = ? AND "key" = ? AND seq <= ?').bind(entry.table, entry.key, entry.seq).run();
  }

  function sealable(table: string, row: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      if (table === "receipts" && key === "data") continue;
      const value = row[key];
      if (typeof value === "bigint") copy[key] = Number(value);
      else if (value instanceof Uint8Array) copy[key] = bytesToBase64(value);
      else copy[key] = value ?? null;
    }
    return copy;
  }

  function docOf(row: Record<string, unknown>): { type: "quote" | "invoice"; number: number; status: "draft" | "sent" | "paid" | "void"; dueDate: string | null } | null {
    const type = row.doc_type;
    const status = row.status;
    const number = Number(row.number);
    if ((type !== "quote" && type !== "invoice") || typeof status !== "string" || !DOC_STATUSES.has(status) || !Number.isSafeInteger(number) || number < 1) return null;
    const due = row.due_date == null || row.due_date === "" ? null : String(row.due_date);
    return { type, number, status: status as "draft" | "sent" | "paid" | "void", dueDate: due };
  }

  async function send(method: "PUT" | "DELETE", collection: string, id: string, payload: Record<string, unknown>): Promise<{ kind: "ok"; version: number } | { kind: "conflict"; currentVersion: number } | { kind: "missing" } | { kind: "offline" } | { kind: "error"; retry?: boolean }> {
    let response: Response;
    try {
      response = await options.fetch(endpoint(`/api/e2e/records/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      return { kind: "offline" };
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 404 && method === "DELETE") return { kind: "missing" };
    if (response.status === 409) {
      const current = body && typeof body === "object" ? (body as { currentVersion?: unknown }).currentVersion : undefined;
      if (typeof current === "number" && Number.isInteger(current) && current >= 0) return { kind: "conflict", currentVersion: current };
      return { kind: "error" };
    }
    if (!response.ok) return response.status >= 500 ? { kind: "error", retry: true } : { kind: "error" };
    const version = body && typeof body === "object" ? Number((body as { version?: unknown }).version) : NaN;
    if (!Number.isInteger(version)) return { kind: "error" };
    return { kind: "ok", version };
  }

  async function pushFile(id: string, data: string): Promise<{ kind: "ok" } | { kind: "conflict"; currentVersion: number } | { kind: "offline" } | { kind: "error"; retry?: boolean } | { kind: "skip" }> {
    const raw = base64ToBytes(data);
    const known = versions.get(versionKey(RECEIPT_FILES, id)) ?? 0;
    if (!raw.byteLength) {
      if (!known) return { kind: "skip" };
      const result = await send("DELETE", RECEIPT_FILES, id, { expectedVersion: known });
      if (result.kind === "ok") {
        remember(RECEIPT_FILES, id, result.version);
        return { kind: "ok" };
      }
      if (result.kind === "missing") {
        versions.delete(versionKey(RECEIPT_FILES, id));
        return { kind: "ok" };
      }
      return result;
    }
    if (raw.byteLength > MAX_RECEIPT_BYTES) return { kind: "error" };
    const blob = await sealBytes(options.dek, { table: RECEIPT_FILES, id, userId: options.userId }, raw);
    const result = await send("PUT", RECEIPT_FILES, id, { expectedVersion: known, blob });
    if (result.kind === "ok") {
      remember(RECEIPT_FILES, id, result.version);
      return { kind: "ok" };
    }
    if (result.kind === "missing") return { kind: "error" };
    return result;
  }

  async function pushEntry(entry: DirtyEntry): Promise<{ kind: "ok" } | { kind: "conflict"; collection: string; id: string; currentVersion: number } | { kind: "offline" } | { kind: "error"; retry?: boolean }> {
    const spec = TABLE_BY_NAME.get(entry.table);
    if (!spec) {
      await clearDirty(entry);
      return { kind: "ok" };
    }
    const row = await readRow(entry.table, entry.key);
    const known = versions.get(versionKey(spec.collection, entry.key)) ?? 0;
    if (!row) {
      if (!known) {
        await clearDirty(entry);
        return { kind: "ok" };
      }
      const result = await send("DELETE", spec.collection, entry.key, { expectedVersion: known });
      if (result.kind === "conflict") return { kind: "conflict", collection: spec.collection, id: entry.key, currentVersion: result.currentVersion };
      if (result.kind !== "ok" && result.kind !== "missing") return result;
      if (result.kind === "ok") remember(spec.collection, entry.key, result.version);
      else versions.delete(versionKey(spec.collection, entry.key));
      if (spec.table === "receipts") {
        const file = await pushFile(entry.key, "");
        if (file.kind === "conflict") return { kind: "conflict", collection: RECEIPT_FILES, id: entry.key, currentVersion: file.currentVersion };
        if (file.kind === "offline" || file.kind === "error") return file;
      }
      await clearDirty(entry);
      return { kind: "ok" };
    }
    const blob = await sealRecord(options.dek, { table: spec.collection, id: entry.key, userId: options.userId }, sealable(spec.table, row));
    const payload: Record<string, unknown> = { expectedVersion: known, blob };
    if (spec.collection === "documents") {
      const doc = docOf(row);
      if (!doc) return { kind: "error" };
      payload.doc = doc;
    }
    const result = await send("PUT", spec.collection, entry.key, payload);
    if (result.kind === "conflict") return { kind: "conflict", collection: spec.collection, id: entry.key, currentVersion: result.currentVersion };
    if (result.kind !== "ok") return result.kind === "missing" ? { kind: "error" } : result;
    remember(spec.collection, entry.key, result.version);
    if (spec.table === "receipts") {
      const file = await pushFile(entry.key, typeof row.data === "string" ? row.data : "");
      if (file.kind === "conflict") return { kind: "conflict", collection: RECEIPT_FILES, id: entry.key, currentVersion: file.currentVersion };
      if (file.kind === "offline" || file.kind === "error") return file;
    }
    await clearDirty(entry);
    return { kind: "ok" };
  }

  async function snapshotDirty(): Promise<Array<{ table: string; key: string; row: Record<string, unknown> | null }>> {
    const entries = await listDirty();
    const snaps = [];
    for (const entry of entries) snaps.push({ table: entry.table, key: entry.key, row: await readRow(entry.table, entry.key) });
    return snaps;
  }

  async function resolveConflict(hint: { collection: string; id: string; currentVersion: number }) {
    const snaps = await snapshotDirty();
    await pullBody(true);
    await withApplying(async () => {
      for (const snap of snaps) {
        if (snap.row) await writeRow(snap.table, snap.row);
        else await deleteRow(snap.table, snap.key);
      }
    });
    const key = versionKey(hint.collection, hint.id);
    const known = versions.get(key) ?? 0;
    if (hint.currentVersion > known) versions.set(key, hint.currentVersion);
  }

  async function refreshStatus() {
    const rows = await listDirty();
    if (!rows.length) {
      attempt = 0;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      setStatus("idle");
      return;
    }
    if (status !== "offline" && status !== "error") setStatus("pending");
  }

  function schedule() {
    if (closed || timer) return;
    const delay = Math.min(30_000, 250 * 2 ** attempt);
    attempt = Math.min(attempt + 1, 16);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) void push();
    }, delay);
    const handle = timer as { unref?: () => void };
    handle.unref?.();
  }

  async function pushBody() {
    if (closed) return;
    for (let round = 0; round < 3; round++) {
      const entries = await listDirty();
      if (!entries.length) {
        await refreshStatus();
        return;
      }
      setStatus("syncing");
      let conflict: { collection: string; id: string; currentVersion: number } | null = null;
      for (const entry of entries) {
        const result = await pushEntry(entry);
        if (result.kind === "ok") continue;
        if (result.kind === "conflict") {
          conflict = result;
          break;
        }
        if (result.kind === "offline") {
          setStatus("offline");
          schedule();
          return;
        }
        setStatus("error");
        if (result.retry) schedule();
        return;
      }
      if (!conflict) {
        await refreshStatus();
        return;
      }
      if (round === 2) {
        setStatus("error");
        return;
      }
      await resolveConflict(conflict);
    }
  }

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  function push(): Promise<void> {
    if (closed) return Promise.resolve();
    if (depth > 0) return Promise.resolve();
    return enqueue(() => pushBody());
  }

  function pull(): Promise<void> {
    if (closed) return Promise.resolve();
    if (depth > 0) return pullBody(false);
    return enqueue(async () => {
      await pushBody();
      await pullBody(false);
    });
  }

  const target = options.events ?? (typeof window !== "undefined" ? window : null);
  if (target) {
    const onOnline = () => {
      attempt = 0;
      void push();
    };
    target.addEventListener("online", onOnline);
    unlisten = () => target.removeEventListener("online", onOnline);
  }

  return {
    pull,
    push,
    status: () => status,
    idle: () => chain,
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
      if (depth > 0) return fn();
      return enqueue(fn);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      unlisten();
    },
  };
}


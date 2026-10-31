import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "./db-helper.mts";

export const A = "user-a";
export const B = "user-b";
export const P256 = "A".repeat(87);
export const PUSH_AUTH = "B".repeat(22);
export const AVATAR = "data:image/png;base64,iVBORw0KGgo=";

export const ids = {
  contactA: "contact-a",
  contactB: "contact-b",
  projectA: "project-a",
  projectB: "project-b",
  taskA: "task-a",
  taskB: "task-b",
  accountA: "account-a",
  accountB: "account-b",
  txA: "tx-a",
  txB: "tx-b",
  receiptA: "receipt-a",
  receiptB: "receipt-b",
  receiptBFree: "receipt-b-free",
  ruleA: "rule-a",
  ruleB: "rule-b",
  activityA: "activity-a",
  activityB: "activity-b",
  inquiryA: "inquiry-a",
  inquiryB: "inquiry-b",
  entryA: "entry-a",
  entryB: "entry-b",
  docA: "doc-a",
  docB: "doc-b",
  itemA: "item-a",
  itemB: "item-b",
  itemPoison: "item-poison",
  pushA: "https://push.example.test/device-user-a",
  pushB: "https://push.example.test/device-user-b",
};

const TABLES = ["user", "contacts", "projects", "tasks", "financial_accounts", "financial_transactions", "receipts", "recurring_rules", "activities", "activity_contacts", "inquiries", "push_subscriptions", "timer_state", "time_entries", "documents", "document_items", "document_time_entries", "contact_relationships", "session", "invites"];

function userRow(db: DatabaseSync, id: string, name: string) {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, name, id + "@test.local", 1, 1, 1, "user", "approved");
}

export function seedWorld() {
  const { db, d1 } = openDb();
  userRow(db, A, "Ana Secret");
  userRow(db, B, "Beto");
  const contact = db.prepare("INSERT INTO contacts (id,user_id,kind,name,email,phone,notes,is_potential,created_at,updated_at,avatar_data,avatar_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  contact.run(ids.contactA, A, "person", "A-SECRET-CONTACT", "a-secret@test.local", "111", "A-SECRET-NOTES", 0, 1, 1, AVATAR, "custom");
  contact.run(ids.contactB, B, "person", "B-CONTACT", "b@test.local", "222", "nota b", 0, 1, 1, AVATAR, "custom");
  const project = db.prepare("INSERT INTO projects (id,user_id,name,description,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  project.run(ids.projectA, A, "A-SECRET-PROJECT", "A-SECRET-PROJECT-DESC", "active", 1, 1);
  project.run(ids.projectB, B, "B-PROJECT", "proyecto b", "active", 1, 1);
  const task = db.prepare("INSERT INTO tasks (id,user_id,project_id,contact_id,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  task.run(ids.taskA, A, ids.projectA, ids.contactA, "A-SECRET-TASK", "A-SECRET-TASK-DESC", "todo", "normal", 1, 1);
  task.run(ids.taskB, B, ids.projectB, ids.contactB, "B-TASK", "tarea b", "todo", "normal", 1, 1);
  const account = db.prepare("INSERT INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  account.run(ids.accountA, A, "A-SECRET-ACCOUNT", "ARS", 0, 1, 1);
  account.run(ids.accountB, B, "B-ACCOUNT", "ARS", 0, 1, 1);
  const tx = db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,contact_id,kind,amount_minor,category,description,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  tx.run(ids.txA, A, ids.accountA, ids.contactA, "expense", 424242, "A-SECRET-CAT", "A-SECRET-TX", "2026-10-01", 1);
  tx.run(ids.txB, B, ids.accountB, ids.contactB, "expense", 100, "Comida", "gasto b", "2026-10-02", 2);
  const receipt = db.prepare("INSERT INTO receipts (id,user_id,transaction_id,mime,size,data,read_ok,created_at) VALUES (?,?,?,?,?,?,?,?)");
  receipt.run(ids.receiptA, A, ids.txA, "image/png", 8, "iVBORw0KGgo=", 0, 1);
  receipt.run(ids.receiptB, B, ids.txB, "image/png", 8, "iVBORw0KGgo=", 0, 2);
  receipt.run(ids.receiptBFree, B, null, "image/png", 8, "iVBORw0KGgo=", 0, 3);
  const rule = db.prepare("INSERT INTO recurring_rules (id,user_id,account_id,contact_id,kind,amount_minor,category,description,frequency,anchor_date,status,from_date,generated_through,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  rule.run(ids.ruleA, A, ids.accountA, ids.contactA, "expense", 500, "A-SECRET-RULE", "A-SECRET-RULE-DESC", "monthly", "2020-01-01", "active", "2020-01-01", "2099-12-31", 1, 1);
  rule.run(ids.ruleB, B, ids.accountB, ids.contactB, "expense", 500, "B-RULE", "regla b", "monthly", "2020-01-01", "active", "2020-01-01", "2099-12-31", 1, 1);
  const activity = db.prepare("INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
  activity.run(ids.activityA, A, "note", "A-SECRET-ACTIVITY", "A-SECRET-BODY", "2026-10-01T12:00:00.000Z", 1, 1);
  activity.run(ids.activityB, B, "note", "B-ACTIVITY", "cuerpo b", "2026-10-02T12:00:00.000Z", 2, 2);
  const link = db.prepare("INSERT INTO activity_contacts (activity_id,contact_id,user_id) VALUES (?,?,?)");
  link.run(ids.activityA, ids.contactA, A);
  link.run(ids.activityB, ids.contactB, B);
  // Child row owned by A hanging off B's activity. A list that forgets ac.user_id would leak contact-a.
  link.run(ids.activityB, ids.contactA, A);
  const inquiry = db.prepare("INSERT INTO inquiries (id,user_id,source,name,email,message,status,created_at) VALUES (?,?,?,?,?,?,?,?)");
  inquiry.run(ids.inquiryA, A, "portfolio", "A-SECRET-INQ", "inq-a@test.local", "A-SECRET-MESSAGE", "new", 1);
  inquiry.run(ids.inquiryB, B, "portfolio", "B-INQ", "inq-b@test.local", "mensaje b", "new", 2);
  const push = db.prepare("INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,created_at) VALUES (?,?,?,?,?,?)");
  push.run("push-row-a", A, ids.pushA, P256, PUSH_AUTH, 1);
  push.run("push-row-b", B, ids.pushB, P256, PUSH_AUTH, 2);
  db.prepare("INSERT INTO timer_state (user_id,started_at,segment_start,accumulated_ms,updated_at) VALUES (?,?,?,?,?)").run(A, 111111, 111111, 0, 1);
  db.prepare("INSERT INTO timer_state (user_id,started_at,segment_start,accumulated_ms,updated_at) VALUES (?,?,?,?,?)").run(B, 222222, 222222, 0, 2);
  const entry = db.prepare("INSERT INTO time_entries (id,user_id,task_id,started_at,ended_at,duration_ms,billable,hourly_rate_minor,amount_minor,currency,description,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  entry.run(ids.entryA, A, ids.taskA, 1_700_000_000_000, 1_700_003_600_000, 3_600_000, 1, 1000, 1000, "ARS", "A-SECRET-HOURS", 1);
  entry.run(ids.entryB, B, ids.taskB, 1_700_000_000_000, 1_700_003_600_000, 3_600_000, 1, 1000, 1000, "ARS", "horas b", 2);
  const doc = db.prepare("INSERT INTO documents (id,user_id,doc_type,number,contact_id,issue_date,due_date,currency,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  doc.run(ids.docA, A, "invoice", 1, ids.contactA, "2026-10-01", "2026-10-16", "ARS", "A-SECRET-DOC", "draft", 1, 1);
  doc.run(ids.docB, B, "invoice", 1, ids.contactB, "2026-10-01", "2026-10-16", "ARS", "doc b", "draft", 2, 2);
  const item = db.prepare("INSERT INTO document_items (id,document_id,position,description,quantity_milli,unit_price_minor,user_id) VALUES (?,?,?,?,?,?,?)");
  item.run(ids.itemA, ids.docA, 0, "A-SECRET-ITEM", 1000, 100, A);
  item.run(ids.itemB, ids.docB, 0, "B-ITEM", 1000, 100, B);
  // A's item parked on B's document. getDocument must filter i.user_id.
  item.run(ids.itemPoison, ids.docB, 1, "A-POISON-ITEM", 1000, 999999, A);
  db.prepare("INSERT INTO document_time_entries (time_entry_id,document_id,user_id) VALUES (?,?,?)").run(ids.entryA, ids.docA, A);
  // B's hours linked under A's user_id. The import query must require d.user_id = e.user_id or these hours vanish.
  db.prepare("INSERT INTO document_time_entries (time_entry_id,document_id,user_id) VALUES (?,?,?)").run(ids.entryB, ids.docA, A);
  return { db, d1 };
}

export function snap(db: DatabaseSync) {
  const out: Record<string, unknown> = {};
  for (const table of TABLES) out[table] = db.prepare("SELECT * FROM " + table).all();
  return JSON.stringify(out);
}

export function assertSame(db: DatabaseSync, before: string) {
  const after = snap(db);
  if (after === before) return;
  const a = JSON.parse(before) as Record<string, unknown[]>;
  const b = JSON.parse(after) as Record<string, unknown[]>;
  const diffs = Object.keys(a).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
  assert.fail("db changed in " + diffs.join(", ") + "\n" + diffs.map((key) => key + "\n before " + JSON.stringify(a[key]) + "\n after " + JSON.stringify(b[key])).join("\n"));
}

const MARKERS = ["A-SECRET", "A-POISON", "contact-a", "project-a", "task-a", "account-a", "tx-a", "receipt-a", "rule-a", "activity-a", "inquiry-a", "entry-a", "doc-a", "item-a", "item-poison", "user-a", "device-user-a"];

export function assertNoA(body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  for (const marker of MARKERS) assert.equal(text.includes(marker), false, "leaked " + marker + " in " + text.slice(0, 600));
}

export function assert4xx(status: number, body: unknown) {
  assert.ok(status >= 400 && status < 500, status + " " + JSON.stringify(body));
}

export const entryBody = (taskId: string | null, fromTimer = false) => ({
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  durationMs: 60_000,
  billable: true,
  hourlyRateMinor: 1000,
  description: "nueva",
  taskId,
  fromTimer,
});

export const docBody = (contactId: string | null, timeEntryId?: string) => ({
  type: "invoice",
  currency: "ARS",
  contactId,
  issueDate: "2026-10-03",
  dueDate: "2026-10-18",
  items: [{ description: "Linea nueva", quantityMilli: 1000, unitPriceMinor: 250, ...(timeEntryId ? { timeEntryId } : {}) }],
});

export const txBody = (accountId: string, extra: Record<string, unknown> = {}) => ({
  accountId,
  amountMinor: 150,
  category: "Comida",
  kind: "expense",
  occurredAt: "2026-10-03",
  ...extra,
});

#!/usr/bin/env node
// Idempotent, additive import of a Zoho Solo JSON export into Serpix (D1).
// Usage: node scripts/import-zoho-solo.mjs <export.json> <user-email> [--apply] [--db serpix-production]
// Default is a dry run that prints the SQL. Only INSERTs guarded by NOT EXISTS (owner + name/title);
// nothing is updated or deleted. The export file stays out of git.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [file, email, ...rest] = process.argv.slice(2);
if (!file || !email) { console.error("Usage: import-zoho-solo.mjs <export.json> <user-email> [--apply] [--db name]"); process.exit(2); }
const apply = rest.includes("--apply");
const db = rest.includes("--db") ? rest[rest.indexOf("--db") + 1] : "serpix-production";
const data = JSON.parse(readFileSync(file, "utf8"));

const q = (v) => v === null || v === undefined || v === "" ? "NULL" : "'" + String(v).replace(/'/g, "''") + "'";
const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const json = (out) => JSON.parse(out.slice(out.indexOf("[")));

const userRows = json(wrangler(["d1", "execute", db, "--remote", "--json", "--command", `SELECT id FROM user WHERE email=${q(email)}`]))[0].results;
if (userRows.length !== 1) { console.error("User not found; nothing written."); process.exit(1); }
const userId = userRows[0].id;

const uuid = (...parts) => { const h = createHash("sha1").update([userId, "zoho-solo", ...parts].join("|")).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = (n) => String(n).padStart(2, "0");
const parseDay = (s) => { const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s*(\d{4})?/.exec(s || ""); return m ? `${m[3] || 2026}-${p2(MONTHS[m[2].toLowerCase()])}-${p2(m[1])}` : null; };
const parseDateTime = (s) => { const m = /(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(s || ""); if (!m) return null; let h = Number(m[4]) % 12; if (/pm/i.test(m[6])) h += 12; return { day: `${m[3]}-${p2(MONTHS[m[2].toLowerCase()])}-${p2(m[1])}`, time: `${p2(h)}:${m[5]}` }; };
const ROLE = { customer: "client", partner: "partner", lead: "potential" };
// New relations model: Customer -> client confirmed, Partner -> partner confirmed, Lead/none -> no relation marked.
const RELATIONS = { customer: { client: "confirmed" }, partner: { partner: "confirmed" } };
const now = Date.now();
const sql = [];
const counts = { contacts: 0, tasks: 0, events: 0, notes: 0 };
const contactId = (name) => `(SELECT id FROM contacts WHERE user_id=${q(userId)} AND name=${q(name)} COLLATE NOCASE LIMIT 1)`;

for (const c of data.contacts || []) {
  const phone = (c.phones || []).map((p) => p.number).join(", ") || null;
  const noteLines = [c.description, c.website ? `Web: ${c.website}` : null].filter(Boolean);
  sql.push(`INSERT INTO contacts (id,user_id,kind,name,company_name,email,phone,notes,is_potential,role,relations,created_at,updated_at) SELECT ${q(uuid("contact", c.name))},${q(userId)},'person',${q(c.name)},${q(c.company)},${q(c.email)},${q(phone)},${q(noteLines.join("\n") || null)},0,${q(ROLE[(c.type || "").toLowerCase()] || "potential")},${q(JSON.stringify(RELATIONS[(c.type || "").toLowerCase()] || {}))},${now},${now} WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE user_id=${q(userId)} AND name=${q(c.name)} COLLATE NOCASE);`);
  counts.contacts++;
}
for (const t of data.tasks || []) {
  const done = /complet|done/i.test(t.status || "");
  sql.push(`INSERT INTO tasks (id,user_id,contact_id,title,status,priority,due_date,created_at,updated_at) SELECT ${q(uuid("task", t.title))},${q(userId)},${t.linked_contact ? contactId(t.linked_contact) : "NULL"},${q(t.title)},${done ? "'done'" : "'todo'"},'normal',${q(parseDay(t.due_date))},${now},${now} WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE user_id=${q(userId)} AND title=${q(t.title)} COLLATE NOCASE);`);
  counts.tasks++;
}
const activity = (kind, title, occurredAt, body, linked) => {
  const id = uuid(kind, title);
  sql.push(`INSERT INTO activities (id,user_id,kind,title,body,occurred_at,created_at,updated_at) SELECT ${q(id)},${q(userId)},${q(kind)},${q(title)},${q(body)},${q(occurredAt)},${now},${now} WHERE NOT EXISTS (SELECT 1 FROM activities WHERE user_id=${q(userId)} AND kind=${q(kind)} AND title=${q(title)} COLLATE NOCASE);`);
  if (linked) sql.push(`INSERT OR IGNORE INTO activity_contacts (activity_id,contact_id) SELECT ${q(id)}, c.id FROM contacts c WHERE c.user_id=${q(userId)} AND c.name=${q(linked)} COLLATE NOCASE AND EXISTS (SELECT 1 FROM activities WHERE id=${q(id)} AND user_id=${q(userId)});`);
};
for (const e of data.events || []) {
  const s = parseDateTime(e.start), f = parseDateTime(e.end);
  activity("event", e.title, `${s.day}T${s.time}`, f ? `Hasta las ${f.time}${f.day !== s.day ? ` (${f.day})` : ""}` : null, e.linked_contact);
  counts.events++;
}
for (const n of data.notes || []) {
  let body = n.body;
  if (n.list_preview_truncated) body = n.list_preview_truncated.replace(/…$/, "") + "… (texto cortado al importar de Zoho)";
  activity("note", n.title, `${parseDay(n.date)}T12:00`, body, n.linked_contact);
  counts.notes++;
}

const script = sql.join("\n") + "\n";
console.log(`user ${userId}; planned: ${JSON.stringify(counts)} (existing records are skipped by owner + name/title)`);
if (!apply) { console.log(script); console.log("Dry run. Re-run with --apply to write."); process.exit(0); }
const f = join(mkdtempSync(join(tmpdir(), "zoho-")), "import.sql");
writeFileSync(f, script, { mode: 0o600 });
console.log(wrangler(["d1", "execute", db, "--remote", "--file", f]).split("\n").filter((l) => /Executed|rows|changes/i.test(l)).join("\n"));

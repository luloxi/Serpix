import test from "node:test";
import assert from "node:assert/strict";
import { createRuleForTransaction, dueDates, generateDue, nextDate, occurrenceDate, parseRecurrence, todayInBuenosAires, isDateKey } from "../lib/recurring.ts";
import { account, openDb, user } from "./db-helper.mts";

test("occurrenceDate: monthly clamps to the end of short months and recovers", () => {
  assert.equal(occurrenceDate("2026-01-31", "monthly", 0), "2026-01-31");
  assert.equal(occurrenceDate("2026-01-31", "monthly", 1), "2026-02-28");
  assert.equal(occurrenceDate("2026-01-31", "monthly", 2), "2026-03-31");
  assert.equal(occurrenceDate("2028-01-31", "monthly", 1), "2028-02-29");
  assert.equal(occurrenceDate("2026-11-15", "monthly", 3), "2027-02-15");
});

test("occurrenceDate: weekly and yearly (Feb 29)", () => {
  assert.equal(occurrenceDate("2026-10-31", "weekly", 1), "2026-11-07");
  assert.equal(occurrenceDate("2026-12-28", "weekly", 1), "2027-01-04");
  assert.equal(occurrenceDate("2028-02-29", "yearly", 1), "2029-02-28");
  assert.equal(occurrenceDate("2028-02-29", "yearly", 4), "2032-02-29");
});

test("dueDates respects fromDate, generatedThrough, the end date and today", () => {
  const base = { anchorDate: "2026-01-10", frequency: "monthly" as const, endDate: null, fromDate: "2026-01-10", generatedThrough: null };
  assert.deepEqual(dueDates(base, "2026-03-09"), ["2026-01-10", "2026-02-10"]);
  assert.deepEqual(dueDates(base, "2026-03-10"), ["2026-01-10", "2026-02-10", "2026-03-10"]);
  assert.deepEqual(dueDates({ ...base, generatedThrough: "2026-02-10" }, "2026-04-30"), ["2026-03-10", "2026-04-10"]);
  assert.deepEqual(dueDates({ ...base, fromDate: "2026-03-01" }, "2026-04-30"), ["2026-03-10", "2026-04-10"]);
  assert.deepEqual(dueDates({ ...base, endDate: "2026-02-20" }, "2026-12-31"), ["2026-01-10", "2026-02-10"]);
});

test("nextDate", () => {
  const r = { anchorDate: "2026-01-31", frequency: "monthly" as const, endDate: null };
  assert.equal(nextDate(r, "2026-02-10"), "2026-02-28");
  assert.equal(nextDate(r, "2026-02-28"), "2026-03-31");
  assert.equal(nextDate(r, "2026-02-28", true), "2026-02-28");
  assert.equal(nextDate({ ...r, endDate: "2026-02-01" }, "2026-02-10"), null);
});

test("todayInBuenosAires uses UTC-3", () => {
  assert.equal(todayInBuenosAires(Date.parse("2026-10-31T02:30:00Z")), "2026-10-30");
  assert.equal(todayInBuenosAires(Date.parse("2026-10-31T03:00:00Z")), "2026-10-31");
});

test("parseRecurrence validates frequency and end date", () => {
  assert.equal(parseRecurrence("", "", "2026-01-01"), null);
  assert.equal(parseRecurrence("none", undefined, "2026-01-01"), null);
  assert.deepEqual(parseRecurrence("weekly", "", "2026-01-01"), { frequency: "weekly", endDate: null });
  assert.deepEqual(parseRecurrence("monthly", "2026-12-31", "2026-01-01"), { frequency: "monthly", endDate: "2026-12-31" });
  assert.equal(parseRecurrence("daily", "", "2026-01-01"), "Frecuencia inválida");
  assert.equal(parseRecurrence("monthly", "2026-02-30", "2026-01-01"), "Fecha de fin inválida");
  assert.equal(parseRecurrence("monthly", "2025-12-31", "2026-01-01"), "La fecha de fin es anterior al primer movimiento");
  assert.equal(isDateKey("2026-02-29"), false);
});

function setup() {
  const { db, d1 } = openDb();
  user(db, "ana");
  user(db, "bob");
  account(db, "a1", "ana");
  account(db, "b1", "bob");
  return { db, d1 };
}

async function newRule(d1: ReturnType<typeof openDb>["d1"], db: ReturnType<typeof openDb>["db"], userId: string, accountId: string, anchor: string, frequency: "weekly" | "monthly" | "yearly", endDate: string | null = null) {
  db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run("first-" + userId + anchor, userId, accountId, "expense", 5000, "Alquiler", anchor, 1);
  return createRuleForTransaction(d1, userId, "first-" + userId + anchor, { accountId, contactId: null, kind: "expense", amountMinor: 5000, category: "Alquiler", description: "Depto", anchorDate: anchor, recurrence: { frequency, endDate } }, 10);
}

const count = (db: ReturnType<typeof openDb>["db"], where = "1=1") => Number((db.prepare("SELECT COUNT(*) AS n FROM financial_transactions WHERE " + where).get() as { n: number }).n);

test("generateDue creates each period once, links the anchor, and is idempotent", async () => {
  const { db, d1 } = setup();
  const id = await newRule(d1, db, "ana", "a1", "2026-07-15", "monthly");
  assert.equal(count(db), 1);
  const first = await generateDue(d1, null, "2026-10-31", 20);
  assert.equal(first.created, 3); // Aug, Sep, Oct (July is the anchor)
  const second = await generateDue(d1, null, "2026-10-31", 21);
  assert.equal(second.created, 0);
  assert.equal(count(db, "recurring_id='" + id + "'"), 4);
  const periods = (db.prepare("SELECT recurring_period AS p, occurred_at AS o FROM financial_transactions WHERE recurring_id=? ORDER BY occurred_at").all(id) as { p: string; o: string }[]).map((r) => r.p + "=" + r.o);
  assert.deepEqual(periods, ["2026-07-15=2026-07-15", "2026-08-15=2026-08-15", "2026-09-15=2026-09-15", "2026-10-15=2026-10-15"]);
  const next = await generateDue(d1, null, "2026-11-16", 30);
  assert.equal(next.created, 1);
  assert.equal(count(db, "recurring_id='" + id + "'"), 5);
});

test("the unique index blocks a duplicate period even if the generator is bypassed (concurrent runs)", async () => {
  const { db, d1 } = setup();
  const id = await newRule(d1, db, "ana", "a1", "2026-07-15", "monthly");
  const insert = () => db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at,recurring_id,recurring_period) VALUES (?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), "ana", "a1", "expense", 1, "x", "2026-07-15", 1, id, "2026-07-15");
  assert.throws(insert, /UNIQUE/);
  // Two generator runs racing on the same rule: still one row per period.
  db.prepare("UPDATE recurring_rules SET generated_through=NULL").run();
  await Promise.all([generateDue(d1, null, "2026-09-30", 40), generateDue(d1, null, "2026-09-30", 41)]);
  assert.equal(count(db, "recurring_id='" + id + "'"), 3);
});

test("paused rules generate nothing; resume does not back-fill the pause; end stops generation", async () => {
  const { db, d1 } = setup();
  const id = await newRule(d1, db, "ana", "a1", "2026-07-15", "monthly");
  await generateDue(d1, null, "2026-08-20", 20);
  assert.equal(count(db, "recurring_id='" + id + "'"), 2);
  db.prepare("UPDATE recurring_rules SET status='paused' WHERE id=?").run(id);
  assert.equal((await generateDue(d1, null, "2026-11-20", 21)).created, 0);
  db.prepare("UPDATE recurring_rules SET status='active', from_date='2026-11-20' WHERE id=?").run(id);
  assert.equal((await generateDue(d1, null, "2026-11-20", 22)).created, 0); // Nov 15 was during the pause
  assert.equal((await generateDue(d1, null, "2026-12-16", 23)).created, 1); // Dec 15
  db.prepare("UPDATE recurring_rules SET status='ended' WHERE id=?").run(id);
  assert.equal((await generateDue(d1, null, "2027-03-01", 24)).created, 0);
});

test("end date: generates up to it, then marks the rule ended", async () => {
  const { db, d1 } = setup();
  const id = await newRule(d1, db, "ana", "a1", "2026-07-15", "monthly", "2026-09-20");
  const r = await generateDue(d1, null, "2026-12-31", 20);
  assert.equal(r.created, 2); // Aug, Sep
  const rule = db.prepare("SELECT status FROM recurring_rules WHERE id=?").get(id) as { status: string };
  assert.equal(rule.status, "ended");
});

test("weekly rule and per-user scoping", async () => {
  const { db, d1 } = setup();
  const a = await newRule(d1, db, "ana", "a1", "2026-10-01", "weekly");
  const b = await newRule(d1, db, "bob", "b1", "2026-10-01", "weekly");
  const only = await generateDue(d1, "ana", "2026-10-31", 20);
  assert.equal(only.created, 4); // Oct 8, 15, 22, 29
  assert.equal(count(db, "recurring_id='" + b + "'"), 1);
  await generateDue(d1, null, "2026-10-31", 21);
  assert.equal(count(db, "recurring_id='" + b + "'"), 5);
  assert.equal(count(db, "recurring_id='" + a + "'"), 5);
});

test("deleting a rule keeps its movements; deleting a movement does not bring it back", async () => {
  const { db, d1 } = setup();
  db.exec("PRAGMA foreign_keys = ON");
  const id = await newRule(d1, db, "ana", "a1", "2026-07-15", "monthly");
  await generateDue(d1, null, "2026-09-30", 20);
  db.prepare("DELETE FROM financial_transactions WHERE recurring_id=? AND recurring_period='2026-08-15'").run(id);
  await generateDue(d1, null, "2026-09-30", 21);
  assert.equal(count(db, "recurring_id='" + id + "'"), 2);
  db.prepare("DELETE FROM recurring_rules WHERE id=?").run(id);
  assert.equal(count(db, "recurring_id IS NULL"), 2);
});

test("one failing rule does not stop the other due rules", async () => {
  const { db, d1 } = setup();
  const first = await newRule(d1, db, "ana", "a1", "2026-07-15", "monthly");
  const middle = await newRule(d1, db, "ana", "a1", "2026-08-15", "monthly");
  const last = await newRule(d1, db, "ana", "a1", "2026-09-15", "monthly");
  const dbLike = {
    prepare(sql: string) {
      const stmt = d1.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const bound = stmt.bind(...(values as []));
          return {
            all: bound.all.bind(bound),
            first: bound.first.bind(bound),
            async run() {
              if (sql.includes("INSERT OR IGNORE INTO financial_transactions") && values.includes(middle)) {
                throw new Error("e2e_account_plaintext_write");
              }
              return bound.run();
            },
          };
        },
      };
    },
  };
  const logs: unknown[][] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    const result = await generateDue(dbLike as unknown as typeof d1, null, "2026-10-31", 20);
    assert.equal(result.failed, 1);
    assert.equal(result.rules, 3);
    assert.ok(result.created >= 2);
    assert.ok(count(db, "recurring_id='" + first + "'") > 1);
    assert.equal(count(db, "recurring_id='" + middle + "'"), 1);
    assert.ok(count(db, "recurring_id='" + last + "'") > 1);
    assert.deepEqual(logs, [["generateDue rule failed", middle]]);
  } finally {
    console.error = previous;
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ACCOUNTS_SQL, TOTALS_SQL, getFinanceTotals, updateAccount, type D1Like } from "../lib/finance.ts";

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

function openDb() {
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

function user(db: DatabaseSync, id: string) {
  db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role,approvalStatus) VALUES (?,?,?,?,?,?,?,?)").run(id, id, id + "@test.local", 1, 1, 1, "user", "approved");
}

function account(db: DatabaseSync, id: string, userId: string, name: string, currency: string, opening: number) {
  db.prepare("INSERT INTO financial_accounts (id,user_id,name,currency,opening_balance_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, userId, name, currency, opening, 1, 1);
}

const LIST_SQL = "SELECT t.amount_minor AS amountMinor, t.kind AS kind FROM financial_transactions t JOIN financial_accounts a ON a.id = t.account_id LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.user_id = ? ORDER BY t.occurred_at DESC, t.created_at DESC LIMIT 250";

test("totals sum every transaction, not a 250-row page, and ignore other users", async () => {
  assert.doesNotMatch(TOTALS_SQL, /\blimit\b/i);
  assert.doesNotMatch(ACCOUNTS_SQL, /\blimit\b/i);
  const { db, d1 } = openDb();
  user(db, "ana");
  user(db, "bob");
  account(db, "ars", "ana", "Caja ARS", "ARS", 1_000);
  account(db, "usd", "ana", "Caja USD", "USD", 500);
  account(db, "empty", "ana", "Sin movimientos", "ARS", 4_242);
  account(db, "bob-ars", "bob", "Bob", "ARS", 0);
  const insert = db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)");
  let arsIn = 0, arsOut = 0, usdIn = 0, usdOut = 0;
  db.exec("BEGIN");
  for (let i = 0; i < 600; i++) {
    const usd = i % 3 === 0;
    const income = i % 2 === 0;
    const amount = (i % 17) + 1;
    insert.run("t" + i, "ana", usd ? "usd" : "ars", income ? "income" : "expense", amount, "var", "2024-01-01", i);
    if (usd && income) usdIn += amount;
    else if (usd) usdOut += amount;
    else if (income) arsIn += amount;
    else arsOut += amount;
  }
  insert.run("bob1", "bob", "bob-ars", "income", 9_000_000, "var", "2024-06-01", 1);
  db.exec("COMMIT");

  const totals = await getFinanceTotals(d1, "ana");
  assert.equal(totals.transactionCount, 600);
  assert.deepEqual(totals.ARS, { incomeMinor: arsIn, expenseMinor: arsOut });
  assert.deepEqual(totals.USD, { incomeMinor: usdIn, expenseMinor: usdOut });
  assert.equal(arsIn + arsOut + usdIn + usdOut > 0, true);

  const page = db.prepare(LIST_SQL).all("ana") as { amountMinor: number; kind: string }[];
  const pageSum = page.reduce((sum, row) => sum + Number(row.amountMinor), 0);
  assert.equal(page.length, 250);
  assert.notEqual(pageSum, arsIn + arsOut + usdIn + usdOut);

  const bob = await getFinanceTotals(d1, "bob");
  assert.deepEqual(bob, { ARS: { incomeMinor: 9_000_000, expenseMinor: 0 }, USD: { incomeMinor: 0, expenseMinor: 0 }, transactionCount: 1 });
  const nobody = await getFinanceTotals(d1, "nadie");
  assert.deepEqual(nobody, { ARS: { incomeMinor: 0, expenseMinor: 0 }, USD: { incomeMinor: 0, expenseMinor: 0 }, transactionCount: 0 });

  const accounts = await d1.prepare(ACCOUNTS_SQL).bind("ana").all<{ id: string; openingBalanceMinor: number; balanceMinor: number }>();
  const byId = Object.fromEntries((accounts.results ?? []).map((row) => [row.id, row]));
  assert.equal(Number(byId.ars.balanceMinor), 1_000 + arsIn - arsOut);
  assert.equal(Number(byId.usd.balanceMinor), 500 + usdIn - usdOut);
  assert.equal(Number(byId.empty.balanceMinor), 4_242);
  assert.equal(Number(byId.empty.openingBalanceMinor), 4_242);
  assert.equal(byId["bob-ars"], undefined);
  db.close();
});

test("updateAccount persists opening balance, keeps it when omitted, and rejects bad input", async () => {
  const { db, d1 } = openDb();
  user(db, "ana");
  user(db, "bob");
  account(db, "caja", "ana", "Caja", "ARS", 1_000);
  db.prepare("INSERT INTO financial_transactions (id,user_id,account_id,kind,amount_minor,category,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run("in1", "ana", "caja", "income", 100, "venta", "2024-02-01", 1);

  const balanceOf = async () => {
    const rows = await d1.prepare(ACCOUNTS_SQL).bind("ana").all<{ balanceMinor: number; openingBalanceMinor: number; currency: string; name: string }>();
    return rows.results?.[0];
  };
  const rowOf = () => db.prepare("SELECT name, currency, opening_balance_minor AS opening FROM financial_accounts WHERE id='caja'").get() as { name: string; currency: string; opening: number };
  const expectRow = (name: string, currency: string, opening: number) => {
    const row = rowOf();
    assert.equal(row.name, name);
    assert.equal(row.currency, currency);
    assert.equal(Number(row.opening), opening);
  };

  let res = await updateAccount(d1, "ana", "caja", { name: "Caja nueva", openingBalanceMinor: 2_500 }, 10);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(Number((await balanceOf())?.balanceMinor), 2_600);
  assert.equal(Number((await balanceOf())?.openingBalanceMinor), 2_500);

  res = await updateAccount(d1, "ana", "caja", { name: "Solo nombre" }, 11);
  assert.equal(res.status, 200);
  expectRow("Solo nombre", "ARS", 2_500);
  assert.equal(Number((await balanceOf())?.balanceMinor), 2_600);

  res = await updateAccount(d1, "ana", "caja", { name: "Solo nombre", openingBalanceMinor: -50 }, 12);
  assert.equal(res.status, 200);
  expectRow("Solo nombre", "ARS", -50);
  assert.equal(Number((await balanceOf())?.balanceMinor), 50);

  for (const bad of [1.5, Number.NaN, "abc"]) {
    res = await updateAccount(d1, "ana", "caja", { name: "Solo nombre", openingBalanceMinor: bad }, 13);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Saldo inicial inválido" });
    expectRow("Solo nombre", "ARS", -50);
  }

  res = await updateAccount(d1, "bob", "caja", { name: "Ajena", openingBalanceMinor: 1 }, 14);
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "Cuenta inexistente" });
  expectRow("Solo nombre", "ARS", -50);

  res = await updateAccount(d1, "ana", "no-existe", { name: "Nada" }, 15);
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "Cuenta inexistente");

  res = await updateAccount(d1, "ana", "caja", { name: "   ", openingBalanceMinor: 9 }, 16);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: "El nombre es obligatorio" });
  expectRow("Solo nombre", "ARS", -50);

  res = await updateAccount(d1, "ana", "caja", { name: "Dólares", currency: "USD" }, 17);
  assert.equal(res.status, 200);
  expectRow("Dólares", "USD", -50);

  res = await updateAccount(d1, "ana", "caja", { name: "Dólares", currency: "EUR", openingBalanceMinor: 80 }, 18);
  assert.equal(res.status, 200);
  expectRow("Dólares", "USD", 80);
  assert.equal(Number((await balanceOf())?.balanceMinor), 180);
  db.close();
});

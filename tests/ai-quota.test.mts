import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_RECEIPT_SCANS_PER_DAY, AI_CUTOFF_NEURONS, AI_FREE_NEURONS_PER_DAY, INVITEE_RECEIPT_SCANS_PER_DAY, NEURONS_PER_SCAN_ESTIMATE, refundNeurons, reserveNeurons, reserveReceiptScan, utcDay } from "../lib/ai-quota.ts";
import { MAX_SCANS_PER_DAY } from "../lib/receipt.ts";
import { todayInBuenosAires } from "../lib/recurring.ts";
import { openDb } from "./db-helper.mts";

const NOW = Date.parse("2026-10-31T15:00:00.000Z");

function amount(db: DatabaseSync, day: string, scope: string, kind: string) {
  const row = db.prepare("SELECT amount FROM usage_daily WHERE day=? AND scope=? AND kind=?").get(day, scope, kind) as { amount: number } | undefined;
  return row?.amount ?? 0;
}

test("neuron reserves never pass the cutoff and a refund frees the seat", async () => {
  assert.equal(AI_FREE_NEURONS_PER_DAY, 10_000);
  assert.equal(AI_CUTOFF_NEURONS, 7_000);
  assert.equal(NEURONS_PER_SCAN_ESTIMATE, 40);
  assert.equal(ADMIN_RECEIPT_SCANS_PER_DAY, MAX_SCANS_PER_DAY);
  assert.equal(INVITEE_RECEIPT_SCANS_PER_DAY, 10);
  const { db, d1 } = openDb();
  const results = await Promise.all(Array.from({ length: 300 }, () => reserveNeurons(d1, NOW)));
  const ok = results.filter(Boolean).length;
  assert.equal(ok, Math.floor(AI_CUTOFF_NEURONS / NEURONS_PER_SCAN_ESTIMATE));
  assert.equal(amount(db, utcDay(NOW), "global", "ai_neurons"), AI_CUTOFF_NEURONS);
  assert.equal(await refundNeurons(d1, NOW), true);
  assert.equal(amount(db, utcDay(NOW), "global", "ai_neurons"), AI_CUTOFF_NEURONS - NEURONS_PER_SCAN_ESTIMATE);
  assert.equal(await reserveNeurons(d1, NOW), true);
  assert.equal(await reserveNeurons(d1, NOW), false);
  assert.equal(amount(db, utcDay(NOW), "global", "ai_neurons"), AI_CUTOFF_NEURONS);
});

test("the neuron counter resets on the UTC day and scans reset on the Buenos Aires day", async () => {
  const { db, d1 } = openDb();
  const day1 = Date.parse("2026-10-31T23:30:00.000Z");
  const day2 = Date.parse("2026-11-01T00:30:00.000Z");
  assert.equal(utcDay(day1), "2026-10-31");
  assert.equal(utcDay(day2), "2026-11-01");
  db.prepare("INSERT INTO usage_daily (day, scope, kind, amount) VALUES (?, 'global', 'ai_neurons', ?)").run(utcDay(day1), AI_CUTOFF_NEURONS);
  assert.equal(await reserveNeurons(d1, day1), false);
  assert.equal(await reserveNeurons(d1, day2), true);
  assert.equal(amount(db, utcDay(day2), "global", "ai_neurons"), NEURONS_PER_SCAN_ESTIMATE);

  const late = Date.UTC(2026, 9, 31, 2, 30);
  const next = Date.UTC(2026, 9, 31, 3, 30);
  assert.equal(todayInBuenosAires(late), "2026-10-30");
  assert.equal(todayInBuenosAires(next), "2026-10-31");
  for (let i = 0; i < INVITEE_RECEIPT_SCANS_PER_DAY; i++) assert.equal(await reserveReceiptScan(d1, "ana", late, INVITEE_RECEIPT_SCANS_PER_DAY), true);
  assert.equal(await reserveReceiptScan(d1, "ana", late, INVITEE_RECEIPT_SCANS_PER_DAY), false);
  assert.equal(await reserveReceiptScan(d1, "bob", late, INVITEE_RECEIPT_SCANS_PER_DAY), true);
  assert.equal(await reserveReceiptScan(d1, "ana", next, INVITEE_RECEIPT_SCANS_PER_DAY), true);
  for (let i = 0; i < ADMIN_RECEIPT_SCANS_PER_DAY; i++) assert.equal(await reserveReceiptScan(d1, "admin", next, ADMIN_RECEIPT_SCANS_PER_DAY), true);
  assert.equal(await reserveReceiptScan(d1, "admin", next, ADMIN_RECEIPT_SCANS_PER_DAY), false);
});

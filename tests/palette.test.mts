import test from "node:test";
import assert from "node:assert/strict";
import { toneForMonth, toneForDate, toneClass, toneForIndex, TONES } from "../lib/palette.ts";
import { addDays, dayChip, monthLabel, shortDate, todayBA } from "../lib/agenda-dates.ts";

test("a month always has the same tone, year-independent, and all tones are used", () => {
  assert.equal(toneForDate("2026-10-30"), toneForDate("2031-10-01"));
  assert.equal(toneForMonth(9), toneForDate("2026-10-05"));
  assert.equal(new Set(Array.from({ length: 12 }, (_, i) => toneForMonth(i))).size, TONES.length);
  assert.equal(toneClass("2026-10-30"), "tone-" + toneForMonth(9));
  assert.equal(toneForDate("sin fecha"), "pink");
  assert.equal(toneForMonth(-1), toneForMonth(11));
});

test("toneForIndex rotates the logo tones and wraps negatives", () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, i) => toneForIndex(i)),
    ["pink", "cyan", "yellow", "violet", "pink", "cyan", "yellow", "violet"],
  );
  assert.equal(toneForIndex(0), TONES[0]);
  assert.equal(toneForIndex(3), "violet");
  assert.equal(toneForIndex(4), "pink");
  assert.equal(toneForIndex(-1), "violet");
  assert.equal(toneForIndex(-2), "yellow");
  assert.equal(toneForIndex(-4), "pink");
  assert.equal(toneForIndex(-5), "violet");
  assert.equal(toneForIndex(1.9), "cyan");
});

test("agenda dates: Buenos Aires today, month once, day chips without the month", () => {
  assert.equal(todayBA(new Date("2026-10-31T02:30:00Z")), "2026-10-30"); // 23:30 in Buenos Aires
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(monthLabel("2026-10-30", "2026-10-30"), "Octubre");
  assert.equal(monthLabel("2027-01-05", "2026-10-30"), "Enero 2027");
  assert.equal(dayChip("2026-10-30", "2026-10-30"), "Hoy · Vie 30");
  assert.equal(dayChip("2026-10-31", "2026-10-30"), "Mañana · Sáb 31");
  assert.equal(dayChip("2026-11-03", "2026-10-30"), "Mar 3");
  assert.equal(shortDate("2026-10-28"), "28 oct");
});

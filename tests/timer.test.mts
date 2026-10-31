import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DURATION_MS, MAX_HOURLY_RATE_MINOR, MIN_DURATION_MS, NUDGE_MS, ROUND_STEP_MS,
  adjustedNow, applyEndInput, applyStartInput, clockSkew, elapsedMs, entryAmountMinor,
  epochToLocalInput, formatHM, formatHMS, formatTracked, initialEntryWindow, localInputToEpoch,
  nudgeEnd, parseTimeEntryBody, parseTimerState, pauseTimer, resumeTimer, roundUpDuration, roundUpEnd, startTimer,
} from "../lib/timer.ts";

test("pause and resume fold segments from timestamps and elapsed never goes negative", () => {
  const t0 = 1_000_000;
  let timer = startTimer(t0);
  assert.deepEqual(timer, { startedAt: t0, segmentStart: t0, accumulatedMs: 0 });
  assert.equal(elapsedMs(timer, t0 + 5_000), 5_000);

  timer = pauseTimer(timer, t0 + 10_000);
  assert.equal(timer.segmentStart, null);
  assert.equal(timer.accumulatedMs, 10_000);
  assert.equal(elapsedMs(timer, t0 + 99_000), 10_000);

  const pausedAgain = pauseTimer(timer, t0 + 50_000);
  assert.equal(pausedAgain, timer);
  assert.equal(pausedAgain.accumulatedMs, 10_000);

  timer = resumeTimer(timer, t0 + 20_000);
  assert.equal(timer.segmentStart, t0 + 20_000);
  assert.equal(timer.accumulatedMs, 10_000);
  assert.equal(elapsedMs(timer, t0 + 25_000), 15_000);

  const resumedAgain = resumeTimer(timer, t0 + 30_000);
  assert.equal(resumedAgain, timer);
  assert.equal(resumedAgain.segmentStart, t0 + 20_000);

  // Second segment keeps what was already accumulated.
  const second = pauseTimer({ startedAt: 0, segmentStart: 1_000, accumulatedMs: 5_000 }, 1_500);
  assert.equal(second.accumulatedMs, 5_500);
  assert.equal(second.segmentStart, null);
  const resumed = resumeTimer(second, 9_000);
  assert.equal(elapsedMs(resumed, 9_500), 6_000);

  // Clock behind the segment, or a negative accumulated value, still displays 0.
  assert.equal(elapsedMs({ accumulatedMs: 10, segmentStart: 1_000_000 }, 0), 0);
  assert.equal(elapsedMs({ accumulatedMs: -1, segmentStart: null }, 5), 0);
  assert.equal(elapsedMs(timer, t0), 0);
  const clamped = pauseTimer({ startedAt: 0, segmentStart: 5_000, accumulatedMs: 100 }, 0);
  assert.equal(clamped.accumulatedMs, 0);
  assert.equal(clamped.segmentStart, null);
  assert.equal(elapsedMs(clamped, 0), 0);
});

test("clock skew uses serverNow so a fast client clock does not inflate elapsed", () => {
  const serverNow = 10_000;
  const clientNow = 10_400;
  const skew = clockSkew(serverNow, clientNow);
  assert.equal(skew, -400);
  const timer = startTimer(serverNow - 2_500);
  assert.equal(elapsedMs(timer, adjustedNow(clientNow, skew)), 2_500);
});

test("round up to 15 minutes, including exact boundaries, and ±5 min never drops under 1 minute", () => {
  assert.equal(roundUpDuration(MIN_DURATION_MS), ROUND_STEP_MS);
  assert.equal(roundUpDuration(14 * MIN_DURATION_MS), ROUND_STEP_MS);
  assert.equal(roundUpDuration(ROUND_STEP_MS - 1), ROUND_STEP_MS);
  assert.equal(roundUpDuration(ROUND_STEP_MS), ROUND_STEP_MS);
  assert.equal(roundUpDuration(ROUND_STEP_MS + 1), 2 * ROUND_STEP_MS);
  assert.equal(roundUpDuration(16 * MIN_DURATION_MS), 2 * ROUND_STEP_MS);
  assert.equal(roundUpDuration(31 * MIN_DURATION_MS), 3 * ROUND_STEP_MS);
  assert.equal(roundUpDuration(0), ROUND_STEP_MS);
  assert.equal(roundUpDuration(MAX_DURATION_MS), MAX_DURATION_MS);
  assert.equal(roundUpDuration(MAX_DURATION_MS - 1), MAX_DURATION_MS);
  assert.equal(roundUpDuration(MAX_DURATION_MS + NUDGE_MS), MAX_DURATION_MS);

  const start = 5_000_000;
  assert.equal(nudgeEnd(start, start + 10 * MIN_DURATION_MS, -NUDGE_MS), start + 5 * MIN_DURATION_MS);
  assert.equal(nudgeEnd(start, start + 3 * MIN_DURATION_MS, -NUDGE_MS), start + MIN_DURATION_MS);
  assert.equal(nudgeEnd(start, start + MIN_DURATION_MS, -NUDGE_MS), start + MIN_DURATION_MS);
  assert.equal(nudgeEnd(start, start + 10 * MIN_DURATION_MS, NUDGE_MS), start + 15 * MIN_DURATION_MS);
  assert.equal(nudgeEnd(start, start + MAX_DURATION_MS, NUDGE_MS), start + MAX_DURATION_MS);
  assert.equal(roundUpEnd(start, start + 7 * MIN_DURATION_MS) - start, ROUND_STEP_MS);
  assert.equal(roundUpEnd(start, start + ROUND_STEP_MS) - start, ROUND_STEP_MS);

  const window = initialEntryWindow(start, 30_000);
  assert.equal(window.durationMs, MIN_DURATION_MS);
  assert.equal(window.endedAt, start + MIN_DURATION_MS);
  assert.equal(initialEntryWindow(start, 90_000).durationMs, MIN_DURATION_MS);
  assert.equal(initialEntryWindow(start, 120_000).durationMs, 120_000);
  assert.equal(initialEntryWindow(start, 0).durationMs, MIN_DURATION_MS);
  assert.equal(initialEntryWindow(start, MAX_DURATION_MS + NUDGE_MS).durationMs, MAX_DURATION_MS);
});

test("amount is rounded half-up from duration hours × rate, and zero when not billable", () => {
  assert.equal(entryAmountMinor(3_600_000, 150_000, true), 150_000);
  assert.equal(entryAmountMinor(1_800_000, 10_000, true), 5_000);
  assert.equal(entryAmountMinor(60_000, 100, true), 2);
  assert.equal(entryAmountMinor(90 * 60_000, 1, true), 2);
  assert.equal(entryAmountMinor(120_000, 10_000, true), 333);
  assert.equal(entryAmountMinor(3_600_000, 10_000, false), 0);
  assert.equal(entryAmountMinor(3_600_000, 0, true), 0);
});

test("HH:MM:SS, HH:MM and tracked labels", () => {
  assert.equal(formatHMS(0), "00:00:00");
  assert.equal(formatHMS(1_000), "00:00:01");
  assert.equal(formatHMS(61_000), "00:01:01");
  assert.equal(formatHMS(3_661_000), "01:01:01");
  assert.equal(formatHMS(-5), "00:00:00");
  assert.equal(formatHMS(100 * 3_600_000), "100:00:00");
  assert.equal(formatHM(0), "00:00");
  assert.equal(formatHM(60_000), "00:01");
  assert.equal(formatHM(59_999), "00:00");
  assert.equal(formatHM(80 * 60_000), "01:20");
  assert.equal(formatTracked(80 * 60_000), "1h 20m");
  assert.equal(formatTracked(20 * 60_000), "20m");
  assert.equal(formatTracked(2 * 3_600_000), "2h");
  assert.equal(formatTracked(0), "0m");
  assert.equal(formatTracked(-1_000), "0m");
  assert.equal(formatTracked(59_999), "0m");
});

test("datetime-local converts to and from America/Buenos_Aires", () => {
  const utc = Date.parse("2026-10-31T02:30:00.000Z");
  assert.equal(epochToLocalInput(utc), "2026-10-30T23:30");
  assert.equal(localInputToEpoch("2026-10-30T23:30"), utc);
  assert.equal(epochToLocalInput(Date.parse("2026-10-31T12:05:00.000Z")), "2026-10-31T09:05");
  assert.equal(localInputToEpoch("2026-01-01T00:00"), Date.parse("2026-01-01T03:00:00.000Z"));
  assert.equal(epochToLocalInput(localInputToEpoch("2026-01-01T00:00")!), "2026-01-01T00:00");
  assert.equal(epochToLocalInput(localInputToEpoch("2026-06-15T12:00")!), "2026-06-15T12:00");
  assert.equal(epochToLocalInput(localInputToEpoch("2028-02-29T23:59")!), "2028-02-29T23:59");
  assert.equal(localInputToEpoch("2026-02-31T10:00"), null);
  assert.equal(localInputToEpoch("2026-02-29T10:00"), null);
  assert.equal(localInputToEpoch("2026-13-01T00:00"), null);
  assert.equal(localInputToEpoch("2026-00-10T00:00"), null);
  assert.equal(localInputToEpoch("2026-10-30T24:00"), null);
  assert.equal(localInputToEpoch("2026-10-30"), null);
  assert.equal(localInputToEpoch("2026-10-30T23:30:00"), null);
  assert.equal(epochToLocalInput(Number.NaN), "");

  const start = localInputToEpoch("2026-10-30T10:00")!;
  const end = localInputToEpoch("2026-10-30T11:00")!;
  const moved = applyStartInput(end, "2026-10-30T10:30");
  assert.equal(moved?.startedAt, localInputToEpoch("2026-10-30T10:30"));
  assert.equal(moved?.endedAt, end);
  const clampedStart = applyStartInput(end, "2026-10-30T12:00");
  assert.equal(clampedStart!.endedAt - clampedStart!.startedAt, MIN_DURATION_MS);
  assert.equal(applyStartInput(end, "nope"), null);
  assert.equal(applyEndInput(start, "2026-10-30T10:00")! - start, MIN_DURATION_MS);
  assert.equal(applyEndInput(start, "2026-10-30T12:00"), localInputToEpoch("2026-10-30T12:00"));
  assert.equal(applyEndInput(start, "bogus"), null);
});

test("time entry body validation accepts a clean payload and rejects the rest", () => {
  const good = parseTimeEntryBody({
    startedAt: 1_000, endedAt: 121_000, durationMs: 120_000, billable: true, hourlyRateMinor: 10_000,
    description: "  hola  ", taskId: "  task-1  ", fromTimer: true,
  });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value.description, "hola");
    assert.equal(good.value.taskId, "task-1");
    assert.equal(good.value.fromTimer, true);
    assert.equal(good.value.billable, true);
    assert.equal(entryAmountMinor(good.value.durationMs, good.value.hourlyRateMinor, good.value.billable), 333);
  }

  const minimal = parseTimeEntryBody({ startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 0 });
  assert.equal(minimal.ok, true);
  if (minimal.ok) {
    assert.equal(minimal.value.taskId, null);
    assert.equal(minimal.value.description, null);
    assert.equal(minimal.value.fromTimer, false);
  }

  const maxOk = parseTimeEntryBody({ startedAt: 0, endedAt: MAX_DURATION_MS, durationMs: MAX_DURATION_MS, billable: true, hourlyRateMinor: MAX_HOURLY_RATE_MINOR, description: "a".repeat(2000) });
  assert.equal(maxOk.ok, true);

  const rejects: unknown[] = [
    null,
    [],
    "nope",
    { endedAt: 120_000, durationMs: 120_000, billable: true, hourlyRateMinor: 0 },
    { startedAt: 10, endedAt: 10, durationMs: MIN_DURATION_MS, billable: true, hourlyRateMinor: 0 },
    { startedAt: 20, endedAt: 10, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 0 },
    { startedAt: 0, endedAt: 1, durationMs: MIN_DURATION_MS - 1, billable: false, hourlyRateMinor: 0 },
    { startedAt: 0, endedAt: 1, durationMs: MAX_DURATION_MS + 1, billable: false, hourlyRateMinor: 0 },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: -1 },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: MAX_HOURLY_RATE_MINOR + 1 },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 1.5 },
    { startedAt: "0", endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 0 },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: 1, hourlyRateMinor: 0 },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 0, description: "x".repeat(2001) },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 0, description: 12 },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 0, taskId: 12 },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 0, taskId: "x".repeat(81) },
    { startedAt: 0, endedAt: MIN_DURATION_MS, durationMs: MIN_DURATION_MS, billable: false, hourlyRateMinor: 0, fromTimer: "yes" },
  ];
  for (const body of rejects) {
    const parsed = parseTimeEntryBody(body);
    assert.equal(parsed.ok, false, JSON.stringify(body));
  }

  assert.equal(parseTimerState(null), null);
  assert.deepEqual(parseTimerState({ startedAt: 1, segmentStart: null, accumulatedMs: 0 }), { startedAt: 1, segmentStart: null, accumulatedMs: 0 });
  assert.deepEqual(parseTimerState({ startedAt: 1, segmentStart: 2, accumulatedMs: 3 }), { startedAt: 1, segmentStart: 2, accumulatedMs: 3 });
  assert.equal(parseTimerState({ startedAt: 1.5, segmentStart: null, accumulatedMs: 0 }), null);
  assert.equal(parseTimerState({ startedAt: 1, segmentStart: null, accumulatedMs: -1 }), null);
  assert.equal(parseTimerState({ startedAt: 1, segmentStart: "2", accumulatedMs: 0 }), null);
});

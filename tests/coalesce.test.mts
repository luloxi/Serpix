import test from "node:test";
import assert from "node:assert/strict";
import { createCoalescedLoader } from "../lib/coalesce.ts";

test("a second call during an in-flight run triggers exactly one follow-up and resolves after it", async () => {
  const seen: boolean[] = [];
  const ends: string[] = [];
  let release: () => void = () => {};
  const load = createCoalescedLoader(async (silent) => {
    const n = seen.length + 1;
    seen.push(silent);
    await new Promise<void>((resolve) => { release = resolve; });
    ends.push("end" + n);
  });
  const first = load(false);
  const second = load(true);
  assert.equal(seen.length, 1);
  release();
  await first;
  assert.deepEqual(ends, ["end1"]);
  assert.deepEqual(seen, [false, true]);
  let secondDone = false;
  const tracked = second.then(() => { secondDone = true; ends.push("second"); });
  await Promise.resolve();
  assert.equal(secondDone, false);
  release();
  await tracked;
  assert.deepEqual(ends, ["end1", "end2", "second"]);
});

test("three calls during a run still queue only one follow-up", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const load = createCoalescedLoader(async () => {
    calls += 1;
    await new Promise<void>((resolve) => { release = resolve; });
  });
  const first = load();
  const rest = [load(), load(), load()];
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(calls, 2);
  release();
  await Promise.all(rest);
  assert.equal(calls, 2);
});

test("a non-silent request wins over silent ones queued behind the same run", async () => {
  const seen: boolean[] = [];
  let release: () => void = () => {};
  const load = createCoalescedLoader(async (silent) => {
    seen.push(silent);
    await new Promise<void>((resolve) => { release = resolve; });
  });
  const first = load(true);
  const silent = load(true);
  const loud = load(false);
  const silentAgain = load(true);
  release();
  await first;
  assert.deepEqual(seen, [true, false]);
  release();
  await Promise.all([silent, loud, silentAgain]);
  assert.deepEqual(seen, [true, false]);

  seen.length = 0;
  const again = load(true);
  const loudFirst = load(false);
  const silentLater = load(true);
  release();
  await again;
  assert.deepEqual(seen, [true, false]);
  release();
  await Promise.all([loudFirst, silentLater]);
});

test("the loader recovers after fn throws, including a queued follow-up", async () => {
  let n = 0;
  const load = createCoalescedLoader(async () => {
    n += 1;
    if (n < 3) throw new Error("boom");
  });
  const first = load();
  const second = load();
  await assert.rejects(first, /boom/);
  await assert.rejects(second, /boom/);
  await load();
  assert.equal(n, 3);

  let calls = 0;
  const sync = createCoalescedLoader(() => {
    calls += 1;
    throw new Error("sync");
  });
  await assert.rejects(sync(), /sync/);
  await assert.rejects(sync(), /sync/);
  assert.equal(calls, 2);
});

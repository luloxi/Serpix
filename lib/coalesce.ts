type Pending = { silent: boolean; promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void };

// One in-flight run, plus at most one queued follow-up. Non-silent wins.
// A thrown fn rejects that run's callers and never leaves the loader stuck.
export function createCoalescedLoader(fn: (silent: boolean) => Promise<void>): (silent?: boolean) => Promise<void> {
  let busy = false;
  let pending: Pending | null = null;

  const start = (silent: boolean): Promise<void> => {
    busy = true;
    let job: Promise<void>;
    try { job = Promise.resolve(fn(silent)); }
    catch (error) { job = Promise.reject(error); }
    const settled = job.then(() => undefined);
    const finished = settled.finally(() => {
      busy = false;
      const next = pending;
      pending = null;
      if (!next) return;
      start(next.silent).then(next.resolve, next.reject);
    });
    finished.catch(() => {});
    return settled;
  };

  return (silent = false) => {
    if (!busy) return start(silent);
    if (!pending) {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      pending = { silent, promise, resolve, reject };
    } else if (!silent) pending.silent = false;
    return pending.promise;
  };
}

// Times Argon2id at the two setup sizes. Run with Node. This box is usually faster
// than a mid-range phone; the real safeguard is the >2s downgrade inside createPasswordWrap.
import os from "node:os";
import { benchmarkArgon2 } from "../lib/crypto/password.ts";

const round = (ms) => Math.round(ms * 10) / 10;
const bench = await benchmarkArgon2();
const cpus = os.cpus();
const report = {
  arch: process.arch,
  cpuModel: cpus[0]?.model ?? "unknown",
  cores: cpus.length,
  rows: bench.rows.map((row) => ({
    m: row.m,
    t: row.t,
    p: row.p,
    medianMs: round(row.medianMs),
    minMs: round(row.minMs),
    maxMs: round(row.maxMs),
    samplesMs: row.samplesMs.map(round),
  })),
};

for (const row of report.rows) {
  console.log(
    `argon2id m=${row.m} t=${row.t} p=${row.p} n=${row.samplesMs.length} median=${row.medianMs}ms min=${row.minMs}ms max=${row.maxMs}ms`,
  );
}
console.log(`arch=${report.arch} cores=${report.cores} cpu=${report.cpuModel}`);
console.log(JSON.stringify(report));

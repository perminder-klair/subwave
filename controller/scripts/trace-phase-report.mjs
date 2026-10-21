#!/usr/bin/env node
// Summarise the `trace.phase` events timePhase() writes (#1723): for each pick
// preparation step, how long it held the thread (syncMs, an event-loop stall)
// and how long it took in total (ms), plus the stall per pick.
//
//   node scripts/trace-phase-report.mjs            # today's and yesterday's logs
//   node scripts/trace-phase-report.mjs --days 3   # the last 3 days
//
// Streams the event logs line by line (they reach hundreds of MB a day), so it
// is safe to run inside the live controller container. Read-only.

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const args = process.argv.slice(2);
const days = Math.max(1, Number(args[args.indexOf('--days') + 1]) || 2);
const stateDir = process.env.STATE_DIR || '/var/sub-wave';

// Event logs live at <STATE_DIR>/logs, or under stations/<id>/logs.
const dirs = [join(stateDir, 'logs')];
const stationsDir = join(stateDir, 'stations');
for (const d of existsSync(stationsDir) ? readdirSync(stationsDir, { withFileTypes: true }) : []) {
  if (d.isDirectory()) dirs.push(join(stationsDir, d.name, 'logs'));
}
const wanted = new Set(
  Array.from({ length: days }, (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)),
);
const files = dirs.flatMap((dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.test(f) && wanted.has(f.slice(7, 17)))
        .map((f) => join(dir, f))
    : [],
);
if (!files.length) {
  console.log(`no event logs for the last ${days} day(s) under ${dirs.join(', ')}`);
  process.exit(0);
}

const byPhase = new Map();
const perPick = new Map();
for (const file of files) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"trace.phase"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'trace.phase' || typeof e.phase !== 'string') continue;
    const sync = Number(e.syncMs) || 0;
    const total = Number(e.ms) || 0;
    if (!byPhase.has(e.phase)) byPhase.set(e.phase, []);
    byPhase.get(e.phase).push([sync, total]);
    if (e.traceId && (e.phase.startsWith('pick.') || e.phase.startsWith('djAgentPick.'))) {
      perPick.set(e.traceId, (perPick.get(e.traceId) ?? 0) + sync);
    }
  }
}

const q = (xs, f) => {
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * f))] ?? 0;
};
console.log(`files: ${files.length} (${[...wanted].sort().join(', ')})`);
console.log(`${'phase'.padEnd(26)} ${'n'.padStart(6)} ${'sync p50'.padStart(9)} ${'p95'.padStart(7)} ${'max'.padStart(7)} ${'total p95'.padStart(10)}  (ms)`);
const rows = [...byPhase.entries()].sort((a, b) => q(b[1].map((x) => x[0]), 0.95) - q(a[1].map((x) => x[0]), 0.95));
for (const [phase, v] of rows) {
  const s = v.map((x) => x[0]);
  const t = v.map((x) => x[1]);
  console.log(
    `${phase.padEnd(26)} ${String(v.length).padStart(6)} ${String(q(s, 0.5)).padStart(9)} ${String(q(s, 0.95)).padStart(7)} ` +
      `${String(Math.max(...s)).padStart(7)} ${String(q(t, 0.95)).padStart(10)}`,
  );
}
const picks = [...perPick.values()];
if (picks.length) {
  console.log(
    `\npicks: ${picks.length} — thread blocked per pick (sum of preparation syncMs): ` +
      `p50 ${q(picks, 0.5)} ms, p95 ${q(picks, 0.95)} ms, max ${Math.max(...picks)} ms`,
  );
}

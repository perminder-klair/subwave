// Pins broadcast/tagger-run-log.ts — the per-run seq'd log that the admin
// Library page polls. Each case targets a contract that the old "last 100
// lines in an array" approach silently violated.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  RunLog,
  RUN_LOG_CAP,
  RUN_LOG_HOLD_MS,
  RUN_LOG_KEEP,
  RUN_LOG_DIR_NAME,
  runLogId,
  isRunLogId,
  parseRunLogId,
  openRunLog,
  openRunLogSink,
  listRunLogs,
  runLogPath,
  pruneRunLogs,
} from '../src/broadcast/tagger-run-log.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

let t = 1_000_000;
const now = () => t;

function makeSink() {
  return { lines: [] as string[], closedCount: 0, write(s: string) { this.lines.push(s); }, close() { this.closedCount++; } };
}

// A dir for each file test, removed however the test ends.
async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = createTempDir(path.join(os.tmpdir(), 'tagger-run-log-'));
  try {
    await fn(dir);
  } finally {
    await removeTempDir(dir);
  }
}

test('seq starts at 1 and is contiguous; since(0) returns everything', () => {
  t = 1_000_000;
  const log = new RunLog({ runId: 'r1', now });
  log.event({ kind: 'info', text: 'a', at: '2026-10-21T05:00:00.000Z' }, () => false);
  log.event({ kind: 'info', text: 'b', at: '2026-10-21T05:00:01.000Z' }, () => false);

  const p = log.since(0);
  assert.equal(p.entries.length, 2);
  assert.equal(p.entries[0].seq, 1);
  assert.equal(p.entries[1].seq, 2);
  assert.equal(p.nextSeq, 2);

  // Asking for "after nextSeq" returns nothing.
  const p2 = log.since(p.nextSeq);
  assert.equal(p2.entries.length, 0);
  assert.equal(p2.nextSeq, 2);
  assert.equal(p2.closed, false, 'an open run is still printing');
});

test('a raw line is held until holdMs elapses', () => {
  t = 1_000_000;
  const log = new RunLog({ runId: 'r2', now });
  log.raw('a');
  // Not yet committed—since(0) sees nothing.
  const p1 = log.since(0);
  assert.equal(p1.entries.length, 0);
  assert.equal(p1.nextSeq, 0);

  t += RUN_LOG_HOLD_MS;
  const p2 = log.since(0);
  assert.equal(p2.entries.length, 1);
  assert.equal(p2.entries[0].line, 'a');
  assert.equal(p2.entries[0].seq, 1);
});

test('a second raw commits the first without waiting for holdMs', () => {
  t = 1_000_000;
  const log = new RunLog({ runId: 'r3', now });
  log.raw('a');
  log.raw('b');
  const p = log.since(0);
  // 'a' committed (seq 1); 'b' still pending.
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].line, 'a');
  assert.equal(p.entries[0].seq, 1);
});

test('event echo suppresses the preceding raw line', () => {
  t = 1_000_000;
  const sink = makeSink();
  const log = new RunLog({ runId: 'r4', now, sink });
  log.raw('[tag] Tagged 3 tracks');
  log.event(
    { kind: 'success', text: 'Tagged 3 tracks', at: '2026-10-21T05:27:41.000Z' },
    r => r.replace(/^\[tag\]\s*/, '') === 'Tagged 3 tracks',
  );
  const p = log.since(0);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].seq, 1);
  assert.deepEqual(p.entries[0].line, { kind: 'success', text: 'Tagged 3 tracks', at: '2026-10-21T05:27:41.000Z' });
  assert.equal(sink.lines.length, 1);
  assert.equal(sink.lines[0], '05:27:41  [success] Tagged 3 tracks\n');
});

test('non-echo raw is committed before the event', () => {
  t = 1_000_000;
  const log = new RunLog({ runId: 'r5', now });
  log.raw('x');
  log.event({ kind: 'info', text: 'y', at: '2026-10-21T05:00:00.000Z' }, () => false);
  const p = log.since(0);
  assert.equal(p.entries.length, 2);
  assert.equal(p.entries[0].line, 'x');
  assert.equal(p.entries[0].seq, 1);
  assert.deepEqual(p.entries[1].line, { kind: 'info', text: 'y', at: '2026-10-21T05:00:00.000Z' });
  assert.equal(p.entries[1].seq, 2);
});

test('cap evicts oldest entries and reports gap correctly', () => {
  t = 1_000_000;
  const log = new RunLog({ runId: 'r6', cap: 3, now });
  for (let i = 1; i <= 5; i++) {
    log.event({ kind: 'info', text: String(i), at: `2026-10-21T05:00:0${i}.000Z` }, () => false);
  }
  // Memory holds seqs 3,4,5.
  const p0 = log.since(0);
  assert.deepEqual(p0.entries.map(e => e.seq), [3, 4, 5]);
  assert.equal(p0.gap, true); // asked for seq > 0 but 1,2 evicted

  const p2 = log.since(2);
  assert.deepEqual(p2.entries.map(e => e.seq), [3, 4, 5]);
  assert.equal(p2.gap, false); // 2 >= firstSeq(3)-1 = 2

  const p4 = log.since(4);
  assert.deepEqual(p4.entries.map(e => e.seq), [5]);
  assert.equal(p4.gap, false);
});

test('since() sanitises NaN, negative, Infinity, and fractional cursors', () => {
  t = 1_000_000;
  const log = new RunLog({ runId: 'r7', now });
  log.event({ kind: 'info', text: 'a', at: '2026-10-21T05:00:00.000Z' }, () => false);
  log.event({ kind: 'info', text: 'b', at: '2026-10-21T05:00:01.000Z' }, () => false);

  // NaN, -5, Infinity, Number('x') → treated as 0 → return all.
  for (const bad of [NaN, -5, Infinity, Number('x')]) {
    const p = log.since(bad);
    assert.equal(p.entries.length, 2, `after=${bad}`);
  }

  // 1.7 floors to 1 → return seq 2 only.
  const p = log.since(1.7);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].seq, 2);
});

test('mutating a returned entry does not alter the log', () => {
  t = 1_000_000;
  const log = new RunLog({ runId: 'r8', now });
  log.event({ kind: 'info', text: 'original', at: '2026-10-21T05:00:00.000Z' }, () => false);

  const p1 = log.since(0);
  (p1.entries[0].line as unknown as { text: string }).text = 'MUTATED';

  const p2 = log.since(0);
  assert.equal((p2.entries[0].line as unknown as { text: string }).text, 'original');
});

test('close() flushes pending, calls sink.close once, ignores subsequent writes', () => {
  t = 1_000_000;
  const sink = makeSink();
  const log = new RunLog({ runId: 'r9', now, sink });
  log.raw('pending');
  log.close();

  // Pending was committed, and the page says the run's output is all in.
  const p = log.since(0);
  assert.equal(p.entries.length, 1);
  assert.equal(p.entries[0].line, 'pending');
  assert.equal(p.closed, true);
  assert.equal(sink.closedCount, 1);

  // Writes after close are silently ignored.
  log.raw('ignored');
  log.event({ kind: 'info', text: 'ignored', at: '2026-10-21T05:00:00.000Z' }, () => false);
  assert.equal(log.since(0).entries.length, 1);

  // Second close is a no-op.
  log.close();
  assert.equal(sink.closedCount, 1);

  // since still works after close.
  assert.equal(log.since(0).entries.length, 1);
});

test('a sink that throws on write does not crash the run', () => {
  t = 1_000_000;
  let writeCount = 0;
  let closeCount = 0;
  const badSink: { write(text: string): void; close(): void } = {
    write(_text: string): void {
      writeCount++;
      if (writeCount === 2) throw new Error('disk full');
    },
    close() { closeCount++; },
  };
  const log = new RunLog({ runId: 'r10', now, sink: badSink });
  log.event({ kind: 'info', text: 'one', at: '2026-10-21T05:00:00.000Z' }, () => false); // write 1 ok
  log.event({ kind: 'info', text: 'two', at: '2026-10-21T05:00:01.000Z' }, () => false); // write 2 throws
  log.event({ kind: 'info', text: 'three', at: '2026-10-21T05:00:02.000Z' }, () => false); // sink is null now

  // All entries remain in memory.
  const p = log.since(0);
  assert.equal(p.entries.length, 3);
  assert.equal(writeCount, 2); // not called a 3rd time
  assert.equal(closeCount, 1, 'the failed file is closed straight away, not held open for the run');

  // close() must not call write again, nor close the dropped file twice.
  log.close();
  assert.equal(writeCount, 2);
  assert.equal(closeCount, 1);
});

test('sink line format: HH:MM:SS prefix and newlines collapsed', () => {
  t = Date.parse('2026-10-21T05:27:41Z');
  const sink = makeSink();
  const log = new RunLog({ runId: 'r11', now, sink });
  log.raw('hello');
  // Force commit via second raw.
  log.raw('line1\nline2');
  log.close();

  assert.equal(sink.lines[0], '05:27:41  hello\n');
  assert.equal(sink.lines[1], '05:27:41  line1 line2\n');
});

test('a held line keeps its arrival time in the file, however late it is committed', () => {
  t = Date.parse('2026-10-21T10:00:00Z');
  const sink = makeSink();
  const log = new RunLog({ runId: 'r11b', now, sink });
  log.raw('[tag] batch 3: asking the model');
  t += 5 * 60_000; // a slow model call, and no page polling
  log.raw('[tag] batch 3: model answered');
  t += 1_000;
  log.close();
  assert.deepEqual(sink.lines, [
    '10:00:00  [tag] batch 3: asking the model\n',
    '10:05:00  [tag] batch 3: model answered\n',
  ]);
});

test('runLogId / isRunLogId / parseRunLogId contract', () => {
  const d = new Date('2026-10-21T05:27:41.123Z');
  assert.equal(runLogId(d, 'analyze'), 'tagger-run-20261021-052741-analyze');
  assert.equal(runLogId(d, 'tag'), 'tagger-run-20261021-052741-tag');
  assert.equal(runLogId(d, 'reconcile'), 'tagger-run-20261021-052741-reconcile');
  assert.equal(runLogId(d, 'tag', 2), 'tagger-run-20261021-052741-tag-2');
  assert.throws(() => runLogId(d, 'other' as never), /unknown run mode/);

  // isRunLogId
  assert.equal(isRunLogId('tagger-run-20261021-052741-analyze'), true);
  assert.equal(isRunLogId('../x'), false);
  assert.equal(isRunLogId('tagger-run-20261021-052741-analyze.log'), false);
  assert.equal(isRunLogId('tagger-run-20261021-052741-other'), false);
  assert.equal(isRunLogId(42), false);
  assert.equal(isRunLogId(null), false);
  assert.equal(isRunLogId('tagger-run-20261021-052741-analyze/../../etc'), false);
  assert.equal(isRunLogId('tagger-run-20261021-052741-analyze-2'), true);
  assert.equal(isRunLogId('tagger-run-20261021-052741-analyze-x'), false);
  assert.equal(isRunLogId('tagger-run-20261021-052741-analyze-100'), false);
  assert.equal(isRunLogId('tagger-run-20261021-052741-2-analyze'), false);

  // parseRunLogId
  const parsed = parseRunLogId('tagger-run-20261021-052741-analyze');
  assert.deepEqual(parsed, { mode: 'analyze', startedAt: '2026-10-21T05:27:41.000Z', n: 1 });
  assert.deepEqual(parseRunLogId('tagger-run-20261021-052741-tag-3'), { mode: 'tag', startedAt: '2026-10-21T05:27:41.000Z', n: 3 });
  assert.equal(parseRunLogId('nope'), null);
  assert.equal(parseRunLogId('tagger-run-20261021-052741-other'), null);
});

test('openRunLogSink creates nested dirs, appends, rejects bad ids', () => withTempDir((tmp) => {
  const nested = path.join(tmp, 'a', 'b');
  const id = 'tagger-run-20261021-052741-analyze';

  const s1 = openRunLogSink(nested, id);
  assert.ok(s1);
  s1!.write('first\n');
  s1!.close();

  // Second sink appends to the same file.
  const s2 = openRunLogSink(nested, id);
  assert.ok(s2);
  s2!.write('second\n');
  s2!.close();

  const content = fs.readFileSync(path.join(nested, `${id}.log`), 'utf8');
  assert.equal(content, 'first\nsecond\n');

  // Invalid id → null, no file created.
  const sBad = openRunLogSink(tmp, '../evil');
  assert.equal(sBad, null);

}));

test('listRunLogs returns only valid .log files, newest first', () => withTempDir((tmp) => {
  const ids = [
    'tagger-run-20261021-050000-tag',
    'tagger-run-20261021-050001-analyze',
    'tagger-run-20261021-050002-reconcile',
  ];
  for (const id of ids) {
    fs.writeFileSync(path.join(tmp, `${id}.log`), 'x'.repeat(id.length));
  }
  // Noise files that must be ignored.
  fs.writeFileSync(path.join(tmp, 'notes.log'), 'ignore');
  fs.writeFileSync(path.join(tmp, `${ids[0]}.log.tmp`), 'ignore');
  fs.mkdirSync(path.join(tmp, 'tagger-run-20261021-050003-tag.log')); // directory masquerading as log

  const list = listRunLogs(tmp);
  assert.equal(list.length, 3);
  // Newest first (lex descending).
  assert.equal(list[0].id, 'tagger-run-20261021-050002-reconcile');
  assert.equal(list[1].id, 'tagger-run-20261021-050001-analyze');
  assert.equal(list[2].id, 'tagger-run-20261021-050000-tag');
  assert.equal(list[0].mode, 'reconcile');
  assert.equal(list[0].startedAt, '2026-10-21T05:00:02.000Z');
  assert.equal(list[0].bytes, 'tagger-run-20261021-050002-reconcile'.length);

}));

test('listRunLogs orders runs within one second by their count', () => withTempDir((tmp) => {
  for (const id of [
    'tagger-run-20261021-050000-tag-10',
    'tagger-run-20261021-045959-reconcile',
    'tagger-run-20261021-050000-tag',
    'tagger-run-20261021-050000-reconcile-2',
  ]) fs.writeFileSync(path.join(tmp, `${id}.log`), 'x');
  assert.deepEqual(listRunLogs(tmp).map(f => f.id), [
    'tagger-run-20261021-050000-tag-10',
    'tagger-run-20261021-050000-reconcile-2',
    'tagger-run-20261021-050000-tag',
    'tagger-run-20261021-045959-reconcile',
  ]);
}));

test('openRunLog gives a run started in the same second its own id and file', () => withTempDir((tmp) => {
  const at = new Date('2026-10-21T05:27:41.100Z');
  const a = openRunLog(tmp, at, 'tag', null);
  a.event({ kind: 'info', text: 'first run', at: at.toISOString() }, () => false);
  a.close();
  const b = openRunLog(tmp, new Date('2026-10-21T05:27:41.900Z'), 'tag', a.runId);
  b.event({ kind: 'info', text: 'second run', at: at.toISOString() }, () => false);
  b.close();
  // Another mode in the same second still counts on, so the count orders them.
  const c = openRunLog(tmp, at, 'reconcile', b.runId);
  c.close();
  assert.equal(a.runId, 'tagger-run-20261021-052741-tag');
  assert.equal(b.runId, 'tagger-run-20261021-052741-tag-2');
  assert.equal(c.runId, 'tagger-run-20261021-052741-reconcile-3');
  assert.equal(fs.readFileSync(path.join(tmp, `${a.runId}.log`), 'utf8'), '05:27:41  [info] first run\n');
  assert.equal(fs.readFileSync(path.join(tmp, `${b.runId}.log`), 'utf8'), '05:27:41  [info] second run\n');
  assert.deepEqual(listRunLogs(tmp).map(f => f.id), [c.runId, b.runId, a.runId]);

  // A run in another second starts the count again.
  const d = openRunLog(tmp, new Date('2026-10-21T05:27:42Z'), 'tag', c.runId);
  d.close();
  assert.equal(d.runId, 'tagger-run-20261021-052742-tag');
}));

test('openRunLog counts the previous run even when its file never opened', () => withTempDir((empty) => {
  const log = openRunLog(empty, new Date('2026-10-21T05:27:41.100Z'), 'tag', 'tagger-run-20261021-052741-tag');
  log.close();
  assert.equal(log.runId, 'tagger-run-20261021-052741-tag-2');
}));

test('openRunLog keeps the newest nine files, so the new one is the tenth', () => withTempDir((tmp) => {
  for (let i = 0; i < RUN_LOG_KEEP + 2; i++) {
    fs.writeFileSync(path.join(tmp, `tagger-run-20261021-0400${String(i).padStart(2, '0')}-tag.log`), 'x');
  }
  openRunLog(tmp, new Date('2026-10-21T05:00:00Z'), 'tag', null).close();
  const ids = listRunLogs(tmp).map(f => f.id);
  assert.equal(ids.length, RUN_LOG_KEEP);
  assert.equal(ids[0], 'tagger-run-20261021-050000-tag');
}));

test('listRunLogs on a missing directory returns []', () => {
  assert.deepEqual(listRunLogs('/no/such/dir/xyzzy'), []);
});

test('pruneRunLogs removes oldest beyond keep, leaves non-log files', () => withTempDir((tmp) => {
  // Create 12 valid log files with sequential timestamps.
  const validIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `tagger-run-20261021-0500${String(i).padStart(2, '0')}-tag`;
    validIds.push(id);
    fs.writeFileSync(path.join(tmp, `${id}.log`), 'x');
  }
  // Noise files.
  fs.writeFileSync(path.join(tmp, 'notes.log'), 'keep');
  fs.writeFileSync(path.join(tmp, 'subwave-auto-backup-2026-10-21-000000.zip'), 'keep');
  // Look-alikes the writer never produces: an unknown mode, a short stamp.
  fs.writeFileSync(path.join(tmp, 'tagger-run-20200101-000000-other.log'), 'keep');
  fs.writeFileSync(path.join(tmp, 'tagger-run-2020.log'), 'keep');

  const deleted = pruneRunLogs(tmp, 10);
  assert.equal(deleted, 2);
  // The two oldest (0500 and 0501) are gone.
  assert.equal(fs.existsSync(path.join(tmp, `${validIds[0]}.log`)), false);
  assert.equal(fs.existsSync(path.join(tmp, `${validIds[1]}.log`)), false);
  // 10 newest remain.
  for (let i = 2; i < 12; i++) {
    assert.ok(fs.existsSync(path.join(tmp, `${validIds[i]}.log`)), `seq ${i} should remain`);
  }
  // Noise files untouched.
  assert.ok(fs.existsSync(path.join(tmp, 'notes.log')));
  assert.ok(fs.existsSync(path.join(tmp, 'subwave-auto-backup-2026-10-21-000000.zip')));
  assert.ok(fs.existsSync(path.join(tmp, 'tagger-run-20200101-000000-other.log')));
  assert.ok(fs.existsSync(path.join(tmp, 'tagger-run-2020.log')));

  // prune with keep = -1 treats it as 0 → deletes all valid logs.
  const deleted2 = pruneRunLogs(tmp, -1);
  assert.equal(deleted2, 10);
  assert.equal(fs.existsSync(path.join(tmp, 'notes.log')), true);
  assert.equal(fs.existsSync(path.join(tmp, 'subwave-auto-backup-2026-10-21-000000.zip')), true);

}));

test('pruneRunLogs on a missing directory returns 0', () => {
  assert.equal(pruneRunLogs('/no/such/dir/prune-xyzzy'), 0);
});

test('runLogPath returns existing valid path or null', () => withTempDir((tmp) => {
  const id = 'tagger-run-20261021-052741-tag';
  fs.writeFileSync(path.join(tmp, `${id}.log`), 'x');

  assert.equal(runLogPath(tmp, id), path.join(tmp, `${id}.log`));

  // Valid format but file missing.
  const missing = 'tagger-run-20260101-000000-tag';
  assert.equal(runLogPath(tmp, missing), null);

  // Path traversal attempt.
  assert.equal(runLogPath(tmp, '../etc/passwd'), null);

}));

test('the defaults: 5000 lines in memory, ten files on disk, under state/tagger-logs', () => withTempDir((tmp) => {
  assert.equal(RUN_LOG_DIR_NAME, 'tagger-logs');
  const log = new RunLog({ runId: 'defaults' });
  for (let i = 0; i <= RUN_LOG_CAP; i++) log.event({ kind: 'info', text: `l${i}`, at: '2026-10-21T05:00:00.000Z' }, () => false);
  const page = log.since(0);
  assert.equal(page.entries.length, RUN_LOG_CAP);
  assert.equal(page.gap, true);
  for (let i = 0; i < RUN_LOG_KEEP + 3; i++) {
    fs.writeFileSync(path.join(tmp, `tagger-run-20261021-0600${String(i).padStart(2, '0')}-analyze.log`), 'x');
  }
  assert.equal(pruneRunLogs(tmp), 3);
  assert.equal(listRunLogs(tmp).length, RUN_LOG_KEEP);
}));

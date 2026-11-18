// The stem cache usage journal's rules (music/stem-usage-policy.ts, #2317):
// what a line says, when a snapshot's position vouches for it, what a walk
// re-measures, and how a writer settles against what the snapshot holds.
// Pure: no files. The orderings against real files are
// scripts/stem-usage-orderings.test.ts.
//
// Run: npm test -- stem-usage-policy

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../src/music/stem-usage-policy.js';

const NOW = 1_800_000_000_000;
const alive = () => true;
const live = (inFlight?: p.InFlight, w: p.WriterAlive = alive) => ({ inFlight, nowMs: NOW, alive: w });

function journalOf(lines: string[], id = 'J1'): p.Journal {
  const j = p.parseJournal(p.headerLine(id, NOW - 1000) + lines.join(''));
  assert.ok(j);
  return j;
}
const endOf = (j: p.Journal, i: number) => j.entries[i].end;

test('a journal parses whole lines; a line still landing is left past the end', () => {
  const text = p.headerLine('J1', NOW) + p.openLine('s1', 'a', NOW, 7, '100') + p.closeLine('s1', 'a') + '= s1 b';
  const j = p.parseJournal(text);
  assert.ok(j);
  assert.equal(j.id, 'J1');
  assert.equal(j.createdMs, NOW);
  assert.deepEqual(j.entries.map(e => e.kind), ['+', '=']);
  assert.equal(j.end, Buffer.byteLength(text) - '= s1 b'.length);
});

test('not a journal: no header, another format or version, a bad id', () => {
  for (const text of ['', 'x\n', 'subwave-stem-journal 2 J1 1\n', 'other 1 J1 1\n', 'subwave-stem-journal 1 J/1 1\n', 'subwave-stem-journal 1 J1\n']) {
    assert.equal(p.parseJournal(text), null, JSON.stringify(text));
  }
});

test('a line that does not parse reads as a change of unknown size', () => {
  const j = journalOf(['+ s1 a notanumber 7\n', 'garbage\n', '= s1\n', `+ s1 ${encodeURIComponent('../x')} ${NOW} 7\n`]);
  assert.deepEqual(j.entries.map(e => e.kind), ['*', '*', '*', '*']);
});

test('dir names round-trip, and a pass\'s opening names no dir', () => {
  const j = journalOf([p.openLine('s1', 'id with space%', NOW, 7, '100'), p.passOpenLine('s2', NOW, 7, '100')]);
  assert.equal(j.entries[0].kind === '+' && j.entries[0].dir, 'id with space%');
  assert.equal(j.entries[1].kind === '+' && j.entries[1].dir, p.UNNAMED_DIRS);
});

test('a snapshot is vouched for only while nothing but openings lies past its position', () => {
  const j = journalOf([p.openLine('s1', 'a', NOW, 7, '100'), p.closeLine('s1', 'a'), p.openLine('s2', 'b', NOW, 7, '100')]);
  assert.equal(p.journalAccounts({ id: 'J1', upTo: j.headerEnd }, j, live()), false, 'a close past it');
  assert.equal(p.journalAccounts({ id: 'J1', upTo: endOf(j, 1) }, j, live()), true, 'only an opening past it');
  assert.equal(p.journalAccounts({ id: 'J1', upTo: j.end }, j, live()), true);
  assert.equal(p.journalAccounts({ id: 'J2', upTo: j.end }, j, live()), false, 'another journal');
  assert.equal(p.journalAccounts({ id: 'J1', upTo: j.end + 1 }, j, live()), false, 'past the end');
  assert.equal(p.journalAccounts({ id: 'J1', upTo: 1 }, j, live()), false, 'inside the header');
  assert.equal(p.journalAccounts(undefined, j, live()), false, 'no position');
  assert.equal(p.journalAccounts({ id: 'J1', upTo: j.end }, null, live()), false, 'no journal');
  const unknown = journalOf([p.unknownLine('s3')]);
  assert.equal(p.journalAccounts({ id: 'J1', upTo: unknown.headerEnd }, unknown, live()), false, 'a change of unknown size');
});

test('open writes: unclosed, young, and with a live writer', () => {
  const j = journalOf([
    p.openLine('s1', 'a', NOW, 7, '100'),
    p.openLine('s2', 'b', NOW, 7, '100'), p.closeLine('s2', 'b'),
    p.closeLine('s3', 'c'), p.openLine('s3', 'c', NOW, 7, '100'), // a trim copied the close ahead
    p.openLine('s4', 'd', NOW - p.OPEN_MAX_AGE_MS - 1, 7, '100'),
    p.openLine('s5', 'e', NOW, 99, '100'),
    p.passOpenLine('s6', NOW - p.OPEN_MAX_AGE_MS - 1, 7, '100'),
  ]);
  const open = p.openWrites(j, NOW, pid => pid !== 99).map(o => `${o.session} ${o.dir}`);
  assert.deepEqual(open, ['s1 a', `s6 ${p.UNNAMED_DIRS}`], 'a pass is young for longer');
});

test('a walk re-measures what changed since it started and what is still open', () => {
  const j = journalOf([p.openLine('s1', 'a', NOW, 7, '100'), p.openLine('s2', 'b', NOW, 7, '100'), p.closeLine('s2', 'b'), p.openLine('s3', 'c', NOW, 7, '100')]);
  const from = endOf(j, 0); // the walk started after s1 opened
  const r = p.walkReconcile('J1', from, j, NOW, alive);
  assert.ok(r.ok);
  assert.deepEqual(r.remeasure, ['a', 'b', 'c']);
  assert.deepEqual(r.open.map(o => o.dir), ['a', 'c']);
});

test('a walk is refused: unknown change, replaced or missing journal, a pass, two writers in a dir', () => {
  const base = journalOf([]);
  assert.equal(p.walkReconcile(null, 0, base, NOW, alive).ok, false);
  assert.equal(p.walkReconcile('J1', base.headerEnd, null, NOW, alive).ok, false);
  assert.equal(p.walkReconcile('J0', base.headerEnd, base, NOW, alive).ok, false);
  const unknown = journalOf([p.unknownLine('s1')]);
  assert.equal(p.walkReconcile('J1', unknown.headerEnd, unknown, NOW, alive).ok, false);
  assert.equal(p.walkReconcile('J1', unknown.end, unknown, NOW, alive).ok, true, 'an unknown change before it started');
  const pass = journalOf([p.passOpenLine('s1', NOW, 7, '100'), p.closeLine('s1', p.UNNAMED_DIRS)]);
  assert.equal(p.walkReconcile('J1', pass.headerEnd, pass, NOW, alive).ok, false, 'a pass started during it');
  assert.equal(p.walkReconcile('J1', pass.end, pass, NOW, alive).ok, true, 'a pass that settled before it started');
  const running = journalOf([p.passOpenLine('s1', NOW, 7, '100')]);
  assert.equal(p.walkReconcile('J1', running.end, running, NOW, alive).ok, false, 'a pass still writing');
  assert.equal(p.walkReconcile('J1', running.end, running, NOW, () => false).ok, true, 'a pass whose process died');
  const two = journalOf([p.openLine('s1', 'a', NOW, 7, '100'), p.openLine('s2', 'a', NOW, 7, '100')]);
  assert.equal(p.walkReconcile('J1', two.end, two, NOW, alive).ok, false);
});

function settle(lines: string[], upTo: (j: p.Journal) => number, inFlight: p.InFlight | undefined, dirs: p.SessionDir[], session = 's1') {
  const j = journalOf(lines);
  return { j, d: p.settleDecision({ mark: { id: 'J1', upTo: upTo(j) }, inFlight, journal: j, session, dirs }) };
}

test('a writer settles against what the snapshot holds for each of its dirs', () => {
  const lines = [p.openLine('s1', 'a', NOW, 7, '100'), p.closeLine('s1', 'a')];
  const dirs = [{ dir: 'a', base: 1000, final: 1500 }];
  // The snapshot predates the opening: it holds the base.
  let { j, d } = settle(lines, j => j.headerEnd, undefined, dirs);
  assert.deepEqual(d, { kind: 'apply', bytes: 500, dirs: 0, mark: { id: 'J1', upTo: j.end }, inFlight: {} });
  // Stored with the write open: it holds what it counted.
  ({ j, d } = settle(lines, j => endOf(j, 0), { 's1 a': 1200 }, dirs));
  assert.deepEqual(d, { kind: 'apply', bytes: 300, dirs: 0, mark: { id: 'J1', upTo: j.end }, inFlight: {} });
  // Counted absent, now present: a dir joins.
  ({ d } = settle(lines, j => endOf(j, 0), { 's1 a': null }, dirs));
  assert.equal(d.kind === 'apply' && `${d.bytes} ${d.dirs}`, '1500 1');
  // Passed while open by another writer: the base.
  ({ d } = settle(lines, j => endOf(j, 0), { 's1 a': 'base' }, dirs));
  assert.equal(d.kind === 'apply' && d.bytes, 500);
  // Stored after the close: nothing to add.
  ({ d } = settle(lines, j => j.end, undefined, dirs));
  assert.equal(d.kind === 'apply' && `${d.bytes} ${d.dirs}`, '0 0');
  // A dir that went: it leaves.
  ({ d } = settle(lines, j => j.headerEnd, undefined, [{ dir: 'a', base: 1000, final: null }]));
  assert.equal(d.kind === 'apply' && `${d.bytes} ${d.dirs}`, '-1000 -1');
});

test('a writer passes another writer\'s opening, and marks it as the base', () => {
  const lines = [p.openLine('s2', 'b', NOW, 7, '100'), p.openLine('s1', 'a', NOW, 7, '100'), p.closeLine('s1', 'a')];
  const { j, d } = settle(lines, j => j.headerEnd, undefined, [{ dir: 'a', base: 0, final: 10 }]);
  assert.deepEqual(d, { kind: 'apply', bytes: 10, dirs: 0, mark: { id: 'J1', upTo: j.end }, inFlight: { 's2 b': 'base' } });
});

test('a writer stands down: another\'s close, an unknown change, a pass, its own dir held by another, a missing line', () => {
  const dirs = [{ dir: 'a', base: 0, final: 10 }];
  const refused = (lines: string[], inFlight?: p.InFlight, upTo = (j: p.Journal) => j.headerEnd) =>
    settle(lines, upTo, inFlight, dirs).d.kind === 'refuse';
  const mine = [p.openLine('s1', 'a', NOW, 7, '100'), p.closeLine('s1', 'a')];
  assert.ok(refused([p.openLine('s2', 'b', NOW, 7, '100'), p.closeLine('s2', 'b'), ...mine]), 'another writer\'s close in between');
  assert.ok(refused([p.unknownLine('s2'), ...mine]), 'an unknown change in between');
  assert.ok(refused([p.passOpenLine('s2', NOW, 7, '100'), ...mine]), 'a pass opened in between');
  assert.ok(refused([p.openLine('s2', 'a', NOW, 7, '100'), ...mine]), 'another writer opened the same dir');
  assert.ok(refused(mine, { 's2 a': 5 }, j => j.headerEnd), 'the snapshot holds the same dir open for another');
  assert.ok(refused([p.openLine('s1', 'a', NOW, 7, '100')]), 'its own close is missing');
  assert.ok(refused(mine, {}, j => endOf(j, 0)), 'held open, but not what it counted');
  assert.ok(refused([...mine, p.unknownLine('s1')]), 'its own unknown change');
  // Another writer's close AFTER this writer's last line is past the new position, not in between.
  const later = settle([...mine, p.openLine('s2', 'b', NOW, 7, '100'), p.closeLine('s2', 'b')], j => j.headerEnd, undefined, dirs);
  assert.equal(later.d.kind, 'apply');
  assert.equal(later.d.kind === 'apply' && later.d.mark.upTo, endOf(later.j, 1));
});

test('two writers settling on one snapshot: whichever reads second stands down', () => {
  // Both closed; both read the same snapshot at the start.
  const lines = [p.openLine('s1', 'a', NOW, 7, '100'), p.openLine('s2', 'b', NOW, 7, '100'), p.closeLine('s1', 'a'), p.closeLine('s2', 'b')];
  const one = settle(lines, j => j.headerEnd, undefined, [{ dir: 'a', base: 0, final: 10 }], 's1');
  const two = settle(lines, j => j.headerEnd, undefined, [{ dir: 'b', base: 0, final: 20 }], 's2');
  assert.equal(one.d.kind, 'apply', 'the first close has only an opening before it');
  assert.equal(two.d.kind, 'refuse', 'the second sees the first\'s close');
  // And the first's position stops short of the second's close: untrusted until a walk.
  assert.ok(one.d.kind === 'apply' && !p.journalAccounts(one.d.mark, one.j, live()));
});

test('a writer whose lines a trim dropped was counted by the walk that trimmed', () => {
  const j = journalOf([]);
  const d = p.settleDecision({ mark: { id: 'J1', upTo: j.end }, inFlight: {}, journal: j, session: 's1', dirs: [{ dir: 'a', base: 0, final: 1 }] });
  assert.equal(d.kind, 'accounted');
});

test('a trimmed journal keeps the openings still running, in order', () => {
  const lines = [p.openLine('s1', 'a', NOW, 7, '100'), p.openLine('s2', 'b', NOW, 7, '100')];
  const body = p.trimmedBody(p.openWrites(journalOf(lines), NOW, alive));
  assert.equal(body, lines.join(''));
});

// #2352: a writer that dies between its change and its close. Pid 7 runs
// with start identity '100'; a process under tini that got pid 7 again after a
// restart has another, so an opening is judged by its identity when it carries
// one, and a 5-field opening by the pid alone.
const writer7: p.WriterAlive = (pid, start) => pid === 7 && (start === undefined || start === '100');

test('an opening carries its writer\'s start identity; a 5-field one carries none', () => {
  const j = journalOf([p.openLine('s1', 'a', NOW, 7, '100'), p.passOpenLine('s2', NOW, 7, '100'), p.openLine('s3', 'b', NOW, 7, null), '+ s4 c 1 7 x9\n']);
  assert.deepEqual(j.entries.map(e => e.kind === '+' ? e.start ?? 'none' : e.kind), ['100', '100', 'none', '*']);
  assert.equal(p.openLine('s1', 'a', NOW, 7, '100').trim().split(' ').length, 6);
  assert.equal(p.openLine('s1', 'a', NOW, 7, null).trim().split(' ').length, 5, 'no identity where /proc cannot be read');
});

// The read rule as it stood before #2352 (9d7b9ab5): an opening is exactly 5
// fields, anything else reads as `*`, and every entry past the position must
// be an opening. A downgrade, or a mixed image, must not trust past a line it
// cannot read.
function legacyAccounts(text: string, upTo: number): boolean {
  let offset = 0;
  for (const raw of text.split('\n').slice(0, -1)) {
    const lineStart = offset;
    offset += Buffer.byteLength(raw + '\n');
    if (lineStart === 0) continue; // the header
    const opening = raw.split(' ')[0] === '+' && raw.split(' ').length === 5;
    if (lineStart >= upTo && !opening) return false;
  }
  return true;
}

test('an older reader fails safe on the new opening: it reads it as a change of unknown size', () => {
  const header = p.headerLine('J1', NOW);
  const upTo = Buffer.byteLength(header);
  assert.equal(legacyAccounts(header + p.openLine('s1', 'a', NOW, 7, null), upTo), true, 'the 5-field line it knows');
  assert.equal(legacyAccounts(header + p.openLine('s1', 'a', NOW, 7, '100'), upTo), false, 'the 6-field line leaves it untrusted');
});

test('a snapshot is not vouched for past an opening whose writer died or is too old (#2352)', () => {
  const at = (line: string, w: p.WriterAlive = writer7) => {
    const j = journalOf([line]);
    return p.journalAccounts({ id: 'J1', upTo: j.headerEnd }, j, live(undefined, w));
  };
  assert.equal(at(p.openLine('s1', 'a', NOW, 7, '100')), true, 'a live writer');
  assert.equal(at(p.openLine('s1', 'a', NOW, 8, '100')), false, 'its pid is gone');
  assert.equal(at(p.openLine('s1', 'a', NOW, 7, '200')), false, 'its pid now names another process (tini reuse)');
  assert.equal(at(p.openLine('s1', 'a', NOW, 7, null)), true, 'a 5-field opening is judged on pid and age alone');
  assert.equal(at(p.openLine('s1', 'a', NOW - p.OPEN_MAX_AGE_MS - 1, 7, '100')), false, 'older than OPEN_MAX_AGE_MS');
  assert.equal(at(p.openLine('s1', 'a', NOW - p.OPEN_MAX_AGE_MS - 1, 7, null)), false, 'a legacy opening that old too');
  assert.equal(at(p.passOpenLine('s1', NOW - p.OPEN_MAX_AGE_MS - 1, 7, '100')), true, 'a pass is young for longer');
  assert.equal(at(p.passOpenLine('s1', NOW - p.PASS_OPEN_MAX_AGE_MS - 1, 7, '100')), false, 'a pass past its own bound');
});

test('a snapshot holding a bracket open is not vouched for once that writer died (#2352)', () => {
  // A walk stored with s1 open; the trim carried s1's opening ahead of the position.
  const j = journalOf([p.openLine('s1', 'a', NOW, 7, '100')]);
  const mark = { id: 'J1', upTo: j.end };
  const held: p.InFlight = { [p.inFlightKey('s1', 'a')]: 500 };
  assert.equal(p.journalAccounts(mark, j, live(held, writer7)), true, 'its writer still running');
  assert.equal(p.journalAccounts(mark, j, live(held, () => false)), false, 'its writer died');
  assert.equal(p.journalAccounts(mark, j, live(held, (pid, start) => pid === 7 && start === '200')), false, 'its pid was reused');
  assert.equal(p.journalAccounts(mark, j, { inFlight: held, nowMs: NOW + p.OPEN_MAX_AGE_MS + 1, alive: writer7 }), false, 'too old');
  const missing: p.InFlight = { [p.inFlightKey('s9', 'z')]: 'base' };
  assert.equal(p.journalAccounts(mark, j, live(missing, writer7)), false, 'no opening left for what it holds');
  assert.equal(p.journalAccounts(mark, j, live({}, () => false)), true, 'an opening it does not hold is history');
});

test('open writes drop an opening whose pid was reused by another process', () => {
  const j = journalOf([p.openLine('s1', 'a', NOW, 7, '100'), p.openLine('s2', 'b', NOW, 7, '200'), p.openLine('s3', 'c', NOW, 7, null)]);
  assert.deepEqual(p.openWrites(j, NOW, writer7).map(o => o.session), ['s1', 's3']);
});

test('the start identity is /proc stat field 22, read after the command name', () => {
  const tail = 'S 1 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 11 0 987654 1000 10';
  assert.equal(p.procStartTime(`42 (node) ${tail}`), '987654');
  assert.equal(p.procStartTime(`42 (a) b (c)) ${tail}`), '987654', 'a command name with spaces and parentheses');
  assert.equal(p.procStartTime('42 (node) S 1'), null, 'cut short');
  assert.equal(p.procStartTime('garbage'), null);
});

// The I/O side's liveness check reads /proc synchronously, and between walks
// the journal holds thousands of settled brackets from a handful of writers:
// a read judges only what it must (openings past the position, and those it
// holds open), once per writer (#2352).
test('a read asks after each writer once, and only for openings that still matter', () => {
  const lines: string[] = [];
  for (let i = 0; i < 500; i += 1) lines.push(p.openLine(`s${i}`, `d${i}`, NOW, 7, '100'), p.closeLine(`s${i}`, `d${i}`));
  lines.push(p.openLine('held', 'h', NOW, 9, '300'));
  const settled = journalOf(lines);
  const tail = journalOf([...lines, p.openLine('t1', 'x', NOW, 7, '100'), p.openLine('t2', 'y', NOW, 7, '100')]);
  const held: p.InFlight = { [p.inFlightKey('held', 'h')]: 'base' };
  let calls = 0;
  const counted: p.WriterAlive = () => { calls += 1; return true; };
  assert.equal(p.journalAccounts({ id: 'J1', upTo: settled.end }, settled, live({}, counted)), true);
  assert.equal(calls, 0, 'settled brackets before the position are history');
  assert.equal(p.journalAccounts({ id: 'J1', upTo: settled.end }, tail, live(held, counted)), true);
  assert.equal(calls, 2, 'one held writer and one writer past the position, each asked once');
  calls = 0;
  assert.equal(p.openWrites(tail, NOW, counted).length, 3);
  assert.equal(calls, 2, 'a walk asks once per writer too');
});

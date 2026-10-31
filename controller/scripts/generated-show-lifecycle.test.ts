// Durable generated episodes: isolated files, controlled clocks and injected generation.
import assert from 'node:assert/strict';
import test, { after, type TestContext } from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import type { GeneratedShowSnapshot } from '../src/broadcast/show-preparation.js';
import type { SessionContext } from '../src/broadcast/session.js';

const root = createTempDir(join(tmpdir(), 'subwave-generated-lifecycle-'));
process.env.STATE_DIR = root;
const { createShowPreparation, prepareUpcomingGeneratedShows, showPreparation } = await import('../src/broadcast/show-preparation.js');
const settings = await import('../src/settings.js');
const { showSchema } = await import('../src/schemas/show.js');
const { resolveShowOccurrence } = await import('../src/broadcast/show-occurrence.js');
const { zonedParts, setStationTimezone } = await import('../src/time.js');
after(() => removeTempDir(root));
const epoch = Date.parse('2026-10-26T08:00:00Z');
function snapshot(id: string, startsAt = epoch + 3600_000, endsAt = startsAt + 3600_000): GeneratedShowSnapshot {
  return { occurrence: { id, showId: 's_fixture', source: 'scheduled', startsAt, endsAt },
    template: 'dj-choice', configuration: 'original-cast-and-filters', planningPrompt: '', minimumCoverage: null,
    cast: { hostPersonaId: 'p_host', guestPersonaIds: ['p_guest'] }, show: { id: 's_fixture' } };
}
const context = (at: number) => ({ at: new Date(at).toISOString() }) as SessionContext;
// JSON persistence omits optional undefined fields; compare the stored shape.
const durable = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function fixture(name: string) {
  let clock = epoch;
  let current: GeneratedShowSnapshot | null = snapshot(`scheduled:s_fixture:${epoch + 3600_000}`);
  let failure = false;
  let count = 100;
  let calls = 0;
  let gate: Promise<void> | null = null;
  let release = () => {};
  let entered = () => {};
  let started = Promise.resolve();
  const file = join(root, `${name}.json`);
  const deps = {
    file, snapshot: () => null, execute: async () => null, source: async () => null, now: () => clock,
    generatedSnapshot: () => current, scheduledGeneratedSnapshot: () => current,
    isScheduledOccurrenceCurrent: (occurrence: GeneratedShowSnapshot['occurrence']) =>
      current?.occurrence.id === occurrence.id && current.occurrence.endsAt === occurrence.endsAt,
    generate: async () => {
      calls++; entered(); await gate;
      if (failure) throw new Error('Fixture model unavailable');
      return { name: `Episode ${calls}`, topic: 'A grounded musical brief.', genres: ['Folk'], moods: [], eras: [],
        energies: [], filtersStrict: true, rationale: '' };
    },
    diagnose: async () => ({ strict: true, artists: count, library: { indexed: 100, matchingFilters: count, afterExclusions: count, effective: count }, playlist: null, warnings: [] }),
  };
  let owner = createShowPreparation(deps);
  return {
    file, get owner() { return owner; }, calls: () => calls, current: () => current!,
    prepare: () => owner.ensureGenerated({ context: context(current!.occurrence.startsAt), source: 'scheduled' }),
    restart: () => { owner = createShowPreparation(deps); },
    change: (value: GeneratedShowSnapshot | null) => { current = value; },
    at: (value: number) => { clock = value; }, fail: (value: boolean) => { failure = value; }, coverage: (value: number) => { count = value; },
    hold: () => { gate = new Promise(resolve => { release = resolve; }); started = new Promise(resolve => { entered = resolve; }); },
    entered: () => started, release: () => { release(); gate = null; },
  };
}

test('fresh owners and a fresh process recover the accepted plan and cast without generating again', async () => {
  const f = fixture('restart-ready');
  const first = await f.prepare();
  f.restart(); f.fail(true);
  assert.deepEqual(await f.prepare(), durable(first));
  assert.equal(f.calls(), 1);
  const moduleUrl = new URL('../src/broadcast/show-preparation.ts', import.meta.url).href;
  const code = `
    const { createShowPreparation } = await import(${JSON.stringify(moduleUrl)});
    const snapshot = ${JSON.stringify(f.current())};
    const owner = createShowPreparation({ file: ${JSON.stringify(f.file)}, now: () => ${epoch},
      snapshot: () => null, execute: async () => null, source: async () => null,
      scheduledGeneratedSnapshot: () => snapshot,
      generate: async () => { throw new Error('A restart must not regenerate'); } });
    const record = await owner.ensureGenerated({ context: {}, source: 'scheduled' });
    console.log('RESULT:' + JSON.stringify(record));
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
    { env: { ...process.env, STATE_DIR: root }, encoding: 'utf8', timeout: 15_000 });
  const line = output.split('\n').find(value => value.startsWith('RESULT:'))!;
  assert.deepEqual(JSON.parse(line.slice('RESULT:'.length)), durable(first));
});

test('future configuration edits replace an accepted plan, while on-air plans remain locked', async () => {
  const f = fixture('configuration');
  await f.prepare();
  f.change({ ...f.current(), configuration: 'new-cast', cast: { hostPersonaId: 'p_other', guestPersonaIds: [] } });
  const second = await f.prepare();
  assert.equal(second?.hostPersonaId, 'p_other');
  assert.equal(f.calls(), 2);
  f.at(f.current().occurrence.startsAt);
  f.change({ ...f.current(), configuration: 'another-edit' });
  f.restart();
  assert.deepEqual(await f.prepare(), durable(second));
  assert.equal(f.calls(), 2);
});

test('failed generation cooldown and exhausted automatic retries survive restart; explicit retry remains possible', async () => {
  const f = fixture('failure-restart');
  f.fail(true);
  assert.equal((await f.prepare())?.kind, 'failed');
  f.restart();
  await f.prepare();
  assert.equal(f.calls(), 1);
  f.at(epoch + 60_000);
  const exhausted = await f.prepare();
  assert.equal(exhausted?.kind === 'failed' && exhausted.attempts, 2);
  assert.equal(exhausted?.kind === 'failed' && exhausted.retryAt, null);
  f.restart(); f.at(epoch + 120_000); f.fail(false);
  assert.equal((await f.prepare())?.kind, 'failed');
  assert.equal(f.calls(), 2);
  assert.equal((await f.owner.regenerateGenerated(f.current().occurrence.id))?.kind, 'ready');
  assert.equal(f.calls(), 3);
});

test('failed manual regeneration preserves the accepted plan on disk and after restart', async () => {
  const f = fixture('accepted-failure');
  const first = await f.prepare();
  f.fail(true);
  await assert.rejects(f.owner.regenerateGenerated(f.current().occurrence.id), /model unavailable/);
  f.restart();
  assert.deepEqual(await f.prepare(), durable(first));
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).generated, durable([first]));
});

test('a short coverage pool never becomes ready and keeps the bounded correction failure after restart', async () => {
  const f = fixture('coverage-restart');
  f.coverage(29);
  const result = await f.prepare();
  assert.equal(result?.kind, 'failed');
  assert.match(result?.kind === 'failed' ? result.reason : '', /needs at least 30.*only 29/);
  assert.equal(f.calls(), 2, 'one proposal and one correction');
  f.restart();
  assert.deepEqual(await f.prepare(), durable(result));
  assert.equal(f.calls(), 2);
});

test('late first-generation results cannot publish after removal, reconfiguration or the end of an airing', async () => {
  for (const reason of ['removed', 'configuration', 'ended']) {
    const f = fixture(`late-${reason}`);
    f.hold();
    const running = f.prepare();
    await f.entered();
    if (reason === 'removed') f.change(null);
    else if (reason === 'configuration') f.change({ ...f.current(), configuration: 'changed' });
    else f.at(f.current().occurrence.endsAt);
    f.release();
    assert.equal(await running, null);
    assert.deepEqual(await f.owner.generatedRecords(), []);
  }
});

test('an edit during generation discards the stale proposal and coalesces callers onto a current one', async () => {
  for (const change of ['configuration', 'duration']) {
    const f = fixture(`pending-edit-${change}`);
    f.hold();
    const old = f.prepare();
    await f.entered();
    f.change(change === 'configuration' ? { ...f.current(), configuration: 'edited-while-pending' }
      : { ...f.current(), occurrence: { ...f.current().occurrence, endsAt: epoch + 3 * 3600_000 } });
    const current = f.prepare();
    f.release();
    assert.equal(await old, null);
    const ready = await current;
    assert.equal(ready?.configuration, f.current().configuration);
    assert.equal(ready?.occurrence.endsAt, f.current().occurrence.endsAt);
    assert.equal(ready?.kind, 'ready');
    assert.equal(f.calls(), 2);
    assert.equal((await f.owner.generatedRecords()).length, 1);
  }
});

test('a waiting caller cannot restart generation once its edited airing has ended', async () => {
  const f = fixture('pending-ended');
  f.hold();
  const first = f.prepare();
  await f.entered();
  f.change({ ...f.current(), configuration: 'edited' });
  const second = f.prepare();
  f.at(f.current().occurrence.endsAt);
  f.release();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(f.calls(), 1);
});

test('cast shuffling conflicts with an in-progress generation rather than starting a second call', async () => {
  const f = fixture('shuffle-pending');
  await f.prepare();
  f.hold();
  const regenerating = f.owner.regenerateGenerated(f.current().occurrence.id);
  await f.entered();
  await assert.rejects(f.owner.regenerateGenerated(f.current().occurrence.id, 'new-cast-seed'), /already being generated/);
  f.release();
  await regenerating;
  assert.equal(f.calls(), 2);
});

test('an edited boundary between adjacent Sub/Shows replaces both obsolete future plans', async () => {
  setStationTimezone('UTC');
  const schedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Array(24).fill(null)]));
  schedule[1][10] = schedule[1][11] = 's_first';
  schedule[1][12] = schedule[1][13] = 's_second';
  const at = (hour: number) => Date.parse(`2026-10-26T${hour}:00:00Z`);
  const snapAt = (time: number): GeneratedShowSnapshot | null => {
    const p = zonedParts(new Date(time));
    const id = schedule[p.dow][p.hour];
    if (!id) return null;
    const occurrence = resolveShowOccurrence({ at: time, showId: id, schedule, override: null, parts: value => zonedParts(new Date(value)) });
    return occurrence ? { ...snapshot(occurrence.id), occurrence } : null;
  };
  let calls = 0;
  const file = join(root, 'adjacent-boundary.json');
  const deps = {
    file, snapshot: () => null, execute: async () => null, source: async () => null, now: () => epoch,
    scheduledGeneratedSnapshot: (ctx: SessionContext) => snapAt(Date.parse(ctx.at!)),
    isScheduledOccurrenceCurrent: (occurrence: GeneratedShowSnapshot['occurrence']) => {
      const latest = snapAt(occurrence.startsAt)?.occurrence;
      return latest?.id === occurrence.id && latest.endsAt === occurrence.endsAt;
    },
    generate: async () => ({ name: `Episode ${++calls}`, topic: 'A musical brief.', genres: ['Folk'], moods: [], eras: [], energies: [], filtersStrict: true, rationale: '' }),
    diagnose: async () => ({ strict: true, artists: 100, library: { indexed: 100, matchingFilters: 100, afterExclusions: 100, effective: 100 }, playlist: null, warnings: [] }),
  };
  const owner = createShowPreparation(deps);
  for (const hour of [10, 12]) await owner.ensureGenerated({ context: context(at(hour)), source: 'scheduled' });
  const old = await owner.generatedRecords();
  assert.equal(old.length, 2);
  schedule[1][12] = 's_first'; // First show grows; the following show starts an hour later.
  for (const hour of [10, 13]) await owner.ensureGenerated({ context: context(at(hour)), source: 'scheduled' });
  const records = await owner.generatedRecords();
  assert.equal(calls, 4);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => [record.occurrence.startsAt, record.occurrence.endsAt]), [[at(13), at(14)], [at(10), at(13)]]);
  const restarted = createShowPreparation(deps);
  assert.deepEqual(await restarted.generatedRecords(), durable(records));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).generated, durable(records));
});

test('pruning drops removed future episodes but preserves aired history without configuration details', async () => {
  const f = fixture('history-pruning');
  await f.prepare();
  f.at(f.current().occurrence.endsAt + 1);
  f.change(null);
  const history = await f.owner.generatedRecords();
  assert.equal(history.length, 1);
  assert.equal(history[0].configuration, '');
  f.at(epoch + 32 * 24 * 3600_000);
  assert.deepEqual(await f.owner.generatedRecords(), []);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).generated, []);
});

function sweepFixture(t: TestContext) {
  const station = settings.get();
  const original = { shows: station.shows, schedule: station.schedule };
  t.after(() => Object.assign(station, original));
  setStationTimezone('UTC');
  station.shows = ['s_first', 's_second'].map(id => ({
    ...showSchema({ personaIds: null, moodNames: null, themeIds: null, minTrackSeconds: null }).parse({
      name: 'Generated fixture', personaId: station.personas[0].id,
      generation: { mode: 'generated', template: 'dj-choice' },
    }), id,
  }));
  station.schedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Array(24).fill(null)]));
  station.schedule[1][8] = station.schedule[1][10] = station.schedule[1][11] = 's_first';
  station.schedule[1][12] = 's_second'; station.schedule[2][9] = 's_first';
  t.mock.method(showPreparation, 'reconcileGenerated', async () => {});
}

test('the 48-hour sweep prepares distinct future airings serially and skips the already-airing slot', async t => {
  sweepFixture(t);
  let release = () => {};
  let entered = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  let active = 0; let peak = 0;
  t.mock.method(showPreparation, 'ensureGenerated', async args => {
    assert.equal(args.source, 'scheduled');
    calls.push(args.context.at!); peak = Math.max(peak, ++active);
    if (calls.length === 1) { entered(); await gate; }
    active--;
    return null;
  });
  const preparing = prepareUpcomingGeneratedShows({ from: epoch });
  await started;
  assert.equal(calls.length, 1);
  release();
  assert.equal(await preparing, 3);
  assert.deepEqual(calls, ['2026-10-26T10:00:00.000Z', '2026-10-26T12:00:00.000Z', '2026-10-27T09:00:00.000Z']);
  assert.equal(peak, 1);
});

test('one failed scheduled preparation does not block later airings in the sweep', async t => {
  sweepFixture(t);
  let calls = 0;
  t.mock.method(showPreparation, 'ensureGenerated', async () => {
    if (++calls === 1) throw new Error('Fixture provider offline');
    return null;
  });
  assert.equal(await prepareUpcomingGeneratedShows({ from: epoch }), 3);
  assert.equal(calls, 3);
});
